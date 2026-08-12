// Feature 092 (T099, FR-055, FR-056, FR-065, US5 scenario 2) — tier 1 of the
// drill-down: every queue at a glance, and the one action that creates another.
//
// Tier 1 is the existing `operations` route, which is already labelled 'Queues'.
// These tests therefore assert what the tier *shows* and *offers*, never that a
// new nav sibling appeared — `routes.test.ts` pins the nav enum against exactly
// that.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueuesTier from '../QueuesTier.svelte';
import { CMD_CREATE_QUEUE } from '../../../lib/messages';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import type { QueueItem, QueueRuntime } from '../../../lib/snapshot-types';

const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({ correlationId: 'corr-1' }));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

function task(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    label: `task ${id}`,
    enqueuedAt: '2026-08-12T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  };
}

const QUEUES: readonly QueueRuntime[] = Object.freeze([
  buildQueueRuntime({
    queueId: 'default',
    name: 'Default',
    position: 0,
    lifecycle: 'running',
    pendingCount: 2,
    tasks: [task('a'), task('b')]
  }),
  buildQueueRuntime({
    queueId: 'q-beta',
    name: 'nightly',
    position: 1,
    lifecycle: 'idle-pending',
    pendingCount: 0
  }),
  buildQueueRuntime({
    queueId: 'q-gamma',
    name: 'Review Lane',
    position: 2,
    lifecycle: 'operator-paused',
    pendingCount: 5
  })
]);

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('QueuesTier — every queue at a glance (FR-055)', () => {
  it('renders one card per registered queue', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: true } });

    expect(container.querySelectorAll('[data-testid^="queue-card-"]')).toHaveLength(3);
    expect(container.querySelector('[data-testid="queue-card-q-beta"]')).not.toBeNull();
  });

  it('shows each queue name, lifecycle and pending count', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: true } });

    const card = container.querySelector('[data-testid="queue-card-q-gamma"]');
    expect(card?.textContent).toContain('Review Lane');
    expect(card?.textContent).toContain('Paused');
    expect(card?.textContent).toContain('5');
  });

  it('spells every lifecycle it can be handed, so no queue reads as blank', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: true } });

    expect(
      container.querySelector('[data-testid="queue-lifecycle-default"]')?.textContent?.trim()
    ).toBe('Running');
    expect(
      container.querySelector('[data-testid="queue-lifecycle-q-beta"]')?.textContent?.trim()
    ).toBe('Idle (pending)');
    expect(
      container.querySelector('[data-testid="queue-lifecycle-q-gamma"]')?.textContent?.trim()
    ).toBe('Paused');
  });

  it('orders cards by queue position, not by arrival order in the array', () => {
    const shuffled = Object.freeze([QUEUES[2], QUEUES[0], QUEUES[1]] as readonly QueueRuntime[]);
    const { container } = render(QueuesTier, { props: { queues: shuffled, isPrimary: true } });

    const ids = Array.from(container.querySelectorAll('[data-testid^="queue-card-"]')).map((el) =>
      el.getAttribute('data-testid')
    );
    expect(ids).toEqual(['queue-card-default', 'queue-card-q-beta', 'queue-card-q-gamma']);
  });

  it('renders an empty state rather than a bare grid when no queue has been projected', () => {
    const { container } = render(QueuesTier, { props: { queues: [], isPrimary: true } });

    expect(container.querySelectorAll('[data-testid^="queue-card-"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="queues-empty"]')).not.toBeNull();
  });

  it('owns the single main landmark for the operations surface', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: true } });

    expect(container.querySelectorAll('main')).toHaveLength(1);
  });
});

describe('QueuesTier — drilling into a queue (FR-056, FR-059)', () => {
  it('makes each card a button so it is reachable by keyboard', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: true } });

    for (const card of container.querySelectorAll('[data-testid^="queue-card-"]')) {
      expect(card.tagName).toBe('BUTTON');
    }
  });

  it('reports the queue that was activated rather than navigating itself', async () => {
    const selected: string[] = [];
    const { container } = render(QueuesTier, {
      props: { queues: QUEUES, isPrimary: true, onSelectQueue: (id: string) => selected.push(id) }
    });

    await fireEvent.click(container.querySelector('[data-testid="queue-card-q-beta"]') as Element);
    expect(selected).toEqual(['q-beta']);
  });

  it('activates a card from the keyboard', async () => {
    const selected: string[] = [];
    const { container } = render(QueuesTier, {
      props: { queues: QUEUES, isPrimary: true, onSelectQueue: (id: string) => selected.push(id) }
    });

    const card = container.querySelector('[data-testid="queue-card-q-gamma"]') as HTMLElement;
    await fireEvent.keyDown(card, { key: 'Enter' });
    expect(selected).toEqual(['q-gamma']);
  });
});

describe('QueuesTier — creating a queue (FR-056)', () => {
  it('offers a create-queue action', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: true } });

    expect(container.querySelector('[data-testid="queue-create"]')).not.toBeNull();
  });

  it('posts CMD_CREATE_QUEUE with the trimmed name the operator typed', async () => {
    const { container, getByTestId } = render(QueuesTier, {
      props: { queues: QUEUES, isPrimary: true }
    });

    await fireEvent.click(getByTestId('queue-create'));
    const input = container.querySelector('[data-testid="queue-create-name"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '  release train  ' } });
    await fireEvent.click(getByTestId('queue-create-submit'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_CREATE_QUEUE, { name: 'release train' });
  });

  it('refuses to post a blank name', async () => {
    const { container, getByTestId } = render(QueuesTier, {
      props: { queues: QUEUES, isPrimary: true }
    });

    await fireEvent.click(getByTestId('queue-create'));
    const input = container.querySelector('[data-testid="queue-create-name"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.click(getByTestId('queue-create-submit'));

    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('closes the name field after a successful submit so the next create starts empty', async () => {
    const { container, getByTestId } = render(QueuesTier, {
      props: { queues: QUEUES, isPrimary: true }
    });

    await fireEvent.click(getByTestId('queue-create'));
    const input = container.querySelector('[data-testid="queue-create-name"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'one' } });
    await fireEvent.click(getByTestId('queue-create-submit'));

    expect(container.querySelector('[data-testid="queue-create-name"]')).toBeNull();
  });
});

describe('QueuesTier — read-only in a non-primary window (FR-065)', () => {
  it('withholds the create action', () => {
    const { container } = render(QueuesTier, { props: { queues: QUEUES, isPrimary: false } });

    expect(container.querySelector('[data-testid="queue-create"]')).toBeNull();
  });

  it('still lets the operator read and drill into every queue', async () => {
    const selected: string[] = [];
    const { container } = render(QueuesTier, {
      props: { queues: QUEUES, isPrimary: false, onSelectQueue: (id: string) => selected.push(id) }
    });

    expect(container.querySelectorAll('[data-testid^="queue-card-"]')).toHaveLength(3);
    await fireEvent.click(container.querySelector('[data-testid="queue-card-default"]') as Element);
    expect(selected).toEqual(['default']);
  });
});
