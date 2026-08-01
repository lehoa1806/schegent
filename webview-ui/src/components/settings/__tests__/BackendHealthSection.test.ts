import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import BackendHealthSection from '../BackendHealthSection.svelte';
import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
import { pingBackend } from '../../../lib/backend-ping-ipc';

vi.mock('../../../lib/backend-ping-ipc', () => ({ pingBackend: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function snapshot(ping: WorkflowSnapshot['backendPingState'] = { status: 'idle' }) {
  return {
    availableBackends: ['claude'],
    backendPingState: ping
  } as unknown as WorkflowSnapshot;
}

describe('BackendHealthSection', () => {
  it('renders one action per v1 backend through the shared helper', async () => {
    const { getByTestId } = render(BackendHealthSection, {
      props: { snapshot: snapshot() }
    });
    expect(getByTestId('ping-backend-claude')).toBeTruthy();
    expect(getByTestId('ping-backend-codex')).toBeTruthy();
    expect(getByTestId('ping-backend-agy')).toBeTruthy();
    await fireEvent.click(getByTestId('ping-backend-codex'));
    expect(pingBackend).toHaveBeenCalledWith('codex');
  });

  it('disables every action during the host-local single flight', () => {
    const { getByTestId, getByRole } = render(BackendHealthSection, {
      props: {
        snapshot: snapshot({
          status: 'running', runner: 'agy', startedAt: 10, timeoutSeconds: 5
        })
      }
    });
    for (const runner of ['claude', 'codex', 'agy']) {
      expect((getByTestId(`ping-backend-${runner}`) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(getByRole('status').textContent).toContain('Checking Agy');
  });

  it('renders only generic failure data', () => {
    const { getByRole } = render(BackendHealthSection, {
      props: {
        snapshot: snapshot({
          status: 'failure', runner: 'claude', startedAt: 10,
          completedAt: 12, latencyMs: 2, timeoutSeconds: 5,
          cause: 'non-zero-exit', exitCode: 7
        })
      }
    });
    expect(getByRole('status').textContent).toBe('Unavailable · non-zero-exit · exit 7');
  });
});
