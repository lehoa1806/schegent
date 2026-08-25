// The canvas Builder's layout, as a pure function.
//
// The list Builder needed no layout: an authored array rendered in authored
// order and every row was visible by construction. A canvas has to decide where
// a node goes and which edge is drawn where, and that decision is a rule. Rules
// do not live in Svelte markup anywhere else in this Builder — `addWorkflowNode`,
// `conditionRightArity`, and `workflowErrorAnchor` are all pure functions in
// `workflow-catalog-state.ts` for the same reason — so the whole of it lives here
// and `__tests__/workflow-flow-layout.test.ts` is what pins it.
//
// Three properties this owes the canvas, all of them about drafts the host would
// reject. The Builder edits a draft, so every one is reachable mid-edit and none
// may crash or hide the defect the operator has to fix:
//
//   1. a node with two parents is placed ONCE, and the later edge becomes a jump
//      reference — rendering it twice would show a graph that does not exist;
//   2. a cycle terminates, and its members are named so the canvas can badge
//      them alongside the host's `graph-cycle` defect;
//   3. a node no start reaches is still returned, in `detached` — an
//      `unreachable-node` the canvas dropped is one the operator cannot select
//      to connect or delete.
//
// Branch order mirrors `src/services/workflow-execution/next-node-selector.ts`:
// ascending `priority`, authored position for ties, default arm last. The canvas
// therefore draws the order the run engine will actually offer, which is the
// whole reason to draw it top-to-bottom rather than in authored array order.

import type {
  WorkflowCondition,
  WorkflowConditionOperator,
  WorkflowConnection,
  WorkflowNode
} from '../../lib/snapshot-types';
import { conditionValues, formatWorkflowConditionLiteral } from './workflow-catalog-state';

/**
 * An unprioritized connection sorts after every explicit one — the same reading
 * `next-node-selector.ts` documents. Treating an absent `priority` as `0` would
 * draw an unmarked arm ahead of one the operator explicitly marked `priority: 1`,
 * which inverts what marking it meant.
 */
const UNPRIORITIZED = Number.POSITIVE_INFINITY;

/** Compact forms for the closed operator set. Symbols where one reads better. */
const OPERATOR_SYMBOLS: Record<WorkflowConditionOperator, string> = {
  equals: '=',
  notEquals: '≠',
  in: 'in',
  exists: 'exists',
  greaterThan: '>',
  greaterThanOrEqual: '≥',
  lessThan: '<',
  lessThanOrEqual: '≤'
};

/** How a branch reads on the canvas. `default` is the arm considered last. */
export type WorkflowBranchKind = 'conditional' | 'default' | 'unconditional';

export interface WorkflowBranchDescription {
  readonly kind: WorkflowBranchKind;
  /** Null only for an unconditional, non-default arm, which needs no chip. */
  readonly label: string | null;
}

export interface FlowBranch extends WorkflowBranchDescription {
  /** Position in the authored `connections` array — what a defect addresses. */
  readonly connectionIndex: number;
  readonly targetNodeId: string;
  /**
   * The target is placed elsewhere in the flow, so this arm draws as a reference
   * rather than descending into a second copy of the subtree.
   */
  readonly isJump: boolean;
}

export interface FlowNodeSlot {
  readonly nodeId: string;
  /** Position in the authored `nodes` array — what an edit addresses. */
  readonly nodeIndex: number;
  /** 0 for a start (and for each detached root). */
  readonly depth: number;
  readonly isStart: boolean;
  readonly branches: readonly FlowBranch[];
  /** No outgoing connection at all: the canvas draws an End terminal. */
  readonly isTerminal: boolean;
}

export interface WorkflowFlowLayout {
  /** Pre-order from the starts; every reachable node appears exactly once. */
  readonly slots: readonly FlowNodeSlot[];
  /** Reachable from no start (`unreachable-node`), in authored order. */
  readonly detached: readonly FlowNodeSlot[];
  /** Every node on a back edge, so the canvas can badge a `graph-cycle`. */
  readonly cycleNodeIds: readonly string[];
}

export interface WorkflowFlowInput {
  readonly nodes: readonly WorkflowNode[];
  readonly connections: readonly WorkflowConnection[];
  readonly startNodeIds: readonly string[];
}

/**
 * What one branch says on the canvas (the chip the image renders as `Yes` / `No`).
 *
 * A default arm reads as the fallback it is, and keeps its condition when it has
 * one: FR-027 evaluates a default's own condition once the arm is reached, so
 * describing it as an unconditional catch-all would state the opposite.
 */
export function describeWorkflowBranch(
  connection: WorkflowConnection
): WorkflowBranchDescription {
  const comparison = connection.condition ? describeCondition(connection.condition) : null;
  if (connection.isDefault === true) {
    return {
      kind: 'default',
      label: comparison === null ? 'Otherwise' : `Otherwise, if ${comparison}`
    };
  }
  return comparison === null
    ? { kind: 'unconditional', label: null }
    : { kind: 'conditional', label: comparison };
}

/** `a status = completed`, `a.verdict ≠ fail`, `a.tag in [x, y]`, `a.report exists`. */
function describeCondition(condition: WorkflowCondition): string {
  const operand =
    condition.left.source === 'node-status'
      ? `${condition.left.nodeId} status`
      : `${condition.left.nodeId}.${condition.left.field}`;
  // Typed as possibly absent so the fallback below stays meaningful: a
  // persisted operator outside the union types as impossible but is not.
  const symbol: string | undefined = OPERATOR_SYMBOLS[condition.operator];
  const operatorLabel = symbol ?? condition.operator;
  const right = describeRight(condition);
  return right === null
    ? `${operand} ${operatorLabel}`
    : `${operand} ${operatorLabel} ${right}`;
}

/** Null when the operator takes no right operand, or none was authored yet. */
function describeRight(condition: WorkflowCondition): string | null {
  if (condition.operator === 'exists') return null;
  const values = conditionValues(condition);
  if (values.length === 0) return null;
  const rendered = values.map(formatWorkflowConditionLiteral);
  return condition.operator === 'in' ? `[${rendered.join(', ')}]` : rendered[0];
}

interface OutgoingConnection {
  readonly index: number;
  readonly connection: WorkflowConnection;
}

/**
 * Ascending priority, then authored position — with the default arm held behind
 * every explicit one whatever its priority. `next-node-selector.ts` partitions it
 * out before it sorts, because a default is not a low-priority alternative: it is
 * considered only when nothing explicit matched, so drawing an explicit arm below
 * a `priority: 0` default would state the reverse of what the run engine does.
 */
function byOfferOrder(left: OutgoingConnection, right: OutgoingConnection): number {
  const leftFallback = left.connection.isDefault === true ? 1 : 0;
  const rightFallback = right.connection.isDefault === true ? 1 : 0;
  if (leftFallback !== rightFallback) return leftFallback - rightFallback;
  const leftPriority = left.connection.priority ?? UNPRIORITIZED;
  const rightPriority = right.connection.priority ?? UNPRIORITIZED;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.index - right.index;
}

/**
 * Group the connections leaving each node into offer order, once.
 *
 * An endpoint naming a node the draft does not hold is dropped rather than
 * rendered: it is authorable mid-edit, the host answers it with
 * `unresolved-endpoint`, and there is no node on the canvas for the arm to point
 * at. The defect still reaches the operator through the connection's own row.
 */
function groupOutgoing(
  input: WorkflowFlowInput,
  present: ReadonlySet<string>
): ReadonlyMap<string, readonly OutgoingConnection[]> {
  const outgoing = new Map<string, OutgoingConnection[]>();
  input.connections.forEach((connection, index) => {
    if (!present.has(connection.from.nodeId) || !present.has(connection.to.nodeId)) return;
    const bucket = outgoing.get(connection.from.nodeId);
    if (bucket) {
      bucket.push({ index, connection });
      return;
    }
    outgoing.set(connection.from.nodeId, [{ index, connection }]);
  });
  for (const bucket of outgoing.values()) bucket.sort(byOfferOrder);
  return outgoing;
}

interface WalkState {
  readonly outgoing: ReadonlyMap<string, readonly OutgoingConnection[]>;
  readonly indexOf: ReadonlyMap<string, number>;
  readonly starts: ReadonlySet<string>;
  readonly placed: Set<string>;
  readonly onStack: Set<string>;
  readonly cycle: Set<string>;
}

/**
 * Place one node, then descend into the arms that have not been placed yet.
 *
 * The slot is pushed BEFORE the descent so the result reads top-to-bottom, and
 * its `branches` array is filled during the descent so each arm's `isJump`
 * reflects what was actually placed by the time that arm is drawn — deciding it
 * up front would mark an arm as descending into a subtree an earlier sibling had
 * already claimed.
 *
 * Recursive, and bounded by the node count: `placed` is set before any descent,
 * so each node is walked once and the 20-node soft cap keeps the depth trivial.
 */
function place(state: WalkState, into: FlowNodeSlot[], nodeId: string, depth: number): void {
  state.placed.add(nodeId);
  state.onStack.add(nodeId);

  const outgoing = state.outgoing.get(nodeId) ?? [];
  const branches: FlowBranch[] = [];
  into.push({
    nodeId,
    nodeIndex: state.indexOf.get(nodeId) ?? -1,
    depth,
    isStart: state.starts.has(nodeId),
    branches,
    isTerminal: outgoing.length === 0
  });

  for (const { index, connection } of outgoing) {
    const targetNodeId = connection.to.nodeId;
    if (state.onStack.has(targetNodeId)) {
      state.cycle.add(targetNodeId);
      state.cycle.add(nodeId);
    }
    const alreadyPlaced = state.placed.has(targetNodeId);
    branches.push({
      connectionIndex: index,
      targetNodeId,
      isJump: alreadyPlaced,
      ...describeWorkflowBranch(connection)
    });
    if (!alreadyPlaced) place(state, into, targetNodeId, depth + 1);
  }

  state.onStack.delete(nodeId);
}

/**
 * Lay the draft out for the canvas (see the file header for the three properties
 * this owes it).
 *
 * Total: no input shape throws. A draft with no nodes, no starts, a start naming
 * a node that was deleted, a self-edge, or a fully disconnected node all produce
 * a layout rather than an exception, because every one of them is a state the
 * operator passes through while authoring.
 */
export function buildWorkflowFlowLayout(input: WorkflowFlowInput): WorkflowFlowLayout {
  const present = new Set(input.nodes.map((node) => node.nodeId));
  const state: WalkState = {
    outgoing: groupOutgoing(input, present),
    indexOf: new Map(input.nodes.map((node, index) => [node.nodeId, index])),
    // A start naming a node the draft no longer holds is dropped here and
    // reported by the host as `invalid-start-set`; it has nothing to render.
    starts: new Set(input.startNodeIds.filter((nodeId) => present.has(nodeId))),
    placed: new Set(),
    onStack: new Set(),
    cycle: new Set()
  };

  // Authored start order, so reordering the starts reorders the canvas lanes.
  const slots: FlowNodeSlot[] = [];
  for (const nodeId of input.startNodeIds) {
    if (!present.has(nodeId) || state.placed.has(nodeId)) continue;
    place(state, slots, nodeId, 0);
  }

  // Everything left is reachable from no start. Walked the same way rather than
  // listed flat, so a detached *chain* still reads as the chain it is.
  const detached: FlowNodeSlot[] = [];
  for (const node of input.nodes) {
    if (state.placed.has(node.nodeId)) continue;
    place(state, detached, node.nodeId, 0);
  }

  return { slots, detached, cycleNodeIds: [...state.cycle] };
}
