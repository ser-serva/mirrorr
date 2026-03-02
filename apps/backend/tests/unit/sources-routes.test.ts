/**
 * T008 🔴 TDD-RED: Sources CRUD route unit tests.
 *
 * Tests MUST FAIL before route implementation (T011, T012).
 * Run: pnpm --filter backend test tests/unit/sources-routes.test.ts
 *
 * Covers:
 *   - GET  /api/sources 200 — lists all sources
 *   - POST /api/sources 201 — creates a source with valid body
 *   - POST /api/sources 400 — rejects unknown fields (strict Zod validation)
 *   - POST /api/sources 400 — rejects missing required fields
 *   - PATCH /api/sources/:id 200 — updates existing source
 *   - PATCH /api/sources/:id 404 — not found
 *   - DELETE /api/sources/:id 204 — deletes existing source
 *   - DELETE /api/sources/:id 404 — not found
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/sources', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;

  beforeEach(async () => {
    ctx = await buildTestApp();
    cookie = await loginCookie(ctx.app);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('200 — returns empty items array when no sources exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/sources',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [] });
  });

  it('200 — returns existing sources', async () => {
    // Create a source first
    await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { name: 'My TikTok', type: 'tiktok', config: {} },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/sources', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ name: 'My TikTok', type: 'tiktok' });
  });
});

describe('POST /api/sources', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;

  beforeEach(async () => {
    ctx = await buildTestApp();
    cookie = await loginCookie(ctx.app);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('201 — creates a source with minimal required fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { name: 'TikTok Source', type: 'tiktok', config: {} },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      id: expect.any(Number),
      name: 'TikTok Source',
      type: 'tiktok',
      enabled: true,
    });
  });

  it('201 — accepts optional config fields (discoveryMaxAgeDays, cookiesFile, etc.)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: {
        name: 'TikTok Source',
        type: 'tiktok',
        config: {
          discoveryPlaylistLimit: 20,
          discoveryMaxAgeDays: 14,
          cookiesFile: '/data/cookies.txt',
          firefoxProfilePath: '/data/firefox',
          maxConcurrentDownloads: 2,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.config).toMatchObject({
      discoveryPlaylistLimit: 20,
      cookiesFile: '/data/cookies.txt',
    });
  });

  it('400 — rejects unknown fields in config (strict validation)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: {
        name: 'TikTok Source',
        type: 'tiktok',
        config: { unknownField: 'should_be_rejected' },
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('400 — rejects missing required name field', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { type: 'tiktok', config: {} },
    });

    expect(res.statusCode).toBe(400);
  });

  it('400 — rejects invalid type value', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { name: 'Source', type: 'invalid_type', config: {} },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/sources/:id', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  let sourceId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    cookie = await loginCookie(ctx.app);

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { name: 'Original Name', type: 'tiktok', config: {} },
    });
    sourceId = createRes.json().id as number;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('200 — updates name', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/sources/${sourceId}`,
      headers: { cookie },
      payload: { name: 'Updated Name' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated Name');
  });

  it('200 — updates enabled flag', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/sources/${sourceId}`,
      headers: { cookie },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it('200 — updates config fields', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/sources/${sourceId}`,
      headers: { cookie },
      payload: { config: { discoveryMaxAgeDays: 7 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().config).toMatchObject({ discoveryMaxAgeDays: 7 });
  });

  it('400 — rejects unknown fields in config during PATCH', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/sources/${sourceId}`,
      headers: { cookie },
      payload: { config: { unknownField: 'bad' } },
    });

    expect(res.statusCode).toBe(400);
  });

  it('404 — source not found', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/sources/99999',
      headers: { cookie },
      payload: { name: 'Ghost' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/sources/:id', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  let sourceId: number;

  beforeEach(async () => {
    ctx = await buildTestApp();
    cookie = await loginCookie(ctx.app);

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { name: 'To Delete', type: 'tiktok', config: {} },
    });
    sourceId = createRes.json().id as number;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('204 — deletes an existing source', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/sources/${sourceId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(204);

    // Verify it's gone
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/sources',
      headers: { cookie },
    });
    expect(getRes.json().items).toHaveLength(0);
  });

  it('404 — source not found', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/sources/99999',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});
