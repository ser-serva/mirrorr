/**
 * discoverCreatorWorkflow — discovers new videos for a single creator.
 *
 * Input: { creatorId: number }
 * Returns: { queued: number; alreadyKnown: number }
 *
 * WorkflowId patterns:
 *   Scheduled: discover-creator-{creatorId}-{epoch}
 *   Manual:    discover-creator-{creatorId}-manual
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as PipelineActivities from '../activities/pipeline.activities.js';

const { discoverCreatorVideos } = proxyActivities<typeof PipelineActivities>({
  // Discovery fetches playlist + per-video metadata via yt-dlp through VPN.
  // Activity heartbeats every 15s during discover() so the server knows it's
  // alive.  heartbeatTimeout = 2 min gives plenty of buffer; startToCloseTimeout
  // = 15 min is the absolute safety cap for the entire discover() call.
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
  },
});

export interface DiscoverCreatorInput {
  creatorId: number;
}

export interface DiscoverCreatorResult {
  queued: number;
  alreadyKnown: number;
}

export async function discoverCreatorWorkflow(
  input: DiscoverCreatorInput,
): Promise<DiscoverCreatorResult> {
  return await discoverCreatorVideos(input.creatorId);
}
