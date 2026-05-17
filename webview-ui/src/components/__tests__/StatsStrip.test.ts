import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import StatsStrip from '../StatsStrip.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { PhaseTile, QueueItem, WorkflowSnapshot } from '../../lib/snapshot-types';

afterEach(() => cleanup());

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

const SEVEN_NOT_STARTED: ReadonlyArray<PhaseTile> = Object.freeze([
  tile({ name: 'speckit-specify', order: 1 }),
  tile({ name: 'speckit-clarify', order: 2 }),
  tile({ name: 'speckit-plan', order: 3 }),
  tile({ name: 'speckit-tasks', order: 4 }),
  tile({ name: 'speckit-analyze', order: 5 }),
  tile({ name: 'speckit-implement', order: 6 }),
  tile({ name: 'finalize', order: 7 })
]);

function buildSnapshot(
  phases: readonly PhaseTile[] = SEVEN_NOT_STARTED,
  pending: readonly QueueItem[] = [],
  recent: readonly QueueItem[] = []
): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze(phases) as unknown as WorkflowSnapshot['phases'],
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze(pending),
      recent: Object.freeze(recent),
      paused: false
    }) as unknown as WorkflowSnapshot['queue'],
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    }),
    workflowElapsedMs: null,
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-10T00:00:00.000Z'
  } as unknown as WorkflowSnapshot);
}

function applySnap(snap: WorkflowSnapshot): void {
  snapshotStore.apply({ type: 'STATE_SNAPSHOT', payload: snap });
}

describe('StatsStrip', () => {
  beforeEach(() => {
    applySnap(buildSnapshot());
  });

  it('renders sidebar-stats-strip container', () => {
    const { container } = render(StatsStrip);
    expect(container.querySelector('[data-testid="sidebar-stats-strip"]')).not.toBeNull();
  });

  it('renders three counters with their integer values from deriveSidebarStats', () => {
    applySnap(buildSnapshot());
    const { container } = render(StatsStrip);
    const done = container.querySelector('[data-testid="sidebar-stats-done"]');
    const pending = container.querySelector('[data-testid="sidebar-stats-pending"]');
    const failed = container.querySelector('[data-testid="sidebar-stats-failed"]');
    expect(done).not.toBeNull();
    expect(pending).not.toBeNull();
    expect(failed).not.toBeNull();
    expect(done!.textContent).toMatch(/\b0\b/);
    expect(pending!.textContent).toMatch(/\b7\b/);
    expect(failed!.textContent).toMatch(/\b0\b/);
  });

  it('each counter has a visible textual label (done/pending/failed)', () => {
    const { container } = render(StatsStrip);
    expect(container.querySelector('[data-testid="sidebar-stats-done"]')!.textContent?.toLowerCase()).toContain('done');
    expect(container.querySelector('[data-testid="sidebar-stats-pending"]')!.textContent?.toLowerCase()).toContain('pending');
    expect(container.querySelector('[data-testid="sidebar-stats-failed"]')!.textContent?.toLowerCase()).toContain('failed');
  });

  it('renders active phase name + sub-progress when an active phase exists', () => {
    const phases: readonly PhaseTile[] = [
      tile({ name: 'speckit-specify', order: 1, state: 'completed' }),
      tile({ name: 'speckit-clarify', order: 2, state: 'completed' }),
      tile({ name: 'speckit-plan', order: 3, state: 'completed' }),
      tile({ name: 'speckit-tasks', order: 4, state: 'completed' }),
      tile({ name: 'speckit-analyze', order: 5, state: 'completed' }),
      tile({
        name: 'speckit-implement',
        order: 6,
        state: 'active',
        subProgress: { current: 3, total: 7, label: 'task' }
      }),
      tile({ name: 'finalize', order: 7 })
    ];
    applySnap(buildSnapshot(phases));
    const { container } = render(StatsStrip);
    const line = container.querySelector('[data-testid="sidebar-active-phase"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('spec-kit implement');
    expect(line!.textContent).toMatch(/3\s*\/\s*7/);
    expect(line!.textContent?.toLowerCase()).toContain('task');
  });

  it('renders "no active phase" placeholder when none active', () => {
    const { container } = render(StatsStrip);
    const line = container.querySelector('[data-testid="sidebar-active-phase"]');
    expect(line).not.toBeNull();
    expect(line!.textContent?.toLowerCase()).toContain('no active phase');
  });

  it('renders only phase name when active phase has no sub-progress', () => {
    const phases: readonly PhaseTile[] = [
      tile({ name: 'speckit-specify', order: 1, state: 'active' }),
      ...SEVEN_NOT_STARTED.slice(1)
    ];
    applySnap(buildSnapshot(phases));
    const { container } = render(StatsStrip);
    const line = container.querySelector('[data-testid="sidebar-active-phase"]');
    expect(line!.textContent).toContain('spec-kit specify');
    expect(line!.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it('counters update reactively when snapshot changes', async () => {
    applySnap(buildSnapshot());
    const { container } = render(StatsStrip);
    expect(container.querySelector('[data-testid="sidebar-stats-done"]')!.textContent).toMatch(/\b0\b/);
    const phasesB: readonly PhaseTile[] = SEVEN_NOT_STARTED.map((p, i) =>
      tile({ name: p.name, order: p.order, state: i < 3 ? 'completed' : 'not-started' })
    );
    applySnap(buildSnapshot(phasesB));
    await tick();
    expect(container.querySelector('[data-testid="sidebar-stats-done"]')!.textContent).toMatch(/\b3\b/);
    expect(container.querySelector('[data-testid="sidebar-stats-pending"]')!.textContent).toMatch(/\b4\b/);
  });

  it('renders integer values across sequence of snapshots (no NaN, no floats, no strings)', async () => {
    const sequence: ReadonlyArray<readonly PhaseTile[]> = [
      SEVEN_NOT_STARTED.map((p, i) => tile({ name: p.name, order: p.order, state: i < 3 ? 'completed' : 'not-started' })),
      SEVEN_NOT_STARTED.map((p, i) => tile({ name: p.name, order: p.order, state: i < 4 ? 'completed' : 'not-started' })),
      SEVEN_NOT_STARTED.map((p) => tile({ name: p.name, order: p.order, state: 'completed' }))
    ];
    applySnap(buildSnapshot(sequence[0]));
    const { container } = render(StatsStrip);
    for (const phases of sequence) {
      applySnap(buildSnapshot(phases));
      await tick();
      const doneText = container.querySelector('[data-testid="sidebar-stats-done"]')!.textContent ?? '';
      const m = doneText.match(/\b(\d+)\b/);
      expect(m).not.toBeNull();
      expect(/\bNaN\b/.test(doneText)).toBe(false);
      expect(Number.parseInt(m![1], 10)).toBeGreaterThanOrEqual(0);
    }
  });
});
