import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../env.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb() {
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });

  const sqlite = new Database(env.DATABASE_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

export async function runMigrations(db: Db) {
  migrate(db as any, { migrationsFolder: './src/db/migrations' });
}

export { schema };
