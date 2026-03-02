/**
 * T009 🔴 TDD-RED: uploadVideo activity unit tests.
 *
 * Tests MUST FAIL before T011 (uploadVideo implementation).
 * Run: pnpm --filter backend test tests/unit/upload-activity.test.ts
 *
 * Covers:
 *   - Idempotency: returns immediately when video stage is UPLOAD_SUCCEEDED
 *   - Mirror target resolution: prefers mirrorTargetId over targetId when both set
 *   - Creator with neither targetId nor mirrorTargetId → ApplicationFailure.nonRetryable
 *   - File missing on disk → ApplicationFailure.nonRetryable
 *   - File below minVideoKb → ApplicationFailure.nonRetryable
 *   - File above maxVideoMb → ApplicationFailure.nonRetryable
 *   - Successful upload persists targetPostId + targetPostUrl and deletes local file
 *   - Prefers video.transcodedPath over video.localPath when both set
 *   - Recoverable HTTP error propagates so Temporal retries
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/activity';
import { eq } from 'drizzle-orm';
import { createTestDb, seedSourceAndTarget } from '../helpers/test-app.js';
import * as schema from '../../src/db/schema.js';
import {
  uploadVideo,
  _setDbFactory,
  _setTargetAdapterFactory,
} from '../../src/activities/pipeline.activities.js';
import { encrypt } from '../../src/lib/crypto.js';

// ── Mock fs/promises ──────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const fsMocks = await import('node:fs/promises');
const mockStat = vi.mocked(fsMocks.stat);
const mockUnlink = vi.mocked(fsMocks.unlink);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupTestVideo(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    stage?: schema.VideoStage;
    localPath?: string | null;
    transcodedPath?: string | null;
    targetId?: number;
    mirrorTargetId?: number | null;
  } = {},
) {
  const { sourceId, targetId: defaultTargetId } = await seedSourceAndTarget(db);
  const targetId = overrides.targetId ?? defaultTargetId;

  const [creator] = await db
    .insert(schema.creators)
    .values({
      handle: '@testuser',
      sourceId,
      targetId,
      enabled: true,
      mirrorTargetId: overrides.mirrorTargetId !== undefined ? overrides.mirrorTargetId : null,
    })
    .returning({ id: schema.creators.id });

  const [video] = await db
    .insert(schema.videos)
    .values({
      creatorId: creator!.id,
      sourceVideoId: 'vid001',
      sourceVideoUrl: 'https://www.tiktok.com/@testuser/video/vid001',
      stage: overrides.stage ?? 'DOWNLOAD_SUCCEEDED',
      localPath: overrides.localPath !== undefined ? overrides.localPath : '/data/downloads/vid001.mp4',
      transcodedPath: overrides.transcodedPath !== undefined ? overrides.transcodedPath : null,
    })
    .returning({ id: schema.videos.id });

  return { videoId: video!.id, creatorId: creator!.id, sourceId, targetId };
}

async function seedMirrorTarget(db: ReturnType<typeof createTestDb>['db'], apiToken = 'mirror-token') {
  const [target] = await db
    .insert(schema.targets)
    .values({
      name: 'Mirror loops',
      type: 'loops',
      url: 'http://loops.mirror.test',
      apiTokenEnc: encrypt(apiToken),
      publicationConfig: {},
      config: { maxVideoMb: 500, minVideoKb: 250 },
      isMirror: true,
      enabled: true,
    })
    .returning({ id: schema.targets.id });
  return target!.id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('uploadVideo activity', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let mockUpload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDb = createTestDb();

    mockUpload = vi.fn().mockResolvedValue({ postId: 'post-123', postUrl: 'http://loops.test/posts/post-123' });

    // Default: file exists and is 1 MB
    mockStat.mockResolvedValue({ size: 1024 * 1024 } as any);
    mockUnlink.mockResolvedValue(undefined);

    _setDbFactory(() => testDb.db as any);
    _setTargetAdapterFactory(() => ({
      upload: mockUpload,
      test: vi.fn(),
    }));
  });

  afterEach(() => {
    _setDbFactory(null);
    _setTargetAdapterFactory(null);
    testDb.close();
    vi.clearAllMocks();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it('returns immediately without calling adapter when stage is already UPLOAD_SUCCEEDED', async () => {
    const { videoId } = await setupTestVideo(testDb.db, { stage: 'UPLOAD_SUCCEEDED' });

    const env = new MockActivityEnvironment();
    await env.run(uploadVideo, videoId);

    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── Target resolution ───────────────────────────────────────────────────────

  it('uses mirrorTargetId over targetId when both set', async () => {
    const mirrorTargetId = await seedMirrorTarget(testDb.db, 'mirror-token');
    const { videoId } = await setupTestVideo(testDb.db, { mirrorTargetId });

    const env = new MockActivityEnvironment();
    await env.run(uploadVideo, videoId);

    // The upload should have been called with config using the mirror target's URL
    expect(mockUpload).toHaveBeenCalledOnce();
    const [config] = mockUpload.mock.calls[0]!;
    expect((config as { url: string }).url).toBe('http://loops.mirror.test');
  });

  it('throws nonRetryable when creator has neither targetId nor mirrorTargetId', async () => {
    // Use a fully mocked DB that simulates a creator with no upload target.
    // (The real schema has targetId NOT NULL, but a misconfigured or future
    // state could have a creator without a valid upload target.)
    const fakeVideoId = 9999;
    const fakeCreatorId = 8888;

    _setDbFactory(() => {
      let callCount = 0;
      return {
        select: () => ({
          from: () => ({
            where: () => {
              callCount++;
              if (callCount === 1) {
                // First call: return video
                return Promise.resolve([{
                  id: fakeVideoId,
                  creatorId: fakeCreatorId,
                  stage: 'DOWNLOAD_SUCCEEDED',
                  localPath: '/data/downloads/vid-fake.mp4',
                  transcodedPath: null,
                  title: null,
                  description: null,
                  hashtags: [],
                }]);
              }
              if (callCount === 2) {
                // Second call: return creator with no targetId or mirrorTargetId
                return Promise.resolve([{
                  id: fakeCreatorId,
                  handle: '@fakeuser',
                  sourceId: 1,
                  targetId: null,
                  mirrorTargetId: null,
                  enabled: true,
                }]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      } as any;
    });

    const env = new MockActivityEnvironment();

    await expect(env.run(uploadVideo, fakeVideoId)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApplicationFailure &&
        err.nonRetryable === true &&
        err.message.toLowerCase().includes('no upload target'),
    );
  });

  // ── File guard ──────────────────────────────────────────────────────────────

  it('throws nonRetryable when local file is missing (ENOENT)', async () => {
    const { videoId } = await setupTestVideo(testDb.db);

    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(enoent);

    const env = new MockActivityEnvironment();
    await expect(env.run(uploadVideo, videoId)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApplicationFailure && err.nonRetryable === true,
    );
  });

  it('throws nonRetryable when file size is below minVideoKb', async () => {
    const { videoId } = await setupTestVideo(testDb.db);

    // Default minVideoKb is 250 KB; make file 10 KB
    mockStat.mockResolvedValue({ size: 10 * 1024 } as any);

    const env = new MockActivityEnvironment();
    await expect(env.run(uploadVideo, videoId)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApplicationFailure && err.nonRetryable === true,
    );
  });

  it('throws nonRetryable when file size exceeds maxVideoMb', async () => {
    const { videoId } = await setupTestVideo(testDb.db);

    // Default maxVideoMb is 500; make file 600 MB
    mockStat.mockResolvedValue({ size: 600 * 1024 * 1024 } as any);

    const env = new MockActivityEnvironment();
    await expect(env.run(uploadVideo, videoId)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApplicationFailure && err.nonRetryable === true,
    );
  });

  // ── Successful upload ───────────────────────────────────────────────────────

  it('persists targetPostId and targetPostUrl in DB after successful upload', async () => {
    const { videoId } = await setupTestVideo(testDb.db);

    const env = new MockActivityEnvironment();
    await env.run(uploadVideo, videoId);

    const [updated] = await testDb.db
      .select({ targetPostId: schema.videos.targetPostId, targetPostUrl: schema.videos.targetPostUrl })
      .from(schema.videos)
      .where(eq(schema.videos.id, videoId));

    expect(updated?.targetPostId).toBe('post-123');
    expect(updated?.targetPostUrl).toBe('http://loops.test/posts/post-123');
  });

  it('deletes local file after successful upload', async () => {
    const { videoId } = await setupTestVideo(testDb.db, { localPath: '/data/downloads/vid001.mp4' });

    const env = new MockActivityEnvironment();
    await env.run(uploadVideo, videoId);

    expect(mockUnlink).toHaveBeenCalledWith('/data/downloads/vid001.mp4');
  });

  it('prefers transcodedPath over localPath when both set', async () => {
    const { videoId } = await setupTestVideo(testDb.db, {
      localPath: '/data/downloads/vid001.mp4',
      transcodedPath: '/data/transcodes/vid001.mp4',
    });

    const env = new MockActivityEnvironment();
    await env.run(uploadVideo, videoId);

    // fs.stat and adapter.upload should use transcodedPath
    expect(mockStat).toHaveBeenCalledWith('/data/transcodes/vid001.mp4');
    expect(mockUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/data/transcodes/vid001.mp4',
    );
  });

  // ── Recoverable errors ──────────────────────────────────────────────────────

  it('propagates recoverable adapter error so Temporal can retry', async () => {
    const { videoId } = await setupTestVideo(testDb.db);

    const networkError = new Error('Connection refused');
    mockUpload.mockRejectedValue(networkError);

    const env = new MockActivityEnvironment();
    await expect(env.run(uploadVideo, videoId)).rejects.toThrow('Connection refused');
  });
});
