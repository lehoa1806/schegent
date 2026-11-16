// The inspector's Data tab: where each input of a step comes from.
//
// The host decides whether a child Workflow's required input is bound
// (`missing-required-input`): a binding that names the step and the input, a
// connection that ends at that input, or the item port of a ForEach. This view only
// reads the same three, so the table agrees with the defect the save would raise.

import { describe, expect, it } from 'vitest';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import { FOR_EACH_ITEM_SOURCE, stepInputRows, stepOutputIds } from '../PipelineBuilderEditors/workflow-node-data';

type StepData = Pick<MutableWorkflow, 'nodes' | 'connections' | 'bindings'>;

const WORKFLOW: StepData = {
  nodes: [
    { nodeId: 'draft', kind: 'phase', phaseId: 'p-draft', label: 'Draft notes' },
    {
      nodeId: 'call',
      kind: 'workflow',
      workflowId: 'child',
      control: {
        version: 1,
        kind: 'for-each',
        collection: { source: 'workflow-input', portId: 'itemsFile' },
        itemInputPortId: 'item'
      }
    },
    { nodeId: 'ship', kind: 'phase', phaseId: 'p-ship' }
  ],
  connections: [
    { from: { nodeId: 'draft', portId: 'notes' }, to: { nodeId: 'call', portId: 'notes' } },
    { from: { nodeId: 'ship' }, to: { nodeId: 'call', portId: 'brief' } },
    { from: { nodeId: 'draft' }, to: { nodeId: 'call', portId: 'returned', kind: 'return' } }
  ],
  bindings: [
    { kind: 'input', nodeId: 'call', inputKey: 'brief', source: { from: 'workflow-input', portId: 'request' } },
    { kind: 'input', nodeId: 'call', inputKey: 'summary', source: { from: 'node-output', nodeId: 'draft', portId: 'summary' } },
    { kind: 'input', nodeId: 'call', inputKey: 'extra', source: { from: 'node-output', nodeId: 'gone', portId: 'text' } },
    { kind: 'input', nodeId: 'ship', inputKey: 'report', source: { from: 'workflow-input', portId: 'report' } },
    { kind: 'output', nodeId: 'call', portId: 'result', outputKey: 'verdict' },
    { kind: 'output', nodeId: 'call', portId: 'notes' }
  ]
};

describe('stepInputRows', () => {
  it('names the source of every declared input, then the inputs only a binding names', () => {
    expect(stepInputRows(WORKFLOW, 1, ['brief', 'summary', 'notes', 'item', 'returned', 'missing'])).toEqual([
      { portId: 'brief', from: 'Workflow input request' },
      { portId: 'summary', from: 'Draft notes · summary' },
      { portId: 'notes', from: 'Draft notes · notes' },
      { portId: 'item', from: FOR_EACH_ITEM_SOURCE },
      { portId: 'returned', from: null },
      { portId: 'missing', from: null },
      { portId: 'extra', from: 'gone · text' }
    ]);
  });

  it('prefers a binding over a connection into the same input, as the save does not care which', () => {
    expect(stepInputRows(WORKFLOW, 1, ['brief']).at(0)?.from).toBe('Workflow input request');
  });

  it('names a connection from a step without a port by the step alone', () => {
    const plain: StepData = { ...WORKFLOW, bindings: [] };
    expect(stepInputRows(plain, 1, ['brief'])).toEqual([{ portId: 'brief', from: 'ship' }]);
  });

  it('lists what bindings feed a Phase step, which declares no ports of its own', () => {
    expect(stepInputRows(WORKFLOW, 2, [])).toEqual([{ portId: 'report', from: 'Workflow input report' }]);
  });

  it('reads a ForEach item port only on the step that carries the ForEach', () => {
    expect(stepInputRows(WORKFLOW, 0, ['item'])).toEqual([{ portId: 'item', from: null }]);
  });

  it('has no rows for a step that is not there', () => {
    expect(stepInputRows(WORKFLOW, 9, ['brief'])).toEqual([]);
  });
});

describe('stepOutputIds', () => {
  it('lists the declared outputs, then the step outputs only a binding names', () => {
    expect(stepOutputIds(WORKFLOW, 1, ['notes', 'log'])).toEqual(['notes', 'log', 'verdict']);
  });

  it('has none for a step that is not there', () => {
    expect(stepOutputIds(WORKFLOW, 9, ['notes'])).toEqual([]);
  });
});
