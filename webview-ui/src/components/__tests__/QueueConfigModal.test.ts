// Feature 095 (T029, US3, FR-009 to FR-011) — the workspace queue settings.
//
// Four properties, each of which has a plausible-looking wrong implementation:
//
// 1. The prefill comes from the projection. The fixture deliberately carries a
//    cap of 7 and a default queue of `q-gamma` — neither is the idle default
//    (3 / `default`), so a modal that renders a constant fails rather than
//    happening to agree.
// 2. One command carries both values. Two posts would be two writes and a
//    half-applied settings change if the second is refused.
// 3. An out-of-range value reaches the host. FR-011 puts the range in the host
//    validator, so the webview must not pre-refuse 99 — it must post it and
//    render the refusal that comes back.
// 4. The default-queue options are the queues that exist. An id the registry
//    does not hold cannot be chosen, because the host would refuse it.
//
// Acks are driven through `snapshotStore.apply({type: CMD_ACK, …})` — the real
// store and the real `queue-control-ipc`, with only `postCommand` spied. Mocking
// the IPC module instead would make the payload assertions assert the mock.

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueueConfigModal from '../QueueConfigModal.svelte';
import { CMD_ACK, CMD_SAVE_QUEUE_SETTINGS } from '../../lib/messages';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import type { GeneralSettings, QueueRuntime } from '../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({
  correlationId: `corr-${++nextCorrelationId}`
}));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

const QUEUES: readonly QueueRuntime[] = Object.freeze([
  buildQueueRuntime({ queueId: 'q-gamma', name: 'Review Lane', position: 2 }),
  buildQueueRuntime({ queueId: 'default', name: 'Default', position: 0 }),
  buildQueueRuntime({ queueId: 'q-beta', name: 'nightly', position: 1 })
]);

// Neither value is the idle default, so a hard-coded prefill cannot pass.
const SETTINGS: GeneralSettings = Object.freeze({
  ...IDLE_GENERAL_SETTINGS,
  queueGlobalConcurrencyCap: 7,
  queueDefaultQueueId: 'q-gamma'
});

function mount(overrides: Partial<GeneralSettings> = {}) {
  return render(QueueConfigModal, {
    props: {
      generalSettings: { ...SETTINGS, ...overrides },
      queues: QUEUES,
      onClose: () => {}
    }
  });
}

function ack(callIndex: number, status: 'accepted' | 'rejected', reason?: string): void {
  const result = postCommandSpy.mock.results[callIndex];
  expect(result, `no post at index ${callIndex}`).toBeDefined();
  const { correlationId } = result!.value as { correlationId: string };
  snapshotStore.apply({
    type: CMD_ACK,
    correlationId,
    status,
    ...(reason !== undefined ? { reason } : {})
  } as never);
}

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('QueueConfigModal — prefilled from the projection (FR-009)', () => {
  it('shows the projected cap, not a constant', () => {
    const { getByTestId } = mount();

    expect((getByTestId('queue-config-cap') as HTMLInputElement).value).toBe('7');
  });

  it('shows the projected default queue, not the first option', () => {
    const { getByTestId } = mount();

    expect((getByTestId('queue-config-default-queue') as HTMLSelectElement).value).toBe('q-gamma');
  });

  it('offers exactly the queues that exist, in registry position order', () => {
    const { getByTestId } = mount();

    const select = getByTestId('queue-config-default-queue') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'default',
      'q-beta',
      'q-gamma'
    ]);
  });

  it('names each option by its queue name so the operator picks a queue, not an id', () => {
    const { getByTestId } = mount();

    const select = getByTestId('queue-config-default-queue') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent?.trim())).toEqual([
      'Default',
      'nightly',
      'Review Lane'
    ]);
  });
});

describe('QueueConfigModal — saving both values (FR-010)', () => {
  it('posts one command carrying both settings', async () => {
    const { getByTestId } = mount();

    await fireEvent.input(getByTestId('queue-config-cap'), { target: { value: '5' } });
    await fireEvent.change(getByTestId('queue-config-default-queue'), {
      target: { value: 'q-beta' }
    });
    await fireEvent.click(getByTestId('queue-config-save'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SAVE_QUEUE_SETTINGS, {
      globalConcurrencyCap: 5,
      defaultQueueId: 'q-beta'
    });
  });

  it('sends the cap as a number, not as the input element string', async () => {
    const { getByTestId } = mount();

    await fireEvent.input(getByTestId('queue-config-cap'), { target: { value: '12' } });
    await fireEvent.click(getByTestId('queue-config-save'));

    const [, payload] = postCommandSpy.mock.calls[0] as [string, { globalConcurrencyCap: unknown }];
    expect(payload.globalConcurrencyCap).toBe(12);
    expect(typeof payload.globalConcurrencyCap).toBe('number');
  });

  it('closes only once the host accepts', async () => {
    let closed = 0;
    const { getByTestId } = render(QueueConfigModal, {
      props: { generalSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
    });

    await fireEvent.click(getByTestId('queue-config-save'));
    expect(closed).toBe(0);

    ack(0, 'accepted');
    await waitFor(() => expect(closed).toBe(1));
  });

  it('cancels without posting anything', async () => {
    let closed = 0;
    const { getByTestId } = render(QueueConfigModal, {
      props: { generalSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
    });

    await fireEvent.click(getByTestId('queue-config-cancel'));

    expect(closed).toBe(1);
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

describe('QueueConfigModal — the host owns the range (FR-011)', () => {
  it('lets an out-of-range cap reach the host rather than pre-refusing it', async () => {
    const { getByTestId } = mount();

    await fireEvent.input(getByTestId('queue-config-cap'), { target: { value: '99' } });
    await fireEvent.click(getByTestId('queue-config-save'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SAVE_QUEUE_SETTINGS, {
      globalConcurrencyCap: 99,
      defaultQueueId: 'q-gamma'
    });
  });

  it('shows the refusal the host answers and stays open', async () => {
    let closed = 0;
    const { getByTestId, queryByTestId } = render(QueueConfigModal, {
      props: { generalSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
    });

    await fireEvent.input(getByTestId('queue-config-cap'), { target: { value: '99' } });
    await fireEvent.click(getByTestId('queue-config-save'));
    // `QueueManager.saveQueueSettings`'s code for a cap outside the accepted range.
    ack(0, 'rejected', 'invalid-concurrency-cap');

    await waitFor(() =>
      expect(queryByTestId('queue-config-refusal')?.textContent).toContain(
        'outside the range this setting accepts'
      )
    );
    expect(closed).toBe(0);
    expect(queryByTestId('queue-config-modal')).not.toBeNull();
  });

  it('carries the range only as an input hint, never as a submit-time rule', () => {
    const { getByTestId } = mount();

    const input = getByTestId('queue-config-cap') as HTMLInputElement;
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('20');
  });
});

describe('QueueConfigModal — dialog conventions', () => {
  it('is a modal dialog with an accessible name', () => {
    const { getByTestId } = mount();

    const dialog = getByTestId('queue-config-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('queue-config-title');
  });

  it('closes on Escape without posting', async () => {
    let closed = 0;
    render(QueueConfigModal, {
      props: { generalSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
    });

    await fireEvent.keyDown(window, { key: 'Escape' });

    expect(closed).toBe(1);
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});
