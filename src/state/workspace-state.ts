import {
  MAX_PENDING_TASKS_PER_QUEUE,
  ensureExtendedFeatureRequest,
  validateDescription,
  type FeatureRequest,
  type QueueState
} from '../queue/feature-request';
import {
  DEFAULT_QUEUE_ID,
  MAX_QUEUES,
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
import { STATE_SCHEMA_VERSION, STATE_SCHEMA_VERSION_V8 } from '../contracts/state-schema';
import {
  migrateLegacyRun,
  migrateQueueRegistryV4ToV5,
  repairLegacyRunSnapshot,
  type WorkflowRunRepairedAuditEvent
} from './workflow-run-migrator';
import {
  assertPersistedVersionSupported,
  migrateLegacyQueueState,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV9ToV10,
  type QueueStateMap,
  type StateMigratedV5ToV6AuditEvent,
  type StateMigratedV6ToV7AuditEvent,
  type StateMigratedV9ToV10AuditEvent
} from './queue-state-migrator';
import {
  isRunStateMap,
  isWorkflowRun,
  migrateV10ToV11,
  type RunStateMap,
  type RunStateMigrationAuditEvent
} from './run-state-migrator';
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

/**
 * Feature 092 (T056, FR-026/FR-027) — the workspace concurrency ceiling's
 * default and upper bound.
 *
 * The upper bound is `MAX_QUEUES` rather than a second literal 20, because a
 * ceiling above the number of queues is unreachable by construction: each queue
 * runs at most one Task, so no workspace can exceed `MAX_QUEUES` in flight. The
 * two numbers agreeing is a fact, not a coincidence to be maintained by hand.
 *
 * Feature 094 — the *authority* for a cap above one, as distinct from the
 * mechanism above that makes one representable, is
 * `docs/architecture/local-queue-parallelism-ratification.md`. It narrows one
 * clause of the remote/multi-user expansion gate for the local single-operator
 * shape only, dispositions the gate's seven exit criteria individually, and
 * enumerates the premises whose change reopens the question. Raising this
 * bound past `MAX_QUEUES`, or widening `MAX_QUEUES` itself, is outside what
 * that record authorises.
 *
 * This is one of six sites that define the cap's value or its bounds: three
 * enforce (here, `queue/queue-manager.ts`, `contracts/validators/
 * queue-management.ts`) and three advertise (`config/settings-schema.ts`,
 * `config/general-settings.ts`, `package.json`). The enforcing three derive
 * their ceiling; only the advertising three restate the numbers.
 */
// Feature 098 (REL-02) — 3 -> 1. See `config/general-settings.ts` for the
// reasoning; the ceiling below and the ratification record are unchanged.
export const DEFAULT_GLOBAL_CONCURRENCY_CAP = 1;
export const MAX_GLOBAL_CONCURRENCY_CAP = MAX_QUEUES;

/**
 * The single range check both the reader and the setter use. `origin`
 * distinguishes "the operator just asked for this" from "this is what was on
 * disk", which is the only part of the two call sites that legitimately
 * differs.
 */
function assertGlobalConcurrencyCap(value: unknown, origin: 'requested' | 'persisted'): asserts value is number {
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

/**
 * Wake-up withdrawal — forward-only coercion of the retired
 * `'wake-up-runner'` start source.
 *
 * The literal was dropped from `ScheduledStartSource` with the capability
 * that produced it, but it may still sit in a queue record persisted by an
 * earlier release. It maps to `'programmatic-scheduled'` because that is
 * what it always meant operationally: a non-human caller armed a scheduled
 * start. Coercing on read rather than rewriting on upgrade keeps this a
 * pure projection — the value is normalized every time the record is read,
 * so there is no migration to miss and no half-migrated state.
 *
 * Every persisted `QueueState` reaches this through
 * `ensureExtendedQueueShape`, which is the single normalization point.
 */
const RETIRED_START_SOURCE = 'wake-up-runner';

function coerceRetiredStartSource(
  source: QueueState['scheduledStartSource']
): QueueState['scheduledStartSource'] {
  return (source as string | null) === RETIRED_START_SOURCE ? 'programmatic-scheduled' : source;
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
  const scheduledStartSource = coerceRetiredStartSource(
    (persisted as QueueState).scheduledStartSource ?? null
  );
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
  confirmSuppression: 'schegent.ui.confirmSuppression',
  // Feature 088 (FR-006) — connected Workflow runs, keyed by connectedRunId.
  // A separate key from `run`/`queue` on purpose: the connected run is a
  // different aggregate, and keeping it separate is what makes its migration
  // a no-op for every workspace that predates the feature (FR-007).
  connectedRuns: 'schegent.connectedRuns',
  // Feature 092 (T049, FR-031) — per-queue execution leases, keyed by queueId.
  // Deliberately NOT `lock`: that key stays the one-per-workspace window-primacy
  // lease feeding `WorkflowSnapshot.isPrimary`, and merging the two would make a
  // window primary the moment it drained any queue.
  executionLeases: 'schegent.executionLeases',
  // Feature 092 (T065, FR-037) — the once-per-workspace shared-working-tree
  // notice, armed when the workspace first stops being single-queue.
  //
  // Its own key, and not a field on any `QueueState`: FR-037 scopes the notice
  // to the workspace, so storing it inside a queue record would make it per
  // queue by construction and deleting that queue would erase the operator's
  // dismissal. It is also NOT `QueueState.migrationNotice` (feature 065), which
  // is per queue, fires on a different trigger, and carries different text —
  // one shared field would make dismissing either dismiss both.
  concurrencyNotice: 'schegent.ui.concurrencyNotice'
} as const;

import { readConfirmSuppression, writeConfirmSuppression } from './confirm-suppression';
export { CONFIRM_SUPPRESSION_VERSION, type ConfirmSuppressionState } from './confirm-suppression';
import { migrateConnectedRuns } from './connected-run-migrator';
import { assertConnectedRunInvariants, type ConnectedWorkflowRun } from './connected-workflow-run';
// Type-only: `execution-lease.ts` imports the staleness constants from `lock.ts`,
// so a value import here would close a cycle the type import cannot.
import type { ExecutionLease } from './execution-lease';

export const HISTORY_CAP = 50;

/**
 * Feature 092 (T065, FR-037) — the answer to the shared-working-tree notice.
 *
 * Shares its two words with `QueueState.migrationNotice` and nothing else: that
 * one is per queue and records a migration, this one is per workspace and
 * records that the workspace stopped being single-queue. They are separate
 * types over separate keys so a future widening of either cannot silently reach
 * the other.
 */
export type ConcurrencyNotice = 'pending' | 'dismissed';

export type StoreChangeKey =
  | typeof KEYS.run
  | typeof KEYS.queue
  | typeof KEYS.queueRegistry
  | typeof KEYS.queueDefaultId
  | typeof KEYS.queueGlobalConcurrencyCap
  | typeof KEYS.lock
  | typeof KEYS.history
  | typeof KEYS.terminalTransitionIntent
  | typeof KEYS.connectedRuns
  | typeof KEYS.executionLeases
  | typeof KEYS.concurrencyNotice;

export type StoreChangeListener = (key: StoreChangeKey) => void;

export interface Disposable {
  dispose(): void;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Feature 088 (FR-046) — the outcome of a compare-and-set connected-run write.
 * `current` is the authoritative record at the moment of the refusal, and is
 * `null` when the run does not exist at all.
 */
export type ConnectedRunWriteResult =
  | { readonly outcome: 'written'; readonly run: ConnectedWorkflowRun }
  | { readonly outcome: 'stale'; readonly current: ConnectedWorkflowRun | null };

/**
 * The refusal arm, built through a function so the variable that holds it keeps
 * its declared union type. Assigning the object literal directly would narrow
 * the variable to the refusal arm, and the write arm assigned inside the
 * serialized closure would then be unreachable as far as the checker is
 * concerned.
 */
function staleConnectedRunWrite(current: ConnectedWorkflowRun | null): ConnectedRunWriteResult {
  return { outcome: 'stale', current };
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
/**
 * Feature 093 (T048) — the one rule for recognising a persisted terminal
 * transition intent, used both for a legacy single value and for each entry of
 * the keyed journal. A second copy would be free to disagree about what counts
 * as an intent, and the disagreement would surface as a transition that replays
 * on one path and is silently dropped on the other.
 */
function asTerminalTransitionIntent(raw: unknown): TerminalTransitionIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const intent = raw as Partial<TerminalTransitionIntent>;
  return intent.schemaVersion === 1
    && intent.run !== undefined
    && typeof intent.run === 'object'
    && typeof (intent.run as WorkflowRun).id === 'string'
    && typeof intent.createdAt === 'number'
    ? (intent as TerminalTransitionIntent)
    : null;
}

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
  // Feature 092 — emitted by the v9 → v10 migrator when it lifted the singular
  // `QueueState` into the per-queue map. Same forwarding contract as
  // `v6MigrationEvents` above; at most one event, and never on a fresh
  // workspace (there is nothing to lift).
  v10MigrationEvents: readonly StateMigratedV9ToV10AuditEvent[];
  // Feature 093 — emitted by the v10 → v11 migrator when it reshaped the
  // singular `WorkflowRun` record into the per-queue map, plus one event per
  // repair it had to make on the way. Same forwarding contract as
  // `v6MigrationEvents` above, and unlike `v10MigrationEvents` it is actually
  // consumed — see the D2 wiring in `extension.ts`.
  v11MigrationEvents: readonly RunStateMigrationAuditEvent[];
  // Feature 056 — emitted when persisted WorkflowRun snapshots are repaired.
  runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
}

export class WorkspaceStateStore {
  private readonly memento: Memento;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<StoreChangeListener>();
  private readonly logger: SanitizedLogger | null;
  // Feature 092 (T056) retired the one-shot saturation-WARN guard that used to
  // live here: the reader no longer saturates, so there is no silent coercion
  // left to warn about.

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

  /**
   * Whether the legacy `WorkflowRun` forward-migrator has anything to do.
   *
   * A record persisted at v8 already carries every field the runtime expects,
   * so running `migrateLegacyRun()` over it would rewrite it — adding a
   * `mutationPlan` fingerprint it never had — for no reason. Feature 088's
   * v8 → v9 step touches only the new `schegent.connectedRuns` key and MUST
   * leave existing `WorkflowRun` records byte-identical (FR-007), so the gate
   * is the persisted version rather than "the numeric version moved at all".
   * Every earlier version still migrates exactly as before.
   */
  private static needsLegacyRunMigration(persistedNumeric: number | undefined): boolean {
    return typeof persistedNumeric !== 'number' || persistedNumeric < STATE_SCHEMA_VERSION_V8;
  }

  public async initialize(): Promise<InitializeResult> {
    const persistedNumeric = this.memento.get<number>(KEYS.schemaVersionNumeric);
    // Feature 093 (T014, defect D3) — the forward-only refusal of FR-007, which
    // used to be an inline copy of the check `assertPersistedVersionSupported`
    // already made. Delegating rather than duplicating is what keeps the two
    // from drifting: the copy that was called had the right constant and the
    // copy that had a test had the wrong one, and nothing in the build could
    // notice, because each was correct on its own terms.
    assertPersistedVersionSupported(persistedNumeric);
    const persistedVersion = this.memento.get<string>(KEYS.schemaVersion);
    if (!persistedVersion) {
      const runRepairEvents = await this.normalizeRunForInitialize(
        WorkspaceStateStore.needsLegacyRunMigration(persistedNumeric)
      );
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
      const v10Events = await this.migrateV9ToV10IfNeeded();
      const v11Events = await this.migrateV10ToV11IfNeeded();
      await this.reconcileQueuePauseStateIfDivergent();
      await this.stampVersion(true);
      return {
        migrated: true,
        v6MigrationEvents: v6Events,
        v7MigrationEvents: v7Events,
        v10MigrationEvents: v10Events,
        v11MigrationEvents: v11Events,
        runRepairEvents
      };
    }
    if (persistedVersion === SCHEMA_VERSION) {
      if (persistedNumeric !== STATE_SCHEMA_VERSION) {
        // Numeric schema bump only (additive fields) — apply forward
        // migrator so legacy `WorkflowRun` records gain the new fields.
        const runRepairEvents = await this.normalizeRunForInitialize(
          WorkspaceStateStore.needsLegacyRunMigration(persistedNumeric)
        );
        await this.migrateQueueRegistryIfNeeded();
        const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
        const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
        const v10Events = await this.migrateV9ToV10IfNeeded();
        const v11Events = await this.migrateV10ToV11IfNeeded();
        await this.reconcileQueuePauseStateIfDivergent();
        await this.stampVersion(false);
        return {
          migrated: true,
          v6MigrationEvents: v6Events,
          v7MigrationEvents: v7Events,
          v10MigrationEvents: v10Events,
          v11MigrationEvents: v11Events,
          runRepairEvents
        };
      }
      const runRepairEvents = await this.normalizeRunForInitialize(false);
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
      const v10Events = await this.migrateV9ToV10IfNeeded();
      const v11Events = await this.migrateV10ToV11IfNeeded();
      const reconciled = await this.reconcileQueuePauseStateIfDivergent();
      return {
        migrated:
          v6Events.length > 0
          || v7Events.length > 0
          || v10Events.length > 0
          || v11Events.length > 0
          || runRepairEvents.length > 0
          || reconciled,
        v6MigrationEvents: v6Events,
        v7MigrationEvents: v7Events,
        v10MigrationEvents: v10Events,
        v11MigrationEvents: v11Events,
        runRepairEvents
      };
    }
    const [persistedMajor] = persistedVersion.split('.');
    const [runtimeMajor] = SCHEMA_VERSION.split('.');
    if (persistedMajor === runtimeMajor) {
      const runRepairEvents = await this.normalizeRunForInitialize(
        WorkspaceStateStore.needsLegacyRunMigration(persistedNumeric)
      );
      await this.migrateQueueRegistryIfNeeded();
      const v6Events = await this.migrateV5ToV6IfNeeded(persistedNumeric);
      const v7Events = await this.migrateV6ToV7IfNeeded(persistedNumeric);
      const v10Events = await this.migrateV9ToV10IfNeeded();
      const v11Events = await this.migrateV10ToV11IfNeeded();
      await this.reconcileQueuePauseStateIfDivergent();
      await this.stampVersion(true);
      return {
        migrated: true,
        v6MigrationEvents: v6Events,
        v7MigrationEvents: v7Events,
        v10MigrationEvents: v10Events,
        v11MigrationEvents: v11Events,
        runRepairEvents
      };
    }
    throw new Error(
      `Schegent state version ${persistedVersion} is incompatible with runtime ${SCHEMA_VERSION}. Run "Schegent: Reset Workspace State" to clear.`
    );
  }

  /**
   * Record the runtime schema version — **after** the migration chain, never
   * before it.
   *
   * Feature 093 (FR-002a) moved this. The version keys and the records the
   * migrators reshape are separate memento keys with separate writes, so
   * stamping first meant a migration that threw left a workspace claiming a
   * version whose shape it did not have. Stamping last makes the failure
   * legible instead: the persisted version stays where it was, in the shape it
   * had, and the next open re-runs the whole chain. Every migrator in that
   * chain is idempotent, which is what makes re-running it the recovery path —
   * forward-only leaves no other one.
   *
   * The success path is unchanged: the same two keys reach the same two values
   * in the same order.
   */
  private async stampVersion(includeVersionString: boolean): Promise<void> {
    if (includeVersionString) {
      await this.memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    }
    await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
  }

  /**
   * Feature 092 — the pre-v10 migration chain, read through one seam.
   *
   * Every migrator numbered below v10 was written when `KEYS.queue` held a
   * single `QueueState`, and each of them concerns exactly that one queue.
   * After the v10 lift the key holds a map, so those readers would otherwise
   * be handed a `Record` and try to migrate it as though it were a queue.
   *
   * The reserved queue is the right subject in both shapes: no non-default
   * queue can exist at v9 or earlier, so the entry the lift produced under
   * `DEFAULT_QUEUE_ID` *is* the record those migrators were written against.
   * Reading through here keeps them byte-for-byte correct on a genuine v9
   * record and idempotent on a lifted one.
   */
  private readLegacySingularQueue(): QueueState | null {
    const raw = this.memento.get<unknown>(KEYS.queue);
    if (raw === undefined || raw === null) return null;
    if (Array.isArray((raw as QueueState).requests)) return raw as QueueState;
    if (typeof raw === 'object') {
      return (raw as QueueStateMap)[DEFAULT_QUEUE_ID] ?? null;
    }
    return null;
  }

  /** The write half of `readLegacySingularQueue()`; preserves the stored shape. */
  private writeLegacySingularQueue(next: QueueState): Thenable<void> {
    const raw = this.memento.get<unknown>(KEYS.queue);
    const isMap =
      raw !== undefined
      && raw !== null
      && typeof raw === 'object'
      && !Array.isArray((raw as QueueState).requests);
    if (!isMap) return this.memento.update(KEYS.queue, next);
    return this.memento.update(KEYS.queue, { ...(raw as QueueStateMap), [DEFAULT_QUEUE_ID]: next });
  }

  /**
   * Feature 092 (FR-001, FR-005) — the v9 → v10 forward migration.
   *
   * Runs *after* the v5 → v6 and v6 → v7 chains so each of those still sees
   * the singular record it was written against, and it is the last step that
   * changes the shape of `KEYS.queue`. Idempotent: a record already in map
   * shape returns no events and is written back only if a per-entry lockstep
   * repair was needed.
   */
  private async migrateV9ToV10IfNeeded(): Promise<readonly StateMigratedV9ToV10AuditEvent[]> {
    const raw = this.memento.get<unknown>(KEYS.queue);
    if (raw === undefined || raw === null) return [];
    const result = migrateV9ToV10(raw, Date.now());
    if (Object.keys(result.queueStates).length === 0) return [];
    await this.memento.update(KEYS.queue, result.queueStates);
    if (!result.migrated) return [];
    return result.auditEvents;
  }

  /**
   * Feature 093 (FR-002, FR-002a) — the v10 → v11 forward migration.
   *
   * Runs last in the chain, after `migrateV9ToV10IfNeeded()`, so the task →
   * queue resolver below reads a `KEYS.queue` already in map shape. It owns
   * **exactly one** `update()` and performs it only when the migrator reports a
   * change. That is what makes the reshape all-or-nothing: `KEYS.run` is the
   * only key it touches, so a rejected write leaves valid v10 state behind
   * rather than a half-populated workspace, and the next open re-attempts.
   * Forward-only means re-attempt is the whole recovery story — there is no
   * rollback to a shape the runtime no longer reads.
   *
   * The step is keyed on the **shape** of the record and never on the persisted
   * version number. The two live in separate memento keys with separate writes,
   * so a workspace whose version key moved but whose record did not must still
   * be repaired the next time it is opened; a version-gated step would skip it
   * forever.
   */
  private async migrateV10ToV11IfNeeded(): Promise<readonly RunStateMigrationAuditEvent[]> {
    const result = migrateV10ToV11(
      this.memento.get<unknown>(KEYS.run),
      (taskId) => this.queueIdForPersistedTask(taskId),
      Date.now()
    );
    if (!result.changed) return [];
    await this.memento.update(KEYS.run, result.runs);
    return result.events;
  }

  /**
   * The queue a persisted Task belongs to, or `null` when no queue holds it.
   *
   * `QueueManager.queueIdForTask()` answers the same question but falls back to
   * `DEFAULT_QUEUE_ID`, which is the wrong shape here: the v11 migrator has to
   * *distinguish* "belongs to the default queue" from "belongs to no queue at
   * all", because only the second one reassigns and audits. It also runs before
   * the queue manager exists, so the persisted record is the only thing to ask.
   */
  private queueIdForPersistedTask(taskId: string): string | null {
    for (const [queueId, state] of Object.entries(this.readQueueMap())) {
      if ((state?.requests ?? []).some((request) => request.id === taskId)) return queueId;
    }
    return null;
  }

  // BUG-001 self-heal: pre-fix persisted v6 state may have a stale legacy
  // `QueueState.paused` diverging from the authoritative
  // `QueueRegistry.entries[0].state`. Reconcile legacy → registry per FR-020.
  private async reconcileQueuePauseStateIfDivergent(): Promise<boolean> {
    const persistedQueue = this.readLegacySingularQueue();
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
    await this.writeLegacySingularQueue({
      ...persistedQueue,
      paused: registryPaused,
      pausedReason: correctedReason,
      queueLifecycle: correctedLifecycle,
      scheduledStartAt: correctedLifecycle === 'idle-pending' ? persistedQueue.scheduledStartAt ?? null : null,
      scheduledStartSource:
        correctedLifecycle === 'idle-pending'
          ? coerceRetiredStartSource(persistedQueue.scheduledStartSource ?? null)
          : null,
      updatedAt: Date.now()
    });
    this.logger?.warn(
      `workspace-state: reconciled divergent queue pause state (legacy=${legacyPaused} registry=${registryPaused}) → registry`
    );
    this.notify(KEYS.queue);
    return true;
  }

  /**
   * Feature 011 — STATE_SCHEMA_VERSION 1 → 2: fills the three new `WorkflowRun`
   * fields on legacy records.
   *
   * Feature 093 (T020) made it shape-aware. It runs **before** the v10 → v11
   * reshape, so on an unmigrated workspace the record is still a bare Run and
   * on a migrated one it is the per-queue map; each is normalized and written
   * back in the shape it arrived in.
   *
   * Lifting the bare record onto the default queue here instead would hand the
   * v11 migrator a record already in v11 shape. It would report `changed:
   * false`, skip the task → queue resolution that is the only thing able to
   * place a Run on a non-default queue, and emit no reshape event — a Run
   * silently moved to `default`, with no audit record saying so. The reverse
   * order is not available either: this step is what coerces a retired legacy
   * `status` into one the v11 migrator's shape predicate accepts, and running
   * it second would have that migrator discard the Run as unreadable.
   *
   * On invariant RM-4, T020's task text proposed routing these writes through
   * `setRun`. That is the wrong instrument here and the rule is closed a
   * different way. `setRun` validates by **throwing**, and this method is the
   * one path whose whole purpose is to accept a record the current runtime
   * would refuse — a throw at initialize does not protect the operator, it
   * bricks the workspace on exactly the record repair exists to fix. It also
   * rejects unknown queue ids, which is not yet answerable: the queue registry
   * has not been migrated at this point in the chain. Both writers of
   * `KEYS.run` are nonetheless covered: `migrateLegacyRun` normalizes every
   * invariant `validateRunInvariants` checks (both retry-pair halves, both
   * manual-pause halves, the cap-implies-paused-or-failed relation, and
   * `rawTranscriptMode`) by repair rather than refusal, and every write the
   * running system makes goes through `setRun` and is validated there.
   */
  private async normalizeRunForInitialize(
    applyLegacyMigration: boolean
  ): Promise<readonly WorkflowRunRepairedAuditEvent[]> {
    const raw = this.memento.get<unknown>(KEYS.run);
    if (raw === undefined || raw === null) return [];

    if (isRunStateMap(raw)) {
      const events: WorkflowRunRepairedAuditEvent[] = [];
      const next: RunStateMap = {};
      let changed = applyLegacyMigration;
      for (const [queueId, persisted] of Object.entries(raw)) {
        const migrated = applyLegacyMigration ? migrateLegacyRun(persisted) : persisted;
        if (migrated === null) {
          changed = true;
          continue;
        }
        const repair = repairLegacyRunSnapshot(migrated);
        next[queueId] = repair.run;
        if (repair.auditEvent !== null) {
          events.push(repair.auditEvent);
          changed = true;
        }
      }
      if (changed) await this.memento.update(KEYS.run, next);
      return events;
    }

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
    const lifted = migrateLegacyQueueState(this.readLegacySingularQueue());
    await this.memento.update(KEYS.queueRegistry, lifted.registry);
    await this.writeLegacySingularQueue(lifted.queueState);
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
    const queueState = this.readLegacySingularQueue();
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
      await this.writeLegacySingularQueue(result.state.queueState);
      await this.memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
      return [];
    }
    // Persist the unified registry and queue state. Order matters: write
    // the registry first so concurrent readers see a consistent shape.
    await this.memento.update(KEYS.queueRegistry, result.state.queueRegistry);
    await this.writeLegacySingularQueue(result.state.queueState);
    await this.memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
    // If a WorkflowRun is persisted, ensure its `queueId` is `'default'`.
    // The WorkflowRun shape itself is unchanged; only the queueId field is
    // rewritten so downstream code can rely on the single-queue invariant.
    //
    // Feature 093 (T020) — asked rather than cast. A workspace at v5 can only
    // hold the bare Run this step corrects, but from v11 on the same key holds
    // the per-queue map, and reading that as a `WorkflowRun` gives the right
    // answer here for the wrong reason: `queueId` is absent because a map has
    // no such field, not because the Run was already on the default queue.
    const raw = this.memento.get<unknown>(KEYS.run);
    if (isWorkflowRun(raw)) {
      const runRecord = raw as unknown as { queueId?: string };
      if (runRecord.queueId !== undefined && runRecord.queueId !== DEFAULT_QUEUE_ID) {
        await this.memento.update(KEYS.run, { ...raw, queueId: DEFAULT_QUEUE_ID });
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
    const queueState = this.readLegacySingularQueue();
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
    await this.writeLegacySingularQueue(result.queueState);
    if (isFreshWorkspace) return [];
    return result.auditEvents;
  }

  /**
   * Feature 092 (FR-006) — the raw v10 record: one `QueueState` per queue,
   * keyed by queue id.
   *
   * A v9 record (a bare `QueueState`) still reads correctly here. That is not
   * a second migration path: `initialize()` owns the write, and this is the
   * projection that keeps a read taken before that write — an early snapshot
   * pass, a test that seeds the memento directly — from seeing a queue with no
   * tasks in it. It writes nothing.
   */
  private readQueueMap(): QueueStateMap {
    const raw = this.memento.get<unknown>(KEYS.queue);
    if (raw === undefined || raw === null) return {};
    if (Array.isArray((raw as QueueState).requests)) {
      return { [DEFAULT_QUEUE_ID]: raw as QueueState };
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as QueueStateMap;
    }
    return {};
  }

  private static bornEmptyQueue(): QueueState {
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

  /**
   * One queue's execution state. `queueId` defaults to the reserved queue so
   * every pre-092 caller keeps its meaning unchanged.
   *
   * An unknown id returns a born-empty `QueueState` and persists **nothing**
   * (FR-007). Reading is not a way to create a queue — the registry is the
   * only thing that decides which queues exist, and a read that fabricated an
   * entry would let a typo'd id quietly become a real one.
   */
  public getQueue(queueId: string = DEFAULT_QUEUE_ID): QueueState {
    const persisted = this.readQueueMap()[queueId];
    if (!persisted) return WorkspaceStateStore.bornEmptyQueue();
    return ensureExtendedQueueShape(persisted);
  }

  /** Every persisted queue's execution state, normalized. */
  public getQueueStates(): QueueStateMap {
    const map = this.readQueueMap();
    const out: QueueStateMap = {};
    for (const [queueId, state] of Object.entries(map)) {
      out[queueId] = ensureExtendedQueueShape(state);
    }
    return out;
  }

  /** The ids that have persisted execution state. Not the registry. */
  public getQueueStateIds(): readonly string[] {
    return Object.keys(this.readQueueMap());
  }

  /** Whether `queueId` has persisted execution state, without creating any. */
  public hasQueueState(queueId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.readQueueMap(), queueId);
  }

  /** @internal Full replacement seam for migrations and test setup only. */
  public setQueue(queue: QueueState, queueId: string = DEFAULT_QUEUE_ID): Promise<void> {
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
    return this.serialize(KEYS.queue, () =>
      this.memento.update(KEYS.queue, { ...this.readQueueMap(), [queueId]: next })
    ).then(() => {
      this.notify(KEYS.queue);
    });
  }

  /** @internal Drop one queue's execution state. Used by queue deletion. */
  public deleteQueueState(queueId: string): Promise<void> {
    return this.serialize(KEYS.queue, () => {
      const map = { ...this.readQueueMap() };
      delete map[queueId];
      return this.memento.update(KEYS.queue, map);
    }).then(() => {
      this.notify(KEYS.queue);
    });
  }

  /**
   * The only safe read/modify/write boundary for queue state. The current
   * value is read after this mutation reaches the head of the queue chain,
   * preventing callers from committing a snapshot captured before another
   * queued mutation completed.
   *
   * Feature 092 — the mutation is scoped to one queue, but the *serialization*
   * stays on `KEYS.queue`, because the whole map is one memento key and two
   * concurrent read/modify/write cycles on different queues would still clobber
   * each other's sibling entries. Per-queue concurrency is a property of what
   * runs, not of how the record is written.
   */
  public updateQueue<T>(
    mutate: (current: QueueState) => { readonly queue: QueueState; readonly result: T },
    queueId: string = DEFAULT_QUEUE_ID
  ): Promise<T> {
    let result!: T;
    return this.serialize(KEYS.queue, async () => {
      const current = this.getQueue(queueId);
      const mutation = mutate(current);
      const next = ensureExtendedQueueShape({
        ...mutation.queue,
        requests: compactRequestPositions(mutation.queue.requests),
        updatedAt: Date.now()
      });
      result = mutation.result;
      await this.memento.update(KEYS.queue, { ...this.readQueueMap(), [queueId]: next });
    }).then(() => {
      this.notify(KEYS.queue);
      return result;
    });
  }

  /**
   * Feature 092 — a read/modify/write over **every** queue's state as one
   * write. `updateQueue()` above is the right primitive for all but one
   * operation; moving a Task between queues is that one, because it removes
   * from one entry and inserts into another and must not be able to half-land.
   * Serialised on the same `KEYS.queue` chain, so it composes with the
   * single-queue writer rather than racing it.
   */
  private updateQueueMap<T>(
    mutate: (current: QueueStateMap) => { readonly queueStates: QueueStateMap; readonly result: T }
  ): Promise<T> {
    let result!: T;
    return this.serialize(KEYS.queue, async () => {
      const current = this.getQueueStates();
      const mutation = mutate(current);
      const next: QueueStateMap = {};
      for (const [queueId, state] of Object.entries(mutation.queueStates)) {
        next[queueId] = ensureExtendedQueueShape({
          ...state,
          requests: compactRequestPositions(state.requests),
          updatedAt: Date.now()
        });
      }
      result = mutation.result;
      await this.memento.update(KEYS.queue, next);
    }).then(() => {
      this.notify(KEYS.queue);
      return result;
    });
  }

  /**
   * Which queue holds `taskId`, if any.
   *
   * Task ids are globally unique, so a Task-addressed mutation names a Task
   * and not a queue. Before feature 092 the owning queue was a field on the
   * row and the whole array was one record; now the map key is the authority,
   * so the owner has to be found before the row can be written. Returns the
   * first match — a Task in two queues at once is not a state the writers can
   * produce, and scanning for a second one would only hide it if it happened.
   */
  private findTaskOwner(taskId: string): { queueId: string; request: FeatureRequest } | null {
    for (const [queueId, state] of Object.entries(this.readQueueMap())) {
      const request = state.requests?.find((r) => r.id === taskId);
      if (request) return { queueId, request };
    }
    return null;
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
    // Feature 092 (T056, FR-027) — the reader refuses an out-of-range value
    // instead of saturating it to 1.
    //
    // Feature 056's saturation was defensible while the schema admitted
    // exactly one value: every out-of-range record was a legacy artifact of a
    // wider schema, and 1 was both the clamp and the only truth. Now that the
    // schema *is* the wider one, silently returning 1 for a persisted 100
    // would run the workspace at a twentieth of the operator's stated intent
    // and say so only in a log line nobody reads. A refusal surfaces at the
    // call site.
    const value = this.memento.get<number>(KEYS.queueGlobalConcurrencyCap);
    // The key having never been written is the normal cold-start case, not a
    // corruption: fall back to the schema default the six defining sites agree
    // on. Six, not five — feature 094 enumerated them by inspection and found
    // this comment's count and `config/general-settings.ts`'s count disagreed
    // with each other and both with the truth. See the header on
    // `DEFAULT_GLOBAL_CONCURRENCY_CAP` for the enumeration and the authority.
    if (value === undefined || value === null) return DEFAULT_GLOBAL_CONCURRENCY_CAP;
    assertGlobalConcurrencyCap(value, 'persisted');
    return value;
  }

  public setGlobalConcurrencyCap(value: number): Promise<void> {
    // Feature 092 (T056, FR-026/FR-027) — `[1, MAX_QUEUES]`. The package
    // contribution, `SETTINGS_SCHEMA`, the host validator and
    // `QueueManager.saveQueueSettings` all share this invariant.
    assertGlobalConcurrencyCap(value, 'requested');
    return this.serialize(KEYS.queueGlobalConcurrencyCap, () =>
      this.memento.update(KEYS.queueGlobalConcurrencyCap, value)
    ).then(() => {
      this.notify(KEYS.queueGlobalConcurrencyCap);
    });
  }

  /**
   * Feature 092 (T065, FR-037) — the shared-working-tree notice's answer.
   *
   * Three states, and the third is not a default: `null` is "the workspace has
   * never stopped being single-queue, so the question has not been asked",
   * `'pending'` is "asked, unanswered", `'dismissed'` is "answered". Collapsing
   * `null` into `'dismissed'` would suppress the notice for every workspace
   * that has not yet earned it; collapsing it into `'pending'` would show it to
   * a workspace with one queue, which has no shared working tree to warn about.
   */
  public getConcurrencyNotice(): ConcurrencyNotice | null {
    const value = this.memento.get<unknown>(KEYS.concurrencyNotice);
    return value === 'pending' || value === 'dismissed' ? value : null;
  }

  /**
   * Feature 092 (T065, FR-037) — record the notice's state.
   *
   * Deliberately dumb: this writes what it is given, and the once-per-workspace
   * rule lives at the two call sites in `QueueManager` that own the triggers
   * (`createQueue` arms only from `null`, `dismissConcurrencyNotice` answers
   * only from `'pending'`). Putting the rule here as well would give the
   * invariant two homes and let them disagree.
   */
  public setConcurrencyNotice(value: ConcurrencyNotice): Promise<void> {
    return this.serialize(KEYS.concurrencyNotice, () =>
      this.memento.update(KEYS.concurrencyNotice, value)
    ).then(() => {
      this.notify(KEYS.concurrencyNotice);
    });
  }

  public getRequestsForQueue(queueId: string): FeatureRequest[] {
    if (!findQueue(this.getQueueRegistry(), queueId)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
    }
    return this.getQueue(queueId)
      .requests.slice()
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
      //
      // Feature 092 — `queue` is now the target queue's own state, so the cap
      // this counts against is per queue by construction rather than by
      // filtering a shared array (FR-005).
      const pendingInTarget = queue.requests
        .filter((item) => item.status === 'pending')
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
      const allInTarget = queue.requests.slice().sort((a, b) => a.position - b.position);
      allInTarget.forEach((item, idx) => denseIndex.set(item.id, idx));
      const shifted = queue.requests.map((item) => {
        const dense = denseIndex.get(item.id) ?? item.position;
        const repositioned = dense >= insertAt ? dense + 1 : dense;
        if (repositioned === item.position) return item;
        return { ...item, position: repositioned, updatedAt: now };
      });
      return {
        queue: { ...queue, requests: [...shifted, nextRequest] },
        result: nextRequest
      };
    }, queueId);
  }

  public async removePendingRequest(taskId: string): Promise<FeatureRequest> {
    const owner = this.findTaskOwner(taskId);
    if (!owner) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
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
    }, owner.queueId);
  }

  public getRequest(taskId: string): FeatureRequest | null {
    return this.findTaskOwner(taskId)?.request ?? null;
  }

  public async removeRequest(taskId: string): Promise<FeatureRequest> {
    const owner = this.findTaskOwner(taskId);
    if (!owner) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
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
    }, owner.queueId);
  }

  public async modifyPendingRequest(
    taskId: string,
    updates: { description?: string }
  ): Promise<FeatureRequest> {
    const owner = this.findTaskOwner(taskId);
    if (!owner) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
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
    }, owner.queueId);
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
    const owner = this.findTaskOwner(taskId);
    if (!owner) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
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
      // Feature 092 — the peers are the addressed queue's own pending rows;
      // the map key already partitions them.
      const pendingPeers = queue.requests
        .filter((request) => request.status === 'pending')
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
    }, owner.queueId);
  }

  /**
   * Feature 092 (FR-017) — move a pending Task from the queue that holds it to
   * another one.
   *
   * The Task's own content is carried verbatim: description, `runPlan`,
   * `pipelineId`, `rerun`, retry count and timestamps all survive, because the
   * operator is re-filing work, not re-authoring it. Only `queueId`, `position`
   * and `updatedAt` change.
   *
   * A same-queue "move" is a reorder and delegates to the reorder writer, so
   * there is exactly one implementation of within-queue position arithmetic.
   * A genuine cross-queue move goes through `updateQueueMap()` as a single
   * write — removing the row from the source and inserting it into the target
   * in two writes would leave a window where the Task is in neither queue, or
   * in both.
   */
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
    const owner = this.findTaskOwner(taskId);
    if (!owner) {
      throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
    }
    const target = owner.request;
    if (target.status !== 'pending') {
      throw new QueueMutationRejected(
        'task-not-in-pending-state',
        `Task ${taskId} is not pending`
      );
    }
    const sameQueue = owner.queueId === params.targetQueueId;
    const targetPending = this.getQueue(params.targetQueueId).requests.filter(
      (request) => request.status === 'pending'
    );
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
    return this.updateQueueMap((current) => {
      const source = current[owner.queueId] ?? WorkspaceStateStore.bornEmptyQueue();
      const destination = current[params.targetQueueId] ?? WorkspaceStateStore.bornEmptyQueue();
      return {
        queueStates: {
          ...current,
          [owner.queueId]: {
            ...source,
            requests: source.requests.filter((request) => request.id !== taskId)
          },
          [params.targetQueueId]: {
            ...destination,
            requests: [
              ...destination.requests.map((request) =>
                request.status === 'pending' && request.position >= insertAt
                  ? { ...request, position: request.position + 1, updatedAt: now }
                  : request
              ),
              moved
            ]
          }
        },
        result: moved
      };
    });
  }

  /**
   * Feature 093 (T018, FR-008) — the raw v11 record: at most one **active**
   * `WorkflowRun` per queue, keyed by queue id. The mirror of `readQueueMap()`.
   *
   * A v10 record (a bare `WorkflowRun`) still reads correctly here, lifted onto
   * the default queue. That is not a second migration path — `initialize()`
   * owns the write, and this is the projection that keeps a read taken *before*
   * that write from reporting a workspace with nothing executing. It writes
   * nothing.
   *
   * **Both** shape rules are imported from the migrator rather than restated, so
   * the pre-write and post-write views cannot disagree about what a Run looks
   * like. The map half used to be restated here as
   * `typeof raw === 'object' && !Array.isArray(raw)`, which is laxer than
   * `isRunStateMap` — it accepts a map whose values are not Runs. That is the
   * one input on which the two views disagreed: this read cast the junk to
   * `RunStateMap` and handed callers values typed as `WorkflowRun` that are not
   * one, while the migrator classified the same record `unrecognised-record-shape`
   * and repaired it to `{}`. Reading it as `{}` here is what the write is about
   * to make true, and an empty map is the safe direction — a fabricated Run
   * would hand the drain coordinator a queue that looks busy forever, which is
   * the migrator's own stated reason for repairing rather than guessing.
   */
  private readRunMap(): RunStateMap {
    const raw = this.memento.get<unknown>(KEYS.run);
    if (raw === undefined || raw === null) return {};
    if (isWorkflowRun(raw)) return { [DEFAULT_QUEUE_ID]: raw };
    if (isRunStateMap(raw)) return raw;
    return {};
  }

  /**
   * The Run executing on `queueId`, or `null` when that queue has none.
   *
   * An unknown id reads as `null` rather than throwing, matching `getQueue()`
   * above: a read has nothing to corrupt, and making it throw would put a
   * registry lookup in front of every projection that only wants to know
   * whether something is running.
   */
  public getRun(queueId: string): WorkflowRun | null {
    return this.readRunMap()[queueId] ?? null;
  }

  /**
   * Every queue with a Run executing on it (G-4).
   *
   * A copy, not the stored object: the map is handed to snapshot and status-bar
   * projections, and a caller that mutated the live record would change what is
   * running without going through the invariant check or the write chain.
   */
  public getRunMap(): Readonly<RunStateMap> {
    return { ...this.readRunMap() };
  }

  /**
   * The Run advancing `taskId`, together with the queue it executes on.
   *
   * Both halves or neither. A caller holding only the Run cannot release its
   * execution lease or clear its record without guessing the queue, and a
   * guessed queue in a window running several Runs clears a sibling's — the
   * same failure the hard rule on `releaseExecutionLeaseForRun()` exists to
   * prevent.
   */
  public findRunByTask(
    taskId: string
  ): { readonly queueId: string; readonly run: WorkflowRun } | null {
    for (const [queueId, run] of Object.entries(this.readRunMap())) {
      if (run.featureId === taskId) return { queueId, run };
    }
    return null;
  }

  /**
   * Write or clear one queue's active Run.
   *
   * `null` **removes** the key rather than storing a null under it (G-5), so
   * `Object.keys(getRunMap())` is exactly the set of queues with something
   * executing — the count concurrency accounting reads. Clearing an id the
   * registry no longer knows is allowed and removes nothing: a deleted queue
   * has its registry entry dropped first, and refusing the cleanup afterwards
   * would strand its Run record forever. Writing a Run for an unknown id is
   * refused (G-6), because that is the direction in which a typo'd id would
   * quietly become a running queue.
   *
   * Serialized on `KEYS.run` with the map re-read *inside* the chain, for the
   * same reason `updateQueue()` does on `KEYS.queue`: the whole map is one
   * memento key, so two concurrent single-queue writes would otherwise write
   * back snapshots missing each other's entries. Per-queue concurrency is a
   * property of what runs, not of how the record is written.
   */
  public setRun(queueId: string, run: WorkflowRun | null): Promise<void> {
    if (run !== null) {
      validateRunInvariants(run);
      if (!findQueue(this.getQueueRegistry(), queueId)) {
        throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
      }
    }
    return this.serialize(KEYS.run, () => {
      const next = { ...this.readRunMap() };
      if (run === null) delete next[queueId];
      else next[queueId] = run;
      return this.memento.update(KEYS.run, next);
    }).then(() => {
      this.notify(KEYS.run);
    });
  }

  /**
   * Feature 093 (T048) — every in-flight terminal transition, keyed by run id.
   *
   * The journal used to be one intent for the whole window. Two Runs reaching a
   * terminal status at once meant the second `begin()` overwrote the first's
   * intent and the first `complete()` cleared the record for both, so a crash
   * between the second Run's record write and its queue/history projection had
   * nothing left to replay — the durability the journal exists for, lost
   * precisely when two Runs are executing.
   *
   * A legacy single-intent value is **lifted**, not dropped: it is the record of
   * a terminal transition that has not finished projecting, and discarding it on
   * the upgrade read would strand exactly the crash it was written for.
   */
  public getTerminalTransitionIntents(): Readonly<Record<string, TerminalTransitionIntent>> {
    const value = this.memento.get<unknown>(KEYS.terminalTransitionIntent);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const legacy = asTerminalTransitionIntent(value);
    if (legacy) return { [legacy.run.id]: legacy };
    const entries: Record<string, TerminalTransitionIntent> = {};
    for (const [runId, raw] of Object.entries(value as Record<string, unknown>)) {
      const intent = asTerminalTransitionIntent(raw);
      if (intent) entries[runId] = intent;
    }
    return entries;
  }

  public setTerminalTransitionIntent(
    runId: string,
    intent: TerminalTransitionIntent | null
  ): Promise<void> {
    return this.serialize(KEYS.terminalTransitionIntent, () => {
      const next = { ...this.getTerminalTransitionIntents() };
      if (intent === null) delete next[runId];
      else next[runId] = intent;
      return this.memento.update(KEYS.terminalTransitionIntent, next);
    }).then(() => this.notify(KEYS.terminalTransitionIntent));
  }

  public getLock(): WorkspaceLock | null {
    return this.memento.get<WorkspaceLock>(KEYS.lock) ?? null;
  }

  public setLock(lock: WorkspaceLock | null): Promise<void> {
    return this.serialize(KEYS.lock, () => this.memento.update(KEYS.lock, lock)).then(() => {
      this.notify(KEYS.lock);
    });
  }

  /**
   * Feature 092 (T049, FR-031) — every queue's execution lease.
   *
   * Returned as a plain record so `ExecutionLeaseManager` owns the staleness
   * arithmetic in one place; this accessor makes no judgement about whether a
   * lease is live.
   */
  public getExecutionLeases(): Record<string, ExecutionLease> {
    const raw = this.memento.get<Record<string, ExecutionLease>>(KEYS.executionLeases);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  }

  public setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void> {
    return this.serialize(KEYS.executionLeases, () => {
      const next = { ...this.getExecutionLeases() };
      if (lease === null) delete next[queueId];
      else next[queueId] = lease;
      return this.memento.update(KEYS.executionLeases, next);
    }).then(() => {
      this.notify(KEYS.executionLeases);
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

  /**
   * Feature 088 (FR-006, FR-007) — the connected-run collection.
   *
   * Narrowing and the v8 → v9 lift live in `./connected-run-migrator.ts`; an
   * absent key reads as an empty collection. A record that fails the aggregate's
   * invariants is named in a WARN rather than dropped silently.
   */
  public getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>> {
    const result = migrateConnectedRuns(this.memento.get<unknown>(KEYS.connectedRuns));
    if (result.dropped.length > 0) {
      this.logger?.warn(
        `workspace-state: dropped ${result.dropped.length} connected run(s) failing persisted invariants: ${result.dropped.join(', ')}`
      );
    }
    return result.runs;
  }

  public getConnectedRun(connectedRunId: string): ConnectedWorkflowRun | null {
    return this.getConnectedRuns()[connectedRunId] ?? null;
  }

  /**
   * The single write path for connected-run state (FR-046).
   *
   * Compare-and-set, not last-writer-wins: `expectedRevision` is the revision
   * the caller read, `0` for a run that does not exist yet, and the write is
   * refused with the authoritative record when it does not match. The refusal
   * carries `current` so a stale caller can correct itself in one round trip
   * instead of re-reading and racing again.
   *
   * The stored revision must advance, but not necessarily by one: a caller may
   * compose several in-memory mutations — creating a run and recording its
   * first attempt is the common case — and persist them in a single write. Each
   * helper still increments by exactly one, so the count of mutations remains
   * readable from the revision.
   *
   * Serialized on the key, so two accepted writes cannot interleave between
   * their read and their update.
   */
  public async compareAndSetConnectedRun(
    next: ConnectedWorkflowRun,
    expectedRevision: number
  ): Promise<ConnectedRunWriteResult> {
    let result = staleConnectedRunWrite(null);
    await this.serialize(KEYS.connectedRuns, async () => {
      const runs = this.getConnectedRuns();
      const current = runs[next.connectedRunId] ?? null;
      if ((current?.revision ?? 0) !== expectedRevision || next.revision <= expectedRevision) {
        result = staleConnectedRunWrite(current);
        return;
      }
      // A violation here is a defect in the caller, not an operator-facing
      // outcome, so it throws rather than joining the refusal arm.
      //
      // Feature 092 (T078, FR-045) — the registry is supplied here and only
      // here. This is the single write path, so it is the one place that both
      // holds the registry and sees every candidate record; the aggregate
      // module itself must stay registry-free because the migrator loads it
      // with nothing but a memento.
      assertConnectedRunInvariants(next, {
        knownQueueIds: new Set(this.getQueueRegistry().entries.map((entry) => entry.id))
      });
      await this.memento.update(KEYS.connectedRuns, { ...runs, [next.connectedRunId]: next });
      result = { outcome: 'written', run: next };
    });
    if (result.outcome === 'written') this.notify(KEYS.connectedRuns);
    return result;
  }

  /**
   * Feature 092 (T083, FR-016a) — terminate connected runs outright.
   *
   * The aggregate stores no lifecycle, so there is no `status` to set to
   * `terminated`; removing the record IS the termination. No compare-and-set:
   * the caller is a confirmed queue deletion, and the queue these runs are
   * bound to no longer exists, so there is no revision at which keeping one
   * would be correct.
   *
   * Serialized on the same key as the write path, so a delete cannot interleave
   * between a compare-and-set's read and its update.
   */
  public async deleteConnectedRuns(connectedRunIds: readonly string[]): Promise<number> {
    if (connectedRunIds.length === 0) return 0;
    let removed = 0;
    await this.serialize(KEYS.connectedRuns, async () => {
      const runs = { ...this.getConnectedRuns() };
      for (const id of connectedRunIds) {
        if (runs[id] === undefined) continue;
        delete runs[id];
        removed += 1;
      }
      if (removed === 0) return;
      await this.memento.update(KEYS.connectedRuns, runs);
    });
    if (removed > 0) this.notify(KEYS.connectedRuns);
    return removed;
  }

  public async reset(): Promise<void> {
    await Promise.all([
      this.memento.update(KEYS.queue, undefined),
      this.memento.update(KEYS.queueRegistry, undefined),
      this.memento.update(KEYS.queueMigrationQuarantine, undefined),
      this.memento.update(KEYS.queueDefaultId, undefined),
      this.memento.update(KEYS.queueGlobalConcurrencyCap, undefined),
      // Feature 093 (T020) — still `undefined`, not an empty map. Reset clears
      // keys, and `readRunMap()` reads an absent key as no queue running, so
      // writing `{}` would only make the cleared state a stored value instead
      // of an absent one.
      this.memento.update(KEYS.run, undefined),
      this.memento.update(KEYS.lock, undefined),
      this.memento.update(KEYS.watchdog, undefined),
      this.memento.update(KEYS.history, undefined),
      this.memento.update(KEYS.terminalTransitionIntent, undefined),
      this.memento.update(KEYS.connectedRuns, undefined),
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
