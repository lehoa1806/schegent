// Opening a failed row's last error must ask the host for the failure record
// once per open (finding 227 of the webview port review).
//
// `QueueItemError.test.ts` replaces the snapshot store whole, so the call the
// helper makes on the way out, `snapshotStore.markPending`, never reaches the
// real store under test. That call reads the store's pending set and replaces
// it. Made from inside an effect, the read is tracked and the write invalidates
// it, so the effect asks again until Svelte stops it with
// `effect_update_depth_exceeded`. `history-panels-ask-once.test.ts` pins the
// same shape for the two History panels.
//
// Only the transport is stubbed here: the helper makes its real correlated
// request against the real store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { CMD_READ_FAILURE_RECORD } from '../../lib/messages';
import type { QueueItem } from '../../lib/snapshot-types';

const postCommandSpy = vi.fn<(type: string, payload?: unknown) => { correlationId: string }>();

vi.mock('../../lib/vscode-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vscode-api')>()),
  postCommand: (type: string, payload?: unknown) => postCommandSpy(type, payload)
}));

import QueueItemError from '../QueueItemError.svelte';

const ITEM = {
  id: 'task-1',
  label: 'Add the export button',
  queueId: 'q-7',
  status: 'failed',
  lastErrorSummary: 'invocation-failed: the last phase reported remaining issues'
} as unknown as QueueItem;

const ASKED = { queueId: 'q-7', taskId: 'task-1' };

/** The payloads posted for one command, in order. */
function requestsFor(command: string): unknown[] {
  return postCommandSpy.mock.calls.filter(([type]) => type === command).map(([, payload]) => payload);
}

function mount(open: boolean) {
  return render(QueueItemError, { props: { item: ITEM, showLastError: true, open, onToggle: () => {} } });
}

let sent = 0;

beforeEach(() => {
  sent = 0;
  postCommandSpy.mockReset();
  postCommandSpy.mockImplementation(() => {
    sent += 1;
    return { correlationId: `queue-item-error-ask-once-${sent}` };
  });
});

afterEach(() => cleanup());

describe('the failure-record region asks once per open', () => {
  it('mounts open and asks once', async () => {
    expect(() => mount(true)).not.toThrow();
    await tick();

    expect(requestsFor(CMD_READ_FAILURE_RECORD)).toEqual([ASKED]);
  });

  it('asks once more when it is closed and opened again, and stops there', async () => {
    const { rerender } = mount(true);
    await tick();
    await rerender({ open: false });
    await tick();
    await rerender({ open: true });
    await tick();

    expect(requestsFor(CMD_READ_FAILURE_RECORD)).toEqual([ASKED, ASKED]);
  });
});
