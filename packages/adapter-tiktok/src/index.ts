/**
 * @mirrorr/adapter-tiktok
 *
 * TikTok source adapter using yt-dlp for discovery and download.
 * Cookie auth is resolved at call-time via a config-over-env priority chain.
 */
import type { SourceAdapter, VideoMetadata, DiscoveryResult, DiscoveryContext } from '@mirrorr/adapter-core';
import { YtDlp, type PlaylistEntry, type VideoMeta } from '@mirrorr/ytdlp';
import { ProxyAgent } from 'undici';

// ── TikTok config type ────────────────────────────────────────────────────────
// Mirrors apps/backend/src/db/schema.ts TikTokSourceConfig.
// Defined here to avoid a cross-package import from adapter → backend.

export interface TikTokSourceConfig {
  discoveryPlaylistLimit?: number;
  discoveryMaxAgeDays?: number;
  maxConcurrentDownloads?: number;
  cookiesFile?: string;
  firefoxProfilePath?: string;
}

// ── TikTokTestResult ──────────────────────────────────────────────────────────

export interface TikTokTestResult {
  /** Outbound IP as seen by ipinfo.io */
  publicIp: string;
  /** Reverse DNS hostname */
  hostname: string;
  /** ASN + organisation, e.g. "AS12345 Mullvad VPN AB" */
  org: string;
  /** ISO 3166-1 alpha-2 country code */
  country: string;
  /** yt-dlp version string from `yt-dlp --version` */
  ytdlpVersion: string;
  /** true if flat-playlist probe exited 0 with ≥1 entry */
  ytdlpProbeOk: boolean;
  /** Error message when ytdlpProbeOk = false */
  ytdlpProbeError?: string;
  /** ISO 8601 UTC timestamp */
  testedAt: string;
}

// ── Cookie arg resolution ─────────────────────────────────────────────────────

/**
 * Resolve cookie auth args from the per-source config priority chain.
 *
 * Priority order (highest → lowest):
 *   1. config.firefoxProfilePath → --cookies-from-browser firefox:<path>
 *   2. config.cookiesFile        → --cookies <file>
 *   3. FIREFOX_PROFILE_PATH env  → --cookies-from-browser firefox:<path>
 *   4. TIKTOK_COOKIES_FILE env   → --cookies <file>
 *   5. Nothing configured        → [] (no auth args)
 */
export function resolveCookieArgs(config: TikTokSourceConfig): string[] {
  if (config.firefoxProfilePath) {
    return ['--cookies-from-browser', `firefox:${config.firefoxProfilePath}`];
  }
  if (config.cookiesFile) {
    return ['--cookies', config.cookiesFile];
  }
  const envFirefox = process.env['FIREFOX_PROFILE_PATH'];
  if (envFirefox) {
    return ['--cookies-from-browser', `firefox:${envFirefox}`];
  }
  const envCookies = process.env['TIKTOK_COOKIES_FILE'];
  if (envCookies) {
    return ['--cookies', envCookies];
  }
  return [];
}

// ── Internal YtDlp interface (for dependency injection in tests) ──────────────

interface IYtDlp {
  version(): Promise<string>;
  getPlaylistInfo(
    url: string,
    options?: { limit?: number; cookieArgs?: string[] },
  ): Promise<PlaylistEntry[]>;
  getVideoMeta(url: string, options?: { cookieArgs?: string[] }): Promise<VideoMeta>;
  downloadVideo(
    url: string,
    outputTemplate: string,
    options?: { cookieArgs?: string[]; extraArgs?: string[] },
  ): Promise<string>;
}

// ── TiktokAdapter ─────────────────────────────────────────────────────────────

export class TiktokAdapter implements SourceAdapter {
  private readonly _ytDlp: IYtDlp;

  /**
   * @param ytDlp Optional YtDlp instance — pass a mock for unit testing.
   *              Defaults to a real YtDlp() when omitted.
   */
  constructor(ytDlp?: IYtDlp) {
    this._ytDlp = ytDlp ?? new YtDlp();
  }

  // ── discover() ─────────────────────────────────────────────────────────────

  async discover(config: unknown, ctx: DiscoveryContext): Promise<DiscoveryResult> {
    const cfg = (config ?? {}) as TikTokSourceConfig;
    const cookieArgs = resolveCookieArgs(cfg);
    const limit = cfg.discoveryPlaylistLimit;
    const maxAgeDays = ctx.maxAgeDays ?? cfg.discoveryMaxAgeDays;
    const maxBacklog = ctx.maxBacklog;

    // Strip leading '@' from handle — the DB may store handles with or without it.
    const channelUrl = `https://www.tiktok.com/@${ctx.handle.replace(/^@/, '')}`;

    // Phase 1: flat-playlist — get IDs + URLs
    const entries: PlaylistEntry[] = await this._ytDlp.getPlaylistInfo(channelUrl, {
      limit,
      cookieArgs,
    });

    // Apply maxBacklog limit
    const limited = maxBacklog != null ? entries.slice(0, maxBacklog) : entries;

    // Phase 2: per-ID metadata fetch
    const videos: VideoMetadata[] = [];
    const failures: DiscoveryResult['failures'] = [];

    const nowSec = Date.now() / 1000;
    const cutoffAgeSeconds = maxAgeDays != null ? maxAgeDays * 86400 : null;

    for (const entry of limited) {
      try {
        const meta = await this._ytDlp.getVideoMeta(entry.url, { cookieArgs });

        // Age filter: skip videos older than maxAgeDays
        if (
          cutoffAgeSeconds !== null &&
          meta.timestamp !== null &&
          nowSec - meta.timestamp > cutoffAgeSeconds
        ) {
          continue;
        }

        videos.push({
          sourceVideoId: meta.id,
          sourceVideoUrl: meta.webpage_url,
          title: meta.title ?? undefined,
          description: meta.description ?? undefined,
          hashtags: meta.tags,
          publishedAt: meta.timestamp != null ? new Date(meta.timestamp * 1000) : undefined,
        });
      } catch (err) {
        failures.push({
          url: entry.url,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { videos, failures };
  }

  // ── download() ─────────────────────────────────────────────────────────────

  async download(config: unknown, url: string, destDir: string): Promise<string> {
    const cfg = (config ?? {}) as TikTokSourceConfig;
    const cookieArgs = resolveCookieArgs(cfg);
    const outputTemplate = `${destDir}/%(id)s.%(ext)s`;

    return this._ytDlp.downloadVideo(url, outputTemplate, {
      cookieArgs,
      extraArgs: [
        '-f', 'best[ext=mp4][vcodec=h264]/best[vcodec=h264]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
      ],
    });
  }

  // ── test() ─────────────────────────────────────────────────────────────────

  async test(config: unknown): Promise<TikTokTestResult> {
    const cfg = (config ?? {}) as TikTokSourceConfig;
    const cookieArgs = resolveCookieArgs(cfg);

    // Step 1: VPN connectivity check — throws on failure (route returns 502)
    // If YTDLP_PROXY is set (e.g. http://gluetun:8888), route the IP check
    // through the same proxy so the returned IP reflects the VPN exit node.
    const proxyUrl = process.env.YTDLP_PROXY;
    const ipFetchInit = proxyUrl
      ? ({ dispatcher: new ProxyAgent(proxyUrl) } as unknown as RequestInit)
      : undefined;
    const ipRes = await fetch('https://ipinfo.io/json', ipFetchInit);
    const ipInfo = (await ipRes.json()) as {
      ip: string;
      hostname: string;
      org: string;
      country: string;
    };

    // Step 2: yt-dlp version check
    const ytdlpVersion = await this._ytDlp.version();

    // Step 3: yt-dlp auth probe (non-throwing)
    let ytdlpProbeOk = false;
    let ytdlpProbeError: string | undefined;

    try {
      const probeEntries = await this._ytDlp.getPlaylistInfo('https://www.tiktok.com/@tiktok', {
        limit: 1,
        cookieArgs,
      });

      if (probeEntries.length >= 1) {
        ytdlpProbeOk = true;
      } else {
        ytdlpProbeError = 'probe returned no entries';
      }
    } catch (err) {
      ytdlpProbeError = err instanceof Error ? err.message : String(err);
    }

    return {
      publicIp: ipInfo.ip,
      hostname: ipInfo.hostname,
      org: ipInfo.org,
      country: ipInfo.country,
      ytdlpVersion,
      ytdlpProbeOk,
      ytdlpProbeError,
      testedAt: new Date().toISOString(),
    };
  }

  // ── fetchMeta() (kept for SourceAdapter compat, delegates to getVideoMeta) ─

  async fetchMeta(config: unknown, url: string): Promise<VideoMetadata> {
    const cfg = (config ?? {}) as TikTokSourceConfig;
    const cookieArgs = resolveCookieArgs(cfg);
    const meta = await this._ytDlp.getVideoMeta(url, { cookieArgs });

    return {
      sourceVideoId: meta.id,
      sourceVideoUrl: meta.webpage_url,
      title: meta.title ?? undefined,
      description: meta.description ?? undefined,
      hashtags: meta.tags,
      publishedAt: meta.timestamp != null ? new Date(meta.timestamp * 1000) : undefined,
    };
  }
}

export const adapter = new TiktokAdapter();
