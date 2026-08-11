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
import type { RunOutputRecord } from '../../contracts/run-results';

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
}

export interface ConditionContext {
  readonly nodes: Readonly<Record<string, NodeAttemptFacts>>;
}

/**
 * What one operand resolved to. `value` is present only when `resolved`, and is
 * always a comparison literal — never an object a condition could traverse.
 */
export interface OperandLookup {
  readonly resolved: boolean;
  readonly value?: WorkflowConditionLiteral;
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
export function buildConditionContext(facts: readonly NodeAttemptFacts[]): ConditionContext {
  const nodes: Record<string, NodeAttemptFacts> = {};
  for (const fact of facts) {
    if (nodes[fact.nodeId] !== undefined) {
      throw new ConditionContextError(
        `condition context received two attempts for node ${fact.nodeId}`
      );
    }
    nodes[fact.nodeId] = {
      nodeId: fact.nodeId,
      status: fact.status,
      outputs: fact.outputs
    };
  }
  return { nodes };
}

/**
 * Resolve one operand against the context (FR-021, FR-022).
 *
 * Nothing raises and nothing coerces: an operand that names a node with no
 * recorded attempt, an output that was never declared, an output the run did not
 * produce, or any output of an attempt that did not complete, all answer
 * unresolved — which the evaluator turns into `false` for every operator
 * (FR-024).
 */
export function resolveOperand(
  operand: WorkflowConditionOperand,
  context: ConditionContext
): OperandLookup {
  const facts = context.nodes[operand.nodeId];
  if (facts === undefined) return UNRESOLVED;
  if (operand.source === 'node-status') return { resolved: true, value: facts.status };

  // Outputs of an attempt that did not complete are not readable. Its status
  // still is — routing on a failure is the point of FR-050.
  if (facts.status !== 'completed') return UNRESOLVED;
  const record = facts.outputs.find((output) => output.name === operand.field);
  if (record === undefined || record.status !== 'resolved') return UNRESOLVED;
  if (record.reference === undefined) return UNRESOLVED;
  return { resolved: true, value: record.reference };
}
