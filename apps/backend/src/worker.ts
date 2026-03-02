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
    // Barrel file exports: videoPipelineWorkflow, discoverCreatorWorkflow,
    // discoverAllCreatorsWorkflow — all registered from one entry point.
    // Extension switches between .ts (tsx dev) and .js (compiled prod).
    workflowsPath: resolve(__dirname, `./workflows/index${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`),
    // All pipeline activities including new discovery activities:
    // updateVideoStage, downloadVideo, transcodeVideo, uploadVideo,
    // cleanupArtifacts, archiveVideo, discoverCreatorVideos, getEnabledCreatorIds
    activities,
    maxConcurrentActivityTaskExecutions:
      env.MAX_CONCURRENT_DOWNLOADS + env.UPLOAD_CONCURRENCY,
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
