import type {
  RunQuarantineEntry,
  RunRecordQuarantinedPayload
} from '../contracts/audit-events';
import { createRunQuarantine } from './run-quarantine';
import { DEFAULT_GLOBAL_CONCURRENCY_CAP, MAX_QUEUES } from '../contracts/queue-bounds';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import {
  MAX_PENDING_TASKS_PER_QUEUE,
  ensureExtendedFeatureRequest,
  validateDescription,
  type FeatureRequest,
  type QueueState
} from '../queue/feature-request';
import {
  findQueue,
  makeDefaultRegistry,
  projectQueueRegistry,
  validateQueueRegistry,
  type ProjectedQueueRegistry,
  type QueuePauseSource,
  type QueuePauseView,
  type QueueRegistry,
  type QueueRegistryEntry
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
  repairLegacyRunSnapshot,
  type WorkflowRunRepairedAuditEvent
} from './workflow-run-migrator';
import {
  assertPersistedVersionSupported,
  migrateLegacyQueueState,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV9ToV10,
  migrateV12ToV13,
  type QueuePauseCollapseAuditEvent,
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
import { DELAYED_RETRY_CAP } from '../contracts/retry-bounds';
import { HISTORY_UNATTRIBUTED_QUEUE_ID } from '../contracts/queue-identity';
import {
  migrateV11ToV12,
  type HistoryStateMigrationAuditEvent
} from './history-state-migrator';
import type { SanitizedLogger } from '../lib/logger';

export const SCHEMA_VERSION = '1.0.0';
export { STATE_SCHEMA_VERSION };

export type PersistedHistoryEntry = object;

/**
 * FR-R3-010 (T402) — the v12 persisted shape of `KEYS.history`: one array of
 * terminal-run records per queue, keyed by queue id.
 *
 * A queue with no history has no key. Absence is the empty state, never a
 * stored `[]`, on the same reasoning as the v11 run map: a stored empty value
 * is a value, and it would survive a reset's `undefined` clear as a re-created
 * key on the next read.
 */
export type PersistedHistoryMap = Record<string, PersistedHistoryEntry[]>;

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
 * upper bound.
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
 * FR-R3-145 (T1572) — this is one of *three* sites defining the cap's value or
 * its bounds, and all three enforce: here, `queue/queue-manager.ts`, and
 * `contracts/validators/queue-management.ts`, each deriving its ceiling from
 * `MAX_QUEUES`. The three that restated the numbers without enforcing them —
 * `config/settings-schema.ts`, `config/general-settings.ts`, `package.json` —
 * advertised a configuration key nothing read, and went with it. The default
 * now lives in `contracts/queue-bounds.ts` beside `MAX_QUEUES`: the projection
 * that displays it and the store that decides it are in different layers.
 */
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
  // FR-R3-011 — the legacy `paused` / `pausedReason` mirrors are read above (as
  // migration input, to derive a lifecycle for a record that predates the
  // discriminator) and are **not** written back. Normalising them forward would
  // reinstate the second representation on every read, which is the one thing
  // the collapse must not leave a way to do.
  const pauseSource = normalizePauseSource(persisted, queueLifecycle, paused);
  return {
    inFlightId,
    updatedAt: persisted.updatedAt ?? Date.now(),
    requests: normalizedRequests,
    queueLifecycle,
    pauseSource,
    // Kept, unlike `paused` above: the reason string is held nowhere else, and
    // the controller matches its `retry-cap-exhausted:<runId>` marker. Cleared
    // when the queue is not paused, which is the field's own invariant.
    pausedReason: pauseSource === null ? null : persisted.pausedReason ?? null,
    scheduledStartAt: queueLifecycle === 'idle-pending' ? scheduledStartAt : null,
    scheduledStartSource: queueLifecycle === 'idle-pending' ? scheduledStartSource : null,
    ...(migrationNotice ? { migrationNotice } : {})
  };
}

/**
 * FR-R3-011 — the pause attribution for a normalised queue record.
 *
 * A record written by this build carries its own `pauseSource` and it is
 * returned verbatim. A record that predates the collapse carries none, so a
 * queue that reads as paused is attributed `'operator'` — the conservative
 * reading, because an operator pause outranks a cascade one and must never be
 * demoted to it.
 *
 * The pairing is established here rather than asserted afterwards: a queue that
 * is not paused has no source, in one expression, from one input.
 */
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

export const KEYS = {
  schemaVersion: 'schegent.schemaVersion',
  schemaVersionNumeric: 'schegent.schemaVersionNumeric',
  queue: 'schegent.queue',
  queueRegistry: 'schegent.queues.registry',
  queueMigrationQuarantine: 'schegent.state.quarantine.v2',
  // FR-R3-111 (FR-112, FR-114) — the RUN half of the same idea.
  //
  // A separate key from the queue quarantine on purpose: the two hold different aggregates and
  // are bounded independently, so a corruption loop in one cannot evict the other's evidence.
  runQuarantine: 'schegent.state.runQuarantine.v1',
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
  concurrencyNotice: 'schegent.ui.concurrencyNotice',
  // FR-R3-146 (FR-006) — durable Git-plan consent, keyed by mutation-plan
  // fingerprint. Its own key for the reason `connectedRuns` gives above, and
  // deliberately not folded into `confirmSuppression`: that one holds UI action
  // names, and merging them would let "don't ask about clearing the queue" read
  // as consent to mutate a repository. Absent means nothing granted, which is
  // both fail-closed and the whole forward migration this record needs.
  gitPlanGrants: 'schegent.consent.gitPlanGrants.v1',
  // Feature FR-R3-006 (T337, T341) — the reset generation marker.
  //
  // In `KEYS` and on `RESET_EXEMPT_KEYS` below, which is not a contradiction:
  // it belongs here because the completeness test enumerates this map and a key
  // reset does not clear has to be an accounted-for decision rather than an
  // omission, and it is exempt because it is the one record that must survive
  // the clear it describes. Clearing it would erase the evidence that a reset
  // was underway at exactly the moment that evidence matters.
  resetMarker: 'schegent.reset.marker'
} as const;

/**
 * Feature FR-R3-006 (T338) — the keys `reset()` deliberately does not clear.
 *
 * Every other entry in `KEYS` is cleared. This list is the complement, and
 * `tests/unit/state/reset-covers-every-key.test.ts` asserts the two partition
 * `KEYS` exactly — so a key added to neither fails the build rather than being
 * silently missed, which is how `executionLeases` and `concurrencyNotice` came
 * to survive a reset for two features.
 *
 * The reason strings are the point of the structure. A bare list would record
 * that a key is exempt without recording why, and the next person to read it
 * cannot tell a decision from an oversight.
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
    'marker exists.'
} as const;

/**
 * Feature FR-R3-006 (T339) — the keys a reset clears, derived rather than
 * listed.
 *
 * Derivation is the fix. The list this replaces was maintained by hand, so a key
 * was cleared only if someone remembered to add it, and two were not: feature
 * 092's `executionLeases` and `concurrencyNotice` both shipped into `KEYS` and
 * neither reached the clear. Deriving makes the default "cleared" and turns
 * exemption into the thing that has to be written down.
 */
export const RESET_CLEARED_KEYS: readonly string[] = Object.values(KEYS).filter(
  (key) => !(key in RESET_EXEMPT_KEYS)
);

import { readConfirmSuppression, writeConfirmSuppression } from './confirm-suppression';
export { CONFIRM_SUPPRESSION_VERSION, type ConfirmSuppressionState } from './confirm-suppression';
import {
  readGitPlanGrants,
  writeGitPlanGrant,
  type GitPlanGrant,
  type GitPlanGrantMap
} from './git-plan-grants';
export { type GitPlanGrant, type GitPlanGrantMap } from './git-plan-grants';
import { migrateConnectedRuns } from './connected-run-migrator';
import { assertConnectedRunInvariants, type ConnectedWorkflowRun } from './connected-workflow-run';
// Type-only: `execution-lease.ts` imports the staleness constants from `lock.ts`,
// so a value import here would close a cycle the type import cannot.
import type { ExecutionLease } from './execution-lease';
import {
  checkCommitFence,
  isFencedClaim,
  unfencedCommit,
  type QueueCommitClaim,
  type RunCommitClaim
} from './ownership-claim';
import { createMementoOwnershipFs, type OwnershipFs } from './ownership-fs';
import {
  isResetInterrupted,
  isResetMarker,
  nextResetGeneration,
  type ResetMarker
} from './reset-transaction';
import {
  MEMENTO_OWNERSHIP_DIR,
  OwnershipRegistry,
  queueResource,
  type FenceCheck
} from './ownership-registry';
import { isSupersededRun } from './workflow-run';

/**
 * FR-R3-010 (T403) — retained terminal runs **per queue**.
 *
 * The number is unchanged from the flat cap it replaces; its denominator is
 * not. 50 used to be the whole workspace's history divided across up to
 * `MAX_QUEUES` queues, so a fully populated workspace kept an average of 2.5
 * runs each and one busy queue evicted everyone else's. It is now 50 for each
 * queue, applied at the write site and nowhere else.
 *
 * Raising it is now a bounded decision rather than the compounding one it used
 * to be: with the description moved out of the entry (T405) a record is a few
 * hundred bytes of counters and identifiers, so depth costs bytes linearly
 * instead of multiplying a 32 KB field by the cap on every completion.
 */
export const HISTORY_CAP_PER_QUEUE = 50;

/**
 * Feature FR-R3-003 (T302) — one window's claim on one arbitrated resource, as a
 * guarded operation carries it.
 *
 * `resource` is `PRIMACY_RESOURCE` or `queueResource(queueId)`; the two have
 * independent generation counters, so a fence is only meaningful against the
 * resource it was issued for. Passing them together as one value is what keeps a
 * caller from pairing a primacy token with a queue.
 */
export interface OwnershipClaim {
  readonly resource: string;
  readonly ownerId: string;
  readonly fence: number;
}

/**
 * FR-R3-077 — whoever can answer "does this window hold `queueId`, and at what
 * generation". `ExecutionLeaseManager` is the production implementation; the
 * narrow shape is what lets a test bind a stub without a lease manager.
 */
export interface RunClaimSource {
  claimFor(queueId: string): OwnershipClaim | null;
}

/**
 * FR-R3-077 — what `readRunIfLive` answers.
 *
 * `superseded` carries both generations rather than a bare boolean, because the
 * decline has to be observable: a reader that logged "declined" without the two
 * numbers gives an operator nothing to act on.
 */
export type RunReadVerdict =
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'live'; readonly run: WorkflowRun }
  | {
      readonly outcome: 'superseded';
      readonly run: WorkflowRun;
      readonly writtenAtFence: number;
      readonly liveFence: number;
    };

/**
 * The outcome of a guarded write (T302).
 *
 * `rejected` is the arm the fencing token exists to produce: the write did not
 * happen, and the caller is told which generation superseded it and who holds the
 * resource now. `unavailable` means storage could not answer — the claim may well
 * still be good — and is kept separate for that reason.
 */
export type GuardedWriteOutcome =
  | { readonly outcome: 'written' }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'stale-fence' | 'not-holder';
      readonly currentFence: number;
      readonly ownerOfRecord: string | null;
    }
  | { readonly outcome: 'unavailable' };

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
  | 'invalid-global-concurrency-cap'
  // FR-R3-055 (H-06) — the mutator's execution fence is no longer the live
  // generation for that resource, so its state mutation is refused AT THE COMMIT
  // POINT rather than believed because admission once said yes.
  | 'fence-superseded'
  // The two refusals `fence-superseded` used to absorb; see `checkCommitFence`
  // in `ownership-claim.ts` for why each is its own answer.
  | 'fence-unverifiable'
  | 'fence-wrong-resource';

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
  const intent = raw as Partial<TerminalTransitionIntent> & { description?: unknown };
  if (
    intent.schemaVersion !== 1 ||
    intent.run === undefined ||
    typeof intent.run !== 'object' ||
    typeof (intent.run as WorkflowRun).id !== 'string' ||
    typeof intent.createdAt !== 'number'
  ) {
    return null;
  }
  // FR-R3-071 — the journalled description is optional; a non-string value is
  // dropped rather than coerced or grounds for rejecting the whole intent,
  // which would strand a replayable transition over a corrupt convenience field.
  if (intent.description !== undefined && typeof intent.description !== 'string') {
    const { description: _dropped, ...rest } = intent;
    return rest as TerminalTransitionIntent;
  }
  return intent as TerminalTransitionIntent;
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

/**
 * The audit events the forward migration ladder produces.
 *
 * Derived from `InitializeResult` by omitting the fields the ladder does not
 * own, so adding a migration step means adding one field in one place. Declaring
 * a parallel interface would reintroduce, at the type level, exactly the
 * duplication `runForwardMigrations` removes at the call level.
 */
export type ForwardMigrationEvents = Omit<
  InitializeResult,
  'migrated' | 'runRepairEvents'
>;

/**
 * Did any step of the forward ladder actually produce events?
 *
 * Reads every field of the ladder's result rather than naming six of them, so a
 * seventh step is counted without editing this predicate. The version that stood
 * here spelled out six `.length > 0` checks; a step added without a seventh line
 * would have reported `migrated: false` on a workspace that had just been
 * migrated.
 */
function anyForwardMigrationRan(events: ForwardMigrationEvents): boolean {
  return Object.values(events).some((list) => list.length > 0);
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
  // FR-R3-010 — emitted by the v11 → v12 migrator when it partitioned the flat
  // history array by queue, plus one summary event when entries could not be
  // attributed. Same forwarding contract as `v11MigrationEvents` above.
  v12MigrationEvents: readonly HistoryStateMigrationAuditEvent[];
  // FR-R3-011 — emitted by the v12 → v13 pause collapse, plus one event per
  // queue whose three representations disagreed. Same forwarding contract as
  // `v12MigrationEvents` above.
  //
  // The divergence events are the durable record that replaces the retired
  // reconciler's `logger.warn`. A warn line is neither durable nor
  // correlatable, and an operator asking why a queue came back paused after an
  // upgrade needs to see which representation said so.
  v13MigrationEvents: readonly QueuePauseCollapseAuditEvent[];
  // Feature 056 — emitted when persisted WorkflowRun snapshots are repaired.
  runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
}

export class WorkspaceStateStore {
  /** FR-R3-111 — the quarantine, in its own module; see `state/run-quarantine.ts`. */
  private readonly runQuarantine = createRunQuarantine({
    read: () => this.memento.get<RunQuarantineEntry[]>(KEYS.runQuarantine) ?? [],
    write: (entries) => this.memento.update(KEYS.runQuarantine, entries),
    now: () => Date.now(),
    warn: (reason) => this.logger?.warn('run record quarantine failed', { reason })
  });

  private readonly memento: Memento;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<StoreChangeListener>();
  private readonly logger: SanitizedLogger | null;
  /** FR-R3-077 — bound at composition; see `bindRunClaimSource`. */
  private runClaimSource: RunClaimSource | null = null;
  /** One warn per queue, not one per commit: a stranded lease is not news twice. */
  private readonly unfencedQueuesWarned = new Set<string>();
  /** FR-R3-146 — same rule for an unreadable Git-plan grant; see `getGitPlanGrants`. */
  private readonly gitPlanGrantProblemsWarned = new Set<string>();
  // Feature 092 (T056) retired the one-shot saturation-WARN guard that used to
  // live here: the reader no longer saturates, so there is no silent coercion
  // left to warn about.

  // Feature FR-R3-003 (T295) — the compare-and-swap seam the two ownership
  // leases acquire through. It is not a `KEYS` entry, because a `Memento` cannot
  // answer the question either lease asks: `update` is unconditional and its
  // cross-process visibility is undocumented, so two extension hosts reading
  // this store's other keys would each elect themselves. Mutable because the
  // store is constructed in activation stage 1, before a workspace folder is
  // known, and the authoritative storage is rooted inside that folder.
  private ownershipRegistry: OwnershipRegistry;

  constructor(memento: Memento, logger?: SanitizedLogger) {
    this.memento = memento;
    this.logger = logger ?? null;
    this.ownershipRegistry = new OwnershipRegistry(
      createMementoOwnershipFs(memento),
      MEMENTO_OWNERSHIP_DIR
    );
  }

  /**
   * The registry both leases arbitrate through. Read at call time rather than
   * captured, so a manager built before `useOwnershipStorage()` still lands on
   * the authoritative storage.
   */
  public get ownership(): OwnershipRegistry {
    return this.ownershipRegistry;
  }

  /**
   * Point ownership arbitration at storage two extension hosts can both see.
   *
   * Called once, from activation stage 2, with `<workspaceRoot>/.schegent/ownership`
   * — the earliest point at which the workspace root is known. Until then the
   * store falls back to a `Memento`-backed adapter, which is correct for a single
   * host and is the reason this call is not optional in production;
   * `tests/lint/ownership-registry-wiring.test.ts` pins it.
   */
  public useOwnershipStorage(fs: OwnershipFs, dir: string): void {
    this.ownershipRegistry = new OwnershipRegistry(fs, dir);
  }

  /**
   * Feature FR-R3-003 (T302) — is this claim still good?
   *
   * The store's own view of a fencing token, so a caller asking "am I still the
   * holder" does not reach past it into the registry. `rejected` carries the
   * generation that superseded the claim and the owner of record, because a
   * caller that has just been told it is not the holder is entitled to know who
   * is — that is the half of the acceptance criterion the token exists for.
   */
  public verifyClaim(claim: OwnershipClaim): Promise<FenceCheck> {
    return this.ownershipRegistry.verify(claim.resource, claim.ownerId, claim.fence);
  }

  /**
   * FR-R3-077 (T1038) — where a commit point gets the claim it is now required to
   * carry.
   *
   * Bound once, at composition, by whoever owns the per-queue execution leases.
   * The alternative considered and rejected was threading a lease manager through
   * every service that writes a Run: `PhaseControlService` takes a `Pick<>` of the
   * store and nothing else, and widening a dozen constructors is a large diff that
   * changes nothing about *which* commits are fenced.
   *
   * What is NOT delegated is the choice. `setRun` takes `RunCommitClaim`, so every
   * call site still says either "fence me against the lease I hold"
   * (`store.runCommitClaim(queueId)`) or "I hold none, and here is why"
   * (`unfencedCommit(reason)`), and the two are distinguishable in a diff and
   * countable by `tests/unit/state/unfenced-commit-inventory.test.ts`.
   */
  public bindRunClaimSource(source: RunClaimSource): void {
    this.runClaimSource = source;
  }

  /**
   * The commit claim for `queueId`: this window's live lease claim when it holds
   * one, and an observable unfenced commit when it does not.
   *
   * `lease-not-held` is the one reason produced here rather than written at a call
   * site, and it is the honest answer to a real case: a Run's terminal transition
   * releases its queue's lease, and a late write after that release has no claim
   * to carry. Refusing it would strand the record; passing it silently is what
   * this item exists to stop. So it is passed, warned once per queue, and the
   * inventory test pins this file as the ONLY place the reason may appear.
   */
  public runCommitClaim(queueId: string): RunCommitClaim {
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

  /**
   * FR-R3-003 (T302) → FR-R3-077 (T1041) — the advisory lock mirror, refreshed
   * under a claim that reaches the write.
   *
   * This replaces `writeGuarded(claim, write)`, which is **deleted**. That
   * helper verified the claim and then awaited a callback: two operations, with
   * a reclaim able to land between them, behind a name that promised atomicity.
   * The 2026-08-24 review found it had exactly one production caller — this
   * one, guarding the advisory `KEYS.lock` mirror — so the exposure was narrow
   * and the shape was the problem: a working helper of that shape is a working
   * template for reintroducing the defect this round exists to remove. That is
   * the same reasoning that deleted `withLock`, and it is recorded in AGENTS.md
   * under the lock-release rule.
   *
   * What replaces it is not a general-purpose wrapper. It is one method for one
   * write, with the verify INSIDE the `KEYS.lock` serialize chain that performs
   * the mirror update — one link, the same shape `setRun` uses, and as close to
   * a conditional write as `Memento` allows.
   *
   * `unavailable` and `rejected` stay distinct for the reason they always did: a
   * failed read says nothing about who holds the resource, and a caller that
   * conflates them surrenders a live claim on a transient error.
   */
  public async refreshLockMirrorGuarded(
    claim: OwnershipClaim,
    mirror: WorkspaceLock,
    options: { readonly refreshHeartbeatAt?: number } = {}
  ): Promise<GuardedWriteOutcome> {
    let outcome: GuardedWriteOutcome = { outcome: 'unavailable' } as GuardedWriteOutcome;
    await this.serialize(KEYS.lock, async () => {
      const verdict =
        options.refreshHeartbeatAt === undefined
          ? await this.ownershipRegistry.verify(claim.resource, claim.ownerId, claim.fence)
          : await this.ownershipRegistry.heartbeat(
              claim.resource,
              claim.ownerId,
              claim.fence,
              options.refreshHeartbeatAt
            );
      if (verdict.outcome === 'unavailable') {
        outcome = { outcome: 'unavailable' };
        return;
      }
      if (verdict.outcome === 'rejected') {
        outcome = {
          outcome: 'rejected',
          reason: verdict.reason,
          currentFence: verdict.currentFence,
          ownerOfRecord: verdict.ownerOfRecord
        };
        return;
      }
      try {
        await this.memento.update(KEYS.lock, mirror);
        outcome = { outcome: 'written' };
      } catch {
        // The claim was good and the write was not. Reported as `unavailable`
        // for the same reason a failed read is: it says nothing about who holds
        // the resource, and a caller must not read it as having lost one.
        outcome = { outcome: 'unavailable' };
      }
    });
    if (outcome.outcome === 'written') this.notify(KEYS.lock);
    return outcome;
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
      const migrationEvents = await this.runForwardMigrations(persistedNumeric);
      await this.stampVersion(true);
      return {
        migrated: true,
        ...migrationEvents,
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
        const migrationEvents = await this.runForwardMigrations(persistedNumeric);
        await this.stampVersion(false);
        return {
          migrated: true,
          ...migrationEvents,
          runRepairEvents
        };
      }
      const runRepairEvents = await this.normalizeRunForInitialize(false);
      const migrationEvents = await this.runForwardMigrations(persistedNumeric);
      return {
        migrated: anyForwardMigrationRan(migrationEvents) || runRepairEvents.length > 0,
        ...migrationEvents,
        runRepairEvents
      };
    }
    const [persistedMajor] = persistedVersion.split('.');
    const [runtimeMajor] = SCHEMA_VERSION.split('.');
    if (persistedMajor === runtimeMajor) {
      const runRepairEvents = await this.normalizeRunForInitialize(
        WorkspaceStateStore.needsLegacyRunMigration(persistedNumeric)
      );
      const migrationEvents = await this.runForwardMigrations(persistedNumeric);
      await this.stampVersion(true);
      return {
        migrated: true,
        ...migrationEvents,
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
  /**
   * FR-R3-039 — the forward migration ladder, in one place.
   *
   * These seven steps were written out in full at four separate points in
   * `initialize()`, once per version branch: the same calls, in the same order,
   * four times. That is the maintainability defect the round-3 review was
   * pointing at, though not where it looked — it described eight
   * `migrateVnToVn+1` methods living in this class, and those were extracted
   * into `queue-state-migrator.ts`, `run-state-migrator.ts`,
   * `history-state-migrator.ts` and their siblings some time ago. What was left
   * here is the orchestration, and the orchestration was duplicated.
   *
   * Duplicated in a way with teeth: adding a v13 → v14 step meant editing four
   * places, and missing one left a branch that silently skipped a migration for
   * whichever workspaces took it. Order is load-bearing here — each step's
   * doc comment explains what it must run after and why — and an order stated
   * four times is an order that can disagree with itself.
   *
   * The steps themselves are unchanged and still run against `this.memento`.
   * This is a single definition of the sequence, not a new abstraction over it.
   */
  private async runForwardMigrations(
    persistedNumeric: number | undefined
  ): Promise<ForwardMigrationEvents> {
    // Derived from InitializeResult rather than declared beside it: a parallel
    // shape would be a second thing to update when a step is added, which is the
    // duplication this method exists to remove.
    await this.migrateQueueRegistryIfNeeded();
    return {
      v6MigrationEvents: await this.migrateV5ToV6IfNeeded(persistedNumeric),
      v7MigrationEvents: await this.migrateV6ToV7IfNeeded(persistedNumeric),
      v10MigrationEvents: await this.migrateV9ToV10IfNeeded(),
      v11MigrationEvents: await this.migrateV10ToV11IfNeeded(),
      v12MigrationEvents: await this.migrateV11ToV12IfNeeded(),
      v13MigrationEvents: await this.migrateV12ToV13IfNeeded()
    };
  }

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
   * FR-R3-010 (T406) — the v11 → v12 forward migration.
   *
   * Runs after `migrateV10ToV11IfNeeded()` for the same reason that one runs
   * after the v9 → v10 lift: it shares the task → queue resolver, which reads a
   * `KEYS.queue` the earlier step has already put in map shape. It owns exactly
   * one `update()` and performs it only when the migrator reports a change, so
   * `KEYS.history` is the only key it touches and a rejected write leaves valid
   * v11 state behind for the next open to re-attempt.
   *
   * Keyed on the **shape** of the record, never on the persisted version
   * number, on the same reasoning as its v11 sibling: the two live in separate
   * memento keys with separate writes, so a workspace whose version key moved
   * but whose record did not must still be repaired the next time it is opened.
   */
  private async migrateV11ToV12IfNeeded(): Promise<readonly HistoryStateMigrationAuditEvent[]> {
    const result = migrateV11ToV12(
      this.memento.get<unknown>(KEYS.history),
      (taskId) => this.queueIdForPersistedTask(taskId),
      Date.now()
    );
    if (!result.changed) return [];
    await this.memento.update(KEYS.history, result.history);
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

  /**
   * FR-R3-011 (T419/T420) — the v12 → v13 pause collapse.
   *
   * This method **replaces** `reconcileQueuePauseStateIfDivergent()`, the
   * BUG-001 startup repair pass that used to sit here. That pass compared the
   * legacy `QueueState.paused` mirror against `QueueRegistryEntry.state` and, on
   * disagreement, re-derived `queueLifecycle` from `(inFlightId, registryPaused,
   * pendingCount)` — which made it a fourth writer of the discriminator, free to
   * overwrite a legitimately held `idle-pending` or `active-empty` on the
   * strength of a disagreement between two fields that were not the
   * discriminator. It is deleted rather than tightened: a repair pass is a
   * repair for a state that should be unrepresentable, and after the collapse
   * there is one persisted value, so there is nothing left to reconcile.
   *
   * Runs last in the chain, after `migrateV11ToV12IfNeeded()`, because it reads
   * a `KEYS.queue` the v9 → v10 lift has already put in map shape. Keyed on the
   * **shape** of the record, never on the persisted version number, on the same
   * reasoning as its v11 and v12 siblings.
   *
   * Two writes, and the ordering is the guarantee. `KEYS.queue` carries the
   * authoritative value and is written first; `KEYS.queueRegistry` only has the
   * now-derived copy removed from it. A window lost between them leaves a
   * registry holding inert leftovers that `projectQueueRegistry()` overwrites on
   * every read — never a queue whose authority has been erased. The registry
   * write is skipped entirely when nothing on it changed.
   */
  private async migrateV12ToV13IfNeeded(): Promise<readonly QueuePauseCollapseAuditEvent[]> {
    const queueStates = this.readQueueMap();
    const registry = this.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? makeDefaultRegistry();
    const result = migrateV12ToV13(queueStates, registry, Date.now());
    if (!result.changed) return [];
    await this.memento.update(KEYS.queue, result.queueStates);
    if (JSON.stringify(result.registry) !== JSON.stringify(registry)) {
      await this.memento.update(KEYS.queueRegistry, result.registry);
      this.notify(KEYS.queueRegistry);
    }
    this.notify(KEYS.queue);
    return result.auditEvents;
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
      const quarantined: Array<{ queueId: string; raw: unknown }> = [];
      let changed = applyLegacyMigration;
      for (const [queueId, persisted] of Object.entries(raw)) {
        const migrated = applyLegacyMigration ? migrateLegacyRun(persisted) : persisted;
        if (migrated === null) {
          // FR-R3-111 (FR-112) — quarantined, not discarded. This branch is currently
          // UNREACHABLE (`isRunStateMap` and `migrateLegacyRun` have mutually exclusive
          // requirements); `tests/unit/state/run-record-quarantine.test.ts` explains why and
          // asserts it, so a divergence in either predicate reports that this became live. The
          // singular branch below is the one that was losing records.
          changed = true;
          quarantined.push({ queueId, raw: persisted });
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
      // After the map write, so a quarantine failure cannot cost the records that DID parse.
      if (quarantined.length > 0) await this.runQuarantine.capture(quarantined);
      return events;
    }

    const migrated = applyLegacyMigration ? migrateLegacyRun(raw) : (raw as WorkflowRun);
    if (migrated === null) {
      // FR-R3-111 (FR-113) — this returned `[]` with no bookkeeping at all, not even the
      // `changed` flag the map branch set. Silence was the defect, so it is fixed regardless of
      // what the retention policy should be.
      await this.runQuarantine.capture([{ queueId: DEFAULT_QUEUE_ID, raw }]);
      return [];
    }
    const repair = repairLegacyRunSnapshot(migrated);
    if (applyLegacyMigration || repair.auditEvent !== null) {
      await this.memento.update(KEYS.run, repair.run);
    }
    return repair.auditEvent === null ? [] : [repair.auditEvent];
  }

  /**
   * FR-R3-111 — quarantine events awaiting an audit writer.
   *
   * `initialize()` runs before the audit writer exists — the same reason the migration events use a
   * forwarder — so these are buffered and drained here. Dropping them instead would restore the
   * silence this item removed, one layer further out.
   */
  public drainRunQuarantineEvents(): ReadonlyArray<{
    readonly eventType: 'run-record-quarantined';
    readonly payload: RunRecordQuarantinedPayload;
  }> {
    return this.runQuarantine.drain();
  }

  private async migrateQueueRegistryIfNeeded(): Promise<void> {
    const existingRegistry = this.memento.get<QueueRegistry>(KEYS.queueRegistry);
    if (existingRegistry !== undefined && existingRegistry !== null) {
      // FR-R3-011 (T423) — the feature-028 v4 → v5 `pauseSource` backfill used
      // to write here. It is gone, and deliberately not replaced: `pauseSource`
      // is no longer a field of a registry entry, so the backfill had no
      // destination left, and persisting it anyway would re-add on every
      // activation the mirror `migrateV12ToV13()` strips on every load — two
      // writes per open, churning against each other forever.
      //
      // A legacy entry that still carries `state`/`pauseSource` is read by
      // `legacyRegistryPause()` during the collapse, with the same
      // `manually-paused` ⇒ `'operator'` defaulting feature 028 applied. The
      // rule moved to the surviving representation; it was not dropped.
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
      updatedAt: Date.now(),
      queueLifecycle: 'active-empty',
      pauseSource: null,
      pausedReason: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
  }

  /**
   * One queue's execution state. `queueId` is **required** (FR-R3-002, T281).
   * It used to default to `DEFAULT_QUEUE_ID` "so every pre-092 caller keeps its
   * meaning unchanged", and that is exactly how three production seams came to
   * read the Default queue while believing they had read the caller's: a
   * default parameter turns "the caller forgot" into "the caller meant Default",
   * silently and at the wrong layer. Deleting the default makes
   * `npm run typecheck` the exhaustive call-site worklist, the same mechanism
   * feature 093 used when it deleted the ambient `getRun()`.
   *
   * An unknown id returns a born-empty `QueueState` and persists **nothing**
   * (FR-007). Reading is not a way to create a queue — the registry is the
   * only thing that decides which queues exist, and a read that fabricated an
   * entry would let a typo'd id quietly become a real one.
   */
  public getQueue(queueId: string): QueueState {
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
   *
   * FR-R3-002 (T280) — `queueId` is **required**, for the reason given on
   * `getQueue()` above and with one extra edge here: a write that silently
   * lands on Default does not read as a missing write, it reads as a *sibling's*
   * write. A scheduled start armed on queue B cleared queue A's lifecycle
   * fields for exactly this reason.
   */
  public updateQueue<T>(
    mutate: (current: QueueState) => { readonly queue: QueueState; readonly result: T },
    queueId: string,
    /**
     * FR-R3-077 (T1045) — the execution fence this queue mutation is made under.
     *
     * **Required**, and delivered as its own change after the Run commit point's
     * half landed, which is the order the escalated-residuals decision record
     * (`00_INDEX.md` §7) item 2 sets. Folding the two into one change is what
     * that record forbids: the Run path is the one the review measured and the
     * one a stale host reaches first, and a single change that moved both would
     * have made the smaller
     * blast radius indistinguishable from the larger.
     *
     * The verification happens INSIDE the serialized link that performs the
     * memento write, for the same reason `setRun`'s does: `Memento` offers no
     * conditional write, and one link of the chain that already serializes this
     * key is as close to a transaction as this storage allows — strictly closer
     * than two.
     */
    claim: QueueCommitClaim
  ): Promise<T> {
    let result!: T;
    return this.serialize(KEYS.queue, async () => {
      if (isFencedClaim(claim)) {
        const f = await checkCommitFence(this.ownershipRegistry, claim, queueId, 'Queue');
        if (f !== null) throw new QueueMutationRejected(f.reason, f.message);
      }
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

  /**
   * FR-R3-011 — the registry with each entry's pause view filled in from the
   * queue that owns it.
   *
   * This is the read every surface that used to consult
   * `entry.state === 'manually-paused'` now makes. The persisted registry names,
   * orders and schedules queues; whether one is paused lives in its own
   * `QueueState` and is projected here, from one record, on every read. There is
   * no second copy to go stale, so there is nothing to reconcile at startup.
   */
  public getProjectedQueueRegistry(): ProjectedQueueRegistry {
    const queueStates = this.readQueueMap();
    const pauseByQueueId = new Map<string, QueuePauseView>(
      Object.entries(queueStates).map(([queueId, state]) => [
        queueId,
        {
          paused: state.queueLifecycle === 'operator-paused',
          pauseSource: state.pauseSource ?? null
        }
      ])
    );
    return projectQueueRegistry(this.getQueueRegistry(), pauseByQueueId);
  }

  /**
   * Persist the registry, minus anything derived.
   *
   * The strip is the write-side half of the collapse and it is defensive on
   * purpose: a caller that spreads a `ProjectedQueueRegistryEntry` into an edit
   * — a rename, a reorder — would otherwise persist the projected `state` and
   * `pauseSource` back onto the record they were derived from, quietly
   * recreating the second representation this feature removed. Stripping here
   * means every write goes through one normaliser rather than every call site
   * having to remember. `tests/lint/no-legacy-pause-mirror-write.test.ts` is the
   * other half.
   */
  public setQueueRegistry(registry: QueueRegistry): Promise<void> {
    validateQueueRegistry(registry);
    const normalized: QueueRegistry = {
      entries: registry.entries.map((entry) => {
        const { state: _state, pauseSource: _pauseSource, ...rest } = entry as QueueRegistryEntry & {
          state?: unknown;
          pauseSource?: unknown;
        };
        return rest;
      }),
      updatedAt: registry.updatedAt
    };
    return this.serialize(KEYS.queueRegistry, () =>
      this.memento.update(KEYS.queueRegistry, normalized)
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
    // corruption: fall back to `DEFAULT_GLOBAL_CONCURRENCY_CAP`, whose header in
    // `contracts/queue-bounds.ts` carries the value's reason and its authority.
    // FR-R3-145 (T1569) deleted the count that stood here — "the six defining
    // sites agree on. Six, not five" — along with the three that only advertised
    // the bound. `tests/lint/cap-authority-citation-parity.test.ts` counts now.
    if (value === undefined || value === null) return DEFAULT_GLOBAL_CONCURRENCY_CAP;
    assertGlobalConcurrencyCap(value, 'persisted');
    return value;
  }

  public setGlobalConcurrencyCap(value: number): Promise<void> {
    // Feature 092 (T056, FR-026/FR-027) — `[1, MAX_QUEUES]`. FR-R3-145 removed the
    // package contribution and `SETTINGS_SCHEMA` from the list that stood here; the
    // host validator and `QueueManager.saveQueueSettings` still share the invariant.
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
    }, queueId,
      this.runCommitClaim(queueId)
    );
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
    }, owner.queueId,
      this.runCommitClaim(owner.queueId)
    );
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
    }, owner.queueId,
      this.runCommitClaim(owner.queueId)
    );
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
    }, owner.queueId,
      this.runCommitClaim(owner.queueId)
    );
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
    }, owner.queueId,
      this.runCommitClaim(owner.queueId)
    );
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
    // Sorted, because `insertAt` indexes into this below and `getQueue()`
    // returns rows in array order rather than position order.
    const targetPending = this.getQueue(params.targetQueueId)
      .requests.filter((request) => request.status === 'pending')
      .sort((a, b) => a.position - b.position);
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
    // `insertAt` is a PENDING-ARRAY index; `.position` is a slot in the GLOBAL
    // sequence `compactRequestPositions()` keeps contiguous over pending and
    // non-pending rows alike, so using one as the other put an appended Task
    // second-to-last on any executing queue. Translate: the slot of the row the
    // Task lands in front of, or one past the last pending row. `.at()`, not
    // `[...]`, so `T | undefined` makes the guards necessary, not defensive.
    const last = targetPending.at(-1);
    const ahead = targetPending.at(insertAt);
    const insertSlot =
      ahead?.position ??
      (last === undefined
        ? this.getQueue(params.targetQueueId).requests.length
        : last.position + 1);
    const now = Date.now();
    const moved: FeatureRequest = {
      ...target,
      queueId: params.targetQueueId,
      position: insertSlot,
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
            // Every row at or past the opened slot shifts, pending or not: one
            // left in place would share a slot with the arriving Task.
            requests: [
              ...destination.requests.map((request) =>
                request.position >= insertSlot
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
  /**
   * FR-R3-077 (T1040) — the read-side half of the fence, with a production
   * caller at last.
   *
   * `setRun` refuses a write it can SEE; `Memento` offers no conditional write,
   * so a write made by a holder whose lease had already moved on can still land
   * in the window between the verify and the update. This is how a reader
   * disbelieves such a record instead of acting on it.
   *
   * An unstamped record answers `live`: records written before the stamp
   * existed, and every `unfencedCommit`, carry no generation to compare, and
   * reading absence as guilt would reject the entire existing corpus. The stamp
   * is evidence when present.
   *
   * Storage that cannot answer resolves to the current generation `0`, which no
   * stamp is below — so an unreadable registry never manufactures a decline. A
   * fence check that fails open on a read is right for the same reason it is
   * wrong on a write: declining here would strand a live Run on a transient I/O
   * error, and the write path already refuses what it must.
   */
  public async readRunIfLive(queueId: string): Promise<RunReadVerdict> {
    const run = this.getRun(queueId);
    if (run === null) return { outcome: 'absent' };
    const record = await this.ownershipRegistry.read(queueResource(queueId));
    const liveFence = record?.fence ?? 0;
    if (!isSupersededRun(run, liveFence)) return { outcome: 'live', run };
    return {
      outcome: 'superseded',
      run,
      writtenAtFence: run.writtenAtFence ?? 0,
      liveFence
    };
  }

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
   * FR-R3-008 (T377) — the Run with this id, together with the queue it is on.
   *
   * Sibling to `findRunByTask` above and exact for the same reason it is: the
   * monitor identifies its subprocess by run id and nothing else, so the write
   * that stamps that Run's liveness has to name a queue it did not receive.
   * Both halves or neither — a `setRun` with a guessed queue id would overwrite
   * a sibling Run's record, and run ids are `randomUUID()`, so this matches at
   * most one entry.
   */
  public findRunById(
    runId: string
  ): { readonly queueId: string; readonly run: WorkflowRun } | null {
    for (const [queueId, run] of Object.entries(this.readRunMap())) {
      if (run.id === runId) return { queueId, run };
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
  public setRun(
    queueId: string,
    run: WorkflowRun | null,
    /**
     * FR-R3-055 (H-06) / FR-R3-077 (T1038) — the execution fence this mutation is
     * made under. **Required.**
     *
     * It used to be optional, "so every existing caller is unchanged", and the
     * 2026-08-24 review measured what that bought: 35 call sites, none passing
     * one, `writtenAtFence` never written, `isSupersededRun` with no production
     * caller. A required parameter is a compiler-enforced inventory — the same
     * reasoning `createDiskOwnershipFs` applies to `containmentRoot` and
     * `createBackendRunner` to `allowUncontained`.
     *
     * A caller that provably holds no lease passes `unfencedCommit(reason)` with
     * a reason from the closed set in `state/ownership-claim.ts`. That is a
     * recorded finding about the call site, which the item requires; it is not a
     * default, which the item forbids.
     */
    claim: RunCommitClaim
  ): Promise<void> {
    if (run !== null) {
      validateRunInvariants(run);
      if (!findQueue(this.getQueueRegistry(), queueId)) {
        throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
      }
    }
    return this.serialize(KEYS.run, async () => {
      // FR-R3-055 — the verify happens INSIDE this serialized link, not before
      // it. That is the whole difference from `writeGuarded`, which verifies and
      // then separately awaits a callback: two operations, with a reclaim able to
      // land between them. `Memento` offers no conditional write, so one link of
      // the chain that already serialises this key is as close to a transaction
      // as this storage allows -- and it is strictly closer than two.
      if (isFencedClaim(claim)) {
        const f = await checkCommitFence(this.ownershipRegistry, claim, queueId, 'Run');
        if (f !== null) throw new QueueMutationRejected(f.reason, f.message);
      }
      const next = { ...this.readRunMap() };
      if (run === null) delete next[queueId];
      // FR-R3-055 — stamp the generation the write was made under, so a reader
      // holding a newer one can tell this entry came from a superseded holder.
      // Additive and optional: a record written before this field deserializes
      // unchanged, so no `STATE_SCHEMA_VERSION` moves.
      else next[queueId] = isFencedClaim(claim) ? { ...run, writtenAtFence: claim.fence } : run;
      await this.memento.update(KEYS.run, next);
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

  /**
   * FR-R3-010 (T402) — every queue's history, keyed by queue id.
   *
   * Tolerates a legacy flat array on the same terms `readRunMap()` tolerates a
   * single `WorkflowRun`: the migration is what converts it, but a read taken
   * before `initialize()` has written must still answer, and answering `{}`
   * would make a workspace with history read as empty on one path.
   *
   * A legacy array folds into `HISTORY_UNATTRIBUTED_QUEUE_ID` rather than into
   * `DEFAULT_QUEUE_ID`, because at this level there is nothing to attribute
   * *with* — the queue map is a different key and this function does not read
   * it. The migrator does, and it is the one that files entries under the
   * queues that actually own them.
   */
  private readHistoryMap(): PersistedHistoryMap {
    const raw = this.memento.get<unknown>(KEYS.history);
    if (raw === undefined || raw === null) return {};
    if (Array.isArray(raw)) {
      return raw.length > 0 ? { [HISTORY_UNATTRIBUTED_QUEUE_ID]: raw } : {};
    }
    if (typeof raw !== 'object') return {};
    const map: PersistedHistoryMap = {};
    for (const [queueId, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(entries)) map[queueId] = entries;
    }
    return map;
  }

  public getHistoryMap(): Readonly<PersistedHistoryMap> {
    return { ...this.readHistoryMap() };
  }

  /**
   * Every queue's entries in one array, oldest first.
   *
   * An aggregate read, and named as one. It exists because the history pane
   * shows the workspace's history rather than one queue's, so folding is the
   * ordinary case rather than an escape hatch — the opposite of `KEYS.run`,
   * where an ambient read picks a Run the operator was not looking at. Folding
   * history picks nothing; it returns all of it.
   */
  public getHistory(): PersistedHistoryEntry[] {
    return Object.values(this.readHistoryMap()).flat();
  }

  /**
   * FR-R3-010 (T403) — append one entry to one queue's partition.
   *
   * Three things changed from the flat implementation this replaces:
   *
   * **The cap is per partition.** 50 entries used to be the workspace's whole
   * history across up to 20 queues — an average of 2.5 runs each, and a single
   * busy queue evicted every other queue's record of itself. It is now 50 per
   * queue, which is the depth the constant always claimed to describe.
   *
   * **The dedupe scan is per partition too.** It was O(total history); it is
   * now O(one queue's history), and it answers the same question — the same run
   * id cannot terminate twice on two different queues.
   *
   * **The write is still a whole-map read-modify-write on this key's serialize
   * chain.** Partitioning reduces the bytes a write carries; it does not add a
   * second writer. A targeted per-partition write would need a facility the
   * `Memento` does not have, and hand-rolling one is how two queues completing
   * at the same moment drop each other's entry.
   *
   * Returns the entries the cap evicted, so the caller can clean up whatever it
   * stored beside them. Eviction is the only moment an entry stops being
   * reachable, and the store cannot do the cleanup itself without reaching for
   * the filesystem from the persistence boundary.
   */
  public async appendHistory(
    queueId: string,
    entry: PersistedHistoryEntry
  ): Promise<readonly PersistedHistoryEntry[]> {
    let evicted: readonly PersistedHistoryEntry[] = [];
    await this.serialize(KEYS.history, async () => {
      const map = this.readHistoryMap();
      const existing = map[queueId] ?? [];
      const incoming = entry as { runId?: unknown; terminalStatus?: unknown };
      if (
        typeof incoming.runId === 'string' &&
        existing.some((candidate) => {
          const prior = candidate as { runId?: unknown; terminalStatus?: unknown };
          return prior.runId === incoming.runId && prior.terminalStatus === incoming.terminalStatus;
        })
      ) return;
      const next = [...existing, entry];
      const overflow = next.length - HISTORY_CAP_PER_QUEUE;
      const trimmed = overflow > 0 ? next.slice(overflow) : next;
      evicted = overflow > 0 ? next.slice(0, overflow) : [];
      await this.memento.update(KEYS.history, { ...map, [queueId]: trimmed });
    });
    this.notify(KEYS.history);
    return evicted;
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
   * FR-R3-146 (FR-006, FR-011) — the durable Git-plan grants. Narrowing, and the
   * reasoning for its totality, are in `./git-plan-grants.ts`.
   *
   * Read per consultation, never captured: an operator who clears state
   * mid-session means it. Warned once per distinct problem, not once per
   * consultation — a drain asks on every task, and a corrupt entry is not news
   * twenty times (the rule `unfencedQueuesWarned` already applies).
   */
  public getGitPlanGrants(): GitPlanGrantMap {
    const result = readGitPlanGrants(this.memento.get<unknown>(KEYS.gitPlanGrants));
    for (const problem of result.problems) {
      if (this.gitPlanGrantProblemsWarned.has(problem)) continue;
      this.gitPlanGrantProblemsWarned.add(problem);
      this.logger?.warn(`workspace-state: ${KEYS.gitPlanGrants}: ${problem}`);
    }
    return result.grants;
  }

  /** Is this exact plan granted here? `hasOwnProperty`, so a stored `toString` cannot consent. */
  public hasGitPlanGrant(fingerprint: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.getGitPlanGrants(), fingerprint);
  }

  /** Record one grant; only the modal's `'persist'` decision reaches here. */
  public async recordGitPlanGrant(grant: GitPlanGrant): Promise<void> {
    const next = writeGitPlanGrant(this.getGitPlanGrants(), grant);
    await this.memento.update(KEYS.gitPlanGrants, next);
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

  /** The marker as persisted, or `null` when absent or unreadable. */
  public getResetMarker(): ResetMarker | null {
    const raw = this.memento.get<unknown>(KEYS.resetMarker);
    return isResetMarker(raw) ? raw : null;
  }

  /**
   * Feature FR-R3-006 (T339, T340, T341) — the clear, as a transaction.
   *
   * Three things changed and each closes a distinct defect:
   *
   * **It goes through the serialize chain.** The old implementation was a bare
   * `Promise.all` of `memento.update` calls, which is the one write path in this
   * store that does not queue behind the per-key chain. A `setRun` or
   * `updateQueue` already in flight could therefore land *after* its key was
   * cleared, recreating it. `serializeAcrossKeys` takes every affected chain, so
   * a concurrent write either completes wholly before the clear or queues behind
   * it — never inside it.
   *
   * **It clears every key.** `RESET_CLEARED_KEYS` is derived from `KEYS` minus
   * `RESET_EXEMPT_KEYS` rather than hand-listed, so a key added to `KEYS` is
   * cleared by construction. The hand-maintained list this replaces had missed
   * `executionLeases` and `concurrencyNotice` — the first of which is precisely
   * the state an operator reaches for reset to clear.
   *
   * **It is bracketed by the marker.** The marker is advanced to `in-progress`
   * before the first clear and to `complete` after the last, so a host that dies
   * mid-clear leaves a workspace that says so. Both marker writes are inside the
   * same serialized section as the clear, because a marker that could interleave
   * with the clear it brackets would describe the wrong thing.
   *
   * Cleared to `undefined`, never to an empty value: feature 093's note on
   * `KEYS.run` generalizes, and `{}` would make the cleared state a stored value
   * rather than an absent one.
   *
   * Returns the generation it committed, which is what the command layer puts in
   * the audit event (T348). A generation number is safe there in a way nothing
   * else about a reset is: it is a counter this build produced, not a path, a
   * task description, or anything the operator wrote.
   */
  public async reset(): Promise<number> {
    const generation = nextResetGeneration(this.getResetMarker());
    await this.serializeAcrossKeys([...RESET_CLEARED_KEYS, KEYS.resetMarker], async () => {
      await this.memento.update(KEYS.resetMarker, {
        generation,
        status: 'in-progress'
      } satisfies ResetMarker);
      for (const key of RESET_CLEARED_KEYS) {
        await this.memento.update(key, undefined);
      }
      await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
      await this.memento.update(KEYS.resetMarker, {
        generation,
        status: 'complete'
      } satisfies ResetMarker);
    });
    return generation;
  }

  /**
   * Feature FR-R3-006 (T346) — finish a reset the host did not survive.
   *
   * Called from the activation path when the persisted marker still reads
   * `in-progress`. It re-runs the clear at the *same* generation rather than
   * claiming a new one, because this is the completion of one reset and not a
   * second: advancing would make the generation count how many times a reset was
   * attempted rather than how many the workspace has had.
   *
   * Re-running is safe because clearing is idempotent — every key is set to
   * `undefined` whether or not the first attempt reached it — and re-running is
   * the *only* safe response, since a partial clear is indistinguishable from a
   * complete one by inspection. Reporting without finishing would leave the
   * workspace in the state this feature exists to make impossible.
   *
   * Returns the generation it completed, or `null` when there was nothing to
   * finish, so the caller can decide whether to audit.
   */
  public async completeInterruptedReset(): Promise<number | null> {
    const marker = this.getResetMarker();
    if (!isResetInterrupted(marker)) return null;
    const generation = marker!.generation;
    await this.serializeAcrossKeys([...RESET_CLEARED_KEYS, KEYS.resetMarker], async () => {
      for (const key of RESET_CLEARED_KEYS) {
        await this.memento.update(key, undefined);
      }
      await this.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
      await this.memento.update(KEYS.resetMarker, {
        generation,
        status: 'complete'
      } satisfies ResetMarker);
    });
    return generation;
  }

  /**
   * Feature FR-R3-006 (T340) — `serialize`, widened to a set of keys.
   *
   * `serialize` orders writes against one key's chain, which is right for every
   * ordinary write because each touches one key. Reset touches all of them at
   * once, and ordering it against any single chain would leave the other keys
   * unguarded — the same hole as not serializing at all, just narrower.
   *
   * So it waits on every named chain and then installs itself as every named
   * chain. `Promise.all` over the predecessors is not a barrier being added
   * where a pipeline would do: it is the definition of "after everything already
   * queued", which is exactly what a clear has to mean.
   *
   * Failures are swallowed into the stored chain and rethrown to the caller,
   * matching `serialize` — a failed reset must not wedge every subsequent write
   * on a rejected promise.
   */
  private serializeAcrossKeys(
    keys: readonly string[],
    op: () => Thenable<void> | Promise<void>
  ): Promise<void> {
    const predecessors = keys.map((key) => this.chains.get(key) ?? Promise.resolve());
    const next = Promise.all(predecessors).then(() =>
      Promise.resolve(op()).then(() => undefined)
    );
    const stored = next.catch(() => undefined);
    for (const key of keys) this.chains.set(key, stored);
    return next;
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
