import { ensureHistoryEntry, type HistoryEntry } from './history-entry';
import type { RunOutputRecord } from '../contracts/run-results';
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

  /**
   * Feature 091 (T014, FR-010/FR-011) — what a previously completed Run recorded
   * about its declared outputs. This is the source behind the command router's
   * `readPriorRunOutputs`.
   *
   * `null` means there is no such Run — it never existed, or it has aged past
   * `HISTORY_CAP`. An empty array means the Run is known and recorded nothing.
   * The two are different answers and the caller refuses differently
   * (`prior-run-not-found` versus `prior-output-not-found`), so this must not
   * collapse them: returning `[]` for an absent entry would tell an operator
   * their Run identifier was fine and their output name was wrong.
   */
  public outputsFor(runId: string): readonly RunOutputRecord[] | null {
    const entry = this.list().find((candidate) => candidate.runId === runId);
    if (entry === undefined) return null;
    return entry.runOutputs ?? [];
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
