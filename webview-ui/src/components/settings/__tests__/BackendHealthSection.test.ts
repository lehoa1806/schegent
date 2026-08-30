import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import BackendHealthSection from '../BackendHealthSection.svelte';
import type { BackendRunnerKind, WorkflowSnapshot } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type { BackendSection } from '../general/field-types';
import { snapshotToDraft } from '../general/settings-draft';
import { pingBackend } from '../../../lib/backend-ping-ipc';

vi.mock('../../../lib/backend-ping-ipc', () => ({ pingBackend: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function snapshot(ping: WorkflowSnapshot['backendPingState'] = { status: 'idle' }) {
  return {
    availableBackends: ['claude'],
    backendPingState: ping
  } as unknown as WorkflowSnapshot;
}

// FR-R3-144 (T026) — the three assertions below are unchanged. Only the props
// changed shape: an array the component paired with its own runner list by INDEX
// became a record keyed by backend, so the fixture states which backend each
// field belongs to instead of relying on two files agreeing on an order.
const BACKENDS: Readonly<Record<BackendRunnerKind, BackendSection>> = {
  claude: {
    label: 'Claude',
    path: { key: 'cliPath', ipcKey: 'cli.path', label: 'Claude CLI Path', kind: 'string' },
    specific: []
  },
  codex: {
    label: 'Codex',
    path: { key: 'codexPath', ipcKey: 'codex.path', label: 'Codex CLI Path', kind: 'string' },
    specific: []
  },
  agy: {
    label: 'Agy',
    path: { key: 'agyPath', ipcKey: 'agy.path', label: 'Agy CLI Path', kind: 'string' },
    specific: []
  }
};

const mockProps = {
  backends: BACKENDS,
  // A real `Draft`, projected from the idle settings the app itself ships, rather
  // than the four-field object literal that stood here. That literal compiled only
  // because an earlier type error masked it; a partial draft is also a fixture that
  // cannot exercise `inUse`, which reads `draft.backendRunner`.
  draft: snapshotToDraft(IDLE_GENERAL_SETTINGS),
  statusByKey: {},
  fieldChanged: () => false,
  fieldScopeLabel: () => 'default',
  pipelines: [],
  saveOne: () => {},
  resetField: () => {}
};

describe('BackendHealthSection', () => {
  it('renders one action per v1 backend through the shared helper', async () => {
    const { getByTestId } = render(BackendHealthSection, {
      props: { snapshot: snapshot(), ...mockProps }
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
        }),
        ...mockProps
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
        }),
        ...mockProps
      }
    });
    expect(getByRole('status').textContent).toBe('Unavailable · non-zero-exit · exit 7');
  });
});
