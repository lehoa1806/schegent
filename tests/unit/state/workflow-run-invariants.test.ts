// Feature 028 — workflow-run invariants for phaseBreakpoints / resumeTargetPhaseId.
//
// Covers the rejection cases enumerated in data-model.md §12. Asserts that
// `WorkspaceStateStore.setRun()` throws on each invariant violation BEFORE
// the memento write so split-state corruption is impossible at the boundary.

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { WorkflowRun, PhaseBreakpoint, PhaseOverride } from '../../../src/state/workflow-run';
import type { PhaseDef } from '../../../src/config/pipeline-config';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
});

function phaseDef(id: string): PhaseDef {
  return { id, name: id, instruction: `Run ${id}`, loopable: false };
}

function baseRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: 'specs/028-x',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    pipeline: {
      id: 'p',
      name: 'Pipeline',
      phases: [
        phaseDef('speckit-specify'),
        phaseDef('speckit-plan'),
        phaseDef('speckit-tasks'),
        phaseDef('finalize')
      ]
    },
    ...overrides
  };
}

function bp(phaseId: string, actor: PhaseBreakpoint['actor'] = 'operator'): PhaseBreakpoint {
  return { phaseId, setAt: 1_700_000_000_000, actor };
}

function override(phaseId: string, action: PhaseOverride['action']): PhaseOverride {
  return { phaseId, action, setAt: 1_700_000_000_000, actor: 'op' };
}

describe('WorkflowRun invariants — manualPauseAt / manualPauseCause pair (Feature 028)', () => {
  it('rejects manualPauseAt non-null with manualPauseCause null', () => {
    expect(() =>
      store.setRun(baseRun({ manualPauseAt: 1_700_000_000_000, manualPauseCause: null }))
    ).toThrow(/manualPauseAt.*manualPauseCause.*both null or both non-null/);
  });

  it('rejects manualPauseAt null with manualPauseCause non-null (operator-paused)', () => {
    expect(() =>
      store.setRun(baseRun({ manualPauseAt: null, manualPauseCause: 'operator-paused' }))
    ).toThrow(/manualPauseAt.*manualPauseCause.*both null or both non-null/);
  });

  it('rejects manualPauseAt null with manualPauseCause non-null (breakpoint-paused)', () => {
    expect(() =>
      store.setRun(
        baseRun({
          manualPauseAt: null,
          manualPauseCause: 'breakpoint-paused',
          resumeTargetPhaseId: 'speckit-plan'
        })
      )
    ).toThrow(/manualPauseAt.*manualPauseCause.*both null or both non-null/);
  });

  it('accepts both-null', async () => {
    await expect(
      store.setRun(baseRun({ manualPauseAt: null, manualPauseCause: null }))
    ).resolves.toBeUndefined();
  });

  it('accepts both-non-null with breakpoint-paused + matching resumeTargetPhaseId', async () => {
    await expect(
      store.setRun(
        baseRun({
          manualPauseAt: 1_700_000_000_000,
          manualPauseCause: 'breakpoint-paused',
          resumeTargetPhaseId: 'speckit-tasks',
          phaseBreakpoints: []
        })
      )
    ).resolves.toBeUndefined();
  });
});

describe('WorkflowRun invariants — phaseBreakpoints (Feature 028)', () => {
  it('rejects a breakpoint whose phaseId is not in pipeline.phases', () => {
    expect(() =>
      store.setRun(baseRun({ phaseBreakpoints: [bp('unknown-phase')] }))
    ).toThrow(/phaseBreakpoints phaseId 'unknown-phase' is not in pipeline.phases/);
  });

  it('rejects duplicate phaseIds in phaseBreakpoints', () => {
    expect(() =>
      store.setRun(baseRun({ phaseBreakpoints: [bp('speckit-plan'), bp('speckit-plan')] }))
    ).toThrow(/phaseBreakpoints contains duplicate phaseId 'speckit-plan'/);
  });

  it('rejects a phaseId in both phaseBreakpoints and phaseOverrides[skipped]', () => {
    expect(() =>
      store.setRun(
        baseRun({
          phaseBreakpoints: [bp('speckit-tasks')],
          phaseOverrides: [override('speckit-tasks', 'skipped')]
        })
      )
    ).toThrow(/appears in BOTH phaseBreakpoints AND phaseOverrides/);
  });

  it('rejects a phaseId in both phaseBreakpoints and phaseOverrides[disabled]', () => {
    expect(() =>
      store.setRun(
        baseRun({
          phaseBreakpoints: [bp('speckit-tasks')],
          phaseOverrides: [override('speckit-tasks', 'disabled')]
        })
      )
    ).toThrow(/appears in BOTH phaseBreakpoints AND phaseOverrides/);
  });

  it('rejects a phaseId in both phaseBreakpoints and phaseOverrides[removed]', () => {
    expect(() =>
      store.setRun(
        baseRun({
          phaseBreakpoints: [bp('speckit-tasks')],
          phaseOverrides: [override('speckit-tasks', 'removed')]
        })
      )
    ).toThrow(/appears in BOTH phaseBreakpoints AND phaseOverrides/);
  });

  it('accepts an empty phaseBreakpoints (default for fresh runs)', async () => {
    await expect(store.setRun(baseRun({ phaseBreakpoints: [] }))).resolves.toBeUndefined();
  });

  it('accepts multiple distinct breakpoints all in the pipeline', async () => {
    await expect(
      store.setRun(
        baseRun({ phaseBreakpoints: [bp('speckit-tasks'), bp('finalize')] })
      )
    ).resolves.toBeUndefined();
  });

  it('accepts a breakpoint on a phase that has a non-conflicting override on a different phase', async () => {
    await expect(
      store.setRun(
        baseRun({
          phaseBreakpoints: [bp('speckit-tasks')],
          phaseOverrides: [override('finalize', 'skipped')]
        })
      )
    ).resolves.toBeUndefined();
  });
});

describe('WorkflowRun invariants — resumeTargetPhaseId / manualPauseCause coupling (Feature 028)', () => {
  it('rejects manualPauseCause=breakpoint-paused with resumeTargetPhaseId=null', () => {
    expect(() =>
      store.setRun(
        baseRun({
          manualPauseAt: 1_700_000_000_000,
          manualPauseCause: 'breakpoint-paused',
          resumeTargetPhaseId: null
        })
      )
    ).toThrow(/resumeTargetPhaseId.*non-null iff manualPauseCause === 'breakpoint-paused'/);
  });

  it('rejects resumeTargetPhaseId non-null with manualPauseCause=operator-paused', () => {
    expect(() =>
      store.setRun(
        baseRun({
          manualPauseAt: 1_700_000_000_000,
          manualPauseCause: 'operator-paused',
          resumeTargetPhaseId: 'speckit-plan'
        })
      )
    ).toThrow(/resumeTargetPhaseId.*non-null iff manualPauseCause === 'breakpoint-paused'/);
  });

  it('rejects resumeTargetPhaseId non-null with manualPauseCause=queue-paused-mid-run', () => {
    expect(() =>
      store.setRun(
        baseRun({
          manualPauseAt: 1_700_000_000_000,
          manualPauseCause: 'queue-paused-mid-run',
          resumeTargetPhaseId: 'speckit-plan'
        })
      )
    ).toThrow(/resumeTargetPhaseId.*non-null iff manualPauseCause === 'breakpoint-paused'/);
  });

  it('rejects resumeTargetPhaseId non-null with manualPauseCause=null', () => {
    expect(() =>
      store.setRun(
        baseRun({
          manualPauseAt: null,
          manualPauseCause: null,
          resumeTargetPhaseId: 'speckit-plan'
        })
      )
    ).toThrow(/resumeTargetPhaseId.*non-null iff manualPauseCause === 'breakpoint-paused'/);
  });

  it('accepts resumeTargetPhaseId null with manualPauseCause=null', async () => {
    await expect(
      store.setRun(baseRun({ resumeTargetPhaseId: null, manualPauseCause: null }))
    ).resolves.toBeUndefined();
  });
});

describe('WorkflowRun invariants — phaseBreakpoints shape (Feature 028)', () => {
  it('rejects phaseBreakpoints when not an array', () => {
    const bad = baseRun() as unknown as WorkflowRun & { phaseBreakpoints: unknown };
    (bad as { phaseBreakpoints: unknown }).phaseBreakpoints = 'not-an-array';
    expect(() => store.setRun(bad as WorkflowRun)).toThrow(
      /phaseBreakpoints must be an array/
    );
  });
});
