/**
 * FR-R6-F14 (FR-005, FR-019; research R8) — the ledger port held in memory: the export copy
 * identities that make a re-offered record a duplicate, and the most recent delivery receipts
 * and batch dispositions. It lasts one exporter lifetime; a durable ledger is owed by F14-B.
 *
 * It holds identities, receipts and dispositions only: no source record and no request body.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  TELEMETRY_EXPORT_BOUNDS,
  type BatchTerminalState,
  type DeliveryReceipt,
  type DropReason,
  type ExpiryReason,
  type TelemetryLedgerPort
} from '../../contracts/telemetry-export';

export interface BatchDisposition {
  readonly batchId: string;
  readonly state: BatchTerminalState;
  readonly reason: ExpiryReason | DropReason | null;
}

export interface InMemoryLedger extends TelemetryLedgerPort {
  copyCount(): number;
  /** The most recent receipts, oldest first. */
  receipts(): readonly DeliveryReceipt[];
  /** The most recent dispositions, oldest first. */
  dispositions(): readonly BatchDisposition[];
}

export interface InMemoryLedgerOptions {
  readonly rememberedCopiesMax?: number;
  readonly entriesKeptMax?: number;
}

/** How many receipts, and how many dispositions, the ledger keeps. */
export const LEDGER_ENTRIES_KEPT_MAX = 256;

function appendBounded<T>(entries: readonly T[], entry: T, max: number): readonly T[] {
  const next = [...entries, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function createInMemoryLedger(options: InMemoryLedgerOptions = {}): InMemoryLedger {
  const copiesMax = options.rememberedCopiesMax ?? TELEMETRY_EXPORT_BOUNDS.rememberedCopiesMax;
  const entriesMax = options.entriesKeptMax ?? LEDGER_ENTRIES_KEPT_MAX;
  const copies = new Set<string>();
  /**
   * The remembered identities in a ring: once it is full, `oldest` is the place of the oldest
   * one, which the next new identity takes. Forgetting costs the same however many are held.
   */
  const ring: string[] = [];
  let oldest = 0;
  let receipts: readonly DeliveryReceipt[] = [];
  let dispositions: readonly BatchDisposition[] = [];

  return {
    rememberCopy(copyId) {
      if (copies.has(copyId)) return 'duplicate';
      if (!(copiesMax >= 1)) return 'new';
      copies.add(copyId);
      if (ring.length < copiesMax) {
        ring.push(copyId);
        return 'new';
      }
      const forgotten = ring.splice(oldest, 1, copyId).at(0);
      if (forgotten !== undefined) copies.delete(forgotten);
      oldest = oldest + 1 < ring.length ? oldest + 1 : 0;
      return 'new';
    },
    recordReceipt(receipt) {
      receipts = appendBounded(receipts, Object.freeze({ ...receipt }), entriesMax);
    },
    recordDisposition(batchId, state, reason) {
      dispositions = appendBounded(dispositions, Object.freeze({ batchId, state, reason }), entriesMax);
    },
    copyCount() {
      return copies.size;
    },
    receipts() {
      return receipts;
    },
    dispositions() {
      return dispositions;
    }
  };
}
