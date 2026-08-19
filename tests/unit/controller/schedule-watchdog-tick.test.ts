import { describe, expect, it, vi } from 'vitest';
import { QueueScheduleWatchdog } from '../../../src/controller/schedule-watchdog';
import type { QueueState } from '../../../src/queue/feature-request';
import type { AuditEventType } from '../../../src/contracts/audit-events';

interface AuditEntry {
  runId: string;
  phase: string;
  iteration: number;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
  outcome: 'info' | 'success' | 'failure';
}

// FR-R3-002 (T288) — `QueueScheduleWatchdog.tick()`.
//
// This file replaces `schedule-watchdog.test.ts`, which pinned the feature-030
// no-op contract ("returns [] and does not fire the queue even when a schedule
// is set"). That contract was the defect FUNC-02 names: the watchdog's premise
// was `QueueRegistryEntry.schedule` is always null, but feature 065 moved the
// deadline to `QueueState.scheduledStartAt` and feature 092 made it per-queue.
// Deleting the old file rather than amending it is deliberate — its assertions
// asserted the *opposite* of what the tick must now do.

const NOW = Date.parse('2026-08-18T00:00:00.000Z');

function queueState(over: Partial<QueueState> = {}): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...over
  } as QueueState;
}

/** A queue armed and due: idle-pending, deadline in the past, no live timer. */
function due(at: number): QueueState {
  return queueState({
    queueLifecycle: 'idle-pending',
    pauseSource: null,
    scheduledStartAt: at,
    scheduledStartSource: 'operator-chooser'
  });
}

function makeWatchdog(opts: {
  states: Record<string, QueueState>;
  now?: number;
  primary?: boolean;
  armed?: readonly string[];
  promote?: (queueId: string) => Promise<void> | void;
  catalogEmpty?: () => boolean;
}) {
  const promoted: string[] = [];
  const promote = vi.fn(async (queueId: string) => {
    promoted.push(queueId);
    await opts.promote?.(queueId);
  });
  const audit = { append: vi.fn(async (_entry: AuditEntry) => undefined) };
  const logger = { warn: vi.fn(), info: vi.fn() };
  const watchdog = new QueueScheduleWatchdog({
    getQueueStates: () => opts.states,
    hasArmedTimer: (queueId) => (opts.armed ?? []).includes(queueId),
    promote,
    isPrimary: () => opts.primary ?? true,
    logger,
    audit,
    now: () => opts.now ?? NOW,
    ...(opts.catalogEmpty ? { isCatalogEmpty: opts.catalogEmpty } : {})
  });
  return { watchdog, promote, promoted, audit, logger };
}

describe('QueueScheduleWatchdog.tick — per-queue schedule scan (FR-R3-002)', () => {
  it('promotes an elapsed schedule and returns the queue id it acted on', async () => {
    const h = makeWatchdog({
      states: { alpha: due(NOW - 1) },
      now: NOW
    });
    await expect(h.watchdog.tick()).resolves.toEqual(['alpha']);
    expect(h.promote).toHaveBeenCalledExactlyOnceWith('alpha');
  });

  it('leaves a queue whose deadline has not elapsed alone', async () => {
    const h = makeWatchdog({
      states: { alpha: due(NOW + 60_000) },
      now: NOW
    });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('skips a due queue whose in-process timer is still armed', async () => {
    // The coordinator owns a queue it still holds a handle for. Promoting it
    // here would be a double fire — the timer is about to do the same work.
    const h = makeWatchdog({
      states: { alpha: due(NOW - 1) },
      now: NOW,
      armed: ['alpha']
    });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('does not promote a queue that is not idle-pending', async () => {
    // A paused or already-running queue is not the watchdog's to start, and a
    // deadline left on one is the coordinator's `superseded` case, not a
    // recovery case. This is also the invariant guard: `scheduledStartAt` is
    // only ever paired with `idle-pending`.
    const h = makeWatchdog({
      states: {
        paused: queueState({
          queueLifecycle: 'operator-paused',
          pauseSource: null,
          scheduledStartAt: NOW - 1,
          scheduledStartSource: 'operator-chooser'
        }),
        running: queueState({
          queueLifecycle: 'running',
          pauseSource: null,
          scheduledStartAt: NOW - 1,
          scheduledStartSource: 'operator-chooser'
        })
      },
      now: NOW
    });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('does not promote an idle-pending queue that carries no deadline', async () => {
    // An operator who dismissed the start chooser lands here. Nothing armed it,
    // so nothing may auto-promote it — the standing rule against promoting
    // idle-pending without an explicit operator or scheduled-start trigger.
    const h = makeWatchdog({
      states: { alpha: queueState({ queueLifecycle: 'idle-pending'}) },
      now: NOW
    });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('promotes only the due queues and leaves siblings untouched', async () => {
    const h = makeWatchdog({
      states: {
        alpha: due(NOW - 5_000),
        beta: queueState(),
        gamma: due(NOW + 5_000)
      },
      now: NOW
    });
    await expect(h.watchdog.tick()).resolves.toEqual(['alpha']);
    expect(h.promoted).toEqual(['alpha']);
  });

  it('promotes several due queues oldest deadline first', async () => {
    // A backlog that accumulated behind a foreign lock is released in the order
    // the operator scheduled it, not in map-enumeration order.
    const h = makeWatchdog({
      states: {
        late: due(NOW - 1_000),
        earliest: due(NOW - 90_000),
        middle: due(NOW - 30_000)
      },
      now: NOW
    });
    await expect(h.watchdog.tick()).resolves.toEqual(['earliest', 'middle', 'late']);
    expect(h.promoted).toEqual(['earliest', 'middle', 'late']);
  });

  it('keeps sweeping when one queue fails to promote, and omits it from the result', async () => {
    const h = makeWatchdog({
      states: { alpha: due(NOW - 2_000), beta: due(NOW - 1_000) },
      now: NOW,
      promote: (queueId) => {
        if (queueId === 'alpha') throw new Error('drain refused');
      }
    });
    await expect(h.watchdog.tick()).resolves.toEqual(['beta']);
    expect(h.promoted).toEqual(['alpha', 'beta']);
    expect(h.logger.warn).toHaveBeenCalledOnce();
  });

  it('emits the FR-023a core payload and no operator-authored content', async () => {
    const h = makeWatchdog({ states: { alpha: due(NOW - 45_000) }, now: NOW });
    await h.watchdog.tick();
    expect(h.audit.append).toHaveBeenCalledOnce();
    const entry = h.audit.append.mock.calls[0]![0];
    expect(entry.eventType).toBe('scheduled-start-fired');
    expect(entry.payload).toMatchObject({
      queueId: 'alpha',
      occurredAt: NOW,
      transitionReason: 'watchdog-recovered',
      scheduledStartAt: NOW - 45_000,
      lateByMs: 45_000
    });
    // No description, feature dir, or other operator-authored text.
    const serialized = JSON.stringify(entry.payload);
    expect(serialized).not.toMatch(/description|featureDir|prompt/i);
  });

  it('does not promote a due queue while the Process catalog is empty', async () => {
    // Feature 098 (FR-031a): `ScheduledStartCoordinator.refuseOnEmptyCatalog()`
    // drops the timer and leaves the queue in `idle-pending` with its deadline
    // still persisted — which is bit-for-bit the state this tick calls "due and
    // unowned". Without this gate the watchdog undoes the refusal on its next
    // sweep, so an operator with no importable Pipeline gets a run started for
    // them within a tick of being told the catalog is empty.
    const h = makeWatchdog({
      states: { alpha: due(NOW - 1) },
      now: NOW,
      catalogEmpty: () => true
    });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('emits no audit event and no warning for a queue the empty catalog holds back', async () => {
    // The refusal is already on the record — the coordinator told the operator
    // once, at fire time. A per-tick audit row or toast would be the same
    // refusal restated every 60 seconds for as long as the deadline stands.
    const h = makeWatchdog({
      states: { alpha: due(NOW - 1), beta: due(NOW - 2) },
      now: NOW,
      catalogEmpty: () => true
    });
    await h.watchdog.tick();
    expect(h.audit.append).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('promotes normally once the catalog holds something', async () => {
    // The gate's polarity, pinned: a gate wired backwards would make the
    // watchdog dead in exactly the configuration it exists for.
    const h = makeWatchdog({
      states: { alpha: due(NOW - 1) },
      now: NOW,
      catalogEmpty: () => false
    });
    await expect(h.watchdog.tick()).resolves.toEqual(['alpha']);
    expect(h.promote).toHaveBeenCalledExactlyOnceWith('alpha');
  });

  it('asks whether the catalog is empty once per tick, not once per due queue', async () => {
    const catalogEmpty = vi.fn(() => false);
    const h = makeWatchdog({
      states: { alpha: due(NOW - 1), beta: due(NOW - 2), gamma: due(NOW - 3) },
      now: NOW,
      catalogEmpty
    });
    await h.watchdog.tick();
    expect(catalogEmpty).toHaveBeenCalledOnce();
  });

  it('does not fire from a secondary host', async () => {
    const h = makeWatchdog({ states: { alpha: due(NOW - 1) }, now: NOW, primary: false });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.audit.append).not.toHaveBeenCalled();
  });

  it('does not fire after dispose', async () => {
    const h = makeWatchdog({ states: { alpha: due(NOW - 1) }, now: NOW });
    h.watchdog.dispose();
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('disposes the installed interval', () => {
    const handle = { id: 1 };
    const clearTimer = vi.fn();
    const watchdog = new QueueScheduleWatchdog(
      {
        getQueueStates: () => ({}),
        hasArmedTimer: () => false,
        promote: vi.fn(),
        isPrimary: () => true,
        logger: { warn: vi.fn(), info: vi.fn() },
        setTimer: vi.fn(() => handle),
        clearTimer
      },
      60_000
    );
    watchdog.start();
    watchdog.dispose();
    expect(clearTimer).toHaveBeenCalledWith(handle);
  });
});
