// FR-R6-F07 (FR-008) — whole-entry byte budget after per-field truncation.

import { describe, expect, it } from 'vitest';
import { fitEntryToBudget } from '../../../../src/services/phase-log/live-log-entry-budget';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
import { LIVE_LOG_ENTRY_MAX_BYTES } from '../../../../src/contracts/phase-log-bounds';

const FIELD_CAP = 65536;

function sizeOf(entry: PhaseLogDisplayEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

function entryWith(body: PhaseLogDisplayEntry['body']): PhaseLogDisplayEntry {
  return { seq: 7, kind: 'tool-use', ts: '2026-11-10T00:00:00Z', body, bodyTruncated: null };
}

function isLoneSurrogateAt(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const nextUnit = text.charCodeAt(index + 1);
    return !(nextUnit >= 0xdc00 && nextUnit <= 0xdfff);
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    const previous = text.charCodeAt(index - 1);
    return !(previous >= 0xd800 && previous <= 0xdbff);
  }
  return false;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (isLoneSurrogateAt(text, i)) return true;
  return false;
}

const STRING_FIELDS = [
  'text',
  'toolName',
  'toolInput',
  'toolResult',
  'systemSubtype',
  'systemSummary',
  'resultSummary'
] as const;

describe('fitEntryToBudget (FR-R6-F07)', () => {
  it('returns an entry under the bound unchanged', () => {
    const entry = entryWith({ text: 'hello', toolName: 'Read' });
    expect(fitEntryToBudget(entry, LIVE_LOG_ENTRY_MAX_BYTES)).toBe(entry);
  });

  it('fits an entry whose every long field is at the per-field cap', () => {
    const block = 'x'.repeat(FIELD_CAP);
    const entry = entryWith({
      text: block,
      toolName: 'Bash',
      toolInput: block,
      toolResult: block,
      systemSubtype: 'init',
      systemSummary: block,
      resultSummary: block,
      toolArguments: { command: block }
    });
    expect(sizeOf(entry)).toBeGreaterThan(LIVE_LOG_ENTRY_MAX_BYTES);
    const fitted = fitEntryToBudget(entry, LIVE_LOG_ENTRY_MAX_BYTES);
    expect(fitted.kind).toBe('tool-use');
    expect(sizeOf(fitted)).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
  });

  it('never leaves a lone surrogate at a cut', () => {
    const pairs = '\u{1F600}'.repeat(FIELD_CAP);
    const entry = entryWith({ text: pairs, toolResult: pairs });
    for (const budget of [1001, 1002, 1003, 40_001, 40_002, 40_003]) {
      const fitted = fitEntryToBudget(entry, budget);
      for (const field of ['text', 'toolResult'] as const) {
        const value = fitted.body[field];
        if (typeof value === 'string') expect(hasLoneSurrogate(value)).toBe(false);
      }
    }
  });

  it('records each cut in bodyTruncated with the original byte length', () => {
    const big = 'y'.repeat(300_000);
    const entry = entryWith({ text: big });
    const fitted = fitEntryToBudget(entry, LIVE_LOG_ENTRY_MAX_BYTES);
    expect(fitted.bodyTruncated?.text?.originalLength).toBe(300_000);
    expect(fitted.body.text?.length).toBeLessThan(300_000);
  });

  it('keeps an earlier truncation record when the field is cut again', () => {
    const entry: PhaseLogDisplayEntry = {
      ...entryWith({ text: 'z'.repeat(300_000) }),
      bodyTruncated: { text: { originalLength: 900_000 } }
    };
    const fitted = fitEntryToBudget(entry, LIVE_LOG_ENTRY_MAX_BYTES);
    expect(fitted.bodyTruncated?.text?.originalLength).toBe(900_000);
  });

  it('replaces oversized tool arguments with the truncation sentinel', () => {
    const args = { a: 'q'.repeat(400_000) };
    const argBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
    const entry = entryWith({ toolArguments: args });
    const fitted = fitEntryToBudget(entry, LIVE_LOG_ENTRY_MAX_BYTES);
    expect(fitted.body.toolArguments).toEqual({ __truncated: true, originalBytes: argBytes });
    expect(fitted.bodyTruncated?.toolArguments?.originalLength).toBe(argBytes);
  });

  it('becomes a display-truncation coverage gap when it cannot fit', () => {
    const entry = entryWith({ toolName: 'n'.repeat(5000), text: 'short' });
    const original = sizeOf(entry);
    const fitted = fitEntryToBudget(entry, 2000);
    expect(fitted).toEqual({
      seq: 7,
      kind: 'coverage-gap',
      ts: '2026-11-10T00:00:00Z',
      body: { reason: 'display-truncation', count: 1, bytes: original },
      bodyTruncated: null
    });
  });

  it('adds no text that was not in the sanitized entry', () => {
    const entry = entryWith({
      text: 'alpha '.repeat(30_000),
      toolInput: 'beta '.repeat(30_000),
      toolResult: 'été '.repeat(40_000),
      resultSummary: 'gamma'
    });
    const fitted = fitEntryToBudget(entry, 120_000);
    for (const field of STRING_FIELDS) {
      const after = fitted.body[field];
      if (after === undefined) continue;
      const before = entry.body[field] ?? '';
      expect(before.startsWith(after)).toBe(true);
    }
    expect(JSON.stringify(fitted).includes('�')).toBe(false);
  });
});
