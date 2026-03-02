/**
 * Targets route plugin.
 *
 * Routes implemented here:
 *   POST   /api/targets              — register a target (T014b)
 *   POST   /api/targets/:id/test     — test connectivity (T014)
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '../lib/crypto.js';

export const targetsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {};
    routeOptions.schema.tags ??= ['targets'];
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // ── POST /targets ───────────────────────────────────────────────────────────

  f.post(
    '/targets',
    {
      schema: {
        body: z.object({
          name: z.string().min(1),
          type: z.enum(['loops']),
          url: z.string().url(),
          apiToken: z.string().min(1),
          config: z.record(z.unknown()).optional(),
          publicationConfig: z.object({
            titleTemplate: z.string().optional(),
            descriptionTemplate: z.string().optional(),
          }).optional(),
        }),
      },
    },
    async (req, reply) => {
      const apiTokenEnc = encrypt(req.body.apiToken);

      const [target] = await fastify.db
        .insert(schema.targets)
        .values({
          name: req.body.name,
          type: req.body.type,
          url: req.body.url.replace(/\/$/, ''), // strip trailing slash
          apiTokenEnc,
          publicationConfig: req.body.publicationConfig ?? {},
          config: (req.body.config ?? {}) as schema.LoopsTargetConfig,
          isMirror: false,
          enabled: true,
        })
        .returning();

      // Return target row excluding the encrypted token
      const { apiTokenEnc: _hidden, ...rest } = target!;
      void _hidden;
      return reply.code(201).send(rest);
    },
  );

  // ── POST /targets/:id/test ──────────────────────────────────────────────────

  f.post(
    '/targets/:id/test',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const [target] = await fastify.db
        .select()
        .from(schema.targets)
        .where(eq(schema.targets.id, req.params.id));

      if (!target) {
        return reply.code(404).send({ error: 'Target not found' });
      }

      let plainToken: string;
      try {
        plainToken = decrypt(target.apiTokenEnc);
      } catch {
        return reply.code(500).send({ error: 'Failed to decrypt target token' });
      }

      const { LoopsAdapter } = await import('@mirrorr/adapter-loops');
      const adapter = new LoopsAdapter();

      const config = {
        url: target.url,
        apiToken: plainToken,
        maxVideoMb: target.config?.maxVideoMb ?? 500,
        minVideoKb: target.config?.minVideoKb ?? 250,
      };

      const result = await adapter.test(config);

      // Update last tested metadata
      await fastify.db
        .update(schema.targets)
        .set({ lastTestedAt: new Date(), lastTestOk: result.ok })
        .where(eq(schema.targets.id, req.params.id));

      return reply.send(result);
    },
  );
};
