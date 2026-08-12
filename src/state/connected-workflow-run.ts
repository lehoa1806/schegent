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

import type { WorkflowDefinition } from '../contracts/workflow-definitions';
import { DEFAULT_QUEUE_ID } from '../queue/queue-registry';
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
  readonly source: 'node-output' | 'node-status';
  readonly nodeId: string;
  /** Present for `node-output` only; names a declared output, never a path into one. */
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
}

export class ConnectedRunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectedRunInvariantError';
  }
}

const AGGREGATE_KEYS: readonly string[] = [
  'connectedRunId',
  'decisions',
  'graph',
  'nodes',
  'pipelines',
  'queueId',
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
    ...(input.queueId !== undefined ? { queueId: input.queueId } : {})
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

/** Append one routing decision. Decisions are chronological and never rewritten. */
export function appendDecision(
  run: ConnectedWorkflowRun,
  decision: RoutingDecision
): ConnectedWorkflowRun {
  const frozen = deepFreeze(deepCopy(decision));
  const next: ConnectedWorkflowRun = {
    ...run,
    decisions: Object.freeze([...run.decisions, frozen]),
    revision: run.revision + 1
  };
  assertConnectedRunInvariants(next);
  return Object.freeze(next);
}
