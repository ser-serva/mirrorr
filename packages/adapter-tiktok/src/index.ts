import type { SourceAdapter, VideoMetadata, DiscoveryFailure } from '@mirrorr/adapter-core';

export class TiktokAdapter implements SourceAdapter {
  async discover(
    config: unknown,
    ctx: { handle: string; maxBacklog?: number }
  ): Promise<{ videos: VideoMetadata[]; failures: DiscoveryFailure[] }> {
    throw new Error('TiktokAdapter.discover not implemented');
  }

  async download(config: unknown, url: string, destDir: string): Promise<string> {
    throw new Error('TiktokAdapter.download not implemented');
  }

  async fetchMeta(config: unknown, url: string): Promise<VideoMetadata> {
    throw new Error('TiktokAdapter.fetchMeta not implemented');
  }
}

export const adapter = new TiktokAdapter();
