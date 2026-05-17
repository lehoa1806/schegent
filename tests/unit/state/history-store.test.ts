import { describe, it, expect, beforeEach } from 'vitest';
import {
  HISTORY_CAP,
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
  it('append rolls oldest at cap of 50', async () => {
    expect(HISTORY_CAP).toBe(50);
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      await history.append(makeEntry(i));
    }
    const list = history.list();
    expect(list).toHaveLength(HISTORY_CAP);
    const ids = list.map((e) => e.runId);
    expect(ids).not.toContain('run-0');
    expect(ids).not.toContain('run-4');
    expect(ids).toContain('run-5');
    expect(ids).toContain(`run-${HISTORY_CAP + 4}`);
  });

  it('list() is reverse-chronological (newest first)', async () => {
    await history.append(makeEntry(1));
    await history.append(makeEntry(2));
    await history.append(makeEntry(3));
    const list = history.list();
    expect(list.map((e) => e.runId)).toEqual(['run-3', 'run-2', 'run-1']);
  });

  it('subscribe is invoked exactly once per append', async () => {
    let calls = 0;
    const sub = history.subscribe(() => {
      calls++;
    });
    await history.append(makeEntry(1));
    await history.append(makeEntry(2));
    expect(calls).toBe(2);
    sub.dispose();
  });

  it('rehydrates persisted entries on a fresh store instance', async () => {
    await history.append(makeEntry(1));
    await history.append(makeEntry(2));
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
