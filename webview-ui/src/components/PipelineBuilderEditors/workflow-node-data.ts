// The inspector's Data tab: where each input of a step comes from, read-only.
//
// It reads the three things the host counts as binding an input of a child
// Workflow (`missing-required-input` in the graph validator): a binding that names
// the step and the input, a connection that ends at that input (a return ends
// nowhere), and the item port of the step's own ForEach. A binding is named first
// when both exist. Display only: the rule that gates a save stays on the host, and
// bindings are still edited in the Workflow's inputs and outputs.

import type { WorkflowNode } from '../../lib/snapshot-types';
import type { MutableWorkflow } from './types';
import { nodeTitle } from './workflow-flow-view';

type StepData = Pick<MutableWorkflow, 'nodes' | 'connections' | 'bindings'>;

export interface StepInputRow {
  readonly portId: string;
  /** Where the value comes from, in words; null when nothing binds the input. */
  readonly from: string | null;
}

export const FOR_EACH_ITEM_SOURCE = 'Each item of the collection';

const SOURCE_SEPARATOR = ' · ';

function titleOf(workflow: StepData, nodeId: string): string {
  const node = workflow.nodes.find((entry) => entry.nodeId === nodeId);
  return node ? nodeTitle(node) : nodeId;
}

function inputSource(workflow: StepData, node: WorkflowNode, portId: string): string | null {
  for (const binding of workflow.bindings ?? []) {
    if (binding.kind !== 'input' || binding.nodeId !== node.nodeId || binding.inputKey !== portId) continue;
    const source = binding.source;
    return source.from === 'workflow-input'
      ? `Workflow input ${source.portId}`
      : `${titleOf(workflow, source.nodeId)}${SOURCE_SEPARATOR}${source.portId}`;
  }
  const connection = workflow.connections.find(
    (entry) => entry.to.kind !== 'return' && entry.to.nodeId === node.nodeId && entry.to.portId === portId
  );
  if (connection) {
    const title = titleOf(workflow, connection.from.nodeId);
    return connection.from.portId === undefined ? title : `${title}${SOURCE_SEPARATOR}${connection.from.portId}`;
  }
  if (node.control?.kind === 'for-each' && node.control.itemInputPortId === portId) return FOR_EACH_ITEM_SOURCE;
  return null;
}

function withExtras(declared: readonly string[], named: readonly string[]): readonly string[] {
  const out = [...declared];
  for (const key of named) if (!out.includes(key)) out.push(key);
  return out;
}

/**
 * One row per input the step's target declares, then one per input only a binding
 * names (a Phase declares no ports, so its rows are its bindings).
 */
export function stepInputRows(workflow: StepData, index: number, declared: readonly string[]): readonly StepInputRow[] {
  const node = workflow.nodes.at(index);
  if (node === undefined) return [];
  const named = (workflow.bindings ?? []).flatMap((binding) =>
    binding.kind === 'input' && binding.nodeId === node.nodeId ? [binding.inputKey] : []
  );
  return withExtras(declared, named).map((portId) => ({ portId, from: inputSource(workflow, node, portId) }));
}

/** The outputs the step's target declares, then the step outputs only a binding names. */
export function stepOutputIds(workflow: StepData, index: number, declared: readonly string[]): readonly string[] {
  const node = workflow.nodes.at(index);
  if (node === undefined) return [];
  const named = (workflow.bindings ?? []).flatMap((binding) =>
    binding.kind === 'output' && binding.nodeId === node.nodeId
      ? [binding.sourcePortId ?? binding.outputKey ?? binding.portId]
      : []
  );
  return withExtras(declared, named);
}
