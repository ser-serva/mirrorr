/**
 * Fastify type augmentation — adds typed decorators for shared resources.
 *
 * Import this file anywhere that accesses `fastify.db` to get proper typing.
 */
import type { Db } from '../db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Drizzle ORM database instance — attached by buildServer() */
    db: Db;
  }
}
