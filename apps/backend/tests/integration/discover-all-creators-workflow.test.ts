/**
 * T021a 🔴 TDD-RED: discoverAllCreatorsWorkflow integration tests.
 *
 * Tests MUST FAIL before workflow implementation (T021).
 * Run: pnpm --filter backend test tests/integration/discover-all-creators-workflow.test.ts
 *
 * Covers:
 *   - Coordinator fans out one child per enabled creator ID (correct child count)
 *   - One child failing does NOT abort siblings (Promise.allSettled semantics) — SC-004
 *   - Disabled creators are excluded from fan-out (FR-005)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { discoverAllCreatorsWorkflow as discoverAllCreatorsWorkflowType } from '../../src/workflows/discover-all-creators.workflow.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('discoverAllCreatorsWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('fans out one child per enabled creator returned by getEnabledCreatorIds', async () => {
    const { client, nativeConnection } = testEnv;

    const mockGetEnabledCreatorIds = vi.fn().mockResolvedValue([1, 2, 3]);
    const mockDiscoverCreatorVideos = vi.fn().mockResolvedValue({ queued: 2, alreadyKnown: 0 });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-all-creators',
      workflowsPath: resolve(__dirname, '../../src/workflows/index.ts'),
      activities: {
        getEnabledCreatorIds: mockGetEnabledCreatorIds,
        discoverCreatorVideos: mockDiscoverCreatorVideos,
      },
    });

    await worker.runUntil(
      client.workflow.execute<typeof discoverAllCreatorsWorkflowType>(
        'discoverAllCreatorsWorkflow',
        {
          taskQueue: 'test-all-creators',
          workflowId: 'test-discover-all',
          args: [],
        },
      ),
    );

    expect(mockDiscoverCreatorVideos).toHaveBeenCalledTimes(3);
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(1);
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(2);
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(3);
  }, 60_000);

  it('one child failing does NOT abort siblings (Promise.allSettled semantics)', async () => {
    const { client, nativeConnection } = testEnv;

    let call = 0;
    const mockGetEnabledCreatorIds = vi.fn().mockResolvedValue([1, 2, 3]);
    // Creator 2 fails, others succeed
    const mockDiscoverCreatorVideos = vi.fn().mockImplementation(async (creatorId: number) => {
      call++;
      if (creatorId === 2) {
        throw new Error('Creator 2 discovery failed');
      }
      return { queued: 1, alreadyKnown: 0 };
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-all-creators-fail',
      workflowsPath: resolve(__dirname, '../../src/workflows/index.ts'),
      activities: {
        getEnabledCreatorIds: mockGetEnabledCreatorIds,
        discoverCreatorVideos: mockDiscoverCreatorVideos,
      },
    });

    // Coordinator should succeed even when one child fails
    await worker.runUntil(
      client.workflow.execute<typeof discoverAllCreatorsWorkflowType>(
        'discoverAllCreatorsWorkflow',
        {
          taskQueue: 'test-all-creators-fail',
          workflowId: 'test-discover-all-fail',
          args: [],
        },
      ),
    );

    // All 3 creator IDs were attempted (siblings not stopped by one failure).
    // Creator 2 may be called more than once due to Temporal activity retries.
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(1);
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(2);
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(3);
    expect(mockDiscoverCreatorVideos.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('returns immediately with no fan-out when no enabled creators', async () => {
    const { client, nativeConnection } = testEnv;

    const mockGetEnabledCreatorIds = vi.fn().mockResolvedValue([]);
    const mockDiscoverCreatorVideos = vi.fn();

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-all-creators-empty',
      workflowsPath: resolve(__dirname, '../../src/workflows/index.ts'),
      activities: {
        getEnabledCreatorIds: mockGetEnabledCreatorIds,
        discoverCreatorVideos: mockDiscoverCreatorVideos,
      },
    });

    await worker.runUntil(
      client.workflow.execute<typeof discoverAllCreatorsWorkflowType>(
        'discoverAllCreatorsWorkflow',
        {
          taskQueue: 'test-all-creators-empty',
          workflowId: 'test-discover-all-empty',
          args: [],
        },
      ),
    );

    expect(mockDiscoverCreatorVideos).not.toHaveBeenCalled();
  }, 60_000);
});
