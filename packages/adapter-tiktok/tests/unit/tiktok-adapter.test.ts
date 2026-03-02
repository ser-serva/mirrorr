/**
 * T007 & T009 🔴 TDD-RED: TiktokAdapter unit tests.
 *
 * Tests MUST FAIL before implementation (T010, T013).
 * Run: pnpm --filter @mirrorr/adapter-tiktok test
 *
 * T007 covers TiktokAdapter.discover():
 *   (a) Successful two-phase discovery (flat-playlist + per-ID getVideoMeta)
 *   (b) discoveryMaxAgeDays age filtering
 *   (c) maxBacklog limit applied to playlist entries
 *   (d) All four cookie arg resolution scenarios (FR-003 priority chain)
 *   (e) Partial-failure accumulation — one getVideoMeta rejection does not throw
 *   (f) Adapter returns all VideoMetadata (DB dedup via onConflictDoNothing handled
 *       by the calling activity — not the adapter itself)
 *   (g) Full-failure path — getPlaylistInfo() throws → discover() propagates the error
 *
 * T009 covers TiktokAdapter.test():
 *   - Successful test: VPN check + yt-dlp probe → full TikTokTestResult
 *   - ytdlpProbeOk = false when YtDlp.getPlaylistInfo() exits non-zero (no throw)
 *   - testedAt ISO timestamp always present in result
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaylistEntry, VideoMeta } from '@mirrorr/ytdlp';
import { TiktokAdapter, resolveCookieArgs } from '../../src/index.js';

// TikTokSourceConfig shape mirrors apps/backend/src/db/schema.ts
// (defined locally to avoid a cross-package import from adapter → backend)
type TikTokSourceConfig = {
  discoveryPlaylistLimit?: number;
  discoveryMaxAgeDays?: number;
  maxConcurrentDownloads?: number;
  cookiesFile?: string;
  firefoxProfilePath?: string;
};

// ── Mock @mirrorr/ytdlp ───────────────────────────────────────────────────────

// We use constructor injection: TiktokAdapter accepts optional YtDlp instance.
// This avoids hoisting issues with vi.mock on class instances.

function makeMockYtDlp() {
  return {
    version: vi.fn<[], Promise<string>>(),
    getPlaylistInfo: vi.fn<[string, ({ limit?: number; cookieArgs?: string[] } | undefined)?], Promise<PlaylistEntry[]>>(),
    getVideoMeta: vi.fn<[string, ({ cookieArgs?: string[] } | undefined)?], Promise<VideoMeta>>(),
    downloadVideo: vi.fn<[string, string, ({ cookieArgs?: string[]; extraArgs?: string[] } | undefined)?], Promise<string>>(),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const playlistEntries: PlaylistEntry[] = [
  { id: 'vid001', url: 'https://www.tiktok.com/@testuser/video/vid001' },
  { id: 'vid002', url: 'https://www.tiktok.com/@testuser/video/vid002' },
];

function makeVideoMeta(id: string, daysAgo: number): VideoMeta {
  const timestamp = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  return {
    id,
    title: `Video ${id}`,
    description: `Description for ${id}`,
    tags: ['fyp'],
    timestamp,
    duration: 30,
    view_count: 1000,
    thumbnail: `https://example.com/${id}.jpg`,
    webpage_url: `https://www.tiktok.com/@testuser/video/${id}`,
  };
}

// ── T007: TiktokAdapter.discover() ───────────────────────────────────────────

describe('TiktokAdapter.discover()', () => {
  let ytDlp: ReturnType<typeof makeMockYtDlp>;
  let adapter: TiktokAdapter;
  const baseConfig: TikTokSourceConfig = {};
  const ctx = { handle: 'testuser', maxBacklog: undefined, maxAgeDays: undefined };

  beforeEach(() => {
    ytDlp = makeMockYtDlp();
    adapter = new TiktokAdapter(ytDlp as any);
    // Clear env vars that affect cookie resolution
    delete process.env['FIREFOX_PROFILE_PATH'];
    delete process.env['TIKTOK_COOKIES_FILE'];
  });

  it('(a) successful two-phase discovery returns VideoMetadata[] for all playlist IDs', async () => {
    ytDlp.getPlaylistInfo.mockResolvedValueOnce(playlistEntries);
    ytDlp.getVideoMeta
      .mockResolvedValueOnce(makeVideoMeta('vid001', 1))
      .mockResolvedValueOnce(makeVideoMeta('vid002', 2));

    const result = await adapter.discover(baseConfig, ctx);

    expect(result.videos).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.videos[0]).toMatchObject({
      sourceVideoId: 'vid001',
      sourceVideoUrl: 'https://www.tiktok.com/@testuser/video/vid001',
      title: 'Video vid001',
    });
    expect(ytDlp.getPlaylistInfo).toHaveBeenCalledTimes(1);
    expect(ytDlp.getVideoMeta).toHaveBeenCalledTimes(2);
  });

  it('(b) discoveryMaxAgeDays filters out videos older than the threshold', async () => {
    const config: TikTokSourceConfig = { discoveryMaxAgeDays: 7 };
    ytDlp.getPlaylistInfo.mockResolvedValueOnce(playlistEntries);
    ytDlp.getVideoMeta
      .mockResolvedValueOnce(makeVideoMeta('vid001', 3))   // 3 days old — within 7 days
      .mockResolvedValueOnce(makeVideoMeta('vid002', 10));  // 10 days old — filtered out

    const result = await adapter.discover(config, { ...ctx, maxAgeDays: 7 });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.sourceVideoId).toBe('vid001');
    expect(result.failures).toHaveLength(0);
  });

  it('(b) ctx.maxAgeDays takes precedence over config.discoveryMaxAgeDays for filtering', async () => {
    const config: TikTokSourceConfig = { discoveryMaxAgeDays: 30 };
    ytDlp.getPlaylistInfo.mockResolvedValueOnce(playlistEntries);
    ytDlp.getVideoMeta
      .mockResolvedValueOnce(makeVideoMeta('vid001', 3))
      .mockResolvedValueOnce(makeVideoMeta('vid002', 10));

    // ctx.maxAgeDays = 5 → vid002 (10 days) filtered out
    const result = await adapter.discover(config, { ...ctx, maxAgeDays: 5 });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.sourceVideoId).toBe('vid001');
  });

  it('(c) maxBacklog limits how many playlist entries are processed', async () => {
    const threeEntries: PlaylistEntry[] = [
      ...playlistEntries,
      { id: 'vid003', url: 'https://www.tiktok.com/@testuser/video/vid003' },
    ];
    ytDlp.getPlaylistInfo.mockResolvedValueOnce(threeEntries);
    ytDlp.getVideoMeta
      .mockResolvedValueOnce(makeVideoMeta('vid001', 1))
      .mockResolvedValueOnce(makeVideoMeta('vid002', 1));

    // maxBacklog = 2 → only vid001 and vid002 processed
    const result = await adapter.discover(baseConfig, { ...ctx, maxBacklog: 2 });

    expect(result.videos).toHaveLength(2);
    expect(ytDlp.getVideoMeta).toHaveBeenCalledTimes(2);
    expect(ytDlp.getVideoMeta).not.toHaveBeenCalledWith(
      expect.stringContaining('vid003'),
      expect.anything(),
    );
  });

  it('(d) cookie priority 1: config.firefoxProfilePath → --cookies-from-browser', async () => {
    const config: TikTokSourceConfig = { firefoxProfilePath: '/my/firefox' };
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([playlistEntries[0]!]);
    ytDlp.getVideoMeta.mockResolvedValueOnce(makeVideoMeta('vid001', 1));

    await adapter.discover(config, ctx);

    const [[, opts]] = ytDlp.getPlaylistInfo.mock.calls as [string, { cookieArgs?: string[] }][];
    expect(opts?.cookieArgs).toContain('--cookies-from-browser');
    expect(opts?.cookieArgs?.join(' ')).toContain('/my/firefox');
  });

  it('(d) cookie priority 2: config.cookiesFile → --cookies (when no firefoxProfile)', async () => {
    const config: TikTokSourceConfig = { cookiesFile: '/my/cookies.txt' };
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([playlistEntries[0]!]);
    ytDlp.getVideoMeta.mockResolvedValueOnce(makeVideoMeta('vid001', 1));

    await adapter.discover(config, ctx);

    const [[, opts]] = ytDlp.getPlaylistInfo.mock.calls as [string, { cookieArgs?: string[] }][];
    expect(opts?.cookieArgs).toContain('--cookies');
    expect(opts?.cookieArgs).toContain('/my/cookies.txt');
  });

  it('(d) cookie priority 3: FIREFOX_PROFILE_PATH env → --cookies-from-browser', async () => {
    process.env['FIREFOX_PROFILE_PATH'] = '/env/firefox';
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([playlistEntries[0]!]);
    ytDlp.getVideoMeta.mockResolvedValueOnce(makeVideoMeta('vid001', 1));

    await adapter.discover(baseConfig, ctx);

    const [[, opts]] = ytDlp.getPlaylistInfo.mock.calls as [string, { cookieArgs?: string[] }][];
    expect(opts?.cookieArgs).toContain('--cookies-from-browser');
    expect(opts?.cookieArgs?.join(' ')).toContain('/env/firefox');
  });

  it('(d) cookie priority 4: TIKTOK_COOKIES_FILE env → --cookies (lowest priority)', async () => {
    process.env['TIKTOK_COOKIES_FILE'] = '/env/cookies.txt';
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([playlistEntries[0]!]);
    ytDlp.getVideoMeta.mockResolvedValueOnce(makeVideoMeta('vid001', 1));

    await adapter.discover(baseConfig, ctx);

    const [[, opts]] = ytDlp.getPlaylistInfo.mock.calls as [string, { cookieArgs?: string[] }][];
    expect(opts?.cookieArgs).toContain('--cookies');
    expect(opts?.cookieArgs).toContain('/env/cookies.txt');
  });

  it('(d) config.firefoxProfilePath overrides TIKTOK_COOKIES_FILE env var', async () => {
    process.env['TIKTOK_COOKIES_FILE'] = '/env/cookies.txt';
    const config: TikTokSourceConfig = { firefoxProfilePath: '/config/firefox' };
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([playlistEntries[0]!]);
    ytDlp.getVideoMeta.mockResolvedValueOnce(makeVideoMeta('vid001', 1));

    await adapter.discover(config, ctx);

    const [[, opts]] = ytDlp.getPlaylistInfo.mock.calls as [string, { cookieArgs?: string[] }][];
    expect(opts?.cookieArgs).toContain('--cookies-from-browser');
    expect(opts?.cookieArgs).not.toContain('--cookies');
  });

  it('(e) partial failure: one getVideoMeta rejection does not throw; other videos returned', async () => {
    ytDlp.getPlaylistInfo.mockResolvedValueOnce(playlistEntries);
    ytDlp.getVideoMeta
      .mockResolvedValueOnce(makeVideoMeta('vid001', 1))
      .mockRejectedValueOnce(new Error('video unavailable'));

    const result = await adapter.discover(baseConfig, ctx);

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.sourceVideoId).toBe('vid001');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain('video unavailable');
    expect(result.failures[0]?.url).toBe('https://www.tiktok.com/@testuser/video/vid002');
  });

  it('(f) adapter returns all discovered videos including potential duplicates (DB dedup is activity-level)', async () => {
    // The adapter does NOT filter by known DB IDs — it returns all valid VideoMetadata.
    // The discoverCreatorVideos activity uses onConflictDoNothing() for deduplication.
    ytDlp.getPlaylistInfo.mockResolvedValueOnce(playlistEntries);
    ytDlp.getVideoMeta
      .mockResolvedValueOnce(makeVideoMeta('vid001', 1))
      .mockResolvedValueOnce(makeVideoMeta('vid002', 1));

    const result = await adapter.discover(baseConfig, ctx);

    // Both videos returned — caller is responsible for deduplication
    expect(result.videos).toHaveLength(2);
    expect(result.videos.map((v) => v.sourceVideoId)).toEqual(['vid001', 'vid002']);
  });

  it('(g) full-failure path: getPlaylistInfo() throws → discover() propagates the error', async () => {
    ytDlp.getPlaylistInfo.mockRejectedValueOnce(new Error('TikTok rate limited'));

    // The adapter must propagate this error — the activity catches it and writes lastPollError to DB
    await expect(adapter.discover(baseConfig, ctx)).rejects.toThrow('TikTok rate limited');
  });

  it('(h) handle stored with leading "@" is normalised — URL does not contain "@@"', async () => {
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([]);

    await adapter.discover(baseConfig, { ...ctx, handle: '@testuser' });

    const calledUrl: string = ytDlp.getPlaylistInfo.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://www.tiktok.com/@testuser');
    expect(calledUrl).not.toContain('@@');
  });
});

// ── resolveCookieArgs() helper ────────────────────────────────────────────────

describe('resolveCookieArgs()', () => {
  afterEach(() => {
    delete process.env['FIREFOX_PROFILE_PATH'];
    delete process.env['TIKTOK_COOKIES_FILE'];
  });

  it('returns --cookies-from-browser args for firefoxProfilePath (priority 1)', () => {
    const args = resolveCookieArgs({ firefoxProfilePath: '/p1', cookiesFile: '/c1' });
    expect(args).toEqual(['--cookies-from-browser', 'firefox:/p1']);
  });

  it('returns --cookies args for cookiesFile (priority 2)', () => {
    const args = resolveCookieArgs({ cookiesFile: '/c1' });
    expect(args).toEqual(['--cookies', '/c1']);
  });

  it('returns env FIREFOX_PROFILE_PATH args (priority 3)', () => {
    process.env['FIREFOX_PROFILE_PATH'] = '/env/ff';
    const args = resolveCookieArgs({});
    expect(args).toEqual(['--cookies-from-browser', 'firefox:/env/ff']);
  });

  it('returns env TIKTOK_COOKIES_FILE args (priority 4)', () => {
    process.env['TIKTOK_COOKIES_FILE'] = '/env/c.txt';
    const args = resolveCookieArgs({});
    expect(args).toEqual(['--cookies', '/env/c.txt']);
  });

  it('returns empty array when no cookie source is configured', () => {
    const args = resolveCookieArgs({});
    expect(args).toEqual([]);
  });
});

// ── T009: TiktokAdapter.test() ────────────────────────────────────────────────

describe('TiktokAdapter.test()', () => {
  let ytDlp: ReturnType<typeof makeMockYtDlp>;
  let adapter: TiktokAdapter;

  const mockIpInfoResponse = {
    ip: '10.8.0.1',
    hostname: 'vpn-exit.example.com',
    org: 'AS12345 Mullvad VPN AB',
    country: 'SE',
  };

  beforeEach(() => {
    ytDlp = makeMockYtDlp();
    adapter = new TiktokAdapter(ytDlp as any);
    delete process.env['FIREFOX_PROFILE_PATH'];
    delete process.env['TIKTOK_COOKIES_FILE'];

    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockIpInfoResponse,
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns full TikTokTestResult on success', async () => {
    ytDlp.version.mockResolvedValueOnce('2025.01.15');
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([
      { id: 'ttvid', url: 'https://www.tiktok.com/@tiktok/video/ttvid' },
    ]);

    const result = await adapter.test({});

    expect(result.publicIp).toBe('10.8.0.1');
    expect(result.hostname).toBe('vpn-exit.example.com');
    expect(result.org).toBe('AS12345 Mullvad VPN AB');
    expect(result.country).toBe('SE');
    expect(result.ytdlpVersion).toBe('2025.01.15');
    expect(result.ytdlpProbeOk).toBe(true);
    expect(result.ytdlpProbeError).toBeUndefined();
    expect(result.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('ytdlpProbeOk = false when getPlaylistInfo returns empty entries (no throw)', async () => {
    ytDlp.version.mockResolvedValueOnce('2025.01.15');
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([]);

    const result = await adapter.test({});

    expect(result.ytdlpProbeOk).toBe(false);
    expect(result.ytdlpProbeError).toBeDefined();
    // Should NOT throw — returns partial result at HTTP 200
  });

  it('ytdlpProbeOk = false when getPlaylistInfo throws (no rethrow)', async () => {
    ytDlp.version.mockResolvedValueOnce('2025.01.15');
    ytDlp.getPlaylistInfo.mockRejectedValueOnce(new Error('yt-dlp auth failed'));

    const result = await adapter.test({});

    expect(result.ytdlpProbeOk).toBe(false);
    expect(result.ytdlpProbeError).toContain('yt-dlp auth failed');
    // VPN check still succeeds
    expect(result.publicIp).toBe('10.8.0.1');
  });

  it('testedAt is an ISO 8601 UTC timestamp', async () => {
    ytDlp.version.mockResolvedValueOnce('2025.01.15');
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([
      { id: 'ttvid', url: 'https://www.tiktok.com/@tiktok/video/ttvid' },
    ]);

    const result = await adapter.test({});

    expect(() => new Date(result.testedAt)).not.toThrow();
    expect(new Date(result.testedAt).toISOString()).toBe(result.testedAt);
  });

  it('probes @tiktok account with correct URL and cookieArgs', async () => {
    const config: TikTokSourceConfig = { cookiesFile: '/data/cookies.txt' };
    ytDlp.version.mockResolvedValueOnce('2025.01.15');
    ytDlp.getPlaylistInfo.mockResolvedValueOnce([
      { id: 'ttvid', url: 'https://www.tiktok.com/@tiktok/video/ttvid' },
    ]);

    await adapter.test(config);

    const [url, opts] = ytDlp.getPlaylistInfo.mock.calls[0] as [string, { limit?: number; cookieArgs?: string[] }];
    expect(url).toBe('https://www.tiktok.com/@tiktok');
    expect(opts?.limit).toBe(1);
    expect(opts?.cookieArgs).toContain('--cookies');
    expect(opts?.cookieArgs).toContain('/data/cookies.txt');
  });
});

// ── T015: TiktokAdapter.download() ───────────────────────────────────────────

describe('TiktokAdapter.download()', () => {
  let ytDlp: ReturnType<typeof makeMockYtDlp>;
  let adapter: TiktokAdapter;

  beforeEach(() => {
    ytDlp = makeMockYtDlp();
    adapter = new TiktokAdapter(ytDlp as any);
    delete process.env['FIREFOX_PROFILE_PATH'];
    delete process.env['TIKTOK_COOKIES_FILE'];
  });

  afterEach(() => {
    delete process.env['FIREFOX_PROFILE_PATH'];
    delete process.env['TIKTOK_COOKIES_FILE'];
  });

  const videoUrl = 'https://www.tiktok.com/@user/video/vid001';
  const destDir = '/data/downloads';

  it('calls downloadVideo with correct format flags', async () => {
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');

    const result = await adapter.download({}, videoUrl, destDir);

    expect(result).toBe('/data/downloads/vid001.mp4');

    const [, outputTemplate, opts] = ytDlp.downloadVideo.mock.calls[0] as [
      string,
      string,
      { cookieArgs?: string[]; extraArgs?: string[] },
    ];

    expect(outputTemplate).toBe(`${destDir}/%(id)s.%(ext)s`);
    expect(opts?.extraArgs).toContain('-f');
    expect(opts?.extraArgs).toContain(
      'best[ext=mp4][vcodec=h264]/best[vcodec=h264]/best[ext=mp4]/best',
    );
    expect(opts?.extraArgs).toContain('--merge-output-format');
    expect(opts?.extraArgs).toContain('mp4');
  });

  it('passes the video URL as first arg to downloadVideo', async () => {
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');

    await adapter.download({}, videoUrl, destDir);

    const [url] = ytDlp.downloadVideo.mock.calls[0] as [string, string, unknown];
    expect(url).toBe(videoUrl);
  });

  it('(d) cookie priority 1: config.firefoxProfilePath → --cookies-from-browser', async () => {
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');
    const config: TikTokSourceConfig = { firefoxProfilePath: '/my/firefox' };

    await adapter.download(config, videoUrl, destDir);

    const [, , opts] = ytDlp.downloadVideo.mock.calls[0] as [
      string,
      string,
      { cookieArgs?: string[]; extraArgs?: string[] },
    ];
    expect(opts?.cookieArgs).toContain('--cookies-from-browser');
    expect(opts?.cookieArgs?.join(' ')).toContain('/my/firefox');
  });

  it('(d) cookie priority 2: config.cookiesFile → --cookies', async () => {
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');
    const config: TikTokSourceConfig = { cookiesFile: '/data/cookies.txt' };

    await adapter.download(config, videoUrl, destDir);

    const [, , opts] = ytDlp.downloadVideo.mock.calls[0] as [
      string,
      string,
      { cookieArgs?: string[]; extraArgs?: string[] },
    ];
    expect(opts?.cookieArgs).toContain('--cookies');
    expect(opts?.cookieArgs).toContain('/data/cookies.txt');
  });

  it('(d) cookie priority 3: FIREFOX_PROFILE_PATH env', async () => {
    process.env['FIREFOX_PROFILE_PATH'] = '/env/firefox';
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');

    await adapter.download({}, videoUrl, destDir);

    const [, , opts] = ytDlp.downloadVideo.mock.calls[0] as [
      string,
      string,
      { cookieArgs?: string[]; extraArgs?: string[] },
    ];
    expect(opts?.cookieArgs).toContain('--cookies-from-browser');
    expect(opts?.cookieArgs?.join(' ')).toContain('/env/firefox');
  });

  it('(d) cookie priority 4: TIKTOK_COOKIES_FILE env', async () => {
    process.env['TIKTOK_COOKIES_FILE'] = '/env/cookies.txt';
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');

    await adapter.download({}, videoUrl, destDir);

    const [, , opts] = ytDlp.downloadVideo.mock.calls[0] as [
      string,
      string,
      { cookieArgs?: string[]; extraArgs?: string[] },
    ];
    expect(opts?.cookieArgs).toContain('--cookies');
    expect(opts?.cookieArgs).toContain('/env/cookies.txt');
  });

  it('returns the absolute file path from downloadVideo', async () => {
    ytDlp.downloadVideo.mockResolvedValueOnce('/data/downloads/vid001.mp4');

    const result = await adapter.download({}, videoUrl, destDir);
    expect(result).toBe('/data/downloads/vid001.mp4');
  });
});
