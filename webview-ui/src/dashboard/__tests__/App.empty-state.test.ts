import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import App from '../App.svelte';

afterEach(() => cleanup());

// T061: dashboard/App.svelte empty-state guard. snapshotStore is a module
// singleton — keeping this in its own file gives Vitest's default per-file
// isolation a fresh, snapshot-less store, so `isReady` is false at mount.
// When the store is empty, the operations route (OperationsSurface, tier 1
// QueuesTier) MUST NOT mount; only the empty-state placeholder is allowed.
//
// Feature 097 retired the flat, always-mounted Dashboard zones this test
// used to check by testid: three (`dashboard-queue-management`,
// `dashboard-queue-list`, `dashboard-activity-audit-feed`) no longer exist
// anywhere in the app, and the other two (`dashboard-queue-input`,
// `dashboard-phase-progression`) now live two and three drill-down tiers
// deep, so none of the five ever mounted from readiness alone — the check
// was vacuous. `dashboard-route` is the container `App.svelte` renders only
// on the same `{#if ready && snapshot}` branch the zones used to share, so
// its absence asserts the actual guard directly; `queues-tier` pins down the
// real tier-1 content that mounts by default once ready.
describe('dashboard/App.svelte (empty state) — T061', () => {
  it('renders dashboard-empty-state and does NOT mount the operations route when not ready', () => {
    const { container } = render(App);
    expect(
      container.querySelector('[data-testid="dashboard-empty-state"]')
    ).not.toBeNull();
    for (const testId of ['dashboard-route', 'queues-tier']) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
  });
});
