// FR-R3-008 (T382) — activity moves `liveness`, and nothing else.
//
// The anti-pattern this feature was written against is the cheap fix: reuse
// `lastTransitionAt` as a heartbeat, because it is already there and already
// persisted. That would make the liveness question answerable and silently break
// every reader that treats the field as *when the status last changed* — the
// lifecycle auditor's `durationMs`, the staleness reclaim, and the history
// recorder's `completedAt`. A phase streaming output would report a zero-length
// time-in-status, so the field would still answer one question while quietly
// answering the other wrongly.
//
// So this file asserts the negative directly: after activity, `lastTransitionAt`
// is byte-identical, and the auditor's duration still measures from the
// transition. The positive assertions about the field's own contents are here too,
// because a write that touched nothing at all would also pass the negative.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkflowLifecycleAuditor } from '../../../src/controller/workflow-lifecycle-auditor';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
// Feature 098 (T080) — these rows came from `BUILT_IN_PHASES`, which is empty
// now; the fixture supplies the same definitions under the same ids. See its
// header for why the ids are the real Spec Kit ones.
import { SPECKIT_ALL_PHASE_DEFS } from '../../fixtures/speckit-catalog-fixture';
import type { Memento } from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000
};

const STANDARD_PIPELINE = Object.freeze({
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: Object.freeze(
    ['speckit-specify', 'speckit-clarify', 'speckit-plan', 'finalize'].map((id) =>
      Object.freeze(SPECKIT_ALL_PHASE_DEFS.find((p) => p.id === id)!)
    )
  )
});

/** A fixed transition stamp, well in the past, so any drift is unmistakable. */
const TRANSITION_AT = Date.parse('2026-05-10T12:00:00.000Z');

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let controller: SchegentWorkflowController;
let auditWriter: { append: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  auditWriter = { append: vi.fn(async () => {}) };
  controller = new SchegentWorkflowController(
    { run: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts,
    { auditWriter }
  );
});

async function seedRun(
  runId: string,
  queueId: string = DEFAULT_QUEUE_ID,
  overrides: Partial<WorkflowRun> = {}
): Promise<WorkflowRun> {
  const feature = await queue.enqueue(`feature for ${runId}`, { queueId });
  await queue.markInFlight(feature.id, runId);
  const run: WorkflowRun = {
    id: runId,
    featureId: feature.id,
    featureDir: 'specs/001-existing',
    status: 'running' as WorkflowRunStatus,
    currentPhase: 'speckit-clarify',
    currentIteration: 1,
    startedAt: TRANSITION_AT - 60_000,
    lastTransitionAt: TRANSITION_AT,
    phasesCompleted: [],
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
  await store.setRun(queueId, run, unfencedCommit('test-fixture'));
  return run;
}

/** `recordRunActivity` is fire-and-forget; give its `setRun` a turn to land. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FR-R3-008 — liveness is its own field, not a reused transition stamp', () => {
  it('records the observation without moving lastTransitionAt', async () => {
    await seedRun('run-1');

    controller.recordRunActivity({
      runId: 'run-1',
      at: TRANSITION_AT + 120_000,
      stdoutLines: 412,
      stderrLines: 3
    });
    await settle();

    const persisted = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(persisted.liveness).toEqual({
      lastActivityAt: TRANSITION_AT + 120_000,
      stdoutLines: 412,
      stderrLines: 3
    });
    expect(persisted.lastTransitionAt, 'the transition stamp is not a heartbeat').toBe(TRANSITION_AT);
  });

  it('leaves lastTransitionAt fixed across many observations', async () => {
    await seedRun('run-1');

    for (let i = 1; i <= 20; i += 1) {
      controller.recordRunActivity({
        runId: 'run-1',
        at: TRANSITION_AT + i * 15_000,
        stdoutLines: i * 50,
        stderrLines: 0
      });
      await settle();
    }

    const persisted = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(persisted.liveness!.lastActivityAt).toBe(TRANSITION_AT + 20 * 15_000);
    expect(persisted.lastTransitionAt).toBe(TRANSITION_AT);
    // Status is the other thing a transition stamp travels with; neither moved.
    expect(persisted.status).toBe('running');
    expect(persisted.currentPhase).toBe('speckit-clarify');
  });

  it('leaves the lifecycle auditor measuring time-in-status from the transition', async () => {
    await seedRun('run-1');

    // Five minutes in status, of which the last minute was silent. The duration
    // the auditor reports must be the five.
    //
    // The auditor is exercised directly rather than through `skipPhase`, because
    // `skipPhase` writes its own `lastTransitionAt` before re-reading the record
    // and would report ~0 whatever this field did. What is under test is the one
    // expression that reads the stamp, fed the record activity actually left
    // behind.
    controller.recordRunActivity({
      runId: 'run-1',
      at: TRANSITION_AT + 240_000,
      stdoutLines: 9,
      stderrLines: 0
    });
    await settle();

    const auditor = new WorkflowLifecycleAuditor(auditWriter, new SanitizedLogger());
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(TRANSITION_AT + 300_000);
    try {
      await auditor.emitPhaseJumped(store.getRun(DEFAULT_QUEUE_ID)!, 'speckit-clarify');
    } finally {
      nowSpy.mockRestore();
    }

    const jumped = auditWriter.append.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.eventType === 'phase-jumped');
    expect(jumped, 'the auditor event that reads lastTransitionAt').toBeDefined();
    expect(jumped.payload.durationMs).toBe(300_000);
  });

  it('persists a timestamp and two counters, and nothing resembling content', async () => {
    await seedRun('run-1');

    controller.recordRunActivity({
      runId: 'run-1',
      at: TRANSITION_AT + 1_000,
      stdoutLines: 1,
      stderrLines: 0
    });
    await settle();

    const liveness = store.getRun(DEFAULT_QUEUE_ID)!.liveness!;
    expect(Object.keys(liveness).sort()).toEqual([
      'lastActivityAt',
      'stderrLines',
      'stdoutLines'
    ]);
    for (const value of Object.values(liveness)) {
      expect(typeof value, 'no line text, no path — numbers only').toBe('number');
    }
  });

  it('never moves the stamp backwards', async () => {
    await seedRun('run-1');

    controller.recordRunActivity({
      runId: 'run-1',
      at: TRANSITION_AT + 60_000,
      stdoutLines: 100,
      stderrLines: 0
    });
    await settle();
    // A late-arriving observation from an earlier moment — two chunk paths racing
    // through the coalescer — must not make a live Run look staler than it is.
    controller.recordRunActivity({
      runId: 'run-1',
      at: TRANSITION_AT + 30_000,
      stdoutLines: 50,
      stderrLines: 0
    });
    await settle();

    expect(store.getRun(DEFAULT_QUEUE_ID)!.liveness).toEqual({
      lastActivityAt: TRANSITION_AT + 60_000,
      stdoutLines: 100,
      stderrLines: 0
    });
  });

  it('writes nothing for a terminal run', async () => {
    await seedRun('run-1', DEFAULT_QUEUE_ID, { status: 'completed' as WorkflowRunStatus });

    controller.recordRunActivity({
      runId: 'run-1',
      at: TRANSITION_AT + 60_000,
      stdoutLines: 7,
      stderrLines: 0
    });
    await settle();

    // A completed Run's record is the history recorder's input; a stamp landing
    // after the terminal write would be a liveness reading on a Run that ended.
    expect(store.getRun(DEFAULT_QUEUE_ID)!.liveness).toBeUndefined();
    expect(store.getRun(DEFAULT_QUEUE_ID)!.lastTransitionAt).toBe(TRANSITION_AT);
  });

  it('writes nothing for a run id the store does not hold', async () => {
    await seedRun('run-1');

    controller.recordRunActivity({
      runId: 'run-gone',
      at: TRANSITION_AT + 60_000,
      stdoutLines: 7,
      stderrLines: 0
    });
    await settle();

    expect(store.getRun(DEFAULT_QUEUE_ID)!.liveness).toBeUndefined();
  });

  it('addresses the run by its own queue, leaving a sibling queue untouched', async () => {
    const second = await queue.createQueue('second');
    expect(second.ok, second.ok ? '' : second.reason).toBe(true);
    const secondQueueId = second.queueId!;

    await seedRun('run-a', DEFAULT_QUEUE_ID);
    await seedRun('run-b', secondQueueId);

    controller.recordRunActivity({
      runId: 'run-b',
      at: TRANSITION_AT + 60_000,
      stdoutLines: 5,
      stderrLines: 1
    });
    await settle();

    expect(store.getRun(secondQueueId)!.liveness!.stdoutLines).toBe(5);
    expect(
      store.getRun(DEFAULT_QUEUE_ID)!.liveness,
      'the neighbour queue keeps its own reading — here, none'
    ).toBeUndefined();
  });
});
