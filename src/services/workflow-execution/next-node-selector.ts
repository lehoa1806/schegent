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
  WorkflowDefinition
} from '../../contracts/workflow-definitions';
import type {
  ConnectionOutcome,
  OperandResolution,
  RoutingDecision
} from '../../state/connected-workflow-run';
import { evaluateCondition } from './condition-evaluator';
import type { ConditionContext } from './condition-context';

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
  readonly operands: readonly OperandResolution[];
}

function evaluate(candidate: Candidate, context: ConditionContext): Evaluated {
  const { condition } = candidate.connection;
  if (condition === undefined) return { ...candidate, matched: true, operands: [] };
  const evaluation = evaluateCondition(condition, context);
  return { ...candidate, matched: evaluation.matched, operands: evaluation.operands };
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
  const outgoing: Candidate[] = [];
  input.graph.connections.forEach((connection, index) => {
    if (connection.from.nodeId === input.nodeId) outgoing.push({ index, connection });
  });

  // The default is held back rather than filtered out: it still needs an outcome
  // in the record, and it is evaluated only if it is reached.
  const explicit = outgoing.filter((candidate) => candidate.connection.isDefault !== true);
  const fallback = outgoing.filter((candidate) => candidate.connection.isDefault === true);

  const evaluatedExplicit = explicit.map((candidate) => evaluate(candidate, input.context));
  const matchedExplicit = evaluatedExplicit.filter((candidate) => candidate.matched);

  // Considered only when nothing explicit matched (FR-027). Leaving it
  // unevaluated otherwise is deliberate: an unreached connection contributes no
  // operand resolution, so the record never suggests a comparison that did not
  // happen.
  const evaluatedFallback =
    matchedExplicit.length > 0
      ? fallback.map((candidate) => ({ ...candidate, matched: false, operands: [] }))
      : fallback.map((candidate) => evaluate(candidate, input.context));
  const matchedFallback = evaluatedFallback.filter((candidate) => candidate.matched);

  const evaluated = [...evaluatedExplicit, ...evaluatedFallback].sort(
    (left, right) => left.index - right.index
  );
  const connections: readonly ConnectionOutcome[] = evaluated.map((candidate) => ({
    index: candidate.index,
    matched: candidate.matched,
    isDefault: candidate.connection.isDefault === true
  }));

  return Object.freeze({
    nodeId: input.nodeId,
    attemptIndex: input.attemptIndex,
    decidedAt: input.decidedAt,
    operands: Object.freeze(evaluated.flatMap((candidate) => candidate.operands)),
    connections: Object.freeze(connections),
    defaultApplied: matchedExplicit.length === 0 && matchedFallback.length > 0,
    eligible: Object.freeze(
      offerOrder(matchedExplicit.length > 0 ? matchedExplicit : matchedFallback)
    )
  });
}
