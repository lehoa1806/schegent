// How a step runs: once, repeated until a result field matches, or once per item.
//
// The inspector's Control tab offers the three as one choice. Choosing Repeat or For
// each seeds the same default control the two checkboxes used to seed, so a step
// switched on in the redesigned tab saves exactly what it saved before.

import { describe, expect, it } from 'vitest';
import type { PortableWorkflowDefinition } from '../../lib/snapshot-types';
import {
  NODE_CONTROL_CHOICES,
  NODE_CONTROL_KINDS,
  controlForKind,
  controlKindOf,
  controlKindWord,
  defaultForEachControl,
  defaultRepeatControl
} from '../PipelineBuilderEditors/workflow-node-control';

const CHILD: PortableWorkflowDefinition = {
  workflowId: 'wf-child',
  name: 'Child',
  version: 1,
  inputs: [{ portId: 'itemPayload', label: 'Item', type: 'text', required: true }],
  outputs: [],
  nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'p1' }],
  connections: [],
  startNodeIds: ['n1'],
  decisionResults: {
    version: 1,
    fields: [{ fieldId: 'score', type: 'boolean', required: true }],
    bindings: [{ fieldId: 'score', source: { kind: 'node-result', nodeId: 'n1', fieldId: 'score' } }]
  }
};

describe('controlKindOf', () => {
  it('reads a step with no control as running once', () => {
    expect(controlKindOf({})).toBe('once');
  });

  it('reads the kind of the control the step carries', () => {
    expect(controlKindOf({ control: defaultRepeatControl(null) })).toBe('repeat');
    expect(controlKindOf({ control: defaultForEachControl(null) })).toBe('for-each');
  });
});

describe('the default controls', () => {
  it('repeats until the first decision result field of the child is true', () => {
    expect(defaultRepeatControl(CHILD)).toEqual({
      version: 1,
      kind: 'repeat',
      maxIterations: 3,
      until: {
        version: 1,
        kind: 'typed',
        test: { left: { source: 'result-field', fieldId: 'score' }, operator: 'equals', right: true }
      },
      carry: [],
      onExhausted: 'pause'
    });
  });

  it('falls back to an approved field when the child declares no decision results', () => {
    const test = defaultRepeatControl(null).until.test;
    expect('left' in test ? test.left : null).toEqual({ source: 'result-field', fieldId: 'approved' });
  });

  it('feeds each item to the first input port of the child', () => {
    expect(defaultForEachControl(CHILD)).toEqual({
      version: 1,
      kind: 'for-each',
      collection: { source: 'workflow-input', portId: 'itemsFile' },
      itemInputPortId: 'itemPayload',
      maxItems: 50,
      onItemError: 'stop'
    });
  });

  it('falls back to an item port when the child declares no inputs', () => {
    expect(defaultForEachControl(null).itemInputPortId).toBe('item');
  });
});

describe('controlForKind', () => {
  it('clears the control for a step that runs once', () => {
    expect(controlForKind('once', CHILD)).toBeUndefined();
  });

  it('seeds the default control of the chosen kind', () => {
    expect(controlForKind('repeat', CHILD)).toEqual(defaultRepeatControl(CHILD));
    expect(controlForKind('for-each', CHILD)).toEqual(defaultForEachControl(CHILD));
  });
});

describe('the choices', () => {
  it('offers every kind once, in the order the tab lists them', () => {
    expect(NODE_CONTROL_CHOICES.map((choice) => choice.kind)).toEqual([...NODE_CONTROL_KINDS]);
    expect(NODE_CONTROL_KINDS).toEqual(['once', 'repeat', 'for-each']);
  });

  it('names each looping kind in the words the discard warning uses', () => {
    expect(controlKindWord('repeat')).toBe('Repeat');
    expect(controlKindWord('for-each')).toBe('For each');
  });
});
