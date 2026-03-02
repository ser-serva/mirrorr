/**
 * T016 🔴 TDD-RED: POST /api/creators mirror-provisioning unit tests.
 *
 * Tests MUST FAIL before T018 (extend creators.routes.ts).
 * Run: pnpm --filter backend test tests/unit/creators-provisioning.test.ts
 *
 * Covers US3 provisioning behaviour wired into POST /api/creators:
 *   1. New creator → provision call → mirror target inserted (isMirror=true) + creator with mirrorTargetId
 *   2. Re-import existing creator already having mirrorTargetId in DB → 409, no adapter call
 *   3. body.mirrorTargetId supplied → skip provisioning, use supplied ID
 *   4. provisionMirrorAccount throws → transaction rolls back (no creator, no target rows)
 *   5. "username already taken" error surfaces as 4xx to caller
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import * as schema from '../../src/db/schema.js';
import { encrypt } from '../../src/lib/crypto.js';

// ── Mock @mirrorr/adapter-loops so we can control provisionMirrorAccount ──────

const mockProvisionMirrorAccount = vi.fn();

vi.mock('@mirrorr/adapter-loops', () => {
  return {
    LoopsAdapter: class {
      async upload() { return { postId: 'mock-post-id' }; }
      async test() { return { ok: true, message: 'Connected as mock' }; }
      async provisionMirrorAccount(config: unknown, handle: string, sourceType: string) {
        return mockProvisionMirrorAccount(config, handle, sourceType);
      }
    },
    generateUsername: (handle: string, sourceType: string) =>
      `${handle.replace(/^@/, '').slice(0, 24 - 1 - sourceType.length)}.${sourceType}`,
    adapter: {},
  };
});

// ── Login helper ──────────────────────────────────────────────────────────────

async function loginCookie(app: Awaited<ReturnType<typeof buildTestApp>>['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { password: process.env['ADMIN_PASSWORD'] ?? 'test-admin-password-123' },
  });
  if (res.statusCode !== 200) throw new Error(`Login failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No set-cookie header');
  return Array.isArray(setCookie) ? setCookie[0]! : setCookie;
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

async function seedLoopsTarget(ctx: Ctx, opts: { isMirror?: boolean; name?: string } = {}) {
  const [target] = await ctx.db
    .insert(schema.targets)
    .values({
      name: opts.name ?? 'Loops Admin',
      type: 'loops',
      url: 'http://loops.test',
      apiTokenEnc: encrypt('admin-token-xyz'),
      publicationConfig: {},
      config: { maxVideoMb: 500, minVideoKb: 250 },
      isMirror: opts.isMirror ?? false,
      enabled: true,
    })
    .returning();
  return target!;
}

async function seedTikTokSource(ctx: Ctx) {
  const [source] = await ctx.db
    .insert(schema.sources)
    .values({ name: 'TikTok', type: 'tiktok', config: {}, enabled: true })
    .returning();
  return source!;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('POST /api/creators — mirror provisioning', () => {
  let ctx: Ctx;
  let cookie: string;

  beforeEach(async () => {
    ctx = await buildTestApp();
    cookie = await loginCookie(ctx.app);
    mockProvisionMirrorAccount.mockReset();
  });

  afterEach(async () => {
    await ctx.close();
  });

  // ── Test 1: new creator with parent target → provision + insert mirror target ──

  it('201 — provisions mirror account, inserts isMirror target + creator with mirrorTargetId', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);

    mockProvisionMirrorAccount.mockResolvedValue({
      mirrorToken: 'fresh-mirror-jwt',
      mirrorUsername: 'creator.tiktok',
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: {
        handle: '@creator',
        sourceId: source.id,
        targetId: adminTarget.id,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    // Creator row should have mirrorTargetId set
    expect(body.mirrorTargetId).toBeDefined();
    expect(body.mirrorTargetId).toBeGreaterThan(0);

    // provisionMirrorAccount was called with the admin config, handle, and sourceType
    expect(mockProvisionMirrorAccount).toHaveBeenCalledOnce();
    const [calledCfg, calledHandle, calledSourceType] = mockProvisionMirrorAccount.mock.calls[0]!;
    expect(calledHandle).toBe('@creator');
    expect(calledSourceType).toBe('tiktok');
    expect((calledCfg as Record<string, unknown>).apiToken).toBe('admin-token-xyz');

    // A mirror target row should exist with isMirror=true
    const mirrorTargets = await ctx.db
      .select()
      .from(schema.targets)
      .all();

    const mirrorTarget = mirrorTargets.find(t => t.isMirror === true);
    expect(mirrorTarget).toBeDefined();
    expect(mirrorTarget!.name).toContain('@creator');
  });

  // ── Test 2: re-import → creator already has mirrorTargetId in DB → 409 ───────

  it('409 — skips provisioning when creator with mirrorTargetId already exists in DB', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const mirrorTarget = await seedLoopsTarget(ctx, { isMirror: true, name: '@creator mirror' });

    // Pre-insert a creator row WITH mirrorTargetId already set
    await ctx.db.insert(schema.creators).values({
      handle: '@creator',
      sourceId: source.id,
      targetId: adminTarget.id,
      mirrorTargetId: mirrorTarget.id,
      enabled: true,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: {
        handle: '@creator',
        sourceId: source.id,
        targetId: adminTarget.id,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toMatch(/mirror/i);

    // Adapter must NOT have been called
    expect(mockProvisionMirrorAccount).not.toHaveBeenCalled();
  });

  // ── Test 3: body.mirrorTargetId supplied → skip provisioning ─────────────────

  it('201 — uses supplied mirrorTargetId from request body, skips provisioning', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const existingMirrorTarget = await seedLoopsTarget(ctx, { isMirror: true, name: 'pre-created mirror' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: {
        handle: '@newcreator',
        sourceId: source.id,
        targetId: adminTarget.id,
        mirrorTargetId: existingMirrorTarget.id,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mirrorTargetId).toBe(existingMirrorTarget.id);

    // No provisioning should have been triggered
    expect(mockProvisionMirrorAccount).not.toHaveBeenCalled();
  });

  // ── Test 4: provisioning failure rolls back — no creator, no target row ───────

  it('500 — rolls back when provisionMirrorAccount throws (no creator or mirror target inserted)', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);

    mockProvisionMirrorAccount.mockRejectedValue(new Error('Provisioning service unavailable'));

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: {
        handle: '@failcreator',
        sourceId: source.id,
        targetId: adminTarget.id,
      },
    });

    // Should return an error status
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // No new creator should exist in DB
    const creators = await ctx.db.select().from(schema.creators).all();
    expect(creators).toHaveLength(0);

    // No new mirror target should exist in DB
    const allTargets = await ctx.db.select().from(schema.targets).all();
    const mirrorTargets = allTargets.filter(t => t.isMirror === true);
    expect(mirrorTargets).toHaveLength(0);
  });

  // ── Test 5: "username already taken" surfaces as 4xx ─────────────────────────

  it('4xx — surfaces "username already taken" error message from provisioning', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);

    mockProvisionMirrorAccount.mockRejectedValue(new Error('username already taken'));

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/creators',
      headers: { cookie },
      payload: {
        handle: '@takenhandle',
        sourceId: source.id,
        targetId: adminTarget.id,
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toMatch(/username already taken/i);
  });
});

// ── PATCH /api/creators/:id ────────────────────────────────────────────────────

describe('PATCH /api/creators/:id', () => {
  let ctx: Ctx;
  let cookie: string;

  beforeEach(async () => {
    ctx = await buildTestApp();
    cookie = await loginCookie(ctx.app);
    mockProvisionMirrorAccount.mockReset();
  });

  afterEach(async () => {
    await ctx.close();
  });

  // Helper: insert a creator directly into the DB
  async function seedCreator(
    ctx: Ctx,
    opts: { handle: string; sourceId: number; targetId: number; mirrorTargetId?: number | null },
  ) {
    const [creator] = await ctx.db
      .insert(schema.creators)
      .values({
        handle: opts.handle,
        sourceId: opts.sourceId,
        targetId: opts.targetId,
        mirrorTargetId: opts.mirrorTargetId ?? null,
        enabled: true,
        initialSyncWindowDays: 3,
      })
      .returning();
    return creator!;
  }

  // ── Scalar-only updates ──────────────────────────────────────────────────────

  it('200 — updates scalar fields without touching mirrorTargetId', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const creator = await seedCreator(ctx, {
      handle: '@patchme',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { enabled: false, maxBacklog: 10, initialSyncWindowDays: 14 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.maxBacklog).toBe(10);
    expect(body.initialSyncWindowDays).toBe(14);
    expect(body.mirrorTargetId).toBeNull();
    expect(mockProvisionMirrorAccount).not.toHaveBeenCalled();
  });

  // ── Direct mirror target assignment ─────────────────────────────────────────

  it('200 — assigns existing mirror target directly via mirrorTargetId', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const mirrorTarget = await seedLoopsTarget(ctx, { isMirror: true, name: '@patchassign mirror' });
    const creator = await seedCreator(ctx, {
      handle: '@patchassign',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { mirrorTargetId: mirrorTarget.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mirrorTargetId).toBe(mirrorTarget.id);
    expect(mockProvisionMirrorAccount).not.toHaveBeenCalled();
  });

  it('422 — mirrorTargetId refers to non-existent target', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const creator = await seedCreator(ctx, {
      handle: '@patchbad',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { mirrorTargetId: 99999 },
    });

    expect(res.statusCode).toBe(422);
  });

  // ── Provisioning via targetId ────────────────────────────────────────────────

  it('200 — provisions mirror account for existing creator with mirrorTargetId=null', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const creator = await seedCreator(ctx, {
      handle: '@provision_me',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    mockProvisionMirrorAccount.mockResolvedValue({
      mirrorToken: 'patch-mirror-jwt',
      mirrorUsername: 'provision_me.tiktok',
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { targetId: adminTarget.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mirrorTargetId).toBeDefined();
    expect(body.mirrorTargetId).toBeGreaterThan(0);
    expect(body.targetId).toBe(adminTarget.id);

    expect(mockProvisionMirrorAccount).toHaveBeenCalledOnce();
    const [, calledHandle, calledSourceType] = mockProvisionMirrorAccount.mock.calls[0]!;
    expect(calledHandle).toBe('@provision_me');
    expect(calledSourceType).toBe('tiktok');

    // Mirror target row should be inserted
    const allTargets = await ctx.db.select().from(schema.targets).all();
    expect(allTargets.some(t => t.isMirror === true)).toBe(true);
  });

  it('409 — refuses to provision when creator already has mirrorTargetId', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const existingMirror = await seedLoopsTarget(ctx, { isMirror: true, name: 'existing mirror' });
    const creator = await seedCreator(ctx, {
      handle: '@already_provisioned',
      sourceId: source.id,
      targetId: adminTarget.id,
      mirrorTargetId: existingMirror.id,
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { targetId: adminTarget.id },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.mirrorTargetId).toBe(existingMirror.id);
    expect(mockProvisionMirrorAccount).not.toHaveBeenCalled();
  });

  it('422 — targetId refers to non-existent target when provisioning', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const creator = await seedCreator(ctx, {
      handle: '@badtarget',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { targetId: 99999 },
    });

    expect(res.statusCode).toBe(422);
  });

  it('4xx — surfaces provisioning error when adapter throws', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const creator = await seedCreator(ctx, {
      handle: '@errorcreator',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    mockProvisionMirrorAccount.mockRejectedValue(new Error('username already taken'));

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { targetId: adminTarget.id },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toMatch(/username already taken/i);
  });

  // ── Validation ───────────────────────────────────────────────────────────────

  it('400 — rejects body with both targetId and mirrorTargetId', async () => {
    const source = await seedTikTokSource(ctx);
    const adminTarget = await seedLoopsTarget(ctx);
    const creator = await seedCreator(ctx, {
      handle: '@bothfields',
      sourceId: source.id,
      targetId: adminTarget.id,
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/creators/${creator.id}`,
      headers: { cookie },
      payload: { targetId: adminTarget.id, mirrorTargetId: adminTarget.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('404 — returns 404 for unknown creator', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/creators/99999',
      headers: { cookie },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });

  it('401 — unauthenticated request is rejected', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/creators/1',
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(401);
  });
});
