// Feature 064 T013 — top-level flat nav, extended into the six-surface
// operator flow used by the redesigned dashboard shell.
//
// Covers:
//   - Six nav buttons render in the operator flow used by the dashboard shell.
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
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' })),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

function buildSnapshot(): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue: Object.freeze({
      orderedItems: [],
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
  }) as unknown as unknown as WorkflowSnapshot;
}

afterEach(() => cleanup());

describe('Feature 064 T013 — flat six-route top-level nav', () => {
  it('renders six nav buttons in order with stable data-testids', () => {
    // Push a ready snapshot so the nav (and routes) render.
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    const buttons = container.querySelectorAll('[data-testid^="dashboard-route-"]');
    expect(buttons.length).toBe(6);
    expect(buttons[0].getAttribute('data-testid')).toBe('dashboard-route-operations');
    expect(buttons[1].getAttribute('data-testid')).toBe('dashboard-route-history');
    expect(buttons[2].getAttribute('data-testid')).toBe('dashboard-route-metrics');
    expect(buttons[3].getAttribute('data-testid')).toBe('dashboard-route-system');
    expect(buttons[4].getAttribute('data-testid')).toBe('dashboard-route-pipeline-builder');
    expect(buttons[5].getAttribute('data-testid')).toBe('dashboard-route-settings');
  });

  it('switches the visible surface when each route is clicked', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);

    const metBtn = container.querySelector(
      '[data-testid="dashboard-route-metrics"]'
    ) as HTMLButtonElement;
    const opBtn = container.querySelector(
      '[data-testid="dashboard-route-operations"]'
    ) as HTMLButtonElement;
    const historyBtn = container.querySelector(
      '[data-testid="dashboard-route-history"]'
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
    await fireEvent.click(historyBtn);
    expect(container.querySelector('[data-testid="dashboard-route-history"].active')).not.toBeNull();
    await fireEvent.click(metBtn);
    expect(container.querySelector('[data-testid="dashboard-route-metrics"].active')).not.toBeNull();
  });

  it('does NOT render the legacy dashboard-tabs (inner two-tier) markup', () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    expect(container.querySelector('.dashboard-tabs')).toBeNull();
  });

  it('keeps the shell structural and exposes exactly one main landmark per route', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container, getByTestId } = render(App);
    expect(getByTestId('dashboard-app-root').tagName).toBe('DIV');
    expect(container.querySelectorAll('main')).toHaveLength(1);

    await fireEvent.click(getByTestId('dashboard-route-history'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="history-dashboard"]')).not.toBeNull();
    });
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });
});
