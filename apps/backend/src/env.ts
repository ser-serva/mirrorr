// dotenv is loaded by tsx --env-file or NODE_OPTIONS=--env-file from npm scripts.
// No runtime dotenv import needed — Node 20.6+ handles it natively.
import { z } from 'zod';

const EnvSchema = z.object({
  // ── Required secrets ──────────────────────────────────────────────────────
  ENCRYPTION_KEY: z.string().length(64, 'Must be 64 hex chars (32 bytes) — run: openssl rand -hex 32'),
  ADMIN_PASSWORD: z.string().min(12, 'Must be at least 12 chars'),
  SESSION_SECRET: z.string().min(64, 'Must be at least 64 hex chars — run: openssl rand -hex 32'),
  SESSION_SALT: z.string().length(16, 'Must be exactly 16 chars — run: openssl rand -hex 8'),

  // ── Temporal ──────────────────────────────────────────────────────────────
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE: z.string().default('mirrorr-pipeline'),
  TEMPORAL_UI_URL: z.string().url().optional(),

  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_PATH: z.string().default('./data/mirrorr.db'),

  // ── Worker concurrency ────────────────────────────────────────────────────
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(2),  MAX_CONCURRENT_DOWNLOADS: z.coerce.number().int().min(1).default(3),
  // ── TikTok auth ───────────────────────────────────────────────────────────
  TIKTOK_COOKIES_FILE: z.string().default('./data/cookies/cookies.txt'),
  FIREFOX_PROFILE_PATH: z.string().optional(),

  // ── Server ────────────────────────────────────────────────────────────────
  PORT: z.coerce.number().int().default(4001),
  HOST: z.string().default('0.0.0.0'),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  const errors = result.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\n❌  Invalid environment variables:\n${errors}\n`);
  process.exit(1);
}

export const env = result.data;
