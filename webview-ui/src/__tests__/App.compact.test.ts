import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../App.svelte';
import { snapshotStore } from '../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../lib/snapshot-types';

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

function buildSnapshot(): WorkflowSnapshot {
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
    producedAt: '2026-05-10T00:00:00.000Z'
  } as unknown as WorkflowSnapshot);
}

function applySnap(snap: WorkflowSnapshot): void {
  snapshotStore.apply({ type: 'STATE_SNAPSHOT', payload: snap });
}

describe('App.svelte (compact sidebar)', () => {
  beforeEach(() => {
    applySnap(buildSnapshot());
  });

  it('renders all four zone testids in order inside app-root when ready', () => {
    const { container } = render(App);
    const root = container.querySelector('[data-testid="app-root"]');
    expect(root).not.toBeNull();

    const zones = [
      'sidebar-status-row',
      'sidebar-stats-strip',
      'sidebar-current-task',
      'sidebar-open-dashboard-button'
    ];
    const found = zones.map((id) => root!.querySelector(`[data-testid="${id}"]`));
    found.forEach((el, i) => {
      expect(el, `missing zone ${zones[i]}`).not.toBeNull();
    });

    const orderInDom = Array.from(root!.querySelectorAll('[data-testid]'))
      .map((e) => e.getAttribute('data-testid')!)
      .filter((id) => zones.includes(id));
    const firstSeen: string[] = [];
    for (const id of orderInDom) {
      if (zones.includes(id) && !firstSeen.includes(id)) firstSeen.push(id);
    }
    expect(firstSeen).toEqual(zones);
  });

  it('root has no overflow-y: auto in its CSS', () => {
    const src = readFileSync(resolve(__dirname, '../App.svelte'), 'utf8');
    const styleMatch = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    const style = styleMatch ? styleMatch[1] : '';
    expect(style).not.toMatch(/overflow-y:\s*auto/);
    expect(style).not.toMatch(/overflow:\s*auto/);
  });

  it('does NOT render previously sidebar-only testids', () => {
    const { container } = render(App);
    const removed = [
      'live-activity-header',
      'monitor-pill',
      'queue-action-button',
      'queue-open-dashboard-button',
      'history-section',
      'retry-active-run-button'
    ];
    for (const id of removed) {
      expect(
        container.querySelector(`[data-testid="${id}"]`),
        `unexpected sidebar testid present: ${id}`
      ).toBeNull();
    }
  });
});
