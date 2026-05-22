import type { AuditAppendListener, AuditDisposable, AuditLogWriter } from '../../audit/audit-log-writer';
import type { AuditEntry } from '../../audit/audit-entry';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
import type { SanitizedLogger } from '../../lib/logger';
import { parseAuditLogLine } from '../../parser/audit-log-parser';
import { getResolvedCapabilities } from '../../state/capability-trust-resolver';
import type {
  Disposable,
  StoreChangeListener,
  WorkspaceStateStore
} from '../../state/workspace-state';
import type { WorkflowRun } from '../../state/workflow-run';
import { RUNNER_DEFAULT_MODEL, type WakeUpModelSelection } from '../../wakeup/settings';
import { computeFreshness } from './freshness';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { HistoryStore } from '../../state/history-store';
import {
  AUDIT_TAIL_MAX,
  IDLE_LIVE_ACTIVITY,
  IDLE_GENERAL_SETTINGS,
  IDLE_TRUST_PROJECTION,
  IDLE_WAKEUP_LOG,
  IDLE_WAKEUP_SETTINGS,
  SCHEMA_VERSION,
  buildIdleSnapshot,
  type AuditCategory,
  type AuditTailEntry,
  type FreshnessState,
  type GeneralSettings,
  type HistoryEntry,
  type LiveActivity,
  type PhaseName,
  type PhaseTile,
  type QueueProjection,
  type WakeUpSettings,
  type WakeUpLogProjection,
  type WorkflowSnapshot,
  type WorkflowStatus
} from './snapshot';
// Feature 013 — Wave 7 (US7) / 048: projection helpers live in dedicated
// files. `state-projector.ts` is the orchestrator that owns mutable
// bookkeeping (monotonic timers, transition detection) and delegates each
// shape transformation to a pure projector module.
import { sanitizeAndCap, projectQueue } from './queue-projector';
import { projectAuditEntry } from './audit-tail-projector';
import { projectHistory } from './history-projector';
import { projectMonitor } from './monitor-projector';
import {
  buildPhasesFromRun,
  computeSubProgressForTile
} from './phase-projector';
import {
  buildActiveFeature,
  computeIsPrimary,
  mapRunStatus,
  projectDelayedRetry
} from './run-projector';

// Re-export public helpers so existing consumers (tests, validators
// cross-referencing the floor) keep working without import churn.
export { sanitizeAndCap, PAUSED_REASON_MAX_LENGTH } from './queue-projector';
export { projectAuditEntry } from './audit-tail-projector';

export interface ProjectorTimer {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface InitialTailReader {
  readTail(filePath: string, maxLines: number): Promise<readonly string[]>;
}

export interface StateProjectorDeps {
  readonly store?: Pick<WorkspaceStateStore, 'getRun' | 'getQueue' | 'getLock' | 'subscribe'> &
  Partial<Pick<WorkspaceStateStore, 'getQueueRegistry' | 'getConfirmSuppression'>>;
  readonly audit?: Pick<AuditLogWriter, 'subscribe' | 'logPath'>;
  readonly ownerId?: string;
  /**
   * Feature 031 — test seam: when set, forces `isPrimary` to the given
   * value instead of computing it from the lock. Production wiring leaves
   * this undefined so the lock-based computation in `computeIsPrimary`
   * runs (unchanged).
   */
  readonly isPrimary?: boolean;
  /**
   * Feature 031 — test seam: lets a unit test pass an explicit sanitizer
   * without constructing a full `SanitizedLogger`. The projector still
   * prefers `logger.sanitize` when both are present.
   */
  readonly sanitize?: (s: string | null | undefined) => string;
  readonly debounceMs?: number;
  readonly tickIntervalMs?: number;
  readonly timer?: ProjectorTimer;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly initialTailReader?: InitialTailReader;
  // Feature 013 — US4: `sanitize` is now required on the picked logger
  // surface because the projector applies the redaction set to the
  // queue-level `pausedReason` before it reaches the webview.
  // `warn` continues to be used for the audit-tail read path.
  readonly logger?: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'>;
  readonly monitor?: Pick<ClaudeCliMonitor, 'getCurrentState' | 'subscribe' | 'onWorkflowPaused' | 'onWorkflowResumed'> | null;
  readonly history?: Pick<HistoryStore, 'list' | 'subscribe'> | null;
  readonly getCatalog?: () => { phases: readonly import('../../config/pipeline-config').PhaseDef[], pipelines: readonly import('../../config/pipeline-config').PipelineDef[], models: readonly string[] };
  /**
   * Feature 011 — read the current scalar `schegent.*` settings for the
   * Settings surface. Invoked on every projection; the projector also
   * re-runs when the extension's `onDidChangeConfiguration` listener
   * calls `scheduleProjection()` so workspace edits surface within the
   * 1s latency budget (FR-017).
   */
  readonly getGeneralSettings?: () => GeneralSettings;
  /**
   * Feature 014 (BUG-001 / BUG-002) — read the four `schegent.wakeUp.*`
   * settings (Global scope) for the Settings surface. Invoked on every
   * projection so the WakeUpTab can hydrate its draft and resync via
   * `$effect` when the projection changes (FR-025 / SC-010), paralleling
   * `getGeneralSettings`.
   */
  readonly getWakeUpSettings?: () => WakeUpSettings;
  /**
   * Feature 024 — read the sanitized newest wake-up attempts for the
   * Wake up Settings tab. Kept synchronous so projection remains a
   * single immutable snapshot build.
   */
  readonly getWakeUpLog?: () => WakeUpLogProjection;
  /**
   * Feature 031 §FR-002 / data-model §7 — operator's current wake-up
   * model selection (closed `WakeUpModelSelection` union). Surfaces on
   * `snapshot.wakeUp.model` for the dropdown. Defaults to
   * `RUNNER_DEFAULT_MODEL` when the host has not wired the dep yet.
   */
  readonly getWakeupModel?: () => WakeUpModelSelection;
  /**
   * Feature 031 §FR-008 / data-model §7 — host-composed absolute path
   * to `<globalStorageUri>/wakeup/session.log`. Surfaces on
   * `snapshot.wakeUp.sessionLogPath` as a DISPLAY-ONLY string; the
   * webview never echoes this back to the host (the
   * `CMD_READ_WAKEUP_SESSION_LOG` payload carries `correlationId` only).
   */
  readonly getWakeupSessionLogPath?: () => string;
  /**
   * Feature 026 — read the current per-phase precedence projection for
   * the Pipeline Builder UI. Invoked on every projection. The provider
   * is responsible for caching the projection between catalog reloads;
   * the projector merely surfaces the returned plain object onto the
   * `WorkflowSnapshot.phasePrecedence` field. Returning `undefined`
   * (or omitting the dep) results in the field being absent on the
   * snapshot, which the webview treats as "no precedence data yet".
   */
  readonly getPhasePrecedence?: () =>
    | import('../../config/phase-precedence').PhasePrecedenceProjection
    | undefined;
  /**
   * Feature 063 (T030) — read the current value of the
   * `schegent.ui.confirmations.enable` config flag. Invoked on every
   * projection so toggling the workspace setting takes effect on the
   * next push. Returning `undefined` (or omitting the dep) results in
   * the field being absent on the snapshot, which the webview treats
   * as "prompts enabled" (default).
   */
  readonly getConfirmationsEnabled?: () => boolean;
}

export type ProjectorListener = (snapshot: WorkflowSnapshot) => void;

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_TICK_INTERVAL_MS = 1_000;

interface ActivityCache {
  readonly summary: string;
  readonly category: AuditCategory;
  readonly isoAt: string;
}

// Stub store/audit used when the projector is constructed without a
// concrete `store`/`audit` (test seam — feature 031 T014). The stubs
// return idle/empty values so `project()` and `start()` are safe to call.
const STUB_STORE: NonNullable<StateProjectorDeps['store']> = Object.freeze({
  getRun: () => null,
  getQueue: () => ({
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 0,
    queueLifecycle: 'active-empty' as const,
    scheduledStartAt: null,
    scheduledStartSource: null
  }),
  getLock: () => null,
  subscribe: () => ({ dispose: () => { /* noop */ } })
});

const STUB_AUDIT: NonNullable<StateProjectorDeps['audit']> = Object.freeze({
  subscribe: () => ({ dispose: () => { /* noop */ } }),
  logPath: ''
});

export class StateProjector {
  private readonly store: NonNullable<StateProjectorDeps['store']>;
  private readonly audit: NonNullable<StateProjectorDeps['audit']>;
  private readonly ownerId: string;
  private readonly forcedIsPrimary: boolean | null;
  private readonly externalSanitize: ((s: string | null | undefined) => string) | null;
  private readonly debounceMs: number;
  private readonly tickIntervalMs: number;
  private readonly timer: ProjectorTimer;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly initialTailReader: InitialTailReader | null;
  private readonly logger: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> | null;

  private readonly listeners = new Set<ProjectorListener>();
  private readonly auditTail: AuditTailEntry[] = [];
  private readonly monitor: Pick<ClaudeCliMonitor, 'getCurrentState' | 'subscribe' | 'onWorkflowPaused' | 'onWorkflowResumed'> | null;
  private readonly history: Pick<HistoryStore, 'list' | 'subscribe'> | null;
  private readonly getCatalog?: () => { phases: readonly import('../../config/pipeline-config').PhaseDef[], pipelines: readonly import('../../config/pipeline-config').PipelineDef[], models: readonly string[] };
  private readonly getGeneralSettings?: () => GeneralSettings;
  private readonly getWakeUpSettings?: () => WakeUpSettings;
  private readonly getWakeUpLog?: () => WakeUpLogProjection;
  private readonly getWakeupModel?: () => WakeUpModelSelection;
  private readonly getWakeupSessionLogPath?: () => string;
  private readonly getPhasePrecedence?: () =>
    | import('../../config/phase-precedence').PhasePrecedenceProjection
    | undefined;
  private readonly getConfirmationsEnabled?: () => boolean;

  private storeSub: Disposable | null = null;
  private auditSub: AuditDisposable | null = null;
  private monitorSub: Disposable | null = null;
  private historySub: Disposable | null = null;
  private debounceHandle: unknown = null;
  private tickHandle: unknown = null;
  private currentSnapshot: WorkflowSnapshot;
  private disposed = false;
  private started = false;
  private tailHydrationStarted = false;

  // Monotonic-time bookkeeping (not serialized)
  private workflowStartMonotonic: number | null = null;
  private phaseStartMonotonic: number | null = null;
  private readonly cumulativePhaseMs = new Map<PhaseName, number>();
  private cumulativePausedMs = 0;
  private pausedSinceMonotonic: number | null = null;
  private lastActivityAtMonotonic: number | null = null;
  private lastActivityCache: ActivityCache | null = null;
  private readonly subProgressByPhase = new Map<PhaseName, { current: number; total: number }>();
  private readonly phaseMessageByPhase = new Map<
    PhaseName,
    NonNullable<PhaseTile['phaseMessage']>
  >();

  // Last observed run snapshot (for transition detection)
  private observedRunId: string | null = null;
  private observedPhase: PhaseName | null = null;
  private observedStatus: WorkflowStatus = 'idle';

  // Feature 033 — staged telemetry sample. Flushed onto the next
  // snapshot publish, then cleared so the projection naturally falls
  // back to `null` when no sample arrives between publishes.
  // FR-021: a slow sampler does not block phase-end publishes; a fast
  // sampler does not flood IPC because `scheduleProjection()` debounces
  // on `debounceMs`.
  private stagedTelemetry: TelemetrySnapshot | null = null;

  constructor(deps: StateProjectorDeps) {
    this.store = deps.store ?? STUB_STORE;
    this.audit = deps.audit ?? STUB_AUDIT;
    this.ownerId = deps.ownerId ?? 'projector-test-owner';
    this.forcedIsPrimary = typeof deps.isPrimary === 'boolean' ? deps.isPrimary : null;
    this.externalSanitize = deps.sanitize ?? null;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = deps.timer ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>)
    };
    this.now = deps.now ?? (() => new Date());
    this.monotonicNow = deps.monotonicNow ?? (() => {
      const perf = (globalThis as { performance?: { now: () => number } }).performance;
      return perf ? perf.now() : Date.now();
    });
    this.initialTailReader = deps.initialTailReader ?? null;
    this.logger = deps.logger ?? null;
    this.monitor = deps.monitor ?? null;
    this.history = deps.history ?? null;
    this.getCatalog = deps.getCatalog;
    this.getGeneralSettings = deps.getGeneralSettings;
    this.getWakeUpSettings = deps.getWakeUpSettings;
    this.getWakeUpLog = deps.getWakeUpLog;
    this.getWakeupModel = deps.getWakeupModel;
    this.getWakeupSessionLogPath = deps.getWakeupSessionLogPath;
    this.getPhasePrecedence = deps.getPhasePrecedence;
    this.getConfirmationsEnabled = deps.getConfirmationsEnabled;
    // Feature 059 — populate the initial snapshot via a real `project()`
    // so the first `subscribe()` delivers fresh trust + queue values
    // without requiring `start()` to be called first. The projection is
    // pure (read-only across the wired deps) and the trust path is
    // fail-closed via try/catch inside `project()`. If something throws
    // before the first projection completes, fall back to the static
    // idle snapshot.
    try {
      this.currentSnapshot = this.project();
    } catch {
      this.currentSnapshot = buildIdleSnapshot({
        isPrimary: true,
        producedAt: this.now().toISOString()
      });
    }
  }

  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const onStore: StoreChangeListener = () => this.scheduleProjection();
    const onAudit: AuditAppendListener = (entry) => {
      this.appendAuditEntry(entry);
      this.scheduleProjection();
    };
    this.storeSub = this.store.subscribe(onStore);
    this.auditSub = this.audit.subscribe(onAudit);
    if (this.monitor) {
      this.monitorSub = this.monitor.subscribe(() => this.scheduleProjection());
    }
    if (this.history) {
      this.historySub = this.history.subscribe(() => this.scheduleProjection());
    }
    this.currentSnapshot = this.project();
    this.rearmTick();
  }

  public getCurrentSnapshot(): WorkflowSnapshot {
    return this.currentSnapshot;
  }

  /**
   * Feature 011 — force a re-projection. The extension's
   * `onDidChangeConfiguration` listener calls this when any `schegent.*`
   * key changes so the Settings surface sees the new value within
   * FR-017's 1s budget.
   */
  public kick(): void {
    this.scheduleProjection();
  }

  /**
   * Feature 033 — accept a telemetry sample from the
   * `TelemetrySampler`'s `onSample` callback. Runs the status string
   * through the existing `SanitizedLogger.sanitize` once (single
   * sanitization point — FR-022) and clamps numeric fields to
   * non-negative ranges before staging the value for the next snapshot
   * publish. Passing `null` clears the staged sample, which propagates
   * `telemetry: null` on the next published envelope.
   *
   * The projector debounces via `scheduleProjection()` so a fast
   * sampler does not flood IPC; a slow sampler does not block
   * phase-end publishes because the next published snapshot reads the
   * latest staged value regardless of who triggered the publish.
   */
  public updateTelemetry(snap: TelemetrySnapshot | null): void {
    if (this.disposed) return;
    if (snap === null) {
      this.stagedTelemetry = null;
      this.scheduleProjection();
      return;
    }
    const sanitizeFn = this.logger
      ? (s: string): string => this.logger!.sanitize(s)
      : this.externalSanitize
        ? this.externalSanitize
        : (s: string): string => s;
    const sanitizedStatus = sanitizeFn(snap.status) as TelemetrySnapshot['status'];
    const cpu = snap.cpuPercent === null ? null : Math.max(0, snap.cpuPercent);
    const rss = snap.memoryRssBytes === null ? null : Math.max(0, snap.memoryRssBytes);
    const uptime = snap.uptimeMs === null ? null : Math.max(0, snap.uptimeMs);
    this.stagedTelemetry = Object.freeze({
      pid: snap.pid,
      status: sanitizedStatus,
      cpuPercent: cpu,
      memoryRssBytes: rss,
      uptimeMs: uptime,
      sampledAt: snap.sampledAt
    });
    this.scheduleProjection();
  }

  public subscribe(listener: ProjectorListener): Disposable {
    this.listeners.add(listener);
    if (!this.tailHydrationStarted) {
      this.tailHydrationStarted = true;
      void this.hydrateInitialTail();
    }
    try {
      listener(this.currentSnapshot);
    } catch {
      // listener errors must not affect the projector
    }
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  private async hydrateInitialTail(): Promise<void> {
    if (!this.initialTailReader) return;
    let lines: readonly string[];
    try {
      lines = await this.initialTailReader.readTail(this.audit.logPath, AUDIT_TAIL_MAX);
    } catch (err) {
      this.logger?.warn(`projector: failed to read initial audit tail: ${(err as Error).message}`);
      return;
    }
    if (this.disposed) return;
    let warnedOnce = false;
    const parsedEntries: AuditEntry[] = [];
    for (const line of lines) {
      const entry = parseAuditLogLine(line);
      if (entry) parsedEntries.push(entry);
      else if (!warnedOnce) {
        this.logger?.debug('projector: dropped unparseable audit log line(s)');
        warnedOnce = true;
      }
    }
    if (this.auditTail.length === 0 && parsedEntries.length > 0) {
      for (const entry of parsedEntries) this.auditTail.push(projectAuditEntry(entry));
      if (this.auditTail.length > AUDIT_TAIL_MAX) {
        this.auditTail.splice(0, this.auditTail.length - AUDIT_TAIL_MAX);
      }
      this.scheduleProjection();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceHandle !== null) {
      this.timer.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    this.cancelTick();
    this.storeSub?.dispose();
    this.auditSub?.dispose();
    this.monitorSub?.dispose();
    this.historySub?.dispose();
    this.storeSub = null;
    this.auditSub = null;
    this.monitorSub = null;
    this.historySub = null;
    this.listeners.clear();
  }

  public seedAuditTail(entries: readonly AuditTailEntry[]): void {
    this.auditTail.length = 0;
    for (const entry of entries.slice(-AUDIT_TAIL_MAX)) this.auditTail.push(entry);
    this.currentSnapshot = this.project();
  }

  private scheduleProjection(): void {
    if (this.disposed) return;
    if (this.debounceHandle !== null) {
      this.timer.clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = this.timer.setTimeout(() => {
      this.debounceHandle = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.disposed) return;
    const snap = this.project();
    this.currentSnapshot = snap;
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // listener errors must not propagate
      }
    }
    this.rearmTick();
  }

  private rearmTick(): void {
    if (this.disposed) return;
    if (this.tickHandle !== null) return;
    if (this.observedStatus !== 'running') return;
    this.tickHandle = this.timer.setTimeout(() => {
      this.tickHandle = null;
      this.scheduleProjection();
    }, this.tickIntervalMs);
  }

  private cancelTick(): void {
    if (this.tickHandle !== null) {
      this.timer.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private appendAuditEntry(entry: AuditEntry): void {
    const projected = projectAuditEntry(entry);
    this.auditTail.push(projected);
    if (this.auditTail.length > AUDIT_TAIL_MAX) {
      this.auditTail.splice(0, this.auditTail.length - AUDIT_TAIL_MAX);
    }

    if (projected.category !== 'system') {
      this.lastActivityAtMonotonic = this.monotonicNow();
      this.lastActivityCache = {
        summary: projected.summary,
        category: projected.category,
        isoAt: projected.timestamp
      };
    }

    const phaseName = entry.phase === 'done' ? null : (entry.phase as PhaseName);
    if (phaseName) {
      if (
        entry.eventType === 'phase-message-emitted' ||
        entry.eventType === 'phase-message-truncated' ||
        entry.eventType === 'phase-message-invalid'
      ) {
        this.phaseMessageByPhase.set(phaseName, {
          fromPhaseId:
            typeof entry.payload.phaseId === 'string' ? entry.payload.phaseId : phaseName,
          entryCount:
            typeof entry.payload.entryCount === 'number' ? entry.payload.entryCount : 0,
          byteSize: typeof entry.payload.byteSize === 'number' ? entry.payload.byteSize : 0,
          truncated: entry.eventType === 'phase-message-truncated',
          invalidReason:
            entry.eventType === 'phase-message-invalid'
              ? String(entry.payload.reason ?? 'invalid')
              : null
        });
      }
      const tasksCompleted = entry.payload?.tasksCompleted;
      const tasksTotal = entry.payload?.tasksTotal;
      if (
        typeof tasksCompleted === 'number' &&
        typeof tasksTotal === 'number' &&
        Number.isFinite(tasksCompleted) &&
        Number.isFinite(tasksTotal) &&
        tasksCompleted >= 0 &&
        tasksTotal > 0
      ) {
        const existing = this.subProgressByPhase.get(phaseName);
        const nextCurrent = existing ? Math.max(existing.current, Math.floor(tasksCompleted)) : Math.floor(tasksCompleted);
        const clamped = Math.min(nextCurrent, Math.floor(tasksTotal));
        this.subProgressByPhase.set(phaseName, {
          current: clamped,
          total: Math.floor(tasksTotal)
        });
      }
    }
  }

  private updateBookkeeping(run: WorkflowRun | null): void {
    const monoNow = this.monotonicNow();

    if (!run) {
      if (this.observedRunId !== null) {
        this.workflowStartMonotonic = null;
        this.phaseStartMonotonic = null;
        this.cumulativePhaseMs.clear();
        this.cumulativePausedMs = 0;
        this.pausedSinceMonotonic = null;
        this.lastActivityAtMonotonic = null;
        this.lastActivityCache = null;
        this.subProgressByPhase.clear();
        this.phaseMessageByPhase.clear();
      }
      this.observedRunId = null;
      this.observedPhase = null;
      this.observedStatus = 'idle';
      this.cancelTick();
      return;
    }

    const newRunStatus = mapRunStatus(run);
    const newPhase: PhaseName | null = run.currentPhase === 'done' ? null : (run.currentPhase as PhaseName);

    if (run.id !== this.observedRunId) {
      this.workflowStartMonotonic = monoNow;
      this.phaseStartMonotonic = newPhase !== null ? monoNow : null;
      this.cumulativePhaseMs.clear();
      this.cumulativePausedMs = 0;
      this.pausedSinceMonotonic = newRunStatus === 'paused' ? monoNow : null;
      this.subProgressByPhase.clear();
      this.phaseMessageByPhase.clear();
      this.observedRunId = run.id;
      this.observedPhase = newPhase;
      this.observedStatus = newRunStatus;
      return;
    }

    const prevStatus = this.observedStatus;
    if (prevStatus === 'running' && newRunStatus === 'paused') {
      this.pausedSinceMonotonic = monoNow;
      try {
        this.monitor?.onWorkflowPaused();
      } catch { /* monitor errors must not propagate */ }
    } else if (prevStatus === 'paused' && newRunStatus === 'running') {
      if (this.pausedSinceMonotonic !== null) {
        this.cumulativePausedMs += monoNow - this.pausedSinceMonotonic;
        this.pausedSinceMonotonic = null;
      }
      try {
        this.monitor?.onWorkflowResumed();
      } catch { /* monitor errors must not propagate */ }
    }

    const prevPhase = this.observedPhase;
    if (prevPhase !== newPhase) {
      if (prevPhase !== null && this.phaseStartMonotonic !== null) {
        const rawElapsed = monoNow - this.phaseStartMonotonic;
        const prior = this.cumulativePhaseMs.get(prevPhase) ?? 0;
        this.cumulativePhaseMs.set(prevPhase, Math.max(0, prior + Math.max(0, rawElapsed)));
        this.subProgressByPhase.delete(prevPhase);
      }
      this.phaseStartMonotonic = newPhase !== null ? monoNow : null;
    }

    this.observedPhase = newPhase;
    this.observedStatus = newRunStatus;

    if (newRunStatus !== 'running') {
      this.cancelTick();
    }
  }

  private computePhaseElapsedMs(phaseName: PhaseName, isActive: boolean): number {
    const cumulative = this.cumulativePhaseMs.get(phaseName) ?? 0;
    if (!isActive || this.phaseStartMonotonic === null) {
      return Math.max(0, Math.floor(cumulative));
    }
    const monoNow = this.monotonicNow();
    const status = this.observedStatus;
    let activeMs: number;
    if (status === 'paused' && this.pausedSinceMonotonic !== null) {
      activeMs = this.pausedSinceMonotonic - this.phaseStartMonotonic;
    } else {
      activeMs = monoNow - this.phaseStartMonotonic;
    }
    return Math.max(0, Math.floor(cumulative + Math.max(0, activeMs)));
  }

  private computeWorkflowElapsedMs(): number | null {
    if (this.workflowStartMonotonic === null) return null;
    const monoNow = this.monotonicNow();
    const status = this.observedStatus;
    if (status === 'idle') return null;
    let totalMs: number;
    if (status === 'paused' && this.pausedSinceMonotonic !== null) {
      totalMs = this.pausedSinceMonotonic - this.workflowStartMonotonic - this.cumulativePausedMs;
    } else {
      totalMs = monoNow - this.workflowStartMonotonic - this.cumulativePausedMs;
    }
    return Math.max(0, Math.floor(totalMs));
  }

  private computeLiveActivity(status: WorkflowStatus): LiveActivity {
    if (status === 'idle' || status === 'completed' || status === 'canceled') {
      return IDLE_LIVE_ACTIVITY;
    }
    let msSince: number | null;
    if (this.lastActivityAtMonotonic === null) {
      msSince = null;
    } else if (status === 'paused' && this.pausedSinceMonotonic !== null) {
      msSince = Math.max(0, this.pausedSinceMonotonic - this.lastActivityAtMonotonic);
    } else {
      msSince = Math.max(0, this.monotonicNow() - this.lastActivityAtMonotonic);
    }
    const freshness: FreshnessState = computeFreshness(status, msSince);
    const staleSeconds =
      freshness === 'idle' || msSince === null ? null : Math.max(0, Math.floor(msSince / 1000));
    return Object.freeze({
      summary: this.lastActivityCache?.summary ?? null,
      category: this.lastActivityCache?.category ?? null,
      lastEventAt: this.lastActivityCache?.isoAt ?? null,
      freshness,
      staleSeconds: freshness === 'idle' ? null : staleSeconds
    });
  }

  /**
   * Build a `WorkflowSnapshot` from the current store/audit state. Public
   * so unit tests (feature 031 T014 et al) can call it directly without
   * driving the full subscription pipeline. Production wiring still
   * routes through `flush()` → `project()`.
   */
  public project(): WorkflowSnapshot {
    const run = this.store.getRun();
    this.updateBookkeeping(run);
    const queue = this.store.getQueue();
    const registry = this.store.getQueueRegistry ? this.store.getQueueRegistry() : undefined;
    const lock = this.store.getLock();
    // Feature 063 (FR-021) — surface the suppression set for the
    // webview so the confirmation modal can be skipped per action key.
    const confirmSuppression = this.store.getConfirmSuppression
      ? this.store.getConfirmSuppression()
      : undefined;
    // Feature 063 (T030) — surface the global confirmations toggle so
    // the webview's `useConfirm` helper can short-circuit when the
    // operator has disabled prompts workspace-wide.
    const confirmationsEnabled = this.getConfirmationsEnabled
      ? this.getConfirmationsEnabled()
      : undefined;
    const isPrimary =
      this.forcedIsPrimary !== null
        ? this.forcedIsPrimary
        : computeIsPrimary(this.ownerId, lock, this.now().getTime());
    const status: WorkflowStatus = run ? mapRunStatus(run) : 'idle';
    const phases = buildPhasesFromRun(run);
    for (const tile of phases) {
      const phaseMessage = this.phaseMessageByPhase.get(tile.name);
      if (phaseMessage) {
        (tile as { phaseMessage?: PhaseTile['phaseMessage'] }).phaseMessage = phaseMessage;
      }
    }
    this.applyPhaseElapsedAndSubProgress(phases, run);
    const activeFeature = run ? buildActiveFeature(run) : null;
    // Feature 013 — US4 (FR-015): `pausedReason` and queue-item summaries
    // both flow through the logger's redaction set. When the projector
    // runs without a logger (test seams), pass-through is a safe default
    // because tests don't construct payloads with real secrets.
    const externalSanitize = this.externalSanitize;
    const sanitize = (s: string): string =>
      this.logger
        ? this.logger.sanitize(s)
        : externalSanitize
          ? externalSanitize(s)
          : s;
    const inFlightPhase: PhaseName | null = run && run.currentPhase !== 'done' ? (run.currentPhase as PhaseName) : null;
    const queueProjection = projectQueue(queue, {
      sanitize,
      inFlightPhase,
      inFlightId: queue.inFlightId,
      registry,
      // Feature 028 — surface the run's breakpoint pause-cause so the
      // queue-projector can map it to task-level `'breakpoint'`.
      inFlightManualPauseCause: run?.manualPauseCause ?? null
    });
    const auditTail: readonly AuditTailEntry[] = this.auditTail.slice();
    const liveActivity = this.computeLiveActivity(status);
    const workflowElapsedMs = this.computeWorkflowElapsedMs();

    const monitorState = projectMonitor(this.monitor);
    const historyEntries = projectHistory(this.history);
    const activePipeline =
      run?.pipeline && run.pipeline.id !== 'standard'
        ? Object.freeze({ id: run.pipeline.id, name: run.pipeline.name })
        : undefined;
    const catalog = this.getCatalog ? this.getCatalog() : { phases: [], pipelines: [], models: [] };

    const delayedRetry = projectDelayedRetry(run);
    const generalSettings = this.getGeneralSettings
      ? this.getGeneralSettings()
      : IDLE_GENERAL_SETTINGS;
    const wakeUpSettings = this.getWakeUpSettings
      ? this.getWakeUpSettings()
      : IDLE_WAKEUP_SETTINGS;
    const wakeUpLog = this.getWakeUpLog
      ? this.getWakeUpLog()
      : IDLE_WAKEUP_LOG;
    const phasePrecedence = this.getPhasePrecedence
      ? this.getPhasePrecedence()
      : undefined;
    // Feature 031 T014 / data-model §7 — DISPLAY-ONLY projection of the
    // operator's wake-up model selection + the host-composed session-log
    // path. Always present so the webview never needs an existence
    // guard; defaults match the host wiring fallback.
    const wakeUp = Object.freeze({
      model: (this.getWakeupModel ? this.getWakeupModel() : RUNNER_DEFAULT_MODEL) as WakeUpModelSelection,
      sessionLogPath: this.getWakeupSessionLogPath ? this.getWakeupSessionLogPath() : ''
    });

    // Feature 059 — per-capability trust projection. Fail-closed on
    // resolver throw (FR-010d): all four booleans default to `false`
    // and a warning is logged once per failed projection.
    let workspaceTrust = IDLE_TRUST_PROJECTION.workspaceTrust;
    let resolvedTrust = IDLE_TRUST_PROJECTION.resolvedTrust;
    try {
      const resolved = getResolvedCapabilities();
      workspaceTrust = resolved.workspaceTrust;
      resolvedTrust = Object.freeze({
        phases: resolved.phases,
        retryConditions: resolved.retryConditions,
        pipelineOverrides: resolved.pipelineOverrides
      });
    } catch (err) {
      this.logger?.warn(
        `projector: failed to resolve trust capabilities: ${(err as Error).message}`
      );
    }

    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      isPrimary,
      status,
      activeFeature,
      phases: Object.freeze(phases.map((p) => Object.freeze(p))),
      queue: Object.freeze({
        inFlight: queueProjection.inFlight,
        pending: Object.freeze(queueProjection.pending.slice()),
        recent: Object.freeze(queueProjection.recent.slice()),
        queues: Object.freeze(queueProjection.queues.slice()),
        paused: queue.paused,
        pausedReason: sanitizeAndCap(queue.pausedReason, sanitize),
        // Feature 065 — additive lifecycle / scheduled-start projection.
        lifecycle: queue.queueLifecycle,
        scheduledStartAt: queue.scheduledStartAt,
        scheduledStartSource: queue.scheduledStartSource,
        // Feature 065 (T054a / FR-020) — propagate the one-time migration
        // notice flag. Only present (and truthy) on the first publication
        // after a v6 → v7 migration touched at least one queue; the
        // dismiss path writes `'dismissed'`, which then propagates here.
        ...(queue.migrationNotice ? { migrationNotice: queue.migrationNotice } : {})
      }) as QueueProjection,
      phaseOverrides: Object.freeze(
        (run?.phaseOverrides ?? []).map((override) =>
          Object.freeze({ phaseId: override.phaseId, action: override.action })
        )
      ),
      manualPauseAt:
        run?.manualPauseAt !== null && run?.manualPauseAt !== undefined
          ? new Date(run.manualPauseAt).toISOString()
          : null,
      manualPauseCause: run?.manualPauseCause ?? null,
      // Feature 028 — project per-run breakpoints (sorted by setAt asc).
      phaseBreakpoints: Object.freeze(
        [...(run?.phaseBreakpoints ?? [])]
          .sort((a, b) => a.setAt - b.setAt)
          .map((bp) =>
            Object.freeze({
              phaseId: bp.phaseId,
              setAt: new Date(bp.setAt).toISOString(),
              actor: bp.actor
            })
          )
      ),
      resumeTargetPhaseId: run?.resumeTargetPhaseId ?? null,
      // Feature 028 — runId distinct from `activeFeature.id` (which is
      // the queue/task id). Powers `CMD_SET_PHASE_BREAKPOINT` /
      // `CMD_CLEAR_PHASE_BREAKPOINT` targeting from the dashboard.
      activeRunId: run?.id ?? null,
      auditTail: Object.freeze(auditTail),
      liveActivity,
      workflowElapsedMs,
      monitor: monitorState,
      history: Object.freeze(historyEntries) as readonly HistoryEntry[],
      producedAt: this.now().toISOString(),
      availablePhases: Object.freeze([...catalog.phases]),
      availablePipelines: Object.freeze([...catalog.pipelines]),
      availableModels: Object.freeze([...catalog.models]),
      delayedRetry,
      generalSettings,
      wakeUpSettings,
      wakeUpLog,
      wakeUp,
      // Feature 033 — surface the staged telemetry sample. The sample
      // is already sanitized + clamped + frozen in `updateTelemetry`,
      // so we propagate it as-is.
      telemetry: this.stagedTelemetry,
      // Feature 059 — trust projection. Always present so the webview
      // can render policy banners and gate Save affordances without an
      // existence guard.
      workspaceTrust,
      resolvedTrust,
      ...(activePipeline ? { activePipeline } : {}),
      ...(phasePrecedence !== undefined ? { phasePrecedence } : {}),
      // Feature 063 (FR-021) — confirmation-prompt suppression projection.
      // Omitted when the store does not implement the accessor (legacy
      // test seams); the webview defaults to "no suppression" on undefined.
      ...(confirmSuppression !== undefined ? { confirmSuppression } : {}),
      // Feature 063 (T030) — global confirmations toggle. Omitted when
      // the host dep is not wired; webview treats `undefined` as `true`.
      ...(confirmationsEnabled !== undefined ? { confirmationsEnabled } : {})
    });
  }

  private applyPhaseElapsedAndSubProgress(phases: PhaseTile[], run: WorkflowRun | null): void {
    for (const tile of phases) {
      const isActive = tile.state === 'active';
      const mutable = tile as { -readonly [K in keyof PhaseTile]: PhaseTile[K] };
      mutable.elapsedMs = this.computePhaseElapsedMs(tile.name, isActive);
      mutable.subProgress = computeSubProgressForTile(
        tile,
        run,
        this.subProgressByPhase.get(tile.name)
      );
    }
  }

}
