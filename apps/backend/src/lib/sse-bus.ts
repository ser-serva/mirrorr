/**
 * Module-level EventEmitter singleton that bridges activity writes to SSE connections.
 *
 * Activities emit typed events via `emitSseEvent`; each open SSE connection
 * subscribes to `sseBus` and applies its own per-connection filter function.
 *
 * Max listeners is raised to 500 to support many concurrent SSE connections
 * without Node.js emitting "MaxListenersExceededWarning".
 */
import { EventEmitter } from 'node:events';
import type { SseEventName, SseEventPayload } from '@mirrorr/shared';

// Internal bus event name — all SSE frames flow through a single 'event' key
const BUS_EVENT = 'event';

// ── Typed EventEmitter interface ──────────────────────────────────────────────

interface SseBusEvents {
  [BUS_EVENT]: (name: SseEventName, payload: SseEventPayload) => void;
}

class SseBus extends EventEmitter {
  override emit(event: typeof BUS_EVENT, name: SseEventName, payload: SseEventPayload): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on(event: typeof BUS_EVENT, listener: SseBusEvents[typeof BUS_EVENT]): this;
  override on(event: string, listener: (...args: unknown[]) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override off(event: typeof BUS_EVENT, listener: SseBusEvents[typeof BUS_EVENT]): this;
  override off(event: string, listener: (...args: unknown[]) => void): this;
  override off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}

export const sseBus = new SseBus();
sseBus.setMaxListeners(500);

/**
 * Emit a typed SSE event onto the bus.
 *
 * All active SSE connections receive this event and apply their own filter.
 */
export function emitSseEvent(name: SseEventName, payload: SseEventPayload): void {
  sseBus.emit(BUS_EVENT, name, payload);
}

/**
 * Subscribe to bus events. Returns a cleanup function that removes the listener.
 */
export function subscribeSse(
  listener: (name: SseEventName, payload: SseEventPayload) => void,
): () => void {
  sseBus.on(BUS_EVENT, listener);
  return () => sseBus.off(BUS_EVENT, listener);
}

export { BUS_EVENT };
