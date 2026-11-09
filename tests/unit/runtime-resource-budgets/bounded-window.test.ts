import { describe, expect, it } from 'vitest';
import { BoundedWindow } from '../../../src/services/runtime-resource-budgets/bounded-window';

describe('BoundedWindow (T004, T006)', () => {
  it('enforces count limit and limit-plus-one with refuse policy', () => {
    const window = new BoundedWindow<string>({
      maxItems: 3,
      maxBytes: 1024,
      overflow: 'refuse'
    });

    expect(window.offer('a', 10)).toEqual({ status: 'accepted', expiredCount: 0 });
    expect(window.offer('b', 10)).toEqual({ status: 'accepted', expiredCount: 0 });
    expect(window.offer('c', 10)).toEqual({ status: 'accepted', expiredCount: 0 });
    expect(window.size).toBe(3);

    // limit-plus-one
    expect(window.offer('d', 10)).toEqual({
      status: 'refused',
      reason: 'count',
      expiredCount: 0
    });
    expect(window.items()).toEqual(['a', 'b', 'c']);
    expect(window.counters).toEqual({
      observed: 4,
      accepted: 3,
      coalesced: 0,
      refused: 1,
      overwritten: 0,
      expired: 0
    });
  });

  it('enforces byte limit and limit-plus-one and refuses single items exceeding maxBytes', () => {
    const window = new BoundedWindow<string>({
      maxItems: 10,
      maxBytes: 100,
      overflow: 'refuse'
    });

    expect(window.offer('item-1', 50)).toEqual({ status: 'accepted', expiredCount: 0 });
    expect(window.offer('item-2', 50)).toEqual({ status: 'accepted', expiredCount: 0 });
    expect(window.currentBytes).toBe(100);

    // limit-plus-one by bytes (first limit reached wins even though count is 2/10)
    expect(window.offer('item-3', 1)).toEqual({
      status: 'refused',
      reason: 'bytes',
      expiredCount: 0
    });

    // single item > maxBytes
    expect(window.offer('giant', 101)).toEqual({
      status: 'refused',
      reason: 'item-exceeds-bytes',
      expiredCount: 0
    });
  });

  it('runs onEvict before removing oldest items under overwrite-oldest policy', () => {
    const evictedLog: Array<{ item: string; bytes: number; reason: string; sizeAtEvict: number }> =
      [];
    const window = new BoundedWindow<string>({
      maxItems: 2,
      maxBytes: 100,
      overflow: 'overwrite-oldest',
      onEvict: (item, bytes, reason) => {
        evictedLog.push({ item, bytes, reason, sizeAtEvict: window.size });
      }
    });

    window.offer('first', 40);
    window.offer('second', 40);
    const out = window.offer('third', 40);
    expect(out).toEqual({ status: 'overwrote', evictedCount: 1, expiredCount: 0 });
    expect(evictedLog).toEqual([
      { item: 'first', bytes: 40, reason: 'count', sizeAtEvict: 2 }
    ]);
    expect(window.items()).toEqual(['second', 'third']);
    expect(window.currentBytes).toBe(80);
  });

  it('coalesces when coalescer finds a match and refuses when coalescer returns null', () => {
    interface CounterObs {
      readonly key: string;
      readonly count: number;
    }

    const window = new BoundedWindow<CounterObs>({
      maxItems: 2,
      maxBytes: 100,
      overflow: 'coalesce-or-refuse',
      coalescer: (existing, incoming) => {
        const index = existing.findIndex((entry) => entry.key === incoming.key);
        if (index === -1) return null;
        return {
          index,
          merged: { key: incoming.key, count: existing[index]!.count + incoming.count },
          mergedBytes: 30
        };
      }
    });

    window.offer({ key: 'k1', count: 1 }, 30);
    window.offer({ key: 'k2', count: 2 }, 30);

    // limit-plus-one with matching key -> coalesced
    const coalesced = window.offer({ key: 'k1', count: 5 }, 30);
    expect(coalesced).toEqual({ status: 'coalesced', expiredCount: 0, targetIndex: 0 });
    expect(window.items()[0]).toEqual({ key: 'k1', count: 6 });

    // limit-plus-one with non-matching key -> fallback to refuse
    const refused = window.offer({ key: 'k3', count: 1 }, 30);
    expect(refused).toEqual({ status: 'refused', reason: 'count', expiredCount: 0 });
    expect(window.counters.coalesced).toBe(1);
    expect(window.counters.refused).toBe(1);
  });

  it('expires stale items at age limit-plus-one and refuses already-stale incoming items', () => {
    let now = 1_000;
    const window = new BoundedWindow<string>({
      maxItems: 2,
      maxBytes: 100,
      maxAgeMs: 500,
      overflow: 'expire-then-refuse',
      clock: () => now
    });

    window.offer('t1000', 20);
    now = 1_500; // exactly at maxAgeMs (500ms) -> still valid
    window.offer('t1500', 20);
    expect(window.size).toBe(2);

    now = 1_501; // limit-plus-one age for t1000 -> expires t1000 and accepts new item
    const outcome = window.offer('t1501', 20);
    expect(outcome).toEqual({ status: 'accepted', expiredCount: 1 });
    expect(window.items()).toEqual(['t1500', 't1501']);

    // Incoming item already older than maxAgeMs -> refused with reason 'age'
    const staleIn = window.offer('stale', 20, 1_501, 900);
    expect(staleIn).toEqual({ status: 'refused', reason: 'age', expiredCount: 1 });
    expect(window.counters.expired).toBe(2);
  });
});
