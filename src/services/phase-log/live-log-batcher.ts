// FR-R6-F07 (FR-008, NFR-001) — packs batch items within the batch byte bound.
//
// A batch's size is the reserved envelope bound plus the exact serialized
// length of each item and one separator byte. The reserve covers the largest
// envelope a batch can carry: the message type, the protocol, a session id, a
// sequence number up to 2^53, a generation of three 13-character parts, the
// mode and a 160-character cursor. An empty batch always takes one item, and
// one budgeted entry plus its position and the reserve fits the bound:
// LIVE_LOG_ENTRY_MAX_BYTES leaves LIVE_LOG_ENTRY_ENVELOPE_RESERVE_BYTES, and
// this reserve plus an item's position fields stays inside it.

export const BATCH_ENVELOPE_RESERVE_BYTES = 640;
const SEPARATOR_BYTES = 1;

export class BatchBuilder<T> {
  private items: T[] = [];
  private size = BATCH_ENVELOPE_RESERVE_BYTES;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** The bound on the batch's serialized size, envelope included. */
  get bytes(): number {
    return this.size;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Adds `item` when it fits, or when the batch is empty. */
  tryAdd(item: T): boolean {
    // `JSON.stringify` returns undefined for a bare `undefined`; its declared type does not say so.
    const json = JSON.stringify(item) as string | undefined;
    const itemBytes = Buffer.byteLength(json ?? '', 'utf8') + SEPARATOR_BYTES;
    if (!this.isEmpty && this.size + itemBytes > this.maxBytes) return false;
    this.items.push(item);
    this.size += itemBytes;
    return true;
  }

  take(): T[] {
    const taken = this.items;
    this.items = [];
    this.size = BATCH_ENVELOPE_RESERVE_BYTES;
    return taken;
  }
}
