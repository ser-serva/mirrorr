/**
 * T027 🔴 TDD-RED: SSE per-connection filter logic unit tests.
 *
 * Tests MUST FAIL before filter function implementation (T028).
 * Run: pnpm --filter backend test tests/unit/sse-filter.test.ts
 *
 * Covers (per research.md R-004 filter logic):
 *   - No filter → delivers all event types
 *   - creatorId filter passes creator:update with matching id
 *   - creatorId filter blocks creator:update with mismatched id
 *   - creatorId filter passes video:update with matching creatorId
 *   - creatorId filter blocks video:update with mismatched creatorId
 *   - event filter passes only matching event name
 *   - AND logic when both params set
 *   - stats:update is NOT filtered by creatorId (always delivered)
 *   - discovery:status is NOT filtered by creatorId (always delivered)
 */
import { describe, it, expect } from 'vitest';
import { createSseFilter } from '../../src/routes/events.routes.js';

describe('createSseFilter', () => {
  it('no filter — passes all event types', () => {
    const filter = createSseFilter({});

    expect(filter('video:update', { id: 1, creatorId: 5, stage: 'DOWNLOAD_QUEUED', stageUpdatedAt: '' })).toBe(true);
    expect(filter('creator:update', { id: 1, lastDiscoveredAt: null })).toBe(true);
    expect(filter('stats:update', { videos: {} as any, lastDiscoveredAt: null })).toBe(true);
    expect(filter('discovery:status', { paused: false, nextRunAt: null })).toBe(true);
  });

  it('creatorId filter — passes creator:update with matching id', () => {
    const filter = createSseFilter({ creatorId: 5 });

    expect(filter('creator:update', { id: 5, lastDiscoveredAt: null })).toBe(true);
  });

  it('creatorId filter — blocks creator:update with different id', () => {
    const filter = createSseFilter({ creatorId: 5 });

    expect(filter('creator:update', { id: 99, lastDiscoveredAt: null })).toBe(false);
  });

  it('creatorId filter — passes video:update with matching creatorId', () => {
    const filter = createSseFilter({ creatorId: 5 });

    expect(filter('video:update', { id: 1, creatorId: 5, stage: 'DOWNLOAD_QUEUED', stageUpdatedAt: '' })).toBe(true);
  });

  it('creatorId filter — blocks video:update with different creatorId', () => {
    const filter = createSseFilter({ creatorId: 5 });

    expect(filter('video:update', { id: 1, creatorId: 99, stage: 'DOWNLOAD_QUEUED', stageUpdatedAt: '' })).toBe(false);
  });

  it('creatorId filter — stats:update always passes (not filtered by creatorId)', () => {
    const filter = createSseFilter({ creatorId: 5 });

    expect(filter('stats:update', { videos: {} as any, lastDiscoveredAt: null })).toBe(true);
  });

  it('creatorId filter — discovery:status always passes (not filtered by creatorId)', () => {
    const filter = createSseFilter({ creatorId: 5 });

    expect(filter('discovery:status', { paused: false, nextRunAt: null })).toBe(true);
  });

  it('event filter — passes only the matching event name', () => {
    const filter = createSseFilter({ event: 'stats:update' });

    expect(filter('stats:update', { videos: {} as any, lastDiscoveredAt: null })).toBe(true);
    expect(filter('video:update', { id: 1, creatorId: 1, stage: 'DOWNLOAD_QUEUED', stageUpdatedAt: '' })).toBe(false);
    expect(filter('creator:update', { id: 1, lastDiscoveredAt: null })).toBe(false);
    expect(filter('discovery:status', { paused: false, nextRunAt: null })).toBe(false);
  });

  it('AND logic — both creatorId AND event filter must pass', () => {
    const filter = createSseFilter({ creatorId: 5, event: 'video:update' });

    // Matching both
    expect(filter('video:update', { id: 1, creatorId: 5, stage: 'DOWNLOAD_QUEUED', stageUpdatedAt: '' })).toBe(true);

    // Wrong event type
    expect(filter('creator:update', { id: 5, lastDiscoveredAt: null })).toBe(false);

    // Wrong creatorId
    expect(filter('video:update', { id: 1, creatorId: 99, stage: 'DOWNLOAD_QUEUED', stageUpdatedAt: '' })).toBe(false);
  });
});
