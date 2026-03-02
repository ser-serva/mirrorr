/**
 * T003 🔴 TDD-RED: YtDlp spawn wrapper unit tests.
 *
 * Tests MUST FAIL before implementation (T004).
 * Run: pnpm --filter @mirrorr/ytdlp test
 *
 * Covers:
 *   - version(): returns trimmed version string from `yt-dlp --version`
 *   - getPlaylistInfo(): parses flat-playlist JSON, default args
 *   - getPlaylistInfo() with limit: passes --playlist-end N
 *   - getPlaylistInfo() with cookieArgs: appends cookie args
 *   - getVideoMeta(): parses single-video JSON with --skip-download
 *   - getVideoMeta() with cookieArgs: appends cookie args
 *   - downloadVideo(): returns absolute path from --print after_move:filepath
 *   - downloadVideo() with cookieArgs and extraArgs: passes all args
 *   - Non-zero exit code → rejected promise with stderr message
 */
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { YtDlp, type PlaylistEntry, type VideoMeta } from '../../src/index.js';

// ── Mock child_process.spawn ──────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import * as childProcess from 'node:child_process';

// Helper: build a fake ChildProcess that emits configured output then closes
function makeSpawn(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // Emit asynchronously so callers have time to attach listeners
  setImmediate(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr ?? ''));
    proc.emit('close', opts.exitCode ?? 0);
  });

  return proc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const spawnMock = childProcess.spawn as unknown as MockInstance;

beforeEach(() => {
  spawnMock.mockReset();
});

describe('YtDlp.version()', () => {
  it('calls yt-dlp --version and returns trimmed version string', async () => {
    spawnMock.mockReturnValueOnce(makeSpawn({ stdout: '2025.01.15\n' }));

    const ytDlp = new YtDlp();
    const version = await ytDlp.version();

    expect(version).toBe('2025.01.15');
    expect(spawnMock).toHaveBeenCalledWith('yt-dlp', ['--version'], expect.any(Object));
  });

  it('rejects when yt-dlp exits non-zero', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stderr: 'yt-dlp: not found', exitCode: 127 }),
    );

    const ytDlp = new YtDlp();
    await expect(ytDlp.version()).rejects.toThrow('yt-dlp: not found');
  });
});

describe('YtDlp.getPlaylistInfo()', () => {
  const mockPlaylistJson = JSON.stringify({
    entries: [
      { id: 'vid001', url: 'https://www.tiktok.com/@user/video/vid001' },
      { id: 'vid002', url: 'https://www.tiktok.com/@user/video/vid002' },
    ],
  });

  it('calls yt-dlp with flat-playlist args and returns PlaylistEntry[]', async () => {
    spawnMock.mockReturnValueOnce(makeSpawn({ stdout: mockPlaylistJson }));

    const ytDlp = new YtDlp();
    const entries = await ytDlp.getPlaylistInfo('https://www.tiktok.com/@user');

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject<PlaylistEntry>({
      id: 'vid001',
      url: 'https://www.tiktok.com/@user/video/vid001',
    });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--flat-playlist');
    expect(args).toContain('-J');
    expect(args).toContain('--no-warnings');
    expect(args).toContain('https://www.tiktok.com/@user');
    expect(args).not.toContain('--playlist-end');
  });

  it('passes --playlist-end N when limit is provided', async () => {
    spawnMock.mockReturnValueOnce(makeSpawn({ stdout: mockPlaylistJson }));

    const ytDlp = new YtDlp();
    await ytDlp.getPlaylistInfo('https://www.tiktok.com/@user', { limit: 5 });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const limitIdx = args.indexOf('--playlist-end');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(args[limitIdx + 1]).toBe('5');
  });

  it('appends cookieArgs when provided', async () => {
    spawnMock.mockReturnValueOnce(makeSpawn({ stdout: mockPlaylistJson }));

    const ytDlp = new YtDlp();
    await ytDlp.getPlaylistInfo('https://www.tiktok.com/@user', {
      cookieArgs: ['--cookies', '/data/cookies.txt'],
    });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--cookies');
    expect(args).toContain('/data/cookies.txt');
  });

  it('handles empty entries array', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stdout: JSON.stringify({ entries: [] }) }),
    );

    const ytDlp = new YtDlp();
    const entries = await ytDlp.getPlaylistInfo('https://www.tiktok.com/@user');
    expect(entries).toEqual([]);
  });
});

describe('YtDlp.getVideoMeta()', () => {
  const mockMeta: VideoMeta = {
    id: 'vid001',
    title: 'Test video',
    description: 'A test video',
    tags: ['fyp', 'test'],
    timestamp: 1700000000,
    duration: 30,
    view_count: 1000,
    thumbnail: 'https://example.com/thumb.jpg',
    webpage_url: 'https://www.tiktok.com/@user/video/vid001',
  };

  it('calls yt-dlp with --skip-download and returns VideoMeta', async () => {
    spawnMock.mockReturnValueOnce(makeSpawn({ stdout: JSON.stringify(mockMeta) }));

    const ytDlp = new YtDlp();
    const meta = await ytDlp.getVideoMeta('https://www.tiktok.com/@user/video/vid001');

    expect(meta).toMatchObject<VideoMeta>({
      id: 'vid001',
      title: 'Test video',
      description: 'A test video',
      tags: ['fyp', 'test'],
      timestamp: 1700000000,
      duration: 30,
      view_count: 1000,
      thumbnail: expect.any(String),
      webpage_url: expect.any(String),
    });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--skip-download');
    expect(args).toContain('--no-playlist');
    expect(args).toContain('-J');
    expect(args).toContain('--no-warnings');
    expect(args).toContain('https://www.tiktok.com/@user/video/vid001');
  });

  it('appends cookieArgs when provided', async () => {
    spawnMock.mockReturnValueOnce(makeSpawn({ stdout: JSON.stringify(mockMeta) }));

    const ytDlp = new YtDlp();
    await ytDlp.getVideoMeta('https://www.tiktok.com/@user/video/vid001', {
      cookieArgs: ['--cookies-from-browser', 'firefox:/firefox-profile'],
    });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--cookies-from-browser');
    expect(args).toContain('firefox:/firefox-profile');
  });

  it('rejects on non-zero exit with stderr', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stderr: 'ERROR: Video unavailable', exitCode: 1 }),
    );

    const ytDlp = new YtDlp();
    await expect(
      ytDlp.getVideoMeta('https://www.tiktok.com/@user/video/vid001'),
    ).rejects.toThrow('ERROR: Video unavailable');
  });
});

describe('YtDlp.downloadVideo()', () => {
  it('calls yt-dlp with correct args and returns file path from stdout', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stdout: '/data/downloads/vid001.mp4\n' }),
    );

    const ytDlp = new YtDlp();
    const filePath = await ytDlp.downloadVideo(
      'https://www.tiktok.com/@user/video/vid001',
      '/data/downloads/%(id)s.%(ext)s',
    );

    expect(filePath).toBe('/data/downloads/vid001.mp4');

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--print');
    const printIdx = args.indexOf('--print');
    expect(args[printIdx + 1]).toBe('after_move:filepath');
    expect(args).toContain('-o');
    const oIdx = args.indexOf('-o');
    expect(args[oIdx + 1]).toBe('/data/downloads/%(id)s.%(ext)s');
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--no-warnings');
    expect(args).toContain('https://www.tiktok.com/@user/video/vid001');
  });

  it('appends cookieArgs when provided', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stdout: '/data/downloads/vid001.mp4\n' }),
    );

    const ytDlp = new YtDlp();
    await ytDlp.downloadVideo(
      'https://www.tiktok.com/@user/video/vid001',
      '/data/downloads/%(id)s.%(ext)s',
      { cookieArgs: ['--cookies', '/data/cookies.txt'] },
    );

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--cookies');
    expect(args).toContain('/data/cookies.txt');
  });

  it('appends extraArgs when provided', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stdout: '/data/downloads/vid001.mp4\n' }),
    );

    const ytDlp = new YtDlp();
    await ytDlp.downloadVideo(
      'https://www.tiktok.com/@user/video/vid001',
      '/data/downloads/%(id)s.%(ext)s',
      {
        extraArgs: [
          '-f', 'best[ext=mp4][vcodec=h264]/best[vcodec=h264]/best[ext=mp4]/best',
          '--merge-output-format', 'mp4',
        ],
      },
    );

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('-f');
    expect(args).toContain('best[ext=mp4][vcodec=h264]/best[vcodec=h264]/best[ext=mp4]/best');
    expect(args).toContain('--merge-output-format');
    expect(args).toContain('mp4');
  });

  it('rejects on non-zero exit with stderr', async () => {
    spawnMock.mockReturnValueOnce(
      makeSpawn({ stderr: 'ERROR: Unable to download', exitCode: 1 }),
    );

    const ytDlp = new YtDlp();
    await expect(
      ytDlp.downloadVideo(
        'https://www.tiktok.com/@user/video/vid001',
        '/data/downloads/%(id)s.%(ext)s',
      ),
    ).rejects.toThrow('ERROR: Unable to download');
  });
});
