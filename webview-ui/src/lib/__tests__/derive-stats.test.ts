import { describe, it, expect } from 'vitest';
import { deriveSidebarStats, deriveActivePhase } from '../derive-stats';
import type { PhaseTile, QueueProjection, QueueItem, SubProgress } from '../snapshot-types';

function tile(overrides: Partial<PhaseTile> & { name: PhaseTile['name']; order: PhaseTile['order'] }): PhaseTile {
  return Object.freeze({
    name: overrides.name,
    order: overrides.order,
    state: overrides.state ?? 'not-started',
    iteration: overrides.iteration ?? 0,
    lastResult: overrides.lastResult ?? null,
    elapsedMs: overrides.elapsedMs ?? 0,
    subProgress: overrides.subProgress ?? null
  });
}

function emptyQueue(): QueueProjection {
  return Object.freeze({
    orderedItems: [],
    inFlight: null,
    pending: Object.freeze([]) as readonly QueueItem[],
    recent: Object.freeze([]) as readonly QueueItem[],
    paused: false
  });
}

function queueItem(overrides: Partial<QueueItem> & { id: string; status: QueueItem['status'] }): QueueItem {
  return Object.freeze({
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    enqueuedAt: overrides.enqueuedAt ?? '2026-05-10T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-05-10T00:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    status: overrides.status,
    retryCount: overrides.retryCount ?? 0,
    lastErrorSummary: overrides.lastErrorSummary ?? null,
    pausedReason: overrides.pausedReason ?? null,
    currentPhase: overrides.currentPhase ?? null,
    position: overrides.position ?? 0
  });
}

const SEVEN_PHASES: ReadonlyArray<PhaseTile> = Object.freeze([
  tile({ name: 'speckit-specify', order: 1 }),
  tile({ name: 'speckit-clarify', order: 2 }),
  tile({ name: 'speckit-plan', order: 3 }),
  tile({ name: 'speckit-tasks', order: 4 }),
  tile({ name: 'speckit-analyze', order: 5 }),
  tile({ name: 'speckit-implement', order: 6 }),
  tile({ name: 'finalize', order: 7 })
]);

describe('deriveSidebarStats', () => {
  it('all-zero baseline returns 0/7/0', () => {
    const stats = deriveSidebarStats(SEVEN_PHASES, emptyQueue());
    expect(stats.done).toBe(0);
    expect(stats.pending).toBe(7);
    expect(stats.failed).toBe(0);
  });

  it('3 completed + 4 not-started + empty queue → done=3 pending=4 failed=0', () => {
    const phases: ReadonlyArray<PhaseTile> = Object.freeze([
      tile({ name: 'speckit-specify', order: 1, state: 'completed' }),
      tile({ name: 'speckit-clarify', order: 2, state: 'completed' }),
      tile({ name: 'speckit-plan', order: 3, state: 'completed' }),
      tile({ name: 'speckit-tasks', order: 4 }),
      tile({ name: 'speckit-analyze', order: 5 }),
      tile({ name: 'speckit-implement', order: 6 }),
      tile({ name: 'finalize', order: 7 })
    ]);
    const stats = deriveSidebarStats(phases, emptyQueue());
    expect(stats).toEqual({ done: 3, pending: 4, failed: 0 });
  });

  it('7 completed + 2 failed in queue.recent → done=7 pending=0 failed=2', () => {
    const phases: ReadonlyArray<PhaseTile> = Object.freeze(
      SEVEN_PHASES.map((p) => tile({ name: p.name, order: p.order, state: 'completed' }))
    );
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([
        queueItem({ id: 'q1', status: 'failed' }),
        queueItem({ id: 'q2', status: 'failed' })
      ]) as readonly QueueItem[],
      paused: false
    });
    const stats = deriveSidebarStats(phases, queue);
    expect(stats).toEqual({ done: 7, pending: 0, failed: 2 });
  });

  it('mixed phases + non-empty queue.pending → counters add queue.pending to phase pending', () => {
    const phases: ReadonlyArray<PhaseTile> = Object.freeze([
      tile({ name: 'speckit-specify', order: 1, state: 'completed' }),
      tile({ name: 'speckit-clarify', order: 2, state: 'active' }),
      tile({ name: 'speckit-plan', order: 3 }),
      tile({ name: 'speckit-tasks', order: 4 }),
      tile({ name: 'speckit-analyze', order: 5 }),
      tile({ name: 'speckit-implement', order: 6 }),
      tile({ name: 'finalize', order: 7 })
    ]);
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: Object.freeze([
        queueItem({ id: 'qa', status: 'pending' }),
        queueItem({ id: 'qb', status: 'pending' })
      ]) as readonly QueueItem[],
      recent: Object.freeze([]) as readonly QueueItem[],
      paused: false
    });
    const stats = deriveSidebarStats(phases, queue);
    expect(stats.done).toBe(1);
    expect(stats.pending).toBe(6 + 2);
    expect(stats.failed).toBe(0);
  });

  it('empty phases array returns 0/0/0 + queue stats (defensive)', () => {
    const stats = deriveSidebarStats([], emptyQueue());
    expect(stats).toEqual({ done: 0, pending: 0, failed: 0 });
  });

  it('counts skipped phases as done', () => {
    const phases: ReadonlyArray<PhaseTile> = Object.freeze([
      tile({ name: 'speckit-specify', order: 1, state: 'completed' }),
      tile({ name: 'speckit-clarify', order: 2, state: 'skipped' }),
      tile({ name: 'speckit-plan', order: 3, state: 'completed' }),
      tile({ name: 'speckit-tasks', order: 4 }),
      tile({ name: 'speckit-analyze', order: 5 }),
      tile({ name: 'speckit-implement', order: 6 }),
      tile({ name: 'finalize', order: 7 })
    ]);
    const stats = deriveSidebarStats(phases, emptyQueue());
    expect(stats.done).toBe(3);
    expect(stats.pending).toBe(4);
  });

  it('counters render integer values across sequential snapshots', () => {
    const sequence: ReadonlyArray<readonly PhaseTile[]> = [
      SEVEN_PHASES.map((p, i) => tile({ name: p.name, order: p.order, state: i < 3 ? 'completed' : 'not-started' })),
      SEVEN_PHASES.map((p, i) => tile({ name: p.name, order: p.order, state: i < 4 ? 'completed' : 'not-started' })),
      SEVEN_PHASES.map((p, i) => tile({ name: p.name, order: p.order, state: i < 5 ? 'completed' : 'not-started' })),
      SEVEN_PHASES.map((p) => tile({ name: p.name, order: p.order, state: 'completed' }))
    ];
    const expectedDone = [3, 4, 5, 7];
    sequence.forEach((phases, i) => {
      const s = deriveSidebarStats(phases, emptyQueue());
      expect(Number.isInteger(s.done)).toBe(true);
      expect(Number.isInteger(s.pending)).toBe(true);
      expect(Number.isInteger(s.failed)).toBe(true);
      expect(s.done).toBe(expectedDone[i]);
    });
  });

  it('phase transitions: not-started → active → completed update pending/done', () => {
    const phaseAtStart = tile({ name: 'speckit-plan', order: 3 });
    const phaseActive = tile({ name: 'speckit-plan', order: 3, state: 'active' });
    const phaseDone = tile({ name: 'speckit-plan', order: 3, state: 'completed' });
    const others: ReadonlyArray<PhaseTile> = SEVEN_PHASES.filter((p) => p.name !== 'speckit-plan');
    const s0 = deriveSidebarStats([...others, phaseAtStart], emptyQueue());
    const s1 = deriveSidebarStats([...others, phaseActive], emptyQueue());
    const s2 = deriveSidebarStats([...others, phaseDone], emptyQueue());
    expect(s0.done).toBe(0);
    expect(s0.pending).toBe(7);
    expect(s1.done).toBe(0);
    expect(s1.pending).toBe(7);
    expect(s2.done).toBe(1);
    expect(s2.pending).toBe(6);
  });

  it('queue.recent failed accumulation increments failed counter', () => {
    const q1: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([queueItem({ id: 'qa', status: 'failed' })]) as readonly QueueItem[],
      paused: false
    });
    const q2: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([
        queueItem({ id: 'qa', status: 'failed' }),
        queueItem({ id: 'qb', status: 'failed' })
      ]) as readonly QueueItem[],
      paused: false
    });
    expect(deriveSidebarStats(SEVEN_PHASES, q1).failed).toBe(1);
    expect(deriveSidebarStats(SEVEN_PHASES, q2).failed).toBe(2);
  });
});

describe('deriveActivePhase', () => {
  it('returns null when no phase has state=active', () => {
    const result = deriveActivePhase(SEVEN_PHASES);
    expect(result).toBeNull();
  });

  it('returns the first active phase with its subProgress', () => {
    const sub: SubProgress = Object.freeze({ current: 3, total: 7, label: 'task' });
    const phases: ReadonlyArray<PhaseTile> = Object.freeze([
      tile({ name: 'speckit-specify', order: 1, state: 'completed' }),
      tile({ name: 'speckit-clarify', order: 2, state: 'completed' }),
      tile({ name: 'speckit-plan', order: 3, state: 'completed' }),
      tile({ name: 'speckit-tasks', order: 4, state: 'completed' }),
      tile({ name: 'speckit-analyze', order: 5, state: 'completed' }),
      tile({ name: 'speckit-implement', order: 6, state: 'active', subProgress: sub }),
      tile({ name: 'finalize', order: 7 })
    ]);
    const result = deriveActivePhase(phases);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('speckit-implement');
    expect(result!.subProgress).toEqual(sub);
  });

  it('returns the first active phase when two are erroneously both active', () => {
    const phases: ReadonlyArray<PhaseTile> = Object.freeze([
      tile({ name: 'speckit-specify', order: 1, state: 'completed' }),
      tile({ name: 'speckit-clarify', order: 2, state: 'active' }),
      tile({ name: 'speckit-plan', order: 3, state: 'active' }),
      tile({ name: 'speckit-tasks', order: 4 }),
      tile({ name: 'speckit-analyze', order: 5 }),
      tile({ name: 'speckit-implement', order: 6 }),
      tile({ name: 'finalize', order: 7 })
    ]);
    const result = deriveActivePhase(phases);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('speckit-clarify');
  });

  it('returns active phase with subProgress=null when none', () => {
    const phases: ReadonlyArray<PhaseTile> = Object.freeze([
      tile({ name: 'speckit-specify', order: 1, state: 'active' }),
      tile({ name: 'speckit-clarify', order: 2 }),
      tile({ name: 'speckit-plan', order: 3 }),
      tile({ name: 'speckit-tasks', order: 4 }),
      tile({ name: 'speckit-analyze', order: 5 }),
      tile({ name: 'speckit-implement', order: 6 }),
      tile({ name: 'finalize', order: 7 })
    ]);
    const result = deriveActivePhase(phases);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('speckit-specify');
    expect(result!.subProgress).toBeNull();
  });

  it('returns null on empty phases array (defensive)', () => {
    expect(deriveActivePhase([])).toBeNull();
  });
});
