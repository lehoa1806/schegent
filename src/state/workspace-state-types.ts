/**
 * FR-R7-07 — Shared constants, persisted key catalog (`KEYS`), public types,
 * errors (`QueueMutationRejected`), and the internal `WorkspaceStateFamilyContext`
 * contract shared across the split `workspace-state-*.ts` key-family modules.
 *
 * All public symbols are re-exported verbatim from `src/state/workspace-state.ts`
 * so existing callers keep a single import path.
 */

import type {
  RunQuarantineEntry,
  RunRecordQuarantinedPayload
} from '../contracts/audit-events';
import { MAX_QUEUES } from '../contracts/queue-bounds';
import type { FeatureRequest, QueueState } from '../queue/feature-request';
import type { QueueRegistry } from '../contracts/queue-registry';
import { STATE_SCHEMA_VERSION } from '../contracts/state-schema';
import type {
  LoadRepairWarning,
  WorkflowRunRepairedAuditEvent
} from './workflow-run-migrator';
import type {
  QueuePauseCollapseAuditEvent,
  QueueStateMap,
  StateMigratedV5ToV6AuditEvent,
  StateMigratedV6ToV7AuditEvent,
  StateMigratedV9ToV10AuditEvent
} from './queue-state-migrator';
import type { RunStateMigrationAuditEvent } from './run-state-migrator';
import type { OrphanedRunCanceledAuditEvent } from './orphaned-run-reconciler';
import type { HistoryStateMigrationAuditEvent } from './history-state-migrator';
import type { SanitizedLogger } from '../lib/logger';
import type { ConnectedWorkflowRun } from './connected-workflow-run';
import type { ClaimTenure } from './execution-lease';
import type {
  CommitFenceFailure,
  RunCommitClaim
} from './ownership-claim';
import type { VerdictBasisMigrationEvent } from './host-verification-migrator';
import type { Scheduler } from './lock';
import type { MementoBatchEntry, MementoWriteGate } from './memento-write-gate';
import type { OwnershipRegistry } from './ownership-registry';
import type { WorkflowRun } from './workflow-run';

export const SCHEMA_VERSION = '1.0.0';
export { STATE_SCHEMA_VERSION };

export type PersistedHistoryEntry = object;

/**
 * FR-R3-010 (T402) — the v12 persisted shape of `KEYS.history`: one array of
 * terminal-run records per queue, keyed by queue id.
 */
export type PersistedHistoryMap = Record<string, PersistedHistoryEntry[]>;

/**
 * Render an arbitrary persisted-value shape for diagnostic logs without
 * letting `JSON.stringify` throw on circular references or `BigInt`.
 */
export function safeDisplay(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    const encoded: string | undefined = JSON.stringify(value);
    return encoded ?? `<${typeof value}>`;
  } catch {
    return `<${typeof value}>`;
  }
}

export const KEYS = {
  schemaVersion: 'schegent.schemaVersion',
  schemaVersionNumeric: 'schegent.schemaVersionNumeric',
  queue: 'schegent.queue',
  queueRegistry: 'schegent.queues.registry',
  queueMigrationQuarantine: 'schegent.state.quarantine.v2',
  runQuarantine: 'schegent.state.runQuarantine.v1',
  queueDefaultId: 'schegent.queue.defaultQueueId',
  queueGlobalConcurrencyCap: 'schegent.queue.globalConcurrencyCap',
  run: 'schegent.run',
  lock: 'schegent.lock',
  watchdog: 'schegent.watchdog',
  history: 'schegent.history',
  terminalTransitionIntent: 'schegent.terminalTransitionIntent',
  confirmSuppression: 'schegent.ui.confirmSuppression',
  connectedRuns: 'schegent.connectedRuns',
  executionLeases: 'schegent.executionLeases',
  concurrencyNotice: 'schegent.ui.concurrencyNotice',
  gitPlanGrants: 'schegent.consent.gitPlanGrants.v1',
  agentConfigGrants: 'schegent.consent.agentConfigGrants.v1',
  resetMarker: 'schegent.reset.marker',
  operatorPseudonym: 'schegent.operatorPseudonym',
  controlLedger: 'schegent.controlLedger'
} as const;

/**
 * Feature FR-R3-006 (T338) — the keys `reset()` deliberately does not clear.
 */
export const RESET_EXEMPT_KEYS: Readonly<Record<string, string>> = {
  [KEYS.schemaVersion]:
    'Reset re-stamps the version rather than clearing it. Clearing would make a ' +
    'reset workspace indistinguishable from one that has never been opened, so ' +
    'the next activation would take the unversioned branch and run the whole ' +
    'forward-migration chain against empty state.',
  [KEYS.schemaVersionNumeric]:
    'Same as the version string above, and for the same reason: reset writes ' +
    'STATE_SCHEMA_VERSION here so the cleared state is correctly labelled as ' +
    'current rather than as unknown.',
  [KEYS.resetMarker]:
    'The marker records that a reset is underway. A reset that cleared its own ' +
    'marker could not be detected as interrupted, which is the whole reason the ' +
    'marker exists.',
  [KEYS.operatorPseudonym]:
    'The operator pseudonym names who acted in audit rows that are already written and cannot be ' +
    'rewritten. A workspace reset clears Schegent\'s state, not the operator\'s identity, and a ' +
    'pseudonym cleared by it would be created again under a new value, splitting one operator\'s rows ' +
    'across two names for no decision of theirs. The reset-pseudonym command is the one way to change it, ' +
    'and it records that it did.'
} as const;

/**
 * Feature FR-R3-006 (T339) — the keys a reset clears, derived rather than listed.
 */
export const RESET_CLEARED_KEYS: readonly string[] = Object.values(KEYS).filter(
  (key) => !(key in RESET_EXEMPT_KEYS)
);

/**
 * FR-R3-010 (T403) — retained terminal runs **per queue**.
 */
export const HISTORY_CAP_PER_QUEUE = 50;

/**
 * FR-R5-F09 (NU-03) — maximum number of deleted-queue history partitions retained in
 * `KEYS.history` alongside live queues' partitions.
 */
export const MAX_DELETED_HISTORY_PARTITIONS = MAX_QUEUES;

export interface OwnershipClaim {
  readonly resource: string;
  readonly ownerId: string;
  readonly fence: number;
}

export interface RunClaimSource {
  claimFor(queueId: string): OwnershipClaim | null;
  tenureOf?(queueId: string): ClaimTenure;
  markLost?(queueId: string, reason: 'superseded'): void;
}

export interface PrimacyClaimSource {
  canCommitConnectedRun(): Promise<boolean>;
  /** FR-R8-01 (01-03) — current window primacy claim with its monotonic generation, or `null` when unheld. */
  primacyClaim?(): OwnershipClaim | null;
}

export type RunReadVerdict =
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'live'; readonly run: WorkflowRun }
  | {
      readonly outcome: 'superseded';
      readonly run: WorkflowRun;
      readonly writtenAtFence: number;
      readonly liveFence: number;
    };

export interface QueueDeletionView {
  readonly registry: QueueRegistry;
  readonly run: WorkflowRun | null;
  readonly requests: readonly FeatureRequest[];
}

export type GuardedWriteOutcome =
  | { readonly outcome: 'written' }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'stale-fence' | 'not-holder';
      readonly currentFence: number;
      readonly ownerOfRecord: string | null;
    }
  | { readonly outcome: 'unavailable' };

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
  | typeof KEYS.concurrencyNotice
  | typeof KEYS.watchdog
  | typeof KEYS.controlLedger;

export type StoreChangeListener = (key: StoreChangeKey) => void;

export interface Disposable {
  dispose(): void;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
  updateBatch?(entries: readonly MementoBatchEntry[]): PromiseLike<void>;
}

export type ConnectedRunWriteResult =
  | { readonly outcome: 'written'; readonly run: ConnectedWorkflowRun }
  | {
      readonly outcome: 'stale';
      readonly current: ConnectedWorkflowRun | null;
      readonly reason?: 'revision-mismatch' | 'immutability-violation' | 'ownership-lost';
    };

export type QueueMutationRejectReason =
  | 'unknown-queue-id'
  | 'position-out-of-range'
  | 'task-cap-reached'
  | 'task-not-found'
  | 'task-not-in-pending-state'
  | 'illegal-source-status'
  | 'in-flight-ownership-conflict'
  | 'phase-not-found'
  | 'phase-already-removed'
  | 'cannot-delete-default-queue'
  | 'invalid-global-concurrency-cap'
  | 'fence-superseded'
  | 'fence-unverifiable'
  | 'fence-wrong-resource'
  | 'ownership-lost'
  | 'stale-run-id'
  | 'run-status-precondition'
  | 'durable-store-unavailable';

export class QueueMutationRejected extends Error {
  public readonly reason: QueueMutationRejectReason;

  constructor(reason: QueueMutationRejectReason, message: string) {
    super(message);
    this.name = 'QueueMutationRejected';
    this.reason = reason;
  }
}

export type StateSchemaVersionErrorCode =
  | 'UNSUPPORTED_NUMERIC_STATE_VERSION'
  | 'MALFORMED_NUMERIC_STATE_VERSION'
  | 'UNSUPPORTED_LEGACY_STATE_VERSION'
  | 'MALFORMED_LEGACY_STATE_VERSION';

export class UnsupportedStateSchemaVersionError extends Error {
  public readonly code: StateSchemaVersionErrorCode;
  public readonly persistedVersion: unknown;
  public readonly supportedVersion: number | string;

  constructor(
    code: StateSchemaVersionErrorCode,
    persistedVersion: unknown,
    supportedVersion: number | string,
    message: string
  ) {
    super(message);
    this.name = 'UnsupportedStateSchemaVersionError';
    this.code = code;
    this.persistedVersion = persistedVersion;
    this.supportedVersion = supportedVersion;
  }
}

export function describeMalformedVersionValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return 'non-finite number';
    if (value < 0) return 'negative number';
    if (!Number.isInteger(value)) return 'non-integer number';
    return 'number';
  }
  if (typeof value === 'string') return 'malformed string';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function assertPersistedStateSchemaVersionSupported(persistedNumeric: unknown): void {
  if (persistedNumeric === undefined) return;
  if (
    typeof persistedNumeric !== 'number'
    || !Number.isInteger(persistedNumeric)
    || persistedNumeric < 0
  ) {
    throw new UnsupportedStateSchemaVersionError(
      'MALFORMED_NUMERIC_STATE_VERSION',
      persistedNumeric,
      STATE_SCHEMA_VERSION,
      `Schegent state schemaVersion (${describeMalformedVersionValue(persistedNumeric)}) is malformed (expected non-negative integer <= ${STATE_SCHEMA_VERSION}). Run "Schegent: Reset Workspace State" to clear.`
    );
  }
  if (persistedNumeric > STATE_SCHEMA_VERSION) {
    throw new UnsupportedStateSchemaVersionError(
      'UNSUPPORTED_NUMERIC_STATE_VERSION',
      persistedNumeric,
      STATE_SCHEMA_VERSION,
      `Schegent state schemaVersion ${persistedNumeric} exceeds runtime ${STATE_SCHEMA_VERSION}. Update the extension before opening this workspace.`
    );
  }
}

export function isRunRaceRefusal(error: unknown): error is QueueMutationRejected {
  return (
    error instanceof QueueMutationRejected &&
    (error.reason === 'stale-run-id' || error.reason === 'run-status-precondition')
  );
}

export type ForwardMigrationEvents = Omit<
  InitializeResult,
  'migrated' | 'runRepairEvents'
>;

export interface InitializeResult {
  migrated: boolean;
  v6MigrationEvents: readonly StateMigratedV5ToV6AuditEvent[];
  v7MigrationEvents: readonly StateMigratedV6ToV7AuditEvent[];
  v10MigrationEvents: readonly StateMigratedV9ToV10AuditEvent[];
  v11MigrationEvents: readonly RunStateMigrationAuditEvent[];
  v12MigrationEvents: readonly HistoryStateMigrationAuditEvent[];
  v13MigrationEvents: readonly QueuePauseCollapseAuditEvent[];
  v14MigrationEvents: readonly VerdictBasisMigrationEvent[];
  orphanedRunEvents: readonly OrphanedRunCanceledAuditEvent[];
  runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
}

export interface RunQuarantineHandle {
  capture(entries: readonly { readonly queueId: string; readonly raw: unknown }[]): Promise<void>;
  drain(): ReadonlyArray<{
    readonly eventType: 'run-record-quarantined';
    readonly payload: RunRecordQuarantinedPayload;
  }>;
}

/**
 * FR-R7-07 (FR-005) — Single-instance concurrency, fencing, and write-gate context
 * owned exclusively by `WorkspaceStateStore` and passed into key-family modules.
 * Family modules MUST NEVER construct their own serialize chain, commit fence, or
 * `MementoWriteGate`.
 */
export interface WorkspaceStateFamilyContext {
  readonly supportsBatchWrite: boolean;
  readonly memento: Memento;
  readonly writeGate: MementoWriteGate;
  readonly logger: SanitizedLogger | null;
  readonly scheduler: Scheduler;
  readonly runQuarantine: RunQuarantineHandle;
  getOwnershipRegistry(): OwnershipRegistry;
  getRunClaimSource(): RunClaimSource | null;
  getPrimacyClaimSource(): PrimacyClaimSource | null;
  serialize(key: string, op: () => PromiseLike<void> | Promise<void>): Promise<void>;
  serializeAcrossKeys(
    keys: readonly string[],
    op: () => PromiseLike<void> | Promise<void>
  ): Promise<void>;
  notify(key: StoreChangeKey): void;
  runCommitClaim(queueId: string): RunCommitClaim;
  refuseIfClaimLost(queueId: string): void;
  verifyPrimacyForCommit(label: string): Promise<void>;
  verifyQueueOwnershipForCommit(queueId: string, label?: 'Queue' | 'Run'): Promise<void>;
  refuseCommit(failure: CommitFenceFailure, claim: OwnershipClaim, queueId: string): never;
  ensureExtendedQueueShape(persisted: QueueState): QueueState;
  compactRequestPositions(requests: readonly FeatureRequest[]): FeatureRequest[];
  assertGlobalConcurrencyCap(value: unknown, origin: 'requested' | 'persisted'): asserts value is number;
  readQueueMap(): QueueStateMap;
  getQueue(queueId: string): QueueState;
  getQueueRegistry(): QueueRegistry;
  getRun(queueId: string): WorkflowRun | null;
  readHistoryMap(): PersistedHistoryMap;
  pruneExcessDeletedHistoryPartitions(
    map: PersistedHistoryMap,
    registeredIds?: ReadonlySet<string>
  ): PersistedHistoryMap | null;
  warnLoadRepairs(warnings: readonly LoadRepairWarning[]): void;
  getTerminalTransitionIntents(): Readonly<Record<string, import('./workflow-run').TerminalTransitionIntent>>;
  readonly migrationSteps: {
    migrateV12ToV13IfNeeded(): Promise<readonly QueuePauseCollapseAuditEvent[]>;
    migrateVerdictBasisIfNeeded(): Promise<readonly VerdictBasisMigrationEvent[]>;
    migrateCreditPauseIfNeeded(): Promise<void>;
    reconcileOrphanedRunsIfNeeded(): Promise<readonly OrphanedRunCanceledAuditEvent[]>;
  };
}

export type { RunQuarantineEntry };
