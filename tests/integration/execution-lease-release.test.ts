// Feature 092 (T130, T131, BUG-001) — the execution lease's tenure.
//
// The drain claims a queue's execution lease at step 6 and hands off to the
// controller, so the lease is held for the *Run*, not for the drain call. The
// drain has returned long before the Run terminates, and nothing in the Run's
// terminal transition knew a lease existed
// (specs/092-multi-queue-concurrency/bugs/BUG-001.md). FR-033a gives the lease
// the tenure it was missing: released on every terminal status, before the next
// drain is scheduled.
//
// Feature 093 (T049a) — every case below now pairs `drainQueuedWork` with
// `drainedRunsSettled()`. The drain returns at admission rather than at the
// Run's terminal transition, so the first call means "the queue was offered
// work" and the second means "that work is over". These tests assert on the
// *second* — the release happens at the terminal transition — so they have to
// name it. The lease's tenure is unchanged; only the place a test can observe
// its end moved, which is the header note above restated after the split.
//
// EVERY assertion here runs with the fake clock NOT advanced. That is the whole
// test. Advancing past `STALENESS_THRESHOLD_MS` lets the reclaim path answer
// instead of the release path, and the file would pass against the leak while
// proving nothing about it.
//
// Feature 092 (T138, T139, BUG-003) — the *boundary* of that tenure. FR-033a
// named the statuses that end it, which is a rule about set membership and says
// nothing about non-members
// (specs/092-multi-queue-concurrency/bugs/BUG-003.md). The two tests at the foot
// of this file pin the two non-members: a `paused` Run keeps its queue, and a
// Run whose Task row is gone releases nothing. Both are narrowings that agree
// with the correct implementation on every input the tests above drive, so
// neither is reachable by strengthening them. The clock stays frozen for these
// two as well, and for the sharper reason: past the staleness threshold the
// reclaim hands the queue over no matter which guard is present.
//
// Feature 093 (T027) — every `getRun` here reads `QUEUE_A`, the queue the work
// was enqueued on, because the run store is now keyed by queue. Reading the
// default queue would answer `null` for all six and turn the status assertions
// into vacuous ones, which is the same reason `QUEUE_A` is not `'default'` to
// begin with.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceLockManager, type Clock, type Scheduler } from '../../src/state/lock';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { createQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { SanitizedLogger } from '../../src/lib/logger';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';

/** A queue that is not `'default'`, so the assertions are genuinely per queue. */
const QUEUE_A = '11111111-2222-4333-8444-555555555555';
const T0 = 1_700_000_000_000;
const FATAL_TEXT = 'error: unknown option';

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

/** Never advanced by any test in this file. See the header. */
class FrozenClock implements Clock {
  now(): number {
    return T0;
  }
}

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

const cleanStdout = (phase: string): string =>
  [
    '[SCHEGENT_STATUS: CLEAR]',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'open_questions: 0',
    'critical_issues: 0',
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

const buffer = (text: string): ZippedStreamBuffer => {
  const b = new ZippedStreamBuffer();
  if (text.length > 0) b.append(text);
  b.finalize();
  return b;
};

/** How the fake CLI drives the Run to each of the three terminal statuses. */
type TerminalMode = 'completed' | 'failed' | 'canceled';

interface Workspace {
  readonly memento: FakeMemento;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly controller: SchegentWorkflowController;
  readonly executionLease: ExecutionLeaseManager;
  /** Queues whose lease this window released, in order. */
  readonly released: string[];
  /**
   * Feature 092 (T138, T139) — runs once, inside the first phase's CLI
   * invocation, so a test can act on the Run while it is genuinely in flight.
   * The two BUG-003 cases both need that: an operator's pause and an operator's
   * task deletion are mid-Run events, and neither is reachable before the drain
   * call returns.
   */
  readonly midRun: { fn: (() => Promise<void>) | null };
}

async function makeWorkspace(tmpRoot: string, mode: TerminalMode): Promise<Workspace> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new FrozenClock();
  const lock = new WorkspaceLockManager(store, 'window-a', clock, noopScheduler);
  const leaseManager = new ExecutionLeaseManager(store, 'window-a', clock, noopScheduler);
  const released: string[] = [];

  // A controller reference the fake CLI can reach, so the 'canceled' mode can
  // abort mid-phase the way an operator's cancel does.
  let controllerRef: SchegentWorkflowController | null = null;

  const midRun: { fn: (() => Promise<void>) | null } = { fn: null };

  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    if (midRun.fn) {
      const act = midRun.fn;
      midRun.fn = null; // once, on the first phase only
      await act();
    }
    if (mode === 'failed') {
      return {
        stdoutBuffer: buffer(''),
        stderrBuffer: buffer(`error: ${FATAL_TEXT}\n`),
        exitCode: 1,
        killed: false,
        timedOut: false,
        durationMs: 1
      };
    }
    if (mode === 'canceled') {
      // The driver checks the abort signal at the top of the next phase
      // iteration, which is the same place an operator's cancel lands.
      controllerRef?.cancelActive();
    }
    return {
      stdoutBuffer: buffer(cleanStdout(req.phase)),
      stderrBuffer: buffer(''),
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 1
    };
  });

  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

  const controller = new SchegentWorkflowController(
    new PhaseRunner(runner, new PromptBuilder(), audit, logger),
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    {
      executionLease: {
        tryAcquire: (queueId: string) => leaseManager.tryAcquire(queueId),
        release: async (queueId: string) => {
          released.push(queueId);
          await leaseManager.release(queueId);
        }
      }
    }
  );
  controllerRef = controller;

  let registry = store.getQueueRegistry();
  registry = createQueue(registry, { id: QUEUE_A, name: 'Queue A', now: T0 });
  await store.setQueueRegistry(registry);
  await store.setGlobalConcurrencyCap(3);

  return { memento, store, queue, controller, executionLease: leaseManager, released, midRun };
}

/**
 * A second window, built over the same persisted state at assertion time so it
 * cannot be reading a snapshot taken before the Run terminated.
 */
async function rivalWindow(memento: FakeMemento): Promise<ExecutionLeaseManager> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return new ExecutionLeaseManager(store, 'window-b', new FrozenClock(), noopScheduler);
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-execution-lease-release-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('feature 092 (T130, BUG-001, FR-033a, SC-012) — a completed Run returns its queue lease', () => {
  it('lets a second owner acquire the queue with the clock not advanced', async () => {
    const w = await makeWorkspace(tmpRoot, 'completed');
    await w.queue.enqueue('task on A', { queueId: QUEUE_A });

    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    // The drain reached step 7 and the Run ran to a terminal state.
    expect(w.store.getRun(QUEUE_A)?.status).toBe('completed');

    // The queue is free the instant the Run ends — not 15 s later.
    expect(w.executionLease.isHeld(QUEUE_A)).toBe(false);
    const rival = await rivalWindow(w.memento);
    await expect(rival.tryAcquire(QUEUE_A)).resolves.toMatchObject({ acquired: true });
  });
});

describe('feature 092 (T131, BUG-001, FR-033a) — every terminal status returns the lease', () => {
  it('releases on a failed Run', async () => {
    const w = await makeWorkspace(tmpRoot, 'failed');
    await w.queue.enqueue('task on A', { queueId: QUEUE_A });

    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.store.getRun(QUEUE_A)?.status).toBe('failed');
    expect(w.executionLease.isHeld(QUEUE_A)).toBe(false);
    const rival = await rivalWindow(w.memento);
    await expect(rival.tryAcquire(QUEUE_A)).resolves.toMatchObject({ acquired: true });
  });

  it('releases on a canceled Run', async () => {
    const w = await makeWorkspace(tmpRoot, 'canceled');
    await w.queue.enqueue('task on A', { queueId: QUEUE_A });

    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.store.getRun(QUEUE_A)?.status).toBe('canceled');
    expect(w.executionLease.isHeld(QUEUE_A)).toBe(false);
    const rival = await rivalWindow(w.memento);
    await expect(rival.tryAcquire(QUEUE_A)).resolves.toMatchObject({ acquired: true });
  });

  // The drain's step-7 failure release and the Run's terminal release are
  // disjoint paths per the contract's tenure table: step 7 covers a start that
  // never reached the controller, and there is no Run to carry the tenure. A
  // fix that folds one into the other breaks this.
  it('keeps the drain step-7 failure release for a start that never reached the controller', async () => {
    const w = await makeWorkspace(tmpRoot, 'completed');
    await w.queue.enqueue('task on A', { queueId: QUEUE_A });

    vi.spyOn(w.controller, 'admitNew').mockRejectedValueOnce(new Error('start refused'));
    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    // No Run exists, so no terminal transition can have released anything —
    // the lease came back through step 7 alone.
    expect(w.store.getRun(QUEUE_A)).toBeNull();
    expect(w.released).toEqual([QUEUE_A]);
    expect(w.executionLease.isHeld(QUEUE_A)).toBe(false);
  });
});

describe('feature 092 (T138, BUG-003, FR-033a, SC-014) — a paused Run keeps its queue', () => {
  // The mutant this kills is `if (run.status === 'running') return;` — deriving
  // terminal by negating the active status. It satisfies FR-033a's enumerated
  // three, which is why every test above passes against it, and it also admits
  // `paused`. The driver reaches the release hook on a pause exit exactly as it
  // does on a terminal one, so the enumerated set is the only thing standing
  // between a mid-pause Run and a rival window.
  it('holds the lease across an operator pause with the clock not advanced', async () => {
    const w = await makeWorkspace(tmpRoot, 'completed');
    await w.queue.enqueue('task on A', { queueId: QUEUE_A });

    // An operator pause lands while the CLI is executing: the request is
    // persisted mid-phase and the post-phase decision converts it to `paused`.
    w.midRun.fn = async () => {
      await expect(w.controller.pauseActivePhase()).resolves.toMatchObject({ ok: true });
    };
    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.store.getRun(QUEUE_A)?.status).toBe('paused');

    // A paused Run still owns its queue, and the resume continues on this lease.
    expect(w.released).toEqual([]);
    expect(w.executionLease.isHeld(QUEUE_A)).toBe(true);
    const rival = await rivalWindow(w.memento);
    await expect(rival.tryAcquire(QUEUE_A)).resolves.toMatchObject({
      acquired: false,
      ownerId: 'window-a'
    });
  });
});

describe('feature 092 (T139, BUG-003, FR-033a, SC-014) — a Run with no Task row releases nothing', () => {
  // The mutant this kills deletes the `findById` guard, letting
  // `queueIdForTask`'s `?? DEFAULT_QUEUE_ID` fallback name a queue this Run
  // never held. `ExecutionLeaseManager.release()` admits it, because its only
  // check is `ownerId === this.ownerId` and every Run in one window shares that
  // owner id — so the wrong release succeeds silently.
  //
  // `deleteTask` is the production shape of the race: it releases this Run's
  // real queue while the row is still there, then removes the row, and the
  // driver's terminal funnel fires afterwards with a Run whose queue is no
  // longer resolvable. The guard's job is to make that second call a no-op.
  it('leaves a sibling Run\'s reserved-queue lease untouched', async () => {
    const w = await makeWorkspace(tmpRoot, 'completed');
    const task = await w.queue.enqueue('task on A', { queueId: QUEUE_A });

    // A sibling Run in this same window holds the reserved queue — the queue
    // the fallback would name. Same owner id, which is the whole exposure.
    await expect(w.executionLease.tryAcquire(DEFAULT_QUEUE_ID)).resolves.toMatchObject({
      acquired: true
    });

    w.midRun.fn = async () => {
      await expect(w.controller.deleteTask(task.id)).resolves.toMatchObject({ ok: true });
    };
    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    // The row is gone and the Run ended, so the funnel ran with an unresolvable
    // queue.
    expect(w.queue.findById(task.id)).toBeNull();
    expect(w.store.getRun(QUEUE_A)?.status).toBe('canceled');

    // The sibling's lease survives. Assert the lease, not the warning: the warn
    // is observable with the guard deleted too, since the mutant logs nothing.
    expect(w.executionLease.isHeld(DEFAULT_QUEUE_ID)).toBe(true);
    const rival = await rivalWindow(w.memento);
    await expect(rival.tryAcquire(DEFAULT_QUEUE_ID)).resolves.toMatchObject({
      acquired: false,
      ownerId: 'window-a'
    });

    // Exactly one release, for the queue this Run actually held, performed by
    // `deleteTask` before it removed the row.
    expect(w.released).toEqual([QUEUE_A]);
  });
});
