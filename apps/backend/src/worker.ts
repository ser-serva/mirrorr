import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { env } from './env.js';
import * as activities from './activities/pipeline.activities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const connection = await NativeConnection.connect({
    address: env.TEMPORAL_ADDRESS,
  });

  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath: resolve(__dirname, './workflows/video-pipeline.workflow.ts'),
    activities,
    maxConcurrentActivityTaskExecutions:
      env.DOWNLOAD_CONCURRENCY + env.UPLOAD_CONCURRENCY,
  });

  console.log(`🔧 Temporal worker connected to ${env.TEMPORAL_ADDRESS}`);
  console.log(`   task queue : ${env.TEMPORAL_TASK_QUEUE}`);
  console.log(`   namespace  : ${env.TEMPORAL_NAMESPACE}`);

  await worker.run();
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
