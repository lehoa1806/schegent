import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import {
  buildPhasesFromRun,
  mapPhaseOutcome
} from '../../../../src/ui/sidebar/phase-projector';

function makeRun(): WorkflowRun {
  return {
    id: 'run-optional',
    featureId: '076-optional-phases',
    featureDir: '/workspace/specs/076-optional-phases',
    status: 'running',
    currentPhase: 'next-phase',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [
      {
        phase: 'optional-audit',
        iteration: 1,
        startedAt: 1,
        endedAt: 2,
        result: 'failed',
        terminationReason: 'error',
        exitCode: 7,
        stdoutSummary: '',
        stderrSummary: '',
        auditEntryId: 'audit-1'
      }
    ],
    lastError: null,
    pipeline: {
      id: 'custom',
      name: 'Custom',
      phases: [
        {
          id: 'optional-audit',
          name: 'Optional Audit',
          instruction: 'Audit without blocking.',
          isRequired: false
        },
        {
          id: 'next-phase',
          name: 'Next Phase',
          instruction: 'Continue.'
        }
      ]
    },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

describe('phase projector optional failure evidence (076)', () => {
  it('keeps a continued optional phase completed with a failed result badge', () => {
    const tiles = buildPhasesFromRun(makeRun());

    expect(tiles[0]).toMatchObject({
      name: 'optional-audit',
      isRequired: false,
      state: 'completed',
      lastResult: 'failed'
    });
    expect(tiles[1]).toMatchObject({
      name: 'next-phase',
      state: 'active'
    });
  });

  it('maps timeout to the explicit timed-out presentation state', () => {
    expect(mapPhaseOutcome('timeout')).toBe('timed-out');
  });
});
