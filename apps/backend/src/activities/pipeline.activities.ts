import { Context } from '@temporalio/activity';
import { count, eq } from 'drizzle-orm';
import { createDb, type Db } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { VideoStage } from '../db/schema.js';
import { emitSseEvent } from '../lib/sse-bus.js';
import { getTemporalClient } from '../temporal/client.js';
import { env } from '../env.js';
import type { SourceAdapter } from '@mirrorr/adapter-core';

/**
 * Activities run in the main Node.js process — they can use any Node.js APIs,
 * access the DB, spawn child processes, call adapters, etc.
 *
 * The Temporal worker injects retry / heartbeat infrastructure automatically.
 * Activity functions must NOT import from @temporalio/workflow.
 */

// ── Injectable factories (for testing only) ───────────────────────────────────

let _dbFactory: (() => Db) | null = null;
let _sourceAdapterFactory: ((type: string) => SourceAdapter) | null = null;

/** Override the DB factory (for unit testing activities without file-based SQLite). */
export function _setDbFactory(factory: (() => Db) | null): void {
  _dbFactory = factory;
}

/** Override the source adapter factory (for unit testing activities). */
export function _setSourceAdapterFactory(factory: ((type: string) => SourceAdapter) | null): void {
  _sourceAdapterFactory = factory;
}

function getDb(): Db {
  if (_dbFactory) return _dbFactory();
  return createDb().db;
}

async function getSourceAdapterForType(type: string): Promise<SourceAdapter> {
  if (_sourceAdapterFactory) return _sourceAdapterFactory(type);
  if (type === 'tiktok') {
    const { TiktokAdapter } = await import('@mirrorr/adapter-tiktok');
    return new TiktokAdapter();
  }
  throw new Error(`Unknown source adapter type: ${type}`);
}

// ── Pipeline activities ────────────────────────────────────────────────────────

export async function updateVideoStage(videoId: number, stage: VideoStage): Promise<void> {
  const log = Context.current().log;
  log.info('updateVideoStage', { videoId, stage });

  const db = getDb();
  const now = new Date();

  const [updated] = await db
    .update(schema.videos)
    .set({ stage, stageUpdatedAt: now })
    .where(eq(schema.videos.id, videoId))
    .returning({ id: schema.videos.id, creatorId: schema.videos.creatorId });

  if (updated) {
    emitSseEvent('video:update', {
      id: updated.id,
      creatorId: updated.creatorId,
      stage,
      stageUpdatedAt: now.toISOString(),
    });
  }
}

export async function downloadVideo(videoId: number): Promise<string> {
  const { heartbeat } = Context.current();
  const log = Context.current().log;
  log.info('downloadVideo start', { videoId });

  // Heartbeat so Temporal knows the activity is alive during long downloads.
  // TODO: spawn yt-dlp via adapter, heartbeat periodically, return local path
  heartbeat({ progress: 'starting' });

  return `/data/downloads/${videoId}.mp4`;
}

export async function transcodeVideo(videoId: number): Promise<void> {
  const log = Context.current().log;
  log.info('transcodeVideo start', { videoId });

  // TODO: probe with ffprobe, decide passthrough vs encode, run ffmpeg
}

export async function uploadVideo(videoId: number): Promise<void> {
  const log = Context.current().log;
  log.info('uploadVideo start', { videoId });

  // TODO: decrypt target.apiTokenEnc, call target adapter upload(), write targetPostId + targetPostUrl
}

export async function cleanupArtifacts(videoId: number): Promise<void> {
  const log = Context.current().log;
  log.info('cleanupArtifacts', { videoId });

  // TODO: delete /data/downloads/{videoId}.* and /data/transcodes/{videoId}.*
}

export async function archiveVideo(videoId: number): Promise<void> {
  const log = Context.current().log;
  log.info('archiveVideo', { videoId });

  // TODO: call target adapter archive(targetPostId)
}

/**
 * discoverCreatorVideos — the core discovery activity.
 *
 * 1. Loads creator + source from DB
 * 2. Calls the source adapter's discover() method
 * 3. Applies initialSyncWindowDays filter on first discovery (no prior videos)
 * 4. Inserts new video rows at DOWNLOAD_QUEUED with composite-unique conflict ignored
 * 5. Starts videoPipelineWorkflow for each new video
 * 6. Updates creator lastPolledAt/lastDiscoveredAt
 * 7. Emits creator:update and stats:update SSE events
 * On error: sets lastPollError/lastPollErrorAt, emits creator:update with lastDiscoveryError
 */
export async function discoverCreatorVideos(
  creatorId: number,
): Promise<{ queued: number; alreadyKnown: number }> {
  const log = Context.current().log;
  log.info('discoverCreatorVideos', { creatorId });

  const db = getDb();

  // ── Load creator + source ──────────────────────────────────────────────────

  const [creator] = await db
    .select()
    .from(schema.creators)
    .where(eq(schema.creators.id, creatorId));
  if (!creator) throw new Error(`Creator ${creatorId} not found`);

  const [source] = await db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.id, creator.sourceId));
  if (!source) throw new Error(`Source ${creator.sourceId} not found (creator ${creatorId})`);

  try {
    // ── Source adapter ─────────────────────────────────────────────────────

    const adapter = await getSourceAdapterForType(source.type);

    // ── Count prior videos (for first-run detection) ───────────────────────

    const [{ value: existingCount }] = await db
      .select({ value: count() })
      .from(schema.videos)
      .where(eq(schema.videos.creatorId, creatorId));

    // ── Discover ───────────────────────────────────────────────────────────

    const discoveryResult = await adapter.discover(source.config, {
      handle: creator.handle,
      maxBacklog: creator.maxBacklog ?? undefined,
      maxAgeDays: creator.initialSyncWindowDays ?? undefined,
    });

    let videos = discoveryResult.videos;

    // Apply initialSyncWindowDays filter on first discovery (zero prior videos)
    if (existingCount === 0 && creator.initialSyncWindowDays) {
      const cutoffMs = Date.now() - creator.initialSyncWindowDays * 86_400_000;
      videos = videos.filter((v) => !v.publishedAt || v.publishedAt.getTime() >= cutoffMs);
    }

    // ── Insert new videos ──────────────────────────────────────────────────

    let queued = 0;
    let alreadyKnown = 0;

    for (const video of videos) {
      const [inserted] = await db
        .insert(schema.videos)
        .values({
          creatorId,
          sourceVideoId: video.sourceVideoId,
          sourceVideoUrl: video.sourceVideoUrl,
          title: video.title ?? null,
          description: video.description ?? null,
          hashtags: video.hashtags ?? [],
          sourcePubAt: video.publishedAt ?? null,
          stage: 'DOWNLOAD_QUEUED',
        })
        .onConflictDoNothing()
        .returning({ id: schema.videos.id });

      if (inserted) {
        queued++;
        // Start videoPipelineWorkflow for each new video (best-effort)
        try {
          const client = await getTemporalClient();
          await client.workflow.start('videoPipelineWorkflow', {
            taskQueue: env.TEMPORAL_TASK_QUEUE,
            workflowId: `video-${inserted.id}`,
            args: [{ videoId: inserted.id }],
          });
        } catch (wfErr) {
          log.warn('Failed to start videoPipelineWorkflow', {
            videoId: inserted.id,
            error: String(wfErr),
          });
        }
      } else {
        alreadyKnown++;
        log.debug('video dedup — already known, skipping', {
          creatorId,
          sourceVideoId: video.sourceVideoId,
        });
      }
    }

    // ── Update creator timestamps ─────────────────────────────────────────

    const now = new Date();
    await db
      .update(schema.creators)
      .set({ lastPolledAt: now, lastDiscoveredAt: now, lastPollError: null, lastPollErrorAt: null })
      .where(eq(schema.creators.id, creatorId));

    // ── Collect stage counts and emit SSE ──────────────────────────────────

    const stageCounts = await db
      .select({ stage: schema.videos.stage, value: count() })
      .from(schema.videos)
      .where(eq(schema.videos.creatorId, creatorId))
      .groupBy(schema.videos.stage);

    const videoCounts: Partial<Record<VideoStage, number>> = {};
    for (const row of stageCounts) {
      videoCounts[row.stage] = row.value;
    }

    emitSseEvent('creator:update', { id: creatorId, lastDiscoveredAt: now.toISOString() });
    emitSseEvent('stats:update', {
      videos: videoCounts as Record<VideoStage, number>,
      lastDiscoveredAt: now.toISOString(),
    });

    return { queued, alreadyKnown };
  } catch (err) {
    // ── Error path — update DB + emit failure SSE ──────────────────────────

    const now = new Date();
    const errMsg = err instanceof Error ? err.message : String(err);

    await db
      .update(schema.creators)
      .set({ lastPolledAt: now, lastPollError: errMsg, lastPollErrorAt: now })
      .where(eq(schema.creators.id, creatorId));

    emitSseEvent('creator:update', {
      id: creatorId,
      lastDiscoveredAt: null,
      lastDiscoveryError: errMsg,
    });

    throw err;
  }
}

/**
 * Returns IDs of all enabled creators.
 * Called by discoverAllCreatorsWorkflow to determine the fan-out set.
 */
export async function getEnabledCreatorIds(): Promise<number[]> {
  const log = Context.current().log;
  log.info('getEnabledCreatorIds');

  const db = getDb();
  const rows = await db
    .select({ id: schema.creators.id })
    .from(schema.creators)
    .where(eq(schema.creators.enabled, true));
  return rows.map((r) => r.id);
}
