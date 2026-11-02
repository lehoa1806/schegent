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
  PortablePhaseDefinition,
  PortablePipelineDefinition,
  PortableWorkflowDefinition,
  WorkflowNode
} from '../../lib/snapshot-types';
import type { FlowNodeSlot } from './workflow-flow-layout';
import type { WorkflowDraftError } from './workflow-catalog-state';

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
  readonly slotsById: ReadonlyMap<string, FlowNodeSlot>;
  readonly pipelines: readonly PortablePipelineDefinition[];
  readonly phases?: readonly PortablePhaseDefinition[];
  readonly workflows?: readonly PortableWorkflowDefinition[];
  /** Both indexed alongside their authored list; see `anchorWorkflowDefects`. */
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
  /** Add another outgoing arm to `nodeId`, which is how a split is authored. */
  readonly onbranchadd: (nodeId: string) => void;
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

export function nodeTargetSummary(
  view: WorkflowFlowView,
  node: WorkflowNode
): {
  readonly kind: 'phase' | 'workflow' | 'pipeline';
  readonly id: string;
  readonly name: string;
  readonly resolved: boolean;
} {
  if (node.kind === 'phase' || node.phaseId !== undefined) {
    const id = node.phaseId ?? '';
    const phase = phaseOfNode(view, node);
    return {
      kind: 'phase',
      id,
      name: phase ? phase.name : `${id || '(unset)'} (unresolved)`,
      resolved: phase !== null
    };
  }
  if (node.kind === 'workflow' || node.workflowId !== undefined) {
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

/**
 * The card's title. The operator's `label` when they set one, and the node
 * identifier when they did not — never the Pipeline/Phase/Workflow name, which
 * is the *body*. A card titled by its target definition would render two nodes
 * that share one Phase or child Workflow as the same card, which is exactly the
 * distinction `nodeId` exists to carry.
 */
export function nodeTitle(node: WorkflowNode): string {
  const label = node.label?.trim();
  return label !== undefined && label.length > 0 ? label : node.nodeId;
}
