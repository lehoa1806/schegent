// Feature 064 T013 — top-level flat nav, extended into the operator flow used
// by the redesigned dashboard shell. Feature 091 (T017, FR-018) added `runs` as
// a seventh surface, positioned after `operations`.
//
// Covers:
//   - Seven nav buttons render in the operator flow used by the dashboard shell.
//   - Each carries the stable data-testid from the navigation contract.
//   - Clicking each route switches the rendered content surface.
//   - No `dashboard-tabs` (legacy two-tier) markup remains anywhere.
//   - The landing surface is still `operations` after the addition.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import App from '../App.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import {
  DASHBOARD_ROUTES,
  DASHBOARD_ROUTE_LABELS,
  DEFAULT_DASHBOARD_ROUTE
} from '../routes';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' })),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

function buildSnapshot(): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: Object.freeze([]),
      liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
      }),
      workflowElapsedMs: null
    }),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
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

describe('Feature 064 T013 — flat seven-route top-level nav', () => {
  it('renders seven nav buttons in order with stable data-testids', () => {
    // Push a ready snapshot so the nav (and routes) render.
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    const buttons = container.querySelectorAll('[data-testid^="dashboard-route-"]');
    expect(buttons.length).toBe(7);
    expect(buttons[0].getAttribute('data-testid')).toBe('dashboard-route-operations');
    expect(buttons[1].getAttribute('data-testid')).toBe('dashboard-route-runs');
    expect(buttons[2].getAttribute('data-testid')).toBe('dashboard-route-history');
    expect(buttons[3].getAttribute('data-testid')).toBe('dashboard-route-metrics');
    expect(buttons[4].getAttribute('data-testid')).toBe('dashboard-route-system');
    expect(buttons[5].getAttribute('data-testid')).toBe('dashboard-route-builder');
    expect(buttons[6].getAttribute('data-testid')).toBe('dashboard-route-settings');
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
      '[data-testid="dashboard-route-builder"]'
    ) as HTMLButtonElement;
    const sysBtn = container.querySelector(
      '[data-testid="dashboard-route-system"]'
    ) as HTMLButtonElement;
    const setBtn = container.querySelector(
      '[data-testid="dashboard-route-settings"]'
    ) as HTMLButtonElement;

    await fireEvent.click(pbBtn);
    expect(container.querySelector('[data-testid="dashboard-route-builder"].active')).not.toBeNull();
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

// Feature 091 (T017, US2 — FR-018) — the mount, seen from the nav.
//
// Two claims, and the second is the one that could quietly cost an operator
// something. The first is that the surface is genuinely reachable: a button
// exists, clicking it loads a real component, and the component is the Runs
// surface rather than the loading placeholder. The second is that adding it
// moved nobody's landing page — `DEFAULT_DASHBOARD_ROUTE` is asserted directly
// rather than inferred from what renders first, because a default that changed
// while the first render happened to agree is exactly the regression a
// render-only assertion would miss.
describe('Feature 091 T017 — the Runs route (FR-018)', () => {
  it('appears in the nav labelled "Runs"', () => {
    expect(DASHBOARD_ROUTES).toContain('runs');
    expect(DASHBOARD_ROUTE_LABELS.runs).toBe('Runs');

    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { getByTestId } = render(App);
    expect(getByTestId('dashboard-route-runs').textContent).toContain('Runs');
  });

  it('sits directly after operations, before history', () => {
    expect(DASHBOARD_ROUTES.indexOf('runs')).toBe(DASHBOARD_ROUTES.indexOf('operations') + 1);
    expect(DASHBOARD_ROUTES.indexOf('runs')).toBeLessThan(DASHBOARD_ROUTES.indexOf('history'));
  });

  it('loads its surface on demand when the route is opened', async () => {
    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container, getByTestId } = render(App);

    // Not loaded until asked for — that is what "on demand" means here, and a
    // statically imported surface would already be in the DOM's reach.
    expect(container.querySelector('[data-testid="runs-surface"]')).toBeNull();

    await fireEvent.click(getByTestId('dashboard-route-runs'));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="runs-surface"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="dashboard-route-runs"].active')).not.toBeNull();
  });

  it('leaves the landing surface on operations', () => {
    expect(DEFAULT_DASHBOARD_ROUTE).toBe('operations');

    snapshotStore.apply({
      type: 'STATE_SNAPSHOT',
      payload: buildSnapshot()
    } as unknown as Parameters<typeof snapshotStore.apply>[0]);
    const { container } = render(App);
    expect(
      container.querySelector('[data-testid="dashboard-route-operations"].active')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="dashboard-route-runs"].active')).toBeNull();
  });
});
