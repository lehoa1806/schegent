import type { PhaseName } from '../contracts/phase-identity';

export type MonitorStatus =
  | 'starting'
  | 'running'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'canceled'
  | 'paused';

/**
 * Feature FR-R3-007 (T353) — the whole record of how much the CLI emitted.
 *
 * Before this feature the volume of a phase's output was reconstructable from
 * `audit.log`, because every line was in there. Removing that writer makes this
 * aggregate the only place the audit answers "how much did the CLI say, and
 * over what interval" — so it is named, typed, and built in exactly one place
 * (`projectTransportAggregate`) rather than assembled field-by-field at each of
 * its two consumers, the UI projection and the `monitor-invocation-summary`
 * payload. The two must not be able to disagree.
 *
 * The timestamps are chunk-level activity stamps, the same events that move
 * `lastStdoutAt` / `lastStderrAt`: `firstOutputAt` is when either stream first
 * produced anything, `lastOutputAt` the later of the two most recent. A partial
 * line counts as activity, which is why these are not derived from the line
 * counters.
 */
export interface CliTransportAggregate {
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly firstOutputAt: string | null;
  readonly lastOutputAt: string | null;
}

export interface CliMonitorState extends CliTransportAggregate {
  readonly runId: string;
  readonly phase: PhaseName;
  readonly status: MonitorStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly lastStdoutAt: string | null;
  readonly lastStderrAt: string | null;
  readonly lastProgressAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
  readonly msSinceLastStdout: number | null;
  readonly msSinceLastStderr: number | null;
}

/**
 * Build the aggregate from whatever the monitor is tracking for a Run.
 *
 * `lastOutputAt` is the later of the two stream stamps by string comparison,
 * which is sound because both come from `Date.prototype.toISOString()` — fixed
 * width, fixed millisecond precision, always `Z` — so lexical and chronological
 * order coincide. A non-UTC or variable-precision stamp would break that, which
 * is why the monitor formats these and callers do not pass their own.
 */
export function projectTransportAggregate(source: {
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly firstOutputAt: string | null;
  readonly lastStdoutAt: string | null;
  readonly lastStderrAt: string | null;
}): CliTransportAggregate {
  const { lastStdoutAt, lastStderrAt } = source;
  let lastOutputAt: string | null = null;
  if (lastStdoutAt !== null && lastStderrAt !== null) {
    lastOutputAt = lastStdoutAt >= lastStderrAt ? lastStdoutAt : lastStderrAt;
  } else {
    lastOutputAt = lastStdoutAt ?? lastStderrAt;
  }
  return Object.freeze({
    stdoutLines: source.stdoutLines,
    stderrLines: source.stderrLines,
    firstOutputAt: source.firstOutputAt,
    lastOutputAt
  });
}

export function buildIdleMonitorState(runId: string, phase: PhaseName, startedAt: string): CliMonitorState {
  return Object.freeze({
    runId,
    phase,
    status: 'starting' as const,
    pid: null,
    startedAt,
    lastStdoutAt: null,
    lastStderrAt: null,
    lastProgressAt: null,
    stdoutLines: 0,
    stderrLines: 0,
    firstOutputAt: null,
    lastOutputAt: null,
    exitCode: null,
    signal: null,
    detectedIssues: Object.freeze([]) as ReadonlyArray<'rate_limited' | 'stall'>,
    msSinceLastStdout: null,
    msSinceLastStderr: null
  });
}
