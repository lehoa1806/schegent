// Feature 088 (T003, US1) — the connected-run aggregate's invariants.
//
// Seven properties, one per data-model.md invariant. They are asserted here
// rather than in the coordinator because they hold at construction and at every
// write, and a coordinator test can only ever sample the paths it happens to
// exercise.

import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';
import {
  COMPARED_MAX_LENGTH,
  ConnectedRunInvariantError,
  appendAttempt,
  appendDecision,
  assertConnectedRunInvariants,
  createConnectedRun,
  renderCompared,
  type ConnectedWorkflowRun,
  type RoutingDecision
} from '../../../src/state/connected-workflow-run';

function graph(): WorkflowDefinition {
  return {
    workflowId: 'wf-triage',
    name: 'Triage',
    version: 1,
    nodes: [
      { nodeId: 'n-triage', pipelineId: 'p-triage' },
      { nodeId: 'n-fix', pipelineId: 'p-fix' },
      { nodeId: 'n-escalate', pipelineId: 'p-fix' }
    ],
    connections: [
      {
        from: { nodeId: 'n-triage', portId: 'verdict' },
        to: { nodeId: 'n-fix', portId: 'report' },
        condition: {
          left: { source: 'node-output', nodeId: 'n-triage', field: 'verdict' },
          operator: 'equals',
          right: 'fixable'
        }
      },
      {
        from: { nodeId: 'n-triage', portId: 'verdict' },
        to: { nodeId: 'n-escalate', portId: 'report' },
        isDefault: true
      }
    ],
    startNodeIds: ['n-triage']
  };
}

function pipelines(): Record<string, WorkflowRunPipeline> {
  return {
    'p-triage': { id: 'p-triage', name: 'Triage', phases: [{ id: 'specify', name: 'Specify' }] },
    'p-fix': { id: 'p-fix', name: 'Fix', phases: [{ id: 'implement', name: 'Implement' }] }
  };
}

function newRun(): ConnectedWorkflowRun {
  return createConnectedRun({
    connectedRunId: 'cr-1',
    workflowId: 'wf-triage',
    graph: graph(),
    pipelines: pipelines(),
    startedAt: 1_000
  });
}

function started(): ConnectedWorkflowRun {
  return appendAttempt(newRun(), 'n-triage', { queueItemId: 'q-1', startedAt: 1_001 });
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    nodeId: 'n-triage',
    attemptIndex: 0,
    decidedAt: 2_000,
    operands: [
      { source: 'node-output', nodeId: 'n-triage', field: 'verdict', resolved: true, compared: 'fixable' }
    ],
    connections: [
      { index: 0, matched: true, isDefault: false },
      { index: 1, matched: false, isDefault: true }
    ],
    defaultApplied: false,
    eligible: [0],
    ...overrides
  };
}

describe('connected run — invariant 1: frozen means frozen', () => {
  it('deep-freezes the graph snapshot', () => {
    const run = newRun();
    expect(Object.isFrozen(run.graph)).toBe(true);
    expect(Object.isFrozen(run.graph.nodes)).toBe(true);
    expect(Object.isFrozen(run.graph.nodes[0])).toBe(true);
    expect(Object.isFrozen(run.graph.connections[0]?.condition)).toBe(true);
    expect(() => {
      (run.graph.nodes[0] as { pipelineId: string }).pipelineId = 'p-other';
    }).toThrow(TypeError);
  });

  it('deep-freezes every referenced Pipeline', () => {
    const run = newRun();
    expect(Object.isFrozen(run.pipelines)).toBe(true);
    expect(Object.isFrozen(run.pipelines['p-fix'])).toBe(true);
    expect(Object.isFrozen(run.pipelines['p-fix']?.phases)).toBe(true);
    expect(Object.isFrozen(run.pipelines['p-fix']?.phases[0])).toBe(true);
  });

  it('copies rather than aliases, so a later catalog edit cannot reach in', () => {
    const source = graph();
    const sourcePipelines = pipelines();
    const run = createConnectedRun({
      connectedRunId: 'cr-1',
      workflowId: 'wf-triage',
      graph: source,
      pipelines: sourcePipelines,
      startedAt: 1_000
    });
    (source.nodes as { nodeId: string; pipelineId: string }[]).push({
      nodeId: 'n-late',
      pipelineId: 'p-fix'
    });
    delete sourcePipelines['p-fix'];
    expect(run.graph.nodes).toHaveLength(3);
    expect(run.pipelines['p-fix']).toBeDefined();
  });

  it('leaves the graph and pipelines untouched across mutations', () => {
    const run = started();
    const next = appendDecision(run, decision());
    expect(next.graph).toBe(run.graph);
    expect(next.pipelines).toBe(run.pipelines);
  });
});

describe('connected run — invariant 2: attempts only grow', () => {
  it('appends without disturbing earlier entries', () => {
    const first = started();
    const second = appendAttempt(first, 'n-triage', { queueItemId: 'q-2', startedAt: 1_500 });
    expect(second.nodes['n-triage']?.attempts).toHaveLength(2);
    expect(second.nodes['n-triage']?.attempts[0]).toEqual({ queueItemId: 'q-1', startedAt: 1_001 });
    expect(second.nodes['n-triage']?.attempts[1]?.queueItemId).toBe('q-2');
  });

  it('leaves the prior aggregate unchanged', () => {
    const first = started();
    appendAttempt(first, 'n-triage', { queueItemId: 'q-2', startedAt: 1_500 });
    expect(first.nodes['n-triage']?.attempts).toHaveLength(1);
  });

  it('creates a node record only on its first attempt, and never empty', () => {
    const run = newRun();
    expect(run.nodes).toEqual({});
    expect(started().nodes['n-triage']?.attempts).toHaveLength(1);
  });

  it('refuses an attempt on a node the frozen graph does not contain', () => {
    expect(() => appendAttempt(newRun(), 'n-ghost', { queueItemId: 'q-9', startedAt: 1 })).toThrow(
      ConnectedRunInvariantError
    );
  });

  it('refuses a node record whose attempts are empty', () => {
    const run = started();
    expect(() =>
      assertConnectedRunInvariants({
        ...run,
        nodes: { ...run.nodes, 'n-fix': { nodeId: 'n-fix', attempts: [] } }
      })
    ).toThrow(ConnectedRunInvariantError);
  });
});

describe('connected run — invariant 4: decisions only grow', () => {
  it('appends chronologically and preserves earlier decisions', () => {
    const run = appendDecision(started(), decision());
    const next = appendDecision(run, decision({ decidedAt: 3_000 }));
    expect(next.decisions).toHaveLength(2);
    expect(next.decisions[0]?.decidedAt).toBe(2_000);
    expect(run.decisions).toHaveLength(1);
  });

  it('refuses a decision that references an attempt which does not exist', () => {
    expect(() => appendDecision(started(), decision({ attemptIndex: 4 }))).toThrow(
      ConnectedRunInvariantError
    );
    expect(() => appendDecision(started(), decision({ nodeId: 'n-fix' }))).toThrow(
      ConnectedRunInvariantError
    );
  });

  it('refuses a connection outcome outside the frozen graph', () => {
    expect(() =>
      appendDecision(
        started(),
        decision({ connections: [{ index: 7, matched: false, isDefault: false }], eligible: [] })
      )
    ).toThrow(ConnectedRunInvariantError);
  });

  it('refuses an eligible index that no connection outcome names', () => {
    expect(() => appendDecision(started(), decision({ eligible: [1, 5] }))).toThrow(
      ConnectedRunInvariantError
    );
  });

  it('refuses defaultApplied while an explicit condition matched (FR-027)', () => {
    expect(() => appendDecision(started(), decision({ defaultApplied: true }))).toThrow(
      ConnectedRunInvariantError
    );
  });
});

describe('connected run — invariant 5: revision strictly increases', () => {
  it('increments by exactly one per accepted mutation', () => {
    const run = newRun();
    expect(run.revision).toBe(1);
    const withAttempt = appendAttempt(run, 'n-triage', { queueItemId: 'q-1', startedAt: 1_001 });
    expect(withAttempt.revision).toBe(2);
    expect(appendDecision(withAttempt, decision()).revision).toBe(3);
  });

  it('refuses a revision that did not advance', () => {
    const run = started();
    expect(() => assertConnectedRunInvariants({ ...run, revision: 0 })).toThrow(
      ConnectedRunInvariantError
    );
  });
});

describe('connected run — invariant 6: no lifecycle duplication', () => {
  it('holds exactly the persisted field set and nothing lifecycle-shaped', () => {
    const run = appendDecision(started(), decision());
    expect(Object.keys(run).sort()).toEqual([
      'connectedRunId',
      'decisions',
      'graph',
      'nodes',
      'pipelines',
      'revision',
      'startedAt',
      'workflowId'
    ]);
    expect(Object.keys(run.nodes['n-triage'] ?? {}).sort()).toEqual(['attempts', 'nodeId']);
    expect(Object.keys(run.nodes['n-triage']?.attempts[0] ?? {}).sort()).toEqual([
      'queueItemId',
      'startedAt'
    ]);
  });

  it('refuses any field the aggregate does not declare', () => {
    const run = started();
    for (const key of ['status', 'phase', 'logs', 'outputs', 'currentNodeId']) {
      expect(() => assertConnectedRunInvariants({ ...run, [key]: 'x' } as ConnectedWorkflowRun)).toThrow(
        ConnectedRunInvariantError
      );
    }
    expect(() =>
      assertConnectedRunInvariants({
        ...run,
        nodes: { 'n-triage': { nodeId: 'n-triage', attempts: [{ queueItemId: 'q-1', startedAt: 1 }], status: 'running' } }
      } as unknown as ConnectedWorkflowRun)
    ).toThrow(ConnectedRunInvariantError);
  });
});

describe('connected run — invariant 7: no content', () => {
  it('caps the compared rendering and omits a longer one', () => {
    expect(COMPARED_MAX_LENGTH).toBe(64);
    expect(renderCompared('fixable')).toBe('fixable');
    expect(renderCompared(42)).toBe('42');
    expect(renderCompared(true)).toBe('true');
    expect(renderCompared('x'.repeat(COMPARED_MAX_LENGTH))).toHaveLength(COMPARED_MAX_LENGTH);
    expect(renderCompared('x'.repeat(COMPARED_MAX_LENGTH + 1))).toBeUndefined();
    expect(renderCompared(undefined)).toBeUndefined();
  });

  it('refuses an over-long compared value on a persisted decision', () => {
    const run = started();
    expect(() =>
      appendDecision(
        run,
        decision({
          operands: [
            {
              source: 'node-output',
              nodeId: 'n-triage',
              field: 'verdict',
              resolved: true,
              compared: 'x'.repeat(COMPARED_MAX_LENGTH + 1)
            }
          ]
        })
      )
    ).toThrow(ConnectedRunInvariantError);
  });

  it('refuses an absolute path in the only value-derived string there is', () => {
    const run = started();
    for (const compared of ['/Users/someone/secret/doc.md', 'C:\\Users\\someone\\doc.md']) {
      expect(() =>
        appendDecision(
          run,
          decision({
            operands: [
              { source: 'node-output', nodeId: 'n-triage', field: 'verdict', resolved: true, compared }
            ]
          })
        )
      ).toThrow(ConnectedRunInvariantError);
    }
  });

  it('carries no free-text field anywhere in the aggregate', () => {
    // The structural proof of FR-065: the only string fields are identifiers,
    // an output name, and the capped `compared`. There is no description, no
    // instructions, and no plan copy for operator-pasted text to reach.
    const run = appendDecision(started(), decision());
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk({ nodes: run.nodes, decisions: run.decisions, connectedRunId: run.connectedRunId });
    for (const value of strings) {
      expect(value.length).toBeLessThanOrEqual(COMPARED_MAX_LENGTH);
      expect(value.startsWith('/')).toBe(false);
    }
  });
});
