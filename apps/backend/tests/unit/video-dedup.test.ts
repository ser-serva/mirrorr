/**
 * T013 🔴 TDD-RED: Per-creator video deduplication unit tests.
 *
 * Tests MUST FAIL before activity implementation (T019).
 * Run: pnpm --filter backend test tests/unit/video-dedup.test.ts
 *
 * Covers:
 *   - Same source_video_id + same creator_id → conflict (ON CONFLICT IGNORE)
 *   - Same source_video_id + different creator_id → allowed (composite unique)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedSourceAndTarget } from '../helpers/test-app.js';
import * as schema from '../../src/db/schema.js';

describe('Video per-creator deduplication', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let creatorId1: number;
  let creatorId2: number;

  beforeEach(async () => {
    testDb = createTestDb();
    const { sourceId, targetId } = await seedSourceAndTarget(testDb.db);

    // Create two different creators
    const [c1] = await testDb.db
      .insert(schema.creators)
      .values({ handle: '@creator1', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    const [c2] = await testDb.db
      .insert(schema.creators)
      .values({ handle: '@creator2', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });

    creatorId1 = c1!.id;
    creatorId2 = c2!.id;
  });

  it('insert same source_video_id for same creator_id is a no-op (ON CONFLICT IGNORE)', async () => {
    const videoData = {
      creatorId: creatorId1,
      sourceVideoId: 'vid-001',
      sourceVideoUrl: 'https://example.com/@creator1/video/vid-001',
      stage: 'DOWNLOAD_QUEUED' as const,
    };

    // First insert succeeds
    await testDb.db.insert(schema.videos).values(videoData);

    // Second insert of same creator+video should be ignored (not throw)
    await testDb.db.insert(schema.videos).values(videoData).onConflictDoNothing();

    // Verify only one row exists
    const rows = await testDb.db
      .select()
      .from(schema.videos)
      .where(eq(schema.videos.creatorId, creatorId1));

    expect(rows).toHaveLength(1);
  });

  it('alreadyKnown count increments correctly on duplicate insert attempt', async () => {
    // Simulate the activity behaviour: count how many new rows were inserted
    const videoData = {
      creatorId: creatorId1,
      sourceVideoId: 'vid-002',
      sourceVideoUrl: 'https://example.com/@creator1/video/vid-002',
      stage: 'DOWNLOAD_QUEUED' as const,
    };

    // First insert: should be queued
    const first = await testDb.db.insert(schema.videos).values(videoData).returning();
    expect(first).toHaveLength(1); // queued

    // Second insert of same (on conflict do nothing = returns empty array if conflict)
    const second = await testDb.db
      .insert(schema.videos)
      .values(videoData)
      .onConflictDoNothing()
      .returning();
    expect(second).toHaveLength(0); // alreadyKnown

    // alreadyKnown = 1, queued = 0
  });

  it('same source_video_id for DIFFERENT creator_id succeeds', async () => {
    const sharedVideoId = 'vid-shared';

    // Insert for creator 1
    await testDb.db.insert(schema.videos).values({
      creatorId: creatorId1,
      sourceVideoId: sharedVideoId,
      sourceVideoUrl: 'https://example.com/@creator1/video/shared',
      stage: 'DOWNLOAD_QUEUED' as const,
    });

    // Insert for creator 2 with the SAME source_video_id — must succeed
    await testDb.db.insert(schema.videos).values({
      creatorId: creatorId2,
      sourceVideoId: sharedVideoId,
      sourceVideoUrl: 'https://example.com/@creator2/video/shared',
      stage: 'DOWNLOAD_QUEUED' as const,
    });

    // Both rows exist
    const allRows = await testDb.db
      .select()
      .from(schema.videos)
      .where(eq(schema.videos.sourceVideoId, sharedVideoId));

    expect(allRows).toHaveLength(2);
    expect(allRows.map((r) => r.creatorId)).toEqual(
      expect.arrayContaining([creatorId1, creatorId2]),
    );
  });

  it('a truly new video for creator1 inserts successfully after a duplicate attempt', async () => {
    const existing = {
      creatorId: creatorId1,
      sourceVideoId: 'vid-existing',
      sourceVideoUrl: 'https://example.com/@creator1/video/existing',
      stage: 'DOWNLOAD_QUEUED' as const,
    };
    const newVideo = {
      creatorId: creatorId1,
      sourceVideoId: 'vid-new',
      sourceVideoUrl: 'https://example.com/@creator1/video/new',
      stage: 'DOWNLOAD_QUEUED' as const,
    };

    // Insert existing
    await testDb.db.insert(schema.videos).values(existing);

    // Simulate activity: insert batch [existing, newVideo]
    const discovered = [existing, newVideo];
    let queued = 0;
    let alreadyKnown = 0;

    for (const v of discovered) {
      const inserted = await testDb.db
        .insert(schema.videos)
        .values(v)
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        queued++;
      } else {
        alreadyKnown++;
      }
    }

    expect(queued).toBe(1);
    expect(alreadyKnown).toBe(1);
  });
});
