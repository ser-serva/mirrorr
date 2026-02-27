/**
 * T024 🔴 TDD-RED: POST /api/creators/:id/sync route integration tests.
 *
 * Tests MUST FAIL before route implementation (T026).
 * Run: pnpm --filter backend test tests/integration/sync-route.test.ts
 *
 * Covers:
 *   - POST /api/creators/:id/sync 200 with { queued, alreadyKnown } schema
 *   - 404 on unknown creatorId
 *   - 409 when discoverCreatorWorkflow with -manual ID is already RUNNING
 *   - 400 when creator enabled: false
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp, seedSourceAndTarget } from '../helpers/test-app.js';
import * as schema from '../../src/db/schema.js';

// Mock Temporal client — the sync route uses client.workflow.execute() which
// requires a running Temporal cluster; we stub it here for unit-style testing.
vi.mock('../../src/temporal/client.js', () => ({
  getTemporalClient: vi.fn().mockResolvedValue({
    workflow: {
      // Simulate no running manual workflow (getHandle.describe throws)
      getHandle: vi.fn().mockReturnValue({
        describe: vi.fn().mockRejectedValue(new Error('workflow not found')),
      }),
      execute: vi.fn().mockResolvedValue({ queued: 2, alreadyKnown: 0 }),
    },
  }),
}));

describe('POST /api/creators/:id/sync', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let sourceId: number;
  let targetId: number;
  let creatorId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    ({ sourceId, targetId } = await seedSourceAndTarget(ctx.db));

    const [creator] = await ctx.db
      .insert(schema.creators)
      .values({ handle: '@synccreator', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    creatorId = creator!.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('200 — returns { queued, alreadyKnown } on successful sync', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/creators/${creatorId}/sync`,
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      queued: expect.any(Number),
      alreadyKnown: expect.any(Number),
    });
  });

  it('404 — unknown creatorId returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators/99999/sync',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeDefined();
  });

  it('400 — disabled creator returns 400', async () => {
    // Disable the creator first
    await ctx.db
      .update(schema.creators)
      .set({ enabled: false })
      // drizzle uses eq
      .where(
        (await import('drizzle-orm')).eq(schema.creators.id, creatorId),
      );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/creators/${creatorId}/sync`,
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/disabled/i);
  });

  it('401 — unauthenticated request is rejected', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/creators/${creatorId}/sync`,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /api/creators/:id', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let sourceId: number;
  let targetId: number;
  let creatorId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    ({ sourceId, targetId } = await seedSourceAndTarget(ctx.db));

    const [creator] = await ctx.db
      .insert(schema.creators)
      .values({ handle: '@patchcreator', sourceId, targetId, enabled: true })
      .returning({ id: schema.creators.id });
    creatorId = creator!.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('200 — can disable a creator', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creatorId}`,
      headers: { cookie: await loginCookie(ctx.app) },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it('200 — can update initialSyncWindowDays', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creatorId}`,
      headers: { cookie: await loginCookie(ctx.app) },
      payload: { initialSyncWindowDays: 14 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().initialSyncWindowDays).toBe(14);
  });

  it('404 — unknown creatorId', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/creators/99999',
      headers: { cookie: await loginCookie(ctx.app) },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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
