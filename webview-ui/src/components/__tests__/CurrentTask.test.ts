import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import CurrentTask from '../CurrentTask.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type {
  CliMonitorState,
  FreshnessState,
  LiveActivity,
  WorkflowSnapshot
} from '../../lib/snapshot-types';

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

function buildLiveActivity(overrides: Partial<LiveActivity> = {}): LiveActivity {
  return Object.freeze({
    summary: null,
    category: null,
    lastEventAt: null,
    freshness: 'idle',
    staleSeconds: null,
    ...overrides
  });
}

function buildMonitor(overrides: Partial<CliMonitorState> = {}): CliMonitorState {
  return Object.freeze({
    runId: 'run-1',
    phase: 'speckit-implement',
    status: 'running',
    pid: 1234,
    startedAt: '2026-05-10T00:00:00.000Z',
    lastStdoutAt: '2026-05-10T00:00:02.000Z',
    lastStderrAt: null,
    lastProgressAt: null,
    stdoutLines: 1,
    stderrLines: 0,
    exitCode: null,
    signal: null,
    detectedIssues: Object.freeze([]),
    msSinceLastStdout: 2_000,
    msSinceLastStderr: null,
    ...overrides
  });
}

function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze(SEVEN_PHASES) as unknown as WorkflowSnapshot['phases'],
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }) as unknown as WorkflowSnapshot['queue'],
    auditTail: Object.freeze([]),
    liveActivity: buildLiveActivity(),
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

const ALL_FRESHNESS_STATES: ReadonlyArray<FreshnessState> = [
  'live',
  'slowing',
  'stalled',
  'paused',
  'idle'
];

describe('CurrentTask', () => {
  beforeEach(() => {
    applySnap(buildSnapshot());
  });

  it('renders sidebar-current-task container', () => {
    const { container } = render(CurrentTask);
    expect(container.querySelector('[data-testid="sidebar-current-task"]')).not.toBeNull();
  });

  it.each(ALL_FRESHNESS_STATES)('renders sidebar-freshness for state %s', (state) => {
    applySnap(buildSnapshot({ liveActivity: buildLiveActivity({ freshness: state }) }));
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh).not.toBeNull();
    expect(fresh!.getAttribute('aria-label')).toContain(state);
  });

  it('label includes staleSeconds suffix for slowing', () => {
    applySnap(
      buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'slowing', staleSeconds: 12 }) })
    );
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent).toContain('slowing');
    expect(fresh!.textContent).toContain('12s');
  });

  it('label includes staleSeconds suffix for stalled', () => {
    applySnap(
      buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'stalled', staleSeconds: 45 }) })
    );
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent).toContain('stalled');
    expect(fresh!.textContent).toContain('45s');
  });

  it('label has no suffix for live', () => {
    applySnap(
      buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'live', staleSeconds: 0 }) })
    );
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent?.trim()).toBe('live');
  });

  it('label has no suffix for paused', () => {
    applySnap(
      buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'paused', staleSeconds: 0 }) })
    );
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent?.trim()).toBe('paused');
  });

  it('label has no suffix for idle', () => {
    applySnap(buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'idle' }) }));
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent?.trim()).toBe('idle');
  });

  it('staleSeconds=null for slowing degrades gracefully (no suffix)', () => {
    applySnap(
      buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'slowing', staleSeconds: null }) })
    );
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent).toContain('slowing');
    expect(fresh!.textContent).not.toMatch(/\d+s/);
  });

  it('staleSeconds=null for stalled degrades gracefully (no suffix)', () => {
    applySnap(
      buildSnapshot({ liveActivity: buildLiveActivity({ freshness: 'stalled', staleSeconds: null }) })
    );
    const { container } = render(CurrentTask);
    const fresh = container.querySelector('[data-testid="sidebar-freshness"]');
    expect(fresh!.textContent).toContain('stalled');
    expect(fresh!.textContent).not.toMatch(/\d+s/);
  });

  it('activity summary is single-line truncated via CSS', () => {
    applySnap(
      buildSnapshot({
        liveActivity: buildLiveActivity({ summary: 'a very long line of activity', freshness: 'live' })
      })
    );
    const { container } = render(CurrentTask);
    const summaryEl = container.querySelector('[data-testid="sidebar-current-task"] .activity');
    expect(summaryEl).not.toBeNull();
    const src = readFileSync(resolve(__dirname, '../CurrentTask.svelte'), 'utf8');
    const styleMatch = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    const style = styleMatch ? styleMatch[1] : '';
    expect(style).toMatch(/text-overflow:\s*ellipsis/);
    expect(style).toMatch(/white-space:\s*nowrap/);
  });

  it('renders empty string (not "null") when summary is null', () => {
    applySnap(buildSnapshot({ liveActivity: buildLiveActivity({ summary: null }) }));
    const { container } = render(CurrentTask);
    const summaryEl = container.querySelector('[data-testid="sidebar-current-task"] .activity');
    expect(summaryEl?.textContent).not.toContain('null');
  });

  it('monitor row absent when monitor === null', () => {
    applySnap(buildSnapshot({ monitor: null }));
    const { container } = render(CurrentTask);
    expect(container.querySelector('[data-testid="sidebar-monitor-row"]')).toBeNull();
  });

  it('monitor row present with status + stdout age when monitor !== null', () => {
    applySnap(
      buildSnapshot({ monitor: buildMonitor({ status: 'running', msSinceLastStdout: 2_000 }) })
    );
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-monitor-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('running');
    expect(row!.textContent).toContain('2s');
  });

  it('monitor row omits stdout suffix when msSinceLastStdout === null', () => {
    applySnap(
      buildSnapshot({ monitor: buildMonitor({ status: 'stalled', msSinceLastStdout: null }) })
    );
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-monitor-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('stalled');
    expect(row!.textContent).not.toMatch(/stdout\s+\d/);
  });

  it('monitor row collapses when monitor transitions from present to null', async () => {
    applySnap(buildSnapshot({ monitor: buildMonitor({ status: 'running' }) }));
    const { container } = render(CurrentTask);
    expect(container.querySelector('[data-testid="sidebar-monitor-row"]')).not.toBeNull();
    applySnap(buildSnapshot({ monitor: null }));
    await tick();
    expect(container.querySelector('[data-testid="sidebar-monitor-row"]')).toBeNull();
  });

  it('monitor row degraded label maps from "stalled" status', () => {
    applySnap(
      buildSnapshot({ monitor: buildMonitor({ status: 'stalled', msSinceLastStdout: 500 }) })
    );
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-monitor-row"]');
    expect(row!.textContent).toContain('stalled');
  });
});
