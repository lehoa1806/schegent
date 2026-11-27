import { describe, it, expect, vi } from 'vitest';
import {
  migrateLegacyRun,
  repairLegacyRunSnapshot,
  repairPersistedSessionId,
  repairRunOnLoad
} from '../../../src/state/workflow-run-migrator';
import { KEYS, SCHEMA_VERSION, STATE_SCHEMA_VERSION, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { SanitizedLogger } from '../../../src/lib/logger';
import { buildQueueRegistry, buildQueueStateMap, buildWorkflowRun } from '../../fixtures/state/queue-fixtures';
import { resolveSessionDispatch } from '../../../src/services/session-dispatch-policy';
import type { WorkflowRun } from '../../../src/state/workflow-run';

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
    expect(out!.rawTranscriptMode).toBe('always');
  });

  it('preserves valid v8 transcript modes and fails legacy garbage to always', () => {
    expect(migrateLegacyRun({ rawTranscriptMode: 'errors-only' })!.rawTranscriptMode)
      .toBe('errors-only');
    expect(migrateLegacyRun({ rawTranscriptMode: 'garbage' })!.rawTranscriptMode)
      .toBe('always');
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

// FR-R3-207 (T1891): a persisted session id that fails the shape check is dropped with its owner.
describe('repairPersistedSessionId (FR-R3-207, T1891)', () => {
  const MALFORMED_ID = '-x-session';
  const UUID_ID = '3f2c8a4e-9b1d-4c6e-8f0a-2d7b5e1c9a34';
  const MAX_LENGTH_ID = 'a'.repeat(256);

  function runWith(fields: Record<string, unknown>) {
    return migrateLegacyRun({
      id: 'run-session',
      featureId: 'feat-session',
      status: 'running',
      ...fields
    })!;
  }

  function dispatchFor(run: WorkflowRun) {
    return resolveSessionDispatch({
      requestedContinue: true,
      pendingSessionReuse: false,
      ...(run.lastCliSessionId === undefined ? {} : { persistedSessionId: run.lastCliSessionId }),
      ...(run.lastCliSessionRunnerKind === undefined
        ? {}
        : { persistedSessionRunnerKind: run.lastCliSessionRunnerKind }),
      effectiveRunnerKind: 'claude'
    });
  }

  function sessionRepairEvent(runId: string) {
    return {
      type: 'workflow-run-repaired',
      runId,
      repair: 'remove-malformed-cli-session-id'
    };
  }

  it('P1: drops an id that starts with a dash, with its owner, and names only the Run', () => {
    const run = runWith({ lastCliSessionId: MALFORMED_ID, lastCliSessionRunnerKind: 'claude' });

    const result = repairPersistedSessionId(run);

    expect(result.run.lastCliSessionId).toBeUndefined();
    expect(result.run.lastCliSessionRunnerKind).toBeUndefined();
    expect(result.auditEvent).toEqual(sessionRepairEvent(run.id));
  });

  it('P2: drops an id one character over the length bound, though every character is allowed', () => {
    const run = runWith({
      lastCliSessionId: 'a'.repeat(257),
      lastCliSessionRunnerKind: 'claude'
    });

    const result = repairPersistedSessionId(run);

    expect(result.run.lastCliSessionId).toBeUndefined();
    expect(result.run.lastCliSessionRunnerKind).toBeUndefined();
    expect(result.auditEvent).toEqual(sessionRepairEvent(run.id));
  });

  it('P3: drops an id with a character outside the allowed set, though its length is fine', () => {
    const run = runWith({ lastCliSessionId: 'abc def', lastCliSessionRunnerKind: 'claude' });

    const result = repairPersistedSessionId(run);

    expect(result.run.lastCliSessionId).toBeUndefined();
    expect(result.run.lastCliSessionRunnerKind).toBeUndefined();
    expect(result.auditEvent).toEqual(sessionRepairEvent(run.id));
  });

  it('P4: drops an empty id', () => {
    const run = runWith({ lastCliSessionId: '', lastCliSessionRunnerKind: 'claude' });

    const result = repairPersistedSessionId(run);

    expect(result.run.lastCliSessionId).toBeUndefined();
    expect(result.run.lastCliSessionRunnerKind).toBeUndefined();
    expect(result.auditEvent).toEqual(sessionRepairEvent(run.id));
  });

  it('P5: keeps a well-formed id and returns the same Run with no event', () => {
    const run = runWith({ lastCliSessionId: UUID_ID, lastCliSessionRunnerKind: 'claude' });

    const result = repairPersistedSessionId(run);

    expect(result.run).toBe(run);
    expect(result.auditEvent).toBeNull();
  });

  it('P6: keeps an id of exactly the length bound', () => {
    const run = runWith({ lastCliSessionId: MAX_LENGTH_ID, lastCliSessionRunnerKind: 'claude' });

    const result = repairPersistedSessionId(run);

    expect(result.run).toBe(run);
    expect(result.auditEvent).toBeNull();
  });

  it('P7: leaves a null id and its owner alone', () => {
    const run = runWith({ lastCliSessionId: null, lastCliSessionRunnerKind: 'claude' });

    const result = repairPersistedSessionId(run);

    expect(result.run).toBe(run);
    expect(result.run.lastCliSessionRunnerKind).toBe('claude');
    expect(result.auditEvent).toBeNull();
  });

  it('P8: leaves a Run with no id and no owner alone', () => {
    const run = runWith({});

    const result = repairPersistedSessionId(run);

    expect(result.run).toBe(run);
    expect(result.auditEvent).toBeNull();
  });

  it('P9: leaves a non-string id alone, since the dispatch already treats it as no id', () => {
    const run = runWith({
      lastCliSessionId: 42 as unknown as string,
      lastCliSessionRunnerKind: 'claude'
    });

    const result = repairPersistedSessionId(run);

    expect(result.run).toBe(run);
    expect(result.auditEvent).toBeNull();
  });

  it('P10: drops the id on any pipeline and whatever backend owns it', () => {
    const pipeline = {
      id: 'speckit-bugfix',
      name: 'Bugfix',
      phases: [{ id: 'bugfix-report', name: 'Bugfix Report', instruction: 'x', loopable: false }]
    };
    const run = runWith({
      pipeline,
      lastCliSessionId: MALFORMED_ID,
      lastCliSessionRunnerKind: 'codex'
    });

    const result = repairPersistedSessionId(run);

    expect(result.run.lastCliSessionId).toBeUndefined();
    expect(result.run.lastCliSessionRunnerKind).toBeUndefined();
    expect(result.run.pipeline).toBe(run.pipeline);
    expect(result.auditEvent).toEqual(sessionRepairEvent(run.id));
  });

  it('P11: drops the id when no owner was recorded, leaving the owner absent', () => {
    const run = runWith({ lastCliSessionId: MALFORMED_ID });

    const result = repairPersistedSessionId(run);

    expect(result.run.lastCliSessionId).toBeUndefined();
    expect(result.run.lastCliSessionRunnerKind).toBeUndefined();
    expect(result.auditEvent).toEqual(sessionRepairEvent(run.id));
  });

  it('P12: a repaired Run reports no persisted id to the dispatch, and the unrepaired one owned it', () => {
    const run = runWith({ lastCliSessionId: MALFORMED_ID, lastCliSessionRunnerKind: 'claude' });

    const repaired = repairPersistedSessionId(run);
    const afterRepair = dispatchFor(repaired.run);
    const beforeRepair = dispatchFor(run);

    expect(afterRepair.resumeSessionId).toBeUndefined();
    expect(afterRepair.ownsResumeSession).toBe(false);
    expect(afterRepair.freshSessionCause).toBe('no-persisted-session-id');
    expect(beforeRepair.ownsResumeSession).toBe(true);
  });

  // FR-R3-209: the session's cost figure goes with a malformed id and its owner, and stays with a valid id.
  it('M1: drops the persisted cost figure with a malformed id, and keeps it beside a valid one', () => {
    const malformed = runWith({
      lastCliSessionId: MALFORMED_ID,
      lastCliSessionRunnerKind: 'claude',
      lastCliSessionCostUsd: 1.6
    });

    const repairedMalformed = repairPersistedSessionId(malformed);

    expect(repairedMalformed.run.lastCliSessionId).toBeUndefined();
    expect(repairedMalformed.run).not.toHaveProperty('lastCliSessionCostUsd');

    const valid = runWith({
      lastCliSessionId: UUID_ID,
      lastCliSessionRunnerKind: 'claude',
      lastCliSessionCostUsd: 1.6
    });

    const repairedValid = repairPersistedSessionId(valid);

    expect(repairedValid.run.lastCliSessionId).toBe(UUID_ID);
    expect(repairedValid.run.lastCliSessionCostUsd).toBe(1.6);
  });
});

// FR-R4-F02 (spec 240, data-model §3 "Load") — a persisted `creditPause` is accepted only with
// numeric-or-null fields, finite and non-negative, and `windowStartedAt >= pausedAt` when both are
// set. Anything else is repaired to `null`, which makes the Run ineligible rather than wrongly
// eligible, with one warning that names a reason code and nothing from the Run.
describe('FR-R4-F02 — creditPause is repaired on load', () => {
  function pausedRunWith(creditPause: unknown): WorkflowRun {
    return { ...buildWorkflowRun({ id: 'run-credit', status: 'paused' }), creditPause } as unknown as WorkflowRun;
  }
  function creditPauseOf(run: WorkflowRun): unknown {
    return (run as unknown as { creditPause?: unknown }).creditPause;
  }
  const REPAIR_REASON = { reasonCode: 'credit-pause-repaired' };

  it.each([
    ['no window yet', { pausedAt: 100, windowStartedAt: null, stoppedAt: null }],
    ['an open window', { pausedAt: 100, windowStartedAt: 200, stoppedAt: null }],
    ['a window that started at the pause', { pausedAt: 100, windowStartedAt: 100, stoppedAt: null }],
    ['a stopped window', { pausedAt: 100, windowStartedAt: 200, stoppedAt: 300 }]
  ])('keeps a valid object (%s) and warns of nothing', (_name, valid) => {
    const out = repairRunOnLoad(pausedRunWith(valid));
    expect(creditPauseOf(out.run)).toEqual(valid);
    expect(out.warnings).toEqual([]);
  });

  it.each([
    ['a string', 'paused'],
    ['a number', 3],
    ['an array', []],
    ['a string field', { pausedAt: '100', windowStartedAt: null, stoppedAt: null }],
    ['a null pausedAt', { pausedAt: null, windowStartedAt: null, stoppedAt: null }],
    ['a missing field', { pausedAt: 100, windowStartedAt: null }],
    ['windowStartedAt before pausedAt', { pausedAt: 200, windowStartedAt: 100, stoppedAt: null }],
    ['a negative number', { pausedAt: -1, windowStartedAt: null, stoppedAt: null }],
    ['a negative stoppedAt', { pausedAt: 100, windowStartedAt: 200, stoppedAt: -5 }],
    ['NaN', { pausedAt: Number.NaN, windowStartedAt: null, stoppedAt: null }],
    ['an infinite number', { pausedAt: 100, windowStartedAt: Number.POSITIVE_INFINITY, stoppedAt: null }]
  ])('repairs %s to null with one metadata-only warning', (_name, malformed) => {
    const out = repairRunOnLoad(pausedRunWith(malformed));
    expect(creditPauseOf(out.run)).toBeNull();
    expect(out.warnings).toEqual([REPAIR_REASON]);
    expect(JSON.stringify(out.warnings)).not.toContain('run-credit');
  });

  it('leaves a null record and an absent key alone, without a warning', () => {
    const withNull = repairRunOnLoad(pausedRunWith(null));
    expect(creditPauseOf(withNull.run)).toBeNull();
    expect(withNull.warnings).toEqual([]);

    const { creditPause: _absent, ...bare } = pausedRunWith(null) as WorkflowRun & { creditPause?: unknown };
    const absent = repairRunOnLoad(bare as WorkflowRun);
    expect(absent.run).not.toHaveProperty('creditPause');
    expect(absent.warnings).toEqual([]);
  });

  describe('through the store', () => {
    class FakeMemento implements Memento {
      private readonly map = new Map<string, unknown>();
      get<T>(key: string): T | undefined {
        return this.map.get(key) as T | undefined;
      }
      update(key: string, value: unknown): Thenable<void> {
        this.map.set(key, value);
        return Promise.resolve();
      }
    }

    it('persists the repaired Run, logs one warning with a reason code and no Run body', async () => {
      const registry = buildQueueRegistry({ count: 1, defaultAtPosition: 0 });
      const queues = buildQueueStateMap(registry);
      const memento = new FakeMemento();
      await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
      await memento.update(KEYS.queueRegistry, registry);
      await memento.update(KEYS.queue, queues);
      const malformed = { pausedAt: 200, windowStartedAt: 100, stoppedAt: null };
      await memento.update(KEYS.run, {
        default: { ...pausedRunWith(malformed), featureId: 'task-0' }
      });
      const warn = vi.fn();
      const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SanitizedLogger;

      const store = new WorkspaceStateStore(memento, logger);
      await store.initialize();

      expect(creditPauseOf(store.getRun('default') as WorkflowRun)).toBeNull();
      const repairWarnings = warn.mock.calls.filter(
        (call) => (call[1] as { reasonCode?: string } | undefined)?.reasonCode === 'credit-pause-repaired'
      );
      expect(repairWarnings).toHaveLength(1);
      expect(JSON.stringify(repairWarnings[0])).not.toContain('run-credit');
    });
  });
});
