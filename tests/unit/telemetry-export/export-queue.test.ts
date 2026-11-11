// FR-R6-F14 T015 — the sealed-batch queue: arrival order, the byte bound and which batch is
// dropped at saturation, age expiry, and entries that never change in a caller's hands
// (FR-010; NFR-001).
import { describe, expect, it } from 'vitest';

import { TELEMETRY_EXPORT_BOUNDS } from '../../../src/contracts/telemetry-export';
import { createExportQueue, type SealedBatch } from '../../../src/services/telemetry-export/export-queue';

function sealed(batchId: string, bytes: number, sealedAt = 0): SealedBatch {
  return { batchId, body: new Uint8Array(bytes), sealedAt, authorizationGeneration: 1, records: 1 };
}

function idsOf(batches: readonly { batchId: string }[]): string[] {
  return batches.map((batch) => batch.batchId);
}

describe('export queue', () => {
  it('holds batches in arrival order and counts their bytes', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    expect(queue.head()).toBeUndefined();
    expect(queue.enqueue(sealed('a', 10))).toEqual([]);
    expect(queue.enqueue(sealed('b', 20))).toEqual([]);
    expect(queue.head()).toMatchObject({ batchId: 'a', state: 'queued', attemptsMade: 0, firstAttemptAt: null });
    expect(queue.size()).toBe(2);
    expect(queue.bytes()).toBe(30);
  });

  it('drops the oldest batches to make room and never passes the bound', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 40));
    queue.enqueue(sealed('b', 40));
    queue.enqueue(sealed('c', 20));
    expect(queue.bytes()).toBe(100);
    expect(idsOf(queue.enqueue(sealed('d', 50)))).toEqual(['a', 'b']);
    expect(idsOf([queue.head() ?? sealed('none', 0)])).toEqual(['c']);
    expect(queue.bytes()).toBe(70);
  });

  it('keeps the batch being sent and drops the next oldest', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 40));
    queue.enqueue(sealed('b', 40));
    queue.beginAttempt('a', 5);
    expect(idsOf(queue.enqueue(sealed('c', 40)))).toEqual(['b']);
    expect(queue.head()).toMatchObject({ batchId: 'a', state: 'sending' });
    expect(queue.bytes()).toBe(80);
  });

  it('drops a batch waiting for its retry like any other that is not being sent', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 60));
    queue.beginAttempt('a', 5);
    queue.awaitRetry('a');
    expect(idsOf(queue.enqueue(sealed('b', 60)))).toEqual(['a']);
    expect(queue.head()).toMatchObject({ batchId: 'b' });
  });

  it('drops the new batch itself when only the batch being sent could make room', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 60));
    queue.beginAttempt('a', 5);
    expect(idsOf(queue.enqueue(sealed('b', 60)))).toEqual(['b']);
    expect(queue.size()).toBe(1);
    expect(queue.bytes()).toBe(60);
  });

  it('drops a batch larger than the whole bound, and what was ahead of it', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 10));
    expect(idsOf(queue.enqueue(sealed('b', 101)))).toEqual(['a', 'b']);
    expect(queue.size()).toBe(0);
    expect(queue.bytes()).toBe(0);
  });

  it('holds the default bound exactly', () => {
    const queue = createExportQueue();
    const half = TELEMETRY_EXPORT_BOUNDS.memoryQueueBytes / 2;
    queue.enqueue(sealed('a', half));
    expect(queue.enqueue(sealed('b', half))).toEqual([]);
    expect(queue.bytes()).toBe(TELEMETRY_EXPORT_BOUNDS.memoryQueueBytes);
    expect(idsOf(queue.enqueue(sealed('c', 1)))).toEqual(['a']);
    expect(queue.bytes()).toBeLessThanOrEqual(TELEMETRY_EXPORT_BOUNDS.memoryQueueBytes);
  });

  it('counts attempts and keeps the time of the first one', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 10));
    expect(queue.beginAttempt('a', 5)).toMatchObject({ state: 'sending', attemptsMade: 1, firstAttemptAt: 5 });
    queue.awaitRetry('a');
    expect(queue.head()).toMatchObject({ state: 'retrying', attemptsMade: 1 });
    expect(queue.beginAttempt('a', 900)).toMatchObject({ state: 'sending', attemptsMade: 2, firstAttemptAt: 5 });
    expect(queue.beginAttempt('missing', 1)).toBeUndefined();
  });

  it('never changes an entry a caller holds', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 10));
    const before = queue.head();
    queue.beginAttempt('a', 5);
    expect(before).toMatchObject({ state: 'queued', attemptsMade: 0 });
    expect(queue.head()?.body).toBe(before?.body);
  });

  it('expires batches older than the expiry that are not being sent', () => {
    const queue = createExportQueue({ bytesMax: 100, expiryMs: 1_000 });
    queue.enqueue(sealed('a', 10, 0));
    queue.enqueue(sealed('b', 10, 0));
    queue.enqueue(sealed('c', 10, 500));
    queue.beginAttempt('a', 1);
    expect(queue.takeExpired(1_000)).toEqual([]);
    expect(idsOf(queue.takeExpired(1_001))).toEqual(['b']);
    expect(idsOf(queue.takeExpired(1_501))).toEqual(['c']);
    expect(queue.size()).toBe(1);
    expect(queue.bytes()).toBe(10);
  });

  it('uses the 24 hour expiry by default', () => {
    const queue = createExportQueue();
    queue.enqueue(sealed('a', 10, 0));
    expect(queue.takeExpired(TELEMETRY_EXPORT_BOUNDS.copyExpiryMs)).toEqual([]);
    expect(idsOf(queue.takeExpired(TELEMETRY_EXPORT_BOUNDS.copyExpiryMs + 1))).toEqual(['a']);
  });

  it('removes one batch and drains the rest', () => {
    const queue = createExportQueue({ bytesMax: 100 });
    queue.enqueue(sealed('a', 10));
    queue.enqueue(sealed('b', 10));
    queue.enqueue(sealed('c', 10));
    expect(queue.remove('b')).toMatchObject({ batchId: 'b' });
    expect(queue.remove('b')).toBeUndefined();
    expect(idsOf(queue.drain())).toEqual(['a', 'c']);
    expect(queue.size()).toBe(0);
    expect(queue.bytes()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });
});
