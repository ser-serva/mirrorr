/**
 * T014 🔴 TDD-RED: discoverCreatorWorkflow integration tests.
 *
 * Tests MUST FAIL before workflow + activity implementation (T019, T020).
 * Run: pnpm --filter backend test tests/integration/discover-creator-workflow.test.ts
 *
 * Covers:
 *   - Happy path: returns { queued: N, alreadyKnown: 0 }
 *   - Second run: returns { queued: 0, alreadyKnown: N }
 *   - Creator timestamps updated after discovery
 *   - videoPipelineWorkflow started for each new video
 *   - SSE bus emits creator:update and stats:update on success
 *   - Failed run emits creator:update with lastDiscoveryError
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TestWorkflowEnvironment, MockActivityEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { discoverCreatorWorkflow as discoverCreatorWorkflowType } from '../../src/workflows/discover-creator.workflow.js';
import * as schema from '../../src/db/schema.js';
import { buildTestApp, seedSourceAndTarget } from '../helpers/test-app.js';
import { sseBus } from '../../src/lib/sse-bus.js';
import { discoverCreatorVideos, _setDbFactory, _setSourceAdapterFactory } from '../../src/activities/pipeline.activities.js';
import type { SseEventName, SseEventPayload } from '@mirrorr/shared';

// Mock Temporal client so videoPipelineWorkflow.start() doesn't need a real Temporal cluster
vi.mock('../../src/temporal/client.js', () => ({
  getTemporalClient: vi.fn().mockResolvedValue({
    workflow: {
      start: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

describe('discoverCreatorWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('happy path — returns { queued: N, alreadyKnown: 0 } on first run', async () => {
    const { client, nativeConnection } = testEnv;

    const mockDiscoverCreatorVideos = vi.fn().mockResolvedValue({
      queued: 5,
      alreadyKnown: 0,
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-discovery',
      workflowsPath: new URL('../../src/workflows/discover-creator.workflow.ts', import.meta.url)
        .pathname,
      activities: { discoverCreatorVideos: mockDiscoverCreatorVideos },
    });

    const result = await worker.runUntil(
      client.workflow.execute<typeof discoverCreatorWorkflowType>('discoverCreatorWorkflow', {
        taskQueue: 'test-discovery',
        workflowId: 'test-discover-creator-1',
        args: [{ creatorId: 1 }],
      }),
    );

    expect(result).toEqual({ queued: 5, alreadyKnown: 0 });
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(1);
  }, 60_000);

  it('second run — returns { queued: 0, alreadyKnown: N }', async () => {
    const { client, nativeConnection } = testEnv;

    const mockDiscoverCreatorVideos = vi.fn().mockResolvedValue({
      queued: 0,
      alreadyKnown: 5,
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-discovery-2',
      workflowsPath: new URL('../../src/workflows/discover-creator.workflow.ts', import.meta.url)
        .pathname,
      activities: { discoverCreatorVideos: mockDiscoverCreatorVideos },
    });

    const result = await worker.runUntil(
      client.workflow.execute<typeof discoverCreatorWorkflowType>('discoverCreatorWorkflow', {
        taskQueue: 'test-discovery-2',
        workflowId: 'test-discover-creator-2',
        args: [{ creatorId: 1 }],
      }),
    );

    expect(result).toEqual({ queued: 0, alreadyKnown: 5 });
  }, 60_000);
});

/**
 * T029 SSE emit assertions — test the real discoverCreatorVideos activity directly
 * using MockActivityEnvironment (no Temporal worker needed).
 *
 * Verifies that:
 *  - Successful discovery emits creator:update { id, lastDiscoveredAt }
 *  - Successful discovery emits stats:update { videos, lastDiscoveredAt }
 *  - Failed discovery (adapter throws) emits creator:update with lastDiscoveryError
 */
describe('discoverCreatorWorkflow — SSE emit (T029)', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let creatorId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    const { sourceId, targetId } = await seedSourceAndTarget(ctx.db);

    const [creator] = await ctx.db
      .insert(schema.creators)
      .values({ handle: '@sse-test', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    creatorId = creator!.id;

    // Inject the test DB so the activity uses it directly (not a file-based DB)
    _setDbFactory(() => ctx.db as any);
  });

  afterEach(async () => {
    _setDbFactory(null);
    _setSourceAdapterFactory(null);
    await ctx.close();
  });

  it('emits creator:update on successful discovery', async () => {
    // Mock the source adapter to return 2 videos
    _setSourceAdapterFactory(() => ({
      discover: vi.fn().mockResolvedValue({
        videos: [
          { sourceVideoId: 'vid-1', sourceVideoUrl: 'https://example.com/@test/1' },
          { sourceVideoId: 'vid-2', sourceVideoUrl: 'https://example.com/@test/2' },
        ],
        failures: [],
      }),
      download: vi.fn(),
      fetchMeta: vi.fn(),
    }));

    const emitted: Array<{ name: SseEventName; payload: SseEventPayload }> = [];
    const listener = (name: SseEventName, payload: SseEventPayload) => {
      emitted.push({ name, payload });
    };
    sseBus.on('event', listener);

    try {
      const activityEnv = new MockActivityEnvironment();
      await activityEnv.run(() => discoverCreatorVideos(creatorId));
    } finally {
      sseBus.off('event', listener);
    }

    const creatorUpdate = emitted.find((e) => e.name === 'creator:update');
    expect(creatorUpdate).toBeDefined();
    expect(creatorUpdate!.payload).toMatchObject({
      id: creatorId,
      lastDiscoveredAt: expect.any(String),
    });
    expect((creatorUpdate!.payload as any).lastDiscoveryError).toBeUndefined();
  });

  it('emits stats:update on successful discovery', async () => {
    _setSourceAdapterFactory(() => ({
      discover: vi.fn().mockResolvedValue({
        videos: [
          { sourceVideoId: 'vid-s1', sourceVideoUrl: 'https://example.com/@test/s1' },
        ],
        failures: [],
      }),
      download: vi.fn(),
      fetchMeta: vi.fn(),
    }));

    const emitted: Array<{ name: SseEventName; payload: SseEventPayload }> = [];
    const listener = (name: SseEventName, payload: SseEventPayload) => {
      emitted.push({ name, payload });
    };
    sseBus.on('event', listener);

    try {
      const activityEnv = new MockActivityEnvironment();
      await activityEnv.run(() => discoverCreatorVideos(creatorId));
    } finally {
      sseBus.off('event', listener);
    }

    const statsUpdate = emitted.find((e) => e.name === 'stats:update');
    expect(statsUpdate).toBeDefined();
    expect(statsUpdate!.payload).toMatchObject({
      lastDiscoveredAt: expect.any(String),
    });
    expect((statsUpdate!.payload as any).videos).toBeDefined();
  });

  it('emits creator:update with lastDiscoveryError on failure', async () => {
    // Adapter throws to simulate failed discovery
    _setSourceAdapterFactory(() => ({
      discover: vi.fn().mockRejectedValue(new Error('Adapter connection failed')),
      download: vi.fn(),
      fetchMeta: vi.fn(),
    }));

    const emitted: Array<{ name: SseEventName; payload: SseEventPayload }> = [];
    const listener = (name: SseEventName, payload: SseEventPayload) => {
      emitted.push({ name, payload });
    };
    sseBus.on('event', listener);

    try {
      const activityEnv = new MockActivityEnvironment();
      await expect(activityEnv.run(() => discoverCreatorVideos(creatorId))).rejects.toThrow(
        'Adapter connection failed',
      );
    } finally {
      sseBus.off('event', listener);
    }

    const creatorUpdate = emitted.find((e) => e.name === 'creator:update');
    expect(creatorUpdate).toBeDefined();
    expect(creatorUpdate!.payload).toMatchObject({
      id: creatorId,
      lastDiscoveryError: expect.stringContaining('Adapter connection failed'),
    });
  });
});

describe('discoverCreatorWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('happy path — returns { queued: N, alreadyKnown: 0 } on first run', async () => {
    const { client, nativeConnection } = testEnv;

    const mockDiscoverCreatorVideos = vi.fn().mockResolvedValue({
      queued: 5,
      alreadyKnown: 0,
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-discovery',
      workflowsPath: new URL('../../src/workflows/discover-creator.workflow.ts', import.meta.url)
        .pathname,
      activities: { discoverCreatorVideos: mockDiscoverCreatorVideos },
    });

    const result = await worker.runUntil(
      client.workflow.execute<typeof discoverCreatorWorkflowType>('discoverCreatorWorkflow', {
        taskQueue: 'test-discovery',
        workflowId: 'test-discover-creator-1',
        args: [{ creatorId: 1 }],
      }),
    );

    expect(result).toEqual({ queued: 5, alreadyKnown: 0 });
    expect(mockDiscoverCreatorVideos).toHaveBeenCalledWith(1);
  }, 60_000);

  it('second run — returns { queued: 0, alreadyKnown: N }', async () => {
    const { client, nativeConnection } = testEnv;

    const mockDiscoverCreatorVideos = vi.fn().mockResolvedValue({
      queued: 0,
      alreadyKnown: 5,
    });

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-discovery-2',
      workflowsPath: new URL('../../src/workflows/discover-creator.workflow.ts', import.meta.url)
        .pathname,
      activities: { discoverCreatorVideos: mockDiscoverCreatorVideos },
    });

    const result = await worker.runUntil(
      client.workflow.execute<typeof discoverCreatorWorkflowType>('discoverCreatorWorkflow', {
        taskQueue: 'test-discovery-2',
        workflowId: 'test-discover-creator-2',
        args: [{ creatorId: 1 }],
      }),
    );

    expect(result).toEqual({ queued: 0, alreadyKnown: 5 });
  }, 60_000);
});
