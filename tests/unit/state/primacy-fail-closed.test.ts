// FR-R3-024 (FR-019, SC-009) — what every rewired decision site does when the
// ownership record cannot be read at all.
//
// `hasPrimacy()` fails closed: `verifyClaim()` resolving `unavailable` is not
// `valid`, so the answer is `false` and the caller stands down. That is the rule
// `tryAcquire()` already states — refuse to acquire, never assume acquired —
// applied at the point of effect rather than at acquisition.
//
// The posture is only worth having if it is the same posture everywhere, so the
// three shapes of caller are covered here together:
//
//   1. The predicate itself, on the real store: an unanswerable storage layer
//      makes the authoritative and advisory predicates *diverge*. This is the
//      case the FR-R3-024 rewire exists for — before it, six decision sites
//      read the predicate that answers `true` here.
//   2. The palette mutations (`queue-ops`, seven entry points): refuse, tell the
//      operator once, and let nothing reach the queue.
//   3. The schedule watchdog: refuse, and leave the deadline persisted so the
//      next tick retries. A refusal there is a *deferral*, not a loss, and the
//      difference is only observable across two ticks — which is why the last
//      test drives both.
//
// The storage fault is injected on the real `SharedOwnershipFs` rather than by
// stubbing `verifyClaim`, so the `unavailable` verdict is produced by the code
// that produces it in production: `readState()` lists the ownership directory,
// the list throws, and `verify()` translates the throw into a refusal.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceLockManager } from '../../../src/state/lock';
import { QueueScheduleWatchdog } from '../../../src/controller/schedule-watchdog';
import type { QueueState } from '../../../src/queue/feature-request';
import {
  runClearCompleted,
  runClearFailed,
  runMoveQueuedItemDown,
  runMoveQueuedItemUp,
  runPauseQueue,
  runResumeQueue,
  runRetryQueuedItem,
  type QueueOpsCtx
} from '../../../src/commands/queue-ops';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs,
  type Host
} from '../../fixtures/state/ownership-harness';

let fs: SharedOwnershipFs;
let host: Host;
let clock: ManualClock;
let scheduler: ManualScheduler;
let lock: WorkspaceLockManager;

beforeEach(async () => {
  fs = new SharedOwnershipFs();
  host = (await createHosts(1, fs))[0]!;
  clock = new ManualClock();
  scheduler = new ManualScheduler();
  lock = new WorkspaceLockManager(host.store, 'window-a', clock, scheduler);
  expect((await lock.tryAcquire()).acquired).toBe(true);
});

/** Storage stops answering. The claim is untouched; it is unverifiable. */
function loseStorage(): void {
  fs.faults.failList = true;
}

/**
 * A `QueueOpsCtx` whose queue records any method reached rather than doing the
 * work. A `Proxy` rather than a handful of `vi.fn()`s so the assertion is
 * "*nothing* reached the queue" and not "none of the methods I remembered to
 * stub reached the queue" — a refusal that leaked through a method added later
 * would still be caught.
 */
function makeOpsCtx(): {
  ctx: QueueOpsCtx;
  touched: string[];
  notifier: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const touched: string[] = [];
  const queue = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        return (..._args: unknown[]) => {
          touched.push(prop);
          return Promise.resolve({ ok: true, removed: 0 });
        };
      }
    }
  );
  const notifier = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    ctx: { queue, lock, notifier, logger } as unknown as QueueOpsCtx,
    touched,
    notifier
  };
}

/**
 * The seven palette mutations, each with the argument its command passes and
 * the `QueueManager` methods it is expected to reach.
 *
 * The expected methods were a bare count of 1 until `retry` grew a second call:
 * it resolves `queueIdForTask` before mutating, so its caller can drain *that*
 * queue rather than sweeping Default. Naming the methods instead of counting
 * them keeps the positive control specific — a count would have been satisfied
 * by the read alone once the mutation stopped happening.
 */
const QUEUE_OPS: ReadonlyArray<
  readonly [string, (ctx: QueueOpsCtx) => Promise<unknown>, readonly string[]]
> = [
  ['retry', (ctx) => runRetryQueuedItem('item-1', ctx), ['queueIdForTask', 'retry']],
  ['move up', (ctx) => runMoveQueuedItemUp('item-1', ctx), ['moveUp']],
  ['move down', (ctx) => runMoveQueuedItemDown('item-1', ctx), ['moveDown']],
  ['clear completed', (ctx) => runClearCompleted(ctx), ['clearCompleted']],
  ['clear failed', (ctx) => runClearFailed(ctx), ['clearFailed']],
  ['pause', (ctx) => runPauseQueue(undefined, ctx), ['setQueuePausedState']],
  ['resume', (ctx) => runResumeQueue(ctx), ['setQueuePausedState']]
];

const NOW = Date.parse('2026-08-18T00:00:00.000Z');

/** A queue armed and due: idle-pending, deadline elapsed, no live timer. */
function due(at: number): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: 'idle-pending',
    pauseSource: null,
    scheduledStartAt: at,
    scheduledStartSource: 'operator-chooser'
  } as QueueState;
}

describe('the fail-closed primacy posture (FR-R3-024 FR-019)', () => {
  it('makes the two predicates diverge when the record cannot be read', async () => {
    // Both agree while storage answers. This is the control: without it, the
    // divergence below could be a claim that was never valid.
    expect(lock.isHeld()).toBe(true);
    expect(await lock.hasPrimacy()).toBe(true);

    loseStorage();

    // The advisory predicate reads the per-host `Memento` mirror, which storage
    // cannot reach and therefore cannot correct — it still says yes. The
    // authoritative one asks the record, gets `unavailable`, and refuses.
    //
    // This is the whole case for FR-R3-024. A decision made on `isHeld()` here
    // proceeds on a claim nothing can confirm, in the one situation where the
    // record's silence may be a rival window holding it.
    expect(lock.isHeld()).toBe(true);
    expect(await lock.hasPrimacy()).toBe(false);
  });

  it.each(QUEUE_OPS)('refuses the %s mutation and touches no queue state', async (_name, run) => {
    loseStorage();
    const { ctx, touched, notifier } = makeOpsCtx();

    await run(ctx);

    expect(touched).toEqual([]);
    expect(notifier.warn).toHaveBeenCalledExactlyOnceWith(
      'Schegent: another window holds the workspace lock; ignoring request.'
    );
    expect(notifier.error).not.toHaveBeenCalled();
  });

  it.each(QUEUE_OPS)(
    'still performs the %s mutation while storage answers',
    async (_name, run, expectedTouched) => {
      // The positive control for the pair above. Without it, a `queue-ops`
      // function that had become a no-op would satisfy every refusal assertion.
      const { ctx, touched, notifier } = makeOpsCtx();

      await run(ctx);

      expect(touched).toEqual(expectedTouched);
      expect(notifier.warn).not.toHaveBeenCalled();
    }
  );

  it('defers the watchdog sweep and leaves the deadline for the next tick', async () => {
    const states: Record<string, QueueState> = { alpha: due(NOW - 1) };
    const promote = vi.fn(async (_queueId: string) => undefined);
    const watchdog = new QueueScheduleWatchdog({
      getQueueStates: () => states,
      hasArmedTimer: () => false,
      promote,
      isPrimary: () => lock.hasPrimacy(),
      logger: { warn: vi.fn(), info: vi.fn() },
      audit: { append: vi.fn(async () => undefined) },
      now: () => NOW
    });

    loseStorage();
    await expect(watchdog.tick()).resolves.toEqual([]);
    expect(promote).not.toHaveBeenCalled();
    // SC-009 — the refusal is a deferral. The deadline is untouched, so the
    // work is not lost; it is postponed by one tick interval. A watchdog that
    // cleared the schedule field on refusal would pass the two assertions
    // above and silently drop the operator's scheduled start.
    expect(states.alpha!.scheduledStartAt).toBe(NOW - 1);

    // Storage recovers. The same watchdog, the same persisted deadline, and now
    // the sweep acts — which is what makes the earlier `[]` a deferral rather
    // than a loss.
    fs.faults.failList = false;
    await expect(watchdog.tick()).resolves.toEqual(['alpha']);
    expect(promote).toHaveBeenCalledExactlyOnceWith('alpha');
  });
});
