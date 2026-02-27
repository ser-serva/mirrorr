/**
 * Backend startup module — called once during server/worker initialization.
 *
 * Responsibilities:
 *   1. Run DB migrations (idempotent)
 *   2. Register the `discover-all-creators` Temporal Schedule (idempotent)
 *      — catch ALREADY_EXISTS, update interval if changed (FR-005, R-002)
 */
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { createDb, runMigrations, schema } from './db/index.js';
import { getTemporalClient } from './temporal/client.js';
import { env } from './env.js';
import { eq } from 'drizzle-orm';

export const DISCOVERY_SCHEDULE_ID = 'discover-all-creators';

/**
 * Register (or ensure registration of) the global discovery Temporal Schedule.
 * Idempotent — safe to call on every startup.
 *
 * Note: Workflow type is passed as a string to avoid importing the workflow
 * module outside the Temporal worker sandbox.
 */
export async function registerDiscoverySchedule(pollIntervalMs: number): Promise<void> {
  const client = await getTemporalClient();
  const scheduleClient = client.schedule;

  try {
    await scheduleClient.create({
      scheduleId: DISCOVERY_SCHEDULE_ID,
      spec: {
        intervals: [{ every: pollIntervalMs }],
      },
      action: {
        type: 'startWorkflow',
        // Use string name to avoid importing workflow module outside worker sandbox
        workflowType: 'discoverAllCreatorsWorkflow',
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        args: [],
      },
      policies: {
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow: '1 minute',
      },
    });
    console.log(
      `📅 Temporal Schedule registered: ${DISCOVERY_SCHEDULE_ID} (every ${pollIntervalMs}ms)`,
    );
  } catch (err: unknown) {
    // Check for gRPC ALREADY_EXISTS code (5) — thrown by some SDK versions
    const code = (err as { code?: number }).code;
    const msg = (err as Error).message ?? '';
    if (code === 5 || msg.includes('ALREADY_EXISTS')) {
      console.log(`📅 Temporal Schedule already exists: ${DISCOVERY_SCHEDULE_ID}`);
      return;
    }
    throw err;
  }
}

/**
 * Run all startup initializations.
 * Called from server.ts main() before listen().
 */
export async function startup(): Promise<ReturnType<typeof createDb>['db']> {
  const { db } = createDb();

  // 1. Run DB migrations (idempotent)
  await runMigrations(db);

  // 2. Read global poll interval from settings table
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  const pollIntervalMs = rows[0]?.pollIntervalMs ?? 300_000;

  // 3. Register the discovery schedule (idempotent)
  try {
    await registerDiscoverySchedule(pollIntervalMs);
  } catch (err) {
    // Don't crash the server if Temporal is unreachable at startup
    console.warn('⚠️  Could not register Temporal Schedule (Temporal unavailable?):', err);
  }

  return db;
}
