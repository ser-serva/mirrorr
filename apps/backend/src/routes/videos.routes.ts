/**
 * Videos route plugin.
 *
 * Routes implemented here:
 *   GET  /api/videos        — list videos with cursor pagination + optional filters (FR-004)
 *   POST /api/videos/:id/retry — reset a stuck/failed video back to DOWNLOAD_QUEUED and
 *                                terminate + restart its Temporal workflow
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import { and, eq, gt, count } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getTemporalClient } from '../temporal/client.js';
import { env } from '../env.js';

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

  // ── POST /videos/:id/retry ──────────────────────────────────────────────────
  //
  // Terminates any existing Temporal workflow for the video, resets the stage
  // to DOWNLOAD_QUEUED, and starts a fresh videoPipelineWorkflow.
  // Safe to call on any non-terminal stage (DOWNLOAD_QUEUED is a no-op restart).
  // Returns 409 if the video has already succeeded (UPLOAD_SUCCEEDED / ARCHIVE_SUCCEEDED).

  f.post(
    '/videos/:id/retry',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const [video] = await fastify.db
        .select()
        .from(schema.videos)
        .where(eq(schema.videos.id, req.params.id));

      if (!video) {
        return reply.code(404).send({ error: 'Video not found' });
      }

      const alreadyDoneStages: schema.VideoStage[] = ['UPLOAD_SUCCEEDED', 'ARCHIVE_SUCCEEDED'];
      if (alreadyDoneStages.includes(video.stage)) {
        return reply.code(409).send({
          error: `Video already completed successfully (stage: ${video.stage})`,
        });
      }

      const client = await getTemporalClient();

      // Terminate any workflow that may still be running / stuck
      if (video.temporalWorkflowId) {
        try {
          await client.workflow
            .getHandle(video.temporalWorkflowId)
            .terminate('retry requested via API');
        } catch {
          // Workflow not found or already completed — fine, continue
        }
      }

      // Reset stage
      await fastify.db
        .update(schema.videos)
        .set({
          stage: 'DOWNLOAD_QUEUED',
          stageUpdatedAt: new Date(),
          temporalWorkflowId: null,
          transcodeDecision: null,
        })
        .where(eq(schema.videos.id, video.id));

      // Start a fresh workflow with a unique ID so there's no ID conflict
      const workflowId = `video-${video.id}-retry-${Date.now()}`;
      await client.workflow.start('videoPipelineWorkflow', {
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowId,
        args: [{
          videoId: video.id,
          retentionDays: 0,
          sourcePubAtMs: video.sourcePubAt?.getTime() ?? null,
        }],
      });

      // Persist the new workflow ID
      const [updated] = await fastify.db
        .update(schema.videos)
        .set({ temporalWorkflowId: workflowId })
        .where(eq(schema.videos.id, video.id))
        .returning();

      return reply.code(202).send(updated);
    },
  );
};
