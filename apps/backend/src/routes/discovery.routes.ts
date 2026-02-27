/**
 * Discovery control route plugin.
 *
 * Routes implemented here:
 *   POST /api/discovery/pause    — pause the global Temporal Schedule (FR-014)
 *   POST /api/discovery/resume   — resume the global Temporal Schedule (FR-015)
 *   GET  /api/discovery/status   — return current schedule state (FR-015)
 */
import type { FastifyPluginAsync } from 'fastify';
import { getTemporalClient } from '../temporal/client.js';
import { DISCOVERY_SCHEDULE_ID } from '../index.js';
import { emitSseEvent } from '../lib/sse-bus.js';

export const discoveryPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {};
    routeOptions.schema.tags ??= ['discovery'];
  });

  // ── POST /discovery/pause ────────────────────────────────────────────────────

  fastify.post('/discovery/pause', async (_req, reply) => {
    const client = await getTemporalClient();
    const handle = client.schedule.getHandle(DISCOVERY_SCHEDULE_ID);
    await handle.pause('Paused via API');
    emitSseEvent('discovery:status', { paused: true, nextRunAt: null });
    return reply.send({ paused: true });
  });

  // ── POST /discovery/resume ───────────────────────────────────────────────────

  fastify.post('/discovery/resume', async (_req, reply) => {
    const client = await getTemporalClient();
    const handle = client.schedule.getHandle(DISCOVERY_SCHEDULE_ID);
    await handle.unpause();
    const desc = await handle.describe();
    const nextActionTime = desc.info.nextActionTimes?.[0];
    const nextRunAt = nextActionTime
      ? nextActionTime instanceof Date
        ? nextActionTime.toISOString()
        : String(nextActionTime)
      : null;
    emitSseEvent('discovery:status', { paused: false, nextRunAt });
    return reply.send({ paused: false });
  });

  // ── GET /discovery/status ────────────────────────────────────────────────────

  fastify.get('/discovery/status', async (_req, reply) => {
    try {
      const client = await getTemporalClient();
      const handle = client.schedule.getHandle(DISCOVERY_SCHEDULE_ID);
      const desc = await handle.describe();
      // SDK v1.15: describe() returns { state, info, ... } directly — not desc.schedule.state
      const paused = (desc as unknown as { state?: { paused?: boolean } }).state?.paused ?? false;
      const nextActionTime = desc.info.nextActionTimes?.[0];
      // When paused, Temporal still reports nextActionTimes but the schedule won't fire.
      // Return null to match spec: { paused: true, nextRunAt: null }.
      const nextRunAt = paused
        ? null
        : nextActionTime
          ? nextActionTime instanceof Date
            ? nextActionTime.toISOString()
            : String(nextActionTime)
          : null;
      return reply.send({ paused, nextRunAt, status: 'registered' });
    } catch (err: unknown) {
      if (isScheduleNotFoundError(err)) {
        return reply.send({ paused: false, nextRunAt: null, status: 'not_registered' });
      }
      throw err;
    }
  });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isScheduleNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const msg = String((err as Error).message ?? '');
  const type = String((err as { type?: string }).type ?? '');
  return (
    type === 'ScheduleNotFoundError' ||
    msg.toLowerCase().includes('schedule not found') ||
    msg.includes('SCHEDULE_NOT_FOUND') ||
    // gRPC NOT_FOUND
    (err as { code?: number }).code === 5
  );
}
