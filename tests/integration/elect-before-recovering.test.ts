// FR-R3-070 (feature 152) — the resume path cannot drive a Run another window
// owns, regardless of activation ordering.
//
// The activation-ordering half (elect before installing recovery) is pinned by
// tests/lint/elect-before-recovering.test.ts and exercised in
// tests/unit/extension/activate.test.ts. This file is the composition check for
// the defence-in-depth half: `resumeExistingOnQueue` claims the per-queue
// execution lease before it marks anything in flight, so even a resume that
// slips past ordering (the setImmediate(delay === 0) shape REL-01 reported)
// spawns nothing while a competing window holds the queue.
//
// Two hosts share one ownership registry — the disk arbitration surface — while
// keeping their own mementos, exactly the production topology two VS Code
// windows have on one workspace.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import {
  SharedOwnershipFs,
  OWNERSHIP_DIR,
  ManualClock,
  ManualScheduler
} from '../fixtures/state/ownership-harness';
import { createStage2Producers } from '../../src/activation/stage2-producers';
import { wirePrimacyGain } from '../../src/activation/primacy-gain-wiring';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import {
  WorkspaceLockManager,
  HEARTBEAT_INTERVAL_MS,
  STALENESS_THRESHOLD_MS
} from '../../src/state/lock';
import type { WorkflowControllerDeps } from '../../src/controller/workflow-controller';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { removeTempRoot } from '../temp-root-cleanup';

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

/** A runner whose every spawn is countable and fails transiently. */
function makeCountingRunner(): { runner: ClaudeCliRunner; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => ({
    stdoutBuffer: (() => {
      const b = new ZippedStreamBuffer();
      b.append('');
      b.finalize();
      return b;
    })(),
    stderrBuffer: (() => {
      const b = new ZippedStreamBuffer();
      b.finalize();
      return b;
    })(),
    exitCode: 1,
    killed: false,
    timedOut: false,
    durationMs: 1
  }));
  return {
    invoke,
    runner: {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner
  };
}

function makeLock(ownerId: string): WorkspaceLockManager {
  return {
    release: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(() => true),
    ownerOfRecord: vi.fn(),
    id: ownerId
  } as unknown as WorkspaceLockManager;
}

interface Host {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  invoke: ReturnType<typeof vi.fn>;
}

async function makeHost(
  ownerId: string,
  shared: SharedOwnershipFs,
  workspaceRoot: string
): Promise<Host> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const { runner, invoke } = makeCountingRunner();
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  // The production topology: mementos are per window, arbitration is shared.
  store.useOwnershipStorage(shared, OWNERSHIP_DIR);
  const queue = new QueueManager(store);
  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  const deps: WorkflowControllerDeps = { catalog: buildSpeckitCatalog(), auditWriter: audit };
  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    makeLock(ownerId),
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000 },
    deps
  );
  return { controller, store, queue, invoke };
}

let tmpA: string;
let tmpB: string;

beforeEach(async () => {
  tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-elect-a-'));
  tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-elect-b-'));
});

afterEach(async () => {
  await removeTempRoot(tmpA);
  await removeTempRoot(tmpB);
});

describe('FR-R3-070 — a resume cannot drive a Run while another window holds the queue', () => {
  it('declines the resume while window A holds the execution lease, and resumes once A releases', async () => {
    const shared = new SharedOwnershipFs();
    const hostB = await makeHost('window-b', shared, tmpB);

    // Window B has a persisted, resumable Run: one real (transiently failing)
    // start, exactly the state an elapsed pendingRetryAt re-arms against.
    const feature = await hostB.queue.enqueue('two-window fixture task');
    await hostB.controller.startNew(feature, null);
    expect(hostB.invoke).toHaveBeenCalledTimes(1);
    expect(hostB.store.getRun(DEFAULT_QUEUE_ID)).not.toBeNull();

    // Window A claims the queue on the shared registry with a fresh heartbeat
    // — a competing window mid-drive on the same checkout.
    const leaseA = new ExecutionLeaseManager(
      await (async () => {
        const storeA = new WorkspaceStateStore(new FakeMemento());
        await storeA.initialize();
        storeA.useOwnershipStorage(shared, OWNERSHIP_DIR);
        return storeA;
      })(),
      'window-a'
    );
    expect((await leaseA.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);

    // The defence in depth: B's resume — the same path activation's elapsed
    // delayed-retry takes — declines instead of spawning a second process.
    const resumedWhileHeld = await hostB.controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumedWhileHeld).toBe(false);
    expect(hostB.invoke).toHaveBeenCalledTimes(1); // still exactly one spawn
    expect(hostB.store.getRun(DEFAULT_QUEUE_ID)!.status).not.toBe('running');

    // A releases; the same resume now proceeds — the decline was contention,
    // not a broken path.
    await leaseA.release(DEFAULT_QUEUE_ID);
    const resumedAfterRelease = await hostB.controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumedAfterRelease).toBe(true);
    expect(hostB.invoke).toHaveBeenCalledTimes(2);
  });

  it('a stale holder does not block the resume (crash recovery keeps working)', async () => {
    const shared = new SharedOwnershipFs();
    const hostB = await makeHost('window-b', shared, tmpB);
    const feature = await hostB.queue.enqueue('stale-holder fixture task');
    await hostB.controller.startNew(feature, null);
    expect(hostB.invoke).toHaveBeenCalledTimes(1);

    // A crashed window left a lease whose heartbeat is far past the 15 s
    // staleness threshold: the claim must reclaim, not deadlock recovery.
    const staleClock = { now: () => Date.now() - 60_000 };
    const storeA = new WorkspaceStateStore(new FakeMemento());
    await storeA.initialize();
    storeA.useOwnershipStorage(shared, OWNERSHIP_DIR);
    const leaseA = new ExecutionLeaseManager(
      storeA,
      'window-a',
      staleClock as unknown as ConstructorParameters<typeof ExecutionLeaseManager>[2]
    );
    expect((await leaseA.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);

    const resumed = await hostB.controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumed).toBe(true);
    expect(hostB.invoke).toHaveBeenCalledTimes(2);
  });
});

/**
 * Drain the microtask and immediate queues a fire-and-forget recovery starts on.
 * Enough to make a recovery that HAS been dispatched observable; not enough to
 * reach the spawn at the end of one, which is waited for instead.
 */
async function flush(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((r) => setImmediate(r));
}

describe('FR-032 (BUG-001, SC-011) — the window that lost the election recovers on its own', () => {
  // THE ARM T980 DOES NOT COVER, and the one the bug was filed about. T980's two
  // arms are "A present at B's activation" (B declines, correctly) and "A absent
  // at B's activation" (B elects and resumes). Both are about the instant B
  // activates. The gap is the third case: A present WHEN B ELECTS and gone
  // afterwards, without ever releasing — the shape a crashed or force-quit host
  // leaves. Before FR-032 the interval was armed only on the winning branch, so
  // B asked exactly once, lost correctly, and stayed passive for the rest of its
  // life; the filed instance ran 6h28m and was recoverable only by restarting
  // VS Code.
  it('claims primacy once the holder goes stale and resumes the persisted Run, with zero activations in between', async () => {
    const shared = new SharedOwnershipFs();
    const hostB = await makeHost('window-b', shared, tmpB);

    // Window A: a real lock manager holding real primacy on the shared registry,
    // on its own clock. It is never released and never beats again — the point
    // of the fixture is a holder that stops existing without saying so.
    const storeA = new WorkspaceStateStore(new FakeMemento());
    await storeA.initialize();
    storeA.useOwnershipStorage(shared, OWNERSHIP_DIR);
    const clockA = new ManualClock();
    const lockA = new WorkspaceLockManager(storeA, 'window-a', clockA, new ManualScheduler());
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    const heldSince = clockA.current;

    // B has the state a primary window recovers at activation: one real
    // (transiently failing) start, then a delayed-retry deadline moved into the
    // past. `resumeExistingFromActivation` resumes an elapsed deadline
    // immediately, so a spawn is what recovery looks like from outside.
    const feature = await hostB.queue.enqueue('late-primacy fixture task');
    await hostB.controller.startNew(feature, null);
    expect(hostB.invoke).toHaveBeenCalledTimes(1);
    const persisted = hostB.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(persisted.pendingRetryAt).not.toBeNull();
    expect(persisted.pendingRetryCause).not.toBeNull();
    await hostB.store.setRun(
      DEFAULT_QUEUE_ID,
      { ...persisted, pendingRetryAt: Date.now() - 60_000 },
      unfencedCommit('test-fixture')
    );

    // B's Stage 2, composed the way `wireStage2` composes it: the real lock on
    // B's own clock, the producers, and the one subscriber that turns a later
    // gain into the recovery installers. The preamble thunks are counted because
    // "zero activations in between" is a claim about them.
    const clockB = new ManualClock();
    const schedulerB = new ManualScheduler();
    const lockB = new WorkspaceLockManager(hostB.store, 'window-b', clockB, schedulerB);
    const logger = new SanitizedLogger();
    const preamble = {
      replayTerminalTransitions: vi.fn(async () => undefined),
      replayEvidenceBacklog: vi.fn(async () => undefined),
      refreshCatalog: vi.fn(async () => undefined),
      startMountProbe: vi.fn()
    };
    // Two of the five primacy-gated installers, counted. They are the cheapest
    // evidence that the gate itself flipped, so a resume that fails downstream
    // reads differently from a gain that never reached the installers.
    const reArm = vi.fn(async () => undefined);
    const reattachOnActivation = vi.fn(async () => undefined);
    const producers = createStage2Producers({
      isWorkspaceTrusted: () => true,
      logger,
      store: hostB.store,
      auditWriter: new AuditLogWriter({ workspaceRoot: tmpB }, logger),
      lock: lockB,
      // The controller carries this file's existing stub lock, which reports
      // primacy unconditionally. That is deliberate here: it removes the second
      // line of defence, so the ONLY thing standing between the persisted Run
      // and a spawn is the election gate this test is about.
      controller: hostB.controller,
      watchdog: { reattachOnActivation },
      scheduledStartCoordinator: { reArm },
      replayEvidenceBacklog: preamble.replayEvidenceBacklog,
      runSafety: {
        replayTerminalTransitions: preamble.replayTerminalTransitions,
        sweepCheckpointRetention: vi.fn(async () => undefined)
      },
      backendCapabilities: { scan: vi.fn(async () => undefined) },
      startMountProbe: preamble.startMountProbe,
      refreshCatalog: preamble.refreshCatalog
    });
    const gainSubscription = wirePrimacyGain({ logger, lock: lockB, producers });

    try {
      // Activation. B contests, loses to a live A, runs its whole preamble, and
      // installs none of the five recovery producers. The elapsed deadline stays
      // persisted, addressable by whoever is primary — the decline-and-retain
      // shape FR-R3-070 established.
      await producers.run();
      await flush();
      expect(producers.hasRun()).toBe(true);
      expect(hostB.invoke).toHaveBeenCalledTimes(1);
      expect(hostB.store.getRun(DEFAULT_QUEUE_ID)!.pendingRetryAt).not.toBeNull();

      expect(await lockB.hasPrimacy()).toBe(false);

      // The beats below are hand-driven, and THIS is what makes that legitimate
      // rather than fictional: losing armed an interval at the production
      // cadence, so the loop replays beats the host takes on its own. Without
      // it the loop would be testing a timer no window ever starts — which is
      // precisely the bug. (That the arming happens on BOTH outcomes is
      // `tests/unit/state/lock.test.ts`'s assertion; here it is the premise.)
      // Mapped rather than indexed: the count and the cadence in one assertion,
      // and it satisfies both ratchets at once — indexing trips
      // `noUncheckedIndexedAccess` in `compiler-strictness-ratchet.test.ts`, and
      // guarding that index with `?.` trips `no-unnecessary-condition` in `lint`.
      expect(schedulerB.intervals.map((entry) => entry.ms)).toEqual([HEARTBEAT_INTERVAL_MS]);

      // Beat at the production cadence until the contest is won — one beat per
      // `HEARTBEAT_INTERVAL_MS`, never a jump to the threshold, so the interval
      // recorded at the end is the one the real timer would produce rather than
      // a figure this loop chose. Every beat inside the staleness window loses,
      // and losing is silent: no resume, no second activation, nothing retried.
      // That stretch is what the bug reported as a stall; what makes it a
      // stretch rather than a terminal state is that B is still asking.
      const MAX_BEATS = 10; // Runaway guard: 50 s of simulated time, ~3 windows.
      let beats = 0;
      for (; beats < MAX_BEATS && !(await lockB.hasPrimacy()); beats += 1) {
        expect(hostB.invoke).toHaveBeenCalledTimes(1);
        expect(reArm).not.toHaveBeenCalled();
        clockB.advance(HEARTBEAT_INTERVAL_MS);
        await lockB.tick();
        await flush();
      }

      expect(await lockB.hasPrimacy()).toBe(true);
      expect(reArm).toHaveBeenCalledTimes(1);
      expect(reattachOnActivation).toHaveBeenCalledTimes(1);

      // The spawn is WAITED FOR rather than flushed to, and the two are not
      // interchangeable. `installRecovery` hands the elapsed deadline to
      // `resumeExistingFromActivation`, which dispatches through `setImmediate`
      // and hands the drive's promise to nobody — so no amount of queue draining
      // in the test is guaranteed to reach a spawn that is several real awaits
      // (an audit append among them) past the gain. Draining and then asserting
      // would make this test a race that passes on a fast machine.
      await vi.waitFor(() => {
        expect(hostB.invoke).toHaveBeenCalledTimes(2);
      });
      // And run to completion, so the drive is finished before `afterEach`
      // removes the workspace root it is still appending audit records to.
      await vi.waitFor(() => {
        expect(hostB.store.getRun(DEFAULT_QUEUE_ID)!.status).not.toBe('running');
      });

      // ZERO ACTIVATIONS IN BETWEEN, stated as the four things an activation
      // would have done again. The recovery arrived through `installRecovery`
      // from a lock event; nothing re-entered `run()`, no window reloaded, and
      // the operator did nothing.
      expect(preamble.replayTerminalTransitions).toHaveBeenCalledTimes(1);
      expect(preamble.replayEvidenceBacklog).toHaveBeenCalledTimes(1);
      expect(preamble.refreshCatalog).toHaveBeenCalledTimes(1);
      expect(preamble.startMountProbe).toHaveBeenCalledTimes(1);

      // SC-011 — RECORDED, with only its floor asserted. The interval itself is a
      // consequence of `STALENESS_THRESHOLD_MS` and the beat cadence, both tuning
      // knobs; pinning it would turn a tuning decision into a failing integration
      // test and teach the next person to edit the number rather than read it. The
      // floor is not a tuning knob: recovering before the threshold would mean B
      // took a lease that was still live, so that much is a real assertion. The
      // figure is simulated time on `clockB` — no real timer runs in this file.
      const recoveredAfterMs = clockB.current - heldSince;
      console.log(
        `FR-032/SC-011 — B recovered ${recoveredAfterMs} ms (simulated) after A's last ` +
          `heartbeat, over ${beats} beats`
      );
      expect(recoveredAfterMs).toBeGreaterThanOrEqual(STALENESS_THRESHOLD_MS);
    } finally {
      gainSubscription.dispose();
      await lockB.release();
    }
  });
});
