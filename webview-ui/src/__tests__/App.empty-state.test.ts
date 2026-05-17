import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import App from '../App.svelte';

afterEach(() => cleanup());

// This test must live in its own file because snapshotStore is a module-level
// singleton — once any sibling test in the same file applies a valid snapshot,
// `isReady` flips to true for the rest of that file. Vitest's default
// per-file isolation gives us a fresh, snapshot-less store here.
describe('App.svelte (empty state)', () => {
  it('renders empty-state and Open Dashboard button only when not ready', () => {
    const { container } = render(App);
    expect(container.querySelector('[data-testid="empty-state"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-open-dashboard-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-status-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-stats-strip"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-current-task"]')).toBeNull();
  });
});
