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
    path: { key: 'cliPath', ipcKey: 'cli.path', label: 'Claude CLI path', kind: 'string' },
    specific: []
  },
  codex: {
    label: 'Codex',
    path: { key: 'codexPath', ipcKey: 'codex.path', label: 'Codex CLI path', kind: 'string' },
    specific: []
  },
  agy: {
    label: 'Agy',
    path: { key: 'agyPath', ipcKey: 'agy.path', label: 'Agy CLI path', kind: 'string' },
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
  workflows: []
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

  it('disables every action during the host-local single flight', async () => {
    const { getByTestId, getByRole } = render(BackendHealthSection, {
      props: {
        snapshot: snapshot({
          status: 'running', runner: 'agy', startedAt: 10, timeoutSeconds: 5
        }),
        ...mockProps
      }
    });
    // Claude was found, so its test is the card's own button. Codex and Agy were not, so theirs
    // is an item of the card's menu, and a menu disables an item with `aria-disabled`: a keyboard
    // user can still reach the item and read it.
    expect((getByTestId('ping-backend-claude') as HTMLButtonElement).disabled).toBe(true);
    for (const runner of ['codex', 'agy']) {
      expect(getByTestId(`ping-backend-${runner}`).getAttribute('aria-disabled')).toBe('true');
    }
    // Disabled in fact, not only in looks: no second probe starts from any of the three.
    for (const runner of ['claude', 'codex', 'agy']) {
      await fireEvent.click(getByTestId(`ping-backend-${runner}`));
    }
    expect(pingBackend).not.toHaveBeenCalled();
    expect(getByRole('status').textContent).toContain('Checking Agy');
  });

  it('says a test is in flight on the button that started it', () => {
    const { getByTestId } = render(BackendHealthSection, {
      props: {
        snapshot: snapshot({
          status: 'running', runner: 'claude', startedAt: 10, timeoutSeconds: 5
        }),
        ...mockProps
      }
    });
    const button = getByTestId('ping-backend-claude');
    expect(button.textContent.trim()).toBe('Testing…');
    expect(button.getAttribute('aria-label')).toBe('Testing claude…');
  });

  it('heads the list as the redesign does, on the id a launch notice scrolls to', () => {
    const { container } = render(BackendHealthSection, {
      props: { snapshot: snapshot(), ...mockProps }
    });
    const heading = container.querySelector('#backend-health-heading');
    expect(heading?.textContent).toBe('Installed backends');
    expect(container.querySelector('#backend-health-description')).toBeNull();
  });

  it('lets the last test speak for a backend that was not found', () => {
    // Codex was not found and the last test of it failed: the result takes the standing chip's
    // place, so a card never shows two verdicts. Agy, not found and untested, keeps its chip.
    const { getByTestId, queryByTestId } = render(BackendHealthSection, {
      props: {
        snapshot: snapshot({
          status: 'failure', runner: 'codex', startedAt: 10,
          completedAt: 12, latencyMs: 2, timeoutSeconds: 5,
          cause: 'not-found'
        }),
        ...mockProps
      }
    });
    expect(queryByTestId('backend-not-installed-codex')).toBeNull();
    expect(getByTestId('backend-not-installed-agy').textContent.trim()).toBe('Not installed');
  });

  it('opens details the user closed when a save of a field inside them fails', async () => {
    // The reason a save failed is written under its field, so a region the user closed earlier
    // must not keep it out of sight.
    const view = render(BackendHealthSection, { props: { snapshot: snapshot(), ...mockProps } });
    const region = view.getByTestId('backend-details-claude');
    const link = view.getByTestId('backend-details-toggle-claude');
    expect(region.hidden).toBe(true);
    await fireEvent.click(link);
    await fireEvent.click(link);
    expect(region.hidden).toBe(true);
    await view.rerender({
      statusByKey: { cliPath: { status: 'rejected', reason: 'SENTINEL-REJECTION' } }
    });
    expect(region.hidden).toBe(false);
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
