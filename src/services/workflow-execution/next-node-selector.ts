// Feature 088 (T015-T018) — which successors become eligible when a node's
// attempt reaches a terminal state.
//
// The selector *offers*; it never starts (FR-032). It reads the frozen graph and
// an already-built condition context and returns one `RoutingDecision` — the
// bounded record that makes "why was this branch not offered" answerable from
// the persisted run alone (FR-030, FR-066). Starting a node, persisting the
// decision, and asking the operator to choose are all somebody else's job.
//
// Four rules, in the order they apply:
//
//   1. every connection leaving the node is evaluated — a match is preserved as
//      a choice rather than resolved by picking one (FR-026);
//   2. the default connection is considered last, and applied only when nothing
//      explicit matched — and then only if its own condition matches (FR-027);
//   3. nothing matching and no default is an empty offer, which the caller reads
//      as a completed branch, not a failed one (FR-028) — this module reports
//      that state and does not interpret it;
//   4. the offer is ordered ascending by `priority`, ties broken by authored
//      order (FR-029).
//
// No I/O, no host import: the graph and the context are the whole input.

import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowHandoffMode,
  WorkflowNodeTerminalStatus
} from '../../contracts/workflow-definitions';
import type { RetryCapOutcome } from '../../contracts/process-definitions';
import {
  EXECUTION_DECISION_OBSERVATION_VERSION,
  formatConditionSummary,
  type ExecutionBranchDisposition,
  type ExecutionDecisionBranchRecord,
  type ExecutionDecisionExitReason,
  type ExecutionDecisionObservation,
  type ExecutionDecisionSettingSources
} from '../../contracts/execution-decision-observation';
import type {
  ConnectionOutcome,
  OperandResolution,
  RoutingDecision
} from '../../state/connected-workflow-run';
import { isTypedCondition, isTypedLeafTest } from '../../contracts/decision-results';
import { evaluateCondition, evaluateTypedCondition } from './condition-evaluator';
import { resolveOperand, type ConditionContext } from './condition-context';

export interface SelectNextNodesInput {
  readonly graph: WorkflowDefinition;
  /** The node whose attempt just reached a terminal state. */
  readonly nodeId: string;
  readonly attemptIndex: number;
  readonly decidedAt: number;
  readonly context: ConditionContext;
}

/**
 * An unprioritized connection sorts after every explicit priority.
 *
 * The contract says "ascending evaluation order, then authored order for ties"
 * and leaves an absent `priority` undefined. Reading it as `0` would put an
 * unmarked connection ahead of one the operator explicitly marked `priority: 1`,
 * which inverts what marking it meant; reading it as "last" leaves a fully
 * unprioritized node in pure authored order, which is what an operator who never
 * touched the field sees today.
 */
const UNPRIORITIZED = Number.POSITIVE_INFINITY;

interface Candidate {
  /** Position in the frozen graph's `connections` array (FR-044). */
  readonly index: number;
  readonly connection: WorkflowConnection;
}

/**
 * A candidate that has been evaluated: whether it matched, and the operand
 * resolution that decided it (absent for an unconditional connection, which
 * matches without reading anything).
 */
interface Evaluated extends Candidate {
  readonly matched: boolean;
  readonly typedUnresolved: boolean;
  readonly operands: readonly OperandResolution[];
}

/**
 * `recoveryOnly` is set when the node's attempt did not complete. A connection
 * with no condition is the success path, so it matches nothing then: only a
 * connection the author gated with a condition can route past a failed or
 * canceled attempt.
 */
function evaluate(
  candidate: Candidate,
  context: ConditionContext,
  recoveryOnly: boolean
): Evaluated {
  const { condition } = candidate.connection;
  if (condition === undefined) {
    return { ...candidate, matched: !recoveryOnly, typedUnresolved: false, operands: [] };
  }
  if (isTypedCondition(condition)) {
    const typedEval = evaluateTypedCondition(condition, context);
    return {
      ...candidate,
      matched: typedEval.result === true,
      typedUnresolved: typedEval.result === 'unresolved',
      operands: typedEval.operands
    };
  }
  const evaluation = evaluateCondition(condition, context);
  return {
    ...candidate,
    matched: evaluation.matched,
    typedUnresolved: false,
    operands: evaluation.operands
  };
}

/** Ascending priority, then authored order (FR-029). */
function byOfferOrder(left: Evaluated, right: Evaluated): number {
  const leftPriority = left.connection.priority ?? UNPRIORITIZED;
  const rightPriority = right.connection.priority ?? UNPRIORITIZED;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.index - right.index;
}

function offerOrder(evaluated: readonly Evaluated[]): readonly number[] {
  return [...evaluated].sort(byOfferOrder).map((candidate) => candidate.index);
}

/**
 * Decide which connections leaving `nodeId` are eligible (FR-026 - FR-030).
 *
 * Total: no input shape raises. An unknown node, a node with no outgoing
 * connections, and a node whose every condition is unresolvable all produce an
 * empty offer with the evaluation recorded.
 */
export function selectNextNodes(input: SelectNextNodesInput): RoutingDecision {
  return decideNextNodes(input, false).decision;
}

interface InternalDecisionResult {
  readonly decision: RoutingDecision;
  readonly blockedByUnresolvedTyped: boolean;
}

function decideNextNodes(
  input: SelectNextNodesInput,
  recoveryOnly: boolean
): InternalDecisionResult {
  const outgoing: Candidate[] = [];
  input.graph.connections.forEach((connection, index) => {
    if (connection.from.nodeId === input.nodeId) outgoing.push({ index, connection });
  });

  // The default is held back rather than filtered out: it still needs an outcome
  // in the record, and it is evaluated only if it is reached.
  const explicit = outgoing.filter((candidate) => candidate.connection.isDefault !== true);
  const fallback = outgoing.filter((candidate) => candidate.connection.isDefault === true);

  const evaluatedExplicit = explicit.map((candidate) =>
    evaluate(candidate, input.context, recoveryOnly)
  );
  const orderedExplicit = [...evaluatedExplicit].sort(byOfferOrder);
  const matchedExplicit: Evaluated[] = [];
  let blockedByUnresolvedTyped = false;
  for (const candidate of orderedExplicit) {
    if (candidate.typedUnresolved && matchedExplicit.length === 0) {
      blockedByUnresolvedTyped = true;
      break;
    }
    if (candidate.matched) {
      matchedExplicit.push(candidate);
    }
  }

  // Considered only when nothing explicit matched and no higher-priority
  // TypedCondition evaluated to 'unresolved' (FR-027, FR-R5-F24 D2).
  const evaluatedFallback =
    matchedExplicit.length > 0 || blockedByUnresolvedTyped
      ? fallback.map((candidate) => ({
          ...candidate,
          matched: false,
          typedUnresolved: false,
          operands: []
        }))
      : fallback.map((candidate) => evaluate(candidate, input.context, recoveryOnly));
  const fallbackTypedUnresolved = evaluatedFallback.some((candidate) => candidate.typedUnresolved);
  const matchedFallback = evaluatedFallback.filter(
    (candidate) => candidate.matched && !candidate.typedUnresolved
  );

  const evaluated = [...evaluatedExplicit, ...evaluatedFallback].sort(
    (left, right) => left.index - right.index
  );
  const connections: readonly ConnectionOutcome[] = evaluated.map((candidate) => ({
    index: candidate.index,
    matched: candidate.matched,
    isDefault: candidate.connection.isDefault === true
  }));

  return {
    decision: Object.freeze({
      nodeId: input.nodeId,
      attemptIndex: input.attemptIndex,
      decidedAt: input.decidedAt,
      operands: Object.freeze(evaluated.flatMap((candidate) => candidate.operands)),
      connections: Object.freeze(connections),
      defaultApplied: matchedExplicit.length === 0 && matchedFallback.length > 0,
      eligible: Object.freeze(
        offerOrder(matchedExplicit.length > 0 ? matchedExplicit : matchedFallback)
      )
    }),
    blockedByUnresolvedTyped: blockedByUnresolvedTyped || fallbackTypedUnresolved
  };
}

export type TransitionTarget =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'return' };

export type SelectedTransitionOutcome =
  | {
      readonly outcome: 'transition';
      readonly decision: RoutingDecision;
      readonly connectionIndex: number;
      readonly connection: WorkflowConnection;
      readonly target: TransitionTarget;
      readonly handoff: WorkflowHandoffMode;
    }
  | {
      readonly outcome: 'terminal-sink';
      readonly decision: RoutingDecision;
    }
  | {
      readonly outcome: 'no-eligible-transition';
      readonly decision: RoutingDecision;
    }
  | {
      readonly outcome: 'unresolved-condition';
      readonly decision: RoutingDecision;
    }
  | {
      readonly outcome: 'unhandled-node-failure';
      readonly decision: RoutingDecision;
    };

export interface SelectNextTransitionInput extends SelectNextNodesInput {
  readonly attemptStatus?: WorkflowNodeTerminalStatus;
}

/**
 * FR-R5-F02 — select the winning transition for composable Workflow execution,
 * distinguishing `{ kind: 'node', nodeId }`, `{ kind: 'return' }`, terminal
 * sink completion, `no-eligible-transition`, `unresolved-condition`, and
 * `unhandled-node-failure`.
 *
 * A failed or canceled attempt routes only through a conditional connection
 * (for example `node-status equals failed`). An unconditional or default
 * connection without a condition is the success path: following it would
 * dispatch the successor, or return from the invocation, as though the node had
 * completed, so the attempt is an `unhandled-node-failure` instead.
 */
export function selectNextTransition(
  input: SelectNextTransitionInput
): SelectedTransitionOutcome {
  const attemptStatus =
    input.attemptStatus ?? input.context.nodes[input.nodeId]?.status ?? 'completed';
  const { decision, blockedByUnresolvedTyped } = decideNextNodes(
    input,
    attemptStatus !== 'completed'
  );
  if (decision.eligible.length > 0) {
    const connectionIndex = decision.eligible[0]!;
    const connection = input.graph.connections[connectionIndex]!;
    const target: TransitionTarget =
      connection.to.kind === 'return'
        ? { kind: 'return' }
        : { kind: 'node', nodeId: connection.to.nodeId };
    const handoff: WorkflowHandoffMode = connection.handoff ?? 'auto';
    return {
      outcome: 'transition',
      decision,
      connectionIndex,
      connection,
      target,
      handoff
    };
  }

  if (blockedByUnresolvedTyped) {
    return {
      outcome: 'unresolved-condition',
      decision
    };
  }

  if (attemptStatus !== 'completed') {
    return {
      outcome: 'unhandled-node-failure',
      decision
    };
  }

  const hasOutgoingConnections = input.graph.connections.some(
    (connection) => connection.from.nodeId === input.nodeId
  );
  if (!hasOutgoingConnections) {
    return {
      outcome: 'terminal-sink',
      decision
    };
  }

  return {
    outcome: 'no-eligible-transition',
    decision
  };
}

export interface BuildRoutingDecisionObservationInput extends SelectNextTransitionInput {
  readonly runId: string;
  readonly decisionId?: string;
  readonly attemptId?: string;
  readonly iteration?: number;
  readonly maxIterations?: number;
  readonly retryCondition?: string;
  readonly capOutcome?: RetryCapOutcome;
  readonly noProgressThreshold?: number;
  readonly settingSources?: ExecutionDecisionSettingSources;
  readonly exitReason?: ExecutionDecisionExitReason;
  /**
   * When `true` (default, matching `selectNextTransition`), only the highest-ranked
   * eligible arm is marked `'selected'` / `'fallback'` / `'manual-handoff'` and any
   * remaining eligible arms are marked `'priority-lost'`. When `false` (matching
   * `selectNextNodes` multi-offer mode), all eligible arms keep their selected
   * disposition.
   */
  readonly selectSingleWinner?: boolean;
}

function resolveAttemptStatus(input: SelectNextTransitionInput): WorkflowNodeTerminalStatus {
  if (input.attemptStatus !== undefined) {
    return input.attemptStatus;
  }
  if (Object.hasOwn(input.context.nodes, input.nodeId)) {
    return input.context.nodes[input.nodeId].status;
  }
  return 'completed';
}

/**
 * FR-R5-F23 (F23-T04, D1) — compute per-branch `ExecutionBranchDisposition` records
 * for every outgoing connection leaving `input.nodeId`, or a synthetic `'no-route'`
 * record when the node has no outgoing connections.
 */
export function evaluateBranchDispositions(
  input: SelectNextTransitionInput,
  precomputedDecision?: RoutingDecision,
  selectSingleWinner = true
): readonly ExecutionDecisionBranchRecord[] {
  const attemptStatus = resolveAttemptStatus(input);
  const recoveryOnly = attemptStatus !== 'completed';
  const decision = precomputedDecision ?? decideNextNodes(input, recoveryOnly).decision;

  const outgoing: Candidate[] = [];
  input.graph.connections.forEach((connection, index) => {
    if (connection.from.nodeId === input.nodeId) outgoing.push({ index, connection });
  });

  if (outgoing.length === 0) {
    return Object.freeze([
      Object.freeze({
        connectionIndex: -1,
        isDefault: false,
        disposition: 'no-route' as const,
        summary: 'No outgoing connections'
      })
    ]);
  }

  const eligibleSet = new Set(decision.eligible);
  const explicitMatched = decision.connections.some(
    (outcome) => outcome.matched && !outcome.isDefault
  );

  const records: ExecutionDecisionBranchRecord[] = outgoing.map(({ index, connection }) => {
    const isDefault = connection.isDefault === true;
    const targetNodeId =
      connection.to.kind === 'return' ? 'return' : connection.to.nodeId;
    const summary = formatConditionSummary(connection.condition, isDefault);

    let observedValue: string | number | boolean | undefined;
    let operandResolved = true;
    let conditionMatched = true;

    if (connection.condition !== undefined) {
    if ( isTypedCondition(connection.condition)) {
        const typedEval = evaluateTypedCondition(connection.condition, input.context);
        operandResolved = typedEval.result !== 'unresolved';
        conditionMatched = typedEval.result === true;
        if (isTypedLeafTest(connection.condition.test)) {
          const lookup = resolveOperand(connection.condition.test.left, input.context);
          if (lookup.resolved && lookup.value !== undefined) {
            observedValue = lookup.value;
          }
        }
      } else {
        const lookup = resolveOperand(connection.condition.left, input.context);
        operandResolved = lookup.resolved;
        if (lookup.resolved && lookup.value !== undefined) {
          observedValue = lookup.value;
        }
        conditionMatched = evaluateCondition(connection.condition, input.context).matched;
      }
    }

    let disposition: ExecutionBranchDisposition;
    if (recoveryOnly && connection.condition === undefined) {
      disposition = 'failure-excluded';
    } else if (isDefault && explicitMatched) {
      disposition = 'priority-lost';
    } else if (connection.condition !== undefined && !conditionMatched) {
      disposition = operandResolved ? 'condition-false' : 'unresolved';
    } else if (
      selectSingleWinner &&
      eligibleSet.has(index) &&
      decision.eligible.length > 0 &&
      index !== decision.eligible[0]
    ) {
      disposition = 'priority-lost';
    } else if (eligibleSet.has(index)) {
      if (connection.handoff === 'manual') {
        disposition = 'manual-handoff';
      } else if (isDefault) {
        disposition = 'fallback';
      } else {
        disposition = 'selected';
      }
    } else {
      disposition = 'condition-false';
    }

    return Object.freeze({
      connectionIndex: index,
      targetNodeId,
      isDefault,
      ...(connection.priority !== undefined ? { priority: connection.priority } : {}),
      disposition,
      summary,
      ...(observedValue !== undefined ? { observedValue } : {})
    });
  });

  return Object.freeze(records);
}

/**
 * FR-R5-F23 (F23-T04, F23-T05, D1) — build a closed-shape `ExecutionDecisionObservation`
 * (`version: 1`) for a node's routing evaluation.
 */
export function buildRoutingDecisionObservation(
  input: BuildRoutingDecisionObservationInput,
  precomputedDecision?: RoutingDecision
): ExecutionDecisionObservation {
  const attemptStatus = resolveAttemptStatus(input);
  const recoveryOnly = attemptStatus !== 'completed';
  const decision = precomputedDecision ?? decideNextNodes(input, recoveryOnly).decision;
  const branches = evaluateBranchDispositions(
    input,
    decision,
    input.selectSingleWinner ?? true
  );

  const observedValues: Record<string, string | number | boolean> = {
    [`${input.nodeId}.status`]: attemptStatus
  };
  for (const op of decision.operands) {
    if (Object.keys(observedValues).length >= 32) break;
    const key =
      (op.source === 'node-output' || op.source === 'node-result') && op.field !== undefined
        ? `${op.nodeId}.${op.field}`
        : op.source === 'result-field' && op.field !== undefined
          ? op.field
          : `${op.nodeId}.status`;
    if (op.resolved && op.compared !== undefined) {
      observedValues[key] = op.compared;
    }
  }

  const iteration = Math.max(1, input.iteration ?? input.attemptIndex + 1);
  const maxIterations = Math.max(1, input.maxIterations ?? iteration);
  const hasThreshold =
    input.noProgressThreshold !== undefined &&
    Number.isInteger(input.noProgressThreshold) &&
    input.noProgressThreshold >= 0;

  const settingSources: ExecutionDecisionSettingSources =
    input.settingSources ?? {
      maxIterations: 'default',
      capOutcome: 'default',
      ...(hasThreshold ? { noProgressThreshold: 'default' } : {})
    };

  const exitReason: ExecutionDecisionExitReason =
    input.exitReason ??
    (recoveryOnly && decision.eligible.length === 0
      ? 'host-control'
      : 'condition-cleared');

  return Object.freeze({
    version: EXECUTION_DECISION_OBSERVATION_VERSION,
    decisionId:
      input.decisionId ??
      `${input.runId}:${input.nodeId}:attempt-${input.attemptIndex}:${input.decidedAt}`,
    runId: input.runId,
    nodeId: input.nodeId,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    evaluatedAt: input.decidedAt,
    iteration,
    maxIterations,
    retryCondition: input.retryCondition?.trim() || 'single-pass',
    capOutcome: input.capOutcome ?? 'fail',
    ...(hasThreshold
      ? { noProgressThreshold: input.noProgressThreshold }
      : {}),
    settingSources: Object.freeze({ ...settingSources }),
    observedValues: Object.freeze(observedValues),
    exitReason,
    branches
  });
}
