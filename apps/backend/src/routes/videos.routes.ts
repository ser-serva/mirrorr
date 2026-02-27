/**
 * Videos route plugin.
 *
 * Routes implemented here:
 *   GET /api/videos   — list videos with cursor pagination + optional filters (FR-004)
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import { and, eq, gt, count } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export const videosPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {};
    routeOptions.schema.tags ??= ['videos'];
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // ── GET /videos ─────────────────────────────────────────────────────────────

  f.get(
    '/videos',
    {
      schema: {
        querystring: z.object({
          creatorId: z.coerce.number().int().positive().optional(),
          stage: z.string().optional(),
          cursor: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req, reply) => {
      const { creatorId, stage, cursor, limit } = req.query;

      const conditions: SQL[] = [];
      if (creatorId !== undefined) {
        conditions.push(eq(schema.videos.creatorId, creatorId));
      }
      if (stage !== undefined) {
        conditions.push(eq(schema.videos.stage, stage as schema.VideoStage));
      }
      if (cursor !== undefined) {
        conditions.push(gt(schema.videos.id, cursor));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, totalRows] = await Promise.all([
        fastify.db
          .select()
          .from(schema.videos)
          .where(whereClause)
          .limit(limit),
        fastify.db
          .select({ value: count() })
          .from(schema.videos)
          .where(whereClause),
      ]);

      const total = totalRows[0]?.value ?? 0;
      const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;

      return reply.send({ items, total, nextCursor });
    },
  );
};
