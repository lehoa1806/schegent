import { describe, expect, it } from 'vitest';
import {
  applyCollectionSelection,
  resolveNodeInputBindings,
  resolveWorkflowPublicOutputs
} from '../../../../src/services/workflow-execution/binding-resolver';
import {
  createInvocationFrame,
  recordNodeAttempt,
  type InvocationInputEnvelope,
  type NodeAttemptRecord
} from '../../../../src/state/connected-workflow-run';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';

function dummyEnvelope(invocationId: string, targetNodeId: string): InvocationInputEnvelope {
  return {
    envelopeId: `env-${invocationId}-${targetNodeId}`,
    invocationId,
    targetNodeId,
    source: 'binding',
    inputsByPort: {},
    localInputs: [],
    outputTargetOverrides: [],
    acceptedAt: 1_700_000_000_000
  };
}

function makeAttempt(
  overrides: Partial<NodeAttemptRecord> & Pick<NodeAttemptRecord, 'nodeId' | 'status'>
): NodeAttemptRecord {
  const invocationId = overrides.invocationId ?? 'inv-root';
  return {
    attemptId: overrides.attemptId ?? `att-${overrides.nodeId}-1`,
    attemptIndex: overrides.attemptIndex ?? 1,
    rootRunId: overrides.rootRunId ?? 'run-1',
    invocationId,
    parentInvocationId: overrides.parentInvocationId ?? null,
    nodePath: overrides.nodePath ?? `/${overrides.nodeId}`,
    nodeId: overrides.nodeId,
    nodeKind: overrides.nodeKind ?? 'phase',
    targetDefinitionId: overrides.targetDefinitionId ?? 'phase-1',
    status: overrides.status,
    startedAt: overrides.startedAt ?? 1_700_000_000_000,
    inputEnvelope: overrides.inputEnvelope ?? dummyEnvelope(invocationId, overrides.nodeId),
    declaredOutputs: overrides.declaredOutputs ?? {}
  };
}

describe('binding-resolver — explicit data bindings & collection selection (FR-R5-F02 T06)', () => {
  const workflow: WorkflowDefinition = {
    workflowId: 'wf-data',
    name: 'Data Binding Workflow',
    version: 1,
    inputs: [{ portId: 'topic', label: 'Topic', type: 'text', required: true }],
    outputs: [
      { portId: 'finalReport', label: 'Final Report', type: 'markdown', required: true },
      { portId: 'optionalNotes', label: 'Optional Notes', type: 'markdown', required: false }
    ],
    nodes: [
      { nodeId: 'gather', kind: 'phase', phaseId: 'phase-gather' },
      { nodeId: 'summarize', kind: 'phase', phaseId: 'phase-summarize' },
      { nodeId: 'unselected', kind: 'phase', phaseId: 'phase-unselected' }
    ],
    connections: [{ from: { nodeId: 'gather' }, to: { kind: 'node', nodeId: 'summarize' } }],
    bindings: [
      {
        kind: 'input',
        nodeId: 'gather',
        inputKey: 'query',
        source: { from: 'workflow-input', portId: 'topic' }
      },
      {
        kind: 'input',
        nodeId: 'summarize',
        inputKey: 'primaryDoc',
        source: { from: 'node-output', nodeId: 'gather', portId: 'docs' },
        selection: 'exactlyOne'
      },
      {
        kind: 'output',
        nodeId: 'summarize',
        portId: 'finalReport',
        outputKey: 'report'
      },
      {
        kind: 'output',
        nodeId: 'unselected',
        portId: 'optionalNotes',
        outputKey: 'notes'
      }
    ],
    startNodeIds: ['gather']
  };

  it('resolves workflow-input bindings from the active frame boundInputs only', () => {
    const frame = createInvocationFrame({
      invocationId: 'inv-root',
      rootRunId: 'run-1',
      parentInvocationId: null,
      parentCallNodeId: null,
      parentAttemptId: null,
      workflowId: 'wf-data',
      depth: 0,
      nodePath: '/gather',
      entryNodeId: 'gather',
      boundInputs: {
        topic: { portId: 'topic', type: 'text', value: 'Composable Runtime' },
        unreferencedInput: { portId: 'unreferencedInput', type: 'text', value: 'Secret' }
      },
      startedAt: 1_700_000_000_000
    });

    const result = resolveNodeInputBindings({
      workflow,
      frame,
      targetNodeId: 'gather'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.resolvedByPort)).toEqual(['query']);
    expect(result.resolvedByPort['query']?.value).toBe('Composable Runtime');
  });

  it('ignores failed or in-flight upstream attempts and binds only from completed attempts in the same frame', () => {
    let frame = createInvocationFrame({
      invocationId: 'inv-root',
      rootRunId: 'run-1',
      parentInvocationId: null,
      parentCallNodeId: null,
      parentAttemptId: null,
      workflowId: 'wf-data',
      depth: 0,
      nodePath: '/gather',
      entryNodeId: 'gather',
      boundInputs: {
        topic: { portId: 'topic', type: 'text', value: 'Composable Runtime' }
      },
      startedAt: 1_700_000_000_000
    });

    // Record only a failed attempt on `gather`: must NOT satisfy `summarize` binding
    frame = recordNodeAttempt(
      frame,
      makeAttempt({
        nodeId: 'gather',
        attemptIndex: 1,
        status: 'failed',
        declaredOutputs: {
          docs: { portId: 'docs', type: 'file-set', value: 'doc-1.md', items: ['doc-1.md'] }
        }
      })
    );

    const failedLookup = resolveNodeInputBindings({
      workflow,
      frame,
      targetNodeId: 'summarize'
    });
    expect(failedLookup.ok).toBe(false);
    if (!failedLookup.ok) {
      expect(failedLookup.code).toBe('missing-required-input');
    }

    // Record a completed retry attempt on `gather`: now satisfies the binding
    frame = recordNodeAttempt(
      frame,
      makeAttempt({
        attemptId: 'att-gather-2',
        nodeId: 'gather',
        attemptIndex: 2,
        status: 'completed',
        declaredOutputs: {
          docs: { portId: 'docs', type: 'file-set', value: 'doc-2.md', items: ['doc-2.md'] }
        }
      })
    );

    const completedLookup = resolveNodeInputBindings({
      workflow,
      frame,
      targetNodeId: 'summarize'
    });
    expect(completedLookup.ok).toBe(true);
    if (completedLookup.ok) {
      expect(completedLookup.resolvedByPort['primaryDoc']?.value).toBe('doc-2.md');
    }
  });

  it('enforces collectionSelection rules (first, last, exactlyOne) and fails on violations', () => {
    const multiItem = {
      portId: 'docs',
      type: 'file-set' as const,
      value: 'a.md',
      items: ['a.md', 'b.md']
    };
    const emptyItem = {
      portId: 'docs',
      type: 'file-set' as const,
      value: '',
      items: []
    };

    expect(applyCollectionSelection('first', multiItem, 'target')).toEqual({
      ok: true,
      value: { portId: 'target', type: 'file-set', value: 'a.md', items: ['a.md'] }
    });
    expect(applyCollectionSelection('last', multiItem, 'target')).toEqual({
      ok: true,
      value: { portId: 'target', type: 'file-set', value: 'b.md', items: ['b.md'] }
    });
    expect(applyCollectionSelection('exactlyOne', multiItem, 'target').ok).toBe(false);
    expect(applyCollectionSelection('exactlyOne', emptyItem, 'target').ok).toBe(false);
    expect(applyCollectionSelection('first', emptyItem, 'target').ok).toBe(false);
    expect(applyCollectionSelection('last', emptyItem, 'target').ok).toBe(false);
  });

  it('resolves required public outputs on return and allows required: false outputs to stay omitted on unselected branches', () => {
    let frame = createInvocationFrame({
      invocationId: 'inv-root',
      rootRunId: 'run-1',
      parentInvocationId: null,
      parentCallNodeId: null,
      parentAttemptId: null,
      workflowId: 'wf-data',
      depth: 0,
      nodePath: '/gather',
      entryNodeId: 'gather',
      boundInputs: {},
      startedAt: 1_700_000_000_000
    });

    // Missing required `finalReport` before `summarize` completes
    const missingResult = resolveWorkflowPublicOutputs({ workflow, frame });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.code).toBe('missing-required-output');
    }

    // Complete `summarize` while leaving `unselected` unvisited
    frame = recordNodeAttempt(
      frame,
      makeAttempt({
        nodeId: 'summarize',
        status: 'completed',
        declaredOutputs: {
          report: { portId: 'report', type: 'markdown', value: 'out/summary.md' }
        }
      })
    );

    const resolvedResult = resolveWorkflowPublicOutputs({ workflow, frame });
    expect(resolvedResult.ok).toBe(true);
    if (resolvedResult.ok) {
      expect(resolvedResult.resolvedByPort['finalReport']?.value).toBe('out/summary.md');
      expect(resolvedResult.resolvedByPort['optionalNotes']).toBeUndefined();
    }
  });
});

