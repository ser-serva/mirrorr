/**
 * Test helper: builds a Fastify test app with an in-memory SQLite database.
 *
 * Usage in tests:
 *   const { app, db } = await buildTestApp();
 *   await app.ready();
 *   const res = await app.inject({ method: 'POST', url: '/api/creators', ... });
 *   await app.close();
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../../src/db/schema.js';
import { buildServer } from '../../src/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createTestDb() {
  // In-memory SQLite for fast, isolated tests
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // Run migrations against the in-memory DB
  migrate(db as any, {
    migrationsFolder: resolve(__dirname, '../../src/db/migrations'),
  });

  // Return close as a function to hide BetterSqlite3.Database from the inferred
  // return type (prevents TS4058 "cannot be named" errors in declaration files).
  return { db, close: () => sqlite.close() };
}

export async function buildTestApp() {
  const { db, close: closeDb } = createTestDb();
  const app = await buildServer(db as any);
  await app.ready();

  return {
    app,
    db,
    close: async () => {
      await app.close();
      closeDb();
    },
  };
}

/**
 * Seed a minimal source + target row for use in creator tests.
 * Returns { sourceId, targetId }.
 */
export async function seedSourceAndTarget(db: ReturnType<typeof createTestDb>['db']) {
  const [source] = await db
    .insert(schema.sources)
    .values({ name: 'TikTok', type: 'tiktok', config: {}, enabled: true })
    .returning({ id: schema.sources.id });

  const [target] = await db
    .insert(schema.targets)
    .values({
      name: 'Loops',
      type: 'loops',
      url: 'http://localhost:8085',
      apiTokenEnc: 'test-token-enc',
      publicationConfig: {},
      config: {},
      isMirror: false,
      enabled: true,
    })
    .returning({ id: schema.targets.id });

  return { sourceId: source!.id, targetId: target!.id };
}
