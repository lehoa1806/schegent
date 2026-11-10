// FR-R6-F07 T026 (FR-004, FR-005, SC-004) — the store applies live-log batches
// once, asks once for a resync, and keeps the applied cursor across a recreation.
//
// WHAT THIS PINS. Delivered through the store's subscription:
//   - 100 deliveries of one batch leave one copy, each repeat acknowledged as a
//     duplicate;
//   - a batch-number gap sends exactly one `resync`;
//   - a `resume` replay of positions already applied adds nothing;
//   - a `reset` clears the applied position, so an earlier position shows again;
//   - the applied cursor and generation are written to webview state beside the
//     selection, merged with the keys already there;
//   - a recreated store passes the persisted cursor on start only for the same
//     selection.
//
// FIXTURE. The store's read and tail seams are injected, as in
// `phase-log-store.window.test.ts`; `vscode-api` is mocked so each test drives
// the persisted state.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';

const getWebviewStateMock = vi.fn<() => unknown>();
const setWebviewStateMock = vi.fn<(state: unknown) => void>();

vi.mock('../vscode-api', () => ({
  getWebviewState: () => getWebviewStateMock(),
  setWebviewState: (state: unknown) => setWebviewStateMock(state),
  postCommand: vi.fn(),
  onHostMessage: () => () => {}
}));

vi.mock('../phase-log-ipc', () => ({
  readPhaseLog: vi.fn(),
  startPhaseLogTail: vi.fn(),
  stopPhaseLogTail: vi.fn(),
  subscribePhaseLogBatch: () => () => {},
  ackPhaseLogTail: vi.fn()
}));

import { __resetLiveModeForTests, createPhaseLogStore } from '../phase-log-store.svelte';

const SESSION = 's-live-log';
const GENERATION = 'g-1';
const DUPLICATE_DELIVERIES = 100;
const SELECTION = {
  queueId: 'q-1',
  taskId: 't-1',
  pipelineId: 'p-1',
  phaseId: 'ph-1',
  iterationN: 1
} as const;
const OTHER_SELECTION = { ...SELECTION, phaseId: 'ph-2' } as const;

interface Item {
  readonly at: number;
  readonly n: number;
  readonly entry: PhaseLogDisplayEntry;
}

interface BatchInit {
  readonly batchSeq: number;
  readonly mode?: 'continue' | 'resume' | 'reset';
  readonly items?: readonly Item[];
  readonly toCursor?: string | null;
  readonly generation?: string;
}

function entry(text: string): PhaseLogDisplayEntry {
  return Object.freeze({ seq: 0, kind: 'assistant-text', ts: null, body: { text }, bodyTruncated: null });
}

function item(at: number, n = 0): Item {
  return { at, n, entry: entry(`record at ${at}.${n}`) };
}

function batch(init: BatchInit) {
  return {
    protocol: 1,
    tailSessionId: SESSION,
    batchSeq: init.batchSeq,
    generation: init.generation ?? GENERATION,
    mode: init.mode ?? 'continue',
    toCursor: init.toCursor ?? null,
    entries: init.items ?? []
  };
}

function emptyRead() {
  return {
    outcome: 'success' as const,
    manifest: {
      iterations: [1],
      selectedIteration: 1,
      entries: [],
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: null,
      isInFlight: true,
      cursor: null
    }
  };
}

interface Rig {
  readonly store: ReturnType<typeof createPhaseLogStore>;
  readonly acks: unknown[];
  readonly starts: { readonly selection: unknown; readonly fromCursor?: string }[];
  deliver(payload: unknown): void;
}

function buildRig(): Rig {
  const acks: unknown[] = [];
  const starts: { readonly selection: unknown; readonly fromCursor?: string }[] = [];
  // A one-slot array: the write happens inside the `subscribe` closure, which flow analysis does not see.
  const captured: ((payload: unknown) => void)[] = [];
  const store = createPhaseLogStore(
    async () => emptyRead() as never,
    {
      start: async (req: { readonly selection: unknown; readonly fromCursor?: string }) => {
        starts.push(req);
        return {
          outcome: 'success',
          sessionId: SESSION,
          mechanism: 'fs.watch',
          snapshotCutoff: 'cut-0',
          nextCursor: 'c-0',
          cursorStatus: req.fromCursor === undefined ? 'none' : 'accepted'
        };
      },
      stop: async () => ({ outcome: 'success', sessionId: SESSION }),
      ack: (req: unknown) => {
        acks.push(req);
      },
      subscribe: (callback: (payload: never) => void) => {
        captured.length = 0;
        captured.push(callback as (payload: unknown) => void);
        return () => {
          captured.length = 0;
        };
      }
    } as never
  );
  return {
    store,
    acks,
    starts,
    deliver: (payload) => {
      const push = captured.at(0);
      if (push === undefined) throw new Error('no subscription: startTail has not run');
      push(payload);
    }
  };
}

async function startedRig(): Promise<Rig> {
  const rig = buildRig();
  rig.store.setSelection({ ...SELECTION }, { origin: 'cascade' });
  await rig.store.reload();
  await rig.store.startTail({ selection: { ...SELECTION } });
  return rig;
}

function textsOf(rig: Rig): string[] {
  return rig.store.state.entries.map((shown) => String(shown.body.text));
}

beforeEach(() => {
  __resetLiveModeForTests();
  getWebviewStateMock.mockReset();
  setWebviewStateMock.mockReset();
  getWebviewStateMock.mockReturnValue(undefined);
});

describe('FR-R6-F07 T026 — idempotent apply', () => {
  it('leaves one copy after 100 deliveries of one batch and acknowledges each repeat as a duplicate', async () => {
    const rig = await startedRig();
    const once = batch({ batchSeq: 1, items: [item(10)] });
    for (let delivery = 0; delivery < DUPLICATE_DELIVERIES; delivery += 1) rig.deliver(once);
    expect(textsOf(rig)).toEqual(['record at 10.0']);
    const duplicates = rig.acks.filter((ack) => (ack as { duplicate?: boolean }).duplicate === true);
    expect(duplicates).toHaveLength(DUPLICATE_DELIVERIES - 1);
    expect(duplicates.at(0)).toEqual({ sessionId: SESSION, batchSeq: 1, duplicate: true });
  });

  it('sends exactly one resync for a batch-number gap', async () => {
    const rig = await startedRig();
    rig.deliver(batch({ batchSeq: 1, items: [item(10)] }));
    rig.deliver(batch({ batchSeq: 3, items: [item(30)] }));
    rig.deliver(batch({ batchSeq: 4, items: [item(40)] }));
    const resyncs = rig.acks.filter((ack) => (ack as { resync?: boolean }).resync === true);
    expect(resyncs).toEqual([{ sessionId: SESSION, batchSeq: 1, resync: true }]);
    expect(textsOf(rig)).toEqual(['record at 10.0']);
  });

  it('adds nothing for a resume replay of positions already applied', async () => {
    const rig = await startedRig();
    rig.deliver(batch({ batchSeq: 1, items: [item(10), item(20), item(20, 1)] }));
    rig.deliver(batch({ batchSeq: 2, mode: 'resume', items: [item(10), item(20), item(20, 1)] }));
    expect(textsOf(rig)).toEqual(['record at 10.0', 'record at 20.0', 'record at 20.1']);
    expect(rig.acks.at(-1)).toEqual({ sessionId: SESSION, batchSeq: 2 });
  });

  it('adds nothing when a restarted tail resumes from a cursor behind the entries already shown', async () => {
    const rig = await startedRig();
    rig.deliver(batch({ batchSeq: 1, items: [item(10)], toCursor: 'cur-10' }));
    rig.deliver(batch({ batchSeq: 2, items: [item(20)] }));
    await rig.store.startTail({ selection: { ...SELECTION } });
    expect(rig.starts.at(1)?.fromCursor).toBe('cur-10');
    rig.deliver(batch({ batchSeq: 1, mode: 'resume', items: [item(20), item(30)] }));
    expect(textsOf(rig)).toEqual(['record at 10.0', 'record at 20.0', 'record at 30.0']);
  });

  it('forgets the applied position when a new read replaces the entries', async () => {
    const rig = await startedRig();
    rig.deliver(batch({ batchSeq: 1, items: [item(10), item(20)] }));
    await rig.store.reload();
    await rig.store.startTail({ selection: { ...SELECTION } });
    rig.deliver(batch({ batchSeq: 1, mode: 'resume', items: [item(10)] }));
    expect(textsOf(rig)).toEqual(['record at 10.0']);
  });

  it('clears the applied position on reset, so an earlier position shows again', async () => {
    const rig = await startedRig();
    rig.deliver(batch({ batchSeq: 1, items: [item(10), item(20)] }));
    rig.deliver(batch({ batchSeq: 2, mode: 'reset', items: [item(5)] }));
    expect(textsOf(rig)).toEqual(['record at 5.0']);
    rig.deliver(batch({ batchSeq: 3, items: [item(10)] }));
    expect(textsOf(rig)).toEqual(['record at 5.0', 'record at 10.0']);
  });
});

describe('FR-R6-F07 T026 — the applied cursor across a recreation', () => {
  it('persists the applied cursor and generation beside the selection, keeping the other keys', async () => {
    getWebviewStateMock.mockReturnValue({ isLiveMode: false, unrelated: 7 });
    const rig = await startedRig();
    rig.deliver(batch({ batchSeq: 1, items: [item(10)], toCursor: 'cur-1' }));
    expect(setWebviewStateMock).toHaveBeenLastCalledWith({
      isLiveMode: false,
      unrelated: 7,
      liveLogResume: { selection: { ...SELECTION }, cursor: 'cur-1', generation: GENERATION }
    });
    const writes = setWebviewStateMock.mock.calls.length;
    rig.deliver(batch({ batchSeq: 2, items: [item(20)] }));
    expect(setWebviewStateMock.mock.calls.length, 'a batch with no cursor writes nothing').toBe(writes);
  });

  it('passes the persisted cursor on start for the same selection only', async () => {
    getWebviewStateMock.mockReturnValue({
      liveLogResume: { selection: { ...SELECTION }, cursor: 'cur-persisted', generation: GENERATION }
    });
    const same = await startedRig();
    expect(same.starts.at(0)?.fromCursor).toBe('cur-persisted');

    const other = buildRig();
    other.store.setSelection({ ...OTHER_SELECTION }, { origin: 'cascade' });
    await other.store.reload();
    await other.store.startTail({ selection: { ...OTHER_SELECTION } });
    expect(other.starts.at(0)?.fromCursor).toBeUndefined();
  });

  it('ignores a persisted record that is not shaped as one', async () => {
    getWebviewStateMock.mockReturnValue({ liveLogResume: { selection: 'q-1', cursor: 42 } });
    const rig = await startedRig();
    expect(rig.starts.at(0)?.fromCursor).toBeUndefined();
  });
});
