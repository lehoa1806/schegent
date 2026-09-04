export const MONITOR_SNAPSHOT_EVENT_TYPES = [
  'monitor.started',
  'monitor.tick',
  'monitor.completed'
] as const;

export type MonitorEventType = (typeof MONITOR_SNAPSHOT_EVENT_TYPES)[number];

export interface MonitorEvent {
  readonly eventType: MonitorEventType;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly summary: string;
}

export interface MonitorSnapshot {
  readonly correlationId: string;
  readonly events: readonly MonitorEvent[];
  readonly lastUpdated: string;
}

export const DEFAULT_MONITOR_TAIL_LIMIT = 200 as const;

/**
 * How long a subprocess may be silent before the monitor declares it stalled.
 *
 * Named and exported because a host-spawned child's own idle bound must not be
 * SHORTER than this, and while the value was a literal at its one construction
 * site nothing could state that. The pre-phase session compaction was bounded at
 * 60_000 against this 90_000: a silent compaction child was killed thirty seconds
 * before `handleStall` could fire, so no `monitor-stall` was ever writable about
 * one and the whole window — a minute of a phase that had already emitted
 * `phase-start` — was structurally unreportable. Two bounds set independently, in
 * the wrong order, with nothing relating them.
 *
 * Not a setting. It is the monitor's own policy on when silence becomes a report,
 * the same kind of value as `DEFAULT_MONITOR_TAIL_LIMIT` above.
 */
export const MONITOR_STALL_THRESHOLD_MS = 90_000 as const;
