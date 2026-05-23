// Feature 033 T021 — CurrentTask telemetry row rendering.
//
// Verifies the compact telemetry summary row in CurrentTask.svelte:
//   * `WorkflowSnapshot.telemetry` populated and status === 'active' /
//     'sleeping' renders `PID <n> · <cpu>% CPU · <rss_mb> MB · <uptime_mmss>`.
//   * `telemetry === null` (or undefined) renders no telemetry row.
//   * `telemetry.status === 'unavailable'` renders `telemetry unavailable`.
//   * `telemetry.status === 'exited' | 'killed'` renders the final
//     numeric line (uses lastLive cache) so the final sample is visible
//     to the operator before the projector clears.
//
// The webview is sanitization-free for this projection: the host emits
// well-typed scalars (FR-022 — single sanitization point at projector).

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import CurrentTask from '../CurrentTask.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type {
  TelemetrySnapshot,
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

function buildTelemetry(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return Object.freeze({
    pid: 12345,
    status: 'active',
    cpuPercent: 38,
    memoryRssBytes: 412 * 1024 * 1024,
    uptimeMs: 134_000, // 02:14
    sampledAt: '2026-05-16T00:00:00.000Z',
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
    producedAt: '2026-05-16T00:00:00.000Z',
    ...overrides
  } as unknown as WorkflowSnapshot);
}

function applySnap(snap: WorkflowSnapshot): void {
  snapshotStore.apply({ type: 'STATE_SNAPSHOT', payload: snap });
}

describe('CurrentTask — Feature 033 telemetry row', () => {
  beforeEach(() => {
    applySnap(buildSnapshot());
  });

  it('renders compact telemetry line when telemetry.status === "active"', () => {
    applySnap(buildSnapshot({ telemetry: buildTelemetry() }));
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-telemetry-row"]');
    expect(row).not.toBeNull();
    const text = row!.textContent ?? '';
    expect(text).toContain('PID 12345');
    expect(text).toContain('38% CPU');
    expect(text).toContain('412 MB');
    expect(text).toContain('02:14');
  });

  it('renders telemetry line when telemetry.status === "sleeping"', () => {
    applySnap(
      buildSnapshot({
        telemetry: buildTelemetry({ status: 'sleeping', cpuPercent: 0.5 })
      })
    );
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-telemetry-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('PID 12345');
  });

  it('renders "telemetry unavailable" when status === "unavailable"', () => {
    applySnap(
      buildSnapshot({
        telemetry: buildTelemetry({
          status: 'unavailable',
          cpuPercent: null,
          memoryRssBytes: null,
          uptimeMs: null
        })
      })
    );
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-telemetry-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('telemetry unavailable');
  });

  it('renders final numerics on status === "exited" (final sample before clear)', () => {
    applySnap(
      buildSnapshot({
        telemetry: buildTelemetry({
          status: 'exited',
          cpuPercent: 12.5,
          memoryRssBytes: 200_000_000,
          uptimeMs: 60_000
        })
      })
    );
    const { container } = render(CurrentTask);
    const row = container.querySelector('[data-testid="sidebar-telemetry-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('PID 12345');
    expect(row!.textContent).toContain('12.5% CPU');
  });

  it('renders no telemetry row when telemetry === null', () => {
    applySnap(buildSnapshot({ telemetry: null }));
    const { container } = render(CurrentTask);
    expect(container.querySelector('[data-testid="sidebar-telemetry-row"]')).toBeNull();
  });

  it('renders no telemetry row when telemetry is absent (legacy-tolerance)', () => {
    applySnap(buildSnapshot({}));
    const { container } = render(CurrentTask);
    expect(container.querySelector('[data-testid="sidebar-telemetry-row"]')).toBeNull();
  });

  it('telemetry row collapses when telemetry transitions from present to null', async () => {
    applySnap(buildSnapshot({ telemetry: buildTelemetry() }));
    const { container } = render(CurrentTask);
    expect(container.querySelector('[data-testid="sidebar-telemetry-row"]')).not.toBeNull();
    applySnap(buildSnapshot({ telemetry: null }));
    await tick();
    expect(container.querySelector('[data-testid="sidebar-telemetry-row"]')).toBeNull();
  });
});
