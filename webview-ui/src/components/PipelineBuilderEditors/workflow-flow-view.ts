// What the canvas components pass between themselves.
//
// Separate from `workflow-flow-layout.ts` on purpose: that module answers "where
// does this node go", which is a rule with a test. This one carries selection and
// callbacks, which are view plumbing with no rule in them at all. Keeping the two
// apart is also what keeps the layout module importable by a test that mounts
// nothing.
//
// It exists as a bundle rather than as twelve props because the canvas is a
// recursive render — `WorkflowFlowSubtree` renders itself for each arm — and
// every prop a subtree needs would otherwise be re-declared and re-forwarded at
// every level. One object forwarded whole cannot fall out of step with itself.

import type {
  CandidateBlockControl,
  PortablePhaseDefinition,
  PortablePipelineDefinition,
  PortableWorkflowDefinition,
  WorkflowConnection,
  WorkflowNode,
  WorkflowNodeControl
} from '../../lib/snapshot-types';
import {
  describeWorkflowBranch,
  isReturnConnection,
  type FlowBranch,
  type FlowNodeSlot
} from './workflow-flow-layout';
import type { WorkflowDraftError } from './workflow-catalog-state';
import { phaseRunsOn, RUNS_ON_SEPARATOR } from './phase-catalog-view';

export interface WorkflowBreadcrumbEntry {
  readonly workflowId: string;
  readonly label: string;
  readonly fromNodeId?: string;
}

/**
 * What the Builder has in focus, and therefore what the inspector renders.
 *
 * `workflow` is the resting state rather than "nothing selected": the Workflow's
 * own identity fields have to live somewhere now that the canvas replaced the
 * form, and the inspector is that somewhere.
 */
export type WorkflowFlowSelection =
  | { readonly kind: 'workflow' }
  | { readonly kind: 'node'; readonly index: number }
  | { readonly kind: 'connection'; readonly index: number };

export function isSameFlowSelection(
  left: WorkflowFlowSelection,
  right: WorkflowFlowSelection | null
): boolean {
  if (right === null || left.kind !== right.kind) return false;
  if (left.kind === 'workflow' || right.kind === 'workflow') return true;
  return left.index === right.index;
}

/** Everything a node card and a subtree read, forwarded unchanged through the recursion. */
export interface WorkflowFlowView {
  readonly nodes: readonly WorkflowNode[];
  /** The authored list, which an arm reads for what the layout does not carry: its handoff. */
  readonly connections: readonly WorkflowConnection[];
  readonly slotsById: ReadonlyMap<string, FlowNodeSlot>;
  readonly pipelines: readonly PortablePipelineDefinition[];
  readonly phases?: readonly PortablePhaseDefinition[];
  readonly workflows?: readonly PortableWorkflowDefinition[];
  readonly control?: CandidateBlockControl;
  /** Both indexed alongside their authored list; see `visibleWorkflowDefects`. */
  readonly nodeDefects: readonly (readonly WorkflowDraftError[])[];
  readonly connectionDefects: readonly (readonly WorkflowDraftError[])[];
  /** Members of a `graph-cycle`, badged on the card so the defect has a place. */
  readonly cycleNodeIds: readonly string[];
  readonly readonly: boolean;
  readonly selection: WorkflowFlowSelection | null;
  readonly onselect: (selection: WorkflowFlowSelection) => void;
  /**
   * The `+` below a terminal card: append a node and connect it downstream of
   * `nodeId`. Only a terminal offers it — a node with arms has the splice below.
   */
  readonly oninsertafter: (nodeId: string) => void;
  /** The `+` on an arm: put a new node on that connection, keeping where it led. */
  readonly onsplice: (connectionIndex: number) => void;
  readonly onnodemove: (index: number, delta: number) => void;
  readonly onnoderemove: (index: number) => void;
  /** Drill down into a referenced child Workflow definition. */
  readonly onopenworkflow?: (workflowId: string, fromNodeId: string) => void;
}

/** The Pipeline a node names, or null when the effective catalog lacks it. */
export function pipelineOf(
  view: WorkflowFlowView,
  node: WorkflowNode
): PortablePipelineDefinition | null {
  return node.pipelineId !== undefined
    ? (view.pipelines.find((entry) => entry.pipelineId === node.pipelineId) ?? null)
    : null;
}

/** The Phase a node names, or null when the effective catalog lacks it. */
export function phaseOfNode(
  view: WorkflowFlowView,
  node: WorkflowNode
): PortablePhaseDefinition | null {
  return node.phaseId !== undefined
    ? ((view.phases ?? []).find((entry) => entry.phaseId === node.phaseId) ?? null)
    : null;
}

/** The child Workflow a node names, or null when the effective catalog lacks it. */
export function childWorkflowOfNode(
  view: WorkflowFlowView,
  node: WorkflowNode
): PortableWorkflowDefinition | null {
  return node.workflowId !== undefined
    ? ((view.workflows ?? []).find((entry) => entry.workflowId === node.workflowId) ?? null)
    : null;
}

export type WorkflowNodeTargetKind = 'phase' | 'workflow' | 'pipeline';

/**
 * What a node runs. A node naming a Phase is a Phase node whatever its `kind`
 * says, and likewise a child Workflow; anything else is a legacy Pipeline node.
 */
export function nodeTargetKind(node: WorkflowNode): WorkflowNodeTargetKind {
  if (node.kind === 'phase' || node.phaseId !== undefined) return 'phase';
  if (node.kind === 'workflow' || node.workflowId !== undefined) return 'workflow';
  return 'pipeline';
}

export function nodeTargetSummary(
  view: WorkflowFlowView,
  node: WorkflowNode
): {
  readonly kind: WorkflowNodeTargetKind;
  readonly id: string;
  readonly name: string;
  readonly resolved: boolean;
} {
  const kind = nodeTargetKind(node);
  if (kind === 'phase') {
    const id = node.phaseId ?? '';
    const phase = phaseOfNode(view, node);
    return {
      kind: 'phase',
      id,
      name: phase ? phase.name : `${id || '(unset)'} (unresolved)`,
      resolved: phase !== null
    };
  }
  if (kind === 'workflow') {
    const id = node.workflowId ?? '';
    const child = childWorkflowOfNode(view, node);
    return {
      kind: 'workflow',
      id,
      name: child ? child.name : `${id || '(unset)'} (unresolved)`,
      resolved: child !== null
    };
  }
  const id = node.pipelineId ?? '';
  const pipeline = pipelineOf(view, node);
  return {
    kind: 'pipeline',
    id,
    name: pipeline ? pipeline.name : `${id} (unresolved)`,
    resolved: pipeline !== null
  };
}

/** "1 step", "3 steps". */
const counted = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The card's summary line: what the target runs on, or how much it holds. Null
 * when the catalog lacks the target. The unknown badge says so, and a summary
 * would read as if the target were there.
 */
export function nodeRunSummary(view: WorkflowFlowView, node: WorkflowNode): string | null {
  const kind = nodeTargetKind(node);
  if (kind === 'phase') {
    const phase = phaseOfNode(view, node);
    return phase ? phaseRunsOn(phase) : null;
  }
  if (kind === 'workflow') {
    const child = childWorkflowOfNode(view, node);
    return child
      ? ['child Workflow', counted(child.nodes.length, 'step')].join(RUNS_ON_SEPARATOR)
      : null;
  }
  const pipeline = pipelineOf(view, node);
  return pipeline
    ? ['Pipeline', counted(pipeline.phaseIds.length, 'Phase')].join(RUNS_ON_SEPARATOR)
    : null;
}

/** The badge a node's run control earns: a call that runs once per item, or again. */
export function nodeControlLabel(control: WorkflowNodeControl): string {
  return control.kind === 'for-each'
    ? 'For each item'
    : `Repeats up to ${counted(control.maxIterations, 'time')}`;
}

/**
 * The words a defective card or arm shows beside its red border, so the defect
 * is not carried by colour alone: "1 issue", "2 issues".
 */
export function issueCountLabel(count: number): string {
  return counted(count, 'issue');
}

/**
 * The card's title. The operator's `label` when they set one, and the node
 * identifier when they did not — never the Pipeline/Phase/Workflow name, which
 * the card prints by identifier under the title. A card titled by its target
 * definition would render two nodes that share one Phase or child Workflow as
 * the same card, which is exactly the distinction `nodeId` exists to carry.
 */
export function nodeTitle(node: WorkflowNode): string {
  const label = node.label?.trim();
  return label !== undefined && label.length > 0 ? label : node.nodeId;
}

/** A node's title by identifier, or the identifier itself for a node the list lacks. */
export function nodeTitleById(view: Pick<WorkflowFlowView, 'nodes'>, nodeId: string): string {
  const found = view.nodes.find((entry) => entry.nodeId === nodeId);
  return found ? nodeTitle(found) : nodeId;
}

/**
 * What the far end of a return arm reads as: on the pill the canvas ends the arm
 * at, in the arm's name, and in the branch inspector's head. The run returns from
 * the Workflow there, so the far end is the return, never the card its endpoint
 * names.
 */
export const RETURN_TITLE = 'Return';

/** The title of the far end of an arm: the card it enters, or the return. */
export function connectionTargetTitle(
  nodes: readonly WorkflowNode[],
  connection: WorkflowConnection
): string {
  return isReturnConnection(connection)
    ? RETURN_TITLE
    : nodeTitleById({ nodes }, connection.to.nodeId);
}

/** The title of the far end of a laid-out arm, which has no target for a return. */
export function branchTargetTitle(
  view: Pick<WorkflowFlowView, 'nodes'>,
  branch: Pick<FlowBranch, 'targetNodeId'>
): string {
  return branch.targetNodeId === null ? RETURN_TITLE : nodeTitleById(view, branch.targetNodeId);
}

/**
 * The name an arm's button announces. The visible chip carries the condition
 * alone, which does not say which two cards the arm joins, and a plain arm has
 * no visible words at all. `label` is null for an unconditional arm. `issues`
 * is how many defects the arm has, which its chip also shows.
 */
export function armName(
  source: string,
  target: string,
  label: string | null,
  manual: boolean,
  issues = 0
): string {
  const named =
    label === null
      ? `Connection from ${source} to ${target}${manual ? ': manual handoff' : ''}`
      : `Branch from ${source} to ${target}: ${label}${manual ? ', manual handoff' : ''}`;
  return issues > 0 ? `${named}, ${issueCountLabel(issues)}` : named;
}

/**
 * An arm's name read from its connection, for a place that has no layout to hand:
 * the words `armName` gives its button, each end titled as its card is.
 */
export function connectionName(
  nodes: readonly WorkflowNode[],
  connection: WorkflowConnection
): string {
  return armName(
    nodeTitleById({ nodes }, connection.from.nodeId),
    connectionTargetTitle(nodes, connection),
    describeWorkflowBranch(connection).label,
    connection.handoff === 'manual'
  );
}

const NOTHING_SELECTED = 'Nothing selected. Showing the Workflow.';

/**
 * What the status line says once the operator selects something, as the workflow
 * builder mockup's editor says it: a card by its title, an arm by its button's
 * name. A selection that addresses nothing reads as the Workflow, which is what
 * the inspector falls back to showing.
 */
export function selectionAnnouncement(
  nodes: readonly WorkflowNode[],
  connections: readonly WorkflowConnection[],
  selection: WorkflowFlowSelection
): string {
  if (selection.kind === 'node') {
    const node = nodes.at(selection.index);
    if (node) return `Selected ${nodeTitle(node)}.`;
  }
  if (selection.kind === 'connection') {
    const connection = connections.at(selection.index);
    if (connection) return `Selected ${connectionName(nodes, connection)}.`;
  }
  return NOTHING_SELECTED;
}

const inRange = (index: number, count: number): boolean => index >= 0 && index < count;

/**
 * Where the selection lands after `moveWorkflowNode(index, delta)` on a list of
 * `count` nodes. Selection addresses the list by index, so without this the
 * inspector would stay on the old index and show whichever node moved into it.
 * The moved node keeps the selection, a node the move passed over shifts one
 * place toward the vacated index, and a move off either end changes nothing,
 * as the move itself does.
 */
export function selectionAfterMove(
  selection: WorkflowFlowSelection,
  index: number,
  delta: number,
  count: number
): WorkflowFlowSelection {
  if (selection.kind !== 'node') return selection;
  const target = index + delta;
  if (!inRange(index, count) || !inRange(target, count)) return selection;
  const selected = selection.index;
  if (selected === index) return { kind: 'node', index: target };
  if (index < target && selected > index && selected <= target) {
    return { kind: 'node', index: selected - 1 };
  }
  if (target < index && selected >= target && selected < index) {
    return { kind: 'node', index: selected + 1 };
  }
  return selection;
}

/** Why a moved card most often stays where it was: what places it on the canvas. */
const CANVAS_ORDER_NOTE =
  'The canvas places the steps a run can reach by their connections, not by this order.';

/**
 * What the status line says once Move earlier or Move later has moved a step:
 * its title and its place in the saved order, the authored list its definition
 * saves. The canvas draws that order only among the steps no start reaches, so the
 * moved card most often stays where it was, and the line says why. Null when the
 * step stands where it stood (a move off either end, or one the editor refused)
 * or is gone, so a move that changed nothing says nothing.
 */
export function moveAnnouncement(
  nodes: readonly WorkflowNode[],
  nodeId: string,
  from: number
): string | null {
  const node = nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) return null;
  const place = nodes.indexOf(node);
  if (place === from) return null;
  const position = `position ${place + 1} of ${nodes.length} in the saved step order`;
  return `Moved ${nodeTitle(node)} to ${position}. ${CANVAS_ORDER_NOTE}`;
}
