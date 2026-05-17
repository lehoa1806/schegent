import { ensureHistoryEntry, type HistoryEntry } from './history-entry';
import { HISTORY_CAP, KEYS, type Disposable, type WorkspaceStateStore } from './workspace-state';

export type HistoryListener = () => void;

export class HistoryStore {
  private readonly store: WorkspaceStateStore;
  private readonly listeners = new Set<HistoryListener>();
  private readonly subscription: Disposable;

  constructor(store: WorkspaceStateStore) {
    this.store = store;
    this.subscription = this.store.subscribe((key) => {
      if (key === KEYS.history) {
        this.fire();
      }
    });
  }

  public list(): readonly HistoryEntry[] {
    const persisted = this.store.getHistory();
    const entries: HistoryEntry[] = [];
    for (const raw of persisted) {
      const entry = ensureHistoryEntry(raw);
      if (entry) entries.push(entry);
    }
    const capped = entries.slice(-HISTORY_CAP);
    return capped.slice().reverse();
  }

  public async append(entry: HistoryEntry): Promise<void> {
    await this.store.appendHistory(entry);
  }

  public subscribe(listener: HistoryListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  public dispose(): void {
    this.listeners.clear();
    this.subscription.dispose();
  }

  private fire(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // listener errors must not propagate
      }
    }
  }
}
