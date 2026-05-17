// Feature 031 T031 — Svelte component tests for WakeupSessionLogPanel.svelte.
//
// The panel renders the sanitized 32 KB-capped session-log body for a
// single wake-up invocation. It mounts inline beneath the expanded row
// in WakeUpTab.svelte. Coverage:
//
//   (a) Loading state: while the IPC is pending, a `wakeup-session-log-loading`
//       spinner/status element is visible.
//   (b) Success: when the helper resolves with `status: 'success'`, the
//       panel renders the `body` string via `{text}` only (the
//       `no-html-interpolation-in-activity-feed` lint catches `{@html}`)
//       and the body's `OUT:` / `ERR:` prefixes are preserved verbatim.
//   (c) Truncation affordance: when `bodyTruncated === true`, the panel
//       shows a "truncated — see on-disk file" hint with the
//       `fullBlockBytesOnDisk` count.
//   (d) Rejection — invalid-correlation-id: the panel surfaces a closed-
//       vocabulary rejection (rendered through human-readable copy).
//   (e) Rejection — unknown-correlation-id: the panel surfaces the
//       "no session log available" empty state.
//   (f) Rejection — session-log-unavailable: the panel surfaces the
//       "session log not yet provisioned" empty state.
//   (g) Timeout: the panel surfaces a retryable timeout state.
//   (h) The IPC is invoked exactly once on mount (mount-to-resolution
//       lifecycle; no auto-retry loop).
//
// The helper is mocked. The component MUST NOT import the IPC constant
// directly — only the helper. The lint regression at
// `tests/lint/no-inline-read-wakeup-session-log.test.ts` pins the
// allowlist; this test file is NOT a registered importer of the
// constant.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import WakeupSessionLogPanel from '../WakeupSessionLogPanel.svelte';

type ReadResult =
  | {
      readonly status: 'success';
      readonly correlationId: string;
      readonly capturedAtMs: number;
      readonly trigger: 'scheduled' | 'manual';
      readonly model: string;
      readonly outcome: 'succeeded' | 'failed';
      readonly body: string;
      readonly bodyTruncated: boolean;
      readonly fullBlockBytesOnDisk: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'not-primary-host'
        | 'invalid-correlation-id'
        | 'unknown-correlation-id'
        | 'session-log-unavailable'
        | 'unknown-error'
        | 'timeout';
    };

const readSpy = vi.fn<[string], Promise<ReadResult>>();

vi.mock('../../../../lib/wakeup-session-log-ipc', () => ({
  readWakeupSessionLog: (correlationId: string) => readSpy(correlationId)
}));

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  readSpy.mockReset();
});

afterEach(() => cleanup());

describe('Feature 031 T031 — WakeupSessionLogPanel mounting and IPC lifecycle', () => {
  it('invokes the helper exactly once on mount with the provided correlationId', async () => {
    readSpy.mockResolvedValue({
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'runner-default',
      outcome: 'succeeded',
      body: 'OUT: ok\n',
      bodyTruncated: false,
      fullBlockBytesOnDisk: 8
    });

    render(WakeupSessionLogPanel, { props: { correlationId: VALID_UUID } });

    await waitFor(() => {
      expect(readSpy).toHaveBeenCalledTimes(1);
    });
    expect(readSpy).toHaveBeenCalledWith(VALID_UUID);
  });

  it('shows a loading state while the IPC is pending', () => {
    // Returned promise that never resolves — pin the loading branch.
    readSpy.mockReturnValue(new Promise<never>(() => {}));

    const { getByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    expect(getByTestId('wakeup-session-log-loading')).toBeTruthy();
  });
});

describe('Feature 031 T031 — WakeupSessionLogPanel success rendering', () => {
  it('renders the body verbatim and preserves OUT:/ERR: stream prefixes', async () => {
    readSpy.mockResolvedValue({
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'claude-sonnet-4-6',
      outcome: 'succeeded',
      body: 'OUT: first line\nERR: warn line\nOUT: trailing\n',
      bodyTruncated: false,
      fullBlockBytesOnDisk: 44
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    const body = await findByTestId('wakeup-session-log-body');
    const text = body.textContent ?? '';
    expect(text).toContain('OUT: first line');
    expect(text).toContain('ERR: warn line');
    expect(text).toContain('OUT: trailing');
  });

  it('shows the truncated affordance with the full on-disk byte count when bodyTruncated is true', async () => {
    readSpy.mockResolvedValue({
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'claude-sonnet-4-6',
      outcome: 'succeeded',
      body: 'OUT: long body...\n',
      bodyTruncated: true,
      fullBlockBytesOnDisk: 70000
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    const truncatedHint = await findByTestId('wakeup-session-log-truncated');
    const text = truncatedHint.textContent ?? '';
    // Surface the on-disk byte count so the operator knows the
    // projection is intentionally clipped at 32 KB.
    expect(text).toContain('70000');
  });

  it('does NOT show the truncated affordance when bodyTruncated is false', async () => {
    readSpy.mockResolvedValue({
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'claude-opus-4-7',
      outcome: 'succeeded',
      body: 'OUT: complete\n',
      bodyTruncated: false,
      fullBlockBytesOnDisk: 14
    });

    const { findByTestId, queryByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    // Wait for resolution before asserting the absence of the truncated
    // affordance — otherwise the loading state can satisfy the query.
    await findByTestId('wakeup-session-log-body');
    expect(queryByTestId('wakeup-session-log-truncated')).toBeNull();
  });
});

describe('Feature 031 T031 — WakeupSessionLogPanel rejection handling', () => {
  it('surfaces the unknown-correlation-id reason as a "no session log available" empty state', async () => {
    readSpy.mockResolvedValue({
      status: 'rejected',
      reason: 'unknown-correlation-id'
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    const empty = await findByTestId('wakeup-session-log-empty');
    expect(empty.textContent ?? '').toMatch(/no session log/i);
  });

  it('surfaces the session-log-unavailable reason', async () => {
    readSpy.mockResolvedValue({
      status: 'rejected',
      reason: 'session-log-unavailable'
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    const status = await findByTestId('wakeup-session-log-error');
    const text = status.textContent ?? '';
    expect(text).toMatch(/session log/i);
  });

  it('surfaces the invalid-correlation-id reason', async () => {
    readSpy.mockResolvedValue({
      status: 'rejected',
      reason: 'invalid-correlation-id'
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: 'NOT-A-UUID' }
    });

    const status = await findByTestId('wakeup-session-log-error');
    expect(status.textContent ?? '').toContain('invalid-correlation-id');
  });

  it('surfaces the timeout reason', async () => {
    readSpy.mockResolvedValue({
      status: 'rejected',
      reason: 'timeout'
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    const status = await findByTestId('wakeup-session-log-error');
    expect(status.textContent ?? '').toContain('timeout');
  });

  it('surfaces a not-primary-host rejection', async () => {
    readSpy.mockResolvedValue({
      status: 'rejected',
      reason: 'not-primary-host'
    });

    const { findByTestId } = render(WakeupSessionLogPanel, {
      props: { correlationId: VALID_UUID }
    });

    const status = await findByTestId('wakeup-session-log-error');
    expect(status.textContent ?? '').toContain('not-primary-host');
  });
});
