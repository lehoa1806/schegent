import { describe, it, expect } from 'vitest';
import {
  migrateV4ToV5,
  migrateQueueRegistryV4ToV5
} from '../../../src/state/workflow-run-migrator';

describe('migrateV4ToV5 (feature 028, T008)', () => {
  it('returns null for null/undefined input', () => {
    expect(migrateV4ToV5(null)).toBeNull();
    expect(migrateV4ToV5(undefined)).toBeNull();
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
    const out = migrateV4ToV5(v4);
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
    const out = migrateV4ToV5(v5);
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
    const out = migrateV4ToV5(mismatched);
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
    const out = migrateV4ToV5(orphan);
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
    const out = migrateV4ToV5(v5);
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
    const out = migrateV4ToV5(v5);
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
    const out = migrateV4ToV5(v5);
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
    const out = migrateV4ToV5(v5);
    expect(out!.phaseBreakpoints).toHaveLength(1);
    expect(out!.phaseBreakpoints[0].phaseId).toBe('implement');
  });

  it('returns [] for non-array phaseBreakpoints', () => {
    const garbage = { id: 'run-1', phaseBreakpoints: 'not an array' };
    const out = migrateV4ToV5(garbage);
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
    const first = migrateV4ToV5(v5);
    const second = migrateV4ToV5(first);
    expect(second!.phaseBreakpoints).toEqual(first!.phaseBreakpoints);
    expect(second!.resumeTargetPhaseId).toBe('plan');
    expect(second!.manualPauseCause).toBe('breakpoint-paused');
  });
});

describe('migrateQueueRegistryV4ToV5 (feature 028, T008)', () => {
  it('returns [] for non-array input', () => {
    expect(migrateQueueRegistryV4ToV5(null)).toEqual([]);
    expect(migrateQueueRegistryV4ToV5(undefined)).toEqual([]);
    expect(migrateQueueRegistryV4ToV5('garbage')).toEqual([]);
  });

  it("defaults pauseSource to 'operator' on legacy manually-paused entries", () => {
    const legacy = [{ id: 'q1', state: 'manually-paused' }];
    const out = migrateQueueRegistryV4ToV5(legacy);
    expect(out).toHaveLength(1);
    expect(out[0].pauseSource).toBe('operator');
  });

  it('sets pauseSource: null for active queues', () => {
    const legacy = [{ id: 'q1', state: 'active' }];
    const out = migrateQueueRegistryV4ToV5(legacy);
    expect(out[0].pauseSource).toBeNull();
  });

  it("preserves an existing valid pauseSource of 'cascade'", () => {
    const legacy = [{ id: 'q1', state: 'manually-paused', pauseSource: 'cascade' }];
    const out = migrateQueueRegistryV4ToV5(legacy);
    expect(out[0].pauseSource).toBe('cascade');
  });

  it("replaces an invalid pauseSource with 'operator' on manually-paused entries", () => {
    const legacy = [{ id: 'q1', state: 'manually-paused', pauseSource: 'bogus' }];
    const out = migrateQueueRegistryV4ToV5(legacy);
    expect(out[0].pauseSource).toBe('operator');
  });

  it('forces pauseSource: null even when active entries carry a stale value', () => {
    const legacy = [{ id: 'q1', state: 'active', pauseSource: 'operator' }];
    const out = migrateQueueRegistryV4ToV5(legacy);
    expect(out[0].pauseSource).toBeNull();
  });

  it('skips non-object entries', () => {
    const legacy = [null, 'garbage', { id: 'q1', state: 'active' }];
    const out = migrateQueueRegistryV4ToV5(legacy);
    expect(out).toHaveLength(1);
  });

  it('is idempotent on already-v5 data', () => {
    const v5 = [
      { id: 'q1', state: 'manually-paused', pauseSource: 'cascade' },
      { id: 'q2', state: 'active', pauseSource: null }
    ];
    const first = migrateQueueRegistryV4ToV5(v5);
    const second = migrateQueueRegistryV4ToV5(first);
    expect(second).toEqual(first);
  });
});
