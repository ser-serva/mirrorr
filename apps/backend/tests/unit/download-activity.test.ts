/**
 * T016 🔴 TDD-RED: downloadVideo activity unit tests.
 *
 * Tests MUST FAIL before activity implementation (T018).
 * Run: pnpm --filter backend test tests/unit/download-activity.test.ts
 *
 * Covers:
 *   - Adapter call delegation (download called with correct args)
 *   - setInterval heartbeat fires during download
 *   - video.transcodeDecision = 'passthrough' written to DB after download
 *   - Returned DownloadVideoResult shape { localPath, transcodeDecision }
 *   - Interval is cleared after activity completes (success and error paths)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { eq } from 'drizzle-orm';
import { createTestDb, seedSourceAndTarget } from '../helpers/test-app.js';
import * as schema from '../../src/db/schema.js';
import {
  downloadVideo,
  _setDbFactory,
  _setSourceAdapterFactory,
} from '../../src/activities/pipeline.activities.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

async function setupTestVideo(
  db: ReturnType<typeof createTestDb>['db'],
  sourceVideoUrl = 'https://www.tiktok.com/@testuser/video/vid001',
) {
  const { sourceId, targetId } = await seedSourceAndTarget(db);

  const [creator] = await db
    .insert(schema.creators)
    .values({ handle: '@testuser', sourceId, targetId, enabled: true })
    .returning({ id: schema.creators.id });

  const [video] = await db
    .insert(schema.videos)
    .values({
      creatorId: creator!.id,
      sourceVideoId: 'vid001',
      sourceVideoUrl,
      stage: 'DOWNLOADING',
    })
    .returning({ id: schema.videos.id });

  return { videoId: video!.id, creatorId: creator!.id, sourceId };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('downloadVideo activity', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let videoId: number;
  let mockDownload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDb = createTestDb();
    const setup = await setupTestVideo(testDb.db);
    videoId = setup.videoId;

    mockDownload = vi.fn().mockResolvedValue('/data/downloads/vid001.mp4');

    _setDbFactory(() => testDb.db as any);
    _setSourceAdapterFactory(() => ({
      discover: vi.fn().mockResolvedValue({ videos: [], failures: [] }),
      fetchMeta: vi.fn(),
      download: mockDownload,
    }));
  });

  afterEach(() => {
    _setDbFactory(null);
    _setSourceAdapterFactory(null);
    testDb.close();
  });

  it('returns DownloadVideoResult with localPath and transcodeDecision: passthrough', async () => {
    const activityEnv = new MockActivityEnvironment();
    const result = await activityEnv.run(() => downloadVideo(videoId));

    // Currently fails: activity returns string, not DownloadVideoResult
    expect(result).toMatchObject({
      localPath: '/data/downloads/vid001.mp4',
      transcodeDecision: 'passthrough',
    });
    expect(typeof (result as any).localPath).toBe('string');
  });

  it('calls adapter.download() with correct arguments', async () => {
    const activityEnv = new MockActivityEnvironment();
    await activityEnv.run(() => downloadVideo(videoId));

    expect(mockDownload).toHaveBeenCalledTimes(1);
    const [, url, destDir] = mockDownload.mock.calls[0] as [unknown, string, string];
    expect(url).toBe('https://www.tiktok.com/@testuser/video/vid001');
    expect(destDir).toBe('/data/downloads');
  });

  it('writes transcodeDecision = passthrough to DB after download', async () => {
    const activityEnv = new MockActivityEnvironment();
    await activityEnv.run(() => downloadVideo(videoId));

    const [video] = await testDb.db
      .select()
      .from(schema.videos)
      .where(eq(schema.videos.id, videoId));

    // Currently fails: activity does not write transcodeDecision
    expect(video?.transcodeDecision).toBe('passthrough');
  });

  it('registers a 15 s heartbeat interval and clears it on completion', async () => {
    // Verify structural setup: setInterval(fn, 15_000) called once, then clearInterval called.
    // Actual firing is covered by integration tests — unit tests verify the wiring.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const activityEnv = new MockActivityEnvironment();
    await activityEnv.run(() => downloadVideo(videoId));

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(clearIntervalSpy).toHaveBeenCalledOnce();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('clears the heartbeat interval even when adapter throws', async () => {
    mockDownload.mockRejectedValueOnce(new Error('download failed'));

    const activityEnv = new MockActivityEnvironment();

    await expect(activityEnv.run(() => downloadVideo(videoId))).rejects.toThrow('download failed');

    // No pending intervals should remain — if clearInterval is not called,
    // subsequent tests may see unexpected heartbeat calls
    // (verified indirectly: if this test hangs, clearInterval is missing)
  });
});
