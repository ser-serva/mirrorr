/**
 * T012 🔴 TDD-RED: Creators route integration tests.
 *
 * Tests MUST FAIL before route implementation (T016, T017).
 * Run: pnpm --filter backend test tests/integration/creators-route.test.ts
 *
 * Covers:
 *   - POST /api/creators 201 happy path — returns Creator schema
 *   - POST /api/creators 409 on duplicate handle+sourceId — returns existing record
 *   - GET  /api/creators 200 — lists all creators
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, seedSourceAndTarget } from '../helpers/test-app.js';

describe('POST /api/creators', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let sourceId: number;
  let targetId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    ({ sourceId, targetId } = await seedSourceAndTarget(ctx.db));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('201 — creates a creator with required fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie: await loginCookie(ctx.app) },
      payload: {
        handle: '@testcreator',
        sourceId,
        targetId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      id: expect.any(Number),
      handle: '@testcreator',
      sourceId,
      targetId,
      enabled: true,
    });
  });

  it('201 — accepts optional fields (pollIntervalMs, maxBacklog, initialSyncWindowDays)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie: await loginCookie(ctx.app) },
      payload: {
        handle: '@optcreator',
        sourceId,
        targetId,
        pollIntervalMs: 60_000,
        maxBacklog: 20,
        initialSyncWindowDays: 7,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.pollIntervalMs).toBe(60_000);
    expect(body.maxBacklog).toBe(20);
    expect(body.initialSyncWindowDays).toBe(7);
  });

  it('409 — duplicate handle+sourceId returns existing record', async () => {
    const cookie = await loginCookie(ctx.app);

    // First creation succeeds
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: { handle: '@dup', sourceId, targetId },
    });
    expect(first.statusCode).toBe(201);
    const createdId = first.json().id;

    // Second creation returns 409 with existing record
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: { handle: '@dup', sourceId, targetId },
    });

    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBeDefined();
    expect(body.creator).toMatchObject({ id: createdId, handle: '@dup' });
  });

  it('400 — missing required field (handle)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie: await loginCookie(ctx.app) },
      payload: { sourceId, targetId },
    });

    expect(res.statusCode).toBe(400);
  });

  it('401 — unauthenticated request is rejected', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      payload: { handle: '@x', sourceId, targetId },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/creators', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let sourceId: number;
  let targetId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    ({ sourceId, targetId } = await seedSourceAndTarget(ctx.db));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('200 — returns empty list when no creators', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/creators',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
  });

  it('200 — lists all created creators', async () => {
    const cookie = await loginCookie(ctx.app);

    await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: { handle: '@one', sourceId, targetId },
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: { handle: '@two', sourceId, targetId },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/creators',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((c: { handle: string }) => c.handle)).toEqual(
      expect.arrayContaining(['@one', '@two']),
    );
  });

  it('200 — each creator item has required fields', async () => {
    const cookie = await loginCookie(ctx.app);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: { handle: '@fieldcheck', sourceId, targetId },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/creators',
      headers: { cookie },
    });

    const item = res.json().items[0];
    expect(item).toMatchObject({
      id: expect.any(Number),
      handle: '@fieldcheck',
      sourceId,
      targetId,
      enabled: true,
    });
  });
});

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Log in and return the session cookie string for subsequent requests.
 */
async function loginCookie(app: Awaited<ReturnType<typeof buildTestApp>>['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { password: process.env['ADMIN_PASSWORD'] ?? 'test-admin-password-123' },
  });

  if (res.statusCode !== 200) {
    throw new Error(`Login failed: ${res.statusCode} ${res.body}`);
  }

  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No set-cookie header in login response');
  return Array.isArray(setCookie) ? setCookie[0]! : setCookie;
}
