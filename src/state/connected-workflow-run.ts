// Feature 088 (T001, T002, T004) — the connected-run aggregate.
//
// One record per connected Workflow run, stored under its own memento key
// (`KEYS.connectedRuns`). It is deliberately NOT a field on `WorkflowRun`:
// `WorkflowRun` describes one Pipeline execution and stays exactly what it was
// (FR-001), while this describes the graph above a set of such executions.
//
// The organizing rule is one sentence, and every field below obeys it:
// **a connected run stores decisions and references; it stores no lifecycle and
// no projection.** There is no `status`, no current phase, no log, and no output
// copy — those are readings of the child runs, and a stored copy would go stale
// the moment a child transitions (FR-002).
//
// No `vscode` import: this module is loaded by the headless evaluator, the
// migrator, and the sidebar projector alike.

import type {
  FrozenOutputRequest,
  FrozenSupplementalInput,
  FrozenWorkflowClosure,
  ResolvedPortValue
} from '../contracts/run-request';
import type {
  WorkflowDefinition,
  WorkflowNodeKind,
  WorkflowNodeTerminalStatus
} from '../contracts/workflow-definitions';
import {
  validateExecutionDecisionObservation,
  type ExecutionDecisionObservation
} from '../contracts/execution-decision-observation';
import {
  isValidConnectedRunControlLink,
  type ConnectedRunControlLink
} from '../contracts/control-ledger';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import type { WorkflowRunPipeline } from './workflow-run';

/**
 * How much of a compared value is recorded (FR-066). Long enough to identify
 * what the comparison saw, short enough that the record cannot become a copy of
 * the document behind an output reference. A longer value is recorded as
 * resolved with `compared` omitted rather than truncated, because a truncated
 * path or sentence still carries content.
 */
export const COMPARED_MAX_LENGTH = 64;

/** A reference to one child Pipeline Run. An identifier and a timestamp — nothing else. */
export interface ChildRunRef {
  readonly queueItemId: string;
  readonly startedAt: number;
}

/**
 * A node that has been started at least once. Absent from `nodes` until then.
 *
 * There is no `status` field. A node's status is its last attempt's child run
 * status, read from the child (FR-002).
 */
export interface ConnectedNodeRecord {
  readonly nodeId: string;
  /** Ordered, append-only (FR-002a). Never empty when the record exists. */
  readonly attempts: readonly ChildRunRef[];
}

/** What one referenced operand resolved to, and what the comparison saw. */
export interface OperandResolution {
  readonly source: 'node-output' | 'node-status' | 'node-result' | 'result-field';
  readonly nodeId: string;
  /** Present for `node-output`, `node-result`, or `result-field`; names a declared field/output. */
  readonly field?: string;
  readonly resolved: boolean;
  /** Capped rendering of the compared value; omitted when the value is longer. */
  readonly compared?: string;
}

/**
 * One outgoing connection's outcome. `index` is its position in the frozen
 * graph's `connections` array — positional addressing is correct here and only
 * here, because a connection carries no identifier of its own and the graph is
 * frozen, so the index cannot drift. It addresses a *connection*, never a node.
 */
export interface ConnectionOutcome {
  readonly index: number;
  readonly matched: boolean;
  readonly isDefault: boolean;
}

/** The bounded record of one evaluation (FR-030, FR-066). */
export interface RoutingDecision {
  readonly nodeId: string;
  readonly attemptIndex: number;
  readonly decidedAt: number;
  readonly operands: readonly OperandResolution[];
  readonly connections: readonly ConnectionOutcome[];
  /** True only when no explicit condition matched (FR-027). */
  readonly defaultApplied: boolean;
  /** Indices of the eligible connections, in offer order. */
  readonly eligible: readonly number[];
}

export type InvocationInputSource = 'launch' | 'binding' | 'manual-continuation';

/**
 * FR-R5-F02 — immutable node input record persisted before node dispatch.
 * Carries `acceptedAt` rather than `frozenAt` so continuation inputs remain
 * structurally distinct from the launch-time ExecutionEnvelope.
 */
export interface InvocationInputEnvelope {
  readonly envelopeId: string;
  readonly invocationId: string;
  readonly targetNodeId: string;
  readonly source: InvocationInputSource;
  readonly inputsByPort: Readonly<Record<string, ResolvedPortValue>>;
  readonly localInputs: readonly FrozenSupplementalInput[];
  readonly outputTargetOverrides: readonly FrozenOutputRequest[];
  readonly acceptedAt: number;
}

export type NodeAttemptStatus =
  | 'pending-dispatch'
  | 'in-flight'
  | 'paused'
  | WorkflowNodeTerminalStatus;

export type WorkflowPauseCause =
  | 'operator-pause'
  | 'credit-exhausted'
  | 'recovery-uncertain-effect'
  | 'spend-bound-exceeded';

export type WorkflowDelayedRetryCause =
  | 'transient-backoff'
  | 'rate-limit-backoff';

export type WorkflowControlOperation =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry-phase'
  | 'retry-invocation'
  | 'continue-handoff';

export const MAX_COMMAND_RECEIPTS = 64;
export const DEFAULT_MAX_PHASE_ATTEMPTS = 5;

/**
 * FR-R5-F03 — paired pause and delayed-retry markers on an invocation frame.
 * Rule 28 pairing invariants:
 *   - `(manualPauseAt === null) === (manualPauseCause === null)`
 *   - `(pendingRetryAt === null) === (pendingRetryCause === null)`
 *   - When paused or canceled, `pendingRetryAt === null && pendingRetryCause === null`.
 */
export interface InvocationControlMarkers {
  readonly manualPauseAt: number | null;
  readonly manualPauseCause: WorkflowPauseCause | null;
  readonly pendingRetryAt: number | null;
  readonly pendingRetryCause: WorkflowDelayedRetryCause | null;
  readonly delayedRetryCount: number;
  readonly spendUsd: number;
  readonly spendBoundUsd?: number;
  readonly maxPhaseAttempts?: number;
}

export const DEFAULT_INVOCATION_CONTROL_MARKERS: InvocationControlMarkers = Object.freeze({
  manualPauseAt: null,
  manualPauseCause: null,
  pendingRetryAt: null,
  pendingRetryCause: null,
  delayedRetryCount: 0,
  spendUsd: 0
});

export function pauseInvocationControlMarkers(
  markers: InvocationControlMarkers | undefined,
  pausedAt: number,
  pauseCause: WorkflowPauseCause
): InvocationControlMarkers {
  return Object.freeze({
    ...(markers ?? DEFAULT_INVOCATION_CONTROL_MARKERS),
    manualPauseAt: pausedAt,
    manualPauseCause: pauseCause,
    pendingRetryAt: null,
    pendingRetryCause: null
  });
}

export function clearInvocationControlMarkers(
  markers: InvocationControlMarkers | undefined
): InvocationControlMarkers {
  return Object.freeze({
    ...(markers ?? DEFAULT_INVOCATION_CONTROL_MARKERS),
    manualPauseAt: null,
    manualPauseCause: null,
    pendingRetryAt: null,
    pendingRetryCause: null
  });
}

/**
 * FR-R5-F02 — one execution attempt of a `phase` or child `workflow` node
 * within a specific `WorkflowInvocationFrame`.
 */
export interface NodeAttemptRecord {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly nodePath: string;
  readonly nodeId: string;
  readonly nodeKind: WorkflowNodeKind;
  readonly targetDefinitionId: string;
  readonly status: NodeAttemptStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly queueItemId?: string;
  readonly childInvocationId?: string;
  readonly inputEnvelope: InvocationInputEnvelope;
  readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly verdict?: 'pass' | 'fail' | null;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export interface PendingHandoffRecord {
  readonly invocationId: string;
  readonly fromNodeId: string;
  readonly fromAttemptId: string;
  readonly connectionIndex: number;
  readonly target:
    | { readonly kind: 'node'; readonly nodeId: string }
    | { readonly kind: 'return' };
  readonly prefilledInputsByPort: Readonly<Record<string, ResolvedPortValue>>;
  readonly pausedAt: number;
  /** FR-R5-F03 (T006) — persisted accepted continuation envelope prior to target dispatch. */
  readonly acceptedEnvelope?: InvocationInputEnvelope;
}

export type WorkflowInvocationStatus =
  | 'in-flight'
  | 'waiting-for-handoff'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface CommittedCommandReceipt {
  readonly commandId: string;
  readonly operation: WorkflowControlOperation;
  readonly targetInvocationId: string;
  readonly targetNodeId?: string;
  readonly committedRevision: number;
  readonly committedAt: number;
  readonly resultingRunStatus: WorkflowInvocationStatus;
  readonly resultingInvocationStatus: WorkflowInvocationStatus;
  readonly spawnedInvocationId?: string;
  readonly spawnedAttemptId?: string;
}

export type RecoveryDispositionStatus =
  | 'clean-handoff'
  | 'pending-dispatch-recovered'
  | 'settled-from-evidence'
  | 'uncertain-effect-paused'
  | 'orphaned-canceled';

export interface RecoveryDispositionRecord {
  readonly status: RecoveryDispositionStatus;
  readonly invocationId: string;
  readonly nodeId: string | null;
  readonly attemptId?: string;
  readonly reconciledAt: number;
  readonly reasonCode: string;
}

/**
 * FR-R5-F02 / FR-R5-F03 — mutable runtime occurrence state for one root or child
 * Workflow invocation, kept strictly separate from the immutable `FrozenWorkflowClosure`.
 */
export interface WorkflowInvocationFrame {
  readonly invocationId: string;
  readonly rootRunId: string;
  readonly parentInvocationId: string | null;
  readonly parentCallNodeId: string | null;
  readonly parentAttemptId: string | null;
  readonly workflowId: string;
  readonly depth: number;
  readonly nodePath: string;
  readonly entryNodeId: string;
  readonly activeNodeId: string | null;
  readonly status: WorkflowInvocationStatus;
  readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly resolvedOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly attemptsByNodeId: Readonly<Record<string, readonly NodeAttemptRecord[]>>;
  readonly decisions: readonly RoutingDecision[];
  readonly pendingHandoff?: PendingHandoffRecord | null;
  readonly controlMarkers?: InvocationControlMarkers;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
}

/**
 * What the operator attached when launching, for the whole run: instructions, supplemental
 * material and the targets of the root Workflow's public outputs, as validated at launch.
 *
 * A reference to frozen input, like `inputEnvelopes`, not lifecycle, so it does not breach the
 * organizing rule above. Every Phase attempt is built from it, including one started long
 * after the launcher returned, by a Retry or by startup recovery.
 */
export interface ConnectedRunLaunchContext {
  readonly supplemental: readonly FrozenSupplementalInput[];
  readonly outputs: readonly FrozenOutputRequest[];
  readonly instructions?: string;
}

export interface ConnectedWorkflowRun {
  readonly connectedRunId: string;
  readonly workflowId: string;
  /** Frozen at start (FR-003). Deep-copied, never aliased to the catalog. */
  readonly graph: WorkflowDefinition;
  /** Frozen at start (FR-004), keyed by `pipelineId`. */
  readonly pipelines: Readonly<Record<string, WorkflowRunPipeline>>;
  readonly nodes: Readonly<Record<string, ConnectedNodeRecord>>;
  readonly decisions: readonly RoutingDecision[];
  /** Monotonic; the compare-and-set token (FR-046). */
  readonly revision: number;
  readonly startedAt: number;
  /**
   * Feature 092 (T078, FR-041) — the queue every child of this run enqueues
   * into. Fixed when the run opens and never rewritten, which is why it sits on
   * the aggregate rather than on each attempt: a per-attempt copy could
   * disagree with itself mid-graph.
   *
   * This is a reference, not lifecycle, so it does not breach the organizing
   * rule above. Whether the queue is paused, draining or empty is read from the
   * queue; this field only says which one to read.
   *
   * Optional because a record written before this feature has none, and absence
   * is not a defect: it resolves to the default queue on read (FR-046) via
   * `resolveBoundQueueId()`, which is why no migration entry lifts it.
   */
  readonly queueId?: string;
  /** FR-R5-F02 — frozen transitive Workflow and Phase closure for nested execution. */
  readonly frozenClosure?: FrozenWorkflowClosure;
  /**
   * Absent when the launch attached nothing, and on a record written before this field: a
   * Phase attempt of such a run is built with no launch material, which is what it had.
   */
  readonly launchContext?: ConnectedRunLaunchContext;
  /** FR-R5-F02 — root and child invocation frames keyed by `invocationId`. */
  readonly invocations?: Readonly<Record<string, WorkflowInvocationFrame>>;
  /** FR-R5-F02 — immutable input envelopes persisted before node dispatch. */
  readonly inputEnvelopes?: readonly InvocationInputEnvelope[];
  /** FR-R5-F02 — active manual handoff pause record, if any. */
  readonly pendingHandoff?: PendingHandoffRecord | null;
  /** FR-R5-F03 — bounded ledger of committed control command receipts (<= 64). */
  readonly commandReceipts?: readonly CommittedCommandReceipt[];
  /** FR-R5-F03 — latest restart recovery reconciliation disposition, if any. */
  readonly recoveryDisposition?: RecoveryDispositionRecord | null;
  /** FR-R5-F23 (F23-T05, D1) — durable decision observation records for phase repetition and branch evaluation. */
  readonly decisionObservations?: readonly ExecutionDecisionObservation[];
  /** FR-R5-F26 (SPEC-04, D4) — link to the durable control ledger root (`{ version: 1, ledgerRunId }`). */
  readonly controlState?: ConnectedRunControlLink;
}

export class ConnectedRunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectedRunInvariantError';
  }
}

const AGGREGATE_KEYS: readonly string[] = [
  'commandReceipts',
  'connectedRunId',
  'controlState',
  'decisionObservations',
  'decisions',
  'frozenClosure',
  'graph',
  'inputEnvelopes',
  'invocations',
  'launchContext',
  'nodes',
  'pendingHandoff',
  'pipelines',
  'queueId',
  'recoveryDisposition',
  'revision',
  'startedAt',
  'workflowId'
];
const NODE_KEYS: readonly string[] = ['attempts', 'nodeId'];
const ATTEMPT_KEYS: readonly string[] = ['queueItemId', 'startedAt'];
const DECISION_KEYS: readonly string[] = [
  'attemptIndex',
  'connections',
  'decidedAt',
  'defaultApplied',
  'eligible',
  'nodeId',
  'operands'
];
const OPERAND_KEYS: readonly string[] = ['compared', 'field', 'nodeId', 'resolved', 'source'];
const OUTCOME_KEYS: readonly string[] = ['index', 'isDefault', 'matched'];

/** POSIX and Windows absolute forms. Workspace-relative references are the only legal shape. */
const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/;

function fail(message: string): never {
  throw new ConnectedRunInvariantError(message);
}

function assertKeys(value: object, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${what} carries an undeclared field: ${key}`);
  }
}

/**
 * Freeze in place, depth-first. Applied to the graph and Pipeline snapshots at
 * creation so a stray write is a `TypeError` at the moment it happens rather
 * than a run that quietly changed shape mid-flight (FR-005).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

/**
 * Copy structurally, dropping nothing and aliasing nothing. `structuredClone`
 * would refuse a frozen source's prototype-less corners in some hosts; a plain
 * recursive copy over JSON-shaped data is enough, and these are JSON-shaped by
 * construction — they are what the memento persists.
 */
function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepCopy) as unknown as T;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = deepCopy(nested);
  }
  return copy as T;
}

/**
 * The short rendering of a compared value (FR-066).
 *
 * Anything that is not a comparison literal renders as nothing: the record says
 * the operand resolved without saying what to, which is the correct answer for
 * a value the record is not allowed to hold.
 */
export function renderCompared(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  return value.length <= COMPARED_MAX_LENGTH ? value : undefined;
}

function assertOperand(operand: OperandResolution): void {
  assertKeys(operand, OPERAND_KEYS, 'operand resolution');
  if (operand.source === 'node-status' && operand.field !== undefined) {
    fail('a node-status operand has no field');
  }
  if (operand.compared === undefined) return;
  if (operand.compared.length > COMPARED_MAX_LENGTH) {
    fail(`compared value exceeds ${COMPARED_MAX_LENGTH} characters`);
  }
  if (ABSOLUTE_PATH.test(operand.compared)) fail('compared value looks like an absolute path');
}

function assertDecision(decision: RoutingDecision, run: ConnectedWorkflowRun): void {
  assertKeys(decision, DECISION_KEYS, 'routing decision');
  const attempts = run.nodes[decision.nodeId]?.attempts;
  if (attempts === undefined) fail(`decision references an unstarted node: ${decision.nodeId}`);
  if (decision.attemptIndex < 0 || decision.attemptIndex >= attempts.length) {
    fail(`decision references attempt ${decision.attemptIndex}, which does not exist`);
  }
  const connectionCount = run.graph.connections.length;
  for (const outcome of decision.connections) {
    assertKeys(outcome, OUTCOME_KEYS, 'connection outcome');
    if (outcome.index < 0 || outcome.index >= connectionCount) {
      fail(`decision names connection ${outcome.index}, which the frozen graph does not have`);
    }
  }
  const named = new Set(decision.connections.map((outcome) => outcome.index));
  for (const index of decision.eligible) {
    if (!named.has(index)) fail(`eligible connection ${index} has no recorded outcome`);
  }
  if (decision.defaultApplied) {
    const explicitMatched = decision.connections.some(
      (outcome) => outcome.matched && !outcome.isDefault
    );
    // FR-027 reads "only when no explicit condition matched". A decision that
    // records both is not a preference conflict to resolve later — it is two
    // incompatible claims about the same evaluation.
    if (explicitMatched) fail('defaultApplied is set while an explicit condition matched');
  }
  decision.operands.forEach(assertOperand);
}

/**
 * Feature 092 (T079, FR-046) — the queue this run's children enqueue into.
 *
 * The default is applied HERE, on read, and nowhere else. A migration entry
 * would have to write a queue id into every pre-092 record, and the id it wrote
 * would be a guess: the reserved default is where those runs' children already
 * are, so reading it back is exact where writing it would be an assumption
 * persisted as fact (plan D7).
 */
export function resolveBoundQueueId(run: ConnectedWorkflowRun): string {
  return run.queueId ?? DEFAULT_QUEUE_ID;
}

/**
 * What a caller can tell the invariants that the record cannot tell them.
 *
 * The queue registry is the one such thing, and it is optional on purpose. The
 * aggregate module holds no registry and must not import one — it is loaded by
 * the migrator, which reads a memento and has no registry to hand. So a caller
 * that HAS the registry gets the containment check, and one that does not gets
 * the shape checks and nothing weaker for either.
 */
export interface ConnectedRunInvariantOptions {
  readonly knownQueueIds?: ReadonlySet<string>;
}

/**
 * Every invariant that can be checked from the record alone, at every write.
 *
 * Invariant 3 — at most one non-terminal child — is deliberately absent: it is
 * checked against the child runs' live statuses by the launcher gate, because
 * the aggregate stores no status to check it against.
 */
export function assertConnectedRunInvariants(
  run: ConnectedWorkflowRun,
  options: ConnectedRunInvariantOptions = {}
): void {
  assertKeys(run, AGGREGATE_KEYS, 'connected run');
  if (!Number.isInteger(run.revision) || run.revision < 1) {
    fail(`revision must be a positive integer, not ${String(run.revision)}`);
  }
  if (run.queueId !== undefined) {
    if (typeof run.queueId !== 'string' || run.queueId.length === 0) {
      fail(`queueId must be a non-empty string, not ${String(run.queueId)}`);
    }
    // FR-045. Present means bound, and a binding that names nothing is not a
    // weaker binding — it is a run whose children have nowhere to go.
    if (options.knownQueueIds !== undefined && !options.knownQueueIds.has(run.queueId)) {
      fail(`queueId names no queue in the registry: ${run.queueId}`);
    }
  }
  if (!Object.isFrozen(run.graph) || !Object.isFrozen(run.pipelines)) {
    fail('the graph and Pipeline snapshots must be frozen');
  }
  if (run.frozenClosure !== undefined) {
    if (
      !Object.isFrozen(run.frozenClosure) ||
      !Object.isFrozen(run.frozenClosure.workflowsById) ||
      !Object.isFrozen(run.frozenClosure.phasesById)
    ) {
      fail('the frozenWorkflowClosure must be frozen');
    }
  }
  if (run.invocations !== undefined) {
    if (!Object.isFrozen(run.invocations)) {
      fail('the invocations map must be frozen');
    }
    for (const [invId, frame] of Object.entries(run.invocations)) {
      if (frame.invocationId !== invId) {
        fail(`invocation frame ${invId} disagrees with its key`);
      }
      if (frame.controlMarkers !== undefined) {
        assertInvocationControlMarkers(frame);
      }
      for (const attempts of Object.values(frame.attemptsByNodeId)) {
        for (const attempt of attempts) {
          if (attempt.status === 'pending-dispatch') {
            if (attempt.completedAt !== undefined) {
              fail(
                `pending-dispatch attempt ${attempt.attemptId} in invocation ${invId} must not set completedAt`
              );
            }
            if (attempt.queueItemId !== undefined) {
              fail(
                `pending-dispatch attempt ${attempt.attemptId} in invocation ${invId} must not bind queueItemId`
              );
            }
          }
        }
      }
    }
  }
  if (run.inputEnvelopes !== undefined && !Object.isFrozen(run.inputEnvelopes)) {
    fail('the inputEnvelopes list must be frozen');
  }
  if (run.launchContext !== undefined && !Object.isFrozen(run.launchContext)) {
    fail('the launchContext must be frozen');
  }
  if (run.commandReceipts !== undefined) {
    if (!Object.isFrozen(run.commandReceipts)) {
      fail('the commandReceipts list must be frozen');
    }
    if (run.commandReceipts.length > MAX_COMMAND_RECEIPTS) {
      fail(`commandReceipts exceeds ${MAX_COMMAND_RECEIPTS} entries`);
    }
  }
  if (run.decisionObservations !== undefined) {
    if (!Object.isFrozen(run.decisionObservations)) fail('the decisionObservations list must be frozen');
    for (const obs of run.decisionObservations) {
      const checked = validateExecutionDecisionObservation(obs);
      if (!checked.valid) fail(`invalid decisionObservation: ${checked.errors[0]?.message ?? 'invalid shape'}`);
    }
  }
  if (run.controlState !== undefined) {
    if (!Object.isFrozen(run.controlState)) {
      fail('the controlState link must be frozen');
    }
    assertKeys(run.controlState, ['version', 'ledgerRunId'], 'controlState link');
    if (!isValidConnectedRunControlLink(run.controlState)) {
      fail('controlState must have version 1 and a non-empty string ledgerRunId');
    }
  }
  const nodeIds = new Set(run.graph.nodes.map((node) => node.nodeId));
  for (const [key, record] of Object.entries(run.nodes)) {
    assertKeys(record, NODE_KEYS, 'node record');
    if (record.nodeId !== key) fail(`node record ${key} disagrees with its key`);
    if (!nodeIds.has(key)) fail(`node record ${key} is not in the frozen graph`);
    if (record.attempts.length === 0) fail(`node record ${key} has no attempts`);
    record.attempts.forEach((attempt) => assertKeys(attempt, ATTEMPT_KEYS, 'attempt'));
  }
  run.decisions.forEach((decision) => assertDecision(decision, run));
}

export function assertInvocationControlMarkers(frame: WorkflowInvocationFrame): void {
  const markers = frame.controlMarkers;
  if (markers === undefined) return;
  const pauseTimeNull = markers.manualPauseAt === null;
  const pauseCauseNull = markers.manualPauseCause === null;
  if (pauseTimeNull !== pauseCauseNull) {
    fail(
      `invocation ${frame.invocationId} violates paired manualPauseAt/manualPauseCause invariant`
    );
  }
  const retryTimeNull = markers.pendingRetryAt === null;
  const retryCauseNull = markers.pendingRetryCause === null;
  if (retryTimeNull !== retryCauseNull) {
    fail(
      `invocation ${frame.invocationId} violates paired pendingRetryAt/pendingRetryCause invariant`
    );
  }
  if (frame.status === 'paused') {
    if (markers.manualPauseAt === null || markers.manualPauseCause === null) {
      fail(`paused invocation ${frame.invocationId} is missing manualPauseAt/manualPauseCause`);
    }
    if (markers.pendingRetryAt !== null || markers.pendingRetryCause !== null) {
      fail(`paused invocation ${frame.invocationId} must clear pendingRetryAt/pendingRetryCause`);
    }
  }
  if (frame.status === 'canceled' || frame.status === 'completed') {
    if (markers.pendingRetryAt !== null || markers.pendingRetryCause !== null) {
      fail(
        `terminal invocation ${frame.invocationId} must clear pendingRetryAt/pendingRetryCause`
      );
    }
  }
}

export interface CreateConnectedRunInput {
  readonly connectedRunId: string;
  readonly workflowId: string;
  readonly graph: WorkflowDefinition;
  readonly pipelines: Readonly<Record<string, WorkflowRunPipeline>>;
  readonly startedAt: number;
  /**
   * Feature 092 (T078, FR-041) — supplied at start or not at all. There is no
   * rebind: the only constructor that sets it is this one, and every subsequent
   * update spreads the existing record, so the binding a run opens with is the
   * binding it keeps.
   */
  readonly queueId?: string;
  readonly frozenClosure?: FrozenWorkflowClosure;
  readonly launchContext?: ConnectedRunLaunchContext;
  readonly invocations?: Readonly<Record<string, WorkflowInvocationFrame>>;
  readonly inputEnvelopes?: readonly InvocationInputEnvelope[];
  readonly commandReceipts?: readonly CommittedCommandReceipt[];
  readonly recoveryDisposition?: RecoveryDispositionRecord | null;
  readonly controlState?: ConnectedRunControlLink;
}

/** Freeze the snapshot and open the aggregate at revision 1. */
export function createConnectedRun(input: CreateConnectedRunInput): ConnectedWorkflowRun {
  const run: ConnectedWorkflowRun = {
    connectedRunId: input.connectedRunId,
    workflowId: input.workflowId,
    graph: deepFreeze(deepCopy(input.graph)),
    pipelines: deepFreeze(deepCopy(input.pipelines)),
    nodes: Object.freeze({}),
    decisions: Object.freeze([]),
    revision: 1,
    startedAt: input.startedAt,
    ...(input.queueId !== undefined ? { queueId: input.queueId } : {}),
    ...(input.frozenClosure !== undefined
      ? { frozenClosure: deepFreeze(deepCopy(input.frozenClosure)) }
      : {}),
    ...(input.launchContext !== undefined
      ? { launchContext: deepFreeze(deepCopy(input.launchContext)) }
      : {}),
    ...(input.invocations !== undefined
      ? { invocations: deepFreeze(deepCopy(input.invocations)) }
      : {}),
    ...(input.inputEnvelopes !== undefined
      ? { inputEnvelopes: deepFreeze(deepCopy(input.inputEnvelopes)) }
      : {}),
    ...(input.commandReceipts !== undefined
      ? { commandReceipts: deepFreeze(deepCopy(input.commandReceipts)) }
      : {}),
    ...(input.recoveryDisposition !== undefined
      ? { recoveryDisposition: deepFreeze(deepCopy(input.recoveryDisposition)) }
      : {}),
    ...(input.controlState !== undefined
      ? { controlState: deepFreeze(deepCopy(input.controlState)) }
      : {})
  };
  assertConnectedRunInvariants(run);
  return Object.freeze(run);
}

/** Append one attempt to a node, creating its record on the first. */
export function appendAttempt(
  run: ConnectedWorkflowRun,
  nodeId: string,
  attempt: ChildRunRef
): ConnectedWorkflowRun {
  const existing = run.nodes[nodeId];
  const record: ConnectedNodeRecord = Object.freeze({
    nodeId,
    attempts: Object.freeze([...(existing?.attempts ?? []), Object.freeze({ ...attempt })])
  });
  const next: ConnectedWorkflowRun = {
    ...run,
    nodes: Object.freeze({ ...run.nodes, [nodeId]: record }),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

/** Append one routing decision (and optional `ExecutionDecisionObservation`). Decisions are chronological and never rewritten. */
export function appendDecision(
  run: ConnectedWorkflowRun,
  decision: RoutingDecision,
  observation?: ExecutionDecisionObservation
): ConnectedWorkflowRun {
  const frozen = deepFreeze(deepCopy(decision));
  const frozenObs = observation !== undefined ? deepFreeze(deepCopy(observation)) : undefined;
  const next: ConnectedWorkflowRun = {
    ...run,
    decisions: Object.freeze([...run.decisions, frozen]),
    ...(frozenObs !== undefined
      ? { decisionObservations: Object.freeze([...(run.decisionObservations ?? []), frozenObs]) }
      : {}),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

/** Append one `ExecutionDecisionObservation` record to `run.decisionObservations`. */
export function appendDecisionObservation(
  run: ConnectedWorkflowRun,
  observation: ExecutionDecisionObservation
): ConnectedWorkflowRun {
  const frozenObs = deepFreeze(deepCopy(observation));
  const next: ConnectedWorkflowRun = {
    ...run,
    decisionObservations: Object.freeze([...(run.decisionObservations ?? []), frozenObs]),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

/**
 * FR-R5-F02 — derive the hierarchical occurrence `nodePath` (`/<nodeId>` for root
 * steps and `/<parentCallNodeId>/<childNodeId>` for nested child invocations).
 */
export function deriveNodePath(parentNodePath: string, nodeId: string): string {
  const trimmed = parentNodePath.trim();
  if (trimmed === '' || trimmed === '/') {
    return `/${nodeId}`;
  }
  const normalized = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  return `${normalized}/${nodeId}`;
}

export interface CreateInvocationFrameInput {
  readonly invocationId: string;
  readonly rootRunId: string;
  readonly parentInvocationId: string | null;
  readonly parentCallNodeId: string | null;
  readonly parentAttemptId: string | null;
  readonly workflowId: string;
  readonly depth: number;
  readonly nodePath: string;
  readonly entryNodeId: string;
  readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly startedAt: number;
  readonly controlMarkers?: InvocationControlMarkers;
}

export function createInvocationFrame(input: CreateInvocationFrameInput): WorkflowInvocationFrame {
  const controlMarkers: InvocationControlMarkers =
    input.controlMarkers ?? DEFAULT_INVOCATION_CONTROL_MARKERS;
  return deepFreeze(
    deepCopy({
      invocationId: input.invocationId,
      rootRunId: input.rootRunId,
      parentInvocationId: input.parentInvocationId,
      parentCallNodeId: input.parentCallNodeId,
      parentAttemptId: input.parentAttemptId,
      workflowId: input.workflowId,
      depth: input.depth,
      nodePath: input.nodePath,
      entryNodeId: input.entryNodeId,
      activeNodeId: input.entryNodeId,
      status: 'in-flight',
      boundInputs: input.boundInputs,
      resolvedOutputs: {},
      attemptsByNodeId: {},
      decisions: [],
      pendingHandoff: null,
      controlMarkers,
      startedAt: input.startedAt
    })
  );
}

/**
 * The attempts recorded for one node of an invocation frame, oldest first; empty for a node
 * that has not been entered, or for no frame at all.
 *
 * An own-property read, not `frame.attemptsByNodeId[nodeId] ?? []`. The record is keyed by an
 * author-chosen node id, and the id grammar admits `constructor`, which a plain index read finds
 * on `Object.prototype` for every node that has not run. `?? []` never fires on a function, so
 * the node's first attempt was numbered 2 and recording it threw once its Phase was enqueued.
 */
export function attemptsForNode(
  frame: WorkflowInvocationFrame | undefined,
  nodeId: string
): readonly NodeAttemptRecord[] {
  if (frame === undefined || !Object.hasOwn(frame.attemptsByNodeId, nodeId)) return [];
  return frame.attemptsByNodeId[nodeId] ?? [];
}

/**
 * Whether an attempt of this run started the queue row: on a legacy node record or on any
 * invocation frame, since a composable run records its attempts on its frames alone.
 */
export function connectedRunOwnsQueueItem(run: ConnectedWorkflowRun, queueItemId: string): boolean {
  const started = (attempts: readonly { readonly queueItemId?: string | null }[]): boolean =>
    attempts.some((attempt) => attempt.queueItemId === queueItemId);
  if (Object.values(run.nodes).some((node) => started(node.attempts))) return true;
  return Object.values(run.invocations ?? {}).some((frame) =>
    Object.values(frame.attemptsByNodeId).some(started)
  );
}

/**
 * Whether a Workflow attempt started this queue row and has since ended. Nothing awaits such a row:
 * starting it again would repeat the Phase's effects for a result no attempt would record.
 */
export function workflowAttemptEndedForQueueItem(
  run: ConnectedWorkflowRun,
  queueItemId: string
): boolean {
  return Object.values(run.invocations ?? {}).some((frame) =>
    Object.values(frame.attemptsByNodeId).some((attempts) =>
      attempts.some(
        (attempt) =>
          attempt.queueItemId === queueItemId &&
          attempt.status !== 'in-flight' &&
          attempt.status !== 'pending-dispatch'
      )
    )
  );
}

/** The queue rows of this run's failed Phase attempts, on every invocation frame. */
export function failedPhaseQueueItemIds(run: ConnectedWorkflowRun): readonly string[] {
  return Object.values(run.invocations ?? {}).flatMap((frame) =>
    Object.values(frame.attemptsByNodeId).flatMap((attempts) =>
      attempts.flatMap((attempt) =>
        attempt.nodeKind === 'phase' && attempt.status === 'failed' && attempt.queueItemId !== undefined
          ? [attempt.queueItemId]
          : []
      )
    )
  );
}

export function recordNodeAttempt(
  frame: WorkflowInvocationFrame,
  attempt: NodeAttemptRecord
): WorkflowInvocationFrame {
  const existing = attemptsForNode(frame, attempt.nodeId);
  const updatedForNode = existing.some((entry) => entry.attemptId === attempt.attemptId)
    ? existing.map((entry) => (entry.attemptId === attempt.attemptId ? attempt : entry))
    : [...existing, attempt];
  return deepFreeze(
    deepCopy({
      ...frame,
      activeNodeId: attempt.nodeId,
      attemptsByNodeId: {
        ...frame.attemptsByNodeId,
        [attempt.nodeId]: updatedForNode
      }
    })
  );
}

export function upsertInvocationFrame(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): ConnectedWorkflowRun {
  const frozenFrame = deepFreeze(deepCopy(frame));
  const next: ConnectedWorkflowRun = {
    ...run,
    invocations: Object.freeze({
      ...(run.invocations ?? {}),
      [frozenFrame.invocationId]: frozenFrame
    }),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

export function appendInputEnvelope(
  run: ConnectedWorkflowRun,
  envelope: InvocationInputEnvelope
): ConnectedWorkflowRun {
  const frozenEnvelope = deepFreeze(deepCopy(envelope));
  const next: ConnectedWorkflowRun = {
    ...run,
    inputEnvelopes: Object.freeze([...(run.inputEnvelopes ?? []), frozenEnvelope]),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

export function setPendingHandoff(
  run: ConnectedWorkflowRun,
  handoff: PendingHandoffRecord | null
): ConnectedWorkflowRun {
  const frozenHandoff = handoff === null ? null : deepFreeze(deepCopy(handoff));
  const next: ConnectedWorkflowRun = {
    ...run,
    pendingHandoff: frozenHandoff,
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

export function appendCommandReceipt(
  run: ConnectedWorkflowRun,
  receipt: CommittedCommandReceipt
): ConnectedWorkflowRun {
  const frozenReceipt = deepFreeze(deepCopy(receipt));
  const existing = run.commandReceipts ?? [];
  const trimmed =
    existing.length >= MAX_COMMAND_RECEIPTS
      ? existing.slice(existing.length - MAX_COMMAND_RECEIPTS + 1)
      : existing;
  const next: ConnectedWorkflowRun = {
    ...run,
    commandReceipts: Object.freeze([...trimmed, frozenReceipt]),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

export function setRecoveryDisposition(
  run: ConnectedWorkflowRun,
  disposition: RecoveryDispositionRecord | null
): ConnectedWorkflowRun {
  const frozenDisposition = disposition === null ? null : deepFreeze(deepCopy(disposition));
  const next: ConnectedWorkflowRun = {
    ...run,
    recoveryDisposition: frozenDisposition,
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}

export function resolveRootInvocationId(run: ConnectedWorkflowRun): string {
  const invocations = run.invocations ?? {};
  for (const frame of Object.values(invocations)) {
    if (frame.parentInvocationId === null) {
      return frame.invocationId;
    }
  }
  return `${run.connectedRunId}:root`;
}
