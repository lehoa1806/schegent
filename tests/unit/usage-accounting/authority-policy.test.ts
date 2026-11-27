/**
 * FR-R6-F06 (T014, FR-006, FR-007, research R5) — one deterministic authority rule.
 */
import { describe, expect, it } from 'vitest';
import {
  type CandidateMeasure,
  selectContribution
} from '../../../src/services/usage-accounting/authority-policy';

function candidate(
  observationId: string,
  ingestSeq: number,
  provenance: CandidateMeasure['provenance'],
  quantity: bigint | null
): CandidateMeasure {
  return {
    observationId,
    ingestSeq,
    provenance,
    completeness: quantity === null ? 'unknown' : 'known',
    quantity
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, index) => {
    const rest = items.filter((_, other) => other !== index);
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

describe('authority policy (T014)', () => {
  it('selects provider-reported over derived over estimated', () => {
    const result = selectContribution([
      candidate('est', 1, 'estimated', 9n),
      candidate('der', 2, 'derived', 8n),
      candidate('rep', 3, 'provider-reported', 7n)
    ]);
    expect(result.selected?.observationId).toBe('rep');
    expect(result.completeness).toBe('known');
    expect(result.dispositions.get('der')).toBe('superseded');
    expect(result.dispositions.get('est')).toBe('superseded');
  });

  it('takes the earliest ingest within a rank and calls an equal value corroborating', () => {
    const result = selectContribution([candidate('late', 5, 'derived', 10n), candidate('early', 2, 'derived', 10n)]);
    expect(result.selected?.observationId).toBe('early');
    expect(result.dispositions.get('early')).toBe('accepted');
    expect(result.dispositions.get('late')).toBe('corroborating');
    expect(result.completeness).toBe('known');
  });

  it('marks a different value at the selected rank conflicting and the result conflicting', () => {
    const result = selectContribution([candidate('a', 1, 'provider-reported', 10n), candidate('b', 2, 'provider-reported', 11n)]);
    expect(result.selected?.observationId).toBe('a');
    expect(result.dispositions.get('b')).toBe('conflicting');
    expect(result.completeness).toBe('conflicting');
  });

  it('does not mark the result conflicting when only a lower rank disagrees', () => {
    const result = selectContribution([candidate('a', 1, 'provider-reported', 10n), candidate('b', 2, 'estimated', 99n)]);
    expect(result.completeness).toBe('known');
    expect(result.dispositions.get('b')).toBe('superseded');
  });

  it('never lets unknown displace known, even at a higher rank', () => {
    const result = selectContribution([candidate('known', 4, 'estimated', 3n), candidate('unknown', 1, 'provider-reported', null)]);
    expect(result.selected?.observationId).toBe('known');
    expect(result.dispositions.get('unknown')).toBe('superseded');
    expect(result.completeness).toBe('known');
  });

  it('lets a known value replace an earlier unknown', () => {
    const before = selectContribution([candidate('unknown', 1, 'derived', null)]);
    expect(before.selected?.observationId).toBe('unknown');
    expect(before.completeness).toBe('unknown');
    const after = selectContribution([candidate('unknown', 1, 'derived', null), candidate('known', 2, 'estimated', 5n)]);
    expect(after.selected?.observationId).toBe('known');
    expect(after.completeness).toBe('known');
  });

  it('carries a partial completeness from the selected candidate', () => {
    const partial: CandidateMeasure = { ...candidate('p', 1, 'derived', 4n), completeness: 'partial' };
    expect(selectContribution([partial]).completeness).toBe('partial');
  });

  it('returns nothing for no candidates', () => {
    const result = selectContribution([]);
    expect(result.selected).toBeNull();
    expect(result.completeness).toBe('unknown');
    expect(result.dispositions.size).toBe(0);
  });

  it('gives the same result for all 120 orders of five candidates', () => {
    const five = [
      candidate('o1', 1, 'estimated', 50n),
      candidate('o2', 2, 'derived', 40n),
      candidate('o3', 3, 'provider-reported', null),
      candidate('o4', 4, 'derived', 41n),
      candidate('o5', 5, 'derived', 40n)
    ];
    const orders = permutations(five);
    expect(orders).toHaveLength(120);
    const baseline = selectContribution(five);
    const baselineDispositions = [...baseline.dispositions.entries()].sort();
    for (const order of orders) {
      const result = selectContribution(order);
      expect(result.selected?.observationId).toBe(baseline.selected?.observationId);
      expect(result.completeness).toBe(baseline.completeness);
      expect([...result.dispositions.entries()].sort()).toEqual(baselineDispositions);
    }
    expect(baseline.selected?.observationId).toBe('o2');
    expect(baseline.completeness).toBe('conflicting');
  });
});

describe('authority policy: latest-value groups (FR-023, AC-09)', () => {
  function occupancy(
    observationId: string,
    ingestSeq: number,
    eventUtc: string,
    quantity: bigint,
    provenance: CandidateMeasure['provenance'] = 'provider-reported'
  ): CandidateMeasure {
    return { ...candidate(observationId, ingestSeq, provenance, quantity), latestWinsEventUtc: eventUtc };
  }

  it('selects the latest update and supersedes the earlier one without a conflict', () => {
    const result = selectContribution([
      occupancy('first', 1, '2026-11-10T10:00:00.000Z', 1000n),
      occupancy('second', 2, '2026-11-10T10:00:05.000Z', 2500n)
    ]);
    expect(result.selected?.observationId).toBe('second');
    expect(result.selected?.quantity).toBe(2500n);
    expect(result.completeness).toBe('known');
    expect(result.dispositions.get('first')).toBe('superseded');
    expect(result.dispositions.get('second')).toBe('accepted');
  });

  it('orders by event time before ingest order', () => {
    const result = selectContribution([
      occupancy('late-event', 1, '2026-11-10T10:00:09.000Z', 3000n),
      occupancy('early-event', 2, '2026-11-10T10:00:01.000Z', 1200n)
    ]);
    expect(result.selected?.observationId).toBe('late-event');
    expect(result.dispositions.get('early-event')).toBe('superseded');
  });

  it('breaks an event-time tie by the later ingest', () => {
    const result = selectContribution([
      occupancy('a', 4, '2026-11-10T10:00:00.000Z', 10n),
      occupancy('b', 7, '2026-11-10T10:00:00.000Z', 20n)
    ]);
    expect(result.selected?.observationId).toBe('b');
  });

  it('still ranks a higher provenance above a later lower-ranked update', () => {
    const result = selectContribution([
      occupancy('reported', 1, '2026-11-10T10:00:00.000Z', 1000n),
      occupancy('estimate', 2, '2026-11-10T10:00:30.000Z', 4000n, 'estimated')
    ]);
    expect(result.selected?.observationId).toBe('reported');
    expect(result.dispositions.get('estimate')).toBe('superseded');
  });

  it('selects the latest reading when every reading is unknown', () => {
    const unknownReading = (id: string, seq: number, eventUtc: string): CandidateMeasure => ({
      ...candidate(id, seq, 'derived', null),
      latestWinsEventUtc: eventUtc
    });
    const result = selectContribution([
      unknownReading('older', 1, '2026-11-10T10:00:00.000Z'),
      unknownReading('newer', 2, '2026-11-10T10:00:05.000Z')
    ]);
    expect(result.selected?.observationId).toBe('newer');
    expect(result.completeness).toBe('unknown');
    expect(result.dispositions.get('older')).toBe('superseded');
  });

  it('gives the same result for every order of four updates', () => {
    const four = [
      occupancy('u1', 1, '2026-11-10T10:00:01.000Z', 100n),
      occupancy('u2', 2, '2026-11-10T10:00:03.000Z', 300n),
      occupancy('u3', 3, '2026-11-10T10:00:02.000Z', 200n),
      occupancy('u4', 4, '2026-11-10T10:00:03.000Z', 310n)
    ];
    for (const order of permutations(four)) {
      const result = selectContribution(order);
      expect(result.selected?.observationId).toBe('u4');
      expect(result.completeness).toBe('known');
    }
  });
});
