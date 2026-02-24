// ─── Video Metadata ──────────────────────────────────────────────────────────

export interface VideoMetadata {
  sourceVideoId: string;
  sourceVideoUrl: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  publishedAt?: Date;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface DiscoveryContext {
  handle: string;
  maxBacklog?: number;
  maxAgeDays?: number;
}

export interface DiscoveryFailure {
  url: string;
  reason: string;
}

export interface DiscoveryResult {
  videos: VideoMetadata[];
  failures: DiscoveryFailure[];
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadOptions {
  title?: string;
  description?: string;
  hashtags?: string[];
}

export interface UploadResult {
  postId: string;
}

// ─── Source Adapter ───────────────────────────────────────────────────────────

export interface SourceAdapter {
  /**
   * Discover new videos for a creator.
   */
  discover(config: unknown, ctx: DiscoveryContext): Promise<DiscoveryResult>;

  /**
   * Download a single video to the given destination directory.
   * Returns the absolute path to the downloaded file.
   */
  download(config: unknown, url: string, destDir: string): Promise<string>;

  /**
   * Fetch metadata for a single video URL without downloading it.
   */
  fetchMeta(config: unknown, url: string): Promise<VideoMetadata>;
}

// ─── Target Adapter ───────────────────────────────────────────────────────────

export interface TargetConfig {
  url: string;
  token: string;
  publicationConfig?: {
    titleTemplate?: string;
    descriptionTemplate?: string;
  };
}

export interface TargetAdapter {
  /**
   * Upload a video file and its metadata to the target platform.
   * Returns the platform post ID.
   */
  upload(
    config: TargetConfig,
    options: UploadOptions,
    filePath: string
  ): Promise<UploadResult>;

  /**
   * Verify connectivity and auth to the target platform.
   */
  test(config: TargetConfig): Promise<{ ok: boolean; message?: string }>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AdapterNotImplementedError extends Error {
  constructor(adapterName: string, method: string) {
    super(`${adapterName}.${method} is not implemented`);
    this.name = 'AdapterNotImplementedError';
  }
}
