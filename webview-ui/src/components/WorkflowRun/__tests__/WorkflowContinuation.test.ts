// FR-R4-F05 (T17, T120; contract I, I5 to I8; contract O, O3, O4) — a continuation whose wait ran out.
//
// WHY. The continuation form had its own 30 s outer timer, which restored the form with "Nothing was
// started" and then ignored the host's answer. The host may still start the node, so that message was
// a claim nobody had made, and the answer it dropped was the only evidence of what happened. The timer
// is gone: the wait is the ledger's 5 s (resolved by the IPC module as `not-yet-known`), the text says
// the outcome is not yet known, the late outcome replaces it once, and unmount aborts the wait.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_DEFINITION } from '../../Runs/__tests__/launch-fixture';

const continueWorkflow = vi.fn();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: (...args: readonly unknown[]) => continueWorkflow(...args),
  launchWorkflow: vi.fn()
}));

// Late import so the form binds to the stub above.
import WorkflowContinuation from '../WorkflowContinuation.svelte';

afterEach(() => {
  cleanup();
  continueWorkflow.mockReset();
});

const NOT_YET_KNOWN = 'The host has not answered yet, so the outcome is not yet known.';

function mountContinuation(onResult?: (result: unknown) => void) {
  return render(WorkflowContinuation, {
    props: {
      connectedRunId: 'cr-1',
      expectedRevision: 3,
      node: { nodeId: 'n-ship' } as never,
      pipeline: REVIEW_DEFINITION,
      ...(onResult === undefined ? {} : { onResult })
    }
  });
}

function lastOptions(): { signal?: AbortSignal; onLateOutcome?: (result: unknown) => void } {
  const call = continueWorkflow.mock.calls.at(-1) as unknown[] | undefined;
  return (call?.[1] ?? {}) as { signal?: AbortSignal; onLateOutcome?: (result: unknown) => void };
}

async function submit(view: ReturnType<typeof mountContinuation>) {
  await fireEvent.click(view.getByTestId('workflow-continuation-submit'));
}

describe('a continuation whose wait ran out (T120; FR-024, FR-026)', () => {
  it('says the outcome is not yet known, and re-enables the form', async () => {
    continueWorkflow.mockResolvedValueOnce({ outcome: 'not-yet-known' });
    const view = mountContinuation();

    await submit(view);
    await fireEvent.input(view.getByTestId('run-input-draft'), { target: { value: 'x' } });

    const status = view.getByTestId('workflow-continuation-status').textContent;
    expect(status).toContain(NOT_YET_KNOWN);
    expect(status).not.toContain('Nothing was started');
    expect(status).not.toContain('30 seconds');
    expect((view.getByTestId('workflow-continuation-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not report a not-yet-known outcome to the parent as a result', async () => {
    const onResult = vi.fn();
    continueWorkflow.mockResolvedValueOnce({ outcome: 'not-yet-known' });
    const view = mountContinuation(onResult);

    await submit(view);

    expect(onResult).not.toHaveBeenCalled();
  });

  it('starts no 30 s timer of its own', async () => {
    vi.useFakeTimers();
    try {
      continueWorkflow.mockImplementation(() => new Promise(() => {}));
      const view = mountContinuation();

      await submit(view);
      const before = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(before).toBe(0);
      expect((view.getByTestId('workflow-continuation-submit') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the not-yet-known text with the late outcome, and tells the parent once', async () => {
    const onResult = vi.fn();
    continueWorkflow.mockResolvedValueOnce({ outcome: 'not-yet-known' });
    const view = mountContinuation(onResult);
    await submit(view);
    expect(view.getByTestId('workflow-continuation-status').textContent).toContain(NOT_YET_KNOWN);

    lastOptions().onLateOutcome!({ outcome: 'started', queueItemId: 'qi-late' });
    await fireEvent.input(view.getByTestId('run-input-draft'), { target: { value: 'y' } });

    const status = view.getByTestId('workflow-continuation-status').textContent;
    expect(status).toContain('Started as qi-late.');
    expect(status).not.toContain(NOT_YET_KNOWN);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('aborts its wait when the form unmounts', async () => {
    continueWorkflow.mockImplementation(() => new Promise(() => {}));
    const view = mountContinuation();
    await submit(view);
    expect(lastOptions().signal!.aborted).toBe(false);

    view.unmount();

    expect(lastOptions().signal!.aborted).toBe(true);
  });
});
