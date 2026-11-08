import { describe, expect, it } from 'vitest';
import {
  MAX_CONTROL_NESTING_DEPTH,
  MAX_WORKFLOW_CLOSURE_DEFINITIONS,
  MAX_WORKFLOW_EXPANDED_NODES,
  MAX_WORKFLOW_NESTING_DEPTH,
  orderWorkflowItemsTopologically,
  resolveWorkflowClosure
} from '../../../src/config/workflow-closure-resolver';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

function phase(phaseId: string): PhaseDefinition {
  return {
    phaseId,
    name: phaseId,
    version: 1,
    instruction: `Run ${phaseId}`
  };
}

function phaseWorkflow(workflowId: string, phaseIds: readonly string[]): WorkflowDefinition {
  return {
    workflowId,
    name: workflowId,
    version: 1,
    nodes: phaseIds.map((phaseId, index) => ({
      nodeId: `n${index + 1}`,
      kind: 'phase' as const,
      phaseId
    })),
    connections: phaseIds.slice(1).map((_, index) => ({
      from: { nodeId: `n${index + 1}` },
      to: { nodeId: `n${index + 2}` }
    })),
    startNodeIds: phaseIds.length > 0 ? ['n1'] : []
  };
}

describe('workflow-closure-resolver (FR-R5-F01-T04)', () => {
  it('resolves a nested child workflow closure and returns topological child-before-parent order', () => {
    const effectivePhases = [phase('specify'), phase('plan'), phase('implement')];
    const leaf = phaseWorkflow('leaf-wf', ['specify', 'plan']);
    const parent: WorkflowDefinition = {
      workflowId: 'parent-wf',
      name: 'Parent Workflow',
      version: 1,
      nodes: [
        { nodeId: 'call-leaf', kind: 'workflow', workflowId: 'leaf-wf' },
        { nodeId: 'run-impl', kind: 'phase', phaseId: 'implement' }
      ],
      connections: [{ from: { nodeId: 'call-leaf' }, to: { nodeId: 'run-impl' } }],
      startNodeIds: ['call-leaf']
    };
    const effectiveWorkflows = [leaf, parent];

    const result = resolveWorkflowClosure(parent, { effectivePhases, effectiveWorkflows });

    expect(result.errors).toEqual([]);
    expect(result.topologicalWorkflowIds).toEqual(['leaf-wf', 'parent-wf']);
    expect(result.referencedPhaseIds).toEqual(['specify', 'plan', 'implement']);
    expect(result.maxDepthReached).toBe(1);
    expect(result.closureSize).toBe(4);
    expect(result.expandedNodeCount).toBe(4);
  });

  it('rejects self-recursive and mutually recursive workflow inclusion with workflow-inclusion-cycle', () => {
    const selfRecursive: WorkflowDefinition = {
      workflowId: 'self-wf',
      name: 'Self Recursive',
      version: 1,
      nodes: [{ nodeId: 'self', kind: 'workflow', workflowId: 'self-wf' }],
      connections: [],
      startNodeIds: ['self']
    };
    const selfResult = resolveWorkflowClosure(selfRecursive, {
      effectivePhases: [],
      effectiveWorkflows: [selfRecursive]
    });
    expect(selfResult.errors).toEqual([
      expect.objectContaining({
        field: 'nodes[0].workflowId',
        code: 'workflow-inclusion-cycle'
      })
    ]);

    const wfA: WorkflowDefinition = {
      workflowId: 'wf-a',
      name: 'WF A',
      version: 1,
      nodes: [{ nodeId: 'to-b', kind: 'workflow', workflowId: 'wf-b' }],
      connections: [],
      startNodeIds: ['to-b']
    };
    const wfB: WorkflowDefinition = {
      workflowId: 'wf-b',
      name: 'WF B',
      version: 1,
      nodes: [{ nodeId: 'to-a', kind: 'workflow', workflowId: 'wf-a' }],
      connections: [],
      startNodeIds: ['to-a']
    };
    const mutualResult = resolveWorkflowClosure(wfA, {
      effectivePhases: [],
      effectiveWorkflows: [wfA, wfB]
    });
    expect(mutualResult.errors).toEqual([
      expect.objectContaining({
        field: 'nodes[0].workflowId',
        code: 'workflow-inclusion-cycle'
      })
    ]);
  });

  it('enforces MAX_WORKFLOW_NESTING_DEPTH = 8 with workflow-depth-exceeded', () => {
    expect(MAX_WORKFLOW_NESTING_DEPTH).toBe(8);
    const effectivePhases = [phase('p1')];
    const effectiveWorkflows: WorkflowDefinition[] = [];

    // Depth 9 chain: wf-0 -> wf-1 -> ... -> wf-9 (phase p1)
    const leaf = phaseWorkflow('wf-9', ['p1']);
    effectiveWorkflows.push(leaf);
    for (let i = 8; i >= 0; i -= 1) {
      const wf: WorkflowDefinition = {
        workflowId: `wf-${i}`,
        name: `WF ${i}`,
        version: 1,
        nodes: [{ nodeId: 'child', kind: 'workflow', workflowId: `wf-${i + 1}` }],
        connections: [],
        startNodeIds: ['child']
      };
      effectiveWorkflows.push(wf);
    }

    const root = effectiveWorkflows.find((w) => w.workflowId === 'wf-0')!;
    const result = resolveWorkflowClosure(root, { effectivePhases, effectiveWorkflows });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: 'nodes[0].workflowId',
        code: 'workflow-depth-exceeded'
      })
    );
  });

  it('enforces MAX_WORKFLOW_CLOSURE_DEFINITIONS = 64 with workflow-closure-exceeded', () => {
    expect(MAX_WORKFLOW_CLOSURE_DEFINITIONS).toBe(64);
    const effectivePhases = [phase('p1')];
    const effectiveWorkflows: WorkflowDefinition[] = [];
    const childNodes = [];
    for (let i = 1; i <= 64; i += 1) {
      const child = phaseWorkflow(`child-${i}`, ['p1']);
      effectiveWorkflows.push(child);
      childNodes.push({
        nodeId: `n-${i}`,
        kind: 'workflow' as const,
        workflowId: child.workflowId
      });
    }
    const root: WorkflowDefinition = {
      workflowId: 'root-wf',
      name: 'Root WF',
      version: 1,
      nodes: childNodes,
      connections: [],
      startNodeIds: ['n-1']
    };
    effectiveWorkflows.push(root);

    const result = resolveWorkflowClosure(root, { effectivePhases, effectiveWorkflows });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'workflow-closure-exceeded'
      })
    );
  });

  it('enforces MAX_WORKFLOW_EXPANDED_NODES = 256 with workflow-expansion-exceeded', () => {
    expect(MAX_WORKFLOW_EXPANDED_NODES).toBe(256);
    const effectivePhases = [phase('p1')];
    // Child workflow has 30 phase nodes; root calls it 9 times (9 + 9*30 = 279 > 256)
    const thirtyPhases = Array.from({ length: 30 }, () => 'p1');
    const child = phaseWorkflow('heavy-child', thirtyPhases);
    const rootNodes = Array.from({ length: 9 }, (_, index) => ({
      nodeId: `call-${index + 1}`,
      kind: 'workflow' as const,
      workflowId: 'heavy-child'
    }));
    const root: WorkflowDefinition = {
      workflowId: 'root-heavy',
      name: 'Root Heavy',
      version: 1,
      nodes: rootNodes,
      connections: [],
      startNodeIds: ['call-1']
    };
    const effectiveWorkflows = [child, root];

    const result = resolveWorkflowClosure(root, { effectivePhases, effectiveWorkflows });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'workflow-expansion-exceeded'
      })
    );
  });

  it('reports unknown-phase, phase-invalid, unknown-workflow, and workflow-invalid', () => {
    const root: WorkflowDefinition = {
      workflowId: 'root-defects',
      name: 'Root Defects',
      version: 1,
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'missing-phase' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'broken-phase' },
        { nodeId: 'n3', kind: 'workflow', workflowId: 'missing-wf' },
        { nodeId: 'n4', kind: 'workflow', workflowId: 'broken-wf' }
      ],
      connections: [],
      startNodeIds: ['n1']
    };
    const result = resolveWorkflowClosure(root, {
      effectivePhases: [],
      invalidPhases: new Map([['broken-phase', 'invalid']]),
      effectiveWorkflows: [],
      invalidWorkflows: new Map([['broken-wf', 'invalid']])
    });

    expect(result.errors.map((e) => `${e.field}:${e.code}`)).toEqual([
      'nodes[0].phaseId:unknown-phase',
      'nodes[1].phaseId:phase-invalid',
      'nodes[2].workflowId:unknown-workflow',
      'nodes[3].workflowId:workflow-invalid'
    ]);
  });

  it('orders workflow items topologically (children before parents)', () => {
    const items = [
      { id: 'parent', childIds: ['child-a', 'child-b'] },
      { id: 'child-b', childIds: ['leaf'] },
      { id: 'child-a', childIds: ['leaf'] },
      { id: 'leaf', childIds: [] }
    ];
    const ordered = orderWorkflowItemsTopologically(
      items,
      (item) => item.id,
      (item) => item.childIds
    );
    expect(ordered.map((item) => item.id)).toEqual(['leaf', 'child-a', 'child-b', 'parent']);
  });

  it('enforces MAX_CONTROL_NESTING_DEPTH = 2 (control depth 2 passes, control depth 3 fails with control-nesting-depth-exceeded)', () => {
    expect(MAX_CONTROL_NESTING_DEPTH).toBe(2);
    const effectivePhases = [phase('p1')];
    const until = {
      version: 1 as const,
      kind: 'typed' as const,
      test: {
        left: { source: 'result-field' as const, fieldId: 'ok' },
        operator: 'equals' as const,
        right: true
      }
    };

    const leaf = phaseWorkflow('wf-leaf', ['p1']);
    const level2: WorkflowDefinition = {
      workflowId: 'wf-level-2',
      name: 'Level 2',
      version: 1,
      nodes: [
        {
          nodeId: 'for-each-leaf',
          kind: 'workflow',
          workflowId: 'wf-leaf',
          control: {
            version: 1,
            kind: 'for-each',
            collection: { source: 'workflow-input', portId: 'items' },
            itemInputPortId: 'item'
          }
        }
      ],
      connections: [],
      startNodeIds: ['for-each-leaf']
    };
    const level1: WorkflowDefinition = {
      workflowId: 'wf-level-1',
      name: 'Level 1',
      version: 1,
      nodes: [
        {
          nodeId: 'repeat-l2',
          kind: 'workflow',
          workflowId: 'wf-level-2',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 3,
            until,
            carry: []
          }
        }
      ],
      connections: [],
      startNodeIds: ['repeat-l2']
    };

    const depth2Result = resolveWorkflowClosure(level1, {
      effectivePhases,
      effectiveWorkflows: [leaf, level2, level1]
    });
    expect(depth2Result.ok).toBe(true);
    expect(depth2Result.maxControlDepthReached).toBe(2);
    expect(depth2Result.errors).toEqual([]);

    const level0: WorkflowDefinition = {
      workflowId: 'wf-level-0',
      name: 'Level 0 (Depth 3)',
      version: 1,
      nodes: [
        {
          nodeId: 'repeat-l1',
          kind: 'workflow',
          workflowId: 'wf-level-1',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 2,
            until,
            carry: []
          }
        }
      ],
      connections: [],
      startNodeIds: ['repeat-l1']
    };
    const depth3Result = resolveWorkflowClosure(level0, {
      effectivePhases,
      effectiveWorkflows: [leaf, level2, level1, level0]
    });
    expect(depth3Result.ok).toBe(false);
    expect(depth3Result.errors).toContainEqual(
      expect.objectContaining({
        code: 'control-nesting-depth-exceeded'
      })
    );
  });
});
