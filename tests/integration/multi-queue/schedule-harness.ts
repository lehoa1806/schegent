// FR-R3-002 — the schedule stack composed the way `extension.ts` composes it,
// over a real `WorkspaceStateStore` carrying more than one queue.
//
// The feature-065 harness (`../enqueue-start-separation.helpers.ts`) supplies
// the primitives, and this file reuses them rather than re-deriving a second
// set. What it does not reuse is that harness's `onFire`: the subject of these
// tests is precisely which queue a fired schedule reaches, so the promotion
// handler has to be the production one — `updateQueue(mutate, queueId)` then
// `drainQueuedWork(queueId)` — and not a test-local approximation of it.

import { vi } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  FakeMemento,
  MutableClock,
  makeAuditCapture,
  makeFakeTimerControl,
  makeLogger,
  type AuditLogCapture,
  type FakeTimerControl
} from '../enqueue-start-separation.helpers';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { ScheduledStartCoordinator } from '../../../src/services/scheduled-start-coordinator';
import { QueueScheduleWatchdog } from '../../../src/controller/schedule-watchdog';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { QueueState, ScheduledStartSource } from '../../../src/queue/feature-request';
import type { ScheduledStartRefusal } from '../../../src/services/scheduled-start-coordinator';

export const DEFAULT_NOW = 1_700_000_000_000;

/**
 * A fired timer calls `void this.fire(queueId)`, so the promotion it triggers
 * is not awaitable from the call site — the audit append and the store's
 * `serialize` chain both land on later turns. Draining a few macrotask turns is
 * what lets a test read the settled state rather than a half-applied one.
 */
export async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

export interface ScheduleHarness {
  readonly store: WorkspaceStateStore;
  readonly clock: MutableClock;
  readonly audit: AuditLogCapture;
  readonly logger: ReturnType<typeof makeLogger>;
  readonly fakeTimer: FakeTimerControl;
  readonly coordinator: ScheduledStartCoordinator;
  readonly watchdog: QueueScheduleWatchdog;
  /** Every `drainQueuedWork` the promotion handler issued, in order. */
  readonly drained: string[];
  /** Every refusal the empty-catalog gate delivered, in order. */
  readonly refusals: ScheduledStartRefusal[];
  /** `true` while a foreign window is deemed to hold the workspace lock. */
  foreignLockHeld: boolean;
  /** `true` while this window is primary; the watchdog will not act otherwise. */
  primary: boolean;
  /** `true` while the active Process catalog holds no Pipeline (FR-031a). */
  catalogEmpty: boolean;
  /** Persist `idle-pending` + a deadline, then arm the in-process timer. */
  armSchedule(
    queueId: string,
    at: number,
    source?: ScheduledStartSource
  ): Promise<void>;
  /** Persist a queue's execution state without touching any sibling. */
  putQueue(queueId: string, over: Partial<QueueState>): Promise<void>;
  read(queueId: string): QueueState;
}

export async function makeScheduleHarness(
  opts: { initialNow?: number } = {}
): Promise<ScheduleHarness> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const clock = new MutableClock(opts.initialNow ?? DEFAULT_NOW);
  const audit = makeAuditCapture();
  const logger = makeLogger();
  const fakeTimer = makeFakeTimerControl(clock);

  const drained: string[] = [];
  const drainQueuedWork = vi.fn(async (queueId: string) => {
    drained.push(queueId);
  });

  const state = { foreignLockHeld: false, primary: true, catalogEmpty: false };
  const refusals: ScheduledStartRefusal[] = [];

  // Mirrors `promoteScheduledQueue` in `src/extension.ts` line for line: the
  // fired queue id is the only address either half uses.
  const promoteScheduledQueue = async (queueId: string): Promise<void> => {
    await store.updateQueue(
      (queueState) => ({
        queue: {
          ...queueState,
          queueLifecycle: 'active-empty' as const,
          pauseSource: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: clock.now()
        },
        result: undefined
      }),
      queueId,
      unfencedCommit('test-fixture')
    );
    await drainQueuedWork(queueId);
  };

  const coordinator = new ScheduledStartCoordinator({
    store,
    auditWriter: audit as unknown as Pick<AuditLogWriter, 'append'>,
    logger: logger as unknown as Pick<SanitizedLogger, 'warn'>,
    onFire: promoteScheduledQueue,
    isForeignLockHeld: () => state.foreignLockHeld,
    now: () => clock.now(),
    setTimer: fakeTimer.setTimer,
    clearTimer: fakeTimer.clearTimer,
    // Feature 098 (FR-031a). Wired here for the same reason `onFire` is the
    // production handler: an empty catalog refuses the start at fire time and
    // leaves the deadline persisted, so a harness without the gate cannot
    // reproduce the state the watchdog then has to leave alone.
    emptyCatalogGate: {
      isCatalogEmpty: () => state.catalogEmpty,
      onRefused: (refusal) => { refusals.push(refusal); }
    }
  });

  const watchdog = new QueueScheduleWatchdog({
    getQueueStates: () => store.getQueueStates(),
    hasArmedTimer: (queueId) => coordinator.hasActiveTimer(queueId),
    promote: promoteScheduledQueue,
    isPrimary: () => state.primary,
    isCatalogEmpty: () => state.catalogEmpty,
    logger,
    audit: audit as unknown as Pick<AuditLogWriter, 'append'>,
    now: () => clock.now()
  });

  const putQueue = async (queueId: string, over: Partial<QueueState>): Promise<void> => {
    await store.updateQueue(
      (current) => ({ queue: { ...current, ...over }, result: undefined }),
      queueId,
      unfencedCommit('test-fixture')
    );
  };

  return {
    store,
    clock,
    audit,
    logger,
    fakeTimer,
    coordinator,
    watchdog,
    drained,
    refusals,
    get foreignLockHeld() { return state.foreignLockHeld; },
    set foreignLockHeld(value: boolean) { state.foreignLockHeld = value; },
    get primary() { return state.primary; },
    set primary(value: boolean) { state.primary = value; },
    get catalogEmpty() { return state.catalogEmpty; },
    set catalogEmpty(value: boolean) { state.catalogEmpty = value; },
    armSchedule: async (queueId, at, source = 'operator-chooser') => {
      await putQueue(queueId, {
        queueLifecycle: 'idle-pending',
        pauseSource: null,
        scheduledStartAt: at,
        scheduledStartSource: source
      });
      await coordinator.arm(queueId, at, source);
    },
    putQueue,
    read: (queueId) => store.getQueue(queueId)
  };
}
