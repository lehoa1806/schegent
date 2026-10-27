// FR-R4-F01 (spec 239, US2, T021, SC-002) — a pause, cancel or retry survives
// concurrent background updates.
//
// The real `PhaseControlService`, the real `recordRunLiveness`, the real `runCancel`
// command and the real retry-decision sink, over the real `WorkspaceStateStore`.
// Each pair is run in BOTH orders, and the order is forced rather than raced: the
// store's `Memento` holds every write until the test lets go, so both writers have
// taken their read of the Run before either one's link on the `KEYS.run` chain
// runs. That is the interleaving which lost updates at `ebf589fa`: each writer
// built a whole Run from its own earlier read, and the later link wrote that
// snapshot back over the earlier one.
//
// At `ebf589fa` "pause then liveness" leaves `manualPauseAt === null`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLastRetryDecisionSink } from '../../../src/activation/phase-execution-wiring';
import { runCancel } from '../../../src/commands/cancel';
import { PhaseControlService } from '../../../src/controller/phase-control-service';
import { recordRunLiveness } from '../../../src/controller/run-liveness-recorder';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { KEYS, WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { LastRetryDecision, WorkflowRun } from '../../../src/state/workflow-run';
import { FakeMemento } from '../../fixtures/state/ownership-harness';
import {
  buildQueueRegistry,
  buildWorkflowRun,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

const QUEUE = DEFAULT_QUEUE_ID;
const BARRIER_QUEUE = fixtureQueueId(2);
const unfenced = unfencedCommit('test-fixture');
const OBSERVATION = { runId: 'run-1', at: 5_000, stdoutLines: 2, stderrLines: 1 };
const LIVENESS = { lastActivityAt: 5_000, stdoutLines: 2, stderrLines: 1 };
const DECISION: LastRetryDecision = {
  phase: 'speckit-plan',
  iteration: 1,
  decision: true,
  missingKeys: [],
  at: 6_000
} as LastRetryDecision;

/** A Memento whose writes wait on `gate`, so two writers can both read first. */
class GatedMemento extends FakeMemento {
  public gate: Promise<void> | null = null;
  override update(key: string, value: unknown): Thenable<void> {
    const wait = this.gate;
    return wait === null ? super.update(key, value) : wait.then(() => super.update(key, value));
  }
}

let memento: GatedMemento;
let store: WorkspaceStateStore;
let release: () => void;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(async () => {
  memento = new GatedMemento();
  await memento.update(KEYS.queueRegistry, buildQueueRegistry({ count: 2, defaultAtPosition: 0 }));
  await memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
  store = new WorkspaceStateStore(memento);
  vi.clearAllMocks();
});

const runningRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  ...buildWorkflowRun({ id: 'run-1', featureId: 'task-1' }),
  ...overrides
});

const holdWrites = () => {
  memento.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
};

/** Let every queued writer reach its link, release the gate, and wait out the chain. */
async function settle(): Promise<void> {
  await flush();
  memento.gate = null;
  release();
  await store.setRun(BARRIER_QUEUE, buildWorkflowRun({ id: 'barrier' }), unfenced);
}

/** Drain every pending microtask while the gate is still held. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** SC-002: whatever the order, the persisted Run satisfies `validateRunInvariants`. */
async function expectValid(): Promise<WorkflowRun> {
  const persisted = store.getRun(QUEUE)!;
  await expect(store.setRun(QUEUE, persisted, unfenced)).resolves.toBeUndefined();
  return persisted;
}

function phaseControl(): PhaseControlService {
  return new PhaseControlService({
    store,
    queue: {
      cascadedPause: vi.fn(async () => {}),
      cascadedResume: vi.fn(async () => {}),
      setQueuePausedState: vi.fn(async () => {})
    },
    logger,
    retryCoordinator: { cancelPendingTimer: vi.fn() },
    isDriving: vi.fn(() => false),
    noteActivePhaseOverrideAbort: vi.fn(),
    armIsContinue: vi.fn(),
    cancelActive: vi.fn(),
    resumeExisting: vi.fn(async () => true),
    auditor: {
      appendPhaseControl: vi.fn(async () => {}),
      emitTaskPaused: vi.fn(async () => {}),
      emitPhaseJumped: vi.fn(async () => {}),
      appendBreakpoint: vi.fn(async () => {})
    }
  } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);
}

function cancelContext(run: WorkflowRun) {
  return {
    controller: { cancelActive: vi.fn() },
    store,
    queue: {
      findById: vi.fn(() => ({ id: run.featureId, status: 'in-flight', runId: run.id })),
      queueIdForTask: vi.fn(() => QUEUE),
      finish: vi.fn(async () => ({ ok: true }))
    },
    audit: { append: vi.fn(async () => {}) },
    notifier: { info: vi.fn(), error: vi.fn() },
    logger,
    taskId: run.featureId
  } as unknown as Parameters<typeof runCancel>[0];
}

describe('pause and liveness (SC-002)', () => {
  it('pause first, then a liveness read taken before the pause landed: both persist', async () => {
    await store.setRun(QUEUE, runningRun(), unfenced);
    holdWrites();

    const paused = phaseControl().pauseActivePhase(QUEUE);
    recordRunLiveness({ store, logger: logger as never }, OBSERVATION);
    await settle();
    await paused;

    const persisted = await expectValid();
    expect(persisted.manualPauseAt).not.toBeNull();
    expect(persisted.manualPauseCause).toBe('operator-paused');
    expect(persisted.liveness).toEqual(LIVENESS);
  });

  it('liveness first, then a pause read taken before the liveness landed: both persist', async () => {
    await store.setRun(QUEUE, runningRun(), unfenced);
    holdWrites();

    recordRunLiveness({ store, logger: logger as never }, OBSERVATION);
    const paused = phaseControl().pauseActivePhase(QUEUE);
    await settle();
    await paused;

    const persisted = await expectValid();
    expect(persisted.manualPauseAt).not.toBeNull();
    expect(persisted.liveness).toEqual(LIVENESS);
  });
});

describe('a terminal write and a stale liveness (SC-002)', () => {
  it('terminal first: the stale liveness is refused and the Run stays terminal', async () => {
    const run = runningRun();
    await store.setRun(QUEUE, run, unfenced);
    holdWrites();

    const terminal = store.setRun(
      QUEUE,
      { ...run, status: 'completed', lastTransitionAt: 9_000 },
      unfenced
    );
    recordRunLiveness({ store, logger: logger as never }, OBSERVATION);
    await settle();
    await terminal;

    const persisted = await expectValid();
    expect(persisted.status).toBe('completed');
    expect(persisted.liveness).toBeUndefined();
  });

  it('liveness first: the terminal write still wins', async () => {
    const run = runningRun();
    await store.setRun(QUEUE, run, unfenced);
    holdWrites();

    recordRunLiveness({ store, logger: logger as never }, OBSERVATION);
    const terminal = store.setRun(
      QUEUE,
      { ...run, status: 'completed', lastTransitionAt: 9_000 },
      unfenced
    );
    await settle();
    await terminal;

    expect((await expectValid()).status).toBe('completed');
  });
});

describe('cancel and a retry decision (SC-002)', () => {
  // A pause was requested while the Run was still running, so the cancel has a
  // pause pair to clear. A cancel that left it behind is the one-sided state
  // `validateRunInvariants` exists to prevent.
  const pausedWhileRunning = () =>
    runningRun({ manualPauseAt: 1_000, manualPauseCause: 'operator-paused' });

  it('decision first: the Run ends canceled, both pairs cleared, the decision kept', async () => {
    const run = pausedWhileRunning();
    await store.setRun(QUEUE, run, unfenced);
    holdWrites();

    const decided = createLastRetryDecisionSink(store)(run.id, DECISION);
    const canceled = runCancel(cancelContext(run));
    await settle();
    await Promise.all([decided, canceled]);

    const persisted = await expectValid();
    expect(persisted.status).toBe('canceled');
    expect(persisted.manualPauseAt).toBeNull();
    expect(persisted.manualPauseCause).toBeNull();
    expect(persisted.pendingRetryAt).toBeNull();
    expect(persisted.pendingRetryCause).toBeNull();
    expect(persisted.lastRetryDecision).toEqual(DECISION);
  });

  it('cancel first: the stale decision is refused and the Run stays canceled', async () => {
    const run = pausedWhileRunning();
    await store.setRun(QUEUE, run, unfenced);
    holdWrites();

    const canceled = runCancel(cancelContext(run));
    await flush();
    const decided = createLastRetryDecisionSink(store)(run.id, DECISION);
    await settle();
    await Promise.all([decided, canceled]);

    const persisted = await expectValid();
    expect(persisted.status).toBe('canceled');
    expect(persisted.manualPauseAt).toBeNull();
    expect(persisted.pendingRetryAt).toBeNull();
    expect(persisted.lastRetryDecision).toBeUndefined();
  });
});
