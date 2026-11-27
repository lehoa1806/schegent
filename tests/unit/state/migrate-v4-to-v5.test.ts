import { describe, it, expect } from 'vitest';
import { migrateLegacyRun } from '../../../src/state/workflow-run-migrator';
import { migrateV12ToV13 } from '../../../src/state/queue-state-migrator';
import type { QueueRegistry } from '../../../src/queue/queue-registry';
import type { QueueState } from '../../../src/queue/feature-request';

describe('migrateLegacyRun (feature 028, T008)', () => {
  it('returns null for null/undefined input', () => {
    expect(migrateLegacyRun(null)).toBeNull();
    expect(migrateLegacyRun(undefined)).toBeNull();
  });

  it('adds phaseBreakpoints: [] and resumeTargetPhaseId: null to a legacy v4 run', () => {
    const v4 = {
      id: 'run-1',
      featureId: 'feat-1',
      status: 'running',
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null
    };
    const out = migrateLegacyRun(v4);
    expect(out).not.toBeNull();
    expect(out!.phaseBreakpoints).toEqual([]);
    expect(out!.resumeTargetPhaseId).toBeNull();
  });

  it("accepts 'breakpoint-paused' as a valid manualPauseCause and preserves resumeTargetPhaseId", () => {
    const v5 = {
      id: 'run-1',
      featureId: 'feat-1',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'breakpoint-paused',
      resumeTargetPhaseId: 'plan'
    };
    const out = migrateLegacyRun(v5);
    expect(out!.manualPauseCause).toBe('breakpoint-paused');
    expect(out!.resumeTargetPhaseId).toBe('plan');
  });

  it("zeroes resumeTargetPhaseId when manualPauseCause is not 'breakpoint-paused'", () => {
    const mismatched = {
      id: 'run-1',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'operator-paused',
      resumeTargetPhaseId: 'plan'
    };
    const out = migrateLegacyRun(mismatched);
    expect(out!.manualPauseCause).toBe('operator-paused');
    expect(out!.resumeTargetPhaseId).toBeNull();
  });

  it("zeroes resumeTargetPhaseId when manualPauseCause is null even if resumeTarget is present", () => {
    const orphan = {
      id: 'run-1',
      manualPauseAt: null,
      manualPauseCause: null,
      resumeTargetPhaseId: 'plan'
    };
    const out = migrateLegacyRun(orphan);
    expect(out!.resumeTargetPhaseId).toBeNull();
  });

  it('preserves valid phaseBreakpoints and dedupes by phaseId', () => {
    const v5 = {
      id: 'run-1',
      phaseBreakpoints: [
        { phaseId: 'plan', setAt: 1_700_000_000_000, actor: 'operator' },
        { phaseId: 'plan', setAt: 1_700_000_000_001, actor: 'operator' },
        { phaseId: 'implement', setAt: 1_700_000_000_002, actor: 'operator' }
      ]
    };
    const out = migrateLegacyRun(v5);
    expect(out!.phaseBreakpoints).toHaveLength(2);
    expect(out!.phaseBreakpoints.map((b) => b.phaseId)).toEqual(['plan', 'implement']);
  });

  it('drops phaseBreakpoint entries with empty/missing phaseId', () => {
    const v5 = {
      id: 'run-1',
      phaseBreakpoints: [
        { phaseId: '', setAt: 1, actor: 'operator' },
        { phaseId: 'plan', setAt: 2, actor: 'operator' }
      ]
    };
    const out = migrateLegacyRun(v5);
    expect(out!.phaseBreakpoints).toHaveLength(1);
    expect(out!.phaseBreakpoints[0].phaseId).toBe('plan');
  });

  it("defaults actor to 'operator' when missing or invalid", () => {
    const v5 = {
      id: 'run-1',
      phaseBreakpoints: [
        { phaseId: 'plan', setAt: 1, actor: 'bogus' },
        { phaseId: 'implement', setAt: 2 }
      ]
    };
    const out = migrateLegacyRun(v5);
    expect(out!.phaseBreakpoints[0].actor).toBe('operator');
    expect(out!.phaseBreakpoints[1].actor).toBe('operator');
  });

  it('skips phaseBreakpoint entries that conflict with phaseOverrides', () => {
    const v5 = {
      id: 'run-1',
      phaseOverrides: [{ phaseId: 'plan', action: 'skipped', setAt: 1, actor: 'op' }],
      phaseBreakpoints: [
        { phaseId: 'plan', setAt: 2, actor: 'operator' },
        { phaseId: 'implement', setAt: 3, actor: 'operator' }
      ]
    };
    const out = migrateLegacyRun(v5);
    expect(out!.phaseBreakpoints).toHaveLength(1);
    expect(out!.phaseBreakpoints[0].phaseId).toBe('implement');
  });

  it('returns [] for non-array phaseBreakpoints', () => {
    const garbage = { id: 'run-1', phaseBreakpoints: 'not an array' };
    const out = migrateLegacyRun(garbage);
    expect(out!.phaseBreakpoints).toEqual([]);
  });

  it('is idempotent on already-v5 data', () => {
    const v5 = {
      id: 'run-1',
      manualPauseAt: 100,
      manualPauseCause: 'breakpoint-paused',
      resumeTargetPhaseId: 'plan',
      phaseBreakpoints: [{ phaseId: 'plan', setAt: 100, actor: 'operator' }]
    };
    const first = migrateLegacyRun(v5);
    const second = migrateLegacyRun(first);
    expect(second!.phaseBreakpoints).toEqual(first!.phaseBreakpoints);
    expect(second!.resumeTargetPhaseId).toBe('plan');
    expect(second!.manualPauseCause).toBe('breakpoint-paused');
  });
});

function makeQueueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    requests: [],
    pausedReason: null,
    inFlightId: null,
    updatedAt: 100,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...overrides
  };
}

describe('migrateV12ToV13 pauseSource normalization (feature 028 / FR-R5-F09)', () => {
  it("defaults pauseSource to 'operator' on legacy manually-paused entries", () => {
    const registry = {
      entries: [{ id: 'q1', name: 'Q1', createdAt: 1, updatedAt: 1, state: 'manually-paused' }],
      updatedAt: 1
    } as unknown as QueueRegistry;
    const out = migrateV12ToV13({ q1: makeQueueState() }, registry, 200);
    const q1 = new Map(Object.entries(out.queueStates)).get('q1');
    expect(q1?.pauseSource).toBe('operator');
    expect(q1?.queueLifecycle).toBe('operator-paused');
  });

  it('sets pauseSource: null for active queues', () => {
    const registry = {
      entries: [{ id: 'q1', name: 'Q1', createdAt: 1, updatedAt: 1, state: 'active' }],
      updatedAt: 1
    } as unknown as QueueRegistry;
    const out = migrateV12ToV13({ q1: makeQueueState() }, registry, 200);
    expect(new Map(Object.entries(out.queueStates)).get('q1')?.pauseSource).toBeNull();
  });

  it("preserves an existing valid pauseSource of 'cascade'", () => {
    const registry = {
      entries: [{ id: 'q1', name: 'Q1', createdAt: 1, updatedAt: 1, state: 'manually-paused', pauseSource: 'cascade' }],
      updatedAt: 1
    } as unknown as QueueRegistry;
    const out = migrateV12ToV13({ q1: makeQueueState() }, registry, 200);
    expect(new Map(Object.entries(out.queueStates)).get('q1')?.pauseSource).toBe('cascade');
  });

  it('is idempotent on already-v13 data', () => {
    const registry: QueueRegistry = {
      entries: [
        { id: 'q1', name: 'Q1', position: 0, schedule: null, createdAt: 1, updatedAt: 1 },
        { id: 'q2', name: 'Q2', position: 1, schedule: null, createdAt: 1, updatedAt: 1 }
      ],
      updatedAt: 1
    };
    const states = {
      q1: makeQueueState({ queueLifecycle: 'operator-paused', pauseSource: 'cascade' }),
      q2: makeQueueState({ queueLifecycle: 'active-empty', pauseSource: null })
    };
    const first = migrateV12ToV13(states, registry, 200);
    expect(first.changed).toBe(false);
    expect(first.queueStates).toEqual(states);
  });
});
