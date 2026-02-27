/**
 * T015 🔴 TDD-RED: Videos route integration tests.
 *
 * Tests MUST FAIL before route implementation (T022).
 * Run: pnpm --filter backend test tests/integration/videos-route.test.ts
 *
 * Covers:
 *   - GET /api/videos 200 returns { items, total, nextCursor }
 *   - Each item includes required fields: id, creatorId, sourceVideoUrl, stage,
 *     temporalWorkflowId, discoveredAt
 *   - Cursor pagination works (T037/T038 extends this with filtering)
 *
 * Note: Stage/creatorId filter tests are in T037 (Phase 8, US3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, seedSourceAndTarget } from '../helpers/test-app.js';
import * as schema from '../../src/db/schema.js';

describe('GET /api/videos', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let sourceId: number;
  let targetId: number;
  let creatorId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    ({ sourceId, targetId } = await seedSourceAndTarget(ctx.db));

    // Create a test creator
    const [creator] = await ctx.db
      .insert(schema.creators)
      .values({ handle: '@testvid', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    creatorId = creator!.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('200 — returns correct response structure with empty list', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      items: [],
      total: 0,
      nextCursor: null,
    });
  });

  it('200 — returns video items with required fields', async () => {
    // Seed a video directly in DB
    await ctx.db.insert(schema.videos).values({
      creatorId,
      sourceVideoId: 'vid-test-001',
      sourceVideoUrl: 'https://example.com/video/001',
      stage: 'DOWNLOAD_QUEUED',
      temporalWorkflowId: 'video-1',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);

    const item = body.items[0];
    expect(item).toMatchObject({
      id: expect.any(Number),
      creatorId,
      sourceVideoUrl: 'https://example.com/video/001',
      stage: 'DOWNLOAD_QUEUED',
      temporalWorkflowId: 'video-1',
    });
    expect(item.discoveredAt).toBeDefined();
  });

  it('200 — returns multiple videos and correct total', async () => {
    const vids = Array.from({ length: 5 }, (_, i) => ({
      creatorId,
      sourceVideoId: `vid-${i}`,
      sourceVideoUrl: `https://example.com/video/${i}`,
      stage: 'DOWNLOAD_QUEUED' as const,
    }));

    await ctx.db.insert(schema.videos).values(vids);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(5);
  });

  it('200 — respects limit query param', async () => {
    const vids = Array.from({ length: 10 }, (_, i) => ({
      creatorId,
      sourceVideoId: `vid-limit-${i}`,
      sourceVideoUrl: `https://example.com/video/limit-${i}`,
      stage: 'DOWNLOAD_QUEUED' as const,
    }));
    await ctx.db.insert(schema.videos).values(vids);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos?limit=3',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(body.total).toBe(10);
    expect(body.nextCursor).not.toBeNull();
  });

  it('200 — cursor pagination returns next page', async () => {
    const vids = Array.from({ length: 5 }, (_, i) => ({
      creatorId,
      sourceVideoId: `vid-page-${i}`,
      sourceVideoUrl: `https://example.com/video/page-${i}`,
      stage: 'DOWNLOAD_QUEUED' as const,
    }));
    await ctx.db.insert(schema.videos).values(vids);

    // First page
    const page1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos?limit=2',
      headers: { cookie: await loginCookie(ctx.app) },
    });
    const { nextCursor } = page1.json();
    expect(nextCursor).not.toBeNull();

    // Second page
    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/videos?limit=2&cursor=${nextCursor}`,
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(2);
  });

  it('401 — unauthenticated request is rejected', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos',
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * T037 🔴 TDD-RED: GET /api/videos filter scenarios (US3).
 *
 * Tests MUST FAIL before filtering implementation (T038).
 */
describe('GET /api/videos — filter scenarios (T037/US3)', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let sourceId: number;
  let targetId: number;
  let creatorId1: number;
  let creatorId2: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    ({ sourceId, targetId } = await seedSourceAndTarget(ctx.db));

    const [c1] = await ctx.db
      .insert(schema.creators)
      .values({ handle: '@filterc1', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    const [c2] = await ctx.db
      .insert(schema.creators)
      .values({ handle: '@filterc2', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    creatorId1 = c1!.id;
    creatorId2 = c2!.id;

    // Insert videos: 2 for c1 (one queued, one downloading), 2 for c2
    await ctx.db.insert(schema.videos).values([
      { creatorId: creatorId1, sourceVideoId: 'f1', sourceVideoUrl: 'https://t.co/f1', stage: 'DOWNLOAD_QUEUED' },
      { creatorId: creatorId1, sourceVideoId: 'f2', sourceVideoUrl: 'https://t.co/f2', stage: 'DOWNLOADING' },
      { creatorId: creatorId2, sourceVideoId: 'f3', sourceVideoUrl: 'https://t.co/f3', stage: 'DOWNLOAD_QUEUED' },
      { creatorId: creatorId2, sourceVideoId: 'f4', sourceVideoUrl: 'https://t.co/f4', stage: 'UPLOAD_SUCCEEDED' },
    ] as const);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('?stage=DOWNLOAD_QUEUED — returns only queued records', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos?stage=DOWNLOAD_QUEUED',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((v: { stage: string }) => v.stage === 'DOWNLOAD_QUEUED')).toBe(true);
  });

  it('?creatorId=X — returns only that creator\'s videos', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/videos?creatorId=${creatorId1}`,
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((v: { creatorId: number }) => v.creatorId === creatorId1)).toBe(true);
  });

  it('?stage=X&creatorId=Y — combined filter', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/videos?stage=DOWNLOAD_QUEUED&creatorId=${creatorId1}`,
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].creatorId).toBe(creatorId1);
    expect(body.items[0].stage).toBe('DOWNLOAD_QUEUED');
  });

  it('?stage=NONEXISTENT — returns empty items array', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/videos?stage=ARCHIVE_SUCCEEDED',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    expect(res.json().total).toBe(0);
  });
});

// ── Test helper ───────────────────────────────────────────────────────────────

async function loginCookie(app: Awaited<ReturnType<typeof buildTestApp>>['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { password: process.env['ADMIN_PASSWORD'] ?? 'test-admin-password-123' },
  });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No set-cookie header');
  return Array.isArray(setCookie) ? setCookie[0]! : setCookie;
}
