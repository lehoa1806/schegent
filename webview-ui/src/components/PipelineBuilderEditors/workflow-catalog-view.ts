// The Workflows tab's list view helpers: status filter, search matching, and
// count line, mirroring `phase-catalog-view.ts` for full Phases/Workflows parity.

import type { DefinitionState } from '../../lib/snapshot-types';
import type { DefinitionValidity } from '../Builder/definition-row-state';

export type WorkflowStatusView = 'all' | 'active' | 'draft' | 'invalid';

export const WORKFLOW_STATUS_VIEWS: readonly {
  readonly id: WorkflowStatusView;
  readonly label: string;
}[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft', label: 'Draft' },
  { id: 'invalid', label: 'Invalid' }
];

const VIEW_STATES: Readonly<Record<'active' | 'draft', readonly DefinitionState[]>> = {
  active: ['active', 'active-with-draft'],
  draft: ['draft', 'active-with-draft']
};

export interface WorkflowRowFacts {
  readonly name: string;
  readonly workflowId: string;
  readonly description?: string;
  readonly sourceStatus: DefinitionValidity;
  readonly state?: DefinitionState;
}

function matchesView(row: WorkflowRowFacts, view: WorkflowStatusView): boolean {
  if (view === 'all') return true;
  if (view === 'invalid') return row.sourceStatus === 'invalid';
  return row.state !== undefined && VIEW_STATES[view].includes(row.state);
}

function matchesQuery(row: WorkflowRowFacts, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [row.name, row.workflowId, row.description ?? ''].some((text) =>
    text.toLowerCase().includes(needle)
  );
}

export function workflowRowVisible(
  row: WorkflowRowFacts,
  view: WorkflowStatusView,
  query: string
): boolean {
  return matchesView(row, view) && matchesQuery(row, query);
}

export function workflowCountLine(shown: number, total: number): string {
  const noun = total === 1 ? 'workflow' : 'workflows';
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

export function hasUnresolvedWorkflowNodes(
  nodes: readonly { readonly phaseId?: string; readonly workflowId?: string; readonly pipelineId?: string }[],
  effectivePhases: readonly { readonly phaseId: string }[],
  effectiveWorkflows: readonly { readonly workflowId: string }[],
  effectivePipelines: readonly { readonly pipelineId: string }[],
  rows: readonly { readonly workflowId: string }[]
): boolean {
  return nodes.some((node) => {
    if (node.phaseId) return !effectivePhases.some((p) => p.phaseId === node.phaseId);
    if (node.workflowId) {
      return (
        !effectiveWorkflows.some((w) => w.workflowId === node.workflowId) &&
        !rows.some((r) => r.workflowId === node.workflowId)
      );
    }
    if (node.pipelineId) return !effectivePipelines.some((p) => p.pipelineId === node.pipelineId);
    return false;
  });
}
