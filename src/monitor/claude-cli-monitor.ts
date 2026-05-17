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
  private state: InternalState | null = null;
  private detector: StallDetector | null = null;
  private readonly opts: ClaudeCliMonitorOptions;
  private readonly listeners = new Set<StateChangeListener>();
  private readonly rateLimitClusterMs: number;

  constructor(opts: ClaudeCliMonitorOptions) {
    this.opts = opts;
    this.rateLimitClusterMs = opts.rateLimitClusterMs ?? DEFAULT_RATE_LIMIT_CLUSTER_MS;
  }

  public onStart(runId: string, phase: PhaseName, pid: number | null): void {
    this.disposeDetector();
    const nowDate = this.opts.now();
    const monotonic = this.opts.monotonicNow();
    this.state = {
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
    this.detector = new StallDetector({
      thresholdMs: this.opts.stallThresholdMs,
      monotonicNow: this.opts.monotonicNow,
      setTimeout: this.opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms)),
      clearTimeout: this.opts.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      onStall: () => this.handleStall()
    });
    this.appendAudit('monitor-invocation-started', { pid }, 'info');
    this.notify();
  }

  public onSpawnPid(pid: number | null): void {
    if (!this.state) return;
    this.state.pid = pid;
    this.notify();
  }

  public onStdoutChunk(chunk: string): void {
    if (!this.state || this.state.terminal) return;
    if (this.state.status === 'starting') {
      this.state.status = 'running';
      this.detector?.start();
    } else if (this.state.status === 'stalled') {
      this.state.status = 'running';
    }
    const monotonic = this.opts.monotonicNow();
    const now = this.opts.now().toISOString();
    this.state.lastStdoutAt = now;
    this.state.lastStdoutMonotonic = monotonic;
    const lines = this.splitLines(this.state.stdoutBuffer + chunk, 'stdout');
    this.state.stdoutBuffer = lines.remainder;
    this.state.stdoutLines += lines.complete.length;
    for (const line of lines.complete) {
      this.appendAudit('monitor-stdout-line', { line: this.opts.logger.sanitize(line) }, 'info');
    }
    this.detector?.noteStdoutChunk();
    this.notify();
  }

  public onStderrChunk(chunk: string): void {
    if (!this.state || this.state.terminal) return;
    if (this.state.status === 'starting') {
      this.state.status = 'running';
      this.detector?.start();
    }
    const monotonic = this.opts.monotonicNow();
    const now = this.opts.now().toISOString();
    this.state.lastStderrAt = now;
    this.state.lastStderrMonotonic = monotonic;
    const lines = this.splitLines(this.state.stderrBuffer + chunk, 'stderr');
    this.state.stderrBuffer = lines.remainder;
    this.state.stderrLines += lines.complete.length;
    for (const line of lines.complete) {
      const sanitized = this.opts.logger.sanitize(line);
      this.appendAudit('monitor-stderr-line', { line: sanitized }, 'info');
      this.checkRateLimit(line, monotonic);
    }
    this.notify();
  }

  public onExit(args: { exitCode: number | null; signal: string | null; killed: boolean; timedOut: boolean }): void {
    if (!this.state || this.state.terminal) return;
    this.detector?.dispose();
    this.detector = null;
    this.state.terminal = true;
    this.state.exitCode = args.exitCode;
    this.state.signal = args.signal;
    const durationMs = this.opts.monotonicNow() - this.state.startedAtMonotonic - this.state.pausedTotalMs;
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
    this.state.status = nextStatus;
    this.appendAudit(
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
      'monitor-invocation-summary',
      {
        status: nextStatus,
        durationMs,
        exitCode: args.exitCode,
        signal: args.signal,
        stdoutLines: this.state.stdoutLines,
        stderrLines: this.state.stderrLines,
        detectedIssues: this.state.detectedIssues.slice()
      },
      nextStatus === 'completed' ? 'success' : 'info'
    );
    this.notify();
  }

  public onWorkflowPaused(): void {
    if (!this.state || this.state.terminal) return;
    if (this.state.pausedAtMonotonic !== null) return;
    this.state.pausedAtMonotonic = this.opts.monotonicNow();
    this.detector?.pause();
    this.appendAudit('pause', { reason: 'workflow-paused' }, 'info');
    this.notify();
  }

  public onWorkflowResumed(): void {
    if (!this.state || this.state.terminal) return;
    if (this.state.pausedAtMonotonic === null) return;
    this.state.pausedTotalMs += this.opts.monotonicNow() - this.state.pausedAtMonotonic;
    this.state.pausedAtMonotonic = null;
    this.detector?.resume();
    this.appendAudit('resume', { reason: 'workflow-resumed' }, 'info');
    this.notify();
  }

  public getCurrentState(): CliMonitorState | null {
    if (!this.state) return null;
    const monotonic = this.opts.monotonicNow();
    const paused = this.state.pausedAtMonotonic !== null;
    const status: MonitorStatus = paused && !this.state.terminal ? 'paused' : this.state.status;
    return Object.freeze({
      runId: this.state.runId,
      phase: this.state.phase,
      status,
      pid: this.state.pid,
      startedAt: this.state.startedAt,
      lastStdoutAt: this.state.lastStdoutAt,
      lastStderrAt: this.state.lastStderrAt,
      lastProgressAt: this.state.lastProgressAt,
      stdoutLines: this.state.stdoutLines,
      stderrLines: this.state.stderrLines,
      exitCode: this.state.exitCode,
      signal: this.state.signal,
      detectedIssues: Object.freeze(this.state.detectedIssues.slice()) as ReadonlyArray<'rate_limited' | 'stall'>,
      msSinceLastStdout: paused
        ? null
        : this.state.lastStdoutMonotonic !== null
          ? Math.max(0, monotonic - this.state.lastStdoutMonotonic)
          : null,
      msSinceLastStderr: paused
        ? null
        : this.state.lastStderrMonotonic !== null
          ? Math.max(0, monotonic - this.state.lastStderrMonotonic)
          : null
    });
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
    this.disposeDetector();
    this.listeners.clear();
    this.state = null;
  }

  private disposeDetector(): void {
    if (this.detector) {
      this.detector.dispose();
      this.detector = null;
    }
  }

  private handleStall(): void {
    if (!this.state || this.state.terminal) return;
    if (this.state.pausedAtMonotonic !== null) return;
    this.state.status = 'stalled';
    if (!this.state.detectedIssues.includes('stall')) {
      this.state.detectedIssues.push('stall');
    }
    const monotonic = this.opts.monotonicNow();
    const sinceMs = this.state.lastStdoutMonotonic !== null
      ? monotonic - this.state.lastStdoutMonotonic
      : monotonic - this.state.startedAtMonotonic;
    this.appendAudit('monitor-stall', { msSinceLastStdout: sinceMs }, 'failure');
    this.notify();
  }

  private checkRateLimit(line: string, monotonicAt: number): void {
    if (!this.state) return;
    for (const matcher of this.opts.rateLimitMatchers) {
      if (matcher.regex.test(line)) {
        if (
          this.state.lastRateLimitAtMonotonic === null ||
          monotonicAt - this.state.lastRateLimitAtMonotonic > this.rateLimitClusterMs
        ) {
          this.state.lastRateLimitAtMonotonic = monotonicAt;
          if (!this.state.detectedIssues.includes('rate_limited')) {
            this.state.detectedIssues.push('rate_limited');
          }
          this.appendAudit('monitor-rate-limited', { cause: matcher.cause }, 'failure');
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

  private appendAudit(eventType: string, payload: Record<string, unknown>, outcome: 'success' | 'failure' | 'info'): void {
    if (!this.state) return;
    void this.opts.audit
      .append({
        runId: this.state.runId,
        phase: this.state.phase as Phase,
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
