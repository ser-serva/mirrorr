/**
 * Sources route plugin.
 *
 * Routes:
 *   GET    /api/sources              — list all sources
 *   POST   /api/sources              — create a source (201)
 *   PATCH  /api/sources/:id          — update source fields (200 / 404)
 *   DELETE /api/sources/:id          — delete source (204 / 404)
 *   POST   /api/sources/:id/test     — test VPN + yt-dlp auth (200 / 404 / 502)
 *                                      (implemented in T014)
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

// ── Strict config schema — rejects unknown fields ─────────────────────────────

const TikTokSourceConfigSchema = z
  .object({
    discoveryPlaylistLimit: z.number().int().positive().optional(),
    discoveryMaxAgeDays: z.number().int().positive().optional(),
    maxConcurrentDownloads: z.number().int().positive().optional(),
    cookiesFile: z.string().optional(),
    firefoxProfilePath: z.string().optional(),
  })
  .strict();

// ── Plugin ────────────────────────────────────────────────────────────────────

export const sourcesPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {};
    routeOptions.schema.tags ??= ['sources'];
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // ── GET /sources ────────────────────────────────────────────────────────────

  f.get('/sources', async (_req, reply) => {
    const items = await fastify.db.select().from(schema.sources);
    return reply.send({ items });
  });

  // ── POST /sources ───────────────────────────────────────────────────────────

  f.post(
    '/sources',
    {
      schema: {
        body: z.object({
          name: z.string().min(1),
          type: z.enum(['tiktok', 'instagram', 'youtube_shorts']),
          config: TikTokSourceConfigSchema.optional().default({}),
          enabled: z.boolean().optional().default(true),
        }),
      },
    },
    async (req, reply) => {
      const [created] = await fastify.db
        .insert(schema.sources)
        .values({
          name: req.body.name,
          type: req.body.type,
          config: req.body.config as schema.TikTokSourceConfig,
          enabled: req.body.enabled,
        })
        .returning();
      return reply.code(201).send(created);
    },
  );

  // ── PATCH /sources/:id ──────────────────────────────────────────────────────

  f.patch(
    '/sources/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z.object({
          name: z.string().min(1).optional(),
          enabled: z.boolean().optional(),
          config: TikTokSourceConfigSchema.optional(),
        }),
      },
    },
    async (req, reply) => {
      const updates: Partial<typeof schema.sources.$inferInsert> = {};
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      if (req.body.config !== undefined)
        updates.config = req.body.config as schema.TikTokSourceConfig;

      const [updated] = await fastify.db
        .update(schema.sources)
        .set(updates)
        .where(eq(schema.sources.id, req.params.id))
        .returning();

      if (!updated) {
        return reply.code(404).send({ error: 'Source not found' });
      }
      return reply.send(updated);
    },
  );

  // ── DELETE /sources/:id ─────────────────────────────────────────────────────

  f.delete(
    '/sources/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const [deleted] = await fastify.db
        .delete(schema.sources)
        .where(eq(schema.sources.id, req.params.id))
        .returning({ id: schema.sources.id });

      if (!deleted) {
        return reply.code(404).send({ error: 'Source not found' });
      }
      return reply.code(204).send();
    },
  );

  // ── POST /sources/:id/test (T014) ────────────────────────────────────────────

  f.post(
    '/sources/:id/test',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const [source] = await fastify.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, req.params.id))
        .limit(1);

      if (!source) {
        return reply.code(404).send({ error: 'Source not found' });
      }

      try {
        const { TiktokAdapter } = await import('@mirrorr/adapter-tiktok');
        const tiktokAdapter = new TiktokAdapter();
        const result = await tiktokAdapter.test(source.config);
        return reply.send(result);
      } catch (err) {
        // VPN fetch failure bubbles up as a network error → 502
        return reply.code(502).send({
          error: 'VPN or network check failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
};
