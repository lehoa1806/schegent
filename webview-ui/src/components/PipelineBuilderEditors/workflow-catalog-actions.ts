// Feature 083 (US5, T059, FR-035) — the destructive Workflow write.
// Feature 100 (FR-R3-016) T509b — one write, not two, and it no longer confirms
// here.
// Feature 101 (US1, T007) / FR-R5-F05 — the Builder's edit path, undo/redo
// history, and Phase + child Workflow + port/binding actions.

import type {
  PipelineExecutionDefaults,
  PortablePhaseDefinition,
  PortablePipelineDefinition,
  PortableWorkflowDefinition,
  WorkflowBinding,
  WorkflowConnection,
  WorkflowInputPort,
  WorkflowNode,
  WorkflowOutputPort
} from '../../lib/snapshot-types';
import type { LifecycleConfirmOptions } from '../../lib/catalog-lifecycle';
import type {
  DeactivateRequest,
  ExpectedDraftVersion
} from '../../../../src/contracts/catalog-lifecycle';
import {
  addWorkflowBinding,
  addWorkflowBranch,
  addWorkflowConditionValue,
  addWorkflowInputPort,
  addWorkflowOutputPort,
  appendWorkflowNode,
  insertWorkflowNodeAfter,
  makeWorkflowCondition,
  moveWorkflowConnection,
  moveWorkflowNode,
  parseWorkflowConditionLiteral,
  removeWorkflowBinding,
  removeWorkflowConditionValue,
  removeWorkflowConnection,
  removeWorkflowInputPort,
  removeWorkflowNode,
  removeWorkflowOutputPort,
  retargetWorkflowConnection,
  spliceWorkflowNodeIntoConnection,
  toggleWorkflowStartNode,
  updateWorkflowBinding,
  updateWorkflowCondition,
  updateWorkflowConditionValue,
  updateWorkflowConnection,
  updateWorkflowExecutionDefaults,
  updateWorkflowInputPort,
  updateWorkflowNode,
  updateWorkflowOutputPort,
  updateWorkflowRecommendedNext,
  type WorkflowConditionPatch,
  type WorkflowNodeTarget
} from './workflow-catalog-state';
import type { MutableWorkflow } from './types';
import {
  boundHistorySnapshots,
  MAX_BUILDER_HISTORY_BYTES,
  MAX_BUILDER_HISTORY_ENTRIES
} from './phase-catalog-actions';

export { MAX_BUILDER_HISTORY_BYTES, MAX_BUILDER_HISTORY_ENTRIES };

export interface WorkflowRemovalRequest {
  /** The row to drop. */
  readonly row: MutableWorkflow;
  /** The write token the projection carried for `row` (100 FR-012). */
  readonly expectedDraftVersion: ExpectedDraftVersion;
  /** Focus returns here when the dialog closes. */
  readonly originatingElement: HTMLElement | null;
}

/** A deactivation and what its confirmation needs to say. */
export interface WorkflowRemoval {
  readonly request: DeactivateRequest;
  readonly options: LifecycleConfirmOptions;
}

/**
 * Build the write that removes one Workflow.
 */
export function buildWorkflowRemoval(request: WorkflowRemovalRequest): WorkflowRemoval {
  const { row, expectedDraftVersion, originatingElement } = request;
  return {
    request: { kind: 'workflow', id: row.workflowId, expectedDraftVersion },
    options: { definitionName: row.name, originatingElement }
  };
}

/**
 * Every id the editor is already showing — stored rows and unsaved drafts
 * alike.
 */
export function takenWorkflowIds(rows: readonly MutableWorkflow[]): readonly string[] {
  return rows.map((row) => row.workflowId);
}

/**
 * The draft list with `sourceKey`'s row rewritten by `edit`, every other row
 * untouched.
 */
export function withWorkflowDraftEdited(
  drafts: readonly MutableWorkflow[],
  sourceKey: string,
  edit: (workflow: MutableWorkflow) => MutableWorkflow
): MutableWorkflow[] {
  return drafts.map((row) => (row.sourceKey === sourceKey ? edit(row) : row));
}

export interface WorkflowHistoryTrack {
  readonly snapshots: readonly MutableWorkflow[];
  readonly index: number;
}

export function pushWorkflowHistory(
  historyByKey: Readonly<Record<string, WorkflowHistoryTrack>>,
  sourceKey: string,
  baseline: MutableWorkflow,
  next: MutableWorkflow,
  maxEntries = MAX_BUILDER_HISTORY_ENTRIES,
  maxBytes = MAX_BUILDER_HISTORY_BYTES
): Record<string, WorkflowHistoryTrack> {
  const existing =
    sourceKey in historyByKey
      ? historyByKey[sourceKey]
      : { snapshots: [baseline], index: 0 };
  const head = existing.snapshots.slice(0, existing.index + 1);
  const clone = (row: MutableWorkflow): MutableWorkflow =>
    JSON.parse(JSON.stringify(row)) as MutableWorkflow;
  const combined =
    !(sourceKey in historyByKey) && JSON.stringify(baseline) === JSON.stringify(next)
      ? [clone(baseline)]
      : [...head.map(clone), clone(next)];
  const bounded = boundHistorySnapshots(combined, maxEntries, maxBytes);
  return {
    ...historyByKey,
    [sourceKey]: {
      snapshots: bounded,
      index: bounded.length - 1
    }
  };
}

export function stepWorkflowHistory(
  historyByKey: Readonly<Record<string, WorkflowHistoryTrack>>,
  sourceKey: string,
  delta: -1 | 1
): {
  readonly nextHistory: Record<string, WorkflowHistoryTrack>;
  readonly workflow: MutableWorkflow;
} | null {
  if (!(sourceKey in historyByKey)) return null;
  const existing = historyByKey[sourceKey];
  const targetIndex = existing.index + delta;
  if (targetIndex < 0 || targetIndex >= existing.snapshots.length) return null;
  const workflow = existing.snapshots[targetIndex];
  return {
    nextHistory: {
      ...historyByKey,
      [sourceKey]: {
        snapshots: existing.snapshots,
        index: targetIndex
      }
    },
    workflow
  };
}

export function mergeWorkflowRows(
  storedRows: readonly MutableWorkflow[],
  editedByKey: Readonly<Record<string, MutableWorkflow>>,
  draftRows: readonly MutableWorkflow[]
): MutableWorkflow[] {
  return [
    ...storedRows.map((row) => {
      const edited = editedByKey[row.sourceKey];
      if (!edited) return row;
      return {
        ...edited,
        sourceStatus: row.sourceStatus,
        sourceErrors: row.sourceErrors,
        derivedInputs: row.derivedInputs,
        derivedOutputs: row.derivedOutputs
      };
    }),
    ...draftRows
  ];
}

/** The callbacks the canvas Builder raises, in the order its panes declare them. */
export interface WorkflowGraphActions {
  /** Palette: append a node that runs a Phase, child Workflow, or legacy Pipeline. */
  addNodeRunning: (target: WorkflowNodeTarget) => void;
  /** Canvas `+` below a terminal card. */
  insertAfter: (nodeId: string) => void;
  /** Canvas `+` on an arm: a new node ON that connection. */
  spliceInto: (connectionIndex: number) => void;
  /** Another arm leaving one node, which is how a split is authored. */
  addBranch: (nodeId: string) => void;
  removeNode: (index: number) => void;
  moveNode: (index: number, delta: number) => void;
  patchNode: (index: number, patch: Partial<WorkflowNode>) => void;
  toggleStartNode: (nodeId: string) => void;
  removeConnection: (index: number) => void;
  moveConnection: (index: number, delta: number) => void;
  /** Branch metadata the canvas renders and therefore has to let the operator edit. */
  patchConnection: (index: number, patch: Partial<WorkflowConnection>) => void;
  retargetConnection: (
    index: number,
    end: 'from' | 'to',
    patch: { nodeId?: string; portId?: string; kind?: 'node' | 'return' }
  ) => void;
  toggleCondition: (index: number, conditional: boolean) => void;
  patchCondition: (index: number, patch: WorkflowConditionPatch) => void;
  setConditionValue: (index: number, valueIndex: number, text: string) => void;
  addConditionValue: (index: number) => void;
  removeConditionValue: (index: number, valueIndex: number) => void;
  addInputPort?: (port?: Partial<WorkflowInputPort>) => void;
  updateInputPort?: (index: number, patch: Partial<WorkflowInputPort>) => void;
  removeInputPort?: (index: number) => void;
  addOutputPort?: (port?: Partial<WorkflowOutputPort>) => void;
  updateOutputPort?: (index: number, patch: Partial<WorkflowOutputPort>) => void;
  removeOutputPort?: (index: number) => void;
  addBinding?: (binding: WorkflowBinding) => void;
  updateBinding?: (index: number, binding: WorkflowBinding) => void;
  removeBinding?: (index: number) => void;
  patchExecutionDefaults?: (patch: Partial<PipelineExecutionDefaults>) => void;
  setRecommendedNext?: (recommendedNext: readonly string[]) => void;
}

/**
 * Bind the whole graph surface to one `apply` sink.
 */
export function makeWorkflowGraphActions(
  apply: (edit: (workflow: MutableWorkflow) => MutableWorkflow) => void,
  pipelines: () => readonly PortablePipelineDefinition[],
  phases: () => readonly PortablePhaseDefinition[] = () => [],
  workflows: () => readonly PortableWorkflowDefinition[] = () => []
): WorkflowGraphActions {
  function defaultTarget(): WorkflowNodeTarget | undefined {
    const allPhases = phases();
    if (allPhases.length > 0) return { kind: 'phase', phaseId: allPhases[0].phaseId };
    const firstPipeline = pipelines()[0];
    if (firstPipeline) return firstPipeline.pipelineId;
    return undefined;
  }

  return {
    addNodeRunning: (target) =>
      apply((workflow) => appendWorkflowNode(workflow, target)),
    insertAfter: (nodeId) =>
      apply((workflow) => {
        const target = defaultTarget();
        return target === undefined
          ? workflow
          : insertWorkflowNodeAfter(workflow, nodeId, target, pipelines(), workflows());
      }),
    spliceInto: (connectionIndex) =>
      apply((workflow) => {
        const target = defaultTarget();
        return target === undefined
          ? workflow
          : spliceWorkflowNodeIntoConnection(
              workflow,
              connectionIndex,
              target,
              pipelines(),
              workflows()
            );
      }),
    addBranch: (nodeId) =>
      apply((workflow) => addWorkflowBranch(workflow, nodeId, pipelines(), workflows())),
    removeNode: (index) => apply((workflow) => removeWorkflowNode(workflow, index)),
    moveNode: (index, delta) => apply((workflow) => moveWorkflowNode(workflow, index, delta)),
    patchNode: (index, patch) => apply((workflow) => updateWorkflowNode(workflow, index, patch)),
    toggleStartNode: (nodeId) => apply((workflow) => toggleWorkflowStartNode(workflow, nodeId)),
    removeConnection: (index) => apply((workflow) => removeWorkflowConnection(workflow, index)),
    moveConnection: (index, delta) =>
      apply((workflow) => moveWorkflowConnection(workflow, index, delta)),
    patchConnection: (index, patch) =>
      apply((workflow) => updateWorkflowConnection(workflow, index, patch)),
    retargetConnection: (index, end, patch) =>
      apply((workflow) =>
        retargetWorkflowConnection(workflow, index, end, patch, pipelines(), workflows())
      ),
    toggleCondition: (index, conditional) =>
      apply((workflow) => {
        const connection = workflow.connections[index];
        if (!connection) return workflow;
        return updateWorkflowConnection(workflow, index, {
          condition: conditional ? makeWorkflowCondition(connection.from.nodeId) : undefined
        });
      }),
    patchCondition: (index, patch) =>
      apply((workflow) => updateWorkflowCondition(workflow, index, patch)),
    setConditionValue: (index, valueIndex, text) =>
      apply((workflow) =>
        updateWorkflowConditionValue(workflow, index, valueIndex, parseWorkflowConditionLiteral(text))
      ),
    addConditionValue: (index) => apply((workflow) => addWorkflowConditionValue(workflow, index)),
    removeConditionValue: (index, valueIndex) =>
      apply((workflow) => removeWorkflowConditionValue(workflow, index, valueIndex)),
    addInputPort: (port) => apply((workflow) => addWorkflowInputPort(workflow, port)),
    updateInputPort: (index, patch) =>
      apply((workflow) => updateWorkflowInputPort(workflow, index, patch)),
    removeInputPort: (index) => apply((workflow) => removeWorkflowInputPort(workflow, index)),
    addOutputPort: (port) => apply((workflow) => addWorkflowOutputPort(workflow, port)),
    updateOutputPort: (index, patch) =>
      apply((workflow) => updateWorkflowOutputPort(workflow, index, patch)),
    removeOutputPort: (index) => apply((workflow) => removeWorkflowOutputPort(workflow, index)),
    addBinding: (binding) => apply((workflow) => addWorkflowBinding(workflow, binding)),
    updateBinding: (index, binding) =>
      apply((workflow) => updateWorkflowBinding(workflow, index, binding)),
    removeBinding: (index) => apply((workflow) => removeWorkflowBinding(workflow, index)),
    patchExecutionDefaults: (patch) =>
      apply((workflow) => updateWorkflowExecutionDefaults(workflow, patch)),
    setRecommendedNext: (recommendedNext) =>
      apply((workflow) => updateWorkflowRecommendedNext(workflow, recommendedNext))
  };
}
