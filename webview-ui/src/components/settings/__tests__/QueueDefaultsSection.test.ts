// The Settings page's Queues section, as the redesign's settings page has it: "Runs at the same
// time" and "Default queue" as settings rows, then "When a task fails" as a table of the queues
// with each queue's behaviour in a select.
//
// Feature 095 (FR-009 to FR-011) and Feature 195 (FR-014, FR-018, FR-019), carried over from the
// Queue settings dialog this section replaces:
//
// 1. Both workspace values are prefilled from the projection, never from a constant (FR-009).
// 2. One command carries both values (FR-010); the cap travels as a number, and a value outside
//    the range still reaches the host, which answers with its refusal (FR-011).
// 3. Each queue offers all three failure choices, names what "the workspace default" currently
//    resolves to, and writes its own answer; a no-op reads as its own sentence (FR-019).
//
// And the page's one save model (Decision 21): an edit is a draft the page header counts, and
// nothing is written until the page's Save. Acks travel through `snapshotStore.apply`, the real
// store and the real IPC module, with only `postCommand` spied.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeIntentLedger } from '../../../lib/intent-ledger';

// FR-R4-F05 (I4) — a command sent through the intent ledger carries the ledger's identity as
// the third argument of `postCommand`; the payload assertions below stay exact.
const LEDGER_IDENTITY = expect.objectContaining({ correlationId: expect.any(String) });

import QueueDefaultsSection from '../QueueDefaultsSection.svelte';
import { SettingsPage } from '../settings-page.svelte';
import {
  CMD_ACK,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_QUEUE_FAILURE_POLICY
} from '../../../lib/messages';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { snapshotStore } from '../../../lib/snapshot-store.svelte';
import type {
  QueueRuntime,
  QueueSettingsProjection,
  QueueSummary,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn((...args: readonly unknown[]) => ({
  // FR-R4-F05 (I4) — honours the identity the intent ledger supplies, as the real `postCommand` does.
  correlationId:
    (args[2] as { correlationId?: string } | undefined)?.correlationId ??
    `corr-${++nextCorrelationId}`
}));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

// Out of position order on purpose: the rows and options must follow `position`.
const QUEUES: readonly QueueRuntime[] = Object.freeze([
  buildQueueRuntime({ queueId: 'q-gamma', name: 'Review Lane', position: 2 }),
  buildQueueRuntime({ queueId: 'default', name: 'Default', position: 0 }),
  buildQueueRuntime({ queueId: 'q-beta', name: 'nightly', position: 1 })
]);

// Neither value is the idle default (3 and `default`), so a prefill read from a constant, or
// from the configuration rather than the memento projection, fails here (FR-R3-145, T1572).
const SETTINGS: QueueSettingsProjection = Object.freeze({
  globalConcurrencyCap: 7,
  defaultQueueId: 'q-gamma'
});

function summary(overrides: Partial<QueueSummary> & { id: string }): QueueSummary {
  return Object.freeze({
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    position: overrides.position ?? 0,
    state: overrides.state ?? 'active',
    pauseSource: overrides.pauseSource ?? null,
    schedule: overrides.schedule ?? null,
    taskCount: overrides.taskCount ?? 0,
    failurePolicy: overrides.failurePolicy ?? 'halt-on-failure',
    failurePolicyOverride: overrides.failurePolicyOverride ?? null
  });
}

const SUMMARIES: readonly QueueSummary[] = Object.freeze([
  summary({ id: 'default', name: 'Default', position: 0 }),
  summary({ id: 'q-beta', name: 'nightly', position: 1 }),
  summary({ id: 'q-gamma', name: 'Review Lane', position: 2 })
]);

interface SnapshotOptions {
  readonly isPrimary?: boolean;
  readonly settings?: Partial<QueueSettingsProjection>;
  readonly summaries?: readonly QueueSummary[];
  readonly machineMemoryBytes?: number;
}

function snapshotWith(options: SnapshotOptions = {}): WorkflowSnapshot {
  return {
    isPrimary: options.isPrimary ?? true,
    queues: QUEUES,
    queue: { queues: options.summaries ?? SUMMARIES },
    queueSettings: { ...SETTINGS, ...options.settings },
    streamPressure: { machineMemoryBytes: options.machineMemoryBytes ?? 0 }
  } as unknown as WorkflowSnapshot;
}

function mount(options: SnapshotOptions = {}) {
  const page = new SettingsPage('queues');
  const view = render(QueueDefaultsSection, { props: { snapshot: snapshotWith(options), page } });
  const cap = view.getByTestId('queue-config-cap') as HTMLInputElement;
  const defaultQueue = view.getByTestId('queue-config-default-queue') as HTMLSelectElement;
  const policy = (queueId: string) =>
    view.getByTestId(`queue-failure-policy-select-${queueId}`) as HTMLSelectElement;
  return { ...view, page, cap, defaultQueue, policy };
}

function ack(
  callIndex: number,
  status: 'accepted' | 'rejected',
  reason?: string,
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed'
): void {
  const result = postCommandSpy.mock.results[callIndex];
  expect(result, `no post at index ${callIndex}`).toBeDefined();
  const { correlationId } = result!.value as { correlationId: string };
  snapshotStore.apply({
    type: CMD_ACK,
    correlationId,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(outcome !== undefined ? { outcome } : {})
  } as never);
}

/** The page's Save, answered by the host once its posts are out. */
async function saveAnswering(page: SettingsPage, answer: () => void): Promise<void> {
  const saving = page.save();
  await tick();
  answer();
  await saving;
}

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  // The ledger is module state: an unsettled intent from one case would be reused by the next.
  disposeIntentLedger();
  cleanup();
});

describe('QueueDefaultsSection — the redesign’s rows and table', () => {
  it('labels the two rows and the table in the redesign’s words', () => {
    const { getByTestId, container } = mount();

    expect(getByTestId('queue-defaults-cap-row').querySelector('.lab')?.textContent.trim())
      .toBe('Runs at the same time');
    expect(getByTestId('queue-defaults-default-queue-row').querySelector('.lab')?.textContent.trim())
      .toBe('Default queue');
    expect(getByTestId('queue-defaults-default-queue-row').querySelector('.desc')?.textContent.trim())
      .toBe('New tasks go here unless you pick another.');
    expect(container.querySelector('#queue-config-cap-unit')?.textContent).toBe('runs');
    expect(Array.from(container.querySelectorAll('.srow .hint')).map((hint) => hint.textContent))
      .toEqual(['Applies to: this workspace', 'Applies to: this workspace']);

    const heading = container.querySelector('#queue-failure-policy-heading');
    expect(heading?.tagName).toBe('H3');
    expect(heading?.textContent).toBe('When a task fails');
    expect(Array.from(container.querySelectorAll('table th')).map((th) => th.textContent))
      .toEqual(['Queue', 'Behavior']);
  });

  it('leads the cap’s description with the redesign’s words and keeps the disclosure', () => {
    const { getByTestId } = mount();
    expect(getByTestId('queue-config-cap-disclosure').textContent.trim())
      .toMatch(/^Across all queues\. Above one, concurrent Runs share one working tree\./);
  });

  it('names each queue’s row in registry position order', () => {
    const { container } = mount();
    expect(
      Array.from(container.querySelectorAll('tbody tr')).map((row) => row.querySelector('td')?.textContent.trim())
    ).toEqual(['Default', 'nightly', 'Review Lane']);
  });
});

describe('QueueDefaultsSection — prefilled from the projection (FR-009)', () => {
  it('shows the projected cap, not a constant', () => {
    const { cap } = mount();
    expect(cap.value).toBe('7');
  });

  it('shows the projected default queue, not the first option', () => {
    const { defaultQueue } = mount();
    expect(defaultQueue.value).toBe('q-gamma');
  });

  it('offers exactly the queues that exist, in registry position order', () => {
    const { defaultQueue } = mount();
    expect(Array.from(defaultQueue.options).map((option) => option.value))
      .toEqual(['default', 'q-beta', 'q-gamma']);
  });

  it('names each option by its queue name so the operator picks a queue, not an id', () => {
    const { defaultQueue } = mount();
    expect(Array.from(defaultQueue.options).map((option) => option.textContent.trim()))
      .toEqual(['Default', 'nightly', 'Review Lane']);
  });

  it('adds no option for a default queue that no longer exists', () => {
    const { defaultQueue } = mount({ settings: { defaultQueueId: 'q-gone' } });
    expect(Array.from(defaultQueue.options).map((option) => option.value))
      .toEqual(['default', 'q-beta', 'q-gamma']);
  });
});

describe('QueueDefaultsSection — one save model (Decision 21)', () => {
  it('writes nothing until the page saves', async () => {
    const { cap, defaultQueue, policy } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });
    await fireEvent.change(defaultQueue, { target: { value: 'q-beta' } });
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('counts each changed value under Queues and marks its row', async () => {
    const { cap, defaultQueue, policy, page, getByTestId } = mount();
    expect(page.changedCount).toBe(0);
    expect(page.sectionChanged('queues')).toBe(false);
    expect(getByTestId('queue-defaults-cap-row').querySelector('.mod')).toBeNull();

    await fireEvent.input(cap, { target: { value: '5' } });
    await fireEvent.change(defaultQueue, { target: { value: 'q-beta' } });
    await fireEvent.change(policy('q-gamma'), { target: { value: 'continue' } });

    expect(page.changedCount).toBe(3);
    expect(page.sectionChanged('queues')).toBe(true);
    expect(page.canSave).toBe(true);
    expect(getByTestId('queue-defaults-cap-row').querySelector('.mod')).not.toBeNull();
    expect(getByTestId('queue-defaults-default-queue-row').querySelector('.mod')).not.toBeNull();
    expect(getByTestId('queue-failure-policy-row-q-gamma').querySelector('.mod')).not.toBeNull();
    expect(getByTestId('queue-failure-policy-row-q-beta').querySelector('.mod')).toBeNull();
  });

  it('counts nothing once a value is set back to the saved one', async () => {
    const { cap, page } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });
    await fireEvent.input(cap, { target: { value: '7' } });
    expect(page.changedCount).toBe(0);
    expect(page.canSave).toBe(false);
  });

  it('reverts every value to the saved one', async () => {
    const { cap, defaultQueue, policy, page } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });
    await fireEvent.change(defaultQueue, { target: { value: 'q-beta' } });
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });

    page.revert();
    await tick();

    expect(cap.value).toBe('7');
    expect(defaultQueue.value).toBe('q-gamma');
    expect(policy('q-beta').value).toBe('follow-default');
    expect(page.changedCount).toBe(0);
  });

  it('drops a draft once the saved value it was made against changes', async () => {
    const { cap, page, rerender } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });

    await rerender({ snapshot: snapshotWith({ settings: { globalConcurrencyCap: 9 } }), page });

    expect(cap.value).toBe('9');
    expect(page.changedCount).toBe(0);
  });

  it('keeps a draft while only another value changes', async () => {
    const { cap, defaultQueue, page, rerender } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });

    await rerender({ snapshot: snapshotWith({ settings: { defaultQueueId: 'default' } }), page });

    expect(cap.value).toBe('5');
    expect(defaultQueue.value).toBe('default');
    expect(page.changedCount).toBe(1);
  });

  it('posts the workspace values first, then each changed queue in position order', async () => {
    const { cap, policy, page } = mount();
    await fireEvent.change(policy('q-gamma'), { target: { value: 'continue' } });
    await fireEvent.change(policy('default'), { target: { value: 'continue' } });
    await fireEvent.input(cap, { target: { value: '2' } });

    await saveAnswering(page, () => {
      ack(0, 'accepted');
      ack(1, 'accepted', undefined, 'accepted');
      ack(2, 'accepted', undefined, 'accepted');
    });

    expect(postCommandSpy.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [CMD_SAVE_QUEUE_SETTINGS, { globalConcurrencyCap: 2, defaultQueueId: 'q-gamma' }],
      [CMD_SET_QUEUE_FAILURE_POLICY, { queueId: 'default', policy: 'continue' }],
      [CMD_SET_QUEUE_FAILURE_POLICY, { queueId: 'q-gamma', policy: 'continue' }]
    ]);
  });
});

describe('QueueDefaultsSection — saving both values (FR-010)', () => {
  it('posts one command carrying both settings', async () => {
    const { cap, defaultQueue, page } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });
    await fireEvent.change(defaultQueue, { target: { value: 'q-beta' } });

    await saveAnswering(page, () => ack(0, 'accepted'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_SAVE_QUEUE_SETTINGS,
      { globalConcurrencyCap: 5, defaultQueueId: 'q-beta' },
      LEDGER_IDENTITY
    );
  });

  it('carries the unchanged value beside the changed one', async () => {
    const { defaultQueue, page } = mount();
    await fireEvent.change(defaultQueue, { target: { value: 'q-beta' } });

    await saveAnswering(page, () => ack(0, 'accepted'));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_SAVE_QUEUE_SETTINGS,
      { globalConcurrencyCap: 7, defaultQueueId: 'q-beta' },
      LEDGER_IDENTITY
    );
  });

  it('sends the cap as a number, not as the input element string', async () => {
    const { cap, page } = mount();
    await fireEvent.input(cap, { target: { value: '12' } });

    await saveAnswering(page, () => ack(0, 'accepted'));

    const payload = postCommandSpy.mock.calls[0][1] as { globalConcurrencyCap: unknown };
    expect(payload.globalConcurrencyCap).toBe(12);
    expect(typeof payload.globalConcurrencyCap).toBe('number');
  });

  it('says the save went through once the host accepts', async () => {
    const { cap, page, getByTestId } = mount();
    await fireEvent.input(cap, { target: { value: '5' } });

    await saveAnswering(page, () => ack(0, 'accepted'));

    await waitFor(() => expect(getByTestId('queue-config-status').textContent.trim()).toBe('Saved'));
  });
});

describe('QueueDefaultsSection — the host owns the range (FR-011)', () => {
  it('lets an out-of-range cap reach the host rather than pre-refusing it', async () => {
    const { cap, page } = mount();
    await fireEvent.input(cap, { target: { value: '99' } });
    expect(page.canSave).toBe(true);

    await saveAnswering(page, () => ack(0, 'rejected', 'invalid-concurrency-cap'));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_SAVE_QUEUE_SETTINGS,
      { globalConcurrencyCap: 99, defaultQueueId: 'q-gamma' },
      LEDGER_IDENTITY
    );
  });

  it('shows the refusal the host answers and keeps the draft', async () => {
    const { cap, page, getByTestId } = mount();
    await fireEvent.input(cap, { target: { value: '99' } });

    await saveAnswering(page, () => ack(0, 'rejected', 'invalid-concurrency-cap'));

    await waitFor(() =>
      expect(getByTestId('queue-config-refusal').textContent).toMatch(
        /outside the range this setting accepts/
      )
    );
    expect(cap.value).toBe('99');
    expect(page.changedCount).toBe(1);
  });

  it('clears the refusal on Revert', async () => {
    const { cap, page, queryByTestId, getByTestId } = mount();
    await fireEvent.input(cap, { target: { value: '99' } });
    await saveAnswering(page, () => ack(0, 'rejected', 'invalid-concurrency-cap'));
    await waitFor(() => expect(getByTestId('queue-config-refusal')).toBeTruthy());

    page.revert();
    await tick();

    expect(queryByTestId('queue-config-refusal')).toBeNull();
    expect(cap.value).toBe('7');
  });

  it('carries the range only as an input hint, never as a submit-time rule', () => {
    const { cap } = mount();
    expect(cap.getAttribute('min')).toBe('1');
    expect(cap.getAttribute('max')).toBe('20');
  });
});

// FR-R3-124 (FR-003) — the disclosure sits where the number is typed. A paragraph beside a number
// input is not announced with the input, so without `aria-describedby` a screen reader user
// changes the cap having heard "Runs at the same time, 7" and nothing else.
describe('QueueDefaultsSection — the shared-tree disclosure', () => {
  it('states that concurrent Runs share one working tree and may conflict', () => {
    const { getByTestId } = mount();

    const disclosure = getByTestId('queue-config-cap-disclosure');
    expect(disclosure.textContent).toMatch(/share one working tree/i);
    expect(disclosure.textContent).toMatch(/conflict/i);
  });

  it('associates the disclosure with the cap input for assistive technology', () => {
    const { cap, getByTestId } = mount();

    const describedBy = cap.getAttribute('aria-describedby');
    expect(describedBy).toBe('queue-config-cap-shared-tree');
    // Resolved, not just asserted as a string: an id pointing at nothing reads to assistive
    // technology exactly like no id at all.
    expect(getByTestId('queue-config-cap-disclosure').id).toBe(describedBy);
  });
});

/**
 * FR-R3-130 (T1495) — what the cap will cost, said at the moment it is typed.
 *
 * The audit of 2026-08-27's point about the cap-20 ceiling was that an operator can accept it
 * without ever seeing it. Both directions are asserted, because a warning that fires at the
 * shipped default is furniture and furniture is what an operator stops reading.
 */
describe('QueueDefaultsSection — the stream-pressure warning', () => {
  const GIB = 1024 * 1024 * 1024;

  function mountWithMemory(cap: number, machineMemoryBytes: number) {
    return mount({ settings: { globalConcurrencyCap: cap }, machineMemoryBytes });
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
    // The operator's next move is the record, and a warning that cannot be checked gets
    // dismissed.
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

  it('follows the value being typed, and does not stop the page saving it', async () => {
    // The cap's range is ratified; an operator on a large machine raising it is making a
    // legitimate choice, and a page that refused would be this component overruling
    // `local-queue-parallelism-ratification.md`.
    const { cap, page, getByTestId, queryByTestId } = mountWithMemory(1, 4 * GIB);
    expect(queryByTestId('queue-config-pressure-advice')).toBeNull();

    await fireEvent.input(cap, { target: { value: '20' } });

    expect(getByTestId('queue-config-pressure-advice')).toBeTruthy();
    expect(page.canSave).toBe(true);
  });
});

// Feature 195 (T041, FR-014, FR-018, FR-019) — each queue's own failure behaviour.
describe('QueueDefaultsSection — each queue’s failure behaviour (FR-014, FR-018, FR-019)', () => {
  it('offers all three choices for a queue, in the redesign’s words', () => {
    const { policy } = mount();
    const select = policy('default');
    expect(Array.from(select.options).map((option) => option.value))
      .toEqual(['follow-default', 'halt-on-failure', 'continue']);
    expect(Array.from(select.options).map((option) => option.textContent.trim())).toEqual([
      'Use the workspace default (stop the queue)',
      'Stop the queue',
      'Continue with the next task'
    ]);
  });

  it('selects the workspace default for an un-opinionated queue and names what it resolves to', () => {
    const { policy } = mount({
      summaries: [summary({ id: 'default', failurePolicy: 'continue', failurePolicyOverride: null })]
    });
    const select = policy('default');
    expect(select.value).toBe('follow-default');
    expect(select.options.item(select.selectedIndex)?.textContent).toContain('continue with the next task');
  });

  it('selects the queue’s own override when it has stated one', () => {
    const { policy } = mount({
      summaries: [summary({ id: 'default', failurePolicy: 'continue', failurePolicyOverride: 'continue' })]
    });
    expect(policy('default').value).toBe('continue');
  });

  it('posts the chosen policy for the addressed queue on Save', async () => {
    const { policy, page } = mount();
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });

    await saveAnswering(page, () => ack(0, 'accepted', undefined, 'accepted'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_SET_QUEUE_FAILURE_POLICY,
      { queueId: 'q-beta', policy: 'continue' },
      LEDGER_IDENTITY
    );
  });

  it('posts policy: null when the operator chooses the workspace default', async () => {
    const { policy, page } = mount({
      summaries: [summary({ id: 'q-beta', position: 1, failurePolicyOverride: 'halt-on-failure' })]
    });
    await fireEvent.change(policy('q-beta'), { target: { value: 'follow-default' } });

    await saveAnswering(page, () => ack(0, 'accepted', undefined, 'accepted'));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_SET_QUEUE_FAILURE_POLICY,
      { queueId: 'q-beta', policy: null },
      LEDGER_IDENTITY
    );
  });

  it('reads a no-op as its own sentence in a polite status region, never as a refusal alert', async () => {
    const { policy, page, getByTestId } = mount();
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });

    await saveAnswering(page, () => ack(0, 'rejected', 'failure-policy-unchanged', 'no-op'));

    await waitFor(() =>
      expect(getByTestId('queue-failure-policy-message-q-beta').textContent.trim()).toBe(
        'Already set that way.'
      )
    );
    const message = getByTestId('queue-failure-policy-message-q-beta');
    expect(message.getAttribute('role')).toBeNull();
    expect(message.closest('[role="status"]')).not.toBeNull();
  });

  it('keeps an unknown timeout outcome in the polite status region without role="alert"', async () => {
    const { policy, page, getByTestId } = mount();
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });

    await saveAnswering(page, () => ack(0, 'rejected', 'timeout', 'refused'));

    await waitFor(() =>
      expect(getByTestId('queue-failure-policy-message-q-beta').textContent.trim()).toBe(
        'The host has not answered yet. The change may still happen; this view will update when it does.'
      )
    );
    const message = getByTestId('queue-failure-policy-message-q-beta');
    expect(message.getAttribute('role')).toBeNull();
    expect(message.closest('[role="status"]')).not.toBeNull();
  });

  it('renders a refusal with role="alert" outside polite role="status" and formats unknown codes as plain text', async () => {
    const { policy, page, getByTestId } = mount();
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });

    await saveAnswering(page, () => ack(0, 'rejected', 'unknown-queue-id', 'refused'));

    await waitFor(() =>
      expect(getByTestId('queue-failure-policy-message-q-beta').textContent.trim()).toBe(
        'That queue no longer exists.'
      )
    );
    const knownRefusal = getByTestId('queue-failure-policy-message-q-beta');
    expect(knownRefusal.getAttribute('role')).toBe('alert');
    expect(knownRefusal.closest('[role="status"]')).toBeNull();

    await saveAnswering(page, () => ack(1, 'rejected', 'future-policy-gate', 'refused'));

    await waitFor(() =>
      expect(getByTestId('queue-failure-policy-message-q-beta').textContent.trim()).toBe(
        'The host refused this action (future-policy-gate).'
      )
    );
    const unknownRefusal = getByTestId('queue-failure-policy-message-q-beta');
    expect(unknownRefusal.getAttribute('role')).toBe('alert');
    expect(unknownRefusal.closest('[role="status"]')).toBeNull();
    expect(unknownRefusal.textContent).not.toContain('`');
  });

  it('shows no message on an accepted write', async () => {
    const { policy, page, queryByTestId } = mount();
    await fireEvent.change(policy('q-beta'), { target: { value: 'continue' } });

    await saveAnswering(page, () => ack(0, 'accepted', undefined, 'accepted'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(queryByTestId('queue-failure-policy-message-q-beta')).toBeNull();
  });

  it('renders a control for every queue independently', () => {
    const { policy } = mount({
      summaries: [
        summary({ id: 'default', failurePolicy: 'halt-on-failure' }),
        summary({ id: 'q-beta', position: 1, failurePolicy: 'continue', failurePolicyOverride: 'continue' })
      ]
    });
    expect(policy('default').value).toBe('follow-default');
    expect(policy('q-beta').value).toBe('continue');
  });
});

// Feature 092 (FR-065) — a non-primary window reads every value but changes none: the host
// refuses its writes, so the section offers none.
describe('QueueDefaultsSection — read-only in a non-primary window (FR-065)', () => {
  it('says why, and disables every control', () => {
    const { cap, defaultQueue, policy, getByTestId } = mount({ isPrimary: false });
    expect(getByTestId('queue-defaults-read-only').textContent.trim()).toBe(
      'This window is not the primary one, so it cannot change these settings.'
    );
    expect(cap.disabled).toBe(true);
    expect(defaultQueue.disabled).toBe(true);
    for (const queueId of ['default', 'q-beta', 'q-gamma']) {
      expect(policy(queueId).disabled).toBe(true);
    }
  });

  it('counts nothing and saves nothing', async () => {
    const { cap, page } = mount({ isPrimary: false });
    await fireEvent.input(cap, { target: { value: '5' } });
    expect(page.changedCount).toBe(0);
    expect(page.canSave).toBe(false);
  });

  it('shows no read-only line in the primary window', () => {
    const { queryByTestId } = mount();
    expect(queryByTestId('queue-defaults-read-only')).toBeNull();
  });
});
