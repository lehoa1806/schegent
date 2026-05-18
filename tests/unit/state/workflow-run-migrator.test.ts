import { describe, it, expect } from 'vitest';
import {
  migrateLegacyRun,
  repairLegacyRunSnapshot
} from '../../../src/state/workflow-run-migrator';

describe('migrateLegacyRun v1 → v2 → v3 (017, T007)', () => {
  it('returns null for null/undefined input', () => {
    expect(migrateLegacyRun(null)).toBeNull();
    expect(migrateLegacyRun(undefined)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(migrateLegacyRun('garbage' as unknown)).toBeNull();
    expect(migrateLegacyRun(42 as unknown)).toBeNull();
  });

  it('adds 017 fields with safe defaults to a v2 record', () => {
    const v2 = {
      id: 'run-1',
      featureId: 'feat-1',
      status: 'running',
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null
    };
    const out = migrateLegacyRun(v2);
    expect(out).not.toBeNull();
    expect(out!.phaseOverrides).toEqual([]);
    expect(out!.manualPauseAt).toBeNull();
    expect(out!.manualPauseCause).toBeNull();
  });

  it('preserves valid phaseOverrides and dedupes by phaseId', () => {
    const v3 = {
      id: 'run-1',
      phaseOverrides: [
        { phaseId: 'specify', action: 'skipped', setAt: 1_700_000_000_000, actor: 'op' },
        { phaseId: 'specify', action: 'disabled', setAt: 1_700_000_000_001, actor: 'op2' },
        { phaseId: 'plan', action: 'disabled', setAt: 1_700_000_000_002, actor: 'op' }
      ]
    };
    const out = migrateLegacyRun(v3);
    expect(out!.phaseOverrides).toHaveLength(2);
    expect(out!.phaseOverrides.map((o) => o.phaseId)).toEqual(['specify', 'plan']);
    expect(out!.phaseOverrides[0].action).toBe('skipped');
  });

  it('drops phaseOverrides with invalid action', () => {
    const v3 = {
      id: 'run-1',
      phaseOverrides: [
        { phaseId: 'specify', action: 'bogus', setAt: 1, actor: 'op' },
        { phaseId: 'plan', action: 'skipped', setAt: 2, actor: 'op' }
      ]
    };
    const out = migrateLegacyRun(v3);
    expect(out!.phaseOverrides).toHaveLength(1);
    expect(out!.phaseOverrides[0].phaseId).toBe('plan');
  });

  it('defaults actor to "unknown-operator" when missing or empty', () => {
    const v3 = {
      id: 'run-1',
      phaseOverrides: [{ phaseId: 'specify', action: 'skipped', setAt: 1, actor: '' }]
    };
    const out = migrateLegacyRun(v3);
    expect(out!.phaseOverrides[0].actor).toBe('unknown-operator');
  });

  it('enforces both-null-or-both-non-null on manualPause pair', () => {
    const v3Partial = {
      id: 'run-1',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: null
    };
    const out = migrateLegacyRun(v3Partial);
    expect(out!.manualPauseAt).toBeNull();
    expect(out!.manualPauseCause).toBeNull();
  });

  it('preserves valid manualPause pair', () => {
    const v3 = {
      id: 'run-1',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'operator-paused'
    };
    const out = migrateLegacyRun(v3);
    expect(out!.manualPauseAt).toBe(1_700_000_000_000);
    expect(out!.manualPauseCause).toBe('operator-paused');
  });

  it('rejects unknown manualPauseCause values (zeroes the pair)', () => {
    const v3 = {
      id: 'run-1',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'bogus-cause'
    };
    const out = migrateLegacyRun(v3);
    expect(out!.manualPauseAt).toBeNull();
    expect(out!.manualPauseCause).toBeNull();
  });

  it('rejects task-level pause causes on WorkflowRun manualPauseCause', () => {
    const v3 = {
      id: 'run-1',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'phase-paused'
    };
    const out = migrateLegacyRun(v3);
    expect(out!.manualPauseAt).toBeNull();
    expect(out!.manualPauseCause).toBeNull();
  });

  it('still enforces v1→v2 retry pair invariant', () => {
    const v1Partial = {
      id: 'run-1',
      pendingRetryAt: 1_700_000_000_000,
      pendingRetryCause: null
    };
    const out = migrateLegacyRun(v1Partial);
    expect(out!.pendingRetryAt).toBeNull();
    expect(out!.pendingRetryCause).toBeNull();
    expect(out!.phaseOverrides).toEqual([]);
  });
});

describe('repairLegacyRunSnapshot', () => {
  it('removes bugfix phases from a contaminated default pipeline snapshot', () => {
    const run = migrateLegacyRun({
      id: 'run-1',
      featureId: 'feat-1',
      status: 'running',
      phaseBreakpoints: [
        { phaseId: 'bugfix-report', setAt: 1, actor: 'operator' },
        { phaseId: 'speckit-plan', setAt: 2, actor: 'operator' }
      ],
      pipeline: {
        id: 'speckit-new-feature',
        name: 'Spec-kit New Feature',
        phases: [
          { id: 'speckit-specify', name: 'Specify', instruction: 'x', loopable: false },
          { id: 'speckit-clarify', name: 'Clarify', instruction: 'x', loopable: true },
          { id: 'speckit-plan', name: 'Plan', instruction: 'x', loopable: false },
          { id: 'speckit-tasks', name: 'Tasks', instruction: 'x', loopable: false },
          { id: 'speckit-analyze', name: 'Analyze', instruction: 'x', loopable: true },
          { id: 'speckit-implement', name: 'Implement', instruction: 'x', loopable: false },
          { id: 'finalize', name: 'Finalize', instruction: 'x', loopable: false },
          { id: 'done', name: 'Done', instruction: 'x', loopable: false },
          { id: 'bugfix-report', name: 'Bugfix Report', instruction: 'x', loopable: false },
          { id: 'bugfix-patch', name: 'Bugfix Patch', instruction: 'x', loopable: false }
        ]
      }
    });

    const result = repairLegacyRunSnapshot(run!);

    expect(result.run.pipeline?.phases.map((p) => p.id)).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize',
      'done'
    ]);
    expect(result.run.phaseBreakpoints.map((bp) => bp.phaseId)).toEqual(['speckit-plan']);
    expect(result.auditEvent).toMatchObject({
      type: 'workflow-run-repaired',
      runId: 'run-1',
      pipelineId: 'speckit-new-feature',
      removedPhaseCount: 2,
      removedBreakpointCount: 1,
      remainingPhaseCount: 8
    });
  });

  it('leaves non-default pipelines untouched', () => {
    const run = migrateLegacyRun({
      id: 'run-2',
      featureId: 'feat-2',
      status: 'running',
      pipeline: {
        id: 'speckit-bugfix',
        name: 'Bugfix',
        phases: [{ id: 'bugfix-report', name: 'Bugfix Report', instruction: 'x', loopable: false }]
      }
    });

    const result = repairLegacyRunSnapshot(run!);

    expect(result.run).toBe(run);
    expect(result.auditEvent).toBeNull();
  });
});
