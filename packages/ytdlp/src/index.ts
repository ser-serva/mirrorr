/**
 * @mirrorr/ytdlp
 *
 * Thin, platform-agnostic wrapper around the yt-dlp CLI.
 * Has no knowledge of TikTok, source config, or env vars.
 * Cookie auth args are passed per-call by the caller (the adapter).
 */
import { spawn } from 'node:child_process';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface PlaylistEntry {
  id: string;
  url: string;
}

export interface VideoMeta {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[];
  timestamp: number | null;   // unix epoch seconds
  duration: number | null;    // seconds
  view_count: number | null;
  thumbnail: string | null;
  webpage_url: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Spawn yt-dlp with the given args and collect stdout/stderr.
 * Resolves with stdout on exit 0; rejects with stderr (or fallback) otherwise.
 */
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { env: process.env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

// ── YtDlp class ───────────────────────────────────────────────────────────────

export class YtDlp {
  /**
   * Returns the installed yt-dlp version string (from `yt-dlp --version`).
   */
  async version(): Promise<string> {
    const output = await runYtDlp(['--version']);
    return output.trim();
  }

  /**
   * Flat-playlist fetch — returns video IDs and URLs without downloading.
   */
  async getPlaylistInfo(
    url: string,
    options?: { limit?: number; cookieArgs?: string[] },
  ): Promise<PlaylistEntry[]> {
    const args: string[] = ['--flat-playlist', '--no-warnings', '-J'];

    if (options?.limit != null) {
      args.push('--playlist-end', String(options.limit));
    }

    if (options?.cookieArgs?.length) {
      args.push(...options.cookieArgs);
    }

    args.push(url);

    const output = await runYtDlp(args);
    const parsed = JSON.parse(output) as { entries?: Array<{ id: string; url: string }> };
    return (parsed.entries ?? []).map((e) => ({ id: e.id, url: e.url }));
  }

  /**
   * Full metadata for a single video (--skip-download).
   */
  async getVideoMeta(
    url: string,
    options?: { cookieArgs?: string[] },
  ): Promise<VideoMeta> {
    const args: string[] = ['--skip-download', '--no-playlist', '--no-warnings', '-J'];

    if (options?.cookieArgs?.length) {
      args.push(...options.cookieArgs);
    }

    args.push(url);

    const output = await runYtDlp(args);
    return JSON.parse(output) as VideoMeta;
  }

  /**
   * Download a video to disk.
   * outputTemplate: yt-dlp -o template, e.g. '/data/downloads/%(id)s.%(ext)s'
   * Returns the absolute path of the written file (via --print after_move:filepath).
   */
  async downloadVideo(
    url: string,
    outputTemplate: string,
    options?: { cookieArgs?: string[]; extraArgs?: string[] },
  ): Promise<string> {
    const args: string[] = ['--no-playlist', '--no-warnings', '--print', 'after_move:filepath', '-o', outputTemplate];

    if (options?.extraArgs?.length) {
      args.push(...options.extraArgs);
    }

    if (options?.cookieArgs?.length) {
      args.push(...options.cookieArgs);
    }

    args.push(url);

    const output = await runYtDlp(args);
    return output.trim();
  }
}
