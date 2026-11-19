/**
 * FR-R7-07 — `WorkspaceStateStore` facade.
 *
 * Coordinates workspace state across cohesive key-family modules:
 *   - `workspace-state-types.ts`      — `KEYS`, constants, public types, `QueueMutationRejected`, family context
 *   - `workspace-state-migrations.ts` — forward migrations v2..v15 executed by `initialize()`
 *   - `workspace-state-queue.ts`      — queue states, queue registry, task CRUD, concurrency cap & notice
 *   - `workspace-state-runs.ts`       — Run map, quarantine, `setRun`, `updateRun`, `admitRunAtomically`, terminal intents
 *   - `workspace-state-locks.ts`      — workspace lock, guarded mirror refresh, execution leases, watchdog, pseudonym
 *   - `workspace-state-history.ts`    — per-queue history partitions & bounded append
 *   - `workspace-state-grants.ts`     — confirmation suppression, Git plan grants, agent config grants
 *   - `workspace-state-connected.ts`  — connected workflow runs CAS/delete, control ledger, reset transaction
 *
 * The facade exclusively owns the single `chains` serialization map (`serialize` /
 * `serializeAcrossKeys`), the single `MementoWriteGate`, and the single `OwnershipRegistry`
 * commit fence, passing them to family modules via `WorkspaceStateFamilyContext`
 * (docs/hard-rules.md rules 4, 7, 28, 57, 58).
 */

import type {
  RunQuarantineEntry,
  RunRecordQuarantinedPayload
} from '../contracts/audit-events';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { MAX_QUEUES } from '../contracts/queue-bounds';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import { ensureExtendedFeatureRequest } from '../contracts/queue-feature-request-helpers';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import type {
  ProjectedQueueRegistry,
  QueuePauseSource,
  QueueRegistry
} from '../contracts/queue-registry';
import type { SanitizedLogger } from '../lib/logger';
import type { FeatureRequest, QueueState } from '../queue/feature-request';
import type { AgentConfigGrant, AgentConfigGrantMap } from './agent-config-grants';
import type { ConfirmSuppressionState } from './confirm-suppression';
import type { ConnectedWorkflowRun } from './connected-workflow-run';
import type { ExecutionLease } from './execution-lease';
import type { GitPlanGrant, GitPlanGrantMap } from './git-plan-grants';
import { systemScheduler, type Scheduler } from './lock';
import { MementoWriteGate, StorageWriteQuarantinedError } from './memento-write-gate';
import {
  checkCommitFence,
  unfencedCommit,
  type CommitFenceFailure,
  type QueueCommitClaim,
  type RunCommitClaim
} from './ownership-claim';
import { createMementoOwnershipFs, type OwnershipFs } from './ownership-fs';
import {
  MEMENTO_OWNERSHIP_DIR,
  OwnershipRegistry,
  type FenceCheck
} from './ownership-registry';
import type { QueueStateMap } from './queue-state-migrator';
import type { ResetMarker } from './reset-transaction';
import { createRunQuarantine } from './run-quarantine';
import type { RunStateMap } from './run-state-migrator';
import type { RunTransitionActor } from './run-transition-decision';
import type { RunUpdate } from './run-update';
import type {
  TerminalTransitionIntent,
  WatchdogState,
  WorkflowRun,
  WorkspaceLock
} from './workflow-run';
import type { LoadRepairWarning } from './workflow-run-migrator';
import * as connectedFamily from './workspace-state-connected';
import * as grantsFamily from './workspace-state-grants';
import * as historyFamily from './workspace-state-history';
import * as locksFamily from './workspace-state-locks';
import * as migrationsFamily from './workspace-state-migrations';
import * as queueFamily from './workspace-state-queue';
import * as runsFamily from './workspace-state-runs';
import {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  MAX_DELETED_HISTORY_PARTITIONS,
  QueueMutationRejected,
  RESET_CLEARED_KEYS,
  RESET_EXEMPT_KEYS,
  SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  isRunRaceRefusal,
  safeDisplay,
  type ConcurrencyNotice,
  type ConnectedRunWriteResult,
  type Disposable,
  type ForwardMigrationEvents,
  type GuardedWriteOutcome,
  type InitializeResult,
  type Memento,
  type OwnershipClaim,
  type PersistedHistoryEntry,
  type PersistedHistoryMap,
  type PrimacyClaimSource,
  type QueueDeletionView,
  type QueueMutationRejectReason,
  type RunClaimSource,
  type RunReadVerdict,
  type StoreChangeKey,
  type StoreChangeListener,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

export {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  MAX_DELETED_HISTORY_PARTITIONS,
  QueueMutationRejected,
  RESET_CLEARED_KEYS,
  RESET_EXEMPT_KEYS,
  SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  isRunRaceRefusal,
  type ConcurrencyNotice,
  type ConnectedRunWriteResult,
  type Disposable,
  type ForwardMigrationEvents,
  type GuardedWriteOutcome,
  type InitializeResult,
  type Memento,
  type OwnershipClaim,
  type PersistedHistoryEntry,
  type PersistedHistoryMap,
  type PrimacyClaimSource,
  type QueueDeletionView,
  type QueueMutationRejectReason,
  type RunClaimSource,
  type RunReadVerdict,
  type StoreChangeKey,
  type StoreChangeListener
};
export { CONFIRM_SUPPRESSION_VERSION, type ConfirmSuppressionState } from './confirm-suppression';
export { type GitPlanGrant, type GitPlanGrantMap } from './git-plan-grants';
export { RUN_UPDATE_LABELS, type RunUpdate, type RunUpdateLabel } from './run-update';
export {
  RunFieldInvariantError,
  RunInvariantError,
  RunTransitionError,
  type RunFieldInvariantCode
} from './run-invariant-error';
export {
  ALL_RUN_TRANSITION_ACTORS,
  DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL,
  RUN_STATUS_TRANSITIONS,
  allowedSameStatusFor,
  allowedSourceStatusesFor,
  allowedSourceStatusesForTargets,
  decideRunTransition,
  type RunTransitionActor,
  type RunTransitionDecision,
  type RunTransitionDecisionInput,
  type RunTransitionRefusalReason,
  type RunTransitionTable
} from './run-transition-decision';
export {
  MEMENTO_WRITE_DEADLINE_MS,
  StorageWriteQuarantinedError,
  type MementoBatchEntry,
  type StorageWriteFailureReason
} from './memento-write-gate';

/**
 * Feature 092 (T056, FR-026/FR-027) — the workspace concurrency ceiling's upper bound.
 *
 * Feature 094 — the authority for a cap above one is
 * `docs/architecture/local-queue-parallelism-ratification.md`. Raising this bound
 * past `MAX_QUEUES`, or widening `MAX_QUEUES` itself, is outside what that record authorises.
 */
export const MAX_GLOBAL_CONCURRENCY_CAP = MAX_QUEUES;

function assertGlobalConcurrencyCap(
  value: unknown,
  origin: 'requested' | 'persisted'
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_GLOBAL_CONCURRENCY_CAP
  ) {
    throw new QueueMutationRejected(
      'invalid-global-concurrency-cap',
      `globalConcurrencyCap must be an integer in [1, ${MAX_GLOBAL_CONCURRENCY_CAP}] (${origin}: ${safeDisplay(value)})`
    );
  }
}

const RETIRED_START_SOURCE = 'wake-up-runner';

function coerceRetiredStartSource(
  source: QueueState['scheduledStartSource']
): QueueState['scheduledStartSource'] {
  return (source as string | null) === RETIRED_START_SOURCE ? 'programmatic-scheduled' : source;
}

function normalizePauseSource(
  persisted: QueueState,
  queueLifecycle: QueueState['queueLifecycle'],
  legacyPaused: boolean
): QueuePauseSource {
  if (queueLifecycle !== 'operator-paused' && !legacyPaused) return null;
  return persisted.pauseSource ?? 'operator';
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

function ensureExtendedQueueShape(persisted: QueueState): QueueState {
  const requests = Array.isArray(persisted.requests)
    ? persisted.requests.map((r) => ensureExtendedFeatureRequest(r as FeatureRequest))
    : [];
  const normalizedRequests = compactRequestPositions(requests);
  const paused = persisted.paused ?? false;
  const inFlightId = persisted.inFlightId ?? null;
  const persistedLifecycle = (persisted as QueueState).queueLifecycle;
  const queueLifecycle =
    persistedLifecycle ??
    deriveLifecycleFromLegacyShape(paused, inFlightId, normalizedRequests.length);
  const scheduledStartAt = (persisted as QueueState).scheduledStartAt ?? null;
  const scheduledStartSource = coerceRetiredStartSource(
    (persisted as QueueState).scheduledStartSource ?? null
  );
  const migrationNotice = (persisted as QueueState).migrationNotice;
  const pauseSource = normalizePauseSource(persisted, queueLifecycle, paused);
  return {
    inFlightId,
    updatedAt: persisted.updatedAt ?? Date.now(),
    requests: normalizedRequests,
    queueLifecycle,
    pauseSource,
    pausedReason: pauseSource === null ? null : persisted.pausedReason ?? null,
    scheduledStartAt: queueLifecycle === 'idle-pending' ? scheduledStartAt : null,
    scheduledStartSource: queueLifecycle === 'idle-pending' ? scheduledStartSource : null,
    ...(migrationNotice ? { migrationNotice } : {}),
    ...(persisted.failurePolicy !== undefined ? { failurePolicy: persisted.failurePolicy } : {})
  };
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

export class WorkspaceStateStore {
  private readonly runQuarantine = createRunQuarantine({
    read: () => this.memento.get<RunQuarantineEntry[]>(KEYS.runQuarantine) ?? [],
    write: (entries) => this.memento.update(KEYS.runQuarantine, entries),
    now: () => Date.now(),
    warn: (reason) => this.logger?.warn('run record quarantine failed', { reason })
  });

  private readonly rawMemento: Memento;
  private readonly memento: Memento;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<StoreChangeListener>();
  private readonly logger: SanitizedLogger | null;
  private readonly writeGate: MementoWriteGate;
  private runClaimSource: RunClaimSource | null = null;
  private primacyClaimSource: PrimacyClaimSource | null = null;
  private readonly unfencedQueuesWarned = new Set<string>();
  private readonly grantsWarned = grantsFamily.createGrantsWarningState();
  private readonly connectedRunsWarned = connectedFamily.createConnectedRunsWarningState();
  private ownershipRegistry: OwnershipRegistry;
  private readonly scheduler: Scheduler;
  private readonly familyContext: WorkspaceStateFamilyContext;

  constructor(memento: Memento, logger?: SanitizedLogger, scheduler: Scheduler = systemScheduler) {
    this.rawMemento = memento;
    this.memento = {
      get: <T>(key: string): T | undefined => this.rawMemento.get<T>(key),
      update: (key: string, value: unknown): PromiseLike<void> => this.writeGate.write(key, value)
    };
    this.logger = logger ?? null;
    this.scheduler = scheduler;
    this.writeGate = new MementoWriteGate(memento, scheduler, this.logger);
    this.ownershipRegistry = new OwnershipRegistry(
      createMementoOwnershipFs(memento),
      MEMENTO_OWNERSHIP_DIR
    );
    this.familyContext = {
      supportsBatchWrite: this.rawMemento.updateBatch !== undefined,
      memento: this.memento,
      writeGate: this.writeGate,
      logger: this.logger,
      scheduler: this.scheduler,
      runQuarantine: this.runQuarantine,
      getOwnershipRegistry: () => this.ownershipRegistry,
      getRunClaimSource: () => this.runClaimSource,
      getPrimacyClaimSource: () => this.primacyClaimSource,
      serialize: (key, op) => this.serialize(key, op),
      serializeAcrossKeys: (keys, op) => this.serializeAcrossKeys(keys, op),
      notify: (key) => this.notify(key),
      runCommitClaim: (queueId) => this.runCommitClaim(queueId),
      refuseIfClaimLost: (queueId) => this.refuseIfClaimLost(queueId),
      verifyPrimacyForCommit: (label) => this.verifyPrimacyForCommit(label),
      verifyQueueOwnershipForCommit: (queueId, label) =>
        this.verifyQueueOwnershipForCommit(queueId, label),
      refuseCommit: (failure, claim, queueId) => this.refuseCommit(failure, claim, queueId),
      ensureExtendedQueueShape,
      compactRequestPositions,
      assertGlobalConcurrencyCap,
      readQueueMap: () => queueFamily.readQueueMap(this.familyContext),
      getQueue: (queueId) => queueFamily.getQueue(this.familyContext, queueId),
      getQueueRegistry: () => queueFamily.getQueueRegistry(this.familyContext),
      getRun: (queueId) => runsFamily.readRunForQueue(this.familyContext, queueId),
      readHistoryMap: () => historyFamily.readHistoryMap(this.familyContext),
      pruneExcessDeletedHistoryPartitions: (map, registeredIds) =>
        historyFamily.pruneExcessDeletedHistoryPartitions(this.familyContext, map, registeredIds),
      warnLoadRepairs: (warnings) => this.warnLoadRepairs(warnings),
      getTerminalTransitionIntents: () =>
        runsFamily.getTerminalTransitionIntents(this.familyContext),
      migrationSteps: {
        migrateV12ToV13IfNeeded: () => this.migrateV12ToV13IfNeeded(),
        migrateVerdictBasisIfNeeded: () => this.migrateVerdictBasisIfNeeded(),
        migrateCreditPauseIfNeeded: () => this.migrateCreditPauseIfNeeded(),
        reconcileOrphanedRunsIfNeeded: () => this.reconcileOrphanedRunsIfNeeded()
      }
    };
  }

  public isWriterQuarantined(): boolean {
    return this.writeGate.isQuarantined();
  }

  public get ownership(): OwnershipRegistry {
    return this.ownershipRegistry;
  }

  public useOwnershipStorage(fs: OwnershipFs, dir: string): void {
    this.ownershipRegistry = new OwnershipRegistry(fs, dir);
  }

  public verifyClaim(claim: OwnershipClaim): Promise<FenceCheck> {
    return this.ownershipRegistry.verify(claim.resource, claim.ownerId, claim.fence);
  }

  public bindRunClaimSource(source: RunClaimSource): void {
    this.runClaimSource = source;
  }

  public bindPrimacyClaimSource(source: PrimacyClaimSource): void {
    this.primacyClaimSource = source;
  }

  public canCommitConnectedRun(): Promise<boolean> {
    return this.primacyClaimSource?.canCommitConnectedRun() ?? Promise.resolve(true);
  }

  public runCommitClaim(queueId: string): RunCommitClaim {
    this.refuseIfClaimLost(queueId);
    const claim = this.runClaimSource?.claimFor(queueId) ?? null;
    if (claim !== null) return claim;
    if (!this.unfencedQueuesWarned.has(queueId)) {
      this.unfencedQueuesWarned.add(queueId);
      this.logger?.warn('state commit carries no execution fence', {
        reason: 'lease-not-held'
      });
    }
    return unfencedCommit('lease-not-held');
  }

  private refuseIfClaimLost(queueId: string): void {
    if (this.runClaimSource?.tenureOf?.(queueId).state !== 'lost') return;
    throw new QueueMutationRejected(
      'ownership-lost',
      `Run mutation refused: this window lost its claim on queue ${queueId}`
    );
  }

  private async verifyPrimacyForCommit(label: string): Promise<void> {
    if (
      this.primacyClaimSource !== null &&
      !(await this.primacyClaimSource.canCommitConnectedRun())
    ) {
      throw new QueueMutationRejected(
        'ownership-lost',
        `${label} mutation refused: this window does not hold workspace primacy`
      );
    }
  }

  private async verifyQueueOwnershipForCommit(
    queueId: string,
    label: 'Queue' | 'Run' = 'Queue'
  ): Promise<void> {
    this.refuseIfClaimLost(queueId);
    const claim = this.runClaimSource?.claimFor(queueId) ?? null;
    if (claim !== null) {
      const f = await checkCommitFence(
        this.ownershipRegistry,
        claim,
        queueId,
        label,
        this.scheduler
      );
      if (f !== null) this.refuseCommit(f, claim, queueId);
    }
  }

  private refuseCommit(
    failure: CommitFenceFailure,
    claim: OwnershipClaim,
    queueId: string
  ): never {
    if (failure.reason === 'fence-superseded') {
      const current = this.runClaimSource?.claimFor(queueId) ?? null;
      if (current?.ownerId === claim.ownerId && current.fence === claim.fence) {
        this.runClaimSource?.markLost?.(queueId, 'superseded');
      }
    }
    throw new QueueMutationRejected(failure.reason, failure.message);
  }

  private warnLoadRepairs(warnings: readonly LoadRepairWarning[]): void {
    for (const warning of warnings) {
      this.logger?.warn('run record repaired on load', { reasonCode: warning.reasonCode });
    }
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

  // ── Migrations ────────────────────────────────────────────────────────────────

  public initialize(): Promise<InitializeResult> {
    return migrationsFamily.initializeWorkspaceState(this.familyContext);
  }

  private migrateV12ToV13IfNeeded() {
    return migrationsFamily.migrateV12ToV13IfNeeded(this.familyContext);
  }

  private migrateVerdictBasisIfNeeded() {
    return migrationsFamily.migrateVerdictBasisIfNeeded(this.familyContext);
  }

  private migrateCreditPauseIfNeeded() {
    return migrationsFamily.migrateCreditPauseIfNeeded(this.familyContext);
  }

  private reconcileOrphanedRunsIfNeeded() {
    return migrationsFamily.reconcileOrphanedRunsIfNeeded(this.familyContext);
  }

  // ── Queue & Registry ──────────────────────────────────────────────────────────

  public getQueue(queueId: string): QueueState {
    return queueFamily.getQueue(this.familyContext, queueId);
  }

  public getQueueStates(): QueueStateMap {
    return queueFamily.getQueueStates(this.familyContext);
  }

  public getQueueStateIds(): readonly string[] {
    return queueFamily.getQueueStateIds(this.familyContext);
  }

  public hasQueueState(queueId: string): boolean {
    return queueFamily.hasQueueState(this.familyContext, queueId);
  }

  /** @internal Full replacement seam for migrations and test setup only. */
  public setQueue(queue: QueueState, queueId: string = DEFAULT_QUEUE_ID): Promise<void> {
    return queueFamily.writeQueueState(this.familyContext, queue, queueId);
  }

  /** @internal Drop one queue's execution state unconditionally; no production path calls it. */
  public deleteQueueState(queueId: string): Promise<void> {
    return queueFamily.deleteQueueState(this.familyContext, queueId);
  }

  public updateQueue<T>(
    mutate: (current: QueueState) => { readonly queue: QueueState; readonly result: T },
    queueId: string,
    claim: QueueCommitClaim
  ): Promise<T> {
    return queueFamily.updateQueue(this.familyContext, mutate, queueId, claim);
  }

  public getQueueRegistry(): QueueRegistry {
    return queueFamily.getQueueRegistry(this.familyContext);
  }

  public getProjectedQueueRegistry(
    workspaceFailurePolicyDefault: QueueFailurePolicy = 'halt-on-failure'
  ): ProjectedQueueRegistry {
    return queueFamily.getProjectedQueueRegistry(
      this.familyContext,
      workspaceFailurePolicyDefault
    );
  }

  public setQueueRegistry(registry: QueueRegistry): Promise<void> {
    return queueFamily.setQueueRegistry(this.familyContext, registry);
  }

  public updateQueueRegistry<T>(
    mutate: (current: QueueRegistry) => { readonly registry: QueueRegistry; readonly result: T },
    queueIds: readonly string[] = []
  ): Promise<T> {
    return queueFamily.updateQueueRegistry(this.familyContext, mutate, queueIds);
  }

  public deleteQueueIfNoLiveRun<I extends { readonly outcome: 'refused' | 'deletable' }>(
    queueId: string,
    recheck: (view: QueueDeletionView) => I,
    now: number
  ): Promise<I> {
    return queueFamily.deleteQueueIfNoLiveRun(this.familyContext, queueId, recheck, now);
  }

  public getDefaultQueueId(): string {
    return queueFamily.getDefaultQueueId(this.familyContext);
  }

  public setDefaultQueueId(id: string): Promise<void> {
    return queueFamily.setDefaultQueueId(this.familyContext, id);
  }

  public getGlobalConcurrencyCap(): number {
    return queueFamily.getGlobalConcurrencyCap(this.familyContext);
  }

  public setGlobalConcurrencyCap(value: number): Promise<void> {
    return queueFamily.setGlobalConcurrencyCap(this.familyContext, value);
  }

  public getConcurrencyNotice(): ConcurrencyNotice | null {
    return queueFamily.getConcurrencyNotice(this.familyContext);
  }

  public setConcurrencyNotice(value: ConcurrencyNotice): Promise<void> {
    return queueFamily.setConcurrencyNotice(this.familyContext, value);
  }

  public getRequestsForQueue(queueId: string): FeatureRequest[] {
    return queueFamily.getRequestsForQueue(this.familyContext, queueId);
  }

  public insertPendingRequest(
    request: FeatureRequest,
    params: { queueId?: string; position?: number | null } = {}
  ): Promise<FeatureRequest> {
    return queueFamily.insertPendingRequest(this.familyContext, request, params);
  }

  public getRequest(taskId: string): FeatureRequest | null {
    return queueFamily.getRequest(this.familyContext, taskId);
  }

  public removeRequest(taskId: string): Promise<FeatureRequest> {
    return queueFamily.removeRequest(this.familyContext, taskId);
  }

  public modifyPendingRequest(
    taskId: string,
    updates: { description?: string }
  ): Promise<FeatureRequest> {
    return queueFamily.modifyPendingRequest(this.familyContext, taskId, updates);
  }

  public reorderPendingRequest(taskId: string, position: number): Promise<FeatureRequest> {
    return queueFamily.reorderPendingRequest(this.familyContext, taskId, position);
  }

  public movePendingRequest(
    taskId: string,
    params: { targetQueueId: string; position?: number | null }
  ): Promise<FeatureRequest> {
    return queueFamily.movePendingRequest(this.familyContext, taskId, params);
  }

  // ── Runs, Quarantine & Terminal Intents ───────────────────────────────────────

  public getRun(queueId: string): WorkflowRun | null {
    return runsFamily.readRunForQueue(this.familyContext, queueId);
  }

  public readRunIfLive(queueId: string): Promise<RunReadVerdict> {
    return runsFamily.readRunIfLive(this.familyContext, queueId);
  }

  public getRunMap(): Readonly<RunStateMap> {
    return runsFamily.getRunMap(this.familyContext);
  }

  public findRunByTask(
    taskId: string
  ): { readonly queueId: string; readonly run: WorkflowRun } | null {
    return runsFamily.findRunByTask(this.familyContext, taskId);
  }

  public findRunById(
    runId: string
  ): { readonly queueId: string; readonly run: WorkflowRun } | null {
    return runsFamily.findRunById(this.familyContext, runId);
  }

  public setRun(
    queueId: string,
    run: WorkflowRun | null,
    claim: RunCommitClaim,
    actor: RunTransitionActor = 'driver'
  ): Promise<void> {
    return runsFamily.writeRunForQueue(this.familyContext, queueId, run, claim, actor);
  }

  public updateRun(
    queueId: string,
    update: RunUpdate,
    claim: RunCommitClaim
  ): Promise<WorkflowRun> {
    return runsFamily.updateRunForQueue(this.familyContext, queueId, update, claim);
  }

  public admitRunAtomically<T>(
    queueId: string,
    run: WorkflowRun,
    mutateQueue: (queue: QueueState) => { readonly queue: QueueState; readonly result: T },
    claim: RunCommitClaim
  ): Promise<T> {
    return runsFamily.admitRunAtomically(this.familyContext, queueId, run, mutateQueue, claim);
  }

  public getTerminalTransitionIntents(): Readonly<Record<string, TerminalTransitionIntent>> {
    return runsFamily.getTerminalTransitionIntents(this.familyContext);
  }

  public setTerminalTransitionIntent(
    runId: string,
    intent: TerminalTransitionIntent | null
  ): Promise<void> {
    return runsFamily.setTerminalTransitionIntent(this.familyContext, runId, intent);
  }

  public removeTerminalIntentIfOwn(runId: string, createdAt: number): Promise<boolean> {
    return runsFamily.removeTerminalIntentIfOwn(this.familyContext, runId, createdAt);
  }

  public drainRunQuarantineEvents(): ReadonlyArray<{
    readonly eventType: 'run-record-quarantined';
    readonly payload: RunRecordQuarantinedPayload;
  }> {
    return runsFamily.drainRunQuarantineEvents(this.familyContext);
  }

  // ── Locks, Leases, Watchdog & Operator Pseudonym ──────────────────────────────

  public refreshLockMirrorGuarded(
    claim: OwnershipClaim,
    mirror: WorkspaceLock,
    options: { readonly refreshHeartbeatAt?: number } = {}
  ): Promise<GuardedWriteOutcome> {
    return locksFamily.refreshLockMirrorGuarded(this.familyContext, claim, mirror, options);
  }

  public getLock(): WorkspaceLock | null {
    return locksFamily.getLock(this.familyContext);
  }

  public setLock(lock: WorkspaceLock | null): Promise<void> {
    return locksFamily.setLock(this.familyContext, lock);
  }

  public getExecutionLeases(): Record<string, ExecutionLease> {
    return locksFamily.getExecutionLeases(this.familyContext);
  }

  public setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void> {
    return locksFamily.setExecutionLease(this.familyContext, queueId, lease);
  }

  public getWatchdog(): WatchdogState {
    return locksFamily.getWatchdog(this.familyContext);
  }

  public setWatchdog(state: WatchdogState): Promise<void> {
    return locksFamily.setWatchdog(this.familyContext, state);
  }

  public readOperatorPseudonym(): unknown {
    return locksFamily.readOperatorPseudonym(this.familyContext);
  }

  public writeOperatorPseudonym(value: {
    readonly version: 1;
    readonly pseudonym: string;
  }): Promise<void> {
    return locksFamily.writeOperatorPseudonym(this.familyContext, value);
  }

  // ── History ───────────────────────────────────────────────────────────────────

  public getHistoryMap(): Readonly<PersistedHistoryMap> {
    return historyFamily.getHistoryMap(this.familyContext);
  }

  public getHistory(): PersistedHistoryEntry[] {
    return historyFamily.getHistory(this.familyContext);
  }

  public appendHistory(
    queueId: string,
    entry: PersistedHistoryEntry
  ): Promise<readonly PersistedHistoryEntry[]> {
    return historyFamily.appendHistory(this.familyContext, queueId, entry);
  }

  // ── Grants & Suppression ──────────────────────────────────────────────────────

  public getConfirmSuppression(): ConfirmSuppressionState {
    return grantsFamily.getConfirmSuppression(this.familyContext);
  }

  public setConfirmSuppression(actionKey: string, suppressed: boolean): Promise<void> {
    return grantsFamily.setConfirmSuppression(this.familyContext, actionKey, suppressed);
  }

  public getGitPlanGrants(): GitPlanGrantMap {
    return grantsFamily.getGitPlanGrants(this.familyContext, this.grantsWarned);
  }

  public hasGitPlanGrant(fingerprint: string): boolean {
    return grantsFamily.hasGitPlanGrant(this.familyContext, this.grantsWarned, fingerprint);
  }

  public recordGitPlanGrant(grant: GitPlanGrant): Promise<void> {
    return grantsFamily.recordGitPlanGrant(this.familyContext, this.grantsWarned, grant);
  }

  public forgetGitPlanGrant(fingerprint: string): Promise<boolean> {
    return grantsFamily.forgetGitPlanGrant(this.familyContext, this.grantsWarned, fingerprint);
  }

  public forgetAllGitPlanGrants(): Promise<number> {
    return grantsFamily.forgetAllGitPlanGrants(this.familyContext, this.grantsWarned);
  }

  public getAgentConfigGrants(): AgentConfigGrantMap {
    return grantsFamily.getAgentConfigGrants(this.familyContext, this.grantsWarned);
  }

  public hasAgentConfigGrant(fingerprint: string, backend?: BackendRunnerKind): boolean {
    return grantsFamily.hasAgentConfigGrant(
      this.familyContext,
      this.grantsWarned,
      fingerprint,
      backend
    );
  }

  public latestAgentConfigGrantForBackend(backend: BackendRunnerKind): AgentConfigGrant | null {
    return grantsFamily.latestAgentConfigGrantForBackend(
      this.familyContext,
      this.grantsWarned,
      backend
    );
  }

  public recordAgentConfigGrant(grant: AgentConfigGrant): Promise<void> {
    return grantsFamily.recordAgentConfigGrant(this.familyContext, this.grantsWarned, grant);
  }

  public forgetAgentConfigGrant(fingerprint: string): Promise<boolean> {
    return grantsFamily.forgetAgentConfigGrant(this.familyContext, this.grantsWarned, fingerprint);
  }

  public forgetAllAgentConfigGrants(): Promise<number> {
    return grantsFamily.forgetAllAgentConfigGrants(this.familyContext, this.grantsWarned);
  }

  // ── Connected Runs, Control Ledger & Reset ────────────────────────────────────

  public getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>> {
    return connectedFamily.getConnectedRuns(this.familyContext, this.connectedRunsWarned);
  }

  public getConnectedRun(connectedRunId: string): ConnectedWorkflowRun | null {
    return connectedFamily.getConnectedRun(
      this.familyContext,
      this.connectedRunsWarned,
      connectedRunId
    );
  }

  public compareAndSetConnectedRun(
    next: ConnectedWorkflowRun,
    expectedRevision: number
  ): Promise<ConnectedRunWriteResult> {
    return connectedFamily.compareAndSetConnectedRun(
      this.familyContext,
      this.connectedRunsWarned,
      next,
      expectedRevision
    );
  }

  public deleteConnectedRuns(connectedRunIds: readonly string[]): Promise<number> {
    return connectedFamily.deleteConnectedRuns(
      this.familyContext,
      this.connectedRunsWarned,
      connectedRunIds
    );
  }

  public getRawControlLedger(): unknown {
    return connectedFamily.getRawControlLedger(this.familyContext);
  }

  public transactControlLedger<T>(
    op: (raw: unknown, write: (next: unknown) => Promise<void>) => Promise<T>
  ): Promise<T> {
    return connectedFamily.transactControlLedger(this.familyContext, op);
  }

  public getResetMarker(): ResetMarker | null {
    return connectedFamily.getResetMarker(this.familyContext);
  }

  public reset(): Promise<number> {
    return connectedFamily.resetWorkspaceState(this.familyContext);
  }

  public completeInterruptedReset(): Promise<number | null> {
    return connectedFamily.completeInterruptedReset(this.familyContext);
  }

  // ── Single Serialization Chain (Hard Rule 58) ─────────────────────────────────

  private serializeAcrossKeys(
    keys: readonly string[],
    op: () => PromiseLike<void> | Promise<void>
  ): Promise<void> {
    if (this.writeGate.isQuarantined()) {
      return Promise.reject(
        new StorageWriteQuarantinedError(
          'storage-write-quarantined',
          `Workspace state write refused for ${keys.join(',')}: storage writer is quarantined`
        )
      );
    }
    const predecessors = keys.map((key) => this.chains.get(key) ?? Promise.resolve());
    const next = Promise.all(predecessors).then(() => {
      if (this.writeGate.isQuarantined()) {
        throw new StorageWriteQuarantinedError(
          'storage-write-quarantined',
          `Workspace state write refused for ${keys.join(',')}: storage writer is quarantined`
        );
      }
      return Promise.resolve(op()).then(() => undefined);
    });
    const stored = next.catch(() => undefined);
    for (const key of keys) this.chains.set(key, stored);
    return next;
  }

  private serialize(key: string, op: () => PromiseLike<void> | Promise<void>): Promise<void> {
    if (this.writeGate.isQuarantined()) {
      return Promise.reject(
        new StorageWriteQuarantinedError(
          'storage-write-quarantined',
          `Workspace state write refused for ${key}: storage writer is quarantined`
        )
      );
    }
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => {
      if (this.writeGate.isQuarantined()) {
        throw new StorageWriteQuarantinedError(
          'storage-write-quarantined',
          `Workspace state write refused for ${key}: storage writer is quarantined`
        );
      }
      return Promise.resolve(op()).then(() => undefined);
    });
    this.chains.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }
}
