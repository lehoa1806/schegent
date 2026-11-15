// Where the selection lands after a node moves, and what the status line says
// when the operator selects something.
//
// Selection addresses the authored node list by index, and a move shifts every
// node between the old place and the new one, so the selected node's index can
// change even when the selected node is not the one that moved. The move itself is
// `moveWorkflowNode`; this only has to agree with it.
//
// The status line names a selection in the words the canvas already gives it: a
// card by its title, an arm by the name its button carries. After a move it says
// where the step now stands in the saved order, which a card often does not show.

import { describe, expect, it } from 'vitest';
import type { WorkflowConnection, WorkflowNode } from '../../lib/snapshot-types';
import {
  connectionName,
  moveAnnouncement,
  selectionAfterMove,
  selectionAnnouncement
} from '../PipelineBuilderEditors/workflow-flow-view';

const nodeAt = (index: number) => ({ kind: 'node', index }) as const;

describe('selectionAfterMove', () => {
  it('follows the moved node', () => {
    expect(selectionAfterMove(nodeAt(1), 1, -1, 3)).toEqual(nodeAt(0));
    expect(selectionAfterMove(nodeAt(0), 0, 2, 3)).toEqual(nodeAt(2));
  });

  it('shifts a node the move passed over', () => {
    // [a, b, c] with a moved to the end is [b, c, a]: b was at 1 and is at 0.
    expect(selectionAfterMove(nodeAt(1), 0, 2, 3)).toEqual(nodeAt(0));
    // [a, b, c] with c moved to the front is [c, a, b]: a was at 0 and is at 1.
    expect(selectionAfterMove(nodeAt(0), 2, -2, 3)).toEqual(nodeAt(1));
  });

  it('leaves a node outside the moved span where it was', () => {
    expect(selectionAfterMove(nodeAt(2), 0, 1, 3)).toEqual(nodeAt(2));
  });

  it('changes nothing when the move falls off either end, as the move itself does', () => {
    expect(selectionAfterMove(nodeAt(0), 0, -1, 3)).toEqual(nodeAt(0));
    expect(selectionAfterMove(nodeAt(1), 2, 1, 3)).toEqual(nodeAt(1));
  });

  it('leaves a Workflow or a connection selection alone', () => {
    expect(selectionAfterMove({ kind: 'workflow' }, 0, 1, 3)).toEqual({ kind: 'workflow' });
    expect(selectionAfterMove({ kind: 'connection', index: 0 }, 0, 1, 3)).toEqual({
      kind: 'connection',
      index: 0
    });
  });
});

const NODES: readonly WorkflowNode[] = [
  { nodeId: 'plan', pipelineId: 'authoring', label: 'Plan' },
  { nodeId: 'review', pipelineId: 'authoring' }
];

const PLAIN: WorkflowConnection = { from: { nodeId: 'plan' }, to: { nodeId: 'review' } };

describe('connectionName', () => {
  it('names an arm as its button does, each end by its card’s title', () => {
    expect(connectionName(NODES, PLAIN)).toBe('Connection from Plan to review');
  });

  it('carries the branch’s chip and a manual handoff', () => {
    expect(connectionName(NODES, { ...PLAIN, isDefault: true, handoff: 'manual' })).toBe(
      'Branch from Plan to review: else, manual handoff'
    );
  });

  it('names an end the node list lacks by its identifier', () => {
    expect(connectionName(NODES, { from: { nodeId: 'plan' }, to: { nodeId: 'gone' } })).toBe(
      'Connection from Plan to gone'
    );
  });

  it('names a return’s far end as the return, not as the node its endpoint names', () => {
    // The run engine reads a return's endpoint without its node, so naming the node
    // would say the arm enters a card the run never reaches through it.
    const toReturn: WorkflowConnection = {
      from: { nodeId: 'plan' },
      to: { nodeId: 'review', kind: 'return' }
    };
    expect(connectionName(NODES, toReturn)).toBe('Connection from Plan to Return');
    expect(selectionAnnouncement(NODES, [toReturn], { kind: 'connection', index: 0 })).toBe(
      'Selected Connection from Plan to Return.'
    );
  });
});

describe('selectionAnnouncement', () => {
  it('names a selected card by its title', () => {
    expect(selectionAnnouncement(NODES, [PLAIN], nodeAt(0))).toBe('Selected Plan.');
    expect(selectionAnnouncement(NODES, [PLAIN], nodeAt(1))).toBe('Selected review.');
  });

  it('names a selected arm by its button’s name', () => {
    expect(selectionAnnouncement(NODES, [PLAIN], { kind: 'connection', index: 0 })).toBe(
      'Selected Connection from Plan to review.'
    );
  });

  it('says the Workflow is showing when nothing on the canvas is selected', () => {
    expect(selectionAnnouncement(NODES, [PLAIN], { kind: 'workflow' })).toBe(
      'Nothing selected. Showing the Workflow.'
    );
  });

  it('says the same for a selection that addresses nothing, as the inspector falls back', () => {
    expect(selectionAnnouncement(NODES, [PLAIN], nodeAt(5))).toBe(
      'Nothing selected. Showing the Workflow.'
    );
    expect(selectionAnnouncement(NODES, [], { kind: 'connection', index: 0 })).toBe(
      'Nothing selected. Showing the Workflow.'
    );
  });
});

describe('moveAnnouncement', () => {
  // Finding 93: a move changes a step's place in the saved order, and the canvas
  // places the steps a run can reach by their connections, so the moved card most
  // often stays where it was. The line says where the step went and why.
  const MOVED: readonly WorkflowNode[] = [
    { nodeId: 'plan', pipelineId: 'authoring', label: 'Plan' },
    { nodeId: 'ship', pipelineId: 'release', label: 'Ship' },
    { nodeId: 'review', pipelineId: 'authoring' }
  ];
  const NOTE = 'The canvas places the steps a run can reach by their connections, not by this order.';

  it('names the moved step by its title and its new place in the saved order', () => {
    expect(moveAnnouncement(MOVED, 'ship', 2)).toBe(
      `Moved Ship to position 2 of 3 in the saved step order. ${NOTE}`
    );
    expect(moveAnnouncement(MOVED, 'review', 1)).toBe(
      `Moved review to position 3 of 3 in the saved step order. ${NOTE}`
    );
  });

  it('says nothing when the step stands where it stood, or is gone', () => {
    expect(moveAnnouncement(MOVED, 'plan', 0)).toBeNull();
    expect(moveAnnouncement(MOVED, 'gone', 0)).toBeNull();
  });
});
