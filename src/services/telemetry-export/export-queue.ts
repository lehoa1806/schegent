/**
 * FR-R6-F14 (FR-010; NFR-001) — the sealed batches waiting for delivery, in arrival order,
 * under a byte bound. When a new batch does not fit, the oldest batch that is not being sent
 * is dropped; the bound counts the encoded bytes, so `bytes()` never passes it.
 *
 * In memory only. An entry is replaced, never edited, so a batch a caller holds does not change.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { TELEMETRY_EXPORT_BOUNDS } from '../../contracts/telemetry-export';

export type QueuedBatchState = 'queued' | 'sending' | 'retrying';

export interface SealedBatch {
  readonly batchId: string;
  /** The encoded request; these bytes never change, and a retry sends them again. */
  readonly body: Uint8Array;
  readonly sealedAt: number;
  /** A batch is sent only under the authorization generation it was sealed under. */
  readonly authorizationGeneration: number;
  /** How many source records the batch carries. */
  readonly records: number;
}

export interface QueuedBatch extends SealedBatch {
  readonly state: QueuedBatchState;
  readonly attemptsMade: number;
  readonly firstAttemptAt: number | null;
}

export interface ExportQueueOptions {
  readonly bytesMax?: number;
  readonly expiryMs?: number;
}

export interface ExportQueue {
  /** Adds the batch and returns the batches dropped to make room, the new one included if it cannot fit. */
  enqueue(batch: SealedBatch): readonly QueuedBatch[];
  head(): QueuedBatch | undefined;
  /** Marks the batch as being sent and counts the attempt. */
  beginAttempt(batchId: string, now: number): QueuedBatch | undefined;
  /** Marks the batch as waiting for its next attempt. */
  awaitRetry(batchId: string): void;
  remove(batchId: string): QueuedBatch | undefined;
  /** Removes and returns the batches older than the expiry that are not being sent. */
  takeExpired(now: number): readonly QueuedBatch[];
  /** Removes and returns every batch. */
  drain(): readonly QueuedBatch[];
  size(): number;
  bytes(): number;
}

export function createExportQueue(options: ExportQueueOptions = {}): ExportQueue {
  const bytesMax = options.bytesMax ?? TELEMETRY_EXPORT_BOUNDS.memoryQueueBytes;
  const expiryMs = options.expiryMs ?? TELEMETRY_EXPORT_BOUNDS.copyExpiryMs;
  let batches: readonly QueuedBatch[] = [];
  let totalBytes = 0;

  function setBatches(next: readonly QueuedBatch[]): void {
    batches = next;
    totalBytes = next.reduce((sum, batch) => sum + batch.body.byteLength, 0);
  }

  function replace(batchId: string, change: (batch: QueuedBatch) => QueuedBatch): QueuedBatch | undefined {
    let changed: QueuedBatch | undefined;
    setBatches(
      batches.map((batch) => {
        if (batch.batchId !== batchId) return batch;
        changed = change(batch);
        return changed;
      })
    );
    return changed;
  }

  function takeWhere(matches: (batch: QueuedBatch) => boolean): readonly QueuedBatch[] {
    const taken = batches.filter(matches);
    if (taken.length > 0) setBatches(batches.filter((batch) => !matches(batch)));
    return taken;
  }

  return {
    enqueue(batch) {
      const added: QueuedBatch = { ...batch, state: 'queued', attemptsMade: 0, firstAttemptAt: null };
      const dropped: QueuedBatch[] = [];
      let kept = batches;
      let keptBytes = totalBytes;
      while (keptBytes + added.body.byteLength > bytesMax) {
        const oldest = kept.find((candidate) => candidate.state !== 'sending');
        if (oldest === undefined) {
          setBatches(kept);
          return [...dropped, added];
        }
        dropped.push(oldest);
        kept = kept.filter((candidate) => candidate !== oldest);
        keptBytes -= oldest.body.byteLength;
      }
      setBatches([...kept, added]);
      return dropped;
    },
    head() {
      return batches.at(0);
    },
    beginAttempt(batchId, now) {
      return replace(batchId, (batch) => ({
        ...batch,
        state: 'sending',
        attemptsMade: batch.attemptsMade + 1,
        firstAttemptAt: batch.firstAttemptAt ?? now
      }));
    },
    awaitRetry(batchId) {
      replace(batchId, (batch) => ({ ...batch, state: 'retrying' }));
    },
    remove(batchId) {
      return takeWhere((batch) => batch.batchId === batchId).at(0);
    },
    takeExpired(now) {
      return takeWhere((batch) => batch.state !== 'sending' && now - batch.sealedAt > expiryMs);
    },
    drain() {
      return takeWhere(() => true);
    },
    size() {
      return batches.length;
    },
    bytes() {
      return totalBytes;
    }
  };
}
