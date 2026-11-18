// The redesigned dashboard shell: its icon sprite, the top bar's workspace chip, the status line,
// and what opening a page from the navigation does besides switching the route.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, type RenderResult } from '@testing-library/svelte';

import { buildSnapshot } from '../../components/Runs/__tests__/launch-fixture';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { STATUS_LINE_READY, statusLine } from '../../lib/status-line.svelte';
import App from '../App.svelte';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' })),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

/** The budget for a lazily imported route to mount. `App.nav.test.ts` records the measurement. */
const LAZY_ROUTE_WAIT_MS = 3000;

function mountShell(overrides: Partial<WorkflowSnapshot> = {}): RenderResult<typeof App> {
  snapshotStore.apply({
    type: 'STATE_SNAPSHOT',
    payload: buildSnapshot(overrides)
  } as unknown as Parameters<typeof snapshotStore.apply>[0]);
  return render(App);
}

function pageHeading(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('#dashboard-content h1');
}

/** Opens a page the way an operator does: the button has focus when it is pressed. */
async function openPage(button: HTMLElement): Promise<void> {
  button.focus();
  await fireEvent.click(button);
}

async function waitForHeading(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(pageHeading(container)?.textContent).toBe(text);
    },
    { timeout: LAZY_ROUTE_WAIT_MS }
  );
}

async function waitForFocusOnHeading(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(document.activeElement).toBe(pageHeading(container));
      expect(document.activeElement?.textContent).toBe(text);
    },
    { timeout: LAZY_ROUTE_WAIT_MS }
  );
}

afterEach(() => {
  cleanup();
  statusLine.announce(STATUS_LINE_READY);
});

describe('dashboard shell', () => {
  it('renders the icon sprite once, with a symbol for every icon the top bar uses', () => {
    const { container } = mountShell();
    expect(container.querySelectorAll('svg.sprite')).toHaveLength(1);
    const references = [...container.querySelectorAll('header use')].map((use) =>
      use.getAttribute('href')
    );
    // The logo and one icon for each of the six pages.
    expect(references).toHaveLength(7);
    for (const reference of references) {
      expect(container.querySelector(`symbol${reference}`), `${reference}`).not.toBeNull();
    }
  });

  it('marks the page that is showing in the navigation', async () => {
    const { container, getByTestId } = mountShell();
    const current = (): (string | null)[] =>
      [...container.querySelectorAll('[aria-current="page"]')].map((button) =>
        button.getAttribute('data-testid')
      );
    expect(current()).toEqual(['dashboard-route-operations']);
    await fireEvent.click(getByTestId('dashboard-route-history'));
    expect(current()).toEqual(['dashboard-route-history']);
  });

  it('says in the top bar that this window controls the workspace', () => {
    const chip = mountShell().getByTestId('dashboard-workspace-state');
    expect(chip.textContent.trim()).toBe('Workspace Connected');
    expect(chip.classList.contains('s-ok')).toBe(true);
    expect(chip.querySelector('.dot')).not.toBeNull();
  });

  it('says in the top bar that a second window is read-only', () => {
    const chip = mountShell({ isPrimary: false }).getByTestId('dashboard-workspace-state');
    expect(chip.textContent.trim()).toBe('Read-only Window');
    expect(chip.classList.contains('s-warn')).toBe(true);
    // A mark of its own, so the state does not rest on colour once the text is hidden.
    expect(chip.querySelector('.dot')).toBeNull();
    expect(chip.querySelector('use')?.getAttribute('href')).toBe('#i-warn');
  });

  it('reads "Ready." in the status line until a page is opened, then names the page', async () => {
    const { getByTestId } = mountShell();
    const line = getByTestId('dashboard-status-line');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent.trim()).toBe('Ready.');
    await fireEvent.click(getByTestId('dashboard-route-history'));
    expect(line.textContent.trim()).toBe('Showing History.');
    await fireEvent.click(getByTestId('dashboard-route-system'));
    expect(line.textContent.trim()).toBe('Showing System Log.');
  });

  it('moves focus to the heading of the page that was opened', async () => {
    const { container, getByTestId } = mountShell();
    // The first visit pays for the import, which can outlast the wait for the heading on a busy
    // machine. The visits after it do not, and those are the ones this test judges.
    await openPage(getByTestId('dashboard-route-history'));
    await waitForHeading(container, 'History');

    await openPage(getByTestId('dashboard-route-operations'));
    await waitForFocusOnHeading(container, 'Queues');

    // A page that loads lazily: the heading is not there yet when the route changes, and the
    // heading of the page being left must not be taken for it.
    await openPage(getByTestId('dashboard-route-history'));
    await waitForFocusOnHeading(container, 'History');

    // From one lazily loaded page to another: the page being left stays mounted a moment longer
    // than in the step above, and its heading must not be taken for the new one either.
    await openPage(getByTestId('dashboard-route-system'));
    await waitForHeading(container, 'System Log');
    await openPage(getByTestId('dashboard-route-history'));
    await waitForFocusOnHeading(container, 'History');
  });

  // The Queues list's "Queue defaults" opens Settings on its Queues section. It is a page opened
  // like any other: the status line names it and focus lands on its heading, as the redesign's
  // own link does. This replaced a dialog whose focus rules (spec 255 FR-022, FR-023) it retired.
  it('opens Settings from "Queue defaults" the way the navigation opens a page', async () => {
    const { container, getByTestId } = mountShell();
    const line = getByTestId('dashboard-status-line');
    // The first visit pays for the import (see the test above); this one is not judged.
    await openPage(getByTestId('dashboard-route-settings'));
    await waitForHeading(container, 'Settings');
    await openPage(getByTestId('dashboard-route-operations'));
    await waitForFocusOnHeading(container, 'Queues');

    await openPage(getByTestId('queue-settings-open'));

    await waitForFocusOnHeading(container, 'Settings');
    expect(line.textContent.trim()).toBe('Showing Settings.');
    const queuesTab = container.querySelector('[data-testid="settings-nav-queues"]');
    expect(queuesTab?.getAttribute('aria-current')).toBe('true');
  });

  it('leaves focus alone when the operator has moved on before the page appears', async () => {
    const { container, getByTestId } = mountShell();
    const system = getByTestId('dashboard-route-system');
    const metrics = getByTestId('dashboard-route-metrics');
    system.focus();
    const clicked = fireEvent.click(system);
    metrics.focus();
    await clicked;
    await waitForHeading(container, 'System Log');
    // Two frames: longer than the wait for the heading needs to see that it has arrived.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(metrics);
  });
});
