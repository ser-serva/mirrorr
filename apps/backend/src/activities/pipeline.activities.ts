import { Context } from '@temporalio/activity';
import type { VideoStage } from '../db/schema.js';

/**
 * Activities run in the main Node.js process — they can use any Node.js APIs,
 * access the DB, spawn child processes, call adapters, etc.
 *
 * The Temporal worker injects retry / heartbeat infrastructure automatically.
 * Activity functions must NOT import from @temporalio/workflow.
 */

export async function updateVideoStage(videoId: number, stage: VideoStage): Promise<void> {
  const log = Context.current().log;
  log.info('updateVideoStage', { videoId, stage });

  // TODO: update videos.stage + stageUpdatedAt in DB, then emit SSE event
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

export async function discoverCreatorVideos(creatorId: number): Promise<number[]> {
  const log = Context.current().log;
  log.info('discoverCreatorVideos', { creatorId });

  // TODO: call source adapter discover(), insert new video rows, return new videoIds
  return [];
}
