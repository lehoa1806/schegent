// Feature 031 T046 — Svelte component tests for WakeupSessionLogPathDisplay.svelte.
//
// The path display is a small strip rendered inside the wake-up settings
// tab (between the model dropdown and the "View recent runs" log list).
// It shows the absolute on-disk path of the wake-up session.log file —
// `<globalStorageUri>/wakeup/session.log` — sourced from the host
// projection at `snapshot.wakeUp.sessionLogPath`, and offers a "Reveal in
// OS file manager" button that posts a typed read-only IPC. Coverage:
//
//   (a) The displayed path comes from `snapshot.wakeUp.sessionLogPath`
//       and is rendered via `{text}` only — never via `{@html}`. The
//       repo-wide lint regression at
//       `tests/lint/no-html-interpolation-in-activity-feed.test.ts`
//       scans this directory.
//   (b) The "Reveal in OS file manager" button calls the shared helper
//       from `webview-ui/src/lib/reveal-wakeup-session-log.ts`. The
//       webview NEVER sends the path back to the host as a payload —
//       the host re-derives it.
//   (c) When `snapshot.wakeUp.sessionLogPath` is `null` (host did not
//       provision yet), the display surfaces a graceful empty state and
//       disables the Reveal button.
//   (d) The button is disabled while a reveal IPC is in-flight.
//
// The reveal helper is mocked. The component MUST NOT import the IPC
// constant directly; the lint regression at
// `tests/lint/no-inline-reveal-wakeup-session-log.test.ts` pins the
// allowlist of registered importers (this test file is NOT a registered
// importer of the constant).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import WakeupSessionLogPathDisplay from '../WakeupSessionLogPathDisplay.svelte';

type RevealResult =
  | { readonly status: 'success' }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'not-primary-host'
        | 'session-log-unavailable'
        | 'reveal-failed'
        | 'timeout'
        | 'unknown-error';
    };

const revealSpy = vi.fn<() => Promise<RevealResult>>();

vi.mock('../../../../lib/reveal-wakeup-session-log', () => ({
  revealWakeupSessionLog: () => revealSpy()
}));

const SAMPLE_PATH = '/Users/op/Library/Application Support/Code/User/globalStorage/schegent.schegent/wakeup/session.log';

beforeEach(() => {
  revealSpy.mockReset();
});

afterEach(() => cleanup());

describe('Feature 031 T046 — WakeupSessionLogPathDisplay path rendering', () => {
  it('renders the path from snapshot.wakeUp.sessionLogPath via {text}', () => {
    const { getByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: SAMPLE_PATH }
    });

    const pathEl = getByTestId('wakeup-session-log-path');
    expect(pathEl.textContent ?? '').toContain(SAMPLE_PATH);
  });

  it('shows a graceful empty state when sessionLogPath is null', () => {
    const { getByTestId, queryByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: null }
    });

    expect(getByTestId('wakeup-session-log-path-empty')).toBeTruthy();
    // The path element is NOT present in the empty state.
    expect(queryByTestId('wakeup-session-log-path')).toBeNull();
  });

  it('does not render raw HTML — operator-influenced strings remain text', () => {
    // Even though the host re-derives the path (so this is unlikely in
    // practice), confirm that a value containing markup is rendered as
    // text — the {text} discipline is the SINGLE bug-prevention layer.
    const pathWithMarkup = '/tmp/<script>alert(1)</script>/session.log';
    const { getByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: pathWithMarkup }
    });
    const pathEl = getByTestId('wakeup-session-log-path');
    // The text content includes the literal angle brackets.
    expect(pathEl.textContent ?? '').toContain('<script>');
    // No script element was injected.
    expect(pathEl.querySelector('script')).toBeNull();
  });
});

describe('Feature 031 T046 — WakeupSessionLogPathDisplay reveal button', () => {
  it('calls the reveal helper exactly once when the button is clicked', async () => {
    revealSpy.mockResolvedValue({ status: 'success' });

    const { getByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: SAMPLE_PATH }
    });

    const button = getByTestId('wakeup-session-log-reveal-button');
    await fireEvent.click(button);

    await waitFor(() => {
      expect(revealSpy).toHaveBeenCalledTimes(1);
    });
    // The helper takes NO arguments — the path is NEVER sent webview→host.
    expect(revealSpy).toHaveBeenCalledWith();
  });

  it('disables the reveal button when sessionLogPath is null', () => {
    const { queryByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: null }
    });
    // The button MUST be either absent or disabled. We accept either
    // discipline so long as the operator cannot trigger the IPC.
    const button = queryByTestId('wakeup-session-log-reveal-button');
    if (button !== null) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('disables the reveal button while an IPC is in-flight', async () => {
    // Promise that never resolves so we can observe the in-flight state.
    revealSpy.mockReturnValue(new Promise<never>(() => {}));

    const { getByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: SAMPLE_PATH }
    });

    const button = getByTestId('wakeup-session-log-reveal-button') as HTMLButtonElement;
    await fireEvent.click(button);
    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });
  });

  it('surfaces a rejection reason inline without crashing', async () => {
    revealSpy.mockResolvedValue({
      status: 'rejected',
      reason: 'session-log-unavailable'
    });

    const { getByTestId, findByTestId } = render(WakeupSessionLogPathDisplay, {
      props: { sessionLogPath: SAMPLE_PATH }
    });

    const button = getByTestId('wakeup-session-log-reveal-button');
    await fireEvent.click(button);

    const error = await findByTestId('wakeup-session-log-reveal-error');
    expect(error.textContent ?? '').toContain('session-log-unavailable');
  });

  it('clears the rejection error when the operator retries successfully', async () => {
    revealSpy.mockResolvedValueOnce({
      status: 'rejected',
      reason: 'reveal-failed'
    });
    revealSpy.mockResolvedValueOnce({ status: 'success' });

    const { getByTestId, findByTestId, queryByTestId } = render(
      WakeupSessionLogPathDisplay,
      { props: { sessionLogPath: SAMPLE_PATH } }
    );

    const button = getByTestId('wakeup-session-log-reveal-button');
    await fireEvent.click(button);

    // First attempt fails — error visible.
    await findByTestId('wakeup-session-log-reveal-error');

    await fireEvent.click(button);
    // Wait for the second resolution to clear the error state.
    await waitFor(() => {
      expect(queryByTestId('wakeup-session-log-reveal-error')).toBeNull();
    });
  });
});
