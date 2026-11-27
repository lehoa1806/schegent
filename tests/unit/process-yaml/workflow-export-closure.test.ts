// Feature 263 (FR-R5-F04) — deterministic export closure walks for composable Workflows.

import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowNode } from '../../../src/contracts/workflow-definitions';
import {
  referencedChildWorkflowOrder,
  referencedNodePhaseOrder,
  referencedPhaseClosure,
  referencedPhaseOrder,
  referencedWorkflowClosure
} from '../../../src/services/process-yaml/workflow-export-closure';

function phaseNode(nodeId: string, phaseId: string): WorkflowNode {
  return { nodeId, kind: 'phase', phaseId };
}

function workflowNode(nodeId: string, workflowId: string): WorkflowNode {
  return { nodeId, kind: 'workflow', workflowId };
}

function workflow(workflowId: string, nodes: readonly WorkflowNode[]): WorkflowDefinition {
  return {
    workflowId,
    name: workflowId,
    version: 1,
    nodes,
    connections: [],
    startNodeIds: nodes[0] ? [nodes[0].nodeId] : []
  };
}

describe('referencedPhaseOrder & referencedNodePhaseOrder', () => {
  it('returns distinct phaseIds in first-occurrence order across phase nodes', () => {
    expect(referencedPhaseOrder(['zulu', 'alpha', 'zulu', 'mike'])).toEqual([
      'zulu',
      'alpha',
      'mike'
    ]);
    const nodes = [
      phaseNode('a', 'zulu'),
      workflowNode('w', 'child'),
      phaseNode('b', 'alpha'),
      phaseNode('c', 'zulu')
    ];
    expect(referencedNodePhaseOrder(nodes)).toEqual(['zulu', 'alpha']);
  });
});

describe('referencedChildWorkflowOrder', () => {
  it('returns distinct workflowIds in first-occurrence order across workflow nodes', () => {
    const nodes = [
      workflowNode('a', 'draft'),
      phaseNode('p', 'outline'),
      workflowNode('b', 'review'),
      workflowNode('c', 'draft')
    ];
    expect(referencedChildWorkflowOrder(nodes)).toEqual(['draft', 'review']);
  });

  it('is authored order, not alphabetical', () => {
    const nodes = [
      workflowNode('a', 'zulu'),
      workflowNode('b', 'alpha'),
      workflowNode('c', 'mike')
    ];
    expect(referencedChildWorkflowOrder(nodes)).toEqual(['zulu', 'alpha', 'mike']);
  });
});

describe('referencedWorkflowClosure (pre-order depth-first)', () => {
  it('traverses nested child Workflows in pre-order depth-first order excluding root', () => {
    const grandChild = workflow('grandchild', [phaseNode('g1', 'verify')]);
    const childA = workflow('child-a', [
      workflowNode('nested', 'grandchild'),
      phaseNode('a1', 'write')
    ]);
    const childB = workflow('child-b', [workflowNode('reused', 'grandchild')]);
    const root = workflow('root', [
      workflowNode('n1', 'child-a'),
      workflowNode('n2', 'child-b'),
      workflowNode('n3', 'child-a')
    ]);
    const map = new Map<string, WorkflowDefinition>([
      ['root', root],
      ['child-a', childA],
      ['child-b', childB],
      ['grandchild', grandChild]
    ]);

    expect(referencedWorkflowClosure(root, map).map((w) => w.workflowId)).toEqual([
      'child-a',
      'grandchild',
      'child-b'
    ]);
  });

  it('terminates on cyclic child references without duplicating ids', () => {
    const childA = workflow('child-a', [workflowNode('n', 'child-b')]);
    const childB = workflow('child-b', [workflowNode('n', 'child-a')]);
    const root = workflow('root', [workflowNode('n', 'child-a')]);
    const map = new Map<string, WorkflowDefinition>([
      ['root', root],
      ['child-a', childA],
      ['child-b', childB]
    ]);

    expect(referencedWorkflowClosure(root, map).map((w) => w.workflowId)).toEqual([
      'child-a',
      'child-b'
    ]);
  });
});

describe('referencedPhaseClosure (across root + included workflows)', () => {
  it('returns distinct phaseIds in first-encountered order across root and child Workflows', () => {
    const root = workflow('root', [
      phaseNode('p1', 'outline'),
      workflowNode('w1', 'child-a'),
      phaseNode('p2', 'finalize')
    ]);
    const childA = workflow('child-a', [
      phaseNode('a1', 'write'),
      phaseNode('a2', 'outline')
    ]);
    const childB = workflow('child-b', [
      phaseNode('b1', 'critique'),
      phaseNode('b2', 'write')
    ]);

    expect(referencedPhaseClosure([root, childA, childB])).toEqual([
      'outline',
      'finalize',
      'write',
      'critique'
    ]);
  });

  it('keeps a Phase whose id matches a Workflow id — the levels do not share a seen-set', () => {
    const root = workflow('build', [workflowNode('w', 'child')]);
    const child = workflow('child', [phaseNode('p1', 'build'), phaseNode('p2', 'ship')]);

    expect(referencedPhaseClosure([root, child])).toEqual(['build', 'ship']);
  });
});
