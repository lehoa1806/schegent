import {
  MAX_PENDING_TASKS_PER_QUEUE,
  ensureExtendedFeatureRequest,
  validateDescription,
  type FeatureRequest,
  type QueueState
} from '../queue/feature-request';
import {
  DEFAULT_QUEUE_ID,
  findQueue,
  makeDefaultRegistry,
  validateQueueRegistry,
  type QueueRegistry
} from '../queue/queue-registry';
import type {
  TerminalTransitionIntent,
  WorkflowRun,
  WatchdogState,
  WorkspaceLock
} from './workflow-run';
import { STATE_SCHEMA_VERSION } from '../contracts/state-schema';
import {
  migrateLegacyRun,
  migrateQueueRegistryV4ToV5,
  repairLegacyRunSnapshot,
  type WorkflowRunRepairedAuditEvent
} from './workflow-run-migrator';
import {
  migrateLegacyQueueState,
  migrateV5ToV6,
  migrateV6ToV7,
  type StateMigratedV5ToV6AuditEvent,
  type StateMigratedV6ToV7AuditEvent
} from './queue-state-migrator';
import { DELAYED_RETRY_CAP } from '../controller/retry-constants';
import type { SanitizedLogger } from '../lib/logger';

export const SCHEMA_VERSION = '1.0.0';
export { STATE_SCHEMA_VERSION };

export type PersistedHistoryEntry = object;

/**
 * Render an arbitrary persisted-value shape for diagnostic logs without
 * letting `JSON.stringify` throw on circular references or `BigInt`. The
 * sanitized logger redacts any embedded secret patterns downstream, so
 * the goal here is *durability* (don't crash the WARN path) rather than
 * sanitization (which is the logger's job).
 */
function safeDisplay(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? `<${typeof value}>`;
  } catch {
    return `<${typeof value}>`;
  }
}

function ensureExtendedQueueShape(persisted: QueueState): QueueState {
  const requests = Array.isArray(persisted.requests)
    ? persisted.requests.map((r) => ensureExtendedFeatureRequest(r as FeatureRequest))
    : [];
  const normalizedRequests = compactRequestPositions(requests);
  const paused = persisted.paused ?? false;
  const inFlightId = persisted.inFlightId ?? null;
  const persistedLifecycle = (persisted as QueueState).queueLifecycle;
  const queueLifecycle = persistedLifecycle ?? deriveLifecycleFromLegacyShape(paused, inFlightId, normalizedRequests.length);
  const scheduledStartAt = (persisted as QueueState).scheduledStartAt ?? null;
  const scheduledStartSource = (persisted as QueueState).scheduledStartSource ?? null;
  const migrationNotice = (persisted as QueueState).migrationNotice;
  return {
    paused,
    pausedReason: (persisted as QueueState).pausedReason ?? null,
    inFlightId,
    updatedAt: persisted.updatedAt ?? Date.now(),
    requests: normalizedRequests,
    queueLifecycle,
    scheduledStartAt: queueLifecycle === 'idle-pending' ? scheduledStartAt : null,
    scheduledStartSource: queueLifecycle === 'idle-pending' ? scheduledStartSource : null,
    ...(migrationNotice ? { migrationNotice } : {})
  };
}

function deriveLifecycleFromLegacyShape(
  paused: boolean,
  inFlightId: string | null,
  pendingCount: number
): QueueState['queueLifecycle'] {
  if (inFlightId !== null) return 'running';
  if (paused) return 'operator-paused';
  if (pendingCount > 0) return 'idle-pending';
  return 'active-empty';
}

export const KEYS = {
  schemaVersion: 'schegent.schemaVersion',
  schemaVersionNumeric: 'schegent.schemaVersionNumeric',
  queue: 'schegent.queue',
  queueRegistry: 'schegent.queues.registry',
  queueMigrationQuarantine: 'schegent.state.quarantine.v2',
  queueDefaultId: 'schegent.queue.defaultQueueId',
  queueGlobalConcurrencyCap: 'schegent.queue.globalConcurrencyCap',
  run: 'schegent.run',
  lock: 'schegent.lock',
  watchdog: 'schegent.watchdog',
  history: 'schegent.history',
  terminalTransitionIntent: 'schegent.terminalTransitionIntent',
  // Feature 063 (FR-021) — per-action "don't ask again" suppression set.
  confirmSuppression: 'schegent.ui.confirmSuppression'
} as const;

import { readConfirmSuppression, writeConfirmSuppression } from './confirm-suppression';
export { CONFIRM_SUPPRESSION_VERSION, type ConfirmSuppressionState } from './confirm-suppression';

export const HISTORY_CAP = 50;

export type StoreChangeKey =
  | typeof KEYS.run
  | typeof KEYS.queue
  | typeof KEYS.queueRegistry
  | typeof KEYS.queueDefaultId
  | typeof KEYS.queueGlobalConcurrencyCap
  | typeof KEYS.lock
  | typeof KEYS.history
  | typeof KEYS.terminalTransitionIntent;

export type StoreChangeListener = (key: StoreChangeKey) => void;

export interface Disposable {
  dispose(): void;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export type QueueMutationRejectReason =
  | 'unknown-queue-id'
  | 'position-out-of-range'
  | 'task-cap-reached'
  | 'task-not-found'
  | 'task-not-in-pending-state'
  | 'phase-not-found'
  | 'phase-already-removed'
  | 'cannot-delete-default-queue'
  | 'invalid-global-concurrency-cap';

export class QueueMutationRejected extends Error {
  public readonly reason: QueueMutationRejectReason;

  constructor(reason: QueueMutationRejectReason, message: string) {
    super(message);
    this.name = 'QueueMutationRejected';
    this.reason = reason;
  }
}

/**
 * Upper bound for `WorkflowRun.delayedRetryCount` accepted by the
 * persisted-state invariant. The live cap is `DELAYED_RETRY_CAP` (5),
 * matching the current `retry.maxAttempts.maximum` schema bound. The
 * ceiling stays at 20 to absorb records persisted under an earlier
 * schema that allowed `retry.maxAttempts` up to 20; the gap (5..20)
 * is intentional headroom, not a live operator surface.
 *
 * Tightening below the current setting is safe — the live cap is
 * already 5. Widening the ceiling ABOVE 20 is the only direction that
 * requires a forward state migration (the old schema's effective
 * accepted range was [0, 20]).
 */
const DELAYED_RETRY_COUNT_PERSISTED_CEILING = 20;

/**
 * Feature 011 — invariant guard for `WorkflowRun` writes.
 *
 *  - `pendingRetryAt` and `pendingRetryCause` MUST be both null or both
 *    non-null. (data-model.md §WorkflowRun)
 *  - `delayedRetryCount === DELAYED_RETRY_CAP` (5) implies `status` is
 *    `'paused'` or `'failed'`.
 *
 * Throws a typed error from the controller call site before the memento
 * write so split-state corruption is prevented locally.
 */
function validateRunInvariants(run: WorkflowRun): void {
  if (
    run.rawTranscriptMode !== undefined &&
    run.rawTranscriptMode !== 'always' &&
    run.rawTranscriptMode !== 'errors-only' &&
    run.rawTranscriptMode !== 'off'
  ) {
    throw new Error('WorkflowRun invariant violation: invalid rawTranscriptMode');
  }
  const pendingAtSet = run.pendingRetryAt !== null;
  const pendingCauseSet = run.pendingRetryCause !== null;
  if (pendingAtSet !== pendingCauseSet) {
    throw new Error(
      `WorkflowRun invariant violation: pendingRetryAt (${run.pendingRetryAt}) and pendingRetryCause (${run.pendingRetryCause}) must be both null or both non-null`
    );
  }
  // When the cap is reached, the run must be paused or failed. Use >= to
  // tolerate a dynamic cap that may have been lowered after the count
  // was already persisted.
  if (
    run.delayedRetryCount >= DELAYED_RETRY_CAP &&
    run.status !== 'paused' &&
    run.status !== 'failed'
  ) {
    throw new Error(
      `WorkflowRun invariant violation: delayedRetryCount >= ${DELAYED_RETRY_CAP} requires status 'paused' or 'failed' (got '${run.status}')`
    );
  }
  if (
    !Number.isFinite(run.delayedRetryCount) ||
    run.delayedRetryCount < 0 ||
    run.delayedRetryCount > DELAYED_RETRY_COUNT_PERSISTED_CEILING
  ) {
    throw new Error(
      `WorkflowRun invariant violation: delayedRetryCount must be in [0, ${DELAYED_RETRY_COUNT_PERSISTED_CEILING}] (got ${run.delayedRetryCount})`
    );
  }
  // Feature 017 — both-null-or-both-non-null invariant on the manual pause pair.
  // Feature 028 — invariant extended to accept `'breakpoint-paused'` as a valid cause.
  const manualAtSet = run.manualPauseAt !== null;
  const manualCauseSet = run.manualPauseCause !== null;
  if (manualAtSet !== manualCauseSet) {
    throw new Error(
      `WorkflowRun invariant violation: manualPauseAt (${run.manualPauseAt}) and manualPauseCause (${run.manualPauseCause}) must be both null or both non-null`
    );
  }
  // Feature 028 — phaseBreakpoints + resumeTargetPhaseId invariants.
  if (!Array.isArray(run.phaseBreakpoints)) {
    throw new Error(
      `WorkflowRun invariant violation: phaseBreakpoints must be an array (got ${typeof run.phaseBreakpoints})`
    );
  }
  const breakpointPhaseIds = new Set<string>();
  const pipelinePhaseIds = run.pipeline
    ? new Set<string>(run.pipeline.phases.map((p) => p.id))
    : null;
  const overrideIds = new Set<string>(run.phaseOverrides.map((o) => o.phaseId));
  for (const bp of run.phaseBreakpoints) {
    if (breakpointPhaseIds.has(bp.phaseId)) {
      throw new Error(
        `WorkflowRun invariant violation: phaseBreakpoints contains duplicate phaseId '${bp.phaseId}'`
      );
    }
    breakpointPhaseIds.add(bp.phaseId);
    if (pipelinePhaseIds !== null && !pipelinePhaseIds.has(bp.phaseId)) {
      throw new Error(
        `WorkflowRun invariant violation: phaseBreakpoints phaseId '${bp.phaseId}' is not in pipeline.phases`
      );
    }
    if (overrideIds.has(bp.phaseId)) {
      throw new Error(
        `WorkflowRun invariant violation: phaseId '${bp.phaseId}' appears in BOTH phaseBreakpoints AND phaseOverrides`
      );
    }
  }
  // resumeTargetPhaseId is non-null iff manualPauseCause === 'breakpoint-paused'.
  const resumeTargetSet = run.resumeTargetPhaseId !== null;
  const breakpointPaused = run.manualPauseCause === 'breakpoint-paused';
  if (resumeTargetSet !== breakpointPaused) {
    throw new Error(
      `WorkflowRun invariant violation: resumeTargetPhaseId (${run.resumeTargetPhaseId}) is non-null iff manualPauseCause === 'breakpoint-paused' (got '${run.manualPauseCause}')`
    );
  }
}

export interface InitializeResult {
  migrated: boolean;
  // Feature 030 — emitted by the v5 → v6 migrator when it ran. Caller
  // (extension.ts) forwards these through `appendAudit` after the
  // `auditWriter` is constructed. Empty array when no migration occurred.
  v6MigrationEvents: readonly StateMigratedV5ToV6AuditEvent[];
  // Feature 065 — emitted by the v6 → v7 migrator when it ran. Same
  // forwarding contract as `v6MigrationEvents` above.
  v7MigrationEvents: readonly StateMigratedV6ToV7AuditEvent[];
  // Feature 056 — emitted when persisted WorkflowRun snapshots are repaired.
  runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
}

export class WorkspaceStateStore {
  private readonly memento: Memento;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<StoreChangeListener>();
  private readonly logger: SanitizedLogger | null;
  /**
   * One-shot guard for the `globalConcurrencyCap` saturation WARN. The
   * cap reader (`getGlobalConcurrencyCap`) is invoked from many hot
   * paths (every snapshot publish, every queue mutation); we only want
   * one WARN per process when a legacy persisted value silently
   * saturates to 1.
   */
  private hasWarnedAboutConcurrencyCapSaturation = false;

  constructor(memento: Memento, logger?: SanitizedLogger) {
    this.memento = memento;
    this.logger = logger ?? null;
  }

  public subscribe(listener: StoreChangeListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  private notify(key: StoreChangeKey): void {
    for (const listener of this.listeners) {
      try {
        listener(key);
      } catch {
        // Listener errors must not affect other subscribers or the store itself.
      }
    }
  }

  public async initialize(): Promise<InitializeResult> {
    const persistedNumeric = this.memento.get<number>(KEYS.schemaVersionNumeric);
    if (typeof persistedNumeric === 'number' && persistedNumeric > STATE_SCHEMA_VERSION) {
      throw new Error(
        `Schegent state schemaVersion ${persistedNumeric} exceeds runtime ${STATE_SCHEMA_VERSION}. Update the extension before opening this workspace.`
      );
    }
    const persistedVersion = this.memento.get<string>(KEYS.schemaVersion);
    if (!persistedVersion) {
      await this.memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
      const runRepairEvents = await this.normalizeRunForInitialize(true);
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
      await this.reconcileQueuePauseStateIfDivergent();
      return { migrated: true, v6MigrationEvents: v6Events, v7MigrationEvents: v7Events, runRepairEvents };
    }
    if (persistedVersion === SCHEMA_VERSION) {
      if (persistedNumeric !== STATE_SCHEMA_VERSION) {
        await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
        // Numeric schema bump only (additive fields) — apply forward
        // migrator so legacy `WorkflowRun` records gain the new fields.
        const runRepairEvents = await this.normalizeRunForInitialize(true);
        await this.migrateQueueRegistryIfNeeded();
        const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
        const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
        await this.reconcileQueuePauseStateIfDivergent();
        return { migrated: true, v6MigrationEvents: v6Events, v7MigrationEvents: v7Events, runRepairEvents };
      }
      const runRepairEvents = await this.normalizeRunForInitialize(false);
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
      const reconciled = await this.reconcileQueuePauseStateIfDivergent();
      return {
        migrated: v6Events.length > 0 || v7Events.length > 0 || runRepairEvents.length > 0 || reconciled,
        v6MigrationEvents: v6Events,
        v7MigrationEvents: v7Events,
        runRepairEvents
      };
    }
    const [persistedMajor] = persistedVersion.split('.');
    const [runtimeMajor] = SCHEMA_VERSION.split('.');
    if (persistedMajor === runtimeMajor) {
      await this.memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
      const runRepairEvents = await this.normalizeRunForInitialize(true);
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
      await this.reconcileQueuePauseStateIfDivergent();
      return { migrated: true, v6MigrationEvents: v6Events, v7MigrationEvents: v7Events, runRepairEvents };
    }
    throw new Error(
      `Schegent state version ${persistedVersion} is incompatible with runtime ${SCHEMA_VERSION}. Run "Schegent: Reset Workspace State" to clear.`
    );
  }

  // BUG-001 self-heal: pre-fix persisted v6 state may have a stale legacy
  // `QueueState.paused` diverging from the authoritative
  // `QueueRegistry.entries[0].state`. Reconcile legacy → registry per FR-020.
  private async reconcileQueuePauseStateIfDivergent(): Promise<boolean> {
    const persistedQueue = this.memento.get<QueueState>(KEYS.queue);
    const persistedRegistry = this.memento.get<QueueRegistry>(KEYS.queueRegistry);
    if (!persistedQueue || !persistedRegistry) return false;
    const defaultEntry = persistedRegistry.entries.find((e) => e.id === DEFAULT_QUEUE_ID);
    if (!defaultEntry) return false;
    const legacyPaused = persistedQueue.paused === true;
    const registryPaused = defaultEntry.state === 'manually-paused';
    if (legacyPaused === registryPaused) return false;
    const correctedReason = registryPaused ? persistedQueue.pausedReason ?? null : null;
    const inFlight = persistedQueue.inFlightId ?? null;
    const pendingCount = (persistedQueue.requests ?? []).filter((r) => r.status === 'pending').length;
    const correctedLifecycle: QueueState['queueLifecycle'] =
      inFlight !== null
        ? 'running'
        : registryPaused
        ? 'operator-paused'
        : pendingCount > 0
        ? 'idle-pending'
        : 'active-empty';
    await this.memento.update(KEYS.queue, {
      ...persistedQueue,
      paused: registryPaused,
      pausedReason: correctedReason,
      queueLifecycle: correctedLifecycle,
      scheduledStartAt: correctedLifecycle === 'idle-pending' ? persistedQueue.scheduledStartAt ?? null : null,
      scheduledStartSource: correctedLifecycle === 'idle-pending' ? persistedQueue.scheduledStartSource ?? null : null,
      updatedAt: Date.now()
    });
    this.logger?.warn(
      `workspace-state: reconciled divergent queue pause state (legacy=${legacyPaused} registry=${registryPaused}) → registry`
    );
    this.notify(KEYS.queue);
    return true;
  }

  // Feature 011 — STATE_SCHEMA_VERSION 1 → 2: fills the three new
  // `WorkflowRun` fields on legacy records.
  private async normalizeRunForInitialize(
    applyLegacyMigration: boolean
  ): Promise<readonly WorkflowRunRepairedAuditEvent[]> {
    const raw = this.memento.get<unknown>(KEYS.run);
    if (raw === undefined || raw === null) return [];
    const migrated = applyLegacyMigration ? migrateLegacyRun(raw) : (raw as WorkflowRun);
    if (migrated === null) return [];
    const repair = repairLegacyRunSnapshot(migrated);
    if (applyLegacyMigration || repair.auditEvent !== null) {
      await this.memento.update(KEYS.run, repair.run);
    }
    return repair.auditEvent === null ? [] : [repair.auditEvent];
  }

  private async migrateQueueRegistryIfNeeded(): Promise<void> {
    const existingRegistry = this.memento.get<QueueRegistry>(KEYS.queueRegistry);
    if (existingRegistry !== undefined && existingRegistry !== null) {
      // Feature 028 v4 → v5: backfill `pauseSource` on existing entries.
      // Idempotent — entries already carrying a valid pauseSource pass through.
      const migrated = migrateQueueRegistryV4ToV5(existingRegistry.entries);
      const needsUpdate = migrated.some((entry, i) => {
        const original = existingRegistry.entries[i];
        return (
          !original ||
          (original as unknown as { pauseSource?: unknown }).pauseSource !== entry.pauseSource
        );
      });
      if (needsUpdate) {
        await this.memento.update(KEYS.queueRegistry, {
          entries: migrated,
          updatedAt: existingRegistry.updatedAt
        });
      }
      return;
    }
    const lifted = migrateLegacyQueueState(this.memento.get<unknown>(KEYS.queue));
    await this.memento.update(KEYS.queueRegistry, lifted.registry);
    await this.memento.update(KEYS.queue, lifted.queueState);
    await this.memento.update(KEYS.queueDefaultId, lifted.defaultQueueId);
    if (lifted.quarantine !== null) {
      await this.memento.update(KEYS.queueMigrationQuarantine, lifted.quarantine);
    }
  }

  // Feature 030 — v5 → v6 forward migration. Runs after v2→v3 lift and
  // v4→v5 pauseSource backfill; before snapshot/watchdog. Returns audit
  // events forwarded by the caller via `appendAudit`. Idempotent.
  private async migrateV5ToV6IfNeeded(
    persistedNumeric: number | undefined
  ): Promise<readonly StateMigratedV5ToV6AuditEvent[]> {
    const registry = this.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? null;
    const queueState = this.memento.get<QueueState>(KEYS.queue) ?? null;
    // Treat missing/legacy numeric version as v5 so the migration runs once
    // on first activation after the schema bump. A persisted numeric >= 6
    // skips (idempotent no-op).
    const effectiveVersion = persistedNumeric !== undefined && persistedNumeric >= 6 ? 6 : 5;
    const result = migrateV5ToV6(
      { schemaVersion: effectiveVersion, queueRegistry: registry, queueState },
      Date.now()
    );
    if (!result.migrated) {
      return [];
    }
    // Feature 030 — fresh workspaces (no prior persisted numeric AND the
    // lift produced a default-shaped registry/queueState above) reach this
    // path because the migrator runs unconditionally on version<6. The v6
    // shape IS the new default for fresh workspaces, so an audit event
    // would be misleading. Skip emission when the migrator's output is
    // structurally identical to a freshly minted default and no prior
    // tasks were coalesced.
    const isFreshWorkspace =
      persistedNumeric === undefined &&
      result.auditEvents.length === 1 &&
      result.auditEvents[0].sourceQueueCount <= 1 &&
      result.auditEvents[0].pendingTaskCount === 0 &&
      result.auditEvents[0].inFlightTaskCount === 0 &&
      result.auditEvents[0].inheritedPausedState === false;
    if (isFreshWorkspace) {
      // Still persist the migrated shape (idempotent on default) but emit
      // no audit event.
      await this.memento.update(KEYS.queueRegistry, result.state.queueRegistry);
      await this.memento.update(KEYS.queue, result.state.queueState);
      await this.memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
      return [];
    }
    // Persist the unified registry and queue state. Order matters: write
    // the registry first so concurrent readers see a consistent shape.
    await this.memento.update(KEYS.queueRegistry, result.state.queueRegistry);
    await this.memento.update(KEYS.queue, result.state.queueState);
    await this.memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
    // If a WorkflowRun is persisted, ensure its `queueId` is `'default'`.
    // The WorkflowRun shape itself is unchanged; only the queueId field is
    // rewritten so downstream code can rely on the single-queue invariant.
    const run = this.memento.get<WorkflowRun>(KEYS.run) ?? null;
    if (run !== null) {
      const runRecord = run as unknown as { queueId?: string };
      if (runRecord.queueId !== undefined && runRecord.queueId !== DEFAULT_QUEUE_ID) {
        await this.memento.update(KEYS.run, { ...run, queueId: DEFAULT_QUEUE_ID });
      }
    }
    return result.auditEvents;
  }

  // Feature 065 — v6 → v7 forward migration. Runs after v5→v6 coalesce; before
  // snapshot/watchdog reconciliation. Returns audit events forwarded by the
  // caller via `appendAudit`. Idempotent: a v7-shape record returns no events.
  private async migrateV6ToV7IfNeeded(
    persistedNumeric: number | undefined
  ): Promise<readonly StateMigratedV6ToV7AuditEvent[]> {
    const queueState = this.memento.get<QueueState>(KEYS.queue) ?? null;
    // No persisted queue yet (fresh workspace) — nothing to migrate; the empty
    // QueueState is already born in v7 shape via `getQueue()` and `setQueue()`.
    if (queueState === null) return [];
    // If the persisted numeric is already v7 AND the record carries the
    // discriminator, idempotent no-op.
    const alreadyV7 =
      persistedNumeric === 7
      && typeof (queueState as QueueState).queueLifecycle === 'string';
    if (alreadyV7) return [];
    const result = migrateV6ToV7(queueState, Date.now());
    if (!result.migrated) return [];
    // Fresh-workspace suppression: when there are no pending tasks AND no
    // in-flight AND not paused, the derived lifecycle is `active-empty` and
    // emitting an audit event would be misleading (matches the v5→v6
    // fresh-workspace heuristic).
    const isFreshWorkspace =
      result.queueState.requests.length === 0
      && result.queueState.inFlightId === null
      && result.queueState.paused === false;
    await this.memento.update(KEYS.queue, result.queueState);
    if (isFreshWorkspace) return [];
    return result.auditEvents;
  }

  public getQueue(): QueueState {
    const persisted = this.memento.get<QueueState>(KEYS.queue);
    if (!persisted) {
      return {
        requests: [],
        inFlightId: null,
        paused: false,
        pausedReason: null,
        updatedAt: Date.now(),
        queueLifecycle: 'active-empty',
        scheduledStartAt: null,
        scheduledStartSource: null
      };
    }
    return ensureExtendedQueueShape(persisted);
  }

  /** @internal Full replacement seam for migrations and test setup only. */
  public setQueue(queue: QueueState): Promise<void> {
    // Feature 065 — normalize via `ensureExtendedQueueShape` so a partial
    // QueueState (legacy callers / tests using `as never`) is persisted in
    // v7 shape (carries `queueLifecycle` + nullable `scheduledStart*`).
    // Without this, the next initialize() re-runs the v6→v7 migrator and
    // breaks idempotency.
    const next = ensureExtendedQueueShape({
      ...queue,
      requests: compactRequestPositions(queue.requests),
      updatedAt: Date.now()
    });
    return this.serialize(KEYS.queue, () => this.memento.update(KEYS.queue, next)).then(() => {
      this.notify(KEYS.queue);
    });
  }

  /**
   * The only safe read/modify/write boundary for queue state. The current
   * value is read after this mutation reaches the head of the queue chain,
   * preventing callers from committing a snapshot captured before another
   * queued mutation completed.
   */
  public updateQueue<T>(
    mutate: (current: QueueState) => { readonly queue: QueueState; readonly result: T }
  ): Promise<T> {
    let result!: T;
    return this.serialize(KEYS.queue, async () => {
      const current = this.getQueue();
      const mutation = mutate(current);
      const next = ensureExtendedQueueShape({
        ...mutation.queue,
        requests: compactRequestPositions(mutation.queue.requests),
        updatedAt: Date.now()
      });
      result = mutation.result;
      await this.memento.update(KEYS.queue, next);
    }).then(() => {
      this.notify(KEYS.queue);
      return result;
    });
  }

  public getQueueRegistry(): QueueRegistry {
    const registry = this.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? makeDefaultRegistry();
    validateQueueRegistry(registry);
    return registry;
  }

  public setQueueRegistry(registry: QueueRegistry): Promise<void> {
    validateQueueRegistry(registry);
    return this.serialize(KEYS.queueRegistry, () =>
      this.memento.update(KEYS.queueRegistry, registry)
    ).then(() => {
      this.notify(KEYS.queueRegistry);
    });
  }

  public getDefaultQueueId(): string {
    const id = this.memento.get<string>(KEYS.queueDefaultId) ?? DEFAULT_QUEUE_ID;
    return findQueue(this.getQueueRegistry(), id) ? id : DEFAULT_QUEUE_ID;
  }

  public setDefaultQueueId(id: string): Promise<void> {
    if (!findQueue(this.getQueueRegistry(), id)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${id}`);
    }
    return this.serialize(KEYS.queueDefaultId, () =>
      this.memento.update(KEYS.queueDefaultId, id)
    ).then(() => {
      this.notify(KEYS.queueDefaultId);
    });
  }

  public getGlobalConcurrencyCap(): number {
    // Feature 056 Track 4 (FR-018..FR-022) — v1 ships exactly one
    // active run. `value === 1` (not the previous `>= 1 && <= 1`)
    // reads as "the only currently-valid value"; legacy persisted
    // values from when the schema permitted up to 5 saturate to 1.
    // The companion setter rejects anything other than `1` outright
    // so forward-written records cannot regress this property.
    const value = this.memento.get<number>(KEYS.queueGlobalConcurrencyCap);
    if (typeof value === 'number' && Number.isInteger(value) && value === 1) {
      return value;
    }
    // Any non-`1` persisted value silently saturates to 1. Emit a
    // one-shot WARN per process so the operator notices and re-saves
    // the setting rather than puzzling over why the queue runs at
    // half-speed days later. We treat *every* invalid shape — legacy
    // >1, 0, negative, NaN, non-number — uniformly so a corrupted
    // memento entry surfaces with the same diagnostic affordance as
    // a legacy >1 record. `undefined`/`null` (key never written) is
    // the normal cold-start case and stays silent.
    if (
      value !== undefined &&
      value !== null &&
      !this.hasWarnedAboutConcurrencyCapSaturation
    ) {
      this.hasWarnedAboutConcurrencyCapSaturation = true;
      this.logger?.warn(
        `schegent.queue.globalConcurrencyCap: persisted value ${safeDisplay(value)} is not 1; saturated to 1 — re-save the setting via the queue settings UI to clear this warning.`
      );
    }
    return 1;
  }

  public setGlobalConcurrencyCap(value: number): Promise<void> {
    // Feature 056 Track 4 (FR-018..FR-022) — Reject any value outside
    // [1, 1]; the package contribution, host validator, and
    // `QueueManager.saveQueueSettings` all share this invariant.
    if (!Number.isInteger(value) || value < 1 || value > 1) {
      throw new QueueMutationRejected(
        'invalid-global-concurrency-cap',
        `globalConcurrencyCap must be an integer in [1, 1] (got ${value})`
      );
    }
    return this.serialize(KEYS.queueGlobalConcurrencyCap, () =>
      this.memento.update(KEYS.queueGlobalConcurrencyCap, value)
    ).then(() => {
      this.notify(KEYS.queueGlobalConcurrencyCap);
    });
  }

  public getRequestsForQueue(queueId: string): FeatureRequest[] {
    if (!findQueue(this.getQueueRegistry(), queueId)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
    }
    return this.getQueue()
      .requests.filter((request) => request.queueId === queueId)
      .sort((a, b) => a.position - b.position);
  }

  public async insertPendingRequest(
    request: FeatureRequest,
    params: { queueId?: string; position?: number | null } = {}
  ): Promise<FeatureRequest> {
    const queueId = params.queueId ?? this.getDefaultQueueId();
    if (!findQueue(this.getQueueRegistry(), queueId)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
    }
    return this.updateQueue((queue) => {
      // BUG-004 — `insertAt` is the logical index into the pending list, and
      // the position field must mirror that index for the queue projector's
      // `position ascending` sort to honor FIFO order.
      const pendingInTarget = queue.requests
        .filter((item) => item.queueId === queueId && item.status === 'pending')
        .sort((a, b) => a.position - b.position);
      if (pendingInTarget.length >= MAX_PENDING_TASKS_PER_QUEUE) {
        throw new QueueMutationRejected(
          'task-cap-reached',
          `Queue ${queueId} already has ${MAX_PENDING_TASKS_PER_QUEUE} pending tasks`
        );
      }
      const insertAt = params.position ?? queue.requests.length;
      if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > queue.requests.length) {
        throw new QueueMutationRejected(
          'position-out-of-range',
          `Position must be in [0, ${queue.requests.length}] (got ${String(params.position)})`
        );
      }
      const now = Date.now();
      const nextRequest: FeatureRequest = {
        ...request,
        queueId,
        position: insertAt,
        pauseCause: null,
        updatedAt: now
      };
      const denseIndex = new Map<string, number>();
      const allInTarget = queue.requests
        .filter((item) => item.queueId === queueId)
        .sort((a, b) => a.position - b.position);
      allInTarget.forEach((item, idx) => denseIndex.set(item.id, idx));
      const shifted = queue.requests.map((item) => {
        if (item.queueId !== queueId) return item;
        const dense = denseIndex.get(item.id) ?? item.position;
        const repositioned = dense >= insertAt ? dense + 1 : dense;
        if (repositioned === item.position) return item;
        return { ...item, position: repositioned, updatedAt: now };
      });
      return {
        queue: { ...queue, requests: [...shifted, nextRequest] },
        result: nextRequest
      };
    });
  }

  public async removePendingRequest(taskId: string): Promise<FeatureRequest> {
    return this.updateQueue((queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      if (target.status !== 'pending') {
        throw new QueueMutationRejected(
          'task-not-in-pending-state',
          `Task ${taskId} is not pending`
        );
      }
      return {
        queue: {
          ...queue,
          requests: queue.requests.filter((request) => request.id !== taskId)
        },
        result: target
      };
    });
  }

  public getRequest(taskId: string): FeatureRequest | null {
    return this.getQueue().requests.find((request) => request.id === taskId) ?? null;
  }

  public async removeRequest(taskId: string): Promise<FeatureRequest> {
    return this.updateQueue((queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      return {
        queue: {
          ...queue,
          inFlightId: queue.inFlightId === taskId ? null : queue.inFlightId,
          requests: queue.requests.filter((request) => request.id !== taskId)
        },
        result: target
      };
    });
  }

  public async modifyPendingRequest(
    taskId: string,
    updates: { description?: string }
  ): Promise<FeatureRequest> {
    return this.updateQueue((queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      if (target.status !== 'pending') {
        throw new QueueMutationRejected(
          'task-not-in-pending-state',
          `Task ${taskId} is not pending`
        );
      }
      const nextTarget: FeatureRequest = {
        ...target,
        ...(updates.description !== undefined
          ? { description: validateDescription(updates.description) }
          : {}),
        updatedAt: Date.now()
      };
      return {
        queue: {
          ...queue,
          requests: queue.requests.map((request) =>
            request.id === taskId ? nextTarget : request
          )
        },
        result: nextTarget
      };
    });
  }

  // Feature 065 BUG-009 T078 (FR-030) — `position` is interpreted as a
  // PENDING-ARRAY index in the queue's pending sub-array (not as a global
  // `requests`-array index). The reshuffle is pending-only: pending rows
  // permute within their existing global position SLOTS, and rows whose
  // status is NOT `'pending'` keep their `.position` field unchanged. The
  // caller (`QueueManager.reorderTaskInUnifiedQueue`) is responsible for
  // translating the operator-emitted global `orderedItems` index into a
  // pending-array index before invoking this writer.
  public async reorderPendingRequest(taskId: string, position: number): Promise<FeatureRequest> {
    return this.updateQueue((queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      if (target.status !== 'pending') {
        throw new QueueMutationRejected(
          'task-not-in-pending-state',
          `Task ${taskId} is not pending`
        );
      }
      const queueId = target.queueId ?? DEFAULT_QUEUE_ID;
      const pendingPeers = queue.requests
        .filter((request) => request.queueId === queueId && request.status === 'pending')
        .sort((a, b) => a.position - b.position);
      if (!Number.isInteger(position) || position < 0 || position >= pendingPeers.length) {
        throw new QueueMutationRejected(
          'position-out-of-range',
          `Position must be in [0, ${Math.max(0, pendingPeers.length - 1)}] (got ${position})`
        );
      }
      const pendingSlots = pendingPeers.map((peer) => peer.position);
      const reorderedPending = pendingPeers.filter((request) => request.id !== taskId);
      reorderedPending.splice(position, 0, target);
      const now = Date.now();
      const byId = new Map(
        reorderedPending.map((request, i) => {
          const nextPosition = pendingSlots[i];
          if (request.position === nextPosition) return [request.id, request];
          return [request.id, { ...request, position: nextPosition, updatedAt: now }];
        })
      );
      return {
        queue: {
          ...queue,
          requests: queue.requests.map((request) => byId.get(request.id) ?? request)
        },
        result: byId.get(taskId) ?? target
      };
    });
  }

  public async movePendingRequest(
    taskId: string,
    params: { targetQueueId: string; position?: number | null }
  ): Promise<FeatureRequest> {
    if (!findQueue(this.getQueueRegistry(), params.targetQueueId)) {
      throw new QueueMutationRejected(
        'unknown-queue-id',
        `Unknown queue id: ${params.targetQueueId}`
      );
    }
    const queue = this.getQueue();
    const target = queue.requests.find((request) => request.id === taskId);
    if (!target) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
    if (target.status !== 'pending') {
      throw new QueueMutationRejected(
        'task-not-in-pending-state',
        `Task ${taskId} is not pending`
      );
    }
    const targetPending = queue.requests.filter(
      (request) => request.queueId === params.targetQueueId && request.status === 'pending'
    );
    const sameQueue = (target.queueId ?? DEFAULT_QUEUE_ID) === params.targetQueueId;
    if (!sameQueue && targetPending.length >= MAX_PENDING_TASKS_PER_QUEUE) {
      throw new QueueMutationRejected(
        'task-cap-reached',
        `Queue ${params.targetQueueId} already has ${MAX_PENDING_TASKS_PER_QUEUE} pending tasks`
      );
    }
    const maxPosition = sameQueue ? targetPending.length - 1 : targetPending.length;
    const insertAt = params.position ?? maxPosition;
    if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > maxPosition) {
      throw new QueueMutationRejected(
        'position-out-of-range',
        `Position must be in [0, ${maxPosition}] (got ${String(params.position)})`
      );
    }
    if (sameQueue) {
      return this.reorderPendingRequest(taskId, insertAt);
    }
    const now = Date.now();
    const moved: FeatureRequest = {
      ...target,
      queueId: params.targetQueueId,
      position: insertAt,
      updatedAt: now
    };
    return this.updateQueue((current) => ({
      queue: {
        ...current,
        requests: [
          ...current.requests
            .filter((request) => request.id !== taskId)
            .map((request) =>
              request.queueId === params.targetQueueId &&
              request.status === 'pending' &&
              request.position >= insertAt
                ? { ...request, position: request.position + 1, updatedAt: now }
                : request
            ),
          moved
        ]
      },
      result: moved
    }));
  }

  public getRun(): WorkflowRun | null {
    return this.memento.get<WorkflowRun>(KEYS.run) ?? null;
  }

  public setRun(run: WorkflowRun | null): Promise<void> {
    if (run !== null) {
      validateRunInvariants(run);
    }
    return this.serialize(KEYS.run, () => this.memento.update(KEYS.run, run)).then(() => {
      this.notify(KEYS.run);
    });
  }

  public getTerminalTransitionIntent(): TerminalTransitionIntent | null {
    const value = this.memento.get<unknown>(KEYS.terminalTransitionIntent);
    if (!value || typeof value !== 'object') return null;
    const intent = value as Partial<TerminalTransitionIntent>;
    return intent.schemaVersion === 1 && intent.run && typeof intent.createdAt === 'number'
      ? (intent as TerminalTransitionIntent)
      : null;
  }

  public setTerminalTransitionIntent(intent: TerminalTransitionIntent | null): Promise<void> {
    return this.serialize(
      KEYS.terminalTransitionIntent,
      () => this.memento.update(KEYS.terminalTransitionIntent, intent)
    ).then(() => this.notify(KEYS.terminalTransitionIntent));
  }

  public getLock(): WorkspaceLock | null {
    return this.memento.get<WorkspaceLock>(KEYS.lock) ?? null;
  }

  public setLock(lock: WorkspaceLock | null): Promise<void> {
    return this.serialize(KEYS.lock, () => this.memento.update(KEYS.lock, lock)).then(() => {
      this.notify(KEYS.lock);
    });
  }

  public getWatchdog(): WatchdogState {
    return (
      this.memento.get<WatchdogState>(KEYS.watchdog) ?? {
        paused: false,
        pausedSince: null,
        nextPollAt: null,
        pollIntervalMs: 30 * 60 * 1000,
        lastStatusOk: null,
        cause: null
      }
    );
  }

  public setWatchdog(state: WatchdogState): Promise<void> {
    return this.serialize(KEYS.watchdog, () => this.memento.update(KEYS.watchdog, state));
  }

  public getHistory(): PersistedHistoryEntry[] {
    return this.memento.get<PersistedHistoryEntry[]>(KEYS.history) ?? [];
  }

  public appendHistory(entry: PersistedHistoryEntry): Promise<void> {
    return this.serialize(KEYS.history, async () => {
      const existing = this.getHistory();
      const incoming = entry as { runId?: unknown; terminalStatus?: unknown };
      if (
        typeof incoming.runId === 'string' &&
        existing.some((candidate) => {
          const prior = candidate as { runId?: unknown; terminalStatus?: unknown };
          return prior.runId === incoming.runId && prior.terminalStatus === incoming.terminalStatus;
        })
      ) return;
      const next = [...existing, entry];
      const trimmed = next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
      await this.memento.update(KEYS.history, trimmed);
    }).then(() => {
      this.notify(KEYS.history);
    });
  }

  // Feature 063 (FR-021) — suppression memento accessors. Narrowing and
  // merge logic lives in `./confirm-suppression.ts` so this file stays
  // focused on the persistence boundary.
  public getConfirmSuppression(): import('./confirm-suppression').ConfirmSuppressionState {
    return readConfirmSuppression(this.memento.get<unknown>(KEYS.confirmSuppression));
  }

  public async setConfirmSuppression(actionKey: string, suppressed: boolean): Promise<void> {
    const next = writeConfirmSuppression(this.getConfirmSuppression(), actionKey, suppressed);
    await this.memento.update(KEYS.confirmSuppression, next);
  }

  public async reset(): Promise<void> {
    await Promise.all([
      this.memento.update(KEYS.queue, undefined),
      this.memento.update(KEYS.queueRegistry, undefined),
      this.memento.update(KEYS.queueMigrationQuarantine, undefined),
      this.memento.update(KEYS.queueDefaultId, undefined),
      this.memento.update(KEYS.queueGlobalConcurrencyCap, undefined),
      this.memento.update(KEYS.run, undefined),
      this.memento.update(KEYS.lock, undefined),
      this.memento.update(KEYS.watchdog, undefined),
      this.memento.update(KEYS.history, undefined),
      this.memento.update(KEYS.terminalTransitionIntent, undefined),
      // Feature 063 (FR-022a) — Reset Workspace clears the suppression
      // set so reopened operators always see confirmation prompts again.
      this.memento.update(KEYS.confirmSuppression, undefined),
      this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION)
    ]);
  }

  private serialize(key: string, op: () => Thenable<void> | Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => Promise.resolve(op()).then(() => undefined));
    this.chains.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }
}

function compactRequestPositions(requests: readonly FeatureRequest[]): FeatureRequest[] {
  const buckets = new Map<string, FeatureRequest[]>();
  for (const request of requests) {
    const queueId = request.queueId || DEFAULT_QUEUE_ID;
    const bucket = buckets.get(queueId) ?? [];
    bucket.push({ ...request, queueId });
    buckets.set(queueId, bucket);
  }
  const positioned = new Map<string, FeatureRequest>();
  for (const bucket of buckets.values()) {
    bucket
      .slice()
      .sort((a, b) => a.position - b.position)
      .forEach((request, position) => {
        positioned.set(request.id, { ...request, position });
      });
  }
  return requests.map((request) => positioned.get(request.id) ?? request);
}
