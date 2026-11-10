// FR-R6-F07 (FR-014) — per-subscription live-log counters.
//
// Each counter is an integer that saturates at LIVE_LOG_COUNTER_MAX, so a
// long-lived subscription can never report a wrapped or unsafe number. The
// snapshot is what the stop response and the `phase-log-tail-stopped` audit row
// carry: counts only, never content.

import { LIVE_LOG_COUNTER_MAX } from '../../contracts/phase-log-bounds';

export const LIVE_LOG_COUNTER_NAMES = Object.freeze([
  'omittedBytes',
  'omittedRecords',
  'duplicateBatches',
  'replayAttempts',
  'deliveryGaps',
  'sourceResets'
] as const);

export type LiveLogCounterName = (typeof LIVE_LOG_COUNTER_NAMES)[number];
export type LiveLogCounterSnapshot = Readonly<Record<LiveLogCounterName, number>>;

export class LiveLogCounters {
  private readonly values = new Map<LiveLogCounterName, number>();

  /** Adds a positive integer amount, saturating; any other amount is ignored. */
  add(name: LiveLogCounterName, amount = 1): void {
    if (!Number.isInteger(amount) || amount <= 0) return;
    const current = this.values.get(name) ?? 0;
    this.values.set(name, Math.min(LIVE_LOG_COUNTER_MAX, current + amount));
  }

  snapshot(): LiveLogCounterSnapshot {
    const out = {} as Record<LiveLogCounterName, number>;
    for (const name of LIVE_LOG_COUNTER_NAMES) out[name] = this.values.get(name) ?? 0;
    return Object.freeze(out);
  }
}
