// Review gap GC-16 (2026-11-12) — the notice a surface shows when the store dropped a snapshot it
// could not read. Rendered against the real store: the property is what the operator sees after
// that drop, and a stubbed store would only echo the stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { buildIdleSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { resetHostTransport, setHostTransport } from '../../lib/host-transport';
import { STATE_SNAPSHOT } from '../../lib/messages';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import IncompatibleSnapshotNotice from '../IncompatibleSnapshotNotice.svelte';

function idle(): WorkflowSnapshot {
  return buildIdleSnapshot({ isPrimary: true, producedAt: '2026-11-12T00:00:00.000Z' }) as unknown as WorkflowSnapshot;
}

function apply(payload: WorkflowSnapshot, revision: number): void {
  snapshotStore.apply({ type: STATE_SNAPSHOT, payload, sync: { mode: 'full', revision } });
  flushSync();
}

beforeEach(() => {
  snapshotStore.resetSyncState();
  resetHostTransport();
  setHostTransport({
    postMessage() {},
    onMessage() {
      return () => {};
    },
    getState() {
      return undefined;
    },
    setState() {}
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => cleanup());

describe('GC-16 — IncompatibleSnapshotNotice', () => {
  it('shows nothing while every snapshot is readable', () => {
    const { queryByTestId } = render(IncompatibleSnapshotNotice);
    apply(idle(), 1);

    expect(queryByTestId('incompatible-snapshot')).toBeNull();
  });

  it('names the unknown version and the remedy as an alert', () => {
    const { getByTestId } = render(IncompatibleSnapshotNotice);
    apply({ ...idle(), schemaVersion: 99 } as unknown as WorkflowSnapshot, 1);

    const notice = getByTestId('incompatible-snapshot');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('state format 99');
    expect(notice.textContent).toContain('Reload the window');
  });

  it('goes away when a readable snapshot follows', () => {
    const { queryByTestId } = render(IncompatibleSnapshotNotice);
    apply({ ...idle(), schemaVersion: 99 } as unknown as WorkflowSnapshot, 1);
    apply(idle(), 2);

    expect(queryByTestId('incompatible-snapshot')).toBeNull();
  });
});

describe('GC-16 — both shells mount the notice', () => {
  it('the sidebar shows it under "Connecting" when the first snapshot is unreadable', async () => {
    const { default: SidebarApp } = await import('../../App.svelte');
    const { getByTestId } = render(SidebarApp);
    apply({ ...idle(), schemaVersion: 99 } as unknown as WorkflowSnapshot, 1);

    expect(getByTestId('empty-state')).toBeTruthy();
    expect(getByTestId('incompatible-snapshot').textContent).toContain('state format 99');
  });

  it('the dashboard shows it under its loading state', async () => {
    const { default: DashboardApp } = await import('../../dashboard/App.svelte');
    const { getByTestId } = render(DashboardApp);
    apply({ ...idle(), schemaVersion: 99 } as unknown as WorkflowSnapshot, 1);

    expect(getByTestId('dashboard-empty-state')).toBeTruthy();
    expect(getByTestId('incompatible-snapshot').textContent).toContain('state format 99');
  });
});
