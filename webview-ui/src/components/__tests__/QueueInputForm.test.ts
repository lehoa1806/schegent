// FR-R4-F05 (T17, T116; contract I, I5 to I8; contract O, O3, O4) — the dashboard's add-work form.
//
// WHY. `CMD_START` is gated and enqueues a task. The form disabled itself until the ack arrived and
// had no timer at all, so a host that never answered locked it for good; with the intent ledger it
// waits 5 s, says the outcome is NOT YET KNOWN (the host may still enqueue the task), lets the
// operator retry under the same identity, shows the host's late answer once, and removes its timer
// and listener when it unmounts.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueueInputForm from '../QueueInputForm.svelte';
import { disposeIntentLedger } from '../../lib/intent-ledger';
import { CMD_ACK, CMD_START } from '../../lib/messages';
import { snapshotStore } from '../../lib/snapshot-store.svelte';

const postCommandSpy = vi.fn(
  (_type: string, _payload?: unknown, opts?: { correlationId?: string }) => ({
    correlationId: opts?.correlationId ?? 'fallback'
  })
);
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (type: string, payload?: unknown, opts?: { correlationId?: string }) =>
    postCommandSpy(type, payload, opts)
}));

const NOT_YET_KNOWN = 'The host has not answered yet, so the outcome is not yet known.';
const PIPELINES = [{ id: 'standard', name: 'Standard', phases: ['speckit-specify'] }] as never;

beforeEach(() => {
  vi.useFakeTimers();
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
  disposeIntentLedger();
  vi.useRealTimers();
});

function mountForm() {
  return render(QueueInputForm, {
    props: { availablePipelines: PIPELINES, defaultPipelineId: 'standard', pendingCount: 0 }
  });
}

async function submitWork(view: ReturnType<typeof mountForm>, text = 'add a login page') {
  await fireEvent.input(view.getByTestId('dashboard-queue-input-textarea'), { target: { value: text } });
  await fireEvent.click(view.getByTestId('dashboard-queue-input-submit'));
}

function identityOf(callIndex: number): string {
  return postCommandSpy.mock.calls[callIndex]![2]!.correlationId!;
}

function answer(correlationId: string, status: 'accepted' | 'rejected', extra: object = {}): void {
  snapshotStore.apply({ type: CMD_ACK, correlationId, status, ...extra } as never);
}

describe('the add-work form waits for the host (T116)', () => {
  it('posts CMD_START and shows an on-time acceptance', async () => {
    const view = mountForm();

    await submitWork(view);
    answer(identityOf(0), 'accepted', { result: { outcome: 'enqueued', queueName: 'Default' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_START, expect.anything(), expect.anything());
    expect(view.getByTestId('dashboard-queue-input-feedback').textContent).toContain('Enqueued to Default');
  });

  it('shows the not-yet-known text at 5,000 ms, and re-enables the form for a retry', async () => {
    const view = mountForm();

    await submitWork(view);
    expect((view.getByTestId('dashboard-queue-input-submit') as HTMLButtonElement).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(view.getByTestId('dashboard-queue-input-feedback').textContent).toContain(NOT_YET_KNOWN);
    expect((view.getByTestId('dashboard-queue-input-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('retries under the same identity and payload, so the host adds the task once', async () => {
    const view = mountForm();

    await submitWork(view);
    await vi.advanceTimersByTimeAsync(5_000);
    await fireEvent.click(view.getByTestId('dashboard-queue-input-submit'));

    expect(postCommandSpy).toHaveBeenCalledTimes(2);
    expect(identityOf(1)).toBe(identityOf(0));
    expect(postCommandSpy.mock.calls[1]![1]).toEqual(postCommandSpy.mock.calls[0]![1]);
  });

  // FR-R4-F05 (FR-017) — the host's fixed storage-fault code is worded for the operator, never shown bare.
  it('shows a storage-fault rejection as its sentence, not the code', async () => {
    const view = mountForm();

    await submitWork(view);
    answer(identityOf(0), 'rejected', { reason: 'queue-state-unavailable' });
    await vi.advanceTimersByTimeAsync(0);

    const text = view.getByTestId('dashboard-queue-input-feedback').textContent;
    expect(text).toContain('The queue could not be read or saved.');
    expect(text).not.toContain('queue-state-unavailable');
  });

  it('replaces the not-yet-known text with the late outcome, once', async () => {
    const view = mountForm();

    await submitWork(view);
    await vi.advanceTimersByTimeAsync(5_000);
    answer(identityOf(0), 'rejected', { reason: 'untrusted-workspace' });
    await vi.advanceTimersByTimeAsync(0);

    const text = view.getByTestId('dashboard-queue-input-feedback').textContent;
    expect(text).toContain('The workspace is not trusted, so this action is unavailable.');
    expect(text).not.toContain(NOT_YET_KNOWN);
    expect(text).not.toContain('untrusted-workspace');

    answer(identityOf(0), 'rejected', { reason: 'something-else' });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.getByTestId('dashboard-queue-input-feedback').textContent).toBe(text);
  });

  it('leaves no timer behind when it unmounts before the ack, and shows nothing for a later ack', async () => {
    const view = mountForm();

    await submitWork(view);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(() => answer(identityOf(0), 'accepted')).not.toThrow();
  });
});
