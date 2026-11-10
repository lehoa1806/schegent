// The live tail window (FR-R4-F08, contract L: L-T1; FR-006, FR-007, FR-010, SC-002).
//
// WHAT THIS PINS. `appendToWindow` keeps the newest `maxEntries` entries and one
// `truncated-head` marker at index 0 that counts everything not shown: the host
// read's own dropped count plus every entry the window has trimmed. Below the
// cap no marker is created. The newest entry is always the last element, the
// marker is never duplicated, `seq` values stay unique, and the result is frozen.
//
// The store applies the window with `maxEntries = 499`, so a full window is 499
// entries and one marker, 500 rows: the same shape a capped host read has.

import { describe, expect, it } from 'vitest';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
import { LIVE_LOG_VISIBLE_MAX_BYTES } from '../../../../src/contracts/phase-log-bounds';
import {
  PHASE_LOG_WINDOW_MAX_ENTRIES,
  WINDOW_MARKER_SEQ,
  appendToWindow,
  hiddenEntryCount
} from '../phase-log-window';

function entry(seq: number): PhaseLogDisplayEntry {
  return Object.freeze({
    seq,
    kind: 'assistant-text',
    ts: null,
    body: { text: `entry ${seq}` },
    bodyTruncated: null
  });
}

function hostMarker(droppedEntryCount: number, seq = 0): PhaseLogDisplayEntry {
  return Object.freeze({
    seq,
    kind: 'truncated-head',
    ts: null,
    body: { droppedEntryCount },
    bodyTruncated: null
  });
}

/** Push `count` entries numbered from `first`, one at a time, through `appendToWindow`. */
function pushAll(
  start: readonly PhaseLogDisplayEntry[],
  first: number,
  count: number,
  maxEntries: number
): readonly PhaseLogDisplayEntry[] {
  let window = start;
  for (let seq = first; seq < first + count; seq += 1) {
    window = appendToWindow(window, entry(seq), maxEntries);
  }
  return window;
}

function realEntries(window: readonly PhaseLogDisplayEntry[]): readonly PhaseLogDisplayEntry[] {
  return window.filter((candidate) => candidate.kind !== 'truncated-head');
}

describe('the window constants', () => {
  it('a full window is 499 entries plus one marker, 500 rows', () => {
    expect(PHASE_LOG_WINDOW_MAX_ENTRIES).toBe(499);
    expect(WINDOW_MARKER_SEQ).toBe(-1);
  });
});

describe('appendToWindow below, at and over the cap', () => {
  const cap = 5;

  it('below the cap appends and creates no marker', () => {
    const window = pushAll([], 1, cap - 1, cap);
    expect(window.map((candidate) => candidate.seq)).toEqual([1, 2, 3, 4]);
    expect(window.some((candidate) => candidate.kind === 'truncated-head')).toBe(false);
    expect(hiddenEntryCount(window)).toBe(0);
  });

  it('at the cap keeps every entry and still creates no marker', () => {
    const window = pushAll([], 1, cap, cap);
    expect(window.map((candidate) => candidate.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(hiddenEntryCount(window)).toBe(0);
  });

  it('one over the cap drops the oldest entry and counts it in a new marker at index 0', () => {
    const window = pushAll([], 1, cap + 1, cap);
    const marker = window.at(0);
    expect(marker?.kind).toBe('truncated-head');
    expect(marker?.body.droppedEntryCount).toBe(1);
    expect(marker?.seq).toBe(WINDOW_MARKER_SEQ);
    expect(realEntries(window).map((candidate) => candidate.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(window.length).toBe(cap + 1);
  });

  it('ten times the cap keeps the newest entries, one marker, and an exact count', () => {
    const total = cap * 10;
    const window = pushAll([], 1, total, cap);
    expect(window.filter((candidate) => candidate.kind === 'truncated-head').length).toBe(1);
    expect(window.at(0)?.kind).toBe('truncated-head');
    expect(hiddenEntryCount(window)).toBe(total - cap);
    expect(realEntries(window).map((candidate) => candidate.seq)).toEqual([46, 47, 48, 49, 50]);
  });

  it('the newest entry is the last element at every step', () => {
    let window: readonly PhaseLogDisplayEntry[] = [];
    for (let seq = 1; seq <= cap * 3; seq += 1) {
      window = appendToWindow(window, entry(seq), cap);
      expect(window.at(-1)?.seq).toBe(seq);
    }
  });
});

describe('appendToWindow with a cap of 1', () => {
  it('keeps the newest entry and counts every earlier one', () => {
    const window = pushAll([], 1, 4, 1);
    expect(realEntries(window).map((candidate) => candidate.seq)).toEqual([4]);
    expect(hiddenEntryCount(window)).toBe(3);
    expect(window.at(-1)?.seq).toBe(4);
  });
});

describe('appendToWindow over a window that starts with a host marker', () => {
  it('raises the marker\'s count by each trim and keeps the host marker\'s seq', () => {
    const cap = 3;
    const start: readonly PhaseLogDisplayEntry[] = [hostMarker(42), entry(1), entry(2), entry(3)];
    const once = appendToWindow(start, entry(4), cap);
    expect(hiddenEntryCount(once)).toBe(43);
    expect(once.at(0)?.seq).toBe(0);
    const twice = appendToWindow(once, entry(5), cap);
    expect(hiddenEntryCount(twice)).toBe(44);
    expect(twice.at(0)?.seq).toBe(0);
    expect(realEntries(twice).map((candidate) => candidate.seq)).toEqual([3, 4, 5]);
    expect(twice.filter((candidate) => candidate.kind === 'truncated-head').length).toBe(1);
  });

  it('does not change the marker while the window is below the cap', () => {
    const start: readonly PhaseLogDisplayEntry[] = [hostMarker(42), entry(1)];
    const next = appendToWindow(start, entry(2), 3);
    expect(hiddenEntryCount(next)).toBe(42);
    expect(next.map((candidate) => candidate.seq)).toEqual([0, 1, 2]);
  });
});

describe('appendToWindow output', () => {
  it('has unique seq values, including the created marker', () => {
    const window = pushAll([], 1, 40, 5);
    const seqs = window.map((candidate) => candidate.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('is frozen, below the cap and over it', () => {
    expect(Object.isFrozen(appendToWindow([], entry(1), 3))).toBe(true);
    expect(Object.isFrozen(pushAll([], 1, 10, 3))).toBe(true);
  });

  it('copies entry references and never rebuilds an entry', () => {
    const first = entry(1);
    const second = entry(2);
    const window = appendToWindow(appendToWindow([], first, 3), second, 3);
    expect(window.at(0)).toBe(first);
    expect(window.at(1)).toBe(second);
  });

  it('does not mutate the array it was given', () => {
    const start: readonly PhaseLogDisplayEntry[] = Object.freeze([entry(1), entry(2)]);
    appendToWindow(start, entry(3), 2);
    expect(start.map((candidate) => candidate.seq)).toEqual([1, 2]);
  });
});

describe('hiddenEntryCount', () => {
  it('is 0 for an empty window and for one with no marker', () => {
    expect(hiddenEntryCount([])).toBe(0);
    expect(hiddenEntryCount([entry(1), entry(2)])).toBe(0);
  });

  it('is the marker\'s dropped count', () => {
    expect(hiddenEntryCount([hostMarker(7), entry(1)])).toBe(7);
  });
});

// FR-R6-F07 T031 (NFR-005) — the window is also bounded in serialized bytes:
// the UTF-8 length of each row's JSON, the marker included. Over the bound the
// oldest entries leave from the head into the marker's count; no field changes.
describe('appendToWindow byte bound (FR-R6-F07)', () => {
  const encoder = new TextEncoder();

  function rowBytes(row: PhaseLogDisplayEntry): number {
    return encoder.encode(JSON.stringify(row)).length;
  }

  function windowBytes(window: readonly PhaseLogDisplayEntry[]): number {
    return window.reduce((total, row) => total + rowBytes(row), 0);
  }

  function sized(seq: number, text: string): PhaseLogDisplayEntry {
    return Object.freeze({ seq, kind: 'assistant-text', ts: null, body: { text }, bodyTruncated: null });
  }

  function pushSized(
    start: readonly PhaseLogDisplayEntry[],
    count: number,
    text: string,
    maxBytes?: number
  ): readonly PhaseLogDisplayEntry[] {
    let window = start;
    for (let seq = 1; seq <= count; seq += 1) {
      window = appendToWindow(window, sized(seq, text), PHASE_LOG_WINDOW_MAX_ENTRIES, maxBytes);
    }
    return window;
  }

  it('the default byte bound is LIVE_LOG_VISIBLE_MAX_BYTES', () => {
    const text = 'x'.repeat(100_000);
    const window = pushSized([], 60, text);
    expect(windowBytes(window)).toBeLessThanOrEqual(LIVE_LOG_VISIBLE_MAX_BYTES);
    expect(realEntries(window).length).toBeLessThan(60);
    expect(hiddenEntryCount(window) + realEntries(window).length).toBe(60);
  });

  it('evicts the oldest entries into the marker when bytes bind before the count', () => {
    const maxBytes = 10_000;
    const window = pushSized([], 50, 'y'.repeat(900), maxBytes);
    const real = realEntries(window);
    expect(windowBytes(window)).toBeLessThanOrEqual(maxBytes);
    expect(window.at(0)?.kind).toBe('truncated-head');
    expect(window.at(0)?.seq).toBe(WINDOW_MARKER_SEQ);
    expect(hiddenEntryCount(window) + real.length).toBe(50);
    expect(real.map((row) => row.seq)).toEqual(
      Array.from({ length: real.length }, (_, index) => 50 - real.length + 1 + index)
    );
  });

  it('keeps as many entries as fit, not fewer', () => {
    const maxBytes = 10_000;
    const window = pushSized([], 50, 'y'.repeat(900), maxBytes);
    const oneMore = sized(0, 'y'.repeat(900));
    const withOneMore = [window.at(0), oneMore, ...realEntries(window)];
    expect(windowBytes(withOneMore as PhaseLogDisplayEntry[])).toBeGreaterThan(maxBytes);
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    const text = 'é'.repeat(400);
    const maxBytes = 3_000;
    const window = pushSized([], 10, text, maxBytes);
    expect(windowBytes(window)).toBeLessThanOrEqual(maxBytes);
    const codeUnits = window.reduce((total, row) => total + JSON.stringify(row).length, 0);
    expect(codeUnits).toBeLessThan(windowBytes(window));
  });

  it('raises a host marker\'s count and keeps its seq', () => {
    const maxBytes = 10_000;
    const window = pushSized([hostMarker(7)], 50, 'z'.repeat(900), maxBytes);
    expect(window.at(0)?.seq).toBe(0);
    expect(hiddenEntryCount(window)).toBe(7 + 50 - realEntries(window).length);
    expect(windowBytes(window)).toBeLessThanOrEqual(maxBytes);
  });

  it('always keeps the newest entry, even when it alone passes the bound', () => {
    const big = sized(2, 'w'.repeat(5_000));
    const window = appendToWindow([sized(1, 'small')], big, PHASE_LOG_WINDOW_MAX_ENTRIES, 1_000);
    expect(window.at(-1)).toBe(big);
    expect(hiddenEntryCount(window)).toBe(1);
  });

  it('copies entry references and never rewrites a field', () => {
    const originals = Array.from({ length: 30 }, (_, index) => sized(index + 1, 'q'.repeat(900)));
    let window: readonly PhaseLogDisplayEntry[] = [];
    for (const row of originals) {
      window = appendToWindow(window, row, PHASE_LOG_WINDOW_MAX_ENTRIES, 10_000);
    }
    for (const row of realEntries(window)) {
      expect(originals).toContain(row);
      expect(row.body.text).toBe('q'.repeat(900));
    }
  });
});
