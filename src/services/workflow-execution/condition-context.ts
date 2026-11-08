// Feature 088 (T010, T011) — everything a Workflow condition may read.
//
// The context is the entire readable surface of evaluation: a condition cannot
// reach a fact this module does not hold, so the contract it implements
// (specs/088-workflow-continuation/contracts/condition-context.md) is enforced
// by what is absent as much as by what is here.
//
// Two things are readable and nothing else (FR-021, FR-022):
//
//   1. the declared structured outputs of a node whose attempt **completed** —
//      as recorded, which is to say a workspace-relative location reference,
//      never the content behind it;
//   2. one run-metadata member, `status`, addressed through `node-status`.
//
// Timestamps are deliberately absent: feature 083's operand set has exactly two
// sources and neither names one, so a timestamp here would be a value nothing
// can read — the kind of dead surface a later contributor half-wires into an
// operand. Adding a member is a contract change (FR-022).
//
// No `fs`, no `vscode`, no I/O of any kind. The unit suite scans this file for
// all three, so the property is checked rather than asserted.

import type {
  WorkflowConditionLiteral,
  WorkflowConditionOperand,
  WorkflowNodeTerminalStatus
} from '../../contracts/workflow-definitions';
import type {
  AttemptOutcomeStatus,
  Primitive,
  TypedOperand
} from '../../contracts/decision-results';
import type { RunOutputRecord } from '../../contracts/run-results';
import type {
  NodeAttemptRecord,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';

/**
 * The closed run-metadata set (FR-022). One member, because `node-status` is the
 * only operand source that addresses metadata at all.
 */
export const CONDITION_CONTEXT_RUN_METADATA = ['status'] as const;

/**
 * One node's contribution to the context: the facts of exactly one attempt.
 *
 * *Which* attempt is the caller's decision — the node being routed contributes
 * the attempt whose completion is being routed on, and every other node
 * contributes its latest terminal attempt. The builder refuses two entries for
 * the same node, so values can never silently mix across attempts (FR-037).
 */
export interface NodeAttemptFacts {
  readonly nodeId: string;
  readonly status: WorkflowNodeTerminalStatus;
  /** As recorded by the child run: location references, never file contents. */
  readonly outputs: readonly RunOutputRecord[];
  /** Optional normalized `AttemptOutcome.status` for `TypedCondition` (`node-status` / `node-result`). */
  readonly outcomeStatus?: AttemptOutcomeStatus;
  /** Optional validated `AttemptOutcome.values` readable via `node-result` when attempt status is `done`/`completed`. */
  readonly results?: Readonly<Record<string, Primitive>>;
}

export interface ConditionContext {
  readonly nodes: Readonly<Record<string, NodeAttemptFacts>>;
  /** Optional map of `nodeId -> validated decision result fields` populated only for `done` attempts. */
  readonly results?: Readonly<Record<string, Readonly<Record<string, Primitive>>>>;
  /** Optional local result fields for `result-field` operands inside `ResultContract.completion`. */
  readonly localResults?: Readonly<Record<string, Primitive>>;
}

/**
 * What one operand resolved to. `value` is present only when `resolved`, and is
 * always a comparison literal — never an object a condition could traverse.
 */
export interface OperandLookup {
  readonly resolved: boolean;
  readonly value?: WorkflowConditionLiteral;
  /** True when the target result map exists and is valid (`done`), even if the specific field is absent. */
  readonly containerResolved?: boolean;
}

const UNRESOLVED: OperandLookup = Object.freeze({ resolved: false });

export class ConditionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionContextError';
  }
}

/**
 * Index one attempt per node.
 *
 * A duplicate `nodeId` is a caller defect rather than an operator-facing
 * outcome: it means two attempts of the same node were about to be readable at
 * once, which is exactly the mixing FR-037 forbids, and silently keeping one of
 * them would decide a branch on a value nobody chose.
 */
export function buildConditionContext(
  facts: readonly NodeAttemptFacts[],
  options?: {
    readonly results?: Readonly<Record<string, Readonly<Record<string, Primitive>>>>;
    readonly localResults?: Readonly<Record<string, Primitive>>;
  }
): ConditionContext {
  const nodes: Record<string, NodeAttemptFacts> = {};
  for (const fact of facts) {
    if (Object.hasOwn(nodes, fact.nodeId)) {
      throw new ConditionContextError(
        `condition context received two attempts for node ${fact.nodeId}`
      );
    }
    nodes[fact.nodeId] = {
      nodeId: fact.nodeId,
      status: fact.status,
      outputs: fact.outputs,
      ...(fact.outcomeStatus !== undefined ? { outcomeStatus: fact.outcomeStatus } : {}),
      ...(fact.results !== undefined ? { results: fact.results } : {})
    };
  }
  return {
    nodes,
    ...(options?.results !== undefined ? { results: options.results } : {}),
    ...(options?.localResults !== undefined ? { localResults: options.localResults } : {})
  };
}

/**
 * Resolve one operand against the context (FR-021, FR-022, FR-R5-F24 D2).
 *
 * Nothing raises and nothing coerces: an operand that names a node with no
 * recorded attempt, an output that was never declared, an output the run did not
 * produce, or any output/result of an attempt that did not complete (`done`), all
 * answer unresolved.
 */
export function resolveOperand(
  operand: WorkflowConditionOperand | TypedOperand,
  context: ConditionContext
): OperandLookup {
  if (operand.source === 'result-field') {
    if (context.localResults === undefined) return UNRESOLVED;
    if (!Object.hasOwn(context.localResults, operand.fieldId)) {
      return { resolved: false, containerResolved: true };
    }
    return { resolved: true, value: context.localResults[operand.fieldId], containerResolved: true };
  }

  // Own properties only: a node id such as `constructor` also names an inherited
  // member of every object, and a node that never ran must stay unresolved.
  const facts = Object.hasOwn(context.nodes, operand.nodeId)
    ? context.nodes[operand.nodeId]
    : undefined;
  if (facts === undefined) return UNRESOLVED;
  if (operand.source === 'node-status') {
    return { resolved: true, value: facts.outcomeStatus ?? facts.status };
  }

  if (operand.source === 'node-result') {
    const attemptDone =
      facts.status === 'completed' &&
      (facts.outcomeStatus === undefined || facts.outcomeStatus === 'done');
    if (!attemptDone) return UNRESOLVED;
    const fromTop =
      context.results !== undefined && Object.hasOwn(context.results, operand.nodeId)
        ? context.results[operand.nodeId]
        : undefined;
    const resultMap = fromTop ?? facts.results;
    if (resultMap === undefined) return UNRESOLVED;
    if (!Object.hasOwn(resultMap, operand.fieldId)) {
      return { resolved: false, containerResolved: true };
    }
    return { resolved: true, value: resultMap[operand.fieldId], containerResolved: true };
  }

  // Outputs of an attempt that did not complete are not readable. Its status
  // still is — routing on a failure is the point of FR-050.
  if (facts.status !== 'completed') return UNRESOLVED;
  const record = facts.outputs.find((output) => output.name === operand.field);
  if (record === undefined || record.status !== 'resolved') return UNRESOLVED;
  if (record.reference === undefined) return UNRESOLVED;
  return { resolved: true, value: record.reference };
}

function attemptRecordToFacts(attempt: NodeAttemptRecord): NodeAttemptFacts | null {
  if (
    attempt.status === 'in-flight' ||
    attempt.status === 'paused' ||
    attempt.status === 'pending-dispatch'
  ) {
    return null;
  }
  const outputs: RunOutputRecord[] = Object.entries(attempt.declaredOutputs).map(
    ([name, portVal]) => ({
      name,
      status: 'resolved',
      reference: portVal.value
    })
  );
  return {
    nodeId: attempt.nodeId,
    status: attempt.status,
    ...(attempt.outcomeStatus !== undefined ? { outcomeStatus: attempt.outcomeStatus } : {}),
    outputs,
    ...(attempt.decisionResults !== undefined ? { results: attempt.decisionResults } : {})
  };
}

/**
 * FR-R5-F02 — build a `ConditionContext` scoped strictly to the terminal
 * attempts recorded in `frame`. Sibling or parent invocation frames are never
 * included.
 */
export function buildInvocationConditionContext(
  frame: WorkflowInvocationFrame,
  routingAttempt?: NodeAttemptRecord
): ConditionContext {
  const factsList: NodeAttemptFacts[] = [];
  for (const [nodeId, attempts] of Object.entries(frame.attemptsByNodeId)) {
    if (routingAttempt !== undefined && routingAttempt.nodeId === nodeId) {
      const facts = attemptRecordToFacts(routingAttempt);
      if (facts !== null) factsList.push(facts);
      continue;
    }
    for (let idx = attempts.length - 1; idx >= 0; idx -= 1) {
      const candidate = attempts[idx];
      if (candidate === undefined) continue;
      const facts = attemptRecordToFacts(candidate);
      if (facts !== null) {
        factsList.push(facts);
        break;
      }
    }
  }
  if (
    routingAttempt !== undefined &&
    !Object.hasOwn(frame.attemptsByNodeId, routingAttempt.nodeId)
  ) {
    const facts = attemptRecordToFacts(routingAttempt);
    if (facts !== null) factsList.push(facts);
  }
  return buildConditionContext(factsList);
}
