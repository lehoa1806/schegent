// The live tail bound through the store (FR-R4-F08, contract L: L-T2; FR-006, FR-007, FR-009).
//
// WHAT THIS PINS. Pushes delivered through the store's `handlePush` keep the
// entries it shows at no more than 500 rows: the newest 499 entries and one
// `truncated-head` marker whose `droppedEntryCount` equals every entry received
// and not shown, the host read's own dropped count included. A push for a stale
// session changes nothing, a `tail-ended` terminator after a trim keeps the
// marker, and a re-read starts from the new read's own marker.
//
// FIXTURE. The store's two seams are injected: a read that returns a scripted
// manifest, and a tail whose `subscribe` captures the push callback the host
// would drive. The `vscode-api` and `phase-log-ipc` modules are mocked as
// `phase-log-store.live-mode.test.ts` does, so the module imports under jsdom.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';

vi.mock('../vscode-api', () => ({
  getWebviewState: () => undefined,
  setWebviewState: () => undefined,
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

const SESSION = 's-window';
const SELECTION = {
  queueId: 'q-1',
  taskId: 't-1',
  pipelineId: 'p-1',
  phaseId: 'ph-1',
  iterationN: 1
} as const;
const READ_CAP = 500;

function entry(seq: number, kind: PhaseLogDisplayEntry['kind'] = 'assistant-text'): PhaseLogDisplayEntry {
  return Object.freeze({ seq, kind, ts: null, body: { text: `entry ${seq}` }, bodyTruncated: null });
}

function manifestOf(entries: readonly PhaseLogDisplayEntry[]) {
  return {
    outcome: 'success' as const,
    manifest: {
      iterations: [1],
      selectedIteration: 1,
      entries,
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: null,
      isInFlight: true
    }
  };
}

/** A capped read as the host builds it: a marker at index 0, then the newest `READ_CAP - 1`. */
function cappedRead(dropped: number): readonly PhaseLogDisplayEntry[] {
  const marker: PhaseLogDisplayEntry = Object.freeze({
    seq: 0,
    kind: 'truncated-head',
    ts: null,
    body: { droppedEntryCount: dropped },
    bodyTruncated: null
  });
  const real = Array.from({ length: READ_CAP - 1 }, (_, index) => entry(index + 1));
  return [marker, ...real];
}

interface Rig {
  readonly store: ReturnType<typeof createPhaseLogStore>;
  readonly pushEntry: (sessionId: string, entry: PhaseLogDisplayEntry) => void;
  readonly setRead: (entries: readonly PhaseLogDisplayEntry[]) => void;
}

async function buildRig(initial: readonly PhaseLogDisplayEntry[]): Promise<Rig> {
  let current = initial;
  // A one-slot array: the write happens inside the `subscribe` closure, which flow analysis does not see.
  const captured: ((payload: unknown) => void)[] = [];
  const store = createPhaseLogStore(
    async () => manifestOf(current) as never,
    {
      start: async () => ({ outcome: 'success', sessionId: SESSION, mechanism: 'fs.watch' }),
      stop: async () => ({ outcome: 'success', sessionId: SESSION }),
      ack: () => undefined,
      subscribe: (callback: (payload: never) => void) => {
        captured.push(callback as (payload: unknown) => void);
        return () => {
          captured.length = 0;
        };
      }
    } as never
  );
  store.setSelection({ ...SELECTION }, { origin: 'cascade' });
  await store.reload();
  await store.startTail({ selection: { ...SELECTION } });
  const push = captured.at(0);
  if (push === undefined) throw new Error('startTail did not subscribe, so no push could be delivered');
  // FR-R6-F07 — each entry arrives as the one-entry `continue` batch that carries it, numbered
  // in arrival order as the host numbers batches.
  let batchSeq = 0;
  const pushEntry = (sessionId: string, delivered: PhaseLogDisplayEntry): void => {
    batchSeq += 1;
    push({
      protocol: 1,
      tailSessionId: sessionId,
      batchSeq,
      generation: 'g-1',
      mode: 'continue',
      toCursor: null,
      entries: [{ at: batchSeq, n: 0, entry: delivered }]
    });
  };
  return { store, pushEntry, setRead: (entries) => { current = entries; } };
}

function deliver(rig: Rig, firstSeq: number, count: number, sessionId = SESSION): void {
  for (let seq = firstSeq; seq < firstSeq + count; seq += 1) {
    rig.pushEntry(sessionId, entry(seq));
  }
}

function markerOf(rig: Rig): PhaseLogDisplayEntry | undefined {
  const first = rig.store.state.entries.at(0);
  return first !== undefined && first.kind === 'truncated-head' ? first : undefined;
}

beforeEach(() => {
  __resetLiveModeForTests();
});

describe('L-T2 5,000 pushes keep the tail at no more than 500 rows', () => {
  it('shows 500 rows, one marker counting the rest, and the newest entry last', async () => {
    const rig = await buildRig([]);
    deliver(rig, 1, 5_000);
    const shown = rig.store.state.entries;
    expect(shown.length).toBeLessThanOrEqual(READ_CAP);
    expect(shown.length).toBe(READ_CAP);
    expect(shown.filter((candidate) => candidate.kind === 'truncated-head').length).toBe(1);
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(5_000 - (READ_CAP - 1));
    expect(shown.at(-1)?.seq).toBe(5_000);
    expect(new Set(shown.map((candidate) => candidate.seq)).size).toBe(shown.length);
  });

  it('below the cap shows every pushed entry and no marker', async () => {
    const rig = await buildRig([]);
    deliver(rig, 1, 10);
    expect(rig.store.state.entries.length).toBe(10);
    expect(markerOf(rig)).toBeUndefined();
  });
});

describe('L-T2 a capped read plus live pushes', () => {
  it('a marker of 42 plus 1,000 pushes gives 42 plus the live trims', async () => {
    const rig = await buildRig(cappedRead(42));
    expect(rig.store.state.entries.length).toBe(READ_CAP);
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(42);
    deliver(rig, 1_000, 1_000);
    expect(rig.store.state.entries.length).toBe(READ_CAP);
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(42 + 1_000);
    expect(rig.store.state.entries.at(-1)?.seq).toBe(1_999);
  });
});

describe('L-T2 pushes that must change nothing', () => {
  it('a push with a stale tailSessionId changes neither the entries nor the marker', async () => {
    const rig = await buildRig(cappedRead(42));
    const before = rig.store.state.entries;
    deliver(rig, 9_000, 25, 's-stale');
    expect(rig.store.state.entries).toBe(before);
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(42);
  });

  it('tail-ended after a trim keeps the marker and appends nothing', async () => {
    const rig = await buildRig([]);
    deliver(rig, 1, 600);
    const countBefore = markerOf(rig)?.body.droppedEntryCount;
    expect(countBefore).toBe(600 - (READ_CAP - 1));
    rig.pushEntry(SESSION, entry(601, 'tail-ended'));
    expect(rig.store.state.tailSessionId).toBeNull();
    expect(rig.store.state.entries.length).toBe(READ_CAP);
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(countBefore);
  });
});

describe('L-T2 the trim count belongs to the selection shown', () => {
  it('a selection change drops the window and its count, and the next read starts clean', async () => {
    const rig = await buildRig([]);
    deliver(rig, 1, 800);
    expect(markerOf(rig)?.body.droppedEntryCount, 'the control: the window had trimmed').toBe(800 - (READ_CAP - 1));

    rig.setRead([entry(1), entry(2)]);
    rig.store.setSelection({ ...SELECTION, iterationN: 2 }, { origin: 'cascade' });
    expect(rig.store.state.entries, 'the previous session\'s entries and count are gone at once').toEqual([]);
    expect(markerOf(rig)).toBeUndefined();

    await rig.store.reload();
    expect(rig.store.state.entries.length).toBe(2);
    expect(markerOf(rig), 'no count is carried over from the earlier selection').toBeUndefined();
  });
});

describe('L-T2 a re-read', () => {
  it('starts from the new read\'s marker, not the window\'s', async () => {
    const rig = await buildRig([]);
    deliver(rig, 1, 800);
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(800 - (READ_CAP - 1));
    rig.setRead(cappedRead(7));
    await rig.store.reload();
    expect(markerOf(rig)?.body.droppedEntryCount).toBe(7);
    expect(rig.store.state.entries.length).toBe(READ_CAP);
  });
});
