// The canvas Builder's layout rules, tested away from any markup.
//
// The canvas replaced the list Builder, and with it went the one property a list
// gave for free: an authored array renders in authored order and every row is
// visible. A flow has to *decide* where a node goes, which is a rule, and a rule
// in markup is a rule nothing can test. So the whole decision lives in
// `workflow-flow-layout.ts` and this suite is what pins it.
//
// Two of these cases are the ones a canvas gets wrong in a way a list could not:
// a node with two parents (rendered twice, or dropped) and a cycle (rendered
// forever). Both are authorable in a draft the host would reject, so the canvas
// has to survive them long enough for the operator to see the defect and fix it.

import { describe, expect, it } from 'vitest';
import type { WorkflowConnection, WorkflowNode } from '../../lib/snapshot-types';
import {
  buildWorkflowFlowLayout,
  describeWorkflowBranch
} from '../PipelineBuilderEditors/workflow-flow-layout';

function node(nodeId: string, pipelineId = 'p1'): WorkflowNode {
  return { nodeId, pipelineId };
}

function edge(
  from: string,
  to: string,
  extra: Partial<Omit<WorkflowConnection, 'from' | 'to'>> = {}
): WorkflowConnection {
  return { from: { nodeId: from, portId: 'out' }, to: { nodeId: to, portId: 'in' }, ...extra };
}

const slotIds = (slots: readonly { readonly nodeId: string }[]): readonly string[] =>
  slots.map((slot) => slot.nodeId);

describe('buildWorkflowFlowLayout', () => {
  it('renders a linear graph in reachability order with ascending depth', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('b'), node('c')],
      connections: [edge('a', 'b'), edge('b', 'c')],
      startNodeIds: ['a']
    });

    expect(slotIds(layout.slots)).toEqual(['a', 'b', 'c']);
    expect(layout.slots.map((slot) => slot.depth)).toEqual([0, 1, 2]);
    expect(layout.detached).toHaveLength(0);
  });

  it('marks only the start nodes as starts, including one that is also a target', () => {
    // FR-015 — a start that another connection also targets is legal, not a defect.
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('b')],
      connections: [edge('a', 'b'), edge('b', 'a')],
      startNodeIds: ['a']
    });

    expect(layout.slots.find((slot) => slot.nodeId === 'a')?.isStart).toBe(true);
    expect(layout.slots.find((slot) => slot.nodeId === 'b')?.isStart).toBe(false);
  });

  it('orders branches by ascending priority, then by authored position', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('x'), node('y'), node('z')],
      connections: [
        edge('a', 'x', { priority: 2 }),
        edge('a', 'y', { priority: 1 }),
        edge('a', 'z', { priority: 2 })
      ],
      startNodeIds: ['a']
    });

    const branches = layout.slots[0].branches;
    expect(branches.map((branch) => branch.targetNodeId)).toEqual(['y', 'x', 'z']);
    // The offer order is the array position the host will report a defect against.
    expect(branches.map((branch) => branch.connectionIndex)).toEqual([1, 0, 2]);
  });

  it('places the default arm last even when its priority is lowest', () => {
    // Mirrors next-node-selector: the default is held back and considered only
    // when nothing explicit matched, so showing it first would misread the graph.
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('x'), node('y')],
      connections: [
        edge('a', 'x', { priority: 0, isDefault: true }),
        edge('a', 'y', { priority: 9 })
      ],
      startNodeIds: ['a']
    });

    expect(layout.slots[0].branches.map((branch) => branch.targetNodeId)).toEqual(['y', 'x']);
  });

  it('renders a join node once and marks the second inbound edge as a jump', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('l'), node('r'), node('join')],
      connections: [edge('a', 'l'), edge('a', 'r'), edge('l', 'join'), edge('r', 'join')],
      startNodeIds: ['a']
    });

    expect(slotIds(layout.slots).filter((id) => id === 'join')).toHaveLength(1);
    const fromLeft = layout.slots.find((slot) => slot.nodeId === 'l')?.branches[0];
    const fromRight = layout.slots.find((slot) => slot.nodeId === 'r')?.branches[0];
    expect(fromLeft?.isJump).toBe(false);
    expect(fromRight?.isJump).toBe(true);
  });

  it('terminates on a cycle and names its members', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('b'), node('c')],
      connections: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
      startNodeIds: ['a']
    });

    expect(slotIds(layout.slots)).toEqual(['a', 'b', 'c']);
    expect([...layout.cycleNodeIds].sort()).toEqual(['b', 'c']);
  });

  it('lists a node no start reaches as detached rather than dropping it', () => {
    // An unreachable node is a host defect (`unreachable-node`). It still has to
    // render, or the operator cannot select the thing they must delete or connect.
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('orphan')],
      connections: [],
      startNodeIds: ['a']
    });

    expect(slotIds(layout.slots)).toEqual(['a']);
    expect(slotIds(layout.detached)).toEqual(['orphan']);
    expect(layout.detached[0].isStart).toBe(false);
  });

  it('flags a node with no outgoing connection as terminal', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('b')],
      connections: [edge('a', 'b')],
      startNodeIds: ['a']
    });

    expect(layout.slots.map((slot) => slot.isTerminal)).toEqual([false, true]);
  });

  it('ignores an endpoint naming a node the draft does not hold', () => {
    // Authorable mid-edit; the host reports `unresolved-endpoint`. The canvas must
    // not throw before the operator can read that.
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a')],
      connections: [edge('a', 'ghost'), edge('ghost', 'a')],
      startNodeIds: ['a']
    });

    expect(slotIds(layout.slots)).toEqual(['a']);
    expect(layout.slots[0].branches).toHaveLength(0);
    expect(layout.detached).toHaveLength(0);
  });

  it('carries the authored node index so an edit addresses the right row', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('first'), node('second')],
      connections: [edge('second', 'first')],
      startNodeIds: ['second']
    });

    expect(layout.slots.map((slot) => [slot.nodeId, slot.nodeIndex])).toEqual([
      ['second', 1],
      ['first', 0]
    ]);
  });

  it('renders every start, in authored order', () => {
    const layout = buildWorkflowFlowLayout({
      nodes: [node('a'), node('b')],
      connections: [],
      startNodeIds: ['b', 'a']
    });

    expect(slotIds(layout.slots)).toEqual(['b', 'a']);
    expect(layout.detached).toHaveLength(0);
  });
});

describe('describeWorkflowBranch', () => {
  it('reads a run-status condition as the node and the status compared', () => {
    const branch = describeWorkflowBranch(
      edge('a', 'b', {
        condition: { left: { source: 'node-status', nodeId: 'a' }, operator: 'equals', right: 'completed' }
      })
    );

    expect(branch).toEqual({ kind: 'conditional', label: 'a status = completed' });
  });

  it('reads an output-field condition as the addressed field', () => {
    const branch = describeWorkflowBranch(
      edge('a', 'b', {
        condition: {
          left: { source: 'node-output', nodeId: 'a', field: 'verdict' },
          operator: 'notEquals',
          right: 'fail'
        }
      })
    );

    expect(branch).toEqual({ kind: 'conditional', label: 'a.verdict ≠ fail' });
  });

  it('renders a list right operand as a bracketed list', () => {
    const branch = describeWorkflowBranch(
      edge('a', 'b', {
        condition: {
          left: { source: 'node-output', nodeId: 'a', field: 'tag' },
          operator: 'in',
          right: ['x', 'y']
        }
      })
    );

    expect(branch.label).toBe('a.tag in [x, y]');
  });

  it('omits a right operand for exists, which takes none', () => {
    const branch = describeWorkflowBranch(
      edge('a', 'b', {
        condition: {
          left: { source: 'node-output', nodeId: 'a', field: 'report' },
          operator: 'exists'
        }
      })
    );

    expect(branch.label).toBe('a.report exists');
  });

  it('labels the default arm as the fallback it is', () => {
    expect(describeWorkflowBranch(edge('a', 'b', { isDefault: true }))).toEqual({
      kind: 'default',
      label: 'Otherwise'
    });
  });

  it('gives an unconditional connection no label to render', () => {
    expect(describeWorkflowBranch(edge('a', 'b'))).toEqual({
      kind: 'unconditional',
      label: null
    });
  });

  it('keeps the condition on a connection that is also the default', () => {
    // FR-027 — a default arm may carry a condition, and it is evaluated when the
    // arm is reached. Reporting it as an unconditional fallback would hide that.
    const branch = describeWorkflowBranch(
      edge('a', 'b', {
        isDefault: true,
        condition: { left: { source: 'node-status', nodeId: 'a' }, operator: 'equals', right: 'failed' }
      })
    );

    expect(branch).toEqual({ kind: 'default', label: 'Otherwise, if a status = failed' });
  });
});
