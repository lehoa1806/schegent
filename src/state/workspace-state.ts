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
import type { WorkflowRun, WatchdogState, WorkspaceLock } from './workflow-run';
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
  type StateMigratedV5ToV6AuditEvent
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
  return {
    paused: persisted.paused ?? false,
    pausedReason: (persisted as QueueState).pausedReason ?? null,
    inFlightId: persisted.inFlightId ?? null,
    updatedAt: persisted.updatedAt ?? Date.now(),
    requests: normalizedRequests
  };
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
  history: 'schegent.history'
} as const;

export const HISTORY_CAP = 50;

export type StoreChangeKey =
  | typeof KEYS.run
  | typeof KEYS.queue
  | typeof KEYS.queueRegistry
  | typeof KEYS.queueDefaultId
  | typeof KEYS.queueGlobalConcurrencyCap
  | typeof KEYS.lock
  | typeof KEYS.history;

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
      return { migrated: true, v6MigrationEvents: v6Events, runRepairEvents };
    }
    if (persistedVersion === SCHEMA_VERSION) {
      if (persistedNumeric !== STATE_SCHEMA_VERSION) {
        await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
        // Numeric schema bump only (additive fields) — apply forward
        // migrator so legacy `WorkflowRun` records gain the new fields.
        const runRepairEvents = await this.normalizeRunForInitialize(true);
        await this.migrateQueueRegistryIfNeeded();
        const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
        return { migrated: true, v6MigrationEvents: v6Events, runRepairEvents };
      }
      const runRepairEvents = await this.normalizeRunForInitialize(false);
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      return {
        migrated: v6Events.length > 0 || runRepairEvents.length > 0,
        v6MigrationEvents: v6Events,
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
      return { migrated: true, v6MigrationEvents: v6Events, runRepairEvents };
    }
    throw new Error(
      `Schegent state version ${persistedVersion} is incompatible with runtime ${SCHEMA_VERSION}. Run "Schegent: Reset Workspace State" to clear.`
    );
  }

  /**
   * Feature 011 — STATE_SCHEMA_VERSION 1 → 2 forward migration.
   * Fills the three new `WorkflowRun` fields on legacy records.
   */
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

  /**
   * Feature 030 — STATE_SCHEMA_VERSION 5 → 6 forward migration. Runs AFTER
   * the v2 → v3 lift and the v4 → v5 pauseSource backfill, so the persisted
   * registry shape is well-formed when this migration considers it. Runs
   * BEFORE snapshot construction and watchdog start (per the CLAUDE.md
   * hard rule). Returns the audit events for the caller to forward through
   * `appendAudit`; the writer is constructed later in the activation chain.
   *
   * `persistedNumeric` is the numeric schema version read at the top of
   * `initialize()`. When it is missing (fresh workspace) or already 6, the
   * migration is a no-op. Idempotent.
   */
  private async migrateV5ToV6IfNeeded(
    persistedNumeric: number | undefined
  ): Promise<readonly StateMigratedV5ToV6AuditEvent[]> {
    const registry = this.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? null;
    const queueState = this.memento.get<QueueState>(KEYS.queue) ?? null;
    // Treat missing/legacy numeric version as v5 so the migration runs once
    // on first activation after the schema bump. A persisted numeric === 6
    // skips (idempotent no-op).
    const effectiveVersion = persistedNumeric === 6 ? 6 : 5;
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

  public getQueue(): QueueState {
    const persisted = this.memento.get<QueueState>(KEYS.queue);
    if (!persisted) {
      return {
        requests: [],
        inFlightId: null,
        paused: false,
        pausedReason: null,
        updatedAt: Date.now()
      };
    }
    return ensureExtendedQueueShape(persisted);
  }

  public setQueue(queue: QueueState): Promise<void> {
    const next = {
      ...queue,
      requests: compactRequestPositions(queue.requests),
      updatedAt: Date.now()
    };
    return this.serialize(KEYS.queue, () => this.memento.update(KEYS.queue, next)).then(() => {
      this.notify(KEYS.queue);
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
    const queue = this.getQueue();
    const pendingInTarget = queue.requests.filter(
      (item) => item.queueId === queueId && item.status === 'pending'
    );
    if (pendingInTarget.length >= MAX_PENDING_TASKS_PER_QUEUE) {
      throw new QueueMutationRejected(
        'task-cap-reached',
        `Queue ${queueId} already has ${MAX_PENDING_TASKS_PER_QUEUE} pending tasks`
      );
    }
    const insertAt = params.position ?? pendingInTarget.length;
    if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > pendingInTarget.length) {
      throw new QueueMutationRejected(
        'position-out-of-range',
        `Position must be in [0, ${pendingInTarget.length}] (got ${String(params.position)})`
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
    const shifted = queue.requests.map((item) =>
      item.queueId === queueId && item.status === 'pending' && item.position >= insertAt
        ? { ...item, position: item.position + 1, updatedAt: now }
        : item
    );
    await this.setQueue({
      ...queue,
      requests: [...shifted, nextRequest]
    });
    return nextRequest;
  }

  public async removePendingRequest(taskId: string): Promise<FeatureRequest> {
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
    await this.setQueue({
      ...queue,
      requests: queue.requests.filter((request) => request.id !== taskId)
    });
    return target;
  }

  public getRequest(taskId: string): FeatureRequest | null {
    return this.getQueue().requests.find((request) => request.id === taskId) ?? null;
  }

  public async removeRequest(taskId: string): Promise<FeatureRequest> {
    const queue = this.getQueue();
    const target = queue.requests.find((request) => request.id === taskId);
    if (!target) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
    await this.setQueue({
      ...queue,
      inFlightId: queue.inFlightId === taskId ? null : queue.inFlightId,
      requests: queue.requests.filter((request) => request.id !== taskId)
    });
    return target;
  }

  public async modifyPendingRequest(
    taskId: string,
    updates: { description?: string }
  ): Promise<FeatureRequest> {
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
    const now = Date.now();
    const nextTarget: FeatureRequest = {
      ...target,
      ...(updates.description !== undefined
        ? { description: validateDescription(updates.description) }
        : {}),
      updatedAt: now
    };
    await this.setQueue({
      ...queue,
      requests: queue.requests.map((request) =>
        request.id === taskId ? nextTarget : request
      )
    });
    return nextTarget;
  }

  public async reorderPendingRequest(taskId: string, position: number): Promise<FeatureRequest> {
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
    const queueId = target.queueId ?? DEFAULT_QUEUE_ID;
    const peers = queue.requests
      .filter((request) => request.queueId === queueId && request.status === 'pending')
      .sort((a, b) => a.position - b.position);
    if (!Number.isInteger(position) || position < 0 || position >= peers.length) {
      throw new QueueMutationRejected(
        'position-out-of-range',
        `Position must be in [0, ${Math.max(0, peers.length - 1)}] (got ${position})`
      );
    }
    const reordered = peers.filter((request) => request.id !== taskId);
    reordered.splice(position, 0, target);
    const byId = new Map(
      reordered.map((request, nextPosition) => [
        request.id,
        { ...request, position: nextPosition, updatedAt: Date.now() }
      ])
    );
    await this.setQueue({
      ...queue,
      requests: queue.requests.map((request) => byId.get(request.id) ?? request)
    });
    return byId.get(taskId) ?? target;
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
    const withoutTarget = queue.requests.filter((request) => request.id !== taskId);
    const shifted = withoutTarget.map((request) =>
      request.queueId === params.targetQueueId &&
      request.status === 'pending' &&
      request.position >= insertAt
        ? { ...request, position: request.position + 1, updatedAt: now }
        : request
    );
    const moved: FeatureRequest = {
      ...target,
      queueId: params.targetQueueId,
      position: insertAt,
      updatedAt: now
    };
    await this.setQueue({
      ...queue,
      requests: [...shifted, moved]
    });
    return moved;
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
      const next = [...existing, entry];
      const trimmed = next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
      await this.memento.update(KEYS.history, trimmed);
    }).then(() => {
      this.notify(KEYS.history);
    });
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
