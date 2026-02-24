import type { TargetAdapter, TargetConfig, UploadOptions, UploadResult } from '@mirrorr/adapter-core';
import { AdapterNotImplementedError } from '@mirrorr/adapter-core';

export class LoopsAdapter implements TargetAdapter {
  async upload(
    config: TargetConfig,
    options: UploadOptions,
    filePath: string
  ): Promise<UploadResult> {
    throw new AdapterNotImplementedError('LoopsAdapter', 'upload');
  }

  async test(config: TargetConfig): Promise<{ ok: boolean; message?: string }> {
    throw new AdapterNotImplementedError('LoopsAdapter', 'test');
  }
}

export const adapter = new LoopsAdapter();
