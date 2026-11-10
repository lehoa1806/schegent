// FR-R6-F07 (FR-008, NFR-001) — batches stay within the batch byte bound.

import { describe, expect, it } from 'vitest';
import {
  BATCH_ENVELOPE_RESERVE_BYTES,
  BatchBuilder
} from '../../../../src/services/phase-log/live-log-batcher';
import {
  LIVE_LOG_BATCH_MAX_BYTES,
  LIVE_LOG_ENTRY_MAX_BYTES
} from '../../../../src/contracts/phase-log-bounds';

interface Item {
  readonly at: number;
  readonly n: number;
  readonly entry: { readonly text: string };
}

function item(at: number, text: string): Item {
  return { at, n: 0, entry: { text } };
}

function envelopeFor(items: readonly Item[]): string {
  return JSON.stringify({
    type: 'phase-log-batch',
    payload: {
      protocol: 1,
      tailSessionId: 's'.repeat(64),
      batchSeq: Number.MAX_SAFE_INTEGER,
      generation: 'g'.repeat(41),
      mode: 'continue',
      toCursor: 'c'.repeat(160),
      entries: items
    }
  });
}

function pack(items: readonly Item[]): Item[][] {
  const builder = new BatchBuilder<Item>(LIVE_LOG_BATCH_MAX_BYTES);
  const batches: Item[][] = [];
  for (const next of items) {
    if (builder.tryAdd(next)) continue;
    batches.push(builder.take());
    expect(builder.tryAdd(next)).toBe(true);
  }
  if (!builder.isEmpty) batches.push(builder.take());
  return batches;
}

describe('BatchBuilder (FR-R6-F07)', () => {
  it('keeps every packed batch, with its envelope, within the bound and in order', () => {
    const sizes = [10, 70_000, 200_000, 5, 130_000, 130_000, 1, 90_000, 60_000, 20_000];
    const items = sizes.map((size, index) => item(index * 10, 'é'.repeat(size / 2)));
    const batches = pack(items);
    expect(batches.flat()).toEqual(items);
    for (const batch of batches) {
      expect(Buffer.byteLength(envelopeFor(batch), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_BATCH_MAX_BYTES);
    }
  });

  it('always accepts one entry at the entry bound into an empty batch', () => {
    const builder = new BatchBuilder<Item>(LIVE_LOG_BATCH_MAX_BYTES);
    const filler = 'x'.repeat(LIVE_LOG_ENTRY_MAX_BYTES - '{"text":""}'.length);
    const big = item(1, filler);
    expect(builder.tryAdd(big)).toBe(true);
    expect(builder.tryAdd(item(2, 'm'.repeat(1000)))).toBe(false);
    expect(Buffer.byteLength(envelopeFor(builder.take()), 'utf8')).toBeLessThanOrEqual(
      LIVE_LOG_BATCH_MAX_BYTES
    );
  });

  it('reports its size and empties on take', () => {
    const builder = new BatchBuilder<Item>(LIVE_LOG_BATCH_MAX_BYTES);
    expect(builder.isEmpty).toBe(true);
    expect(builder.bytes).toBe(BATCH_ENVELOPE_RESERVE_BYTES);
    builder.tryAdd(item(1, 'a'));
    expect(builder.isEmpty).toBe(false);
    expect(builder.bytes).toBeGreaterThan(BATCH_ENVELOPE_RESERVE_BYTES);
    expect(builder.take()).toHaveLength(1);
    expect(builder.isEmpty).toBe(true);
    expect(builder.bytes).toBe(BATCH_ENVELOPE_RESERVE_BYTES);
  });

  it('reserves room for the largest envelope a batch can carry', () => {
    expect(Buffer.byteLength(envelopeFor([]), 'utf8')).toBeLessThanOrEqual(BATCH_ENVELOPE_RESERVE_BYTES);
    expect(LIVE_LOG_ENTRY_MAX_BYTES + BATCH_ENVELOPE_RESERVE_BYTES).toBeLessThanOrEqual(
      LIVE_LOG_BATCH_MAX_BYTES
    );
  });
});
