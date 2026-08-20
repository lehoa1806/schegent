// Feature 083 (US5, T059, FR-035) — the destructive Workflow write.
// Feature 100 (FR-R3-016) T509b — one write, not two, and it no longer confirms
// here.
//
// The confirmation moved into `deactivateDefinition`, the only function that can
// post the command it authorises (FR-049). Keeping it at the call site was the
// right shape while a removal was an *omission* from a whole-array save — there
// was no single function to attach it to — but there is one now, and a gate
// inside it cannot be forgotten by the next caller.
//
// `confirmWorkflowLayerReset` is gone with the Reset action. It emptied the whole
// layer in one write, which the store can no longer do: a package addresses
// definitions by id, so emptying a catalog is N independent deactivations. A
// button whose atomicity the store does not provide is a button that lies, and a
// bulk surface — if one is wanted — is FR-R3-017's to design rather than this
// item's to fake with a loop.
//
// This module still builds the request rather than sending it, so the caller
// keeps one submit path with one pending-revision gate.
//
// Feature 101 (US1, T007) — the Builder's edit path lives here too now.
// `WorkflowCatalogEditor.svelte` sits under a hard 500-line ceiling that
// `tests/lint/svelte-component-loc-budget.test.ts` enforces with no override
// and no allowlist, and the surface work ahead of it only adds markup. What
// moved out is what was never markup: which ids are already taken, how one row
// in the draft list is replaced, and the callbacks the graph editor raises.
// Nothing about the writes changed — every rule still lives in
// `workflow-catalog-state.ts`, and this module still only assembles calls into
// it and hands the result back.

import type { PortablePipelineDefinition, WorkflowNode } from '../../lib/snapshot-types';
import type { LifecycleConfirmOptions } from '../../lib/catalog-lifecycle';
import type {
  DeactivateRequest,
  ExpectedDraftVersion
} from '../../../../src/contracts/catalog-lifecycle';
import {
  addWorkflowConditionValue,
  addWorkflowConnection,
  addWorkflowNode,
  makeWorkflowCondition,
  makeWorkflowConnectionDraft,
  makeWorkflowNodeDraft,
  moveWorkflowConnection,
  moveWorkflowNode,
  parseWorkflowConditionLiteral,
  removeWorkflowConditionValue,
  removeWorkflowConnection,
  removeWorkflowNode,
  retargetWorkflowConnection,
  toggleWorkflowStartNode,
  updateWorkflowCondition,
  updateWorkflowConditionValue,
  updateWorkflowConnection,
  updateWorkflowNode,
  type WorkflowConditionPatch
} from './workflow-catalog-state';
import type { MutableWorkflow } from './types';

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
 *
 * Feature 101 (T028) — `layer` is gone. It was the remaining rows of a
 * whole-array write, which is how a package expressed an omission; a
 * deactivation names the one definition it stops, so there is nothing left to
 * filter. This still builds the request rather than sending it, so the caller
 * keeps one submit path.
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
 * alike. A new draft has to miss all of them, and a draft counts: two drafts
 * created before either is saved would otherwise collide on the same generated
 * id and the second save would be rejected for a clash the operator never saw.
 */
export function takenWorkflowIds(rows: readonly MutableWorkflow[]): readonly string[] {
  return rows.map((row) => row.workflowId);
}

/**
 * The draft list with `sourceKey`'s row rewritten by `edit`, every other row
 * untouched.
 *
 * `sourceKey` is the handle rather than `workflowId` because the id is itself
 * an editable field: keying on it would lose the row the moment the operator
 * typed into the Identifier box.
 */
export function withWorkflowDraftEdited(
  drafts: readonly MutableWorkflow[],
  sourceKey: string,
  edit: (workflow: MutableWorkflow) => MutableWorkflow
): MutableWorkflow[] {
  return drafts.map((row) => (row.sourceKey === sourceKey ? edit(row) : row));
}

/** The callbacks `WorkflowGraphEditor` raises, in the order it declares them. */
export interface WorkflowGraphActions {
  addNode: () => void;
  removeNode: (index: number) => void;
  moveNode: (index: number, delta: number) => void;
  patchNode: (index: number, patch: Partial<WorkflowNode>) => void;
  toggleStartNode: (nodeId: string) => void;
  addConnection: () => void;
  removeConnection: (index: number) => void;
  moveConnection: (index: number, delta: number) => void;
  retargetConnection: (
    index: number,
    end: 'from' | 'to',
    patch: { nodeId?: string; portId?: string }
  ) => void;
  toggleCondition: (index: number, conditional: boolean) => void;
  patchCondition: (index: number, patch: WorkflowConditionPatch) => void;
  setConditionValue: (index: number, valueIndex: number, text: string) => void;
  addConditionValue: (index: number) => void;
  removeConditionValue: (index: number, valueIndex: number) => void;
}

/**
 * Bind the whole graph surface to one `apply` sink.
 *
 * Every control is the same two steps — name a pure edit from
 * `workflow-catalog-state.ts`, hand it to the editor's one gate — so they are
 * written together rather than as fourteen near-identical lines beside the
 * markup that raises them. `apply` is that gate: it is what refuses the edit
 * when nothing is selected or the selection is not editable, and keeping the
 * refusal there is what stops each control from having to remember it.
 *
 * `pipelines` is a getter, not an array. The effective catalog is derived and
 * can move under a mounted editor, and a captured copy would let Add Node keep
 * seeding from a Pipeline that resolution has since dropped (FR-045).
 */
export function makeWorkflowGraphActions(
  apply: (edit: (workflow: MutableWorkflow) => MutableWorkflow) => void,
  pipelines: () => readonly PortablePipelineDefinition[]
): WorkflowGraphActions {
  return {
    addNode: () =>
      apply((workflow) => {
        const pipelineId = pipelines()[0]?.pipelineId;
        return pipelineId === undefined
          ? workflow
          : addWorkflowNode(workflow, makeWorkflowNodeDraft(workflow, pipelineId));
      }),
    removeNode: (index) => apply((workflow) => removeWorkflowNode(workflow, index)),
    moveNode: (index, delta) => apply((workflow) => moveWorkflowNode(workflow, index, delta)),
    patchNode: (index, patch) => apply((workflow) => updateWorkflowNode(workflow, index, patch)),
    toggleStartNode: (nodeId) => apply((workflow) => toggleWorkflowStartNode(workflow, nodeId)),
    addConnection: () =>
      apply((workflow) =>
        addWorkflowConnection(workflow, makeWorkflowConnectionDraft(workflow, pipelines()))
      ),
    removeConnection: (index) => apply((workflow) => removeWorkflowConnection(workflow, index)),
    moveConnection: (index, delta) =>
      apply((workflow) => moveWorkflowConnection(workflow, index, delta)),
    retargetConnection: (index, end, patch) =>
      apply((workflow) =>
        retargetWorkflowConnection(workflow, index, end, patch, pipelines())
      ),
    /**
     * Turn one connection conditional, or unconditional again. The seed reads
     * the connection's own source node: FR-023 bounds a condition to the
     * branching node or an ancestor, and the branching node always qualifies.
     */
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
      apply((workflow) => removeWorkflowConditionValue(workflow, index, valueIndex))
  };
}
