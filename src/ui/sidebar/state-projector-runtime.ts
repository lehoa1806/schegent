import type { AuditAppendListener, AuditDisposable } from '../../audit/audit-log-writer';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { SanitizedLogger } from '../../lib/logger';
import type { Disposable, StoreChangeListener } from '../../state/workspace-state';
import type { StateProjectorDeps, ProjectorListener, ProjectorTimer } from './state-projector';
import { buildIdleSnapshot, type AuditTailEntry, type WorkflowSnapshot } from './snapshot';
import { AuditTailState } from './audit-tail-state';
import { ProjectorBookkeeping } from './projector-bookkeeping';
import { composeWorkflowSnapshot } from './snapshot-composer';

const STUB_STORE: NonNullable<StateProjectorDeps['store']> = Object.freeze({
  getRun: () => null,
  getQueue: () => ({
    requests: [], inFlightId: null, paused: false, pausedReason: null,
    updatedAt: 0, queueLifecycle: 'active-empty' as const,
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
  private readonly timer: ProjectorTimer;
  private readonly now: () => Date;
  private readonly logger: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> | null;
  private readonly listeners = new Set<ProjectorListener>();
  private readonly auditTailState = new AuditTailState();
  private readonly bookkeeping: ProjectorBookkeeping;
  private storeSub: Disposable | null = null;
  private auditSub: AuditDisposable | null = null;
  private monitorSub: Disposable | null = null;
  private historySub: Disposable | null = null;
  private debounceHandle: unknown = null;
  private tickHandle: unknown = null;
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
    this.logger = deps.logger ?? null;
    this.bookkeeping = new ProjectorBookkeeping(monotonicNow);
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
      this.bookkeeping.recordAudit(entry, projected);
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
    const run = this.store.getRun();
    this.bookkeeping.updateRun(
      run,
      this.deps.monitor ?? null,
      () => this.cancelTick()
    );
    return composeWorkflowSnapshot({
      deps: this.deps,
      store: this.store,
      run,
      ownerId: this.ownerId,
      forcedIsPrimary: this.forcedIsPrimary,
      now: this.now,
      logger: this.logger,
      externalSanitize: this.externalSanitize,
      monitor: this.deps.monitor ?? null,
      history: this.deps.history ?? null,
      defaultRunnerKind: this.deps.defaultRunnerKind ?? 'claude',
      auditTail: this.auditTailState.snapshot(),
      bookkeeping: this.bookkeeping,
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

  private scheduleProjection(): void {
    if (this.disposed) return;
    if (this.debounceHandle !== null) this.timer.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timer.setTimeout(() => {
      this.debounceHandle = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.disposed) return;
    const snapshot = this.project();
    this.currentSnapshot = snapshot;
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* listener isolation */ }
    }
    this.rearmTick();
  }

  private rearmTick(): void {
    if (this.disposed || this.tickHandle !== null) return;
    if (this.bookkeeping.observedStatus !== 'running') return;
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
