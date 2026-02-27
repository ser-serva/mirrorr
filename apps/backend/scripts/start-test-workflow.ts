/**
 * Quick smoke test — starts a videoPipelineWorkflow and prints a link
 * to watch it in the Temporal UI.
 *
 * Usage:
 *   pnpm exec tsx --env-file=../../infra/dev/.env scripts/start-test-workflow.ts
 */
import { getTemporalClient } from '../src/temporal/client.js';
import { env } from '../src/env.js';

const TASK_QUEUE = env.TEMPORAL_TASK_QUEUE;

async function main() {
  const client = await getTemporalClient();

  const workflowId = `test-video-${Date.now()}`;

  const handle = await client.workflow.start('videoPipelineWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [
      {
        videoId: 999,
        sourceUrl: 'https://www.tiktok.com/@test/video/123456789',
        creatorHandle: '@test-creator',
      },
    ],
  });

  console.log(`\n✅ Workflow started!`);
  console.log(`   Workflow ID : ${handle.workflowId}`);
  console.log(`   Run ID      : ${handle.firstExecutionRunId}`);
  console.log(
    `\n🔗 View in Temporal UI:\n   http://localhost:8080/namespaces/default/workflows/${encodeURIComponent(workflowId)}\n`,
  );

  // Poll for a few seconds so you can see it transition
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const desc = await handle.describe();
    console.log(`   status: ${desc.status.name}`);
  }

  console.log('\nDone polling. Workflow continues running on the worker.');
  await client.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
