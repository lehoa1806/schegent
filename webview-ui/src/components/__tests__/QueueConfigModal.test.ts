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
import type { QueueRuntime, QueueSettingsProjection } from '../../lib/snapshot-types';

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
//
// FR-R3-145 (T1572) — this was a `GeneralSettings` spread over
// `IDLE_GENERAL_SETTINGS`, which is what let the defect through: the dialog
// prefilled from the CONFIGURATION projection and saved to the MEMENTO, so every
// test here passed while the operator's save read as lost. The prop is now the
// memento projection, and the same two distinctive values prove the prefill.
const SETTINGS: QueueSettingsProjection = Object.freeze({
  globalConcurrencyCap: 7,
  defaultQueueId: 'q-gamma'
});

function mount(overrides: Partial<QueueSettingsProjection> = {}) {
  return render(QueueConfigModal, {
    props: {
      queueSettings: { ...SETTINGS, ...overrides },
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
      props: { queueSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
    });

    await fireEvent.click(getByTestId('queue-config-save'));
    expect(closed).toBe(0);

    ack(0, 'accepted');
    await waitFor(() => expect(closed).toBe(1));
  });

  it('cancels without posting anything', async () => {
    let closed = 0;
    const { getByTestId } = render(QueueConfigModal, {
      props: { queueSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
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
      props: { queueSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
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
      props: { queueSettings: SETTINGS, queues: QUEUES, onClose: () => (closed += 1) }
    });

    await fireEvent.keyDown(window, { key: 'Escape' });

    expect(closed).toBe(1);
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

// FR-R3-124 (FR-003, T010) — the shared-tree consequence, at the point of decision.
//
// The sentence existed in four places before this feature and in none of them was
// it on screen while the number was being typed. Two properties, because the
// second is the one that is easy to ship broken: a paragraph next to a number
// input is not announced with the input, so without `aria-describedby` a screen
// reader user changes the cap having heard "Concurrent runs, 7" and nothing else.
describe('QueueConfigModal — the shared-tree disclosure', () => {
  it('states that concurrent Runs share one working tree and may conflict', () => {
    const { getByTestId } = mount();

    const disclosure = getByTestId('queue-config-cap-disclosure');
    expect(disclosure.textContent).toMatch(/share one working tree/i);
    expect(disclosure.textContent).toMatch(/conflict/i);
  });

  it('associates the disclosure with the cap input for assistive technology', () => {
    const { getByTestId } = mount();

    const input = getByTestId('queue-config-cap');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBe('queue-config-cap-shared-tree');
    // Resolved, not just asserted as a string: an id pointing at nothing reads to
    // assistive technology exactly like no id at all.
    expect(getByTestId('queue-config-cap-disclosure').id).toBe(describedBy);
  });
});

/**
 * FR-R3-130 (T1495) — what the cap will cost, said at the moment it is typed.
 *
 * The audit of 2026-08-27's point about the cap-20 ceiling was that an operator can
 * accept it without ever seeing it. Both directions are asserted, because a warning
 * that fires at the shipped default is furniture and furniture is what an operator
 * stops reading.
 */
describe('QueueConfigModal — the stream-pressure warning', () => {
  const GIB = 1024 * 1024 * 1024;

  function mountWithMemory(cap: number, machineMemoryBytes: number) {
    return render(QueueConfigModal, {
      props: {
        queueSettings: { ...SETTINGS, globalConcurrencyCap: cap },
        queues: QUEUES,
        machineMemoryBytes,
        onClose: () => {}
      }
    });
  }

  it('is silent at the shipped default', () => {
    const { queryByTestId } = mountWithMemory(1, 8 * GIB);
    expect(queryByTestId('queue-config-pressure-advice')).toBeNull();
  });

  it('warns when the cap projects past a quarter of machine memory', () => {
    const { getByTestId } = mountWithMemory(20, 8 * GIB);
    const advice = getByTestId('queue-config-pressure-advice');
    expect(advice.textContent).toMatch(/cap of 20/);
    expect(advice.textContent).toMatch(/% of this machine/);
    // The operator's next move is the record, and a warning that cannot be checked
    // gets dismissed.
    expect(advice.textContent).toMatch(/large-workspace-resource-measurement\.md/);
    // And it must say the cap is still allowed: this warns, it does not refuse.
    expect(advice.textContent).toMatch(/still permitted/);
  });

  it('is silent for the same cap on a machine with headroom', () => {
    // The threshold is machine-derived, which is the whole point.
    const { queryByTestId } = mountWithMemory(20, 128 * GIB);
    expect(queryByTestId('queue-config-pressure-advice')).toBeNull();
  });

  it('is silent when the machine did not answer', () => {
    const { queryByTestId } = mountWithMemory(20, 0);
    expect(queryByTestId('queue-config-pressure-advice')).toBeNull();
  });

  it('does not disable Save — it warns, it does not refuse', () => {
    // The cap's range is ratified; an operator on a large machine raising it is
    // making a legitimate choice, and a dialog that refused would be this component
    // overruling `local-queue-parallelism-ratification.md`.
    const { getByTestId } = mountWithMemory(20, 4 * GIB);
    expect(getByTestId('queue-config-pressure-advice')).toBeTruthy();
    expect((getByTestId('queue-config-save') as HTMLButtonElement).disabled).toBe(false);
  });
});
