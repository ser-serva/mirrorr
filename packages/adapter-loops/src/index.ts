import type { TargetAdapter, UploadOptions, UploadResult } from '@mirrorr/adapter-core';
import { readFile } from 'node:fs/promises';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface LoopsAdapterConfig {
  /**  Loops instance base URL (no trailing slash). */
  url: string;
  /** Plaintext token — caller decrypts before passing. */
  apiToken: string;
  /** Optional title template; supports {{creator}}, {{title}}, {{date}} tokens. */
  titleTemplate?: string;
  /** Optional description template; supports {{creator}}, {{title}}, {{date}} tokens. */
  descriptionTemplate?: string;
  /** Max file size in MB before upload is rejected (default 500). */
  maxVideoMb: number;
  /** Min file size in KB before upload is rejected (default 250). */
  minVideoKb: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderTemplate(
  template: string,
  tokens: { creator?: string; title?: string; date?: string },
): string {
  return template
    .replace(/\{\{creator\}\}/g, tokens.creator ?? '')
    .replace(/\{\{title\}\}/g, tokens.title ?? '')
    .replace(/\{\{date\}\}/g, tokens.date ?? '');
}

function prepareDescription(
  config: LoopsAdapterConfig,
  options: UploadOptions & { creator?: string },
): string {
  const today = new Date().toISOString().slice(0, 10);
  let desc: string;

  if (config.descriptionTemplate) {
    desc = renderTemplate(config.descriptionTemplate, {
      creator: options.creator,
      title: options.title,
      date: today,
    });
  } else {
    desc = options.description ?? '';
  }

  // Truncate to 2200 chars and replace newlines with spaces
  if (desc.length > 2200) {
    desc = desc.slice(0, 2200);
  }
  desc = desc.replace(/\n/g, ' ');

  return desc;
}

function extractPostId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  // Shape 1: { id: "..." }
  if (typeof b['id'] === 'string') return b['id'];

  // Shape 2 & 3: { data: { id } } or { data: [{ id }] }
  if (typeof b['data'] === 'object' && b['data'] !== null) {
    const d = b['data'] as Record<string, unknown>;
    if (typeof d['id'] === 'string') return d['id'];

    if (Array.isArray(d)) {
      const first = d[0] as Record<string, unknown> | undefined;
      if (first && typeof first['id'] === 'string') return first['id'];
    }
  }

  return null;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class LoopsAdapter implements TargetAdapter {

  // ── upload ─────────────────────────────────────────────────────────────────

  async upload(
    config: unknown,
    options: UploadOptions & { creator?: string },
    filePath: string,
  ): Promise<UploadResult> {
    const cfg = config as LoopsAdapterConfig;

    const fileBytes = await readFile(filePath);
    const blob = new Blob([fileBytes], { type: 'video/mp4' });

    const description = prepareDescription(cfg, options);

    const form = new FormData();
    form.append('video', blob, 'video.mp4');
    form.append('description', description);
    form.append('comment_state', '0');
    form.append('can_download', 'false');

    // Do NOT set Content-Type manually — let fetch set it with the correct boundary
    const response = await fetch(`${cfg.url}/api/v1/studio/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Loops upload failed with status ${response.status}: ${text}`);
    }

    const body = await response.json() as unknown;
    const postId = extractPostId(body);

    if (!postId) {
      throw new Error(
        `Loops upload succeeded (${response.status}) but response contained no post id: ${JSON.stringify(body)}`,
      );
    }

    // Attempt to extract a post URL if the response provides one
    const postUrl = (() => {
      if (typeof body !== 'object' || body === null) return undefined;
      const b = body as Record<string, unknown>;
      if (typeof b['url'] === 'string') return b['url'];
      if (typeof b['data'] === 'object' && b['data'] !== null) {
        const d = b['data'] as Record<string, unknown>;
        if (typeof d['url'] === 'string') return d['url'];
        if (Array.isArray(d) && d[0] && typeof (d[0] as Record<string, unknown>)['url'] === 'string') {
          return (d[0] as Record<string, unknown>)['url'] as string;
        }
      }
      return undefined;
    })();

    return { postId, postUrl };
  }

  // ── test ───────────────────────────────────────────────────────────────────

  async test(config: unknown): Promise<{ ok: boolean; message?: string }> {
    const cfg = config as LoopsAdapterConfig;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      let response: Response;
      try {
        response = await fetch(`${cfg.url}/api/v0/user/self`, {
          headers: { Authorization: `Bearer ${cfg.apiToken}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, message: `HTTP ${response.status}: ${text}` };
      }

      const body = await response.json() as unknown;
      const data = (body as Record<string, unknown>)?.['data'] as Record<string, unknown> | undefined;
      const username = (data?.['username'] ?? data?.['display_name'] ?? 'unknown') as string;

      return { ok: true, message: `Connected as ${username}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
  }

  // ── provisionMirrorAccount ─────────────────────────────────────────────────

  async provisionMirrorAccount(
    config: unknown,
    handle: string,
    sourceType: string,
  ): Promise<{ mirrorToken: string; mirrorUsername: string }> {
    const cfg = config as LoopsAdapterConfig;

    const mirrorUsername = generateUsername(handle, sourceType);

    const response = await fetch(`${cfg.url}/api/v1/admin/users/manage-mirror`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: mirrorUsername,
        display_name: handle.replace(/^@/, ''),
        admin_note: 'mirror account provisioned via API',
      }),
    });

    if (response.status === 404) {
      throw new Error('Loops instance does not support mirror provisioning');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Admin token lacks provisioning privileges');
    }

    const body = await response.json() as unknown;

    if (response.status === 422) {
      const errors = (body as Record<string, unknown>)?.['errors'] as Record<string, unknown> | undefined;
      if (errors) {
        const firstMessage = Object.values(errors)[0];
        const msg = Array.isArray(firstMessage) ? firstMessage[0] : firstMessage;
        throw new Error(String(msg ?? 'username already taken'));
      }
      throw new Error('Provisioning validation error (422)');
    }

    if (!response.ok) {
      throw new Error(`Provisioning failed with status ${response.status}`);
    }

    // Extract token — try primary shape, fall back to legacy
    const data = (body as Record<string, unknown>)?.['data'] as Record<string, unknown> | undefined;
    const user = data?.['user'] as Record<string, unknown> | undefined;
    const mirrorToken = (user?.['api_token'] ?? data?.['token']) as string | undefined;

    if (!mirrorToken) {
      throw new Error('Provisioning succeeded but no token was returned in response');
    }

    return { mirrorToken, mirrorUsername };
  }
}

// ─── Username generation ───────────────────────────────────────────────────────

export function generateUsername(handle: string, sourceType: string): string {
  // Strip leading @ and replace invalid chars
  const clean = handle.replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  // Max 24 chars total including the dot and sourceType suffix
  const maxHandleLen = 24 - 1 - sourceType.length;
  return `${clean.slice(0, maxHandleLen)}.${sourceType}`;
}

export const adapter = new LoopsAdapter();
