import { Context, ApplicationFailure } from '@temporalio/activity';
import { count, eq } from 'drizzle-orm';
import { createDb, type Db } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { VideoStage } from '../db/schema.js';
import { emitSseEvent } from '../lib/sse-bus.js';
import { getTemporalClient } from '../temporal/client.js';
import { env } from '../env.js';
import type { SourceAdapter, TargetAdapter } from '@mirrorr/adapter-core';

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
let _targetAdapterFactory: (() => TargetAdapter) | null = null;

/** Override the DB factory (for unit testing activities without file-based SQLite). */
export function _setDbFactory(factory: (() => Db) | null): void {
  _dbFactory = factory;
}

/** Override the source adapter factory (for unit testing activities). */
export function _setSourceAdapterFactory(factory: ((type: string) => SourceAdapter) | null): void {
  _sourceAdapterFactory = factory;
}

/** Override the target adapter factory (for unit testing activities). */
export function _setTargetAdapterFactory(factory: (() => TargetAdapter) | null): void {
  _targetAdapterFactory = factory;
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

async function getTargetAdapter(): Promise<TargetAdapter> {
  if (_targetAdapterFactory) return _targetAdapterFactory();
  const { LoopsAdapter } = await import('@mirrorr/adapter-loops');
  return new LoopsAdapter();
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

export interface DownloadVideoResult {
  localPath: string;
  transcodeDecision: 'passthrough' | 'encode';
}

export async function downloadVideo(videoId: number): Promise<DownloadVideoResult> {
  const log = Context.current().log;
  log.info('downloadVideo start', { videoId });

  const db = getDb();

  // Load video
  const [video] = await db
    .select()
    .from(schema.videos)
    .where(eq(schema.videos.id, videoId));
  if (!video) throw new Error(`Video ${videoId} not found`);

  // Load creator → source chain
  const [creator] = await db
    .select()
    .from(schema.creators)
    .where(eq(schema.creators.id, video.creatorId));
  if (!creator) throw new Error(`Creator ${video.creatorId} not found`);

  const [source] = await db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.id, creator.sourceId));
  if (!source) throw new Error(`Source ${creator.sourceId} not found`);

  const adapter = await getSourceAdapterForType(source.type);

  // Heartbeat every 15s so Temporal knows the activity is alive during long downloads
  let hbInterval: NodeJS.Timeout | null = null;
  try {
    hbInterval = setInterval(() => {
      Context.current().heartbeat({ progress: 'downloading' });
    }, 15_000);

    const localPath = await adapter.download(
      source.config,
      video.sourceVideoUrl,
      '/data/downloads',
    );

    // Decision: always passthrough for now — transcode activity will probe later
    const transcodeDecision = 'passthrough' as const;

    await db
      .update(schema.videos)
      .set({ transcodeDecision, localPath })
      .where(eq(schema.videos.id, videoId));

    return { localPath, transcodeDecision };
  } finally {
    if (hbInterval) clearInterval(hbInterval);
  }
}

export async function transcodeVideo(videoId: number): Promise<void> {
  const log = Context.current().log;
  log.info('transcodeVideo start', { videoId });

  // TODO: probe with ffprobe, decide passthrough vs encode, run ffmpeg
}

export async function uploadVideo(videoId: number): Promise<void> {
  const log = Context.current().log;
  log.info('uploadVideo start', { videoId });

  const db = getDb();

  // ── Load video ─────────────────────────────────────────────────────────────

  const [video] = await db
    .select()
    .from(schema.videos)
    .where(eq(schema.videos.id, videoId));
  if (!video) throw new Error(`Video ${videoId} not found`);

  // ── Idempotency guard ──────────────────────────────────────────────────────

  if (video.stage === 'UPLOAD_SUCCEEDED') {
    log.info('uploadVideo: already UPLOAD_SUCCEEDED, returning', { videoId });
    return;
  }

  // ── Load creator ───────────────────────────────────────────────────────────

  const [creator] = await db
    .select()
    .from(schema.creators)
    .where(eq(schema.creators.id, video.creatorId));
  if (!creator) throw new Error(`Creator ${video.creatorId} not found`);

  // ── Resolve effective upload target ────────────────────────────────────────

  const effectiveTargetId: number | null = creator.mirrorTargetId ?? creator.targetId ?? null;
  if (!effectiveTargetId) {
    throw ApplicationFailure.nonRetryable(
      'Creator has no upload target configured',
      'NO_UPLOAD_TARGET',
    );
  }

  const [target] = await db
    .select()
    .from(schema.targets)
    .where(eq(schema.targets.id, effectiveTargetId));
  if (!target) throw new Error(`Target ${effectiveTargetId} not found`);

  // ── Decrypt token & assemble config ───────────────────────────────────────

  const { decrypt } = await import('../lib/crypto.js');
  const apiToken = decrypt(target.apiTokenEnc);

  const config = {
    url: target.url,
    apiToken,
    titleTemplate: target.publicationConfig?.titleTemplate,
    descriptionTemplate: target.publicationConfig?.descriptionTemplate,
    maxVideoMb: target.config?.maxVideoMb ?? 500,
    minVideoKb: target.config?.minVideoKb ?? 250,
  };

  // ── Resolve file path ──────────────────────────────────────────────────────

  const filePath = video.transcodedPath ?? video.localPath;
  if (!filePath) {
    throw ApplicationFailure.nonRetryable(
      `Video ${videoId} has no local file path (neither transcodedPath nor localPath is set)`,
      'FILE_PATH_MISSING',
    );
  }

  // ── File size guard ────────────────────────────────────────────────────────

  const { stat, unlink } = await import('node:fs/promises');
  let fileSize: number;
  try {
    const stats = await stat(filePath);
    fileSize = stats.size;
  } catch {
    throw ApplicationFailure.nonRetryable(
      `Video file not found on disk: ${filePath}`,
      'FILE_NOT_FOUND',
    );
  }

  const minBytes = config.minVideoKb * 1024;
  if (fileSize < minBytes) {
    throw ApplicationFailure.nonRetryable(
      `Video file is too small: ${fileSize} bytes (min ${config.minVideoKb} KB)`,
      'FILE_TOO_SMALL',
    );
  }

  const maxBytes = config.maxVideoMb * 1024 * 1024;
  if (fileSize > maxBytes) {
    throw ApplicationFailure.nonRetryable(
      `Video file is too large: ${fileSize} bytes (max ${config.maxVideoMb} MB)`,
      'FILE_TOO_LARGE',
    );
  }

  // ── Call upload adapter ────────────────────────────────────────────────────

  const targetAdapter = await getTargetAdapter();

  const uploadOptions = {
    title: video.title ?? undefined,
    description: video.description ?? undefined,
    hashtags: video.hashtags ?? undefined,
  };

  const result = await targetAdapter.upload(config, uploadOptions, filePath);

  // ── Persist result & clean up ──────────────────────────────────────────────

  await db
    .update(schema.videos)
    .set({
      targetPostId: result.postId,
      targetPostUrl: result.postUrl ?? null,
    })
    .where(eq(schema.videos.id, videoId));

  // Delete local file (best-effort)
  try {
    await unlink(filePath);
  } catch (err) {
    log.warn('uploadVideo: failed to delete local file', { filePath, error: String(err) });
  }

  log.info('uploadVideo complete', { videoId, postId: result.postId });
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

    const [countRow] = await db
      .select({ value: count() })
      .from(schema.videos)
      .where(eq(schema.videos.creatorId, creatorId));
    const existingCount = countRow?.value ?? 0;

    // ── Discover ───────────────────────────────────────────────────────────
    //
    // adapter.discover() spawns sequential yt-dlp sub-processes through the
    // VPN proxy — each one can take 20-60s.  Emit a heartbeat every 15 seconds
    // so Temporal knows the activity is alive for the duration of the call.

    const heartbeatInterval = setInterval(() => {
      Context.current().heartbeat({ status: 'discovering', creatorId });
    }, 15_000);

    let discoveryResult: Awaited<ReturnType<typeof adapter.discover>>;
    try {
      discoveryResult = await adapter.discover(source.config, {
        handle: creator.handle,
        maxBacklog: creator.maxBacklog ?? undefined,
        maxAgeDays: creator.initialSyncWindowDays ?? undefined,
      });
    } finally {
      clearInterval(heartbeatInterval);
    }

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
          const wfId = `video-${inserted.id}`;
          await client.workflow.start('videoPipelineWorkflow', {
            taskQueue: env.TEMPORAL_TASK_QUEUE,
            workflowId: wfId,
            args: [{
              videoId: inserted.id,
              retentionDays: 0, // TODO: load from target.config.retentionDays
              sourcePubAtMs: video.publishedAt?.getTime() ?? null,
            }],
          });
          // Persist workflow ID so the video can be signalled, cancelled, or retried later
          await db
            .update(schema.videos)
            .set({ temporalWorkflowId: wfId })
            .where(eq(schema.videos.id, inserted.id));
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
