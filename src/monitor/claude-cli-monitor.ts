import type { Disposable } from '../state/workspace-state';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { Phase } from '../controller/phase';
import type { PhaseName } from '../ui/sidebar/snapshot';
import type { SanitizedLogger } from '../lib/logger';
import type { CliMonitorState, MonitorStatus } from './monitor-state';
import { projectTransportAggregate } from './monitor-state';
import type { CliTransportRecorder } from './cli-transport-sink';
import { ActivityCoalescer, type ActivityRecorder } from './activity-coalescer';
import { StallDetector, type ClearTimeoutFn, type SetTimeoutFn } from './stall-detector';
import { LineFramer, DEFAULT_MAX_LINE_UNITS, type FramedOutput } from '../lib/line-framer';

export type RateLimitMatcher = { regex: RegExp; cause: string };

export interface MonitorAuditFields {
  readonly runId: string;
  readonly phase: Phase;
  readonly iteration: number;
}

export interface ClaudeCliMonitorOptions {
  readonly stallThresholdMs: number;
  readonly rateLimitMatchers: ReadonlyArray<RateLimitMatcher>;
  readonly monotonicNow: () => number;
  readonly now: () => Date;
  readonly audit: Pick<AuditLogWriter, 'append'>;
  /**
   * Feature FR-R3-007 (T358, T359) — where a line of CLI output goes now that
   * it no longer goes to `audit.log`.
   *
   * Required, not optional. An optional recorder would make the one production
   * wiring line load-bearing in the way `ownership-registry-wiring.test.ts`
   * describes: omit it and every test still passes while the host silently
   * captures nothing, which is indistinguishable from the silent loss this
   * feature exists to avoid. Two construction sites exist, so requiring it
   * costs nothing and `npm run typecheck` enforces it.
   */
  readonly transport: CliTransportRecorder;
  /**
   * FR-R3-008 (T376) — where the persisted liveness stamp comes from.
   *
   * Required for the same reason `transport` above is: the monitor is the only
   * thing that knows a phase is still producing output, and an optional recorder
   * would let the one production wiring line go missing while every test still
   * passed and every reloaded window silently reported an unknown liveness — the
   * exact state this feature exists to end.
   *
   * The monitor hands over counters and a timestamp; it does not decide when to
   * write. `ActivityCoalescer` bounds the rate and the controller performs the
   * write.
   */
  readonly activity: ActivityRecorder;
  readonly logger: Pick<SanitizedLogger, 'sanitize' | 'warn'>;
  readonly setTimeout?: SetTimeoutFn;
  readonly clearTimeout?: ClearTimeoutFn;
  readonly rateLimitClusterMs?: number;
  /** Test seam: shortens the liveness coalescing window. Production uses the default. */
  readonly activityCoalesceMs?: number;
}

export type StateChangeListener = (state: CliMonitorState | null) => void;

interface InternalState {
  runId: string;
  phase: PhaseName;
  status: MonitorStatus;
  pid: number | null;
  startedAt: string;
  startedAtMonotonic: number;
  lastStdoutAt: string | null;
  lastStdoutMonotonic: number | null;
  lastStderrAt: string | null;
  lastStderrMonotonic: number | null;
  lastProgressAt: string | null;
  /**
   * Feature FR-R3-007 (T353) — when either stream first produced anything.
   *
   * Stamped once and never overwritten, so it survives a stall-and-resume that
   * moves `lastStdoutAt` repeatedly. `startedAt` is not a substitute: it records
   * when the process was spawned, and the interval between the two is the CLI's
   * own startup. (FR-R3-062: this previously cited
   * `docs/operations/performance.md`, which does not exist. The measurement it
   * described is exactly the interval named above, so the citation is dropped
   * rather than replaced by a page written to host one sentence.)
   */
  firstOutputAt: string | null;
  stdoutLines: number;
  stderrLines: number;
  exitCode: number | null;
  signal: string | null;
  detectedIssues: Array<'rate_limited' | 'stall'>;
  pausedTotalMs: number;
  pausedAtMonotonic: number | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** FR-R3-052 — bounded framing, one per stream. */
  stdoutFramer: LineFramer;
  stderrFramer: LineFramer;
  /** First-loss-only reporting, so one huge record is not one event per chunk. */
  stdoutFramingReported: boolean;
  stderrFramingReported: boolean;
  lastRateLimitAtMonotonic: number | null;
  terminal: boolean;
}

const DEFAULT_RATE_LIMIT_CLUSTER_MS = 5_000;

/**
 * FR-R3-052 (M-10) — how many settled runs stay readable. Well above what any
 * surface displays, and far below unbounded.
 */
const MAX_SETTLED_STATES = 32;

export class ClaudeCliMonitor {
  /**
   * Feature 093 (T046) — one entry per executing Run, not one slot per window.
   *
   * The single slot was correct while a window could execute one Run: `onStart`
   * disposed the previous detector and replaced the state because there was
   * nothing else it could belong to. With N Runs that same line destroys Run
   * A's stall detector the moment Run B starts, and every anonymous chunk after
   * it extends B's deadline while A's is gone — a stalled A would never be
   * reported. Keying by run id is R6's **K** move: the state was always about a
   * Run, and only its addressing changes.
   *
   * `latestRunId` preserves the pre-feature reads for callers that ask for
   * "the" state without naming a Run. It tracks the most recently started Run,
   * which with one Run is that Run and with several is an explicit,
   * documented choice rather than whichever write landed last.
   */
  private readonly states = new Map<string, InternalState>();
  private readonly detectors = new Map<string, StallDetector>();
  private latestRunId: string | null = null;
  private readonly opts: ClaudeCliMonitorOptions;
  private readonly listeners = new Set<StateChangeListener>();
  private readonly rateLimitClusterMs: number;
  /** FR-R3-008 (T376) — per-Run rate limiter in front of the liveness write. */
  private readonly activity: ActivityCoalescer;

  constructor(opts: ClaudeCliMonitorOptions) {
    this.opts = opts;
    this.rateLimitClusterMs = opts.rateLimitClusterMs ?? DEFAULT_RATE_LIMIT_CLUSTER_MS;
    this.activity = new ActivityCoalescer({
      monotonicNow: opts.monotonicNow,
      recorder: opts.activity,
      ...(opts.activityCoalesceMs === undefined ? {} : { intervalMs: opts.activityCoalesceMs })
    });
  }

  public onStart(runId: string, phase: PhaseName, pid: number | null): void {
    // Feature 093 (T046) — dispose only THIS Run's detector. Restarting a Run
    // still replaces its own state and timer; a sibling's are untouched.
    this.disposeDetector(runId);
    // FR-R3-008 (T376) — a new invocation resets the counters below, so it must
    // be able to flush on its first chunk. Inheriting the previous phase's window
    // would leave the persisted counters showing that phase's higher totals for
    // up to a full interval into this one.
    this.activity.forget(runId);
    const nowDate = this.opts.now();
    const monotonic = this.opts.monotonicNow();
    const state: InternalState = {
      runId,
      phase,
      status: 'starting',
      pid,
      startedAt: nowDate.toISOString(),
      startedAtMonotonic: monotonic,
      lastStdoutAt: null,
      lastStdoutMonotonic: null,
      lastStderrAt: null,
      lastStderrMonotonic: null,
      lastProgressAt: null,
      firstOutputAt: null,
      stdoutLines: 0,
      stderrLines: 0,
      exitCode: null,
      signal: null,
      detectedIssues: [],
      pausedTotalMs: 0,
      pausedAtMonotonic: null,
      stdoutBuffer: '',
      stderrBuffer: '',
      stdoutFramer: new LineFramer(),
      stderrFramer: new LineFramer(),
      stdoutFramingReported: false,
      stderrFramingReported: false,
      lastRateLimitAtMonotonic: null,
      terminal: false
    };
    this.states.set(runId, state);
    this.latestRunId = runId;
    this.detectors.set(
      runId,
      new StallDetector({
        thresholdMs: this.opts.stallThresholdMs,
        monotonicNow: this.opts.monotonicNow,
        setTimeout: this.opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms)),
        clearTimeout: this.opts.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
        onStall: () => this.handleStall(runId)
      })
    );
    this.appendAudit(runId, 'monitor-invocation-started', { pid }, 'info');
    this.notify();
  }

  public onSpawnPid(runId: string | null, pid: number | null): void {
    const state = this.resolve(runId);
    if (!state) return;
    state.pid = pid;
    this.notify();
  }

  public onStdoutChunk(runId: string | null, chunk: string): void {
    const state = this.resolve(runId);
    if (!state || state.terminal) return;
    const detector = this.detectors.get(state.runId) ?? null;
    if (state.status === 'starting') {
      state.status = 'running';
      detector?.start();
    } else if (state.status === 'stalled') {
      state.status = 'running';
    }
    const monotonic = this.opts.monotonicNow();
    const nowDate = this.opts.now();
    const now = nowDate.toISOString();
    state.lastStdoutAt = now;
    state.lastStdoutMonotonic = monotonic;
    if (state.firstOutputAt === null) state.firstOutputAt = now;
    // FR-R3-052 (H-03) — bounded framing. `splitLines` returned the whole
    // buffer as the remainder when it found no newline, and that remainder was
    // assigned straight back here, so a newline-free stream retained every byte
    // the CLI produced. Measured before the fix: 8 MiB in, 8 MiB held.
    const framed = state.stdoutFramer.append(chunk);
    state.stdoutBuffer = state.stdoutFramer.retained;
    state.stdoutLines += framed.lines.length;
    this.recordFramingLoss(state, 'stdout', framed);
    for (const line of framed.lines) {
      // Feature FR-R3-007 (T358) — transport, not an audit event. This loop
      // used to `appendAudit('monitor-stdout-line', …)` once per line, which was
      // 93.2% of `audit.log` and read by nothing; the count that replaced it is
      // in `monitor-invocation-summary`, and the content is in the bounded sink.
      // The sink sanitizes, so the raw line is handed over deliberately.
      this.opts.transport.record({
        runId: state.runId,
        phase: state.phase,
        stream: 'stdout',
        line
      });
    }
    detector?.noteStdoutChunk();
    this.noteActivity(state, nowDate);
    this.notify();
  }

  public onStderrChunk(runId: string | null, chunk: string): void {
    const state = this.resolve(runId);
    if (!state || state.terminal) return;
    const detector = this.detectors.get(state.runId) ?? null;
    if (state.status === 'starting') {
      state.status = 'running';
      detector?.start();
    }
    const monotonic = this.opts.monotonicNow();
    const nowDate = this.opts.now();
    const now = nowDate.toISOString();
    state.lastStderrAt = now;
    state.lastStderrMonotonic = monotonic;
    if (state.firstOutputAt === null) state.firstOutputAt = now;
    // FR-R3-052 (H-03) — same bound on stderr. A CLI that writes a huge
    // newline-free diagnostic to stderr is the same defect through the other pipe.
    const framedErr = state.stderrFramer.append(chunk);
    state.stderrBuffer = state.stderrFramer.retained;
    state.stderrLines += framedErr.lines.length;
    this.recordFramingLoss(state, 'stderr', framedErr);
    for (const line of framedErr.lines) {
      // Feature FR-R3-007 (T359) — the stderr half of the same move. The
      // rate-limit scan stays here and stays on the raw line: it is a judgement
      // Schegent makes about the invocation, so `monitor-rate-limited` remains
      // an audit event while the line that triggered it is transport.
      this.opts.transport.record({
        runId: state.runId,
        phase: state.phase,
        stream: 'stderr',
        line
      });
      this.checkRateLimit(state, line, monotonic);
    }
    this.noteActivity(state, nowDate);
    this.notify();
  }

  public onExit(
    runId: string | null,
    args: { exitCode: number | null; signal: string | null; killed: boolean; timedOut: boolean }
  ): void {
    const state = this.resolve(runId);
    if (!state || state.terminal) return;
    this.disposeDetector(state.runId);
    // FR-R3-008 (T376) — release the coalescing window without flushing a final
    // observation. A flush here would race the driver's own terminal `setRun`,
    // and it would make the write count depend on invocation count rather than on
    // elapsed time; the exact end-of-phase totals are in the summary event below.
    this.activity.forget(state.runId);
    state.terminal = true;
    // FR-R3-052 (M-10) — release the framing buffers now. The process has
    // exited, so the partial line they hold is never completing, and holding it
    // for the life of the host session is up to a megabyte per finished run.
    state.stdoutBuffer = '';
    state.stderrBuffer = '';
    state.stdoutFramer = new LineFramer();
    state.stderrFramer = new LineFramer();
    state.exitCode = args.exitCode;
    state.signal = args.signal;
    const durationMs = this.opts.monotonicNow() - state.startedAtMonotonic - state.pausedTotalMs;
    let nextStatus: MonitorStatus;
    let eventType: string;
    if (args.timedOut) {
      nextStatus = 'timed_out';
      eventType = 'monitor-invocation-failed';
    } else if (args.killed) {
      nextStatus = 'canceled';
      eventType = 'monitor-invocation-canceled';
    } else if ((args.exitCode ?? 1) === 0) {
      nextStatus = 'completed';
      eventType = 'monitor-invocation-completed';
    } else {
      nextStatus = 'failed';
      eventType = 'monitor-invocation-failed';
    }
    state.status = nextStatus;
    this.appendAudit(
      state.runId,
      eventType,
      {
        exitCode: args.exitCode,
        signal: args.signal,
        durationMs,
        timedOut: args.timedOut,
        killed: args.killed
      },
      nextStatus === 'completed' ? 'success' : 'failure'
    );
    this.appendAudit(
      state.runId,
      'monitor-invocation-summary',
      {
        status: nextStatus,
        durationMs,
        exitCode: args.exitCode,
        signal: args.signal,
        // Feature FR-R3-007 (T353) — the same aggregate the UI reads. With the
        // per-line events gone this is the audit's only record of the CLI's
        // output volume, so it is built by one function rather than restated.
        ...projectTransportAggregate(state),
        detectedIssues: state.detectedIssues.slice()
      },
      nextStatus === 'completed' ? 'success' : 'info'
    );
    this.evictSettledStates();
    this.notify();
  }

  /**
   * FR-R3-052 (M-10) — the state map only ever grew. Entries were `set` on start
   * and removed only by `dispose()`, so a host session that ran hundreds of
   * phases retained every one. Measured before the fix: 500 runs, 500 entries.
   *
   * Settled entries only, evicted oldest-first: an active run's state is what
   * the monitor exists to hold. The most recent settled runs stay, because the
   * sidebar reads the last run's status after it ends -- an eviction that took
   * that away would trade a leak for a blank panel.
   */
  private evictSettledStates(): void {
    const settled = [...this.states.entries()].filter(([, entry]) => entry.terminal);
    if (settled.length <= MAX_SETTLED_STATES) return;
    for (const [id] of settled.slice(0, settled.length - MAX_SETTLED_STATES)) {
      this.states.delete(id);
    }
  }

  /**
   * Feature 093 (T046) — pause/resume address a Run, defaulting to the latest.
   *
   * These two are driven by the controller's pause/resume path rather than by a
   * subprocess event, so the caller already knows which Run it is pausing. The
   * optional parameter keeps the pre-feature single-Run call sites compiling and
   * behaving identically; a concurrent caller names its Run and leaves siblings
   * running, which is FR-024 applied to the monitor's clock accounting.
   */
  public onWorkflowPaused(runId?: string | null): void {
    const state = this.resolve(runId === undefined ? this.latestRunId : runId);
    if (!state || state.terminal) return;
    if (state.pausedAtMonotonic !== null) return;
    state.pausedAtMonotonic = this.opts.monotonicNow();
    this.detectors.get(state.runId)?.pause();
    this.appendAudit(state.runId, 'pause', { reason: 'workflow-paused' }, 'info');
    this.notify();
  }

  public onWorkflowResumed(runId?: string | null): void {
    const state = this.resolve(runId === undefined ? this.latestRunId : runId);
    if (!state || state.terminal) return;
    if (state.pausedAtMonotonic === null) return;
    state.pausedTotalMs += this.opts.monotonicNow() - state.pausedAtMonotonic;
    state.pausedAtMonotonic = null;
    this.detectors.get(state.runId)?.resume();
    this.appendAudit(state.runId, 'resume', { reason: 'workflow-resumed' }, 'info');
    this.notify();
  }

  /**
   * Feature 093 (T046) — omitting `runId` reads the most recently started Run.
   *
   * The window-level UI readers (`monitor-projector`, `snapshot-composer`,
   * `state-projector`) ask for "the" monitor state and are unchanged by this
   * task; with one Run the answer is identical to the pre-feature one. The
   * per-Run projection those readers eventually need is T051's, and it consumes
   * `getStateMap()` rather than calling this in a loop.
   */
  public getCurrentState(runId?: string): CliMonitorState | null {
    const state = this.resolve(runId === undefined ? this.latestRunId : runId);
    if (!state) return null;
    return this.project(state);
  }

  /**
   * Feature 093 (T046) — every live Run's monitor state, keyed by run id.
   *
   * The C-4 aggregate case SC-012 exempts: it names no single Run and is used by
   * the projections that must show all of them at once.
   */
  public getStateMap(): Readonly<Record<string, CliMonitorState>> {
    const out: Record<string, CliMonitorState> = {};
    for (const [id, state] of this.states) {
      out[id] = this.project(state);
    }
    return Object.freeze(out);
  }

  private project(state: InternalState): CliMonitorState {
    const monotonic = this.opts.monotonicNow();
    const paused = state.pausedAtMonotonic !== null;
    const status: MonitorStatus = paused && !state.terminal ? 'paused' : state.status;
    return Object.freeze({
      runId: state.runId,
      phase: state.phase,
      status,
      pid: state.pid,
      startedAt: state.startedAt,
      lastStdoutAt: state.lastStdoutAt,
      lastStderrAt: state.lastStderrAt,
      lastProgressAt: state.lastProgressAt,
      ...projectTransportAggregate(state),
      exitCode: state.exitCode,
      signal: state.signal,
      detectedIssues: Object.freeze(state.detectedIssues.slice()) as ReadonlyArray<'rate_limited' | 'stall'>,
      msSinceLastStdout: paused
        ? null
        : state.lastStdoutMonotonic !== null
          ? Math.max(0, monotonic - state.lastStdoutMonotonic)
          : null,
      msSinceLastStderr: paused
        ? null
        : state.lastStderrMonotonic !== null
          ? Math.max(0, monotonic - state.lastStderrMonotonic)
          : null
    });
  }

  /**
   * Feature 093 (T046) — resolve an event's Run, or nothing.
   *
   * A `null` id means the invocation carried none, which the sidecar contract
   * documents as "no attributable Run". Attributing it to the latest starter is
   * the exact defect this task removes, so the event is dropped instead. An id
   * with no entry is a Run the monitor never saw start (or already disposed) and
   * is likewise dropped rather than resurrected.
   */
  private resolve(runId: string | null | undefined): InternalState | null {
    if (typeof runId !== 'string') return null;
    return this.states.get(runId) ?? null;
  }

  public subscribe(listener: StateChangeListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  public dispose(): void {
    for (const detector of this.detectors.values()) {
      detector.dispose();
    }
    this.detectors.clear();
    this.listeners.clear();
    this.states.clear();
    this.activity.dispose();
    this.latestRunId = null;
  }

  /**
   * FR-R3-008 (T376) — hand the coalescer a chunk-level observation.
   *
   * Called on every chunk of either stream, including one that carries no
   * complete line: a partial line is still evidence the CLI is alive, which is
   * the same reason `firstOutputAt` and `lastOutputAt` are chunk-stamped rather
   * than derived from the counters. What crosses is the wall-clock stamp and the
   * two counts — never the chunk, so there is no content to sanitize and no path
   * to leak into the state tier.
   */
  private noteActivity(state: InternalState, at: Date): void {
    this.activity.note({
      runId: state.runId,
      at: at.getTime(),
      stdoutLines: state.stdoutLines,
      stderrLines: state.stderrLines
    });
  }

  private disposeDetector(runId: string): void {
    const detector = this.detectors.get(runId);
    if (detector) {
      detector.dispose();
      this.detectors.delete(runId);
    }
  }

  private handleStall(runId: string): void {
    const state = this.states.get(runId);
    if (!state || state.terminal) return;
    if (state.pausedAtMonotonic !== null) return;
    state.status = 'stalled';
    if (!state.detectedIssues.includes('stall')) {
      state.detectedIssues.push('stall');
    }
    const monotonic = this.opts.monotonicNow();
    const sinceMs = state.lastStdoutMonotonic !== null
      ? monotonic - state.lastStdoutMonotonic
      : monotonic - state.startedAtMonotonic;
    this.appendAudit(runId, 'monitor-stall', { msSinceLastStdout: sinceMs }, 'failure');
    this.notify();
  }

  private checkRateLimit(state: InternalState, line: string, monotonicAt: number): void {
    for (const matcher of this.opts.rateLimitMatchers) {
      if (matcher.regex.test(line)) {
        if (
          state.lastRateLimitAtMonotonic === null ||
          monotonicAt - state.lastRateLimitAtMonotonic > this.rateLimitClusterMs
        ) {
          state.lastRateLimitAtMonotonic = monotonicAt;
          if (!state.detectedIssues.includes('rate_limited')) {
            state.detectedIssues.push('rate_limited');
          }
          this.appendAudit(state.runId, 'monitor-rate-limited', { cause: matcher.cause }, 'failure');
        }
        return;
      }
    }
  }

  /**
   * FR-R3-052 — "no silent caps". A framer that truncates without saying so
   * turns a corrupted stream into a plausible one: the line looks short, and
   * nothing distinguishes that from a CLI that wrote a short line.
   *
   * Recorded as an audit event on the FIRST loss per stream only. A run whose
   * output is one huge record would otherwise emit one event per chunk, which is
   * the per-line audit volume problem FR-R3-007 removed.
   */
  private recordFramingLoss(
    state: InternalState,
    stream: 'stdout' | 'stderr',
    framed: FramedOutput
  ): void {
    if (framed.truncatedLines === 0 && framed.droppedUnits === 0) return;
    const framer = stream === 'stdout' ? state.stdoutFramer : state.stderrFramer;
    const already = stream === 'stdout' ? state.stdoutFramingReported : state.stderrFramingReported;
    if (stream === 'stdout') state.stdoutFramingReported = true;
    else state.stderrFramingReported = true;
    if (already) return;
    this.appendAudit(
      state.runId,
      'monitor-output-truncated',
      {
        stream,
        truncatedLines: framer.totals.truncatedLines,
        droppedUnits: framer.totals.droppedUnits,
        limitUnits: DEFAULT_MAX_LINE_UNITS
      },
      'info'
    );
  }

  private appendAudit(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    outcome: 'success' | 'failure' | 'info'
  ): void {
    const state = this.states.get(runId);
    if (!state) return;
    void this.opts.audit
      .append({
        runId: state.runId,
        phase: state.phase as Phase,
        iteration: 0,
        eventType: eventType as never,
        outcome,
        payload
      })
      .catch((err: unknown) => {
        try {
          this.opts.logger.warn(`[monitor] audit append failed: ${(err as Error).message}`);
        } catch {
          // never throw from audit failure path
        }
      });
  }

  private notify(): void {
    const snapshot = this.getCurrentState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // listener errors must not propagate
      }
    }
  }
}
