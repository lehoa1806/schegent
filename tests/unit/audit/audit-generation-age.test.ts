// Feature 251 (FR-R4-F04, contract T10, FR-016; data-model §7) — the start of the live audit generation.
//
// What it pins: `generationStart(timestamps, firstObservedAtMs)` is the oldest USABLE row timestamp that is
// not later than the generation's first-observed time `O`, and `O` itself when no usable row is at or
// before it. Rows that are out of order, missing, malformed or in the future are handled by that one rule:
// a future row can never make the start later than `O` (a row dated a year ahead must not postpone
// rotation), and a generation with no usable timestamp at all is aged from `O`, the time it was first seen.
//
// Why: the filing's finding (S-21) is that the active log's age was its file's mtime, which every append
// refreshes, so a busy workspace never aged out. Age is now `now - start`; this file pins `start`.
// `O` is placed before, between and after the rows, because the formula's two branches meet there.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { generationIdentity, generationStart } from '../../../src/audit/audit-generation-age';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-03-10T00:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

describe('generationStart (T10, data-model §7)', () => {
  it('is the oldest usable timestamp when O is after every row', () => {
    expect(generationStart([iso(DAY_MS), iso(0), iso(2 * DAY_MS)], T0 + 10 * DAY_MS)).toBe(T0);
  });

  it('handles rows out of order: the minimum, not the first', () => {
    expect(generationStart([iso(5 * DAY_MS), iso(3 * DAY_MS), iso(4 * DAY_MS)], T0 + 9 * DAY_MS)).toBe(T0 + 3 * DAY_MS);
  });

  it('skips missing and malformed timestamps rather than treating them as the start', () => {
    expect(generationStart(['', 'not a time', undefined as unknown as string, iso(2 * DAY_MS)], T0 + 9 * DAY_MS)).toBe(
      T0 + 2 * DAY_MS
    );
  });

  it('never lets a future row make the start later than O, or postpone rotation', () => {
    // O is day 1. The only usable row is a year ahead of it: no usable row is at or before O, so the
    // generation is aged from O, not from the future.
    const observed = T0 + DAY_MS;
    const start = generationStart([iso(365 * DAY_MS)], observed);
    expect(start).toBe(observed);
    expect(start).toBeLessThanOrEqual(observed);
  });

  it('with a past row and a future row, takes the past row', () => {
    const observed = T0 + 2 * DAY_MS;
    expect(generationStart([iso(365 * DAY_MS), iso(0)], observed)).toBe(T0);
  });

  it('uses O when no row has a usable timestamp', () => {
    expect(generationStart(['x', '', 'y'], T0 + 3 * DAY_MS)).toBe(T0 + 3 * DAY_MS);
    expect(generationStart([], T0 + 3 * DAY_MS)).toBe(T0 + 3 * DAY_MS);
  });

  it.each([
    ['before every row', -DAY_MS],
    ['between the rows', DAY_MS + 1],
    ['after every row', 10 * DAY_MS]
  ])('with O %s, the start is never later than O and never later than the oldest usable row at or before it', (_label, offset) => {
    const rows = [iso(0), iso(DAY_MS), iso(2 * DAY_MS)];
    const observed = T0 + offset;
    const start = generationStart(rows, observed);
    expect(start).toBeLessThanOrEqual(observed);
    const atOrBefore = rows.map((row) => Date.parse(row)).filter((time) => time <= observed);
    expect(start).toBe(atOrBefore.length === 0 ? observed : Math.min(...atOrBefore));
  });
});

describe('generationIdentity (T10)', () => {
  it('is the sha256 hex of the first line, so a new generation has a new identity', () => {
    const first = '{"id":"a","timestamp":"2026-03-10T00:00:00.000Z"}';
    expect(generationIdentity(Buffer.from(first, 'utf8'))).toBe(createHash('sha256').update(first).digest('hex'));
    expect(generationIdentity(Buffer.from(`${first}x`, 'utf8'))).not.toBe(generationIdentity(Buffer.from(first, 'utf8')));
  });
});
