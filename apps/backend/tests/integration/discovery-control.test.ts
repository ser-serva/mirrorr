/**
 * T031 🔴 TDD-RED: Discovery control route integration tests.
 *
 * Tests MUST FAIL before route implementation (T032, T033, T034).
 * Run: pnpm --filter backend test tests/integration/discovery-control.test.ts
 *
 * Covers:
 *   - POST /api/discovery/pause 200 { paused: true }
 *   - GET  /api/discovery/status 200 with { paused, nextRunAt, status } schema
 *   - POST /api/discovery/resume 200 { paused: false }
 *   - pause idempotency (second pause → 200)
 *   - resume idempotency (second resume → 200)
 *   - status returns status: 'not_registered' when schedule not yet registered
 */
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';

// Mock the Temporal client since we don't have Temporal running in unit tests
vi.mock('../../src/temporal/client.js', () => {
  const mockHandle = {
    pause: vi.fn().mockResolvedValue(undefined),
    unpause: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockResolvedValue({
      // SDK v1.15: describe() returns { state, info, ... } at the top level
      // (not nested under `schedule`)
      state: { paused: false },
      info: { nextActionTimes: [new Date('2026-02-28T00:00:00Z')] },
    }),
  };

  return {
    getTemporalClient: vi.fn().mockResolvedValue({
      schedule: {
        getHandle: vi.fn().mockReturnValue(mockHandle),
      },
    }),
    mockScheduleHandle: mockHandle,
  };
});

describe('POST /api/discovery/pause', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  afterEach(async () => {
    await ctx.close();
    vi.clearAllMocks();
  });

  it('200 — returns { paused: true }', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/pause',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paused: true });
  });

  it('200 — idempotent (second pause returns 200)', async () => {
    const cookie = await loginCookie(ctx.app);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/pause',
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/pause',
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
  });

  it('401 — unauthenticated request rejected', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/pause',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/discovery/resume', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  afterEach(async () => {
    await ctx.close();
    vi.clearAllMocks();
  });

  it('200 — returns { paused: false }', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/resume',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paused: false });
  });

  it('200 — idempotent (second resume returns 200)', async () => {
    const cookie = await loginCookie(ctx.app);

    await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/resume',
      headers: { cookie },
    });

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/discovery/resume',
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
  });
});

describe('GET /api/discovery/status', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  afterEach(async () => {
    await ctx.close();
    vi.clearAllMocks();
  });

  it('200 — returns { paused, nextRunAt, status } schema', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/discovery/status',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      paused: expect.any(Boolean),
      status: expect.stringMatching(/^(registered|not_registered)$/),
    });
    expect('nextRunAt' in body).toBe(true);
  });

  it('200 — status: not_registered when schedule is missing', async () => {
    const { getTemporalClient } = await import('../../src/temporal/client.js');
    vi.mocked(getTemporalClient).mockResolvedValueOnce({
      schedule: {
        getHandle: vi.fn().mockReturnValue({
          describe: vi.fn().mockRejectedValue(
            Object.assign(new Error('Schedule not found'), { code: 5 }),
          ),
          pause: vi.fn(),
          unpause: vi.fn(),
        }),
      },
    } as any);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/discovery/status',
      headers: { cookie: await loginCookie(ctx.app) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('not_registered');
  });

  it('401 — unauthenticated request rejected', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/discovery/status',
    });
    expect(res.statusCode).toBe(401);
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
