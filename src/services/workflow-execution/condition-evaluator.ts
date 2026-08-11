// Feature 088 (T013) — the pure comparator, and the only thing that reads a
// condition.
//
// `WorkflowCondition` is already `{ left, operator, right? }` with an operand
// from a closed two-member set (feature 083), so evaluation is a `switch` over
// eight operators and a field-wise comparison. There is no text to compile, no
// grammar, and nothing to sandbox — the hard rule against giving a Workflow
// condition a string form, a parser, or an evaluator holds by construction here
// as it does on the definition side. The unit suite scans this file for the
// shapes that would break that, so a parser cannot appear without a red build.
//
// Three rules cover everything the operators do not (contracts/condition-context.md):
//
//   1. an unresolved operand answers `false` — every operator, `exists` and
//      `notEquals` included (FR-024);
//   2. a type mismatch answers `false`, without coercion (FR-025);
//   3. nothing raises — a false answer means the branch is not offered, and the
//      node's other connections still evaluate.
//
// No I/O and no host import: the only thing this module touches is the context
// it is handed.

import type {
  WorkflowCondition,
  WorkflowConditionLiteral,
  WorkflowConditionOperator
} from '../../contracts/workflow-definitions';
import type { OperandResolution } from '../../state/connected-workflow-run';
import { renderCompared } from '../../state/connected-workflow-run';
import { resolveOperand, type ConditionContext } from './condition-context';

export interface ConditionEvaluation {
  readonly matched: boolean;
  /** One entry per operand the condition referenced, in evaluation order. */
  readonly operands: readonly OperandResolution[];
}

function isLiteral(value: unknown): value is WorkflowConditionLiteral {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Same type and equal. `typeof` is the whole of the type check because the
 * literal set is exactly string, number, and boolean — `"3"` is not `3`, and
 * making it so would be the coercion FR-025 forbids.
 */
function sameTypeEqual(left: WorkflowConditionLiteral, right: unknown): boolean {
  return typeof left === typeof right && left === right;
}

/**
 * The comparison itself, over resolved literals (FR-025).
 *
 * Total over the eight operators, and total over the literal set: an operator
 * outside the closed set, or a `right` of the wrong shape for the operator,
 * answers `false` rather than raising. Exported for the unit suite, which drives
 * the numeric orderings directly — v1 resolves every operand to text, so no
 * context can produce a numeric left yet.
 */
export function compareValues(
  left: WorkflowConditionLiteral,
  operator: WorkflowConditionOperator,
  right: WorkflowCondition['right']
): boolean {
  switch (operator) {
    case 'exists':
      return true;
    case 'equals':
      return sameTypeEqual(left, right);
    case 'notEquals':
      return isLiteral(right) && typeof left === typeof right && left !== right;
    case 'in':
      return Array.isArray(right) && right.some((candidate) => sameTypeEqual(left, candidate));
    case 'greaterThan':
      return typeof left === 'number' && typeof right === 'number' && left > right;
    case 'greaterThanOrEqual':
      return typeof left === 'number' && typeof right === 'number' && left >= right;
    case 'lessThan':
      return typeof left === 'number' && typeof right === 'number' && left < right;
    case 'lessThanOrEqual':
      return typeof left === 'number' && typeof right === 'number' && left <= right;
    default:
      // Unreachable for a validated definition; an unknown operator is not
      // offered rather than thrown, so one bad connection cannot stop the
      // node's other connections from evaluating.
      return false;
  }
}

/**
 * Evaluate one condition and record what it saw (FR-024, FR-025, FR-066).
 *
 * The returned resolutions are what makes "why was this branch not offered"
 * answerable from the persisted record alone: operand identity, whether it
 * resolved, and a capped rendering of the value the comparison saw — never the
 * content behind it.
 */
export function evaluateCondition(
  condition: WorkflowCondition,
  context: ConditionContext
): ConditionEvaluation {
  const lookup = resolveOperand(condition.left, context);
  const resolution: OperandResolution = {
    source: condition.left.source,
    nodeId: condition.left.nodeId,
    ...(condition.left.source === 'node-output' ? { field: condition.left.field } : {}),
    resolved: lookup.resolved,
    ...(lookup.resolved ? withCompared(lookup.value) : {})
  };
  const matched =
    lookup.resolved && lookup.value !== undefined
      ? compareValues(lookup.value, condition.operator, condition.right)
      : false;
  return { matched, operands: [resolution] };
}

/** Omit `compared` entirely when the value is too long to record (FR-066). */
function withCompared(value: WorkflowConditionLiteral | undefined): { compared?: string } {
  const compared = renderCompared(value);
  return compared === undefined ? {} : { compared };
}
