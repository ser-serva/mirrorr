/**
 * T019 🔴 TDD-RED: videoPipelineWorkflow transcode-bypass tests.
 *
 * Tests MUST FAIL before workflow update (T020).
 * Run: pnpm --filter backend test tests/unit/video-pipeline-workflow.test.ts
 *
 * Covers:
 *   - transcodeVideo NOT called when downloadVideo returns transcodeDecision: passthrough
 *   - Stage sequence DOWNLOAD_SUCCEEDED → UPLOADING (no TRANSCODING / TRANSCODE_SUCCEEDED)
 *   - transcodeVideo IS called + full stage sequence when transcodeDecision: encode
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { videoPipelineWorkflow as VideoPipelineWorkflowType } from '../../src/workflows/video-pipeline.workflow.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal activity set for the pipeline worker. */
function makeActivities(
  downloadResult: { localPath: string; transcodeDecision: 'passthrough' | 'encode' },
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
) {
  return {
    updateVideoStage: vi.fn().mockResolvedValue(undefined),
    downloadVideo: vi.fn().mockResolvedValue(downloadResult),
    transcodeVideo: vi.fn().mockResolvedValue(undefined),
    uploadVideo: vi.fn().mockResolvedValue(undefined),
    cleanupArtifacts: vi.fn().mockResolvedValue(undefined),
    archiveVideo: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const WORKFLOWS_PATH = new URL(
  '../../src/workflows/video-pipeline.workflow.ts',
  import.meta.url,
).pathname;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('videoPipelineWorkflow — transcode bypass', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('does NOT call transcodeVideo when transcodeDecision is passthrough', async () => {
    const { client, nativeConnection } = testEnv;
    const activities = makeActivities({
      localPath: '/data/downloads/1.mp4',
      transcodeDecision: 'passthrough',
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-vp-passthrough-1',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    await worker.runUntil(
      client.workflow.execute<typeof VideoPipelineWorkflowType>('videoPipelineWorkflow', {
        taskQueue: 'test-vp-passthrough-1',
        workflowId: 'test-vp-passthrough-1',
        args: [{ videoId: 1, retentionDays: 0, sourcePubAtMs: null }],
      }),
    );

    // Currently FAILS: workflow unconditionally calls transcodeVideo
    expect(activities.transcodeVideo).not.toHaveBeenCalled();
  }, 60_000);

  it('moves DOWNLOAD_SUCCEEDED → UPLOADING with no TRANSCODING stages in passthrough path', async () => {
    const { client, nativeConnection } = testEnv;
    const activities = makeActivities({
      localPath: '/data/downloads/1.mp4',
      transcodeDecision: 'passthrough',
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-vp-passthrough-2',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    await worker.runUntil(
      client.workflow.execute<typeof VideoPipelineWorkflowType>('videoPipelineWorkflow', {
        taskQueue: 'test-vp-passthrough-2',
        workflowId: 'test-vp-passthrough-2',
        args: [{ videoId: 1, retentionDays: 0, sourcePubAtMs: null }],
      }),
    );

    const stageSequence = activities.updateVideoStage.mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );

    // Currently FAILS: TRANSCODING + TRANSCODE_SUCCEEDED still appear in sequence
    expect(stageSequence).not.toContain('TRANSCODING');
    expect(stageSequence).not.toContain('TRANSCODE_SUCCEEDED');

    const downloadSuccIdx = stageSequence.indexOf('DOWNLOAD_SUCCEEDED');
    const uploadingIdx = stageSequence.indexOf('UPLOADING');
    expect(downloadSuccIdx).toBeGreaterThanOrEqual(0);
    expect(uploadingIdx).toBeGreaterThanOrEqual(0);
    // UPLOADING must be the very next stage after DOWNLOAD_SUCCEEDED
    expect(uploadingIdx).toBe(downloadSuccIdx + 1);
  }, 60_000);

  it('DOES call transcodeVideo when transcodeDecision is encode', async () => {
    const { client, nativeConnection } = testEnv;
    const activities = makeActivities({
      localPath: '/data/downloads/1.mp4',
      transcodeDecision: 'encode',
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-vp-encode-1',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    await worker.runUntil(
      client.workflow.execute<typeof VideoPipelineWorkflowType>('videoPipelineWorkflow', {
        taskQueue: 'test-vp-encode-1',
        workflowId: 'test-vp-encode-1',
        args: [{ videoId: 1, retentionDays: 0, sourcePubAtMs: null }],
      }),
    );

    // encode path: transcodeVideo must still be called
    expect(activities.transcodeVideo).toHaveBeenCalledWith(1);
  }, 60_000);

  it('includes TRANSCODING + TRANSCODE_SUCCEEDED stages in encode path', async () => {
    const { client, nativeConnection } = testEnv;
    const activities = makeActivities({
      localPath: '/data/downloads/1.mp4',
      transcodeDecision: 'encode',
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-vp-encode-2',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    await worker.runUntil(
      client.workflow.execute<typeof VideoPipelineWorkflowType>('videoPipelineWorkflow', {
        taskQueue: 'test-vp-encode-2',
        workflowId: 'test-vp-encode-2',
        args: [{ videoId: 1, retentionDays: 0, sourcePubAtMs: null }],
      }),
    );

    const stageSequence = activities.updateVideoStage.mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );

    expect(stageSequence).toContain('TRANSCODING');
    expect(stageSequence).toContain('TRANSCODE_SUCCEEDED');
    expect(stageSequence).toContain('UPLOADING');
  }, 60_000);
});
