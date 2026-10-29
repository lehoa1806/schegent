// FR-R4-F15 (feature 243, contract P2, P5.4, P5.5; TA5) — when "Show last error" asks the host for
// the retained failure record, and what it does with each outcome.
//
// The host's answer arrives on the command's ack, so the test stubs `postCommand` and the snapshot
// store's ack registry (the seams `history-evidence-ipc.test.ts` uses) and delivers acks by hand.
// That keeps the real IPC helper, its validator and its 5-second timeout in the path: a case here
// is the component, the helper and the shared record validator together, which is the only way to
// show that an invalid result and a timeout read as "could not load" and not as an empty panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import QueueItemError from '../QueueItemError.svelte';
import type { QueueItem } from '../../lib/snapshot-types';
import { CMD_READ_FAILURE_RECORD } from '../../lib/messages';

type Ack = { status: 'accepted' | 'rejected'; reason?: string; result?: unknown };

const ackListeners = new Map<string, (ack: Ack) => void>();
const posted: Array<{ type: string; payload?: unknown; correlationId: string }> = [];
let nextId = 0;

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck(id: string, listener: (ack: Ack) => void): () => void {
      ackListeners.set(id, listener);
      return () => ackListeners.delete(id);
    }
  }
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `read-${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

const ERROR_TEXT = 'invocation-failed: the last phase reported remaining issues';
const ITEM = {
  id: 'task-1',
  label: 'Add the export button',
  queueId: 'q-7',
  status: 'failed',
  lastErrorSummary: ERROR_TEXT
} as unknown as QueueItem;

const RECORD = {
  recordVersion: 1,
  queueId: 'q-7',
  taskId: 'task-1',
  runId: 'run-1',
  failedAt: '2026-10-28T14:30:05.123Z',
  suffix: '0a1b2c3d',
  cause: 'last_phase_issues_remain',
  issueState: 'listed',
  entries: [{ kind: 'issue', summary: 'one case fails', tag: 'regression', source: 'agent' }],
  omittedIssueCount: 0,
  metrics: [],
  omittedMetricCount: 0
};

const NONE = { outcome: 'none', queueId: 'q-7', taskId: 'task-1' };
const AVAILABLE = { outcome: 'available', queueId: 'q-7', taskId: 'task-1', record: RECORD, recordCount: 1 };
const COULD_NOT_LOAD = 'Could not load failure diagnostics.';

beforeEach(() => {
  ackListeners.clear();
  posted.length = 0;
  nextId = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(open = false) {
  const view = render(QueueItemError, {
    props: { item: ITEM, showLastError: true, open, onToggle: vi.fn() }
  });
  const setOpen = (next: boolean): void => {
    void view.rerender({ item: ITEM, showLastError: true, open: next, onToggle: vi.fn() });
    flushSync();
  };
  return { ...view, setOpen };
}

function deliver(correlationId: string, ack: Ack): void {
  const listener = ackListeners.get(correlationId);
  if (listener === undefined) throw new Error(`no listener for ${correlationId}`);
  listener(ack);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

const panelText = (view: ReturnType<typeof mount>): string =>
  (view.queryByTestId('failure-record-panel-task-1')?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('one request per open (P5.4)', () => {
  it('asks nothing while the region is closed', () => {
    mount(false);
    expect(posted).toHaveLength(0);
  });

  it('asks once when the region opens, naming the row\'s queue and its id', () => {
    const view = mount(false);
    view.setOpen(true);
    expect(posted).toEqual([
      { type: CMD_READ_FAILURE_RECORD, payload: { queueId: 'q-7', taskId: 'task-1' }, correlationId: 'read-1' }
    ]);
  });

  it('starts in loading, and shows the record when the host answers', async () => {
    const view = mount(false);
    view.setOpen(true);
    expect(panelText(view)).toBe('Loading failure diagnostics…');
    deliver('read-1', { status: 'accepted', result: AVAILABLE });
    await settle();
    expect(panelText(view)).toContain('one case fails — reported as regression');
  });

  it('asks again on each reopen, once per open', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'accepted', result: NONE });
    await settle();
    view.setOpen(false);
    view.setOpen(true);
    expect(posted.map((entry) => entry.correlationId)).toEqual(['read-1', 'read-2']);
    expect(panelText(view)).toBe('Loading failure diagnostics…');
  });

  it('opens at mount and asks once when it is mounted open', () => {
    mount(true);
    expect(posted).toHaveLength(1);
  });

  it('ignores a response that arrives after the region closed', async () => {
    const view = mount(false);
    view.setOpen(true);
    view.setOpen(false);
    deliver('read-1', { status: 'accepted', result: AVAILABLE });
    await settle();
    expect(view.queryByTestId('failure-record-panel-task-1')).toBeNull();
    view.setOpen(true);
    expect(posted).toHaveLength(2);
    expect(panelText(view)).toBe('Loading failure diagnostics…');
  });

  it('ignores the first open\'s late answer once the region has been reopened', async () => {
    const view = mount(false);
    view.setOpen(true);
    view.setOpen(false);
    view.setOpen(true);
    // The answer to the FIRST open arrives while the second is still pending.
    deliver('read-1', { status: 'accepted', result: AVAILABLE });
    await settle();
    expect(panelText(view)).toBe('Loading failure diagnostics…');
    deliver('read-2', { status: 'accepted', result: { outcome: 'expired', queueId: 'q-7', taskId: 'task-1' } });
    await settle();
    expect(panelText(view)).toBe("This Run's failure diagnostics were removed by retention.");
  });

  it('keeps the last error text unchanged and first, with the panel after it', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'accepted', result: NONE });
    await settle();
    const region = view.getByTestId('queue-item-error-task-1');
    const errorText = view.getByTestId('queue-item-error-text-task-1');
    const panel = view.getByTestId('failure-record-panel-task-1');
    expect(errorText.textContent).toBe(ERROR_TEXT);
    expect(region.firstElementChild).toBe(errorText);
    expect(errorText.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.getAttribute('aria-label')).toBe(`Last error for ${ITEM.label}`);
  });

  it('keeps the button\'s own rule: no button, no region and no request without a last error', () => {
    const view = render(QueueItemError, {
      props: { item: { ...ITEM, lastErrorSummary: null } as unknown as QueueItem, showLastError: true, open: true, onToggle: vi.fn() }
    });
    expect(view.queryByTestId('queue-item-error-toggle-task-1')).toBeNull();
    expect(posted).toHaveLength(0);
  });

  it('keeps the toggle\'s labels and aria wiring', () => {
    const view = mount(false);
    expect(view.getByTestId('queue-item-error-toggle-task-1').textContent).toBe('Show last error');
    view.setOpen(true);
    const toggle = view.getByTestId('queue-item-error-toggle-task-1');
    expect(toggle.textContent).toBe('Hide error');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('a failed read says so, in one sentence (P5.5)', () => {
  it('shows it for a rejected ack', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'rejected', reason: 'internal-error' });
    await settle();
    expect(panelText(view)).toBe(COULD_NOT_LOAD);
  });

  it('shows it for a rejected ack whose result is the host\'s own failure arm', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'rejected', reason: 'unknown-row', result: { outcome: 'failure', reason: 'unknown-row' } });
    await settle();
    expect(panelText(view)).toBe(COULD_NOT_LOAD);
  });

  it('shows it for an accepted ack whose result is not a valid response', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'accepted', result: { outcome: 'available', queueId: 'q-7', taskId: 'task-1', record: { ...RECORD, recordVersion: 2 }, recordCount: 1 } });
    await settle();
    expect(panelText(view)).toBe(COULD_NOT_LOAD);
  });

  it('shows it for an accepted ack with no result at all', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'accepted' });
    await settle();
    expect(panelText(view)).toBe(COULD_NOT_LOAD);
  });

  it('shows it when nothing answers within the 5-second timeout, and not before', async () => {
    vi.useFakeTimers();
    const view = mount(false);
    view.setOpen(true);
    await vi.advanceTimersByTimeAsync(4_999);
    flushSync();
    expect(panelText(view)).toBe('Loading failure diagnostics…');
    await vi.advanceTimersByTimeAsync(2);
    flushSync();
    expect(panelText(view)).toBe(COULD_NOT_LOAD);
  });

  it('leaves the last error text visible in every one of those cases', async () => {
    const view = mount(false);
    view.setOpen(true);
    deliver('read-1', { status: 'rejected', reason: 'internal-error' });
    await settle();
    expect(view.getByTestId('queue-item-error-text-task-1').textContent).toBe(ERROR_TEXT);
  });
});
