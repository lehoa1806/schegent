// FR-R5-F23 (SPEC-01, F23-T05, F23-T07) — Integration test for durable
// `ExecutionDecisionObservation` storage on `ConnectedWorkflowRun` and
// projection through `projectConnectedRun`.

import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { buildConditionContext } from '../../src/services/workflow-execution/condition-context';
import {
  buildRoutingDecisionObservation,
  selectNextNodes
} from '../../src/services/workflow-execution/next-node-selector';
import {
  appendAttempt,
  appendDecision,
  appendDecisionObservation,
  createConnectedRun
} from '../../src/state/connected-workflow-run';
import { projectConnectedRun } from '../../src/ui/sidebar/connected-run-projector';

describe('Workflow decision observation persistence and projection (FR-R5-F23)', () => {
  const graph: WorkflowDefinition = {
    workflowId: 'wf-obs-integration',
    name: 'Observation Integration',
    version: 1,
    nodes: [
      { nodeId: 'analyze', pipelineId: 'p-analyze' },
      { nodeId: 'fix', pipelineId: 'p-fix' },
      { nodeId: 'ship', pipelineId: 'p-ship' }
    ],
    connections: [
      {
        from: { nodeId: 'analyze', portId: 'verdict' },
        to: { nodeId: 'fix', portId: 'brief' },
        priority: 1,
        condition: {
          left: { source: 'node-output', nodeId: 'analyze', field: 'verdict' },
          operator: 'equals',
          right: 'needs-fix'
        }
      },
      {
        from: { nodeId: 'analyze', portId: 'verdict' },
        to: { nodeId: 'ship', portId: 'brief' },
        isDefault: true
      }
    ],
    startNodeIds: ['analyze']
  };

  const pipelines = {
    'p-analyze': {
      id: 'p-analyze',
      name: 'Analyze',
      phases: [{ id: 'analyze', name: 'Analyze' }]
    },
    'p-fix': {
      id: 'p-fix',
      name: 'Fix',
      phases: [{ id: 'fix', name: 'Fix' }]
    },
    'p-ship': {
      id: 'p-ship',
      name: 'Ship',
      phases: [{ id: 'ship', name: 'Ship' }]
    }
  };

  it('persists ExecutionDecisionObservation on ConnectedWorkflowRun and projects per-node and run-level observations', () => {
    const initial = createConnectedRun({
      connectedRunId: 'cr-obs-1',
      workflowId: 'wf-obs-integration',
      graph,
      pipelines,
      startedAt: 1_700_000_000_000
    });
    const withAttempt = appendAttempt(initial, 'analyze', {
      queueItemId: 'q-analyze-1',
      startedAt: 1_700_000_001_000
    });

    const context = buildConditionContext([
      {
        nodeId: 'analyze',
        status: 'completed',
        outputs: [{ name: 'verdict', status: 'resolved', reference: 'clean' }]
      }
    ]);

    const decision = selectNextNodes({
      graph,
      nodeId: 'analyze',
      attemptIndex: 0,
      decidedAt: 1_700_000_002_000,
      context
    });
    const observation = buildRoutingDecisionObservation(
      {
        runId: withAttempt.connectedRunId,
        graph,
        nodeId: 'analyze',
        attemptIndex: 0,
        decidedAt: 1_700_000_002_000,
        iteration: 2,
        maxIterations: 3,
        retryCondition: 'issues > 0',
        capOutcome: 'continue-degraded',
        context
      },
      decision
    );

    const recorded = appendDecision(withAttempt, decision, observation);
    expect(recorded.decisionObservations).toHaveLength(1);
    expect(recorded.decisionObservations?.[0]?.exitReason).toBe('condition-cleared');
    expect(recorded.decisionObservations?.[0]?.branches.map((b) => b.disposition)).toEqual([
      'condition-false',
      'fallback'
    ]);

    const projected = projectConnectedRun(recorded, () => 'completed');
    expect(projected.decisionObservations).toHaveLength(1);
    const analyzeNode = projected.nodes.find((n) => n.nodeId === 'analyze');
    expect(analyzeNode?.decisionObservation?.decisionId).toBe(observation.decisionId);
    expect(analyzeNode?.decisionObservation?.branches[0]?.disposition).toBe('condition-false');
    expect(analyzeNode?.decisionObservation?.branches[1]?.disposition).toBe('fallback');
  });

  it('remains backward-compatible when ConnectedWorkflowRun has no decisionObservations', () => {
    const initial = createConnectedRun({
      connectedRunId: 'cr-obs-legacy',
      workflowId: 'wf-obs-integration',
      graph,
      pipelines,
      startedAt: 1_700_000_000_000
    });
    const projected = projectConnectedRun(initial, () => 'completed');
    expect(projected.decisionObservations).toBeUndefined();
    expect(projected.nodes.every((n) => n.decisionObservation === undefined)).toBe(true);

    const obs = buildRoutingDecisionObservation({
      runId: initial.connectedRunId,
      graph,
      nodeId: 'analyze',
      attemptIndex: 0,
      decidedAt: 1_700_000_005_000,
      context: buildConditionContext([])
    });
    const updated = appendDecisionObservation(initial, obs);
    expect(updated.decisionObservations).toHaveLength(1);
  });
});
