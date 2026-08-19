import { ensureHistoryEntry, type HistoryEntry, type HistoryRecord } from './history-entry';
import type { RunOutputRecord } from '../contracts/run-results';
import {
  KEYS,
  type Disposable,
  type PersistedHistoryEntry,
  type WorkspaceStateStore
} from './workspace-state';

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

  /**
   * Every queue's history, newest first.
   *
   * FR-R3-010 (T404) removed the `entries.slice(-HISTORY_CAP)` that used to
   * stand here. The cap is applied at the write site and nowhere else: a second
   * application on read is not a safety net, it is a second policy — it hid
   * whatever the write site retained beyond it, so raising the write cap did
   * nothing until someone noticed the reader was also capping, and it made the
   * flat 50 look like it was enforced twice when in fact the two were free to
   * disagree.
   *
   * Sorted across partitions by completion time, because a fold in map-key
   * order would group by queue and read as a shuffled list to an operator who
   * expects a chronology. Ties keep the order the fold produced, which is
   * stable for a given map.
   */
  public list(): readonly HistoryRecord[] {
    const entries = this.readAll();
    return entries.sort(
      (a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)
    );
  }

  /**
   * One queue's history, newest first.
   *
   * The read that partitioning exists for. An unknown queue id returns empty
   * rather than throwing — a queue that has completed nothing and a queue that
   * does not exist look the same to history, and there is nothing here that
   * could tell them apart without reaching for the registry.
   */
  public listForQueue(queueId: string): readonly HistoryRecord[] {
    return this.normalize(queueId, this.store.getHistoryMap()[queueId] ?? []).sort(
      (a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)
    );
  }

  /**
   * Append one entry to `queueId`'s partition, returning what the cap evicted.
   *
   * The queue is named rather than inferred. `HistoryRecorder` resolves it from
   * the Task row and falls back to the documented unattributed partition when
   * the row is gone; inferring it here would mean re-deriving that decision at
   * a layer that has no queue manager to ask.
   */
  public async append(
    queueId: string,
    entry: HistoryEntry
  ): Promise<readonly PersistedHistoryEntry[]> {
    return this.store.appendHistory(queueId, entry);
  }

  /**
   * Feature 091 (T014, FR-010/FR-011) — what a previously completed Run recorded
   * about its declared outputs. This is the source behind the command router's
   * `readPriorRunOutputs`.
   *
   * `null` means there is no such Run — it never existed, or it has aged past
   * its queue's retention. An empty array means the Run is known and recorded
   * nothing. The two are different answers and the caller refuses differently
   * (`prior-run-not-found` versus `prior-output-not-found`), so this must not
   * collapse them: returning `[]` for an absent entry would tell an operator
   * their Run identifier was fine and their output name was wrong.
   *
   * Reads across every partition. A `prior-output` reference names a run id and
   * nothing else, so restricting the search to one queue would make a reference
   * resolvable or not depending on which queue happened to run the work.
   */
  public outputsFor(runId: string): readonly RunOutputRecord[] | null {
    const entry = this.readAll().find((candidate) => candidate.runId === runId);
    if (entry === undefined) return null;
    return entry.runOutputs ?? [];
  }

  /**
   * The entry for `runId`, together with the queue it was filed under.
   *
   * FR-R3-010 (T408/T410) — the drill-down's lookup. It returns a
   * `HistoryRecord` rather than a bare entry because every caller that resolves
   * a pointer also reports which queue the run belonged to, and re-deriving
   * that from a second `list()` scan is how the two come to disagree.
   */
  public findByRunId(runId: string): HistoryRecord | null {
    return this.readAll().find((candidate) => candidate.runId === runId) ?? null;
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

  /** Every partition's normalised entries, in map order. Unsorted. */
  private readAll(): HistoryRecord[] {
    const records: HistoryRecord[] = [];
    for (const [queueId, raws] of Object.entries(this.store.getHistoryMap())) {
      records.push(...this.normalize(queueId, raws));
    }
    return records;
  }

  private normalize(queueId: string, raws: readonly PersistedHistoryEntry[]): HistoryRecord[] {
    const records: HistoryRecord[] = [];
    for (const raw of raws) {
      const entry = ensureHistoryEntry(raw, queueId);
      if (entry) records.push(entry);
    }
    return records;
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
