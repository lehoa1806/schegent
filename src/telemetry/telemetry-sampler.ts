// Feature 033 — TelemetrySampler.
//
// Polls a known subprocess PID at a fixed cadence (default 2 s), calls the
// injected platform `shellOutFn`, and forwards each parsed `TelemetrySnapshot`
// to the operator-supplied `onSample` callback. On `stop()`, synthesizes a
// final sample (status: 'exited' | 'killed') from the cached lastLive
// numerics and then emits a single `null` so the projection clears.
//
// Invariants (mirrors contracts/telemetry-sampler.md §Invariants):
//   S1 — at most one sampling lifetime active at a time
//   S2 — onSample is non-throwing; sampler swallows + WARNs on caller throw
//   S3 — shellOutFn failures do NOT cancel the interval
//   S4 — WARN logs deduplicated per (pid, errorClass) within one start()
//   S5 — dispose() is idempotent
//   S6 — NO `vscode` import (policed by tests/lint/no-vscode-import-in-telemetry.test.ts)
//   S7 — sampler MUST NOT touch WorkspaceStateStore or any persisted state
//   S8 — sampler MUST NOT write to the audit log
//
// SC-004 measurement methodology (manual smoke recipe):
//   1. Open a workspace and observe the extension OUTPUT channel.
//   2. Run a 5-minute fixture phase WITHOUT telemetry first (toggle the
//      `monitorHook` wiring off at extension.ts).
//   3. Record phase duration from the `phase-start` / `phase-end` audit
//      entries.
//   4. Re-run the identical fixture phase WITH telemetry on.
//   5. Compute `(durationWith − durationWithout) ÷ durationWithout`.
//      Target: ≤ ±1%. Re-run the recipe if regression is suspected.
//
// Rationale: at 2s cadence with a 1s platform-spawn timeout the worst-case
// CPU on the sampler's own time slice is 0.5s ÷ 2s = 25% of one CPU core,
// but the platform spawn is non-blocking against the main loop (the
// awaited promise resolves on the next event-loop tick), so the wall-clock
// impact on the phase work is well below 1%.

import type { TelemetrySnapshot, TelemetryStatus } from './telemetry-snapshot';
import {
  TELEMETRY_SAMPLE_INTERVAL_MS,
  synthesizeExitSample
} from './telemetry-snapshot';
import type { ShellOutFn } from './platform/platform-ps';

export interface TelemetrySampler {
  start(pid: number, startedAt: number): void;
  stop(exitInfo: { signal: NodeJS.Signals | null }): void;
  current(): TelemetrySnapshot | null;
  dispose(): void;
}

export interface TelemetrySamplerLogger {
  warn(...args: unknown[]): void;
}

export interface TelemetrySamplerOptions {
  readonly shellOutFn: ShellOutFn;
  readonly logger: TelemetrySamplerLogger;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly onSample: (snap: TelemetrySnapshot | null) => void;
}

type FailureClass =
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'parse-failed'
  | 'no-rows'
  | 'timeout'
  | 'unknown';

export class TelemetrySamplerImpl implements TelemetrySampler {
  private readonly shellOutFn: ShellOutFn;
  private readonly logger: TelemetrySamplerLogger;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onSample: (snap: TelemetrySnapshot | null) => void;

  private pid: number | null = null;
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private lastLive: TelemetrySnapshot | null = null;
  private warnedClasses = new Set<string>();
  private disposed = false;

  constructor(opts: TelemetrySamplerOptions) {
    this.shellOutFn = opts.shellOutFn;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? TELEMETRY_SAMPLE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.onSample = opts.onSample;
  }

  public start(pid: number, startedAt: number): void {
    if (this.disposed) return;
    if (this.sampling) {
      this.warnOnce(pid, 'already-sampling');
      return;
    }
    this.sampling = true;
    this.pid = pid;
    this.startedAt = startedAt;
    this.warnedClasses = new Set<string>();
    this.lastLive = null;

    // Immediate first sample via microtask so the projection populates as
    // soon as the runner reports the spawn.
    queueMicrotask(() => {
      if (!this.sampling || this.pid !== pid) return;
      void this.tick();
    });

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Avoid keeping the event loop alive purely for the sampler.
    (this.timer as { unref?: () => void }).unref?.();
  }

  public stop(exitInfo: { signal: NodeJS.Signals | null }): void {
    if (!this.sampling) return;
    const pid = this.pid;
    const startedAt = this.startedAt;
    this.sampling = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (pid === null || startedAt === null) {
      this.safeOnSample(null);
      return;
    }

    const finalSample = synthesizeExitSample({
      pid,
      signal: exitInfo.signal,
      startedAt,
      now: this.now(),
      lastLive: this.lastLive
        ? {
            cpuPercent: this.lastLive.cpuPercent,
            memoryRssBytes: this.lastLive.memoryRssBytes
          }
        : null
    });
    this.safeOnSample(finalSample);

    // Schedule null clear on the microtask boundary so the projector's
    // debounce coalesces appropriately.
    queueMicrotask(() => {
      this.safeOnSample(null);
    });
  }

  public current(): TelemetrySnapshot | null {
    return this.lastLive;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sampling) {
      this.stop({ signal: null });
    }
  }

  private async tick(): Promise<void> {
    if (!this.sampling) return;
    const pid = this.pid;
    if (pid === null) return;
    let snap: TelemetrySnapshot | null = null;
    try {
      snap = await this.shellOutFn(pid);
    } catch {
      snap = null;
    }
    // Re-check sampling state after the async hop — stop() may have fired
    // while the shell-out was in flight; do not emit a live sample after stop.
    if (!this.sampling) return;
    if (snap === null) {
      const errorClass: FailureClass = 'unknown';
      this.warnOnce(pid, errorClass);
      this.safeOnSample(this.buildUnavailable(pid));
      return;
    }
    this.lastLive = snap;
    this.safeOnSample(snap);
  }

  private buildUnavailable(pid: number): TelemetrySnapshot {
    const status: TelemetryStatus = 'unavailable';
    return Object.freeze({
      pid,
      status,
      cpuPercent: null,
      memoryRssBytes: null,
      uptimeMs: null,
      sampledAt: new Date(this.now()).toISOString()
    });
  }

  private warnOnce(pid: number, errorClass: FailureClass | 'already-sampling'): void {
    const key = `${pid}::${errorClass}`;
    if (this.warnedClasses.has(key)) return;
    this.warnedClasses.add(key);
    try {
      this.logger.warn(`telemetry-sampler: pid=${pid} error=${errorClass}`);
    } catch {
      // ignore logger failures
    }
  }

  private safeOnSample(snap: TelemetrySnapshot | null): void {
    try {
      this.onSample(snap);
    } catch {
      const pid = this.pid;
      if (pid !== null) {
        this.warnOnce(pid, 'unknown');
      }
    }
  }
}
