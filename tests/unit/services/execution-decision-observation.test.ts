// FR-R5-F23 (SPEC-01, D1) — Unit tests for `ExecutionDecisionObservation`,
// `buildPhaseTransitionObservation`, `resolvePhaseIterationSources`, and
// `evaluateBranchDispositions` / `buildRoutingDecisionObservation`.

import { describe, expect, it } from 'vitest';
import {
  describeBranchDisposition,
  describeExitReason,
  EXECUTION_BRANCH_DISPOSITIONS,
  EXECUTION_DECISION_EXIT_REASONS,
  EXECUTION_DECISION_OBSERVATION_VERSION,
  formatConditionSummary,
  formatPhaseRetrySummary,
  isExecutionDecisionObservation,
  validateExecutionDecisionObservation,
  type ExecutionDecisionObservation
} from '../../../src/contracts/execution-decision-observation';
import { buildPhaseTransitionObservation } from '../../../src/controller/phase';
import { resolveEffectiveLimits, resolvePhaseIterationSources } from '../../../src/services/effective-limits';
import { buildConditionContext } from '../../../src/services/workflow-execution/condition-context';
import {
  buildRoutingDecisionObservation,
  evaluateBranchDispositions,
  selectNextNodes,
  selectNextTransition
} from '../../../src/services/workflow-execution/next-node-selector';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

function validObservation(
  overrides: Partial<ExecutionDecisionObservation> = {}
): ExecutionDecisionObservation {
  return {
    version: EXECUTION_DECISION_OBSERVATION_VERSION,
    decisionId: 'run-1:triage:iter-1:1700000000000',
    runId: 'run-1',
    nodeId: 'triage',
    attemptId: 'run-1:root:triage:attempt-1',
    evaluatedAt: 1_700_000_000_000,
    iteration: 1,
    maxIterations: 3,
    retryCondition: 'remaining > 0',
    capOutcome: 'fail',
    noProgressThreshold: 2,
    settingSources: {
      maxIterations: 'workspace',
      capOutcome: 'phase',
      noProgressThreshold: 'default'
    },
    observedValues: {
      outcome: 'clean',
      remaining: 0
    },
    exitReason: 'condition-cleared',
    branches: [
      {
        connectionIndex: 0,
        targetNodeId: 'implement',
        isDefault: false,
        priority: 1,
        disposition: 'selected',
        summary: 'triage status = completed',
        observedValue: 'completed'
      }
    ],
    ...overrides
  };
}

describe('ExecutionDecisionObservation closed-shape contract validator (F23-T01, D1)', () => {
  it('accepts a valid v1 ExecutionDecisionObservation and returns a frozen-compatible value', () => {
    const obs = validObservation();
    const result = validateExecutionDecisionObservation(obs);
    expect(result.valid).toBe(true);
    expect(isExecutionDecisionObservation(obs)).toBe(true);
  });

  it('rejects non-object inputs, unknown top-level keys, and unsupported schema versions', () => {
    expect(validateExecutionDecisionObservation(null).valid).toBe(false);
    expect(validateExecutionDecisionObservation([]).valid).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        version: 2
      }).valid
    ).toBe(false);
    const withUnknownKey = validateExecutionDecisionObservation({
      ...validObservation(),
      extraField: true
    });
    expect(withUnknownKey.valid).toBe(false);
    if (!withUnknownKey.valid) {
      expect(withUnknownKey.errors.some((e) => e.code === 'unknown-field')).toBe(true);
    }
  });

  it('rejects null optional fields, non-finite numbers, invalid enums, and invalid UTF-8 strings', () => {
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        attemptId: null
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        noProgressThreshold: null
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        iteration: 0
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        maxIterations: Number.NaN
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        capOutcome: 'ignore' as never
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        exitReason: 'unknown-exit' as never
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        decisionId: 'bad-\uFFFD-id'
      }).valid
    ).toBe(false);
    expect(
      validateExecutionDecisionObservation({
        ...validObservation(),
        branches: [
          {
            connectionIndex: 0,
            isDefault: false,
            disposition: 'invalid-disposition' as never,
            summary: 'Always'
          }
        ]
      }).valid
    ).toBe(false);
  });

  it('formats condition summaries and phase retry summaries deterministically', () => {
    expect(formatConditionSummary(undefined, false)).toBe('Always');
    expect(formatConditionSummary(undefined, true)).toBe('Otherwise');
    expect(
      formatConditionSummary({
        left: { source: 'node-status', nodeId: 'verify' },
        operator: 'equals',
        right: 'completed'
      })
    ).toBe('verify status = completed');
    expect(
      formatConditionSummary({
        left: { source: 'node-output', nodeId: 'analyze', field: 'verdict' },
        operator: 'in',
        right: ['pass', 'warn']
      })
    ).toBe('analyze.verdict in [pass, warn]');

    expect(formatPhaseRetrySummary({})).toBe('Single pass (no retry condition)');
    expect(
      formatPhaseRetrySummary({
        retryCondition: 'remaining > 0',
        maxIterations: 5,
        capOutcome: 'continue-degraded',
        noProgressThreshold: 2
      })
    ).toBe('Repeats on remaining > 0 · max 5 · on cap: continue-degraded · no-progress: 2');

    for (const disp of EXECUTION_BRANCH_DISPOSITIONS) {
      expect(describeBranchDisposition(disp).length).toBeGreaterThan(0);
    }
    for (const reason of EXECUTION_DECISION_EXIT_REASONS) {
      expect(describeExitReason(reason).length).toBeGreaterThan(0);
    }
  });
});

describe('Phase transition observation and effective limits provenance (F23-T02, F23-T03)', () => {
  it('records repeat, condition-cleared, cap-failed, cap-continued, cap-degraded, no-progress, and missing-evidence', () => {
    const baseInput = {
      runId: 'run-obs-1',
      evaluatedAt: 1_700_000_001_000,
      phase: 'analyze',
      outcome: 'issues_remain' as const,
      iteration: 1,
      iterationCap: 3,
      phaseDef: {
        id: 'analyze',
        retryCondition: 'issues > 0'
      },
      metrics: { issues: 2 },
      capOutcome: 'fail' as const
    };

    const repeating = buildPhaseTransitionObservation(baseInput);
    expect(repeating.decision.kind).toBe('loop');
    expect(repeating.observation.exitReason).toBe('repeat');
    expect(repeating.observation.observedValues).toEqual({
      outcome: 'issues_remain',
      issues: 2
    });
    expect(validateExecutionDecisionObservation(repeating.observation).valid).toBe(true);

    const cleared = buildPhaseTransitionObservation({
      ...baseInput,
      outcome: 'clean',
      metrics: { issues: 0 }
    });
    expect(cleared.decision.kind).toBe('advance');
    expect(cleared.observation.exitReason).toBe('condition-cleared');

    const capFailed = buildPhaseTransitionObservation({
      ...baseInput,
      iteration: 3,
      capOutcome: 'fail'
    });
    expect(capFailed.decision.kind).toBe('halt');
    expect(capFailed.observation.exitReason).toBe('cap-failed');

    const capContinued = buildPhaseTransitionObservation({
      ...baseInput,
      iteration: 3,
      capOutcome: 'continue'
    });
    expect(capContinued.decision.kind).toBe('advance');
    expect(capContinued.observation.exitReason).toBe('cap-continued');

    const capDegraded = buildPhaseTransitionObservation({
      ...baseInput,
      iteration: 3,
      capOutcome: 'continue-degraded'
    });
    expect(capDegraded.decision.kind).toBe('advance');
    expect(capDegraded.observation.exitReason).toBe('cap-degraded');

    const noProgress = buildPhaseTransitionObservation({
      ...baseInput,
      iteration: 2,
      stalledCount: 2,
      maxUnchangedComparisons: 2,
      capOutcome: 'fail'
    });
    expect(noProgress.decision.kind).toBe('halt');
    expect(noProgress.observation.exitReason).toBe('no-progress');
    expect(noProgress.observation.noProgressThreshold).toBe(2);

    const missingEvidence = buildPhaseTransitionObservation({
      ...baseInput,
      outcome: 'incomplete_turn'
    });
    expect(missingEvidence.decision.kind).toBe('halt');
    expect(missingEvidence.observation.exitReason).toBe('missing-evidence');
  });

  it('resolves phase iteration setting sources and phaseRetryPolicy on EffectiveLimitsProjection', () => {
    const limitsInput = {
      settings: {
        iterationCap: { value: 5, origin: 'workspace' as const },
        idleTimeoutSeconds: { value: 300, origin: 'default' as const },
        maxDurationSeconds: { value: 3600, origin: 'default' as const }
      },
      live: {
        forceContinueOnCap: { value: false, origin: 'default' as const },
        maxUnchangedComparisons: { value: 3, origin: 'user' as const },
        limitUsd: { value: null, origin: 'default' as const },
        limitTokens: { value: null, origin: 'default' as const }
      },
      run: {
        currentPhase: 'analyze',
        defaultRunnerKind: 'claude' as const,
        pipeline: {
          id: 'p-1',
          name: 'Pipeline 1',
          phases: [
            {
              id: 'analyze',
              name: 'Analyze',
              retryCondition: 'critical > 0',
              onRetryCap: 'continue-degraded' as const
            }
          ]
        }
      },
      spendTrust: () => 'enforced' as const
    };

    const sources = resolvePhaseIterationSources(limitsInput);
    expect(sources).toEqual({
      maxIterations: 'workspace',
      capOutcome: 'phase',
      noProgressThreshold: 'user'
    });

    const limits = resolveEffectiveLimits(limitsInput);
    expect(limits.phaseRetryPolicy).toEqual({
      retryCondition: 'critical > 0',
      capOutcome: 'continue-degraded',
      noProgressThreshold: 3,
      settingSources: {
        maxIterations: 'workspace',
        capOutcome: 'phase',
        noProgressThreshold: 'user'
      }
    });
  });
});

describe('Workflow branch disposition evaluation (F23-T04, AC-02)', () => {
  const workflow: WorkflowDefinition = {
    workflowId: 'wf-branch-visibility',
    name: 'Branch Visibility',
    version: 1,
    nodes: [
      { nodeId: 'triage', kind: 'phase', phaseId: 'p-triage' },
      { nodeId: 'fast', kind: 'phase', phaseId: 'p-fast' },
      { nodeId: 'deep', kind: 'phase', phaseId: 'p-deep' },
      { nodeId: 'missing-data', kind: 'phase', phaseId: 'p-missing' },
      { nodeId: 'fallback', kind: 'phase', phaseId: 'p-fallback' },
      { nodeId: 'sink', kind: 'phase', phaseId: 'p-sink' }
    ],
    connections: [
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'fast' },
        priority: 1,
        handoff: 'manual',
        condition: {
          left: { source: 'node-output', nodeId: 'triage', field: 'route' },
          operator: 'equals',
          right: 'urgent'
        }
      },
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'deep' },
        priority: 2,
        condition: {
          left: { source: 'node-output', nodeId: 'triage', field: 'route' },
          operator: 'equals',
          right: 'urgent'
        }
      },
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'missing-data' },
        priority: 3,
        condition: {
          left: { source: 'node-output', nodeId: 'triage', field: 'unwritten' },
          operator: 'exists'
        }
      },
      {
        from: { nodeId: 'triage' },
        to: { kind: 'node', nodeId: 'fallback' },
        isDefault: true
      }
    ],
    startNodeIds: ['triage']
  };

  it('distinguishes manual-handoff, priority-lost, unresolved, and fallback dispositions', () => {
    const urgentContext = buildConditionContext([
      {
        nodeId: 'triage',
        status: 'completed',
        outputs: [
          { name: 'route', status: 'resolved', reference: 'urgent' },
          { name: 'unwritten', status: 'unresolved' }
        ]
      }
    ]);

    const outcome = selectNextTransition({
      graph: workflow,
      nodeId: 'triage',
      attemptIndex: 0,
      decidedAt: 1_700_000_002_000,
      context: urgentContext
    });
    expect(outcome.outcome).toBe('transition');

    const obs = buildRoutingDecisionObservation(
      {
        runId: 'run-wf-1',
        graph: workflow,
        nodeId: 'triage',
        attemptIndex: 0,
        decidedAt: 1_700_000_002_000,
        context: urgentContext
      },
      outcome.decision
    );

    expect(validateExecutionDecisionObservation(obs).valid).toBe(true);
    expect(obs.branches.map((b) => b.disposition)).toEqual([
      'manual-handoff',
      'priority-lost',
      'unresolved',
      'priority-lost'
    ]);
  });

  it('records condition-false and fallback when no explicit condition matches', () => {
    const standardContext = buildConditionContext([
      {
        nodeId: 'triage',
        status: 'completed',
        outputs: [
          { name: 'route', status: 'resolved', reference: 'standard' },
          { name: 'unwritten', status: 'unresolved' }
        ]
      }
    ]);

    const obs = buildRoutingDecisionObservation({
      runId: 'run-wf-1',
      graph: workflow,
      nodeId: 'triage',
      attemptIndex: 0,
      decidedAt: 1_700_000_003_000,
      context: standardContext
    });

    expect(obs.branches.map((b) => b.disposition)).toEqual([
      'condition-false',
      'condition-false',
      'unresolved',
      'fallback'
    ]);
  });

  it('records selected, failure-excluded, and no-route dispositions', () => {
    const autoGraph: WorkflowDefinition = {
      ...workflow,
      connections: [
        {
          from: { nodeId: 'triage' },
          to: { kind: 'node', nodeId: 'fast' }
        }
      ]
    };

    const completedCtx = buildConditionContext([
      { nodeId: 'triage', status: 'completed', outputs: [] }
    ]);
    const selectedBranches = evaluateBranchDispositions(
      {
        graph: autoGraph,
        nodeId: 'triage',
        attemptIndex: 0,
        decidedAt: 1_700_000_004_000,
        context: completedCtx
      },
      selectNextNodes({
        graph: autoGraph,
        nodeId: 'triage',
        attemptIndex: 0,
        decidedAt: 1_700_000_004_000,
        context: completedCtx
      })
    );
    expect(selectedBranches[0]?.disposition).toBe('selected');

    const failedCtx = buildConditionContext([
      { nodeId: 'triage', status: 'failed', outputs: [] }
    ]);
    const failureBranches = evaluateBranchDispositions({
      graph: autoGraph,
      nodeId: 'triage',
      attemptIndex: 0,
      decidedAt: 1_700_000_005_000,
      attemptStatus: 'failed',
      context: failedCtx
    });
    expect(failureBranches[0]?.disposition).toBe('failure-excluded');

    const noRouteBranches = evaluateBranchDispositions({
      graph: autoGraph,
      nodeId: 'sink',
      attemptIndex: 0,
      decidedAt: 1_700_000_006_000,
      context: completedCtx
    });
    expect(noRouteBranches).toEqual([
      {
        connectionIndex: -1,
        isDefault: false,
        disposition: 'no-route',
        summary: 'No outgoing connections'
      }
    ]);
  });
});
