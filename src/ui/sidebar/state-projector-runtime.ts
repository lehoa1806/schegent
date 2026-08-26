import type { AuditAppendListener, AuditDisposable } from '../../audit/audit-log-writer';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { SanitizedLogger } from '../../lib/logger';
import type { Disposable, StoreChangeListener } from '../../state/workspace-state';
import type { StateProjectorDeps, ProjectorListener, ProjectorTimer } from './state-projector';
import { DEFAULT_MAX_WAIT_MS } from './state-projector';
import { buildIdleSnapshot, type AuditTailEntry, type WorkflowSnapshot } from './snapshot';
import { AuditTailState } from './audit-tail-state';
import { ProjectorBookkeepingRegistry } from './projector-bookkeeping-registry';
import { composeWorkflowSnapshot } from './snapshot-composer';

const STUB_STORE: NonNullable<StateProjectorDeps['store']> = Object.freeze({
  getRunMap: () => ({}),
  // FR-R3-002 (T281) — the parameter is declared even though the stub ignores
  // it. TypeScript accepts a zero-parameter function where a one-parameter one
  // is expected, so a stub written `getQueue: () => …` reintroduces the ambient
  // shape the requirement removed without the compiler saying a word.
  getQueue: (_queueId: string) => ({
    requests: [], inFlightId: null, pausedReason: null,
    updatedAt: 0, queueLifecycle: 'active-empty' as const, pauseSource: null,
    scheduledStartAt: null, scheduledStartSource: null
  }),
  getLock: () => null,
  subscribe: () => ({ dispose: () => {} })
});

const STUB_AUDIT: NonNullable<StateProjectorDeps['audit']> = Object.freeze({
  subscribe: () => ({ dispose: () => {} }), logPath: '', workspaceRoot: ''
});

/** Internal lifecycle owner behind the deliberately small public facade. */
export class StateProjectorRuntime {
  private readonly store: NonNullable<StateProjectorDeps['store']>;
  private readonly audit: NonNullable<StateProjectorDeps['audit']>;
  private readonly ownerId: string;
  private readonly forcedIsPrimary: boolean | null;
  private readonly externalSanitize: ((value: string | null | undefined) => string) | null;
  private readonly debounceMs: number;
  private readonly tickIntervalMs: number;
  private readonly maxWaitMs: number;
  /**
   * Monotonic clock, for the max-wait deadline (FR-R3-106).
   *
   * Monotonic rather than wall-clock deliberately: a deadline measured with `Date.now()`
   * would move if the system clock stepped, and the failure would be a display that froze
   * or thrashed for a reason nothing in this file could explain. The same clock already
   * drives the bookkeepers, so the projector keeps one notion of elapsed time.
   */
  private readonly monotonicNow: () => number;
  private readonly timer: ProjectorTimer;
  private readonly now: () => Date;
  private readonly logger: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> | null;
  private readonly listeners = new Set<ProjectorListener>();
  private readonly auditTailState = new AuditTailState();
  private readonly bookkeepers: ProjectorBookkeepingRegistry;
  private storeSub: Disposable | null = null;
  private auditSub: AuditDisposable | null = null;
  private monitorSub: Disposable | null = null;
  private historySub: Disposable | null = null;
  private debounceHandle: unknown = null;
  private tickHandle: unknown = null;
  /**
   * FR-R3-106 (FR-069) — when the current burst of events started, or `null` between
   * bursts. The max-wait deadline is measured from this rather than from the last event.
   */
  private burstStartedAt: number | null = null;
  private currentSnapshot: WorkflowSnapshot;
  private disposed = false;
  private started = false;
  private stagedTelemetry: TelemetrySnapshot | null = null;

  constructor(private readonly deps: StateProjectorDeps) {
    this.store = deps.store ?? STUB_STORE;
    this.audit = deps.audit ?? STUB_AUDIT;
    this.ownerId = deps.ownerId ?? 'projector-test-owner';
    this.forcedIsPrimary = typeof deps.isPrimary === 'boolean' ? deps.isPrimary : null;
    this.externalSanitize = deps.sanitize ?? null;
    this.debounceMs = deps.debounceMs ?? 100;
    this.tickIntervalMs = deps.tickIntervalMs ?? 1_000;
    this.maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.timer = deps.timer ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>
      )
    };
    this.now = deps.now ?? (() => new Date());
    const monotonicNow = deps.monotonicNow ?? (() => {
      const perf = (globalThis as { performance?: { now: () => number } }).performance;
      return perf ? perf.now() : Date.now();
    });
    this.monotonicNow = monotonicNow;
    this.logger = deps.logger ?? null;
    this.bookkeepers = new ProjectorBookkeepingRegistry(monotonicNow);
    try {
      this.currentSnapshot = this.project();
    } catch {
      this.currentSnapshot = buildIdleSnapshot({
        isPrimary: true, producedAt: this.now().toISOString()
      });
    }
  }

  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const onStore: StoreChangeListener = () => this.scheduleProjection();
    const onAudit: AuditAppendListener = (entry) => {
      const projected = this.auditTailState.append(entry);
      this.bookkeepers.recordAudit(entry, projected);
      this.scheduleProjection();
    };
    this.storeSub = this.store.subscribe(onStore);
    this.auditSub = this.audit.subscribe(onAudit);
    this.monitorSub = this.deps.monitor?.subscribe(() => this.scheduleProjection()) ?? null;
    this.historySub = this.deps.history?.subscribe(() => this.scheduleProjection()) ?? null;
    this.currentSnapshot = this.project();
    this.rearmTick();
  }

  public getCurrentSnapshot(): WorkflowSnapshot { return this.currentSnapshot; }
  public kick(): void { this.scheduleProjection(); }

  public updateTelemetry(snapshot: TelemetrySnapshot | null): void {
    if (this.disposed) return;
    if (snapshot === null) {
      this.stagedTelemetry = null;
      this.scheduleProjection();
      return;
    }
    const sanitize = this.logger
      ? (value: string) => this.logger!.sanitize(value)
      : this.externalSanitize ?? ((value: string) => value);
    this.stagedTelemetry = Object.freeze({
      pid: snapshot.pid,
      status: sanitize(snapshot.status) as TelemetrySnapshot['status'],
      cpuPercent: snapshot.cpuPercent === null ? null : Math.max(0, snapshot.cpuPercent),
      memoryRssBytes: snapshot.memoryRssBytes === null
        ? null : Math.max(0, snapshot.memoryRssBytes),
      uptimeMs: snapshot.uptimeMs === null ? null : Math.max(0, snapshot.uptimeMs),
      sampledAt: snapshot.sampledAt
    });
    this.scheduleProjection();
  }

  public subscribe(listener: ProjectorListener): Disposable {
    this.listeners.add(listener);
    if (this.auditTailState.beginHydration()) void this.hydrateInitialTail();
    try { listener(this.currentSnapshot); } catch { /* listener isolation */ }
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  public seedAuditTail(entries: readonly AuditTailEntry[]): void {
    this.auditTailState.seed(entries);
    this.currentSnapshot = this.project();
  }

  public project(): WorkflowSnapshot {
    // Feature 093 (T025) — pattern D. A projection legitimately wants every
    // Run, so it reads the whole record rather than naming one queue; this is
    // the aggregate case SC-012 exempts, not a Run reached without a queue.
    //
    // Feature 093 (T051) — the whole record now reaches the composer. The
    // collapse to `[0]` this replaces was accurate only while drain step 4b
    // held the record to one entry, and it decided *which* queue the sidebar
    // showed by insertion order.
    const runs = this.store.getRunMap();
    this.bookkeepers.reconcile(runs, this.deps.monitor ?? null);
    // The 1 Hz tick is the window's, so only the window can retire it: a single
    // Run reaching a terminal status must not stop the refresh its siblings are
    // still using. `ProjectorBookkeeping` used to cancel from inside its own
    // update for want of anywhere else to ask.
    if (!this.bookkeepers.anyRunning) this.cancelTick();
    return composeWorkflowSnapshot({
      deps: this.deps,
      store: this.store,
      runs,
      ownerId: this.ownerId,
      forcedIsPrimary: this.forcedIsPrimary,
      now: this.now,
      logger: this.logger,
      externalSanitize: this.externalSanitize,
      monitor: this.deps.monitor ?? null,
      history: this.deps.history ?? null,
      defaultRunnerKind: this.deps.defaultRunnerKind ?? 'claude',
      auditTail: this.auditTailState.snapshot(),
      bookkeepers: this.bookkeepers,
      telemetry: this.stagedTelemetry
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceHandle !== null) this.timer.clearTimeout(this.debounceHandle);
    this.debounceHandle = null;
    this.cancelTick();
    for (const subscription of [
      this.storeSub, this.auditSub, this.monitorSub, this.historySub
    ]) subscription?.dispose();
    this.storeSub = this.auditSub = this.monitorSub = this.historySub = null;
    this.listeners.clear();
  }

  private async hydrateInitialTail(): Promise<void> {
    const tail = await this.auditTailState.readColdStart(
      this.audit.workspaceRoot,
      this.logger as SanitizedLogger | undefined
    );
    if (this.disposed || !this.auditTailState.mergeColdStart(tail)) return;
    this.scheduleProjection();
  }

  /**
   * Trailing debounce **with a deadline** (FR-R3-106, FR-069).
   *
   * THE STARVATION THIS FIXES. This was a pure trailing debounce: every event cleared the
   * pending timer and re-armed it, so under sustained sub-`debounceMs` output the timer
   * never fired at all. Eight event sources feed this projector, and a busy run produces
   * exactly that stream — so the display froze on a stale frame at the moment the run was
   * busiest, which is when an operator is most likely to be watching.
   *
   * It was also **hidden**: webview-local timers keep ticking, so elapsed counters kept
   * moving on a frame that was no longer being refreshed. And it self-healed at the first
   * gap ≥ `debounceMs`, which is why it never presented as a reproducible bug.
   *
   * The 1 Hz tick could not rescue it either: `rearmTick()` is called only from `flush()`,
   * so a projector that never flushed never re-armed its tick.
   *
   * THE DEADLINE. `burstStartedAt` records when the current burst began; once
   * `maxWaitMs` has elapsed since then, the next event flushes immediately instead of
   * re-arming. So a quiet stream still coalesces (the trailing debounce is unchanged) and
   * a saturated one is bounded — the display can be at most `maxWaitMs` stale.
   *
   * `debounceMs` and `tickIntervalMs` are unchanged: this changes what FEEDS them.
   */
  private scheduleProjection(): void {
    if (this.disposed) return;
    const now = this.monotonicNow();
    if (this.burstStartedAt === null) this.burstStartedAt = now;
    else if (now - this.burstStartedAt >= this.maxWaitMs) {
      // The deadline has passed: flush now rather than re-arming into a timer that a
      // sustained stream will keep pushing away.
      if (this.debounceHandle !== null) this.timer.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
      this.flush();
      return;
    }
    if (this.debounceHandle !== null) this.timer.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timer.setTimeout(() => {
      this.debounceHandle = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.disposed) return;
    // The burst is over: the next event starts a fresh deadline window. Reset here rather
    // than in `scheduleProjection` so a flush from ANY path — the debounce, the deadline,
    // or the tick — ends the window it belongs to.
    this.burstStartedAt = null;
    const snapshot = this.project();
    this.currentSnapshot = snapshot;
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* listener isolation */ }
    }
    this.rearmTick();
  }

  private rearmTick(): void {
    if (this.disposed || this.tickHandle !== null) return;
    if (!this.bookkeepers.anyRunning) return;
    this.tickHandle = this.timer.setTimeout(() => {
      this.tickHandle = null;
      this.scheduleProjection();
    }, this.tickIntervalMs);
  }

  private cancelTick(): void {
    if (this.tickHandle === null) return;
    this.timer.clearTimeout(this.tickHandle);
    this.tickHandle = null;
  }
}
