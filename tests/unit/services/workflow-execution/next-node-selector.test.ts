import { describe, expect, it } from 'vitest';
import { buildConditionContext } from '../../../../src/services/workflow-execution/condition-context';
import { selectNextTransition } from '../../../../src/services/workflow-execution/next-node-selector';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';

describe('selectNextTransition — priority routing, return edges, sink completion & failure handling (FR-R5-F02 T07)', () => {
  const graph: WorkflowDefinition = {
    workflowId: 'wf-routing',
    name: 'Routing Workflow',
    version: 1,
    nodes: [
      { nodeId: 'triage', kind: 'phase', phaseId: 'phase-triage' },
      { nodeId: 'fast-path', kind: 'phase', phaseId: 'phase-fast' },
      { nodeId: 'deep-path', kind: 'phase', phaseId: 'phase-deep' },
      { nodeId: 'fallback-path', kind: 'phase', phaseId: 'phase-fallback' }
    ],
    connections: [
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'deep-path' },
        priority: 2,
        condition: {
          left: { source: 'node-output', nodeId: 'triage', field: 'mode' },
          operator: 'equals',
          right: 'urgent'
        }
      },
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'fast-path' },
        priority: 1,
        handoff: 'manual',
        condition: {
          left: { source: 'node-output', nodeId: 'triage', field: 'mode' },
          operator: 'equals',
          right: 'urgent'
        }
      },
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'fallback-path' },
        isDefault: true
      },
      {
        from: { nodeId: 'fast-path' },
        to: { kind: 'return', nodeId: 'fast-path' }
      },
      {
        from: { nodeId: 'deep-path' },
        to: { kind: 'node', nodeId: 'fallback-path' },
        condition: {
          left: { source: 'node-output', nodeId: 'deep-path', field: 'verdict' },
          operator: 'equals',
          right: 'escalate'
        }
      }
    ],
    startNodeIds: ['triage']
  };

  it('selects the lowest numeric priority edge when multiple explicit conditions match', () => {
    const context = buildConditionContext([
      {
        nodeId: 'triage',
        status: 'completed',
        outputs: [{ name: 'mode', status: 'resolved', reference: 'urgent' }]
      }
    ]);

    const outcome = selectNextTransition({
      graph,
      nodeId: 'triage',
      attemptIndex: 1,
      decidedAt: 1_700_000_000_000,
      context
    });

    expect(outcome.outcome).toBe('transition');
    if (outcome.outcome !== 'transition') return;
    expect(outcome.target).toEqual({ kind: 'node', nodeId: 'fast-path' });
    expect(outcome.handoff).toBe('manual');
    expect(outcome.decision.defaultApplied).toBe(false);
  });

  it('applies the isDefault edge only when no explicit condition matched', () => {
    const context = buildConditionContext([
      {
        nodeId: 'triage',
        status: 'completed',
        outputs: [{ name: 'mode', status: 'resolved', reference: 'standard' }]
      }
    ]);

    const outcome = selectNextTransition({
      graph,
      nodeId: 'triage',
      attemptIndex: 1,
      decidedAt: 1_700_000_000_000,
      context
    });

    expect(outcome.outcome).toBe('transition');
    if (outcome.outcome !== 'transition') return;
    expect(outcome.target).toEqual({ kind: 'node', nodeId: 'fallback-path' });
    expect(outcome.handoff).toBe('auto');
    expect(outcome.decision.defaultApplied).toBe(true);
  });

  it('supports { kind: "return" } transition targets for early selected-path completion', () => {
    const context = buildConditionContext([
      {
        nodeId: 'fast-path',
        status: 'completed',
        outputs: []
      }
    ]);

    const outcome = selectNextTransition({
      graph,
      nodeId: 'fast-path',
      attemptIndex: 1,
      decidedAt: 1_700_000_000_000,
      context
    });

    expect(outcome.outcome).toBe('transition');
    if (outcome.outcome !== 'transition') return;
    expect(outcome.target).toEqual({ kind: 'return' });
  });

  it('detects terminal-sink completion when a completed node has zero outgoing connections', () => {
    const context = buildConditionContext([
      {
        nodeId: 'fallback-path',
        status: 'completed',
        outputs: []
      }
    ]);

    const outcome = selectNextTransition({
      graph,
      nodeId: 'fallback-path',
      attemptIndex: 1,
      decidedAt: 1_700_000_000_000,
      context
    });

    expect(outcome.outcome).toBe('terminal-sink');
  });

  it('returns no-eligible-transition when a completed non-sink node has outgoing edges but none match', () => {
    const context = buildConditionContext([
      {
        nodeId: 'deep-path',
        status: 'completed',
        outputs: [{ name: 'verdict', status: 'resolved', reference: 'done' }]
      }
    ]);

    const outcome = selectNextTransition({
      graph,
      nodeId: 'deep-path',
      attemptIndex: 1,
      decidedAt: 1_700_000_000_000,
      context
    });

    expect(outcome.outcome).toBe('no-eligible-transition');
  });

  it('returns unhandled-node-failure when a failed node attempt matches no recovery transition', () => {
    const context = buildConditionContext([
      {
        nodeId: 'deep-path',
        status: 'failed',
        outputs: []
      }
    ]);

    const outcome = selectNextTransition({
      graph,
      nodeId: 'deep-path',
      attemptIndex: 1,
      decidedAt: 1_700_000_000_000,
      context
    });

    expect(outcome.outcome).toBe('unhandled-node-failure');
  });
});
