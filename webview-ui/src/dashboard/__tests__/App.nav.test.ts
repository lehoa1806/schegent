// Feature 064 T013 — top-level four-route flat nav (was three-route under
// Feature 012 T030; extended to include a peer System tab between
// Pipeline Builder and Settings).
//
// Covers:
//   - Four nav buttons render in order: Operations, Pipeline Builder, System, Settings.
//   - Each carries the stable data-testid from the navigation contract.
//   - Clicking each route switches the rendered content surface.
//   - No `dashboard-tabs` (legacy two-tier) markup remains anywhere.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import App from '../App.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));

function buildSnapshot(): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
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
    producedAt: '2026-05-11T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

afterEach(() => cleanup());

describe('Feature 064 T013 — flat four-route top-level nav', () => {
  it('renders four nav buttons in order with stable data-testids', () => {
    // Push a ready snapshot so the nav (and routes) render.
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    const buttons = container.querySelectorAll('[data-testid^="dashboard-route-"]');
    expect(buttons.length).toBe(4);
    expect(buttons[0].getAttribute('data-testid')).toBe('dashboard-route-operations');
    expect(buttons[1].getAttribute('data-testid')).toBe('dashboard-route-pipeline-builder');
    expect(buttons[2].getAttribute('data-testid')).toBe('dashboard-route-system');
    expect(buttons[3].getAttribute('data-testid')).toBe('dashboard-route-settings');
  });

  it('switches the visible surface when each route is clicked', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);

    const opBtn = container.querySelector(
      '[data-testid="dashboard-route-operations"]'
    ) as HTMLButtonElement;
    const pbBtn = container.querySelector(
      '[data-testid="dashboard-route-pipeline-builder"]'
    ) as HTMLButtonElement;
    const sysBtn = container.querySelector(
      '[data-testid="dashboard-route-system"]'
    ) as HTMLButtonElement;
    const setBtn = container.querySelector(
      '[data-testid="dashboard-route-settings"]'
    ) as HTMLButtonElement;

    await fireEvent.click(pbBtn);
    expect(container.querySelector('[data-testid="dashboard-route-pipeline-builder"].active')).not.toBeNull();
    await fireEvent.click(sysBtn);
    expect(container.querySelector('[data-testid="dashboard-route-system"].active')).not.toBeNull();
    await fireEvent.click(setBtn);
    expect(container.querySelector('[data-testid="dashboard-route-settings"].active')).not.toBeNull();
    await fireEvent.click(opBtn);
    expect(container.querySelector('[data-testid="dashboard-route-operations"].active')).not.toBeNull();
  });

  it('does NOT render the legacy dashboard-tabs (inner two-tier) markup', () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    expect(container.querySelector('.dashboard-tabs')).toBeNull();
  });
});
