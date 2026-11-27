// The redesign's queue header keeps one button for the queue's next step and puts the rest in a
// "More queue actions" menu. QueueControls owns two of the menu's items, the clear actions: on its
// own it draws them in a menu of its own, and the queue page passes `actions` to place them among
// its own items (QueueDetailTier.test.ts covers that path).

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueueControls from '../QueueControls.svelte';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-1' }))
}));

afterEach(() => cleanup());

function props(overrides: Record<string, unknown> = {}) {
  return {
    isPrimary: true,
    queueId: 'q-beta',
    paused: false,
    pendingCount: 0,
    hasInFlight: false,
    clearDoneDisabled: false,
    cleanDisabled: false,
    haltedTask: null,
    onResume: vi.fn(),
    onPause: vi.fn(),
    onClearDone: vi.fn(),
    onClean: vi.fn(),
    ...overrides
  };
}

describe('QueueControls — the clear actions', () => {
  it('draws them as items of a More queue actions menu', () => {
    const { getByTestId } = render(QueueControls, { props: props() });
    const clearDone = getByTestId('dashboard-queue-clear-done');
    const clean = getByTestId('dashboard-queue-clean');

    expect(clearDone.getAttribute('role')).toBe('menuitem');
    expect(clean.getAttribute('role')).toBe('menuitem');
    expect(clearDone.closest('[role="menu"]')?.getAttribute('aria-label')).toBe('More queue actions');
    expect(clean.closest('[role="menu"]')).toBe(clearDone.closest('[role="menu"]'));
  });

  it('names them as the redesign does, with the ellipsis of an action that asks first', () => {
    const { getByTestId } = render(QueueControls, { props: props() });

    const clearDone = getByTestId('dashboard-queue-clear-done');
    const clean = getByTestId('dashboard-queue-clean');
    expect(clearDone.textContent).toBe('Clear completed tasks…');
    expect(clean.textContent).toBe('Clear everything…');
    expect(clean.classList.contains('danger')).toBe(true);
    const menu = clearDone.closest('[role="menu"]') as HTMLElement | null;
    expect(menu).not.toBeNull();
    expect(
      [...menu!.children].map((el) => (el.tagName === 'HR' ? 'hr' : el.getAttribute('data-testid')))
    ).toEqual(['dashboard-queue-clear-done', 'hr', 'dashboard-queue-clean']);
  });

  it('hands a chosen item to the caller’s handler', async () => {
    const onClearDone = vi.fn();
    const onClean = vi.fn();
    const { getByTestId } = render(QueueControls, { props: props({ onClearDone, onClean }) });

    await fireEvent.click(getByTestId('dashboard-queue-clear-done'));
    await fireEvent.click(getByTestId('dashboard-queue-clean'));

    expect(onClearDone).toHaveBeenCalledTimes(1);
    expect(onClean).toHaveBeenCalledTimes(1);
  });
});

describe('QueueControls — the queue’s next step', () => {
  it('draws Pause as a secondary button with the pause icon', () => {
    const { getByTestId } = render(QueueControls, { props: props({ hasInFlight: true }) });
    const action = getByTestId('dashboard-queue-action');

    expect(action.classList.contains('btn-secondary')).toBe(true);
    expect(action.querySelector('use')?.getAttribute('href')).toBe('#i-pause');
  });

  it('draws Start Queue and Resume with the play icon, leaving the page its one primary action', () => {
    const start = render(QueueControls, { props: props({ pendingCount: 2 }) }).getByTestId('dashboard-queue-action');
    expect(start.classList.contains('btn-primary')).toBe(false);
    expect(start.querySelector('use')?.getAttribute('href')).toBe('#i-play');
    cleanup();

    const resume = render(QueueControls, { props: props({ paused: true }) }).getByTestId('dashboard-queue-action');
    expect(resume.classList.contains('btn-primary')).toBe(false);
    expect(resume.querySelector('use')?.getAttribute('href')).toBe('#i-play');
  });
});
