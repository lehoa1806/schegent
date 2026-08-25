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

  /**
   * FR-R3-081 (T1083) — one series per sampled child, on ONE shared interval.
   *
   * What this replaces sampled a single PID: `start()` returned early with
   * `already-sampling` whenever a second run spawned, and `stop()` halted the
   * sole sampler. At the default concurrency cap of 1 that is correct and
   * complete; above it, every run after the first was unsampled — so the one
   * instrument that could answer this item's aggregate question went blind
   * exactly when the aggregate became a question. The 2026-08-24 review recorded
   * it as a secondary finding and nothing filed it.
   *
   * A registry rather than a sampler per run: the cost that matters is the
   * `setInterval` and the shell-out, and one timer walking N pids is O(1) in
   * timers where N samplers is O(N). The `already-sampling` warning survives for
   * the case it was actually about — a duplicate `start()` for the SAME pid,
   * which is a caller bug rather than concurrency.
   */
  private readonly series = new Map<
    number,
    { startedAt: number; lastLive: TelemetrySnapshot | null }
  >();
  /** The pid whose samples reach `onSample`; see the class note on projection. */
  private projectedPid: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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
    if (this.series.has(pid)) {
      // The warning the early-return used to carry, kept for the case it was
      // really about: the same child announced twice.
      this.warnOnce(pid, 'already-sampling');
      return;
    }
    this.series.set(pid, { startedAt, lastLive: null });
    // The first child to start is the one the sidebar shows, and it keeps that
    // role until it exits. Every OTHER child is sampled just the same — its
    // series is in the registry and `currentByPid()` answers for it — it simply
    // does not displace the projection mid-run. Choosing a different projection
    // (an aggregate, or a per-run panel) is a UI decision this item deliberately
    // does not take: the finding was that the runs were not SAMPLED.
    this.projectedPid ??= pid;

    // Immediate first sample via microtask so the projection populates as
    // soon as the runner reports the spawn.
    queueMicrotask(() => {
      if (!this.series.has(pid)) return;
      void this.tickPid(pid);
    });

    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Avoid keeping the event loop alive purely for the sampler.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * FR-R3-081 (T1083) — stop ONE child's series.
   *
   * `pid` is optional so the existing single-run call site is unchanged: with
   * one child sampled there is exactly one series to stop, and requiring the pid
   * would be a call-site change with no behaviour behind it. With several, a
   * caller that does not name one is ambiguous, and the ambiguity is resolved in
   * favour of the projected child — the one whose exit the sidebar is showing.
   */
  public stop(exitInfo: { signal: NodeJS.Signals | null; pid?: number }): void {
    const pid = exitInfo.pid ?? this.projectedPid ?? this.firstSeriesPid();
    if (pid === null) return;
    const entry = this.series.get(pid);
    if (entry === undefined) return;
    this.series.delete(pid);
    if (this.projectedPid === pid) this.projectedPid = this.firstSeriesPid();
    if (this.series.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const finalSample = synthesizeExitSample({
      pid,
      signal: exitInfo.signal,
      startedAt: entry.startedAt,
      now: this.now(),
      lastLive: entry.lastLive
        ? {
            cpuPercent: entry.lastLive.cpuPercent,
            memoryRssBytes: entry.lastLive.memoryRssBytes
          }
        : null
    });
    // Only the projected child's exit reaches the projection, for the same
    // reason only its samples do.
    if (pid === (this.projectedPid ?? pid)) this.safeOnSample(finalSample);

    // Schedule null clear on the microtask boundary so the projector's
    // debounce coalesces appropriately.
    queueMicrotask(() => {
      if (this.series.size === 0) this.safeOnSample(null);
    });
  }

  public current(): TelemetrySnapshot | null {
    return this.projectedPid === null
      ? null
      : (this.series.get(this.projectedPid)?.lastLive ?? null);
  }

  /**
   * FR-R3-081 (T1083) — every sampled child's latest sample.
   *
   * This is what makes "every concurrent run is sampled" checkable, and it is
   * what the aggregate measurement (T1079) reads. `current()` above answers for
   * the projection and is deliberately narrower.
   */
  public currentByPid(): ReadonlyMap<number, TelemetrySnapshot | null> {
    return new Map([...this.series].map(([pid, entry]) => [pid, entry.lastLive]));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Every series, not just the projected one: disposal ends the window.
    for (const pid of [...this.series.keys()]) this.stop({ signal: null, pid });
  }

  /**
   * The lowest-ceremony "any registered pid", written as a loop rather than an
   * indexed read: with `noUncheckedIndexedAccess` off, `[...keys][0]` is typed
   * `number` and the `?? null` beside it reads as dead code to the linter while
   * being load-bearing at runtime.
   */
  private firstSeriesPid(): number | null {
    for (const pid of this.series.keys()) return pid;
    return null;
  }

  private async tick(): Promise<void> {
    // Every registered child on one interval. Sequential rather than parallel:
    // each sample is a shell-out, and N concurrent shell-outs on every tick is a
    // load the thing being measured would notice.
    for (const pid of [...this.series.keys()]) await this.tickPid(pid);
  }

  private async tickPid(pid: number): Promise<void> {
    if (!this.series.has(pid)) return;
    let snap: TelemetrySnapshot | null = null;
    try {
      snap = await this.shellOutFn(pid);
    } catch {
      snap = null;
    }
    // Re-check registration after the async hop — `stop()` may have fired while
    // the shell-out was in flight; do not emit a live sample after stop.
    const entry = this.series.get(pid);
    if (entry === undefined) return;
    if (snap === null) {
      const errorClass: FailureClass = 'unknown';
      this.warnOnce(pid, errorClass);
      if (pid === this.projectedPid) this.safeOnSample(this.buildUnavailable(pid));
      return;
    }
    entry.lastLive = snap;
    if (pid === this.projectedPid) this.safeOnSample(snap);
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
      const pid = this.projectedPid;
      if (pid !== null) {
        this.warnOnce(pid, 'unknown');
      }
    }
  }
}
