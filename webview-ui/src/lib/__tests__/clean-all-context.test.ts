// Feature 063 (US3, T050) / FR-R3-150 (T1622a) — unit tests for
// `deriveCleanAllContext`. The helper centralizes the impact-inventory
// derivation that the Clean All confirmation modal's body template
// substitutes. Keeping it isolated from Dashboard rendering lets each
// branch (empty queue, in-flight, pause-by-cascade vs operator, active run,
// armed schedule) be asserted by exact-value equality rather than by
// re-running the full Dashboard mount.
//
// FR-R3-150 rewrote every case here to pass the addressed `queueId` the
// function now requires (FR-001): today's tree resolved every field off
// `snapshot.queue`/`queue.queues?.[0]`, which is the reserved queue's own
// projection and the array's first entry regardless of which queue was
// open — the exact defect this feature closes. Every populated case below
// therefore carries a sibling queue with its own, deliberately different
// state, so a read that leaked from `default` would surface as a wrong
// value rather than a plausible-looking one.

import { describe, expect, it } from 'vitest';
import { deriveCleanAllContext } from '../queue-derived';
import type { QueueItem, QueueLifecycle, QueueSummary, WorkflowSnapshot } from '../snapshot-types';
import { buildInFlightRun, buildQueueRuntime } from './queue-runtime-fixture';

function task(
  overrides: Partial<QueueItem> & { id: string; status: QueueItem['status'] }
): QueueItem {
  return Object.freeze({
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    enqueuedAt: overrides.enqueuedAt ?? '2026-05-22T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-05-22T00:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    status: overrides.status,
    retryCount: overrides.retryCount ?? 0,
    lastErrorSummary: overrides.lastErrorSummary ?? null,
    pausedReason: overrides.pausedReason ?? null,
    currentPhase: overrides.currentPhase ?? null,
    position: overrides.position ?? 0
  });
}

function summary(overrides: Partial<QueueSummary> & { id: string }): QueueSummary {
  return Object.freeze({
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    position: overrides.position ?? 0,
    state: overrides.state ?? (overrides.pauseSource ? 'manually-paused' : 'active'),
    pauseSource: overrides.pauseSource ?? null,
    schedule: overrides.schedule ?? null,
    taskCount: overrides.taskCount ?? 0,
    failurePolicy: overrides.failurePolicy ?? 'halt-on-failure',
    failurePolicyOverride: overrides.failurePolicyOverride ?? null
  });
}

/**
 * A snapshot carrying Default plus `q-beta`, `q-beta`'s state supplied by the
 * caller and Default's fixed to values every case can assert never leaked.
 */
function mkSnapshot(
  betaTasks: readonly QueueItem[],
  options: {
    readonly betaSummary?: Partial<QueueSummary>;
    readonly betaInFlight?: boolean;
    /**
     * Code-review finding (iteration 5, sweep) — the id the queue's Run names as
     * its active Task. Production always carries it for a queue that owns a Run;
     * it is what distinguishes an FR-026 system-paused active row from an
     * operator-paused row the pause path detached.
     */
    readonly betaActiveTaskId?: string;
    // Code-review finding (LC-Q-05) — `hasSchedule` no longer reads
    // `QueueSummary.schedule` (dead in practice; see `queue-derived.ts`).
    // Code-review finding (iteration 5) — nor the lifecycle. It reads the
    // authoritative `QueueRuntime.scheduledStartAt`, so a fixture that wants
    // `hasSchedule: true` sets that field and nothing else; the lifecycle is
    // now independent of it, which is the point.
    readonly betaLifecycle?: QueueLifecycle;
    readonly betaScheduledStartAt?: number | null;
  } = {}
): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([
      buildQueueRuntime({
        queueId: 'default',
        name: 'Default',
        tasks: [task({ id: 'default-only', status: 'completed', label: 'not q-beta' })]
      }),
      buildQueueRuntime({
        queueId: 'q-beta',
        name: 'nightly',
        pendingCount: betaTasks.filter((t) => t.status === 'pending').length,
        tasks: betaTasks,
        lifecycle: options.betaLifecycle,
        scheduledStartAt: options.betaScheduledStartAt ?? null,
        inFlightRun: options.betaInFlight
          ? buildInFlightRun({
              runId: 'run-beta',
              ...(options.betaActiveTaskId === undefined
                ? {}
                : {
                    feature: {
                      id: options.betaActiveTaskId,
                      label: options.betaActiveTaskId,
                      startedAt: '2026-05-22T00:00:00.000Z'
                    }
                  })
            })
          : null
      })
    ]),
    queue: {
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([]),
      queues: Object.freeze([
        summary({ id: 'default', name: 'Default', pauseSource: 'operator' }),
        summary({ id: 'q-beta', name: 'nightly', ...options.betaSummary })
      ]),
      paused: false
    },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-05-22T00:00:00.000Z',
    availablePipelines: [],
    availablePhases: [],
    availableModels: []
  } as unknown as WorkflowSnapshot;
}

describe('deriveCleanAllContext', () => {
  it('empty queue → all counts zero, no in-flight, no pause, no schedule', () => {
    const ctx = deriveCleanAllContext(mkSnapshot([]), 'q-beta');
    expect(ctx).toEqual({
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: null,
      hasActiveRun: false,
      hasSchedule: false
    });
  });

  it('populated queue returns the exact impact inventory the body template substitutes', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot(
        [
          task({ id: 'live', status: 'in-flight', label: 'Run feature 063 specify' }),
          task({ id: 'p1', status: 'pending' }),
          task({ id: 'p2', status: 'pending' }),
          task({ id: 'p3', status: 'pending' }),
          task({ id: 'c1', status: 'completed' }),
          task({ id: 'c2', status: 'completed' }),
          task({ id: 'f1', status: 'failed' }),
          task({ id: 'x1', status: 'canceled' })
        ],
        { betaSummary: { pauseSource: 'cascade' }, betaInFlight: true }
      ),
      'q-beta'
    );
    expect(ctx).toEqual({
      queueId: 'q-beta',
      queueName: 'nightly',
      pendingCount: 3,
      completedCount: 2,
      failedCount: 1,
      canceledCount: 1,
      inflightTitle: 'Run feature 063 specify',
      pauseSource: 'cascade',
      hasActiveRun: true,
      hasSchedule: false
    });
  });

  it('reads pauseSource from the addressed queue’s own summary, never the sibling’s', () => {
    // Default is paused ('operator') in every fixture built by mkSnapshot; q-beta
    // must not inherit that reading.
    const ctx = deriveCleanAllContext(mkSnapshot([]), 'q-beta');
    expect(ctx.pauseSource).toBeNull();
  });

  it('reads counts from the addressed queue’s own tasks, never a sibling’s', () => {
    // Default carries one completed task in every fixture; a leak would show up
    // as completedCount:1 on an otherwise-empty q-beta.
    const ctx = deriveCleanAllContext(mkSnapshot([]), 'q-beta');
    expect(ctx.completedCount).toBe(0);
  });

  it('hasSchedule is true when the addressed queue’s runtime carries an armed schedule (LC-Q-05)', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([], { betaLifecycle: 'idle-pending', betaScheduledStartAt: 1_780_000_000_000 }),
      'q-beta'
    );
    expect(ctx.hasSchedule).toBe(true);
  });

  it('hasSchedule is false when the runtime carries no armed schedule', () => {
    const ctx = deriveCleanAllContext(mkSnapshot([]), 'q-beta');
    expect(ctx.hasSchedule).toBe(false);
  });

  // Code-review finding (iteration 4) — an ordinary queue with a pending
  // backlog and no schedule at all also has `lifecycle === 'idle-pending'`
  // (`queue-manager.ts`: `hasPending ? 'idle-pending' : ...`). Reading the
  // lifecycle alone made `hasSchedule` true here — a false positive on what
  // is likely the single most common Clean All invocation.
  it('hasSchedule is false when idle-pending is caused by a pending backlog, not a schedule', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([task({ id: 'p1', status: 'pending' })], { betaLifecycle: 'idle-pending' }),
      'q-beta'
    );
    expect(ctx.hasSchedule).toBe(false);
  });

  // Code-review finding (iteration 5) — the direction the lifecycle heuristic
  // got wrong that mattered: `applyStartIntentPolicy`'s `scheduled` branch arms
  // the schedule AND leaves the task it enqueued pending, so this is the
  // ordinary "start this at 14:00" shape, not an exotic combination. Reading
  // `pendingCount === 0` reported `hasSchedule: false` here and the
  // confirmation omitted the cancellation `clearQueue` performs regardless.
  it('hasSchedule is true when a schedule is armed on a queue that also has a pending backlog', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([task({ id: 'p1', status: 'pending' })], {
        betaLifecycle: 'idle-pending',
        betaScheduledStartAt: 1_780_000_000_000
      }),
      'q-beta'
    );
    expect(ctx.hasSchedule).toBe(true);
  });

  // Code-review finding (iteration 5) — the other direction: `cancel-schedule`
  // clears `scheduledStartAt` but deliberately HOLDS `idle-pending`, and no
  // refresher recomputes a held lifecycle. The heuristic read `true` here for
  // the rest of the window's life.
  it('hasSchedule is false when idle-pending is held after the schedule was canceled', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([], { betaLifecycle: 'idle-pending', betaScheduledStartAt: null }),
      'q-beta'
    );
    expect(ctx.hasSchedule).toBe(false);
  });

  // Code-review finding (iteration 5, sweep) — BUG-006/FR-026. The rate-limit /
  // system pause path preserves `inFlightId` and writes the row `paused`, so a
  // scan for `'in-flight'` alone placed the task in NONE of the impact figures:
  // no `inflightTitle`, and the host's `pendingCount` excludes `paused` by
  // construction. The operator confirmed a destructive reset whose inventory
  // never named the task it aborts.
  it('names a system-paused active task as the in-flight impact (FR-026)', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([task({ id: 'live', status: 'paused', label: 'Rate-limited task' })], {
        betaInFlight: true,
        betaActiveTaskId: 'live'
      }),
      'q-beta'
    );
    expect(ctx.inflightTitle).toBe('Rate-limited task');
    expect(ctx.pendingCount).toBe(0);
  });

  // The operator-pause path CLEARS `inFlightId`, so its `paused` row is a
  // pending row — `queue-projector.ts`'s own rule. Either way the row is
  // counted somewhere, which is the property that was missing.
  it('counts an operator-paused task as pending when it is not the active row', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([task({ id: 'held', status: 'paused', label: 'Held task' })]),
      'q-beta'
    );
    expect(ctx.inflightTitle).toBeNull();
    expect(ctx.pendingCount).toBe(1);
  });

  it('resolves the default queue’s own context when it is the one addressed', () => {
    const ctx = deriveCleanAllContext(mkSnapshot([]), 'default');
    expect(ctx.queueId).toBe('default');
    expect(ctx.queueName).toBe('Default');
    expect(ctx.completedCount).toBe(1);
    expect(ctx.pauseSource).toBe('operator');
  });

  it('falls back to the queueId when no runtime or summary names the queue', () => {
    const ctx = deriveCleanAllContext(mkSnapshot([]), 'unknown-queue');
    expect(ctx.queueName).toBe('unknown-queue');
    expect(ctx.pendingCount).toBe(0);
    expect(ctx.hasActiveRun).toBe(false);
  });

  // Code-review finding — `queue.queues` is still optional on `QueueProjection`;
  // when it hasn't arrived, the reserved/default queue's `pauseSource` used to
  // silently under-report (read `null`) instead of falling back to the legacy
  // top-level `queue.paused` flag the way this function did before FR-R3-150.
  it('falls back to the legacy queue.paused flag for the default queue when queues[] is absent', () => {
    const snapshot = mkSnapshot([]);
    const withoutQueues = { ...snapshot, queue: { ...snapshot.queue, queues: undefined, paused: true } };
    const ctx = deriveCleanAllContext(withoutQueues, 'default');
    expect(ctx.pauseSource).toBe('operator');
  });

  it('does not apply the legacy queue.paused fallback to a non-default queue', () => {
    const snapshot = mkSnapshot([]);
    const withoutQueues = { ...snapshot, queue: { ...snapshot.queue, queues: undefined, paused: true } };
    const ctx = deriveCleanAllContext(withoutQueues, 'q-beta');
    expect(ctx.pauseSource).toBeNull();
  });

  // Code-review finding (iteration 4) — the legacy `queue.paused` fallback
  // must trigger only when `queue.queues` (the summary array) is absent,
  // never when it is present and authoritatively says `pauseSource: null`.
  // `summary?.pauseSource ?? fallback` cannot tell those two cases apart —
  // `null ?? fallback` still evaluates the fallback — so a genuinely
  // unpaused default queue with a stale legacy `queue.paused: true` would
  // falsely report `pauseSource: 'operator'`.
  it('trusts a present summary’s pauseSource: null over a stale legacy queue.paused flag', () => {
    const snapshot = mkSnapshot([]);
    const staleLegacyPaused = {
      ...snapshot,
      queue: {
        ...snapshot.queue,
        paused: true,
        queues: Object.freeze([
          summary({ id: 'default', name: 'Default', pauseSource: null }),
          summary({ id: 'q-beta', name: 'nightly' })
        ])
      }
    };
    const ctx = deriveCleanAllContext(staleLegacyPaused, 'default');
    expect(ctx.pauseSource).toBeNull();
  });

  it('recent counts ignore non-terminal statuses mixed into the tasks list by mistake', () => {
    const ctx = deriveCleanAllContext(
      mkSnapshot([
        task({ id: 'c1', status: 'completed' }),
        task({ id: 'f1', status: 'failed' }),
        task({ id: 'x1', status: 'canceled' }),
        task({ id: 'stray-pending', status: 'pending' }),
        task({ id: 'stray-inflight', status: 'in-flight' })
      ]),
      'q-beta'
    );
    expect(ctx.completedCount).toBe(1);
    expect(ctx.failedCount).toBe(1);
    expect(ctx.canceledCount).toBe(1);
  });
});
