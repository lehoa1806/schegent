import type { Disposable } from '../state/workspace-state';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { Phase } from '../controller/phase';
import type { PhaseName } from '../ui/sidebar/snapshot';
import type { SanitizedLogger } from '../lib/logger';
import type { CliMonitorState, MonitorStatus } from './monitor-state';
import { StallDetector, type ClearTimeoutFn, type SetTimeoutFn } from './stall-detector';

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
  readonly logger: Pick<SanitizedLogger, 'sanitize' | 'warn'>;
  readonly setTimeout?: SetTimeoutFn;
  readonly clearTimeout?: ClearTimeoutFn;
  readonly rateLimitClusterMs?: number;
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
  stdoutLines: number;
  stderrLines: number;
  exitCode: number | null;
  signal: string | null;
  detectedIssues: Array<'rate_limited' | 'stall'>;
  pausedTotalMs: number;
  pausedAtMonotonic: number | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  lastRateLimitAtMonotonic: number | null;
  terminal: boolean;
}

const DEFAULT_RATE_LIMIT_CLUSTER_MS = 5_000;

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

  constructor(opts: ClaudeCliMonitorOptions) {
    this.opts = opts;
    this.rateLimitClusterMs = opts.rateLimitClusterMs ?? DEFAULT_RATE_LIMIT_CLUSTER_MS;
  }

  public onStart(runId: string, phase: PhaseName, pid: number | null): void {
    // Feature 093 (T046) — dispose only THIS Run's detector. Restarting a Run
    // still replaces its own state and timer; a sibling's are untouched.
    this.disposeDetector(runId);
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
      stdoutLines: 0,
      stderrLines: 0,
      exitCode: null,
      signal: null,
      detectedIssues: [],
      pausedTotalMs: 0,
      pausedAtMonotonic: null,
      stdoutBuffer: '',
      stderrBuffer: '',
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
    const now = this.opts.now().toISOString();
    state.lastStdoutAt = now;
    state.lastStdoutMonotonic = monotonic;
    const lines = this.splitLines(state.stdoutBuffer + chunk, 'stdout');
    state.stdoutBuffer = lines.remainder;
    state.stdoutLines += lines.complete.length;
    for (const line of lines.complete) {
      this.appendAudit(state.runId, 'monitor-stdout-line', { line: this.opts.logger.sanitize(line) }, 'info');
    }
    detector?.noteStdoutChunk();
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
    const now = this.opts.now().toISOString();
    state.lastStderrAt = now;
    state.lastStderrMonotonic = monotonic;
    const lines = this.splitLines(state.stderrBuffer + chunk, 'stderr');
    state.stderrBuffer = lines.remainder;
    state.stderrLines += lines.complete.length;
    for (const line of lines.complete) {
      const sanitized = this.opts.logger.sanitize(line);
      this.appendAudit(state.runId, 'monitor-stderr-line', { line: sanitized }, 'info');
      this.checkRateLimit(state, line, monotonic);
    }
    this.notify();
  }

  public onExit(
    runId: string | null,
    args: { exitCode: number | null; signal: string | null; killed: boolean; timedOut: boolean }
  ): void {
    const state = this.resolve(runId);
    if (!state || state.terminal) return;
    this.disposeDetector(state.runId);
    state.terminal = true;
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
        stdoutLines: state.stdoutLines,
        stderrLines: state.stderrLines,
        detectedIssues: state.detectedIssues.slice()
      },
      nextStatus === 'completed' ? 'success' : 'info'
    );
    this.notify();
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
      stdoutLines: state.stdoutLines,
      stderrLines: state.stderrLines,
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
    this.latestRunId = null;
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

  private splitLines(buffered: string, _stream: 'stdout' | 'stderr'): { complete: string[]; remainder: string } {
    const idx = buffered.lastIndexOf('\n');
    if (idx === -1) return { complete: [], remainder: buffered };
    const head = buffered.slice(0, idx);
    const remainder = buffered.slice(idx + 1);
    const complete = head.split('\n').filter((s) => s.length > 0);
    return { complete, remainder };
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
