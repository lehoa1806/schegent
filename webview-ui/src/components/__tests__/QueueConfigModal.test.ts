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
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeIntentLedger } from '../../lib/intent-ledger';

// FR-R4-F05 (I4) — a command sent through the intent ledger carries the ledger's identity as
// the third argument of `postCommand`; the payload assertions below stay exact.
const LEDGER_IDENTITY = expect.objectContaining({ correlationId: expect.any(String) });

import QueueConfigModal from '../QueueConfigModal.svelte';
import { CMD_ACK, CMD_SAVE_QUEUE_SETTINGS } from '../../lib/messages';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { QueueRuntime, QueueSettingsProjection } from '../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn((...args: readonly unknown[]) => ({
  // FR-R4-F05 (I4) — honours the identity the intent ledger supplies, as the real `postCommand` does.
  correlationId:
    (args[2] as { correlationId?: string } | undefined)?.correlationId ??
    `corr-${++nextCorrelationId}`
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
  // The ledger is module state: an unsettled intent from one case would be reused by the next.
  disposeIntentLedger();
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
    }, LEDGER_IDENTITY);
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
    }, LEDGER_IDENTITY);
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

// FR-R4-F08 (K-T3 to K-T5; FR-022, FR-023) — the Queue Configuration dialog from the keyboard.
//
// The dialog is modal, but only Escape was wired: Tab left it for whatever was behind it, and
// closing it from a gone opener lost focus. The trap here reads its focusable set at each
// keypress, because this dialog's set changes while it is open (a queue added to `queues` adds a
// select; Save's `disabled` state removes the last stop). The boundary element is focused before
// the key is dispatched, as the ConfirmDialog cases do.
describe('FR-R4-F08 K-T3 — focus starts on the cap input and Tab wraps at the ends', () => {
  async function tabFrom(element: HTMLElement, shiftKey = false): Promise<KeyboardEvent> {
    element.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await tick();
    return event;
  }

  it('puts the initial focus on the cap input', async () => {
    const { getByTestId } = mount();
    await tick();
    await tick();
    expect(document.activeElement).toBe(getByTestId('queue-config-cap'));
  });

  it('Tab on Save goes to the cap input, and Shift+Tab on the cap input goes to Save', async () => {
    const { getByTestId } = mount();
    await tick();
    const save = getByTestId('queue-config-save');
    const cap = getByTestId('queue-config-cap');

    const forward = await tabFrom(save);
    expect(forward.defaultPrevented, 'a boundary Tab is prevented').toBe(true);
    expect(document.activeElement).toBe(cap);

    const backward = await tabFrom(cap, true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(save);
  });

  it('does not prevent a Tab that is not at a boundary', async () => {
    const { getByTestId } = mount();
    await tick();
    const middle = await tabFrom(getByTestId('queue-config-default-queue'));
    expect(middle.defaultPrevented, 'the browser moves focus between inner stops').toBe(false);
    const cancel = await tabFrom(getByTestId('queue-config-cancel'));
    expect(cancel.defaultPrevented, 'Cancel is not the last stop while Save is enabled').toBe(false);
  });
});

describe('FR-R4-F08 K-T4 — the trap follows the live focusable set', () => {
  async function tabFrom(element: HTMLElement | null, shiftKey = false): Promise<KeyboardEvent> {
    if (element !== null) element.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await tick();
    return event;
  }

  it('with Save disabled, Tab on Cancel wraps to the first element', async () => {
    const { getByTestId } = mount();
    await tick();
    // Save disables itself while a write is in flight (`busy`); a click leaves it pending.
    await fireEvent.click(getByTestId('queue-config-save'));
    const save = getByTestId('queue-config-save') as HTMLButtonElement;
    expect(save.disabled, 'the control: Save is disabled while the write is pending').toBe(true);

    const event = await tabFrom(getByTestId('queue-config-cancel'));
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(getByTestId('queue-config-cap'));
  });

  it('a queue added while the dialog is open puts its select in the cycle', async () => {
    const view = mount();
    await tick();
    const policySelect = (id: string) => view.queryByTestId(`queue-failure-policy-select-${id}`);
    expect(policySelect('q-new'), 'the control: the new queue has no select yet').toBeNull();

    await view.rerender({
      queueSettings: SETTINGS,
      queues: [...QUEUES, buildQueueRuntime({ queueId: 'q-new', name: 'Late Lane', position: 3 })],
      onClose: () => {}
    });
    const added = policySelect('q-new');
    expect(added, 'the new queue\'s select is rendered').not.toBeNull();

    // Tab from the select just before Save is not a boundary; from Save it still wraps.
    const lastBeforeSave = await tabFrom(added as HTMLElement);
    expect(lastBeforeSave.defaultPrevented, 'the added select is an inner stop').toBe(false);
    const wrap = await tabFrom(view.getByTestId('queue-config-save'));
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.getByTestId('queue-config-cap'));
  });

  it('focus outside the dialog is pulled in: Tab to the first element, Shift+Tab to the last', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      const { getByTestId } = mount();
      await tick();
      const forward = await tabFrom(outside);
      expect(forward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(getByTestId('queue-config-cap'));

      const backward = await tabFrom(outside, true);
      expect(backward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(getByTestId('queue-config-save'));
    } finally {
      outside.remove();
    }
  });
});

describe('FR-R4-F08 K-T5 — where focus goes when the dialog closes', () => {
  function mountWith(extra: {
    originatingElement?: HTMLElement | null;
    fallbackFocusElement?: HTMLElement | null;
    onClose?: () => void;
  }) {
    return render(QueueConfigModal, {
      props: { queueSettings: SETTINGS, queues: QUEUES, onClose: () => {}, ...extra }
    });
  }

  function attachButton(label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = label;
    document.body.appendChild(button);
    return button;
  }

  it('Escape and Cancel close, and a connected opener gets focus back', async () => {
    const opener = attachButton('opener');
    try {
      let closed = 0;
      const { getByTestId, unmount } = mountWith({ originatingElement: opener, onClose: () => (closed += 1) });
      await tick();
      await fireEvent.keyDown(window, { key: 'Escape' });
      await fireEvent.click(getByTestId('queue-config-cancel'));
      expect(closed, 'Escape and Cancel each close').toBe(2);
      unmount();
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  it('a detached opener sends focus to the fallback element', async () => {
    const opener = attachButton('opener');
    const fallback = attachButton('fallback');
    try {
      const { unmount } = mountWith({ originatingElement: opener, fallbackFocusElement: fallback });
      await tick();
      opener.remove();
      unmount();
      expect(document.activeElement).toBe(fallback);
    } finally {
      fallback.remove();
    }
  });

  it('with both absent nothing throws and nothing is focused on purpose', async () => {
    const { unmount } = mountWith({ originatingElement: null, fallbackFocusElement: null });
    await tick();
    expect(() => unmount()).not.toThrow();
  });
});
