// Feature 065 (T022, revised per BUG-001 / 2026-05-23) — Component
// coverage for the simplified StartModeChooser.svelte.
//
// The chooser is now reached exclusively via the queue-level "Start
// queue" affordance against an idle-pending queue (FR-018). It is never
// presented at task-submit time. The component therefore:
//   - has no `mode` prop (only the queue-level variant remains)
//   - has no `taskDescription` prop (does not own the draft)
//   - has no `onDiscard` callback or "Cancel and discard" affordance
//   - does not import `useConfirm` (no destructive-confirm path)
//   - always emits `StartQueueIntent` with `source: 'operator-restart'`
//
// Coverage map:
//   (1) chooser renders inline (NOT modal)
//   (2) Start now → commit({ startMode: 'now', source: 'operator-restart' })
//   (3) Start in 01:00 → commit(scheduled, scheduledStartAt ≈ now + 1h ±1s)
//   (4) Start in 00:00 → commit({ startMode: 'now', source: 'operator-restart' })
//   (5) Start at HH:MM with future clock time → future scheduledStartAt
//   (6) Horizon: 168:01 entry → inline error, no commit
//   (7) Cancel schedule → commit({ startMode: 'cancel-schedule', source: 'operator-restart' })
//   (8) Close → commit(null) without follow-up
//   (9) Non-modal: sibling clicks NOT swallowed; no backdrop; no focus capture

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import StartModeChooser from '../StartModeChooser.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderChooser(overrides: Record<string, unknown> = {}) {
  const onCommit = vi.fn();
  const result = render(StartModeChooser, {
    props: {
      onCommit,
      ...overrides
    }
  });
  return { ...result, onCommit };
}

describe('StartModeChooser — render', () => {
  it('renders inline (no role=dialog, no aria-modal backdrop)', () => {
    const { getByTestId } = renderChooser();
    const chooser = getByTestId('start-mode-chooser');
    expect(chooser).toBeTruthy();
    expect(chooser.getAttribute('role')).toBe('group');
    expect(chooser.getAttribute('aria-modal')).toBeNull();
    // No backdrop element in the DOM.
    expect(document.querySelector('.confirm-dialog-backdrop')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the three primary affordances plus cancel and close', () => {
    const { getByTestId } = renderChooser();
    expect(getByTestId('start-mode-chooser-now')).toBeTruthy();
    expect(getByTestId('start-mode-chooser-in-duration-toggle')).toBeTruthy();
    expect(getByTestId('start-mode-chooser-at-clock-time-toggle')).toBeTruthy();
    expect(getByTestId('start-mode-chooser-cancel-schedule')).toBeTruthy();
    expect(getByTestId('start-mode-chooser-restart-dismiss')).toBeTruthy();
  });

  it('does NOT render a Cancel-and-discard destructive affordance', () => {
    const { queryByTestId } = renderChooser();
    expect(queryByTestId('start-mode-chooser-discard')).toBeNull();
  });

  it('does NOT render the empty-enqueue Dismiss affordance', () => {
    const { queryByTestId } = renderChooser();
    expect(queryByTestId('start-mode-chooser-dismiss')).toBeNull();
  });
});

describe('StartModeChooser — Start now', () => {
  it('emits commit with startMode=now and source=operator-restart', async () => {
    const { getByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-now'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual({
      startMode: 'now',
      source: 'operator-restart'
    });
  });
});

describe('StartModeChooser — Start in HH:MM', () => {
  it('emits commit with scheduledStartAt ≈ now + 1h for 01:00', async () => {
    const { getByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-in-duration-toggle'));
    const hoursInput = getByTestId('start-mode-chooser-in-duration-hours') as HTMLInputElement;
    const minutesInput = getByTestId('start-mode-chooser-in-duration-minutes') as HTMLInputElement;
    await fireEvent.input(hoursInput, { target: { value: '1' } });
    await fireEvent.input(minutesInput, { target: { value: '0' } });
    const before = Date.now();
    await fireEvent.click(getByTestId('start-mode-chooser-in-duration-confirm'));
    const after = Date.now();
    expect(onCommit).toHaveBeenCalledTimes(1);
    const intent = onCommit.mock.calls[0][0];
    expect(intent.startMode).toBe('scheduled');
    expect(intent.source).toBe('operator-restart');
    expect(intent.scheduledStartAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 60_000);
    expect(intent.scheduledStartAt).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 60_000);
  });

  it('collapses 00:00 to startMode=now (Edge Case)', async () => {
    const { getByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-in-duration-toggle'));
    const hoursInput = getByTestId('start-mode-chooser-in-duration-hours') as HTMLInputElement;
    const minutesInput = getByTestId('start-mode-chooser-in-duration-minutes') as HTMLInputElement;
    await fireEvent.input(hoursInput, { target: { value: '0' } });
    await fireEvent.input(minutesInput, { target: { value: '0' } });
    await fireEvent.click(getByTestId('start-mode-chooser-in-duration-confirm'));
    expect(onCommit.mock.calls[0][0]).toEqual({
      startMode: 'now',
      source: 'operator-restart'
    });
  });

  it('shows inline horizon error for 168:01 and does NOT commit (FR-009c)', async () => {
    const { getByTestId, queryByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-in-duration-toggle'));
    const hoursInput = getByTestId('start-mode-chooser-in-duration-hours') as HTMLInputElement;
    const minutesInput = getByTestId('start-mode-chooser-in-duration-minutes') as HTMLInputElement;
    await fireEvent.input(hoursInput, { target: { value: '168' } });
    await fireEvent.input(minutesInput, { target: { value: '1' } });
    await fireEvent.click(getByTestId('start-mode-chooser-in-duration-confirm'));
    expect(onCommit).not.toHaveBeenCalled();
    const error = queryByTestId('start-mode-chooser-error');
    expect(error).toBeTruthy();
    expect(error!.textContent).toMatch(/7-day/i);
  });
});

describe('StartModeChooser — Start at HH:MM (clock time)', () => {
  it('resolves a clock time to a future scheduledStartAt', async () => {
    const { getByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-at-clock-time-toggle'));
    const hoursInput = getByTestId('start-mode-chooser-at-clock-time-hours') as HTMLInputElement;
    const minutesInput = getByTestId('start-mode-chooser-at-clock-time-minutes') as HTMLInputElement;
    // Pick an hour 2 hours from now to ensure it's in the future today.
    const target = (new Date().getHours() + 2) % 24;
    await fireEvent.input(hoursInput, { target: { value: String(target) } });
    await fireEvent.input(minutesInput, { target: { value: '0' } });
    await fireEvent.click(getByTestId('start-mode-chooser-at-clock-time-confirm'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const intent = onCommit.mock.calls[0][0];
    expect(intent.startMode).toBe('scheduled');
    expect(intent.source).toBe('operator-restart');
    expect(intent.scheduledStartAt).toBeGreaterThan(Date.now());
  });
});

describe('StartModeChooser — Cancel schedule', () => {
  it('emits cancel-schedule intent with source=operator-restart', async () => {
    const { getByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-cancel-schedule'));
    expect(onCommit).toHaveBeenCalledWith({
      startMode: 'cancel-schedule',
      source: 'operator-restart'
    });
  });
});

describe('StartModeChooser — Close', () => {
  it('emits commit(null) without committing a schedule', async () => {
    const { getByTestId, onCommit } = renderChooser();
    await fireEvent.click(getByTestId('start-mode-chooser-restart-dismiss'));
    expect(onCommit).toHaveBeenCalledWith(null);
  });
});

describe('StartModeChooser — non-modal property (FR-009a)', () => {
  it('sibling click is NOT swallowed; chooser remains mounted', async () => {
    const siblingHandler = vi.fn();
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<button id="sibling-control" data-testid="sibling-control">sibling</button>'
    );
    const siblingEl = document.getElementById('sibling-control')!;
    siblingEl.addEventListener('click', siblingHandler);

    const { getByTestId } = renderChooser();
    expect(getByTestId('start-mode-chooser')).toBeTruthy();

    await fireEvent.click(siblingEl);

    expect(siblingHandler).toHaveBeenCalledTimes(1);
    // Chooser still mounted (non-modal).
    expect(getByTestId('start-mode-chooser')).toBeTruthy();
    siblingEl.remove();
  });
});
