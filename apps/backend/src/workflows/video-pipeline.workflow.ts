import {
  condition,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type * as PipelineActivities from '../activities/pipeline.activities.js';

// ── Activity proxies ──────────────────────────────────────────────────────────

const { updateVideoStage, downloadVideo, transcodeVideo, uploadVideo, cleanupArtifacts, archiveVideo } =
  proxyActivities<typeof PipelineActivities>({
    startToCloseTimeout: '15 minutes',
    retry: {
      maximumAttempts: 6,
      initialInterval: '1 minute',
      backoffCoefficient: 2,
      maximumInterval: '1 hour',
    },
  });

// ── Signals ───────────────────────────────────────────────────────────────────

export const pipelineControlSignal = defineSignal<[{ type: 'ignore' | 'unignore' }]>(
  'pipeline-control',
);

// ── Workflow input ─────────────────────────────────────────────────────────────

export interface VideoPipelineInput {
  videoId: number;
  retentionDays: number; // from targets.config.retentionDays; 0 = skip archival
  sourcePubAtMs: number | null; // epoch ms
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export async function videoPipelineWorkflow(input: VideoPipelineInput): Promise<void> {
  const { videoId, retentionDays, sourcePubAtMs } = input;

  let ignored = false;

  setHandler(pipelineControlSignal, ({ type }) => {
    ignored = type === 'ignore';
    log.info('pipeline-control signal received', { videoId, type });
  });

  /** Suspend until not ignored, then proceed. */
  const resume = () => condition(() => !ignored);

  // ── Download ────────────────────────────────────────────────────────────

  await updateVideoStage(videoId, 'DOWNLOADING');
  await resume();
  await downloadVideo(videoId);
  await updateVideoStage(videoId, 'DOWNLOAD_SUCCEEDED');

  // ── Transcode ───────────────────────────────────────────────────────────

  await updateVideoStage(videoId, 'TRANSCODING');
  await resume();
  await transcodeVideo(videoId);
  await updateVideoStage(videoId, 'TRANSCODE_SUCCEEDED');

  // ── Upload ──────────────────────────────────────────────────────────────

  await updateVideoStage(videoId, 'UPLOADING');
  await resume();
  await uploadVideo(videoId);
  await updateVideoStage(videoId, 'UPLOAD_SUCCEEDED');
  await cleanupArtifacts(videoId);

  // ── Archival (durable sleep) ────────────────────────────────────────────

  if (retentionDays > 0 && sourcePubAtMs !== null) {
    const archiveAtMs = sourcePubAtMs + retentionDays * 24 * 60 * 60 * 1000;
    const sleepMs = archiveAtMs - Date.now();

    if (sleepMs > 0) {
      log.info('sleeping until archival', { videoId, sleepMs });
      await sleep(sleepMs);
    }

    await updateVideoStage(videoId, 'ARCHIVING');
    await archiveVideo(videoId);
    await updateVideoStage(videoId, 'ARCHIVE_SUCCEEDED');
  }
}
