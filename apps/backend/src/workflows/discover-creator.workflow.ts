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
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
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
