// FR-R6-F14 T015 — the in-memory ledger: duplicate detection over a bounded set of copy
// identities, and bounded lists of receipts and dispositions (FR-005, FR-019).
import { describe, expect, it } from 'vitest';

import { TELEMETRY_EXPORT_BOUNDS, type DeliveryReceipt } from '../../../src/contracts/telemetry-export';
import { LEDGER_ENTRIES_KEPT_MAX, createInMemoryLedger } from '../../../src/services/telemetry-export/in-memory-ledger';

function receipt(attemptId: string): DeliveryReceipt {
  return { batchId: 'batch-1', attemptId, at: 1, outcome: 'acknowledged', statusCode: 200, rejectedDataPoints: 0, errorClass: null };
}

describe('in-memory ledger', () => {
  it('reports a copy identity new once and duplicate after', () => {
    const ledger = createInMemoryLedger();
    expect(ledger.rememberCopy('copy-a')).toBe('new');
    expect(ledger.rememberCopy('copy-a')).toBe('duplicate');
    expect(ledger.rememberCopy('copy-b')).toBe('new');
    expect(ledger.copyCount()).toBe(2);
  });

  it('remembers the most recent 16,384 identities and forgets the oldest', () => {
    const max = TELEMETRY_EXPORT_BOUNDS.rememberedCopiesMax;
    expect(max).toBe(16_384);
    const ledger = createInMemoryLedger();
    for (let index = 0; index < max; index += 1) ledger.rememberCopy(`copy-${String(index)}`);
    expect(ledger.copyCount()).toBe(max);
    expect(ledger.rememberCopy('copy-0')).toBe('duplicate');
    expect(ledger.rememberCopy('copy-next')).toBe('new');
    expect(ledger.copyCount()).toBe(max);
    expect(ledger.rememberCopy('copy-1')).toBe('duplicate');
    expect(ledger.rememberCopy('copy-0')).toBe('new');
  });

  it('forgets in the order of first sight, round after round, and a repeat does not renew a copy', () => {
    const ledger = createInMemoryLedger({ rememberedCopiesMax: 3 });
    const results: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(ledger.rememberCopy(`copy-${String(index)}`));
      // Seeing the oldest kept copy again does not move it to the back of the line.
      if (index >= 2) results.push(ledger.rememberCopy(`copy-${String(index - 2)}`));
    }
    expect(results.filter((result) => result === 'new')).toHaveLength(10);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(8);
    expect(ledger.copyCount()).toBe(3);
    // The last three are kept; each earlier one was forgotten and is new again.
    expect(['copy-7', 'copy-8', 'copy-9'].map((copy) => ledger.rememberCopy(copy))).toEqual(['duplicate', 'duplicate', 'duplicate']);
    // Each new copy pushes out the oldest kept one: 6 pushes out 7, then 7 pushes out 8.
    expect(ledger.rememberCopy('copy-6')).toBe('new');
    expect(ledger.rememberCopy('copy-7')).toBe('new');
    expect(ledger.rememberCopy('copy-9')).toBe('duplicate');
    expect(ledger.rememberCopy('copy-8')).toBe('new');
    expect(ledger.copyCount()).toBe(3);
  });

  it('remembers nothing when it may keep no identity', () => {
    const ledger = createInMemoryLedger({ rememberedCopiesMax: 0 });
    expect(ledger.rememberCopy('copy-a')).toBe('new');
    expect(ledger.rememberCopy('copy-a')).toBe('new');
    expect(ledger.copyCount()).toBe(0);
  });

  it('keeps the most recent receipts and dispositions, oldest first', () => {
    const ledger = createInMemoryLedger({ entriesKeptMax: 3 });
    for (const id of ['a', 'b', 'c', 'd']) {
      ledger.recordReceipt(receipt(id));
      ledger.recordDisposition(id, 'dropped', 'rejected');
    }
    expect(ledger.receipts().map((entry) => entry.attemptId)).toEqual(['b', 'c', 'd']);
    expect(ledger.dispositions()).toEqual([
      { batchId: 'b', state: 'dropped', reason: 'rejected' },
      { batchId: 'c', state: 'dropped', reason: 'rejected' },
      { batchId: 'd', state: 'dropped', reason: 'rejected' }
    ]);
  });

  it('keeps 256 of each by default', () => {
    const ledger = createInMemoryLedger();
    for (let index = 0; index < LEDGER_ENTRIES_KEPT_MAX + 10; index += 1) {
      ledger.recordReceipt(receipt(`attempt-${String(index)}`));
      ledger.recordDisposition(`batch-${String(index)}`, 'acknowledged', null);
    }
    expect(LEDGER_ENTRIES_KEPT_MAX).toBe(256);
    expect(ledger.receipts()).toHaveLength(256);
    expect(ledger.dispositions()).toHaveLength(256);
    expect(ledger.receipts().at(0)?.attemptId).toBe('attempt-10');
  });

  it('stores a copy of a receipt that later edits of the original cannot change', () => {
    const ledger = createInMemoryLedger();
    const original = { ...receipt('a') };
    ledger.recordReceipt(original);
    original.rejectedDataPoints = 99;
    expect(ledger.receipts().at(0)?.rejectedDataPoints).toBe(0);
    expect(Object.isFrozen(ledger.receipts().at(0))).toBe(true);
  });
});
