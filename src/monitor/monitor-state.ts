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
  /**
   * FR-018a (T102a) — chunks this Run's monitor refused, for any reason.
   *
   * Not part of `CliTransportAggregate`, and that is the point: the aggregate
   * answers "how much did the CLI say", this answers "how much did we throw
   * away", and BUG-001 is what happens when only the first question can be
   * asked. Zero for every healthy Run.
   */
  readonly declinedChunks: number;
  readonly detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
  readonly msSinceLastStdout: number | null;
  readonly msSinceLastStderr: number | null;
  /**
   * Feature 211 — the absolute wall-clock bound this Run's invocation was armed
   * with, or `null` when it was armed with none.
   *
   * `startedAt` above is half of the question an operator asks of a long phase —
   * how close is it to the cap that will kill it — and this is the other half. It
   * used to exist only inside the runner's own closure, which is why the surface
   * could show a phase two minutes from termination and look no different from
   * one two minutes in.
   *
   * `null` means unbounded and MUST NOT be replaced by the setting's default
   * anywhere downstream: an invocation with no deadline rendered as six hours
   * from one is a worse answer than no answer.
   */
  readonly maxDurationMs: number | null;
  /**
   * Feature 211 — whether this invocation has crossed
   * `APPROACH_THRESHOLD_FRACTION` of the bound above.
   *
   * Latched once and never cleared for the life of the invocation, matching the
   * one audit record: the crossing is a fact about the invocation, not a level
   * the reading can fall back below.
   */
  readonly deadlineApproaching: boolean;
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
    declinedChunks: 0,
    detectedIssues: Object.freeze([]) as ReadonlyArray<'rate_limited' | 'stall'>,
    msSinceLastStdout: null,
    msSinceLastStderr: null,
    // Feature 211 — an idle state has no invocation, so it has no bound. Seeding
    // the setting's default here is the specific defect FR-009 forbids: it would
    // put a six-hour limit on a surface for something that is not running.
    maxDurationMs: null,
    deadlineApproaching: false
  });
}
