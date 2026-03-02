/**
 * Creators route plugin.
 *
 * Routes implemented here:
 *   POST   /api/creators              — register a creator (FR-001) + mirror provisioning (US3)
 *   GET    /api/creators              — list all creators (FR-002)
 *   PATCH  /api/creators/:id          — update creator fields; provision or assign mirror target
 *   POST   /api/creators/:id/sync     — manually trigger discovery (FR-003)
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { getTemporalClient } from '../temporal/client.js';
import { env } from '../env.js';
import { decrypt, encrypt } from '../lib/crypto.js';

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
          mirrorTargetId: z.number().int().positive().optional(),
          pollIntervalMs: z.number().int().positive().optional(),
          maxBacklog: z.number().int().positive().optional(),
          initialSyncWindowDays: z.number().int().positive().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { handle, sourceId, targetId, mirrorTargetId: bodyMirrorTargetId } = req.body;

      // ── (0) Pre-flight: check if creator already exists with mirrorTargetId ──
      const [existingCreator] = await fastify.db
        .select()
        .from(schema.creators)
        .where(
          and(
            eq(schema.creators.handle, handle),
            eq(schema.creators.sourceId, sourceId),
          ),
        )
        .limit(1);

      if (existingCreator) {
        if (existingCreator.mirrorTargetId != null) {
          return reply.code(409).send({
            error: 'Creator already exists with a mirror target',
            creator: existingCreator,
          });
        }
        return reply.code(409).send({
          error: 'Creator already exists with this handle and source',
          creator: existingCreator,
        });
      }

      // ── (1) body.mirrorTargetId supplied → skip provisioning ─────────────────
      if (bodyMirrorTargetId != null) {
        const [creator] = await fastify.db
          .insert(schema.creators)
          .values({
            handle,
            sourceId,
            targetId,
            mirrorTargetId: bodyMirrorTargetId,
            enabled: true,
            pollIntervalMs: req.body.pollIntervalMs ?? null,
            maxBacklog: req.body.maxBacklog ?? null,
            initialSyncWindowDays: req.body.initialSyncWindowDays ?? 3,
          })
          .returning();
        return reply.code(201).send(creator);
      }

      // ── (2) Provision a new mirror account ───────────────────────────────────

      // Load parent target (admin Loops config)
      const [parentTarget] = await fastify.db
        .select()
        .from(schema.targets)
        .where(eq(schema.targets.id, targetId));

      if (!parentTarget) {
        return reply.code(422).send({ error: `Target ${targetId} not found` });
      }

      // Load source to obtain sourceType
      const [source] = await fastify.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId));

      if (!source) {
        return reply.code(422).send({ error: `Source ${sourceId} not found` });
      }

      let adminToken: string;
      try {
        adminToken = decrypt(parentTarget.apiTokenEnc);
      } catch {
        return reply.code(500).send({ error: 'Failed to decrypt admin target token' });
      }

      const adapterConfig = {
        url: parentTarget.url,
        apiToken: adminToken,
        maxVideoMb: parentTarget.config?.maxVideoMb ?? 500,
        minVideoKb: parentTarget.config?.minVideoKb ?? 250,
      };

      // Call provisionMirrorAccount
      let mirrorToken: string;
      let mirrorUsername: string;
      try {
        const { LoopsAdapter } = await import('@mirrorr/adapter-loops');
        const adapter = new LoopsAdapter();
        const result = await adapter.provisionMirrorAccount!(adapterConfig, handle, source.type);
        mirrorToken = result.mirrorToken;
        mirrorUsername = result.mirrorUsername;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // "username already taken" and similar provisioning errors → 422
        if (msg.toLowerCase().includes('username already taken') ||
            msg.toLowerCase().includes('provisioning')) {
          return reply.code(422).send({ error: msg });
        }
        return reply.code(500).send({ error: `Provisioning failed: ${msg}` });
      }

      // ── (3) Insert mirror target + creator (sequential — provisioning already
      //       committed at this point, so any DB error will 500 the request) ────

      // Insert mirror target row (isMirror=true)
      const [mirrorTarget] = await fastify.db
        .insert(schema.targets)
        .values({
          name: `${handle} mirror`,
          type: 'loops',
          url: parentTarget.url,
          apiTokenEnc: encrypt(mirrorToken),
          publicationConfig: parentTarget.publicationConfig ?? {},
          config: parentTarget.config as schema.LoopsTargetConfig,
          isMirror: true,
          enabled: true,
        })
        .returning();

      // Insert creator row with mirrorTargetId
      const [newCreator] = await fastify.db
        .insert(schema.creators)
        .values({
          handle,
          sourceId,
          targetId,
          mirrorTargetId: mirrorTarget!.id,
          enabled: true,
          pollIntervalMs: req.body.pollIntervalMs ?? null,
          maxBacklog: req.body.maxBacklog ?? null,
          initialSyncWindowDays: req.body.initialSyncWindowDays ?? 3,
        })
        .returning();

      return reply.code(201).send(newCreator);
    },
  );

  // ── GET /creators ───────────────────────────────────────────────────────────

  f.get('/creators', async (_req, reply) => {
    const items = await fastify.db.select().from(schema.creators);
    return reply.send({ items });
  });

  // ── PATCH /creators/:id ─────────────────────────────────────────────────────
  //
  // Standard fields: enabled, initialSyncWindowDays, maxBacklog
  //
  // Mirror provisioning / assignment:
  //   • targetId (without mirrorTargetId) → provision a new mirror account via the
  //     Loops adapter and store the resulting mirror target row. Only allowed when
  //     the creator currently has mirrorTargetId = null.
  //   • mirrorTargetId (without targetId) → directly assign an existing target row
  //     as the creator's mirror target (e.g. re-point after manual setup).

  f.patch(
    '/creators/:id',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z.object({
          enabled: z.boolean().optional(),
          initialSyncWindowDays: z.number().int().min(1).optional(),
          maxBacklog: z.number().int().positive().optional(),
          // Mirror provisioning: supply targetId to run provisionMirrorAccount
          targetId: z.number().int().positive().optional(),
          // Mirror direct assignment: supply mirrorTargetId to link an existing target
          mirrorTargetId: z.number().int().positive().optional(),
        }).refine(
          (b) => !(b.targetId != null && b.mirrorTargetId != null),
          { message: 'Provide either targetId (provision) or mirrorTargetId (assign), not both' },
        ),
      },
    },
    async (req, reply) => {
      const creatorId = req.params.id;
      const { targetId, mirrorTargetId, ...scalarFields } = req.body;

      // Load the creator first (needed for provisioning path and 404 check)
      const [creator] = await fastify.db
        .select()
        .from(schema.creators)
        .where(eq(schema.creators.id, creatorId));

      if (!creator) {
        return reply.code(404).send({ error: 'Creator not found' });
      }

      // ── Path A: provision a new mirror account ──────────────────────────────
      if (targetId != null) {
        if (creator.mirrorTargetId != null) {
          return reply.code(409).send({
            error: 'Creator already has a mirror target',
            mirrorTargetId: creator.mirrorTargetId,
          });
        }

        const [parentTarget] = await fastify.db
          .select()
          .from(schema.targets)
          .where(eq(schema.targets.id, targetId));

        if (!parentTarget) {
          return reply.code(422).send({ error: `Target ${targetId} not found` });
        }

        const [source] = await fastify.db
          .select()
          .from(schema.sources)
          .where(eq(schema.sources.id, creator.sourceId));

        if (!source) {
          return reply.code(422).send({ error: `Source ${creator.sourceId} not found` });
        }

        let adminToken: string;
        try {
          adminToken = decrypt(parentTarget.apiTokenEnc);
        } catch {
          return reply.code(500).send({ error: 'Failed to decrypt admin target token' });
        }

        const adapterConfig = {
          url: parentTarget.url,
          apiToken: adminToken,
          maxVideoMb: parentTarget.config?.maxVideoMb ?? 500,
          minVideoKb: parentTarget.config?.minVideoKb ?? 250,
        };

        let mirrorToken: string;
        let mirrorUsername: string;
        try {
          const { LoopsAdapter } = await import('@mirrorr/adapter-loops');
          const adapter = new LoopsAdapter();
          const result = await adapter.provisionMirrorAccount!(adapterConfig, creator.handle, source.type);
          mirrorToken = result.mirrorToken;
          mirrorUsername = result.mirrorUsername;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.toLowerCase().includes('username already taken') ||
              msg.toLowerCase().includes('provisioning')) {
            return reply.code(422).send({ error: msg });
          }
          return reply.code(500).send({ error: `Provisioning failed: ${msg}` });
        }

        void mirrorUsername;

        const [mirrorTarget] = await fastify.db
          .insert(schema.targets)
          .values({
            name: `${creator.handle} mirror`,
            type: 'loops',
            url: parentTarget.url,
            apiTokenEnc: encrypt(mirrorToken),
            publicationConfig: parentTarget.publicationConfig ?? {},
            config: parentTarget.config as schema.LoopsTargetConfig,
            isMirror: true,
            enabled: true,
          })
          .returning();

        const [updated] = await fastify.db
          .update(schema.creators)
          .set({ ...scalarFields, targetId, mirrorTargetId: mirrorTarget!.id })
          .where(eq(schema.creators.id, creatorId))
          .returning();

        return reply.send(updated);
      }

      // ── Path B: directly assign an existing mirror target ───────────────────
      if (mirrorTargetId != null) {
        const [mirrorTarget] = await fastify.db
          .select()
          .from(schema.targets)
          .where(eq(schema.targets.id, mirrorTargetId));

        if (!mirrorTarget) {
          return reply.code(422).send({ error: `Target ${mirrorTargetId} not found` });
        }

        const [updated] = await fastify.db
          .update(schema.creators)
          .set({ ...scalarFields, mirrorTargetId })
          .where(eq(schema.creators.id, creatorId))
          .returning();

        return reply.send(updated);
      }

      // ── Path C: scalar-only update ──────────────────────────────────────────
      const [updated] = await fastify.db
        .update(schema.creators)
        .set(scalarFields)
        .where(eq(schema.creators.id, creatorId))
        .returning();

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
