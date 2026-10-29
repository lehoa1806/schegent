// FR-R4-F20 (feature 248, contract T5, SC-001 and SC-002) — end to end: a Skip that names a failed Run
// is refused `run-failed` and changes nothing, and so does every other origin the Skip refuses.
//
// The chain is the real one, built as `removal-provenance.test.ts` builds its: a real
// `WorkspaceStateStore` over a `FakeMemento`, a real `QueueManager`, a real `SchegentWorkflowController`
// whose own object is the router's `PhaseOps`, and a real `MessageRouter`. A raw `CMD_SKIP_PHASE`
// message goes through `validateInboundMessage` first and, when that passes, through `router.dispatch`:
// the sidebar's own order, since `dispatch` takes a command that has already been validated.
//
// "Changes nothing" is measured, not assumed. One snapshot is taken before the dispatch and one after
// the `setImmediate` queue has drained (a Skip's resume is scheduled on it): the Run record, every
// row's id and status, the halt verdict `evaluateQueueHalt` derives from those rows, and the number of
// audit calls, resumes and timer cancellations. The halt verdict is in the snapshot so that a case
// cannot pass on a queue that was never halted, and the control at the end shows the snapshot does
// change when a Skip is admitted, so `after` equal to `before` is not a property of the harness.

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  effectiveQueueFailurePolicy,
  type QueueFailurePolicy
} from '../../src/contracts/queue-failure-policy';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import type { PhaseRunner } from '../../src/controller/phase-runner';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { evaluateQueueHalt, type QueueHaltVerdict } from '../../src/queue/queue-halt-policy';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun, WorkflowRunStatus } from '../../src/state/workflow-run';
import type { Notifier } from '../../src/ui/notifications';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { CMD_SKIP_PHASE, type CommandAckMessage } from '../../src/ui/sidebar/messages';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import { SPECKIT_ALL_PHASE_DEFS } from '../fixtures/speckit-catalog-fixture';

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

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

const STANDARD_PIPELINE = Object.freeze({
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: Object.freeze(
    ['speckit-specify', 'speckit-clarify', 'speckit-plan', 'speckit-tasks', 'finalize'].map((id) =>
      Object.freeze(SPECKIT_ALL_PHASE_DEFS.find((phase) => phase.id === id)!)
    )
  )
});

const CURRENT_PHASE = 'speckit-clarify';
// In the Run's snapshot but not the current Phase.
const NOT_CURRENT_PHASE = 'speckit-plan';
const UNKNOWN_PHASE = 'not-a-phase';
const RUN_ID = 'run-skip-1';
// A second queue, registered by the cases that need a Run on another queue.
const OTHER_QUEUE_ID = '22222222-3333-4444-8555-666666666666';
const OTHER_RUN_ID = 'run-other-queue';

/** The state of the row a Run in `status` leaves its Task in. */
const ROW_END: Partial<Record<WorkflowRunStatus, 'failed' | 'completed' | 'canceled'>> = {
  failed: 'failed',
  completed: 'completed',
  canceled: 'canceled'
};

interface Snapshot {
  readonly run: WorkflowRun | null;
  readonly rows: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly halt: QueueHaltVerdict | null;
  readonly auditCalls: number;
  readonly resumeCalls: number;
  readonly timerCancels: number;
}

interface Sent {
  readonly validation: ReturnType<typeof validateInboundMessage>;
  readonly ack: CommandAckMessage | undefined;
}

let store: WorkspaceStateStore;
let queue: QueueManager;
let router: MessageRouter;
let skipPhaseSpy: MockInstance;
let auditSpies: readonly MockInstance[];
let resumeExisting: MockInstance;
let cancelPendingTimer: MockInstance;

beforeEach(async () => {
  const logger = new SanitizedLogger();
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  const controller = new SchegentWorkflowController(
    { run: vi.fn(), evictStagnationTracker: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    makeLock(),
    { cliPath: 'noop', cwd: '/repo', iterationCap: 5, timeoutMs: 1000 }
  );

  // The controller's own collaborators are observed where the phase-control service reaches them: the
  // service holds closures that look each one up on `this` at call time, so replacing or spying the
  // member here is seen at the call site. No audit line is written and no Run is driven.
  const internals = controller as unknown as {
    lifecycleAuditor: Record<string, (...args: never[]) => unknown>;
    retryCoordinator: { cancelPendingTimer: (queueId: string) => void };
    cancelActive: () => void;
    resumeExisting: () => Promise<void>;
  };
  auditSpies = (
    ['appendPhaseControl', 'emitPhaseJumped', 'appendBreakpoint', 'emitTaskLifecycle'] as const
  ).map((method) => vi.spyOn(internals.lifecycleAuditor, method).mockResolvedValue(undefined));
  cancelPendingTimer = vi.spyOn(internals.retryCoordinator, 'cancelPendingTimer');
  resumeExisting = vi.fn(async () => {}) as unknown as MockInstance;
  internals.resumeExisting = resumeExisting as unknown as () => Promise<void>;
  internals.cancelActive = vi.fn();
  skipPhaseSpy = vi.spyOn(controller, 'skipPhase');

  const deps: RouterDeps = {
    executeCommand: vi.fn() as unknown as RouterDeps['executeCommand'],
    phaseOps: controller,
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: () => undefined,
    logger
  };
  router = new MessageRouter(deps);
});

function buildRun(
  runId: string,
  featureId: string,
  status: WorkflowRunStatus,
  pendingRetry: boolean
): WorkflowRun {
  const now = Date.now();
  return {
    id: runId,
    featureId,
    featureDir: 'specs/001-existing',
    status,
    currentPhase: CURRENT_PHASE,
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
    lastError:
      status === 'failed'
        ? { code: 'Error', message: 'Boom', phase: null, iteration: null, at: now }
        : null,
    pipeline: STANDARD_PIPELINE,
    delayedRetryCount: pendingRetry ? 1 : 0,
    pendingRetryAt: pendingRetry ? now + 60_000 : null,
    pendingRetryCause: pendingRetry ? 'transient_error' : null,
    phaseOverrides: [],
    manualPauseAt: status === 'paused' ? now : null,
    manualPauseCause: status === 'paused' ? 'operator-paused' : null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  } as unknown as WorkflowRun;
}

interface SeedOptions {
  readonly pendingRetry?: boolean;
  readonly policy?: QueueFailurePolicy;
  readonly runId?: string;
}

/**
 * One Task row and, unless `status` is null, the Run on it, with the row left as that Run's status
 * leaves it. The queue's failure policy is stored explicitly, so a halt is never an accident of the
 * workspace default.
 */
async function seedQueue(
  status: WorkflowRunStatus | null,
  options: SeedOptions = {}
): Promise<{ readonly rowId: string }> {
  const row = await queue.enqueue(`task whose run is ${status ?? 'absent'}`);
  if (status !== null) {
    const runId = options.runId ?? RUN_ID;
    await queue.markInFlight(row.id, runId);
    const end = ROW_END[status];
    if (end !== undefined) await queue.finish(row.id, end);
    await store.setRun(
      DEFAULT_QUEUE_ID,
      buildRun(runId, row.id, status, options.pendingRetry ?? false),
      unfencedCommit('test-fixture')
    );
  }
  await queue.setFailurePolicy(DEFAULT_QUEUE_ID, options.policy ?? 'halt-on-failure');
  return { rowId: row.id };
}

/** Registers a second queue and seeds a `running` Run on it, for the cases that name another queue's Run. */
async function seedOtherQueueRun(): Promise<void> {
  const registry = store.getQueueRegistry();
  const stamp = 1_700_000_000_000;
  await store.setQueueRegistry({
    entries: [
      ...registry.entries,
      {
        id: OTHER_QUEUE_ID,
        name: 'Other queue',
        position: registry.entries.length,
        schedule: null,
        createdAt: stamp,
        updatedAt: stamp
      }
    ],
    updatedAt: stamp
  });
  const row = await queue.enqueue('task on the other queue', { queueId: OTHER_QUEUE_ID });
  await queue.markInFlight(row.id, OTHER_RUN_ID);
  await store.setRun(
    OTHER_QUEUE_ID,
    buildRun(OTHER_RUN_ID, row.id, 'running', false),
    unfencedCommit('test-fixture')
  );
}

function snapshot(queueId: string = DEFAULT_QUEUE_ID): Snapshot {
  const queueState = store.getQueue(queueId);
  const run = store.getRun(queueId) ?? null;
  // The default is `continue`, not the product default: a case that forgot to store a policy then
  // reads as not halted and fails its halt assertion, rather than passing by an inherited default.
  const policy = effectiveQueueFailurePolicy(queueState.failurePolicy, 'continue');
  return {
    run: run === null ? null : structuredClone(run),
    rows: queueState.requests.map((row) => ({ id: row.id, status: row.status })),
    halt: evaluateQueueHalt(policy, queueState.requests),
    auditCalls: auditSpies.reduce((total, spy) => total + spy.mock.calls.length, 0),
    resumeCalls: resumeExisting.mock.calls.length,
    timerCancels: cancelPendingTimer.mock.calls.length
  };
}

/** The sidebar's own order: validate the raw message, then dispatch the command it yields. */
async function sendSkip(payload: unknown): Promise<Sent> {
  const validation = validateInboundMessage({ type: CMD_SKIP_PHASE, correlationId: 'skip-1', payload });
  if (!validation.ok) return { validation, ack: undefined };
  const acks: CommandAckMessage[] = [];
  await router.dispatch(validation.command, async (msg) => {
    acks.push(msg as CommandAckMessage);
    return true;
  });
  return { validation, ack: acks[0] };
}

const drainImmediates = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Send one Skip, then assert it was refused with `reason` and that every snapshot field held. */
async function expectRefusedUnchanged(
  payload: unknown,
  reason: string
): Promise<{ readonly before: Snapshot; readonly after: Snapshot }> {
  const before = snapshot();
  const sent = await sendSkip(payload);
  await drainImmediates();
  const after = snapshot();
  expect(sent.validation.ok).toBe(true);
  expect(sent.ack).toMatchObject({ status: 'rejected', outcome: 'refused', reason });
  expect(after).toEqual(before);
  return { before, after };
}

const skipOf = (runId: string, phaseId: string): Record<string, string> => ({
  queueId: DEFAULT_QUEUE_ID,
  runId,
  phaseId
});

describe('FR-R4-F20 — a failed Run cannot be skipped (contract T5, SC-001, SC-002)', () => {
  it('T5.1 refuses a failed Run and leaves the queue halted on the same failed row', async () => {
    const { rowId } = await seedQueue('failed');

    const { before, after } = await expectRefusedUnchanged(skipOf(RUN_ID, CURRENT_PHASE), 'run-failed');

    // The halt is part of the snapshot so this cannot pass on a queue that was never halted.
    expect(before.rows).toEqual([{ id: rowId, status: 'failed' }]);
    expect(before.halt).toEqual({ taskId: rowId, taskName: expect.any(String) });
    expect(after.halt).toEqual(before.halt);
    expect(after.run?.status).toBe('failed');
    expect(skipPhaseSpy).toHaveBeenCalledTimes(1);
  });

  it('T5.2 refuses a failed Run that has a pending retry the same way', async () => {
    const { rowId } = await seedQueue('failed', { pendingRetry: true });

    const { before } = await expectRefusedUnchanged(skipOf(RUN_ID, CURRENT_PHASE), 'run-failed');

    expect(before.run?.pendingRetryAt).not.toBeNull();
    expect(before.halt).toEqual({ taskId: rowId, taskName: expect.any(String) });
  });

  it('T5.3 answers run-failed, not phase-not-active, for a Phase that is in the snapshot but not current', async () => {
    await seedQueue('failed');

    await expectRefusedUnchanged(skipOf(RUN_ID, NOT_CURRENT_PHASE), 'run-failed');
  });

  it('T5.12 refuses a failed Run on a continue queue, which is not halted before or after', async () => {
    await seedQueue('failed', { policy: 'continue' });

    const { before, after } = await expectRefusedUnchanged(skipOf(RUN_ID, CURRENT_PHASE), 'run-failed');

    expect(before.halt).toBeNull();
    expect(after.halt).toBeNull();
  });

  // US3 (FR-006 to FR-008, SC-002) — the origins the Skip refused before this feature and must still
  // refuse with the same reason, and the two it refuses at a new place. Each leaves no trace.
  it('T5.4 refuses a completed Run as run-terminal, for a Phase in its snapshot', async () => {
    await seedQueue('completed');

    await expectRefusedUnchanged(skipOf(RUN_ID, CURRENT_PHASE), 'run-terminal');
  });

  it('T5.5 refuses a canceled Run as run-terminal on its current Phase', async () => {
    await seedQueue('canceled');

    await expectRefusedUnchanged(skipOf(RUN_ID, CURRENT_PHASE), 'run-terminal');
  });

  it('T5.6 refuses a running Run\'s non-current Phase as phase-not-active', async () => {
    await seedQueue('running');

    await expectRefusedUnchanged(skipOf(RUN_ID, NOT_CURRENT_PHASE), 'phase-not-active');
  });

  it('T5.7 refuses a paused Run\'s non-current Phase as phase-not-active', async () => {
    await seedQueue('paused');

    await expectRefusedUnchanged(skipOf(RUN_ID, NOT_CURRENT_PHASE), 'phase-not-active');
  });

  it('T5.8 refuses a Phase the running Run does not carry as phase-id-not-in-pipeline-snapshot', async () => {
    await seedQueue('running');

    await expectRefusedUnchanged(
      skipOf(RUN_ID, UNKNOWN_PHASE),
      'phase-id-not-in-pipeline-snapshot'
    );
  });

  it('T5.9 refuses a queue with no Run as no-run-in-flight', async () => {
    await seedQueue(null);

    await expectRefusedUnchanged(skipOf(RUN_ID, CURRENT_PHASE), 'no-run-in-flight');
  });

  // US3-5 — the Run was replaced after the operator opened the confirmation. The new Run has a current
  // Phase of the same id, so at 5c015930 the Skip was admitted against the successor.
  it('T5.10 refuses a Skip that names a replaced Run, though the new Run\'s current Phase has the same id', async () => {
    const { rowId } = await seedQueue('running', { runId: 'run-old' });
    await store.setRun(
      DEFAULT_QUEUE_ID,
      buildRun('run-new', rowId, 'running', false),
      unfencedCommit('test-fixture')
    );

    const { before } = await expectRefusedUnchanged(skipOf('run-old', CURRENT_PHASE), 'no-run-in-flight');

    // The successor was not skipped, and is the Run the queue holds.
    expect(before.run?.id).toBe('run-new');
    expect(snapshot().run?.phaseOverrides).toEqual([]);
  });

  // The spec's edge case: a Run id that names a real Run, on a different queue. Both queues' snapshots
  // hold, so the refusal is neither a no-op on the wrong queue nor a write to the other one.
  it('T5.10 refuses a Skip that names a Run held by another queue, and moves neither queue', async () => {
    await seedQueue('running');
    await seedOtherQueueRun();
    const defaultBefore = snapshot(DEFAULT_QUEUE_ID);
    const otherBefore = snapshot(OTHER_QUEUE_ID);
    expect(otherBefore.run?.id).toBe(OTHER_RUN_ID);

    const sent = await sendSkip(skipOf(OTHER_RUN_ID, CURRENT_PHASE));
    await drainImmediates();

    expect(sent.ack).toMatchObject({ status: 'rejected', outcome: 'refused', reason: 'no-run-in-flight' });
    expect(snapshot(DEFAULT_QUEUE_ID)).toEqual(defaultBefore);
    expect(snapshot(OTHER_QUEUE_ID)).toEqual(otherBefore);
  });

  // US3-6 — a Skip that names no Run never reaches a handler. The boundary refuses it, so nothing below
  // the validator runs: no ACK, no controller call. T5.1 is the control: its `skipPhase` spy is hit.
  it('T5.11 refuses a Skip with no runId at the boundary, before any handler runs', async () => {
    await seedQueue('running');
    const before = snapshot();

    const sent = await sendSkip({ queueId: DEFAULT_QUEUE_ID, phaseId: CURRENT_PHASE });
    await drainImmediates();

    expect(sent.validation).toMatchObject({ ok: false, reason: 'invalid-runId' });
    expect(sent.ack).toBeUndefined();
    expect(skipPhaseSpy).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  // The control that makes the rows above mean something. The same harness, the same Skip, a Run that
  // may be skipped: the snapshot moves (an override, an audit row, a phase-jumped row), so `after`
  // equal to `before` in T5.1 to T5.3 is a measurement of the refusal and not a blind spot.
  it('control: a running Run is skipped, and the same snapshot sees the write', async () => {
    await seedQueue('running');
    const before = snapshot();

    const sent = await sendSkip(skipOf(RUN_ID, CURRENT_PHASE));
    await drainImmediates();
    const after = snapshot();

    expect(sent.ack).toMatchObject({ status: 'accepted' });
    expect(after).not.toEqual(before);
    expect(after.run?.phaseOverrides).toEqual([
      expect.objectContaining({ phaseId: CURRENT_PHASE, action: 'skipped' })
    ]);
    expect(after.auditCalls).toBeGreaterThan(before.auditCalls);
  });
});
