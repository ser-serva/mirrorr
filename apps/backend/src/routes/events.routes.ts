/**
 * Server-Sent Events (SSE) route plugin.
 *
 * Routes implemented here:
 *   GET /api/events  — persistent SSE stream with optional creatorId/event filters (FR-012, FR-013)
 *
 * Also exports:
 *   createSseFilter(opts) — pure filter factory used by tests (T027)
 */
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sseBus } from '../lib/sse-bus.js';
import {
  SSE_EVENT_NAMES,
  type SseEventName,
  type SseEventPayload,
  type VideoUpdateEvent,
  type CreatorUpdateEvent,
} from '@mirrorr/shared';

// ── Filter factory (exported for unit tests) ──────────────────────────────────

type SseFilter = (name: SseEventName, payload: SseEventPayload) => boolean;

/**
 * Returns a filter predicate that determines whether an SSE event should be
 * forwarded to a given connection. AND logic: both creatorId and event filters
 * must pass when both are set.
 */
export function createSseFilter(opts: {
  creatorId?: number;
  event?: SseEventName;
}): SseFilter {
  return (name: SseEventName, payload: SseEventPayload): boolean => {
    // event-type filter — exact match
    if (opts.event !== undefined && name !== opts.event) {
      return false;
    }

    // creatorId filter — only applies to video:update and creator:update
    if (opts.creatorId !== undefined) {
      if (name === 'video:update') {
        return (payload as VideoUpdateEvent).creatorId === opts.creatorId;
      }
      if (name === 'creator:update') {
        return (payload as CreatorUpdateEvent).id === opts.creatorId;
      }
      // stats:update and discovery:status pass through regardless of creatorId
    }

    return true;
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export const eventsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {};
    routeOptions.schema.tags ??= ['events'];
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/events',
    {
      schema: {
        querystring: z.object({
          creatorId: z.coerce.number().int().positive().optional(),
          event: z.enum(SSE_EVENT_NAMES).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { creatorId, event } = req.query;
      const filter = createSseFilter({ creatorId, event });

      // Set SSE headers
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      // Initial heartbeat comment to confirm connection
      reply.raw.write(': connected\n\n');

      const listener = (name: SseEventName, payload: SseEventPayload) => {
        if (!filter(name, payload)) return;
        reply.raw.write(`event: ${name}\ndata: ${JSON.stringify({ name, payload })}\n\n`);
      };

      sseBus.on('event', listener);

      req.socket.on('close', () => {
        sseBus.off('event', listener);
      });

      // Hijack response — Fastify won't try to finalize it
      return reply.hijack();
    },
  );
};
