/**
 * Creators route plugin.
 *
 * Routes implemented here:
 *   POST   /api/creators              — register a creator (FR-001)
 *   GET    /api/creators              — list all creators (FR-002)
 *   PATCH  /api/creators/:id          — update creator fields (FR-003 enablement)
 *   POST   /api/creators/:id/sync     — manually trigger discovery (FR-003)
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { getTemporalClient } from '../temporal/client.js';
import { env } from '../env.js';

export const creatorsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {};
    routeOptions.schema.tags ??= ['creators'];
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // ── POST /creators ──────────────────────────────────────────────────────────

  f.post(
    '/creators',
    {
      schema: {
        body: z.object({
          handle: z.string().min(1),
          sourceId: z.number().int().positive(),
          targetId: z.number().int().positive(),
          pollIntervalMs: z.number().int().positive().optional(),
          maxBacklog: z.number().int().positive().optional(),
          initialSyncWindowDays: z.number().int().positive().optional(),
        }),
      },
    },
    async (req, reply) => {
      try {
        const [creator] = await fastify.db
          .insert(schema.creators)
          .values({
            handle: req.body.handle,
            sourceId: req.body.sourceId,
            targetId: req.body.targetId,
            enabled: true,
            pollIntervalMs: req.body.pollIntervalMs ?? null,
            maxBacklog: req.body.maxBacklog ?? null,
            initialSyncWindowDays: req.body.initialSyncWindowDays ?? 3,
          })
          .returning();
        return reply.code(201).send(creator);
      } catch (err: unknown) {
        if (isUniqueConstraintError(err)) {
          const [existing] = await fastify.db
            .select()
            .from(schema.creators)
            .where(
              and(
                eq(schema.creators.handle, req.body.handle),
                eq(schema.creators.sourceId, req.body.sourceId),
              ),
            )
            .limit(1);
          return reply.code(409).send({
            error: 'Creator already exists with this handle and source',
            creator: existing,
          });
        }
        throw err;
      }
    },
  );

  // ── GET /creators ───────────────────────────────────────────────────────────

  f.get('/creators', async (_req, reply) => {
    const items = await fastify.db.select().from(schema.creators);
    return reply.send({ items });
  });

  // ── PATCH /creators/:id ─────────────────────────────────────────────────────

  f.patch(
    '/creators/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z.object({
          enabled: z.boolean().optional(),
          initialSyncWindowDays: z.number().int().min(1).optional(),
        }),
      },
    },
    async (req, reply) => {
      const [updated] = await fastify.db
        .update(schema.creators)
        .set(req.body)
        .where(eq(schema.creators.id, req.params.id))
        .returning();

      if (!updated) {
        return reply.code(404).send({ error: 'Creator not found' });
      }
      return reply.send(updated);
    },
  );

  // ── POST /creators/:id/sync ─────────────────────────────────────────────────

  f.post(
    '/creators/:id/sync',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const [creator] = await fastify.db
        .select()
        .from(schema.creators)
        .where(eq(schema.creators.id, req.params.id));

      if (!creator) {
        return reply.code(404).send({ error: 'Creator not found' });
      }

      if (!creator.enabled) {
        return reply.code(400).send({ error: 'Creator is disabled' });
      }

      const workflowId = `discover-creator-${creator.id}-manual`;
      const client = await getTemporalClient();

      // 409 if an existing manual workflow is already RUNNING
      try {
        const handle = client.workflow.getHandle(workflowId);
        const desc = await handle.describe();
        if (desc.status.name === 'RUNNING') {
          return reply
            .code(409)
            .send({ error: 'Manual sync already running for this creator' });
        }
      } catch {
        // Workflow not found / not running — proceed to start
      }

      // Start and synchronously await the result
      const result = await client.workflow.execute('discoverCreatorWorkflow', {
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowId,
        args: [{ creatorId: creator.id }],
      });

      return reply.send(result);
    },
  );

  // ── DELETE /creators/:id ────────────────────────────────────────────────────

  f.delete(
    '/creators/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const [deleted] = await fastify.db
        .delete(schema.creators)
        .where(eq(schema.creators.id, req.params.id))
        .returning();

      if (!deleted) {
        return reply.code(404).send({ error: 'Creator not found' });
      }
      return reply.code(204).send();
    },
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
}
