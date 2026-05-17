import { describe, it, expect } from 'vitest';
import { migrateLegacyRun } from '../../../src/state/workflow-run-migrator';

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
