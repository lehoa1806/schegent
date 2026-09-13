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

/**
 * What fraction of an invocation's absolute wall-clock bound may elapse before
 * the monitor records that the bound is being approached.
 *
 * The absolute deadline is terminal-or-nothing: a phase that is productive and
 * long trips neither the idle window nor `MONITOR_STALL_THRESHOLD_MS` above, so
 * `maxDurationSeconds` used to terminate it with nothing written beforehand. One
 * `monitor-deadline-approaching` record at this fraction is the notice.
 *
 * 0.8 is measured, not picked. Across four weeks of this workspace's logs the
 * longest observed invocation reached 70.7% of its bound, so a higher fraction
 * would describe a path that has never fired — and a path that never fires is a
 * path that rots. At the 21600 s default it leaves 72 minutes of runway between
 * the record and the kill.
 *
 * Not a setting, for the same reason as `MONITOR_STALL_THRESHOLD_MS`: it is the
 * monitor's own policy on when elapsed time becomes a report.
 */
export const APPROACH_THRESHOLD_FRACTION = 0.8 as const;
