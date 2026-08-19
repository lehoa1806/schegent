import { describe, it, expect, beforeEach } from 'vitest';
import {
  HISTORY_CAP_PER_QUEUE,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { HistoryStore } from '../../../src/state/history-store';
import type { HistoryEntry } from '../../../src/state/history-entry';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function makeEntry(seq: number, terminalStatus: HistoryEntry['terminalStatus'] = 'completed'): HistoryEntry {
  const startedMs = 1_700_000_000_000 + seq * 1_000;
  const completedMs = startedMs + 500;
  return {
    runId: `run-${seq}`,
    featureId: `feat-${seq}`,
    descriptionPreview: `desc ${seq}`,
    terminalStatus,
    startedAt: new Date(startedMs).toISOString(),
    completedAt: new Date(completedMs).toISOString(),
    durationMs: 500,
    lastErrorSummary: null,
    auditLogPointer: `runId:run-${seq}`
  };
}

/**
 * FR-R3-010 (T402) — every append names its partition. These cases exercise one
 * queue, so they share a constant; the cross-partition behaviour has its own
 * file in `history-partition.test.ts`.
 */
const QUEUE = 'default';

let memento: FakeMemento;
let store: WorkspaceStateStore;
let history: HistoryStore;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  history = new HistoryStore(store);
});

describe('HistoryStore', () => {
  it('append rolls oldest at cap of 50 per queue', async () => {
    expect(HISTORY_CAP_PER_QUEUE).toBe(50);
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE + 5; i++) {
      await history.append(QUEUE, makeEntry(i));
    }
    const list = history.list();
    expect(list).toHaveLength(HISTORY_CAP_PER_QUEUE);
    const ids = list.map((e) => e.runId);
    expect(ids).not.toContain('run-0');
    expect(ids).not.toContain('run-4');
    expect(ids).toContain('run-5');
    expect(ids).toContain(`run-${HISTORY_CAP_PER_QUEUE + 4}`);
  });

  it('append returns what the cap evicted, so the caller can clean up after it', async () => {
    // The evicted rows are how `HistoryRecorder` knows which description files
    // to remove. Without them the on-disk set grows for the life of the
    // workspace while the memento stays bounded — the same amplification this
    // feature removed, one layer down.
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE; i++) {
      expect(await history.append(QUEUE, makeEntry(i))).toEqual([]);
    }
    const evicted = await history.append(QUEUE, makeEntry(HISTORY_CAP_PER_QUEUE));
    expect(evicted).toHaveLength(1);
    expect((evicted[0] as { runId: string }).runId).toBe('run-0');
  });

  it('list() is reverse-chronological (newest first)', async () => {
    await history.append(QUEUE, makeEntry(1));
    await history.append(QUEUE, makeEntry(2));
    await history.append(QUEUE, makeEntry(3));
    const list = history.list();
    expect(list.map((e) => e.runId)).toEqual(['run-3', 'run-2', 'run-1']);
  });

  it('subscribe is invoked exactly once per append', async () => {
    let calls = 0;
    const sub = history.subscribe(() => {
      calls++;
    });
    await history.append(QUEUE, makeEntry(1));
    await history.append(QUEUE, makeEntry(2));
    expect(calls).toBe(2);
    sub.dispose();
  });

  it('rehydrates persisted entries on a fresh store instance', async () => {
    await history.append(QUEUE, makeEntry(1));
    await history.append(QUEUE, makeEntry(2));
    const reborn = new WorkspaceStateStore(memento);
    await reborn.initialize();
    const reHistory = new HistoryStore(reborn);
    const list = reHistory.list();
    expect(list).toHaveLength(2);
    expect(list[0].runId).toBe('run-2');
    expect(list[1].runId).toBe('run-1');
    reHistory.dispose();
  });
});
