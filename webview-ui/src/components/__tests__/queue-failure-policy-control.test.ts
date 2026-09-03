// Feature 195 (T041, FR-014, FR-018, FR-019) — the per-queue failure-policy
// control in `QueueConfigModal.svelte`.
//
// Three properties:
//
// 1. All three choices are offered — `halt-on-failure`, `continue`, and
//    "follow the workspace default" — read from the generated mirror rather
//    than restated (FR-014).
// 2. An un-opinionated queue (no stored override) selects "follow the
//    default" and names what that currently resolves to.
// 3. Choosing a concrete policy posts `CMD_SET_QUEUE_FAILURE_POLICY` with
//    that policy; choosing "follow the default" posts `policy: null`. A
//    no-op reads as its own sentence, never as a refusal (FR-019).

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueueConfigModal from '../QueueConfigModal.svelte';
import { CMD_ACK, CMD_SET_QUEUE_FAILURE_POLICY } from '../../lib/messages';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { QueueRuntime, QueueSettingsProjection, QueueSummary } from '../../lib/snapshot-types';

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
  buildQueueRuntime({ queueId: 'default', name: 'Default', position: 0 }),
  buildQueueRuntime({ queueId: 'q-beta', name: 'nightly', position: 1 })
]);

const SETTINGS: QueueSettingsProjection = Object.freeze({
  globalConcurrencyCap: 3,
  defaultQueueId: 'default'
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

function mount(queueSummaries: readonly QueueSummary[]) {
  return render(QueueConfigModal, {
    props: {
      queueSettings: SETTINGS,
      queues: QUEUES,
      queueSummaries,
      onClose: () => {}
    }
  });
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

beforeEach(() => {
  nextCorrelationId = 0;
  postCommandSpy.mockReset();
});
afterEach(() => cleanup());

describe('QueueConfigModal — per-queue failure-policy control (FR-014, FR-018, FR-019)', () => {
  it('offers all three choices for a queue', () => {
    const { getByTestId } = mount([
      summary({ id: 'default', failurePolicy: 'halt-on-failure', failurePolicyOverride: null })
    ]);
    const select = getByTestId('queue-failure-policy-select-default') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['follow-default', 'halt-on-failure', 'continue']);
  });

  it('selects "follow the default" for an un-opinionated queue and names its effective policy', () => {
    const { getByTestId } = mount([
      summary({ id: 'default', failurePolicy: 'continue', failurePolicyOverride: null })
    ]);
    const select = getByTestId('queue-failure-policy-select-default') as HTMLSelectElement;
    expect(select.value).toBe('follow-default');
    expect(select.options[select.selectedIndex]!.textContent).toContain('Continue');
  });

  it('selects the queue’s own override when it has stated one', () => {
    const { getByTestId } = mount([
      summary({ id: 'default', failurePolicy: 'continue', failurePolicyOverride: 'continue' })
    ]);
    const select = getByTestId('queue-failure-policy-select-default') as HTMLSelectElement;
    expect(select.value).toBe('continue');
  });

  it('posts the chosen policy for the addressed queue', async () => {
    const { getByTestId } = mount([summary({ id: 'q-beta' })]);
    const select = getByTestId('queue-failure-policy-select-q-beta') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'continue' } });

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SET_QUEUE_FAILURE_POLICY, {
      queueId: 'q-beta',
      policy: 'continue'
    });
  });

  it('posts policy: null when the operator chooses "follow the default"', async () => {
    const { getByTestId } = mount([
      summary({ id: 'q-beta', failurePolicyOverride: 'halt-on-failure' })
    ]);
    const select = getByTestId('queue-failure-policy-select-q-beta') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'follow-default' } });

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SET_QUEUE_FAILURE_POLICY, {
      queueId: 'q-beta',
      policy: null
    });
  });

  it('reads a no-op as its own sentence, never as a refusal', async () => {
    const { getByTestId } = mount([summary({ id: 'q-beta' })]);
    const select = getByTestId('queue-failure-policy-select-q-beta') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'continue' } });
    ack(0, 'rejected', 'failure-policy-unchanged', 'no-op');

    await waitFor(() => {
      expect(getByTestId('queue-failure-policy-message-q-beta').textContent).toBe(
        'Already set that way.'
      );
    });
  });

  it('renders a refusal with its reason', async () => {
    const { getByTestId } = mount([summary({ id: 'q-beta' })]);
    const select = getByTestId('queue-failure-policy-select-q-beta') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'continue' } });
    ack(0, 'rejected', 'unknown-queue-id', 'refused');

    await waitFor(() => {
      expect(getByTestId('queue-failure-policy-message-q-beta').textContent).toBe(
        'That queue no longer exists.'
      );
    });
  });

  it('shows no message on an accepted write', async () => {
    const { getByTestId, queryByTestId } = mount([summary({ id: 'q-beta' })]);
    const select = getByTestId('queue-failure-policy-select-q-beta') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'continue' } });
    ack(0, 'accepted', undefined, 'accepted');

    await waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(1));
    expect(queryByTestId('queue-failure-policy-message-q-beta')).toBeNull();
  });

  it('renders a control for every queue independently', () => {
    const { getByTestId } = mount([
      summary({ id: 'default', failurePolicy: 'halt-on-failure' }),
      summary({ id: 'q-beta', failurePolicy: 'continue', failurePolicyOverride: 'continue' })
    ]);
    expect((getByTestId('queue-failure-policy-select-default') as HTMLSelectElement).value).toBe(
      'follow-default'
    );
    expect((getByTestId('queue-failure-policy-select-q-beta') as HTMLSelectElement).value).toBe(
      'continue'
    );
  });
});
