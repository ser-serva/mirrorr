/**
 * Vitest global setup — runs before any test file is loaded.
 *
 * Sets minimal environment variables so env.ts validation passes in test mode.
 * These are test-only values with no real secrets.
 */

// ── Required secrets ──────────────────────────────────────────────────────────
process.env['ENCRYPTION_KEY'] ??= 'a'.repeat(64); // 64 hex chars (all 'a') — test only
process.env['ADMIN_PASSWORD'] ??= 'test-admin-password-123'; // ≥12 chars
process.env['SESSION_SECRET'] ??= 'b'.repeat(64); // ≥64 chars
process.env['SESSION_SALT'] ??= 'c'.repeat(16);   // exactly 16 chars

// ── Optional overrides ────────────────────────────────────────────────────────
process.env['DATABASE_PATH'] ??= ':memory:'; // default; test-app.ts overrides with in-memory DB
process.env['TEMPORAL_ADDRESS'] ??= 'localhost:7233';
process.env['TEMPORAL_NAMESPACE'] ??= 'default';
process.env['TEMPORAL_TASK_QUEUE'] ??= 'mirrorr-pipeline';
