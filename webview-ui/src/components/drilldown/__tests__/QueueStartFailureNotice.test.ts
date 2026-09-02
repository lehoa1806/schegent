// Feature 187 (T021, FR-001, FR-002, SC-001, SC-002) — the notice that turns a
// step-7 admission throw from a log line into something on screen.
//
// The two assertions that carry the feature are the wording ones. An operator
// looking at a stalled queue is asking two questions the sidebar could not
// answer before: *did something fail*, and *was it my resume or a fresh start*.
// `admitNew` and `admitResume` are host method names, so a notice that printed
// them verbatim would answer the second question only for someone who has read
// the drain. The cases below pin operator words instead.

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import QueueStartFailureNotice from '../QueueStartFailureNotice.svelte';
import type { QueueRuntime } from '../../../lib/snapshot-types';

/** Fixed so the relative age is an assertion and not a race against the clock. */
const NOW = Date.parse('2026-09-02T10:35:00.000Z');

function failure(
  overrides: Partial<NonNullable<QueueRuntime['startFailure']>> = {}
): NonNullable<QueueRuntime['startFailure']> {
  return {
    admission: 'admitNew',
    at: '2026-09-02T10:30:00.000Z',
    summary: 'the backend refused the run',
    ...overrides
  };
}

afterEach(() => cleanup());

describe('QueueStartFailureNotice', () => {
  it('renders nothing at all when the queue has no failed start', () => {
    const { container } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: null, nowMs: NOW }
    });
    expect(container.querySelector('[data-testid="queue-start-failure-q-1"]')).toBeNull();
    expect(container.textContent.trim()).toBe('');
  });

  it('names a fresh start in operator words, not the host method name', () => {
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure({ admission: 'admitNew' }), nowMs: NOW }
    });
    const text = getByTestId('queue-start-failure-q-1').textContent;
    expect(text).toContain('Starting this queue failed');
    expect(text).not.toContain('admitNew');
  });

  it('names a resume attempt, so the operator knows which attempt failed', () => {
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure({ admission: 'admitResume' }), nowMs: NOW }
    });
    const text = getByTestId('queue-start-failure-q-1').textContent;
    expect(text).toContain('Resuming this queue failed');
    expect(text).not.toContain('admitResume');
  });

  it('shows how long ago the attempt failed', () => {
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure(), nowMs: NOW }
    });
    expect(getByTestId('queue-start-failure-age-q-1').textContent).toContain('5m ago');
  });

  it('shows the sanitized summary the host projected', () => {
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure({ summary: 'ENOENT: <path>' }), nowMs: NOW }
    });
    expect(getByTestId('queue-start-failure-summary-q-1').textContent).toContain('ENOENT: <path>');
  });

  it('states the absence of a summary rather than rendering an empty element', () => {
    // A blank line under a failure heading reads as a rendering bug. The report
    // exists either way — the start did fail — so the surface says what it has.
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure({ summary: null }), nowMs: NOW }
    });
    const summary = getByTestId('queue-start-failure-summary-q-1').textContent;
    expect(summary.trim().length).toBeGreaterThan(0);
  });

  it('says the queue will be offered again, which is what the drain actually does', () => {
    // SC-002: the report is not a dead end. The next terminal Run's sweep, an
    // operator start, or the next activation re-offers this queue, so the notice
    // must not read as "this queue is stuck until you do something".
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure(), nowMs: NOW }
    });
    const text = getByTestId('queue-start-failure-q-1').textContent;
    expect(text.toLowerCase()).toContain('again');
  });

  it('is announced, so an operator not watching the panel still hears it', () => {
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-1', startFailure: failure(), nowMs: NOW }
    });
    expect(getByTestId('queue-start-failure-q-1').getAttribute('role')).toBe('status');
  });

  it('scopes its test ids to the queue, so two queues cannot be confused', () => {
    const { getByTestId } = render(QueueStartFailureNotice, {
      props: { queueId: 'q-other', startFailure: failure(), nowMs: NOW }
    });
    expect(getByTestId('queue-start-failure-q-other')).toBeTruthy();
  });
});
