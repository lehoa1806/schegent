// FR-R3-008 (T378) — an override adjusts the recorded total in the *same* write,
// and progress never exceeds 100% or decreases.
//
// This is the acceptance criterion the plan states as "An override adjusts the
// total visibly", and it is the half of the denominator guarantee that the
// factory test cannot reach: `workflow-run-factory-planned-total.test.ts` proves
// the total is frozen against a settings change, and this proves it still tracks
// the one thing that is *allowed* to change it — the operator narrowing or
// widening the plan.
//
// Two properties, and the second is the reason the first has to be one write:
//
//   - **Same write.** `phaseOverrides` and `plannedTotal` land in one `setRun`.
//     A follow-up write would leave a window in which the persisted record says
//     a phase is skipped and the denominator still counts it, and a window is all
//     a reload needs to be observed.
//   - **Symmetric exclusion.** The driver appends a `PhaseResult` with
//     `result: 'skipped'` when it reaches an overridden phase. If the denominator
//     subtracted overrides while the numerator counted their skip records,
//     progress would read past 100% — so the test drives that exact sequence
//     rather than asserting the arithmetic in isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { PhaseResult, WorkflowRun } from '../../../src/state/workflow-run';
import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';
import type { Memento } from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { projectRunProgress } from '../../../src/ui/sidebar/run-projector';

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

/** Four phases, none loopable, so `phaseCount` and the ceiling move together. */
const PIPELINE = Object.freeze({
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: Object.freeze(
    ['speckit-specify', 'speckit-clarify', 'speckit-plan', 'speckit-tasks'].map((id) =>
      Object.freeze(BUILT_IN_PHASES.find((phase) => phase.id === id)!)
    )
  )
});

const NOW = Date.parse('2026-05-10T12:00:00.000Z');

function settled(phase: string, result: PhaseResult['result']): PhaseResult {
  return {
    phase,
    iteration: 1,
    startedAt: NOW - 1_000,
    endedAt: NOW,
    result,
    terminationReason: 'token',
    exitCode: 0,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let controller: SchegentWorkflowController;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  controller = new SchegentWorkflowController(
    { run: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    new SanitizedLogger(),
    {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 },
    { auditWriter: { append: async (entry) => ({ ...entry, id: 'a', timestamp: '' }) as never } }
  );
  // The seeded Run is `running`, which in production always implies a live
  // session; without one the override controls' driver seam silently no-ops.
  const driver = (controller as unknown as {
    sessions: { acquire: (id: string) => { driver: Record<string, unknown> } };
  }).sessions.acquire(DEFAULT_QUEUE_ID).driver;
  vi.spyOn(driver as never, 'noteActivePhaseOverrideAbort').mockImplementation(() => undefined);
  (controller as unknown as { cancelActive: unknown }).cancelActive = vi.fn();
  (controller as unknown as { resumeExisting: unknown }).resumeExisting = vi.fn(async () => {});
});

/**
 * A Run one phase in, sitting on the second of four, with a frozen total for all
 * four. `speckit-plan` and `speckit-tasks` are the *remaining* phases the
 * acceptance criterion overrides.
 */
async function seedRun(extra: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
  const feature = await queue.enqueue('override feature');
  await queue.markInFlight(feature.id, 'run-ovr-1');
  const run: WorkflowRun = {
    id: 'run-ovr-1',
    featureId: feature.id,
    featureDir: 'specs/001-existing',
    status: 'running',
    currentPhase: 'speckit-clarify',
    currentIteration: 1,
    startedAt: NOW,
    lastTransitionAt: NOW,
    phasesCompleted: [settled('speckit-specify', 'clean')],
    lastError: null,
    pipeline: PIPELINE,
    plannedTotal: { phaseCount: 4, iterationCap: 5, maxPhaseInvocations: 4 },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...extra
  };
  await store.setRun(DEFAULT_QUEUE_ID, run);
  return run;
}

function percentOf(run: WorkflowRun | null): number {
  const progress = projectRunProgress(run);
  expect(progress, 'a seeded Run always carries a total').not.toBeNull();
  return progress!.percent;
}

describe('FR-R3-008 — an override adjusts the recorded total in the same write', () => {
  it('writes the narrowed total and the new override together, in one setRun', async () => {
    await seedRun();
    const writes: WorkflowRun[] = [];
    const passThrough = store.setRun.bind(store);
    vi.spyOn(store, 'setRun').mockImplementation(async (queueId, run) => {
      if (run) writes.push(run);
      return passThrough(queueId, run);
    });

    expect(await controller.disablePhase('speckit-tasks')).toEqual({ ok: true });

    // One write, carrying both halves. A second write would be a window in which
    // the two disagree.
    const carrying = writes.filter((run) =>
      run.phaseOverrides.some((override) => override.phaseId === 'speckit-tasks')
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.plannedTotal).toEqual({
      phaseCount: 3,
      iterationCap: 5,
      maxPhaseInvocations: 3
    });
  });

  it.each([
    ['skipPhase', (c: SchegentWorkflowController) => c.skipPhase('speckit-plan')],
    ['disablePhase', (c: SchegentWorkflowController) => c.disablePhase('speckit-plan')]
  ])('narrows the total and raises progress when %s overrides a remaining phase', async (
    _name,
    act
  ) => {
    await seedRun();
    const before = percentOf(store.getRun(DEFAULT_QUEUE_ID));
    expect(before, '1 of 4').toBe(25);

    expect(await act(controller)).toEqual({ ok: true });

    const after = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(after.plannedTotal!.phaseCount, 'the overridden phase left the plan').toBe(3);
    // Fewer phases left to do, the same one done: progress rises. It must not
    // fall, which is what a numerator-only or denominator-only change would do.
    expect(percentOf(after), '1 of 3').toBe(33);
    expect(percentOf(after)).toBeGreaterThan(before);
  });

  it('narrows the total when a remaining phase is removed', async () => {
    const run = await seedRun();
    const result = await controller.removeTaskPhase(run.featureId, 'speckit-tasks');
    expect(result.ok).toBe(true);

    const after = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(after.plannedTotal!.phaseCount).toBe(3);
    expect(after.phaseOverrides.map((override) => override.action)).toEqual(['removed']);
  });

  it('stays at or below 100% once the driver records the override as skipped', async () => {
    // The sequence that would break an asymmetric fraction: override the two
    // remaining phases, then let the driver append the `skipped` results it
    // appends when it reaches them.
    await seedRun();
    await controller.disablePhase('speckit-plan');
    await controller.disablePhase('speckit-tasks');

    const overridden = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(overridden.plannedTotal!.phaseCount, 'specify and clarify remain').toBe(2);

    await store.setRun(DEFAULT_QUEUE_ID, {
      ...overridden,
      phasesCompleted: [
        ...overridden.phasesCompleted,
        settled('speckit-clarify', 'clean'),
        settled('speckit-plan', 'skipped'),
        settled('speckit-tasks', 'skipped')
      ]
    });

    const done = store.getRun(DEFAULT_QUEUE_ID)!;
    // Four settled records against a denominator of two, and still 100 — because
    // both sides subtract the same override set.
    expect(done.phasesCompleted).toHaveLength(4);
    expect(projectRunProgress(done)!.phasesCompleted).toBe(2);
    expect(percentOf(done)).toBe(100);
    expect(percentOf(done)).toBeLessThanOrEqual(100);
  });

  it('widens the total again when the operator re-enables a phase', async () => {
    await seedRun();
    await controller.disablePhase('speckit-plan');
    const narrowed = percentOf(store.getRun(DEFAULT_QUEUE_ID));

    expect(await controller.enablePhase('speckit-plan')).toEqual({ ok: true });

    const widened = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(widened.plannedTotal!.phaseCount, 'back to all four').toBe(4);
    // Progress *falls* here, and that is the honest reading rather than a
    // violation: the operator just put work back into the plan. The acceptance
    // criterion's no-decrease property is about narrowing the plan, which is the
    // direction an override takes it.
    expect(percentOf(widened)).toBeLessThan(narrowed);
    expect(percentOf(widened)).toBe(25);
  });

  it('keeps the frozen cap across an override rather than re-reading settings', async () => {
    // `opts.iterationCap` is 5 and the seeded record says 5. A total refreshed
    // from live settings would be indistinguishable here, so the probe is a
    // record whose frozen cap disagrees with the host's: the override must
    // preserve the record's.
    await seedRun({ plannedTotal: { phaseCount: 4, iterationCap: 2, maxPhaseInvocations: 4 } });

    await controller.disablePhase('speckit-tasks');

    const after = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(after.plannedTotal!.iterationCap, 'the record, not opts.iterationCap').toBe(2);
    // Asserted together with the narrowing, so this cannot pass by the total
    // simply not being rewritten — a preserved cap on an unchanged total is not
    // evidence of anything.
    expect(after.plannedTotal!.phaseCount).toBe(3);
  });

  it('leaves a legacy record without a total untouched rather than writing 0 of 0', async () => {
    // `plannedTotalPatch` returns `{}` for a Run with no pipeline snapshot, so a
    // pre-snapshot record keeps rendering as unknown instead of as complete.
    await seedRun({ pipeline: undefined, plannedTotal: undefined });

    await controller.disablePhase('speckit-tasks');

    const after = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(after.phaseOverrides).toHaveLength(1);
    expect('plannedTotal' in after && after.plannedTotal !== undefined).toBe(false);
    expect(projectRunProgress(after)).toBeNull();
  });
});
