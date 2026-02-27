/**
 * discoverAllCreatorsWorkflow — global discovery coordinator.
 *
 * Fired by the `discover-all-creators` Temporal Schedule on each poll interval.
 * Fetches all enabled creator IDs via activity, then fans out one
 * `discoverCreatorWorkflow` child per creator using `startChild`.
 * Uses Promise.allSettled so a single child failure does NOT abort siblings (SC-004).
 */
import { log, proxyActivities, startChild } from '@temporalio/workflow';
import type * as PipelineActivities from '../activities/pipeline.activities.js';
import { discoverCreatorWorkflow } from './discover-creator.workflow.js';

const { getEnabledCreatorIds } = proxyActivities<typeof PipelineActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

export async function discoverAllCreatorsWorkflow(): Promise<void> {
  const creatorIds = await getEnabledCreatorIds();

  if (creatorIds.length === 0) {
    log.info('discoverAllCreatorsWorkflow: no enabled creators, nothing to do');
    return;
  }

  log.info('discoverAllCreatorsWorkflow: fanning out', { count: creatorIds.length });

  // Start all child workflows concurrently — each is independently observable
  const epoch = Date.now();
  const handles = await Promise.all(
    creatorIds.map((creatorId) =>
      startChild(discoverCreatorWorkflow, {
        args: [{ creatorId }],
        workflowId: `discover-creator-${creatorId}-${epoch}`,
      }),
    ),
  );

  // Wait for all children — failures are logged but do NOT abort siblings
  const results = await Promise.allSettled(handles.map((h) => h.result()));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const creatorId = creatorIds[i];
    if (result?.status === 'rejected') {
      log.error('discoverCreatorWorkflow child failed', {
        creatorId,
        error: String(result.reason),
      });
    } else if (result?.status === 'fulfilled') {
      log.info('discoverCreatorWorkflow child succeeded', {
        creatorId,
        ...(result.value as object),
      });
    }
  }
}
