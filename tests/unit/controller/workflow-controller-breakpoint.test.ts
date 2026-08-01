// Feature 028 — Breakpoint set/clear unit tests for the
// SchegentWorkflowController. Covers the validation matrix from
// data-model.md §7 plus mutual exclusion with `phaseOverrides`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';

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

function makeStatusBar(): SchegentStatusBar {
  return { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
}

function makeNotifier(): Notifier {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
};

const STANDARD_PIPELINE = Object.freeze({
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: Object.freeze(
    [
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize'
    ].map((id) => Object.freeze(BUILT_IN_PHASES.find((p) => p.id === id)!))
  )
});

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let controller: SchegentWorkflowController;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  phaseRunner = { run: vi.fn() } as unknown as PhaseRunner;
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts
  );
});

async function seedRun(
  overrides: Partial<WorkflowRun> = {}
): Promise<{ feature: { id: string }; run: WorkflowRun }> {
  const feature = await queue.enqueue('breakpoint feature');
  await queue.markInFlight(feature.id, 'run-bp-1');
  const now = Date.now();
  const run: WorkflowRun = {
    id: 'run-bp-1',
    featureId: feature.id,
    featureDir: 'specs/001-existing',
    status: 'running' as WorkflowRunStatus,
    currentPhase: 'speckit-clarify',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [
      {
        phase: 'speckit-specify',
        iteration: 1,
        startedAt: now - 1000,
        endedAt: now,
        result: 'clean',
        terminationReason: 'token',
        exitCode: 0,
        stdoutSummary: '',
        stderrSummary: '',
        auditEntryId: null
      }
    ],
    lastError: null,
    pipeline: STANDARD_PIPELINE,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
  await store.setRun(run);
  return { feature, run };
}

describe('SchegentWorkflowController.setPhaseBreakpoint', () => {
  it('adds an entry to phaseBreakpoints with actor "operator"', async () => {
    await seedRun();
    const result = await controller.setPhaseBreakpoint('run-bp-1', 'speckit-implement');
    expect(result).toEqual({ ok: true });
    const run = store.getRun()!;
    expect(run.phaseBreakpoints).toHaveLength(1);
    expect(run.phaseBreakpoints[0].phaseId).toBe('speckit-implement');
    expect(run.phaseBreakpoints[0].actor).toBe('operator');
    expect(typeof run.phaseBreakpoints[0].setAt).toBe('number');
  });

  it('rejects when no run is in-flight', async () => {
    const result = await controller.setPhaseBreakpoint('run-missing', 'speckit-implement');
    expect(result).toEqual({ ok: false, reason: 'run-not-in-flight' });
  });

  it('rejects when the phase id is not in the pipeline snapshot', async () => {
    await seedRun();
    const result = await controller.setPhaseBreakpoint('run-bp-1', 'made-up-phase');
    expect(result).toEqual({ ok: false, reason: 'phase-unknown' });
  });

  it('rejects when the phase is the currently in-flight phase', async () => {
    await seedRun({ currentPhase: 'speckit-clarify' });
    const result = await controller.setPhaseBreakpoint('run-bp-1', 'speckit-clarify');
    expect(result).toEqual({ ok: false, reason: 'phase-in-flight' });
  });

  it('rejects when the phase is already completed', async () => {
    await seedRun();
    // 'speckit-specify' is in phasesCompleted from the seed fixture.
    const result = await controller.setPhaseBreakpoint('run-bp-1', 'speckit-specify');
    expect(result).toEqual({ ok: false, reason: 'phase-completed' });
  });

  it('rejects when the phase already has a skipped/disabled override', async () => {
    await seedRun({
      phaseOverrides: [{ phaseId: 'speckit-implement', action: 'disabled', setAt: 1, actor: 'operator' }]
    });
    const result = await controller.setPhaseBreakpoint('run-bp-1', 'speckit-implement');
    expect(result).toEqual({ ok: false, reason: 'phase-overridden' });
  });

  it('rejects when a breakpoint is already set on the phase', async () => {
    await seedRun({
      phaseBreakpoints: [{ phaseId: 'speckit-implement', setAt: 1, actor: 'operator' }]
    });
    const result = await controller.setPhaseBreakpoint('run-bp-1', 'speckit-implement');
    expect(result).toEqual({ ok: false, reason: 'breakpoint-already-set' });
  });
});

describe('SchegentWorkflowController.clearPhaseBreakpoint', () => {
  it('removes a previously-set breakpoint entry', async () => {
    await seedRun({
      phaseBreakpoints: [{ phaseId: 'speckit-implement', setAt: 1, actor: 'operator' }]
    });
    const result = await controller.clearPhaseBreakpoint('run-bp-1', 'speckit-implement');
    expect(result).toEqual({ ok: true });
    const run = store.getRun()!;
    expect(run.phaseBreakpoints).toHaveLength(0);
  });

  it('rejects when no run is in-flight', async () => {
    const result = await controller.clearPhaseBreakpoint('run-missing', 'speckit-implement');
    expect(result).toEqual({ ok: false, reason: 'run-not-in-flight' });
  });

  it('rejects when no breakpoint is set on the phase', async () => {
    await seedRun();
    const result = await controller.clearPhaseBreakpoint('run-bp-1', 'speckit-implement');
    expect(result).toEqual({ ok: false, reason: 'breakpoint-not-set' });
  });
});

describe('SchegentWorkflowController.setPhaseOverride auto-clears matching breakpoint', () => {
  it('skipping a phase that has a breakpoint also removes the breakpoint (FR-015)', async () => {
    await seedRun({
      phaseBreakpoints: [{ phaseId: 'speckit-implement', setAt: 1, actor: 'operator' }]
    });
    const result = await controller.skipPhase('speckit-implement');
    expect(result).toEqual({ ok: true });
    const run = store.getRun()!;
    expect(run.phaseBreakpoints).toHaveLength(0);
    expect(run.phaseOverrides).toHaveLength(1);
    expect(run.phaseOverrides[0].action).toBe('skipped');
  });

  it('disabling a phase that has a breakpoint also removes the breakpoint', async () => {
    await seedRun({
      phaseBreakpoints: [{ phaseId: 'speckit-implement', setAt: 1, actor: 'operator' }]
    });
    const result = await controller.disablePhase('speckit-implement');
    expect(result).toEqual({ ok: true });
    const run = store.getRun()!;
    expect(run.phaseBreakpoints).toHaveLength(0);
    expect(run.phaseOverrides).toHaveLength(1);
    expect(run.phaseOverrides[0].action).toBe('disabled');
  });
});
