import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import App from '../App.svelte';

afterEach(() => cleanup());

// T061: dashboard/App.svelte empty-state guard. snapshotStore is a module
// singleton — keeping this in its own file gives Vitest's default per-file
// isolation a fresh, snapshot-less store, so `isReady` is false at mount.
// When the store is empty, the recomposed Dashboard.svelte (BUG-003) MUST
// NOT mount; only the empty-state placeholder is allowed.
describe('dashboard/App.svelte (empty state) — T061', () => {
  it('renders dashboard-empty-state and does NOT mount Dashboard zones when not ready', () => {
    const { container } = render(App);
    expect(
      container.querySelector('[data-testid="dashboard-empty-state"]')
    ).not.toBeNull();
    // None of the FR-033 zone testids may appear when no snapshot is delivered.
    for (const zoneId of [
      'dashboard-queue-input',
      'dashboard-queue-management',
      'dashboard-queue-list',
      'dashboard-phase-progression',
      'dashboard-activity-audit-feed'
    ]) {
      expect(container.querySelector(`[data-testid="${zoneId}"]`)).toBeNull();
    }
  });
});
