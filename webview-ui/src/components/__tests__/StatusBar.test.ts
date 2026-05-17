import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import StatusBar from '../StatusBar.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot, WorkflowStatus } from '../../lib/snapshot-types';

afterEach(() => cleanup());

const SEVEN_PHASES = [
  { name: 'speckit-specify', order: 1, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null },
  { name: 'speckit-clarify', order: 2, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null },
  { name: 'speckit-plan', order: 3, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null },
  { name: 'speckit-tasks', order: 4, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null },
  { name: 'speckit-analyze', order: 5, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null },
  { name: 'speckit-implement', order: 6, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null },
  { name: 'finalize', order: 7, state: 'not-started', iteration: 0, lastResult: null, elapsedMs: 0, subProgress: null }
];

function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze(SEVEN_PHASES) as unknown as WorkflowSnapshot['phases'],
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
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
    producedAt: '2026-05-10T00:00:00.000Z',
    ...overrides
  } as unknown as WorkflowSnapshot);
}

function applySnap(snap: WorkflowSnapshot): void {
  snapshotStore.apply({ type: 'STATE_SNAPSHOT', payload: snap });
}

const STATUSES: ReadonlyArray<WorkflowStatus> = [
  'idle',
  'running',
  'paused',
  'completed',
  'failed',
  'canceled'
];

describe('StatusBar', () => {
  beforeEach(() => {
    applySnap(buildSnapshot());
  });

  it('renders sidebar-status-row container', () => {
    const { container } = render(StatusBar);
    expect(container.querySelector('[data-testid="sidebar-status-row"]')).not.toBeNull();
  });

  it.each(STATUSES)('status dot has aria-label="Status: %s"', (status) => {
    applySnap(buildSnapshot({ status }));
    const { container } = render(StatusBar);
    const dot = container.querySelector('[data-testid="sidebar-status-row"] [aria-label^="Status:"]');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('aria-label')).toBe(`Status: ${status}`);
  });

  it('active feature label renders italic placeholder when activeFeatureLabel is null', () => {
    applySnap(buildSnapshot({ activeFeature: null }));
    const { container } = render(StatusBar);
    const row = container.querySelector('[data-testid="sidebar-status-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('no active feature');
  });

  it('active feature label renders the label when present', () => {
    applySnap(
      buildSnapshot({
        activeFeature: { id: 'feat-1', label: 'specs/001-x', startedAt: '2026-05-10T00:00:00.000Z' }
      })
    );
    const { container } = render(StatusBar);
    const row = container.querySelector('[data-testid="sidebar-status-row"]');
    expect(row!.textContent).toContain('specs/001-x');
  });

  it('elapsed pill appears only when workflowElapsedMs !== null', () => {
    applySnap(buildSnapshot({ workflowElapsedMs: null }));
    const { container } = render(StatusBar);
    expect(container.querySelector('[data-testid="sidebar-elapsed-pill"]')).toBeNull();
  });

  it('elapsed pill renders mm:ss format under 1h', () => {
    applySnap(
      buildSnapshot({
        workflowElapsedMs: 65_000,
        activeFeature: { id: 'feat-1', label: 'specs/001-x', startedAt: '2026-05-10T00:00:00.000Z' }
      })
    );
    const { container } = render(StatusBar);
    const pill = container.querySelector('[data-testid="sidebar-elapsed-pill"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toMatch(/1m\s*5s|01:05/);
  });

  it('elapsed pill renders hh:mm:ss-style format >= 1h', () => {
    applySnap(
      buildSnapshot({
        workflowElapsedMs: 3_600_000 + 12_000,
        activeFeature: { id: 'feat-1', label: 'specs/001-x', startedAt: '2026-05-10T00:00:00.000Z' }
      })
    );
    const { container } = render(StatusBar);
    const pill = container.querySelector('[data-testid="sidebar-elapsed-pill"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toMatch(/1h/);
  });

  it('secondary badge appears only when isPrimary === false', () => {
    applySnap(buildSnapshot({ isPrimary: true }));
    const { container } = render(StatusBar);
    expect(container.querySelector('[data-testid="sidebar-secondary-badge"]')).toBeNull();
  });

  it('secondary badge has visible "secondary" text when isPrimary === false', () => {
    applySnap(buildSnapshot({ isPrimary: false }));
    const { container } = render(StatusBar);
    const badge = container.querySelector('[data-testid="sidebar-secondary-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.toLowerCase()).toContain('secondary');
  });
});
