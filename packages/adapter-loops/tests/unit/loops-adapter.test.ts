/**
 * T008 🔴 TDD-RED: LoopsAdapter unit tests — US1 (upload)
 *
 * Tests MUST FAIL before T010 (LoopsAdapter.upload() implementation).
 * Run: pnpm --filter @mirrorr/adapter-loops test
 *
 * US1: LoopsAdapter.upload()
 *   - Happy path: three response shapes ({ id }, { data: { id } }, { data: [{ id }] })
 *   - Recoverable Error thrown on 2xx with no recognisable post ID
 *   - Recoverable Error on non-2xx HTTP status
 *   - Description truncated to 2200 chars with newlines replaced by spaces
 *   - {{creator}}/{{title}}/{{date}} template token rendering
 *   - Absent template falls back to raw options.description
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoopsAdapter, type LoopsAdapterConfig } from '../../src/index.js';
import { readFile, stat } from 'node:fs/promises';

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseConfig: LoopsAdapterConfig = {
  url: 'http://loops.test',
  apiToken: 'test-token',
  maxVideoMb: 500,
  minVideoKb: 250,
};

const baseOptions = {
  title: 'Test Video',
  description: 'A test description',
  hashtags: ['#test'],
};

// Mock fs/promises so tests don't touch real files
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const mockReadFile = vi.mocked(readFile);
const mockStat = vi.mocked(stat);

function setupMockFile(sizeKb = 1024) {
  const fakeBuffer = Buffer.alloc(sizeKb * 1024);
  mockReadFile.mockResolvedValue(fakeBuffer as unknown as string);
  mockStat.mockResolvedValue({ size: sizeKb * 1024 } as any);
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    }),
  );
}

describe('LoopsAdapter.upload()', () => {
  const adapter = new LoopsAdapter();

  beforeEach(() => {
    setupMockFile();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns UploadResult with postId from { id } response shape', async () => {
    mockFetch(200, { id: 'post-abc' });
    const result = await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');
    expect(result.postId).toBe('post-abc');
  });

  it('returns UploadResult with postId from { data: { id } } response shape', async () => {
    mockFetch(200, { data: { id: 'post-def' } });
    const result = await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');
    expect(result.postId).toBe('post-def');
  });

  it('returns UploadResult with postId from { data: [{ id }] } response shape', async () => {
    mockFetch(200, { data: [{ id: 'post-ghi' }] });
    const result = await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');
    expect(result.postId).toBe('post-ghi');
  });

  it('throws recoverable Error on 2xx response with no recognisable post ID', async () => {
    mockFetch(200, { status: 'ok' }); // no id field at any nesting
    await expect(
      adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4'),
    ).rejects.toThrow(/post id/i);
  });

  it('throws recoverable Error on non-2xx HTTP status', async () => {
    mockFetch(422, { error: 'Unprocessable Entity' });
    await expect(
      adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4'),
    ).rejects.toThrow(/422/);
  });

  it('truncates description to 2200 chars and replaces newlines with spaces', async () => {
    mockFetch(200, { id: 'post-trunc' });
    const longDesc = 'A\n'.repeat(1200); // 2400 chars with newlines
    const options = { ...baseOptions, description: longDesc };
    await adapter.upload(baseConfig, options, '/data/downloads/test.mp4');

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const formData = init?.body as FormData;
    const sentDesc = formData.get('description') as string;
    expect(sentDesc.length).toBeLessThanOrEqual(2200);
    expect(sentDesc).not.toContain('\n');
  });

  it('renders {{creator}}/{{title}}/{{date}} tokens in descriptionTemplate', async () => {
    mockFetch(200, { id: 'post-tmpl' });
    const configWithTemplate: LoopsAdapterConfig = {
      ...baseConfig,
      descriptionTemplate: 'By {{creator}} — {{title}} on {{date}}',
    };
    const options = { ...baseOptions, title: 'My Video' };
    const today = new Date().toISOString().slice(0, 10);

    await adapter.upload(configWithTemplate, options, '/data/downloads/test.mp4');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0]!;
    const formData = init?.body as FormData;
    const sentDesc = formData.get('description') as string;
    expect(sentDesc).toContain('By');
    expect(sentDesc).toContain('My Video');
    expect(sentDesc).toContain(today);
  });

  it('falls back to raw options.description when no descriptionTemplate configured', async () => {
    mockFetch(200, { id: 'post-fallback' });
    const options = { ...baseOptions, description: 'Raw description text' };

    await adapter.upload(baseConfig, options, '/data/downloads/test.mp4');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0]!;
    const formData = init?.body as FormData;
    const sentDesc = formData.get('description') as string;
    expect(sentDesc).toBe('Raw description text');
  });

  it('posts to correct upload endpoint with Authorization header', async () => {
    mockFetch(200, { id: 'post-url' });
    await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://loops.test/api/v1/studio/upload');
    expect((init?.headers as Record<string, string>)?.['Authorization']).toBe('Bearer test-token');
  });

  it('extracts postUrl from data[0].url when present in response', async () => {
    mockFetch(200, { data: [{ id: 'post-xyz', url: 'https://loops.test/v/xyz' }] });
    const result = await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');
    expect(result.postId).toBe('post-xyz');
    expect(result.postUrl).toBe('https://loops.test/v/xyz');
  });

  it('extracts postUrl from top-level url field', async () => {
    mockFetch(200, { id: 'post-top', url: 'https://loops.test/v/top' });
    const result = await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');
    expect(result.postId).toBe('post-top');
    expect(result.postUrl).toBe('https://loops.test/v/top');
  });

  it('extracts postUrl from data.url when data is an object', async () => {
    mockFetch(200, { data: { id: 'post-objurl', url: 'https://loops.test/v/obj' } });
    const result = await adapter.upload(baseConfig, baseOptions, '/data/downloads/test.mp4');
    expect(result.postId).toBe('post-objurl');
    expect(result.postUrl).toBe('https://loops.test/v/obj');
  });

  it('uses empty string description when options.description is undefined', async () => {
    mockFetch(200, { id: 'post-nodesc' });
    const options = { title: 'Test', hashtags: [] }; // no description field
    const result = await adapter.upload(
      baseConfig, options as unknown as typeof baseOptions, '/data/downloads/test.mp4'
    );
    expect(result.postId).toBe('post-nodesc');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0]!;
    const formData = init?.body as FormData;
    expect(formData.get('description')).toBe('');
  });
});

// ── T012: LoopsAdapter.test() ─────────────────────────────────────────────────

describe('LoopsAdapter.test()', () => {
  const adapter = new LoopsAdapter();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns { ok: true, message: "Connected as admin" } for 200 response with username', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { username: 'admin' } }),
      text: () => Promise.resolve(''),
    }));

    const result = await adapter.test(baseConfig);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected as admin');
  });

  it('returns { ok: false, message: "..." } for 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Unauthorized'),
    }));

    const result = await adapter.test(baseConfig);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
  });

  it('returns { ok: false, message: "<err.message>" } for network timeout/abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const result = await adapter.test(baseConfig);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('fetch failed');
  });

  it('uses data.display_name when data.username is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { display_name: 'Display Admin' } }),
      text: () => Promise.resolve(''),
    }));

    const result = await adapter.test(baseConfig);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected as Display Admin');
  });

  it('falls back to "unknown" when neither username nor display_name present in data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),
      text: () => Promise.resolve(''),
    }));

    const result = await adapter.test(baseConfig);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected as unknown');
  });
});

// ── T015: LoopsAdapter.provisionMirrorAccount() ───────────────────────────────

import { generateUsername } from '../../src/index.js';

describe('LoopsAdapter.provisionMirrorAccount()', () => {
  const adapter = new LoopsAdapter();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns { mirrorToken, mirrorUsername } from primary data.user.api_token shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        data: { user: { api_token: 'mirror-jwt-abc', username: 'creator.tiktok' } },
      }),
      text: () => Promise.resolve(''),
    }));

    const result = await adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok');
    expect(result.mirrorToken).toBe('mirror-jwt-abc');
    expect(result.mirrorUsername).toBe('creator.tiktok');
  });

  it('falls back to data.token when data.user is absent (legacy shape)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { token: 'legacy-token-xyz' } }),
      text: () => Promise.resolve(''),
    }));

    const result = await adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok');
    expect(result.mirrorToken).toBe('legacy-token-xyz');
  });

  it('throws "Loops instance does not support mirror provisioning" on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Not Found' }),
      text: () => Promise.resolve('Not Found'),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('Loops instance does not support mirror provisioning');
  });

  it('throws "Admin token lacks provisioning privileges" on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Unauthorized'),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('Admin token lacks provisioning privileges');
  });

  it('throws "Admin token lacks provisioning privileges" on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Forbidden'),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('Admin token lacks provisioning privileges');
  });

  it('throws first errors dict message on 422 (username already taken)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({
        errors: { username: ['username already taken'] },
      }),
      text: () => Promise.resolve(''),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('username already taken');
  });

  it('throws on 2xx response with no extractable token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),  // no user.api_token or token
      text: () => Promise.resolve(''),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow(/token/i);
  });

  it('throws "Provisioning validation error (422)" on 422 with no errors dict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ message: 'Failed validation' }),
      text: () => Promise.resolve(''),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('Provisioning validation error (422)');
  });

  it('throws first errors string (not array) on 422 with singular error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ errors: { username: 'username already taken' } }),
      text: () => Promise.resolve(''),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('username already taken');
  });

  it('throws default "username already taken" when 422 errors dict has null value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ errors: { username: null } }),
      text: () => Promise.resolve(''),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('username already taken');
  });

  it('throws "Provisioning failed with status 500" on unexpected 5xx error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal Server Error' }),
      text: () => Promise.resolve(''),
    }));

    await expect(
      adapter.provisionMirrorAccount!(baseConfig, '@creator', 'tiktok'),
    ).rejects.toThrow('Provisioning failed with status 500');
  });
});

// ── T015b: generateUsername() ──────────────────────────────────────────────────

describe('generateUsername()', () => {
  it('strips leading @ and appends .<sourceType>', () => {
    expect(generateUsername('@creator', 'tiktok')).toBe('creator.tiktok');
  });

  it('replaces invalid chars (spaces, hyphens) with nothing', () => {
    expect(generateUsername('@some-creator', 'tiktok')).toBe('somecreator.tiktok');
  });

  it('truncates so total length is ≤ 24 chars', () => {
    const handle = '@' + 'a'.repeat(30);
    const result = generateUsername(handle, 'tiktok');
    expect(result.length).toBeLessThanOrEqual(24);
    expect(result.endsWith('.tiktok')).toBe(true);
  });

  it('preserves dots and underscores as valid characters', () => {
    expect(generateUsername('@some.creator_x', 'tiktok')).toBe('some.creator_x.tiktok');
  });
});
