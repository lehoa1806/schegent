// FR-R6-F07 (FR-008) — whole-entry byte budget.
//
// The per-field cap bounds each body field, but an entry with several long
// fields can still exceed what one batch may carry. This runs after per-field
// truncation and sanitization, so every cut is a prefix of sanitized text and
// never exposes anything the sanitizer removed.
//
// Up to MAX_SHRINKS times, the longest shrinkable field is cut by the excess
// plus a margin. A string is cut at a code-point boundary: a surrogate pair is
// kept or dropped whole, so no replacement character appears. Oversized tool
// arguments become the existing truncation sentinel. Each cut adds or keeps the
// field's `bodyTruncated` record, which holds the larger original byte length.
// An entry that still does not fit becomes a `display-truncation` coverage gap.

import type { PhaseLogDisplayEntry, ToolArgumentValue } from './types';

const MAX_SHRINKS = 8;
const CUT_MARGIN_BYTES = 64;
const STRING_FIELDS = ['text', 'toolInput', 'toolResult', 'systemSummary', 'resultSummary'] as const;
type ShrinkableField = (typeof STRING_FIELDS)[number] | 'toolArguments';

type MutableBody = { -readonly [K in keyof PhaseLogDisplayEntry['body']]: PhaseLogDisplayEntry['body'][K] };
type TruncationMap = { [K in ShrinkableField]?: { readonly originalLength: number } };

function byteLengthOf(value: unknown): number {
  // `JSON.stringify` returns undefined for a bare `undefined`; its declared type does not say so.
  const json = JSON.stringify(value) as string | undefined;
  return Buffer.byteLength(json ?? '', 'utf8');
}

function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** The longest prefix of `text` that is at most `maxBytes` UTF-8 bytes, cut between code points. */
export function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    const next = bytes + codePointBytes(character.codePointAt(0) ?? 0);
    if (next > maxBytes) break;
    bytes = next;
    index += character.length;
  }
  return text.slice(0, index);
}

function largestField(body: MutableBody): { field: ShrinkableField; bytes: number } | null {
  let best: { field: ShrinkableField; bytes: number } | null = null;
  for (const field of STRING_FIELDS) {
    const value = body[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const bytes = byteLengthOf(value);
    if (best === null || bytes > best.bytes) best = { field, bytes };
  }
  const args = body.toolArguments;
  if (args !== undefined && !isSentinel(args)) {
    const bytes = byteLengthOf(args);
    if (best === null || bytes > best.bytes) best = { field: 'toolArguments', bytes };
  }
  return best;
}

function isSentinel(value: ToolArgumentValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__truncated' in value;
}

function recordCut(map: TruncationMap, field: ShrinkableField, originalLength: number): void {
  const existing = map[field]?.originalLength ?? 0;
  map[field] = { originalLength: Math.max(existing, originalLength) };
}

function shrinkField(body: MutableBody, map: TruncationMap, field: ShrinkableField, excess: number): void {
  if (field === 'toolArguments') {
    const args = body.toolArguments;
    if (args === undefined) return;
    const originalBytes = byteLengthOf(args);
    body.toolArguments = { __truncated: true, originalBytes };
    recordCut(map, field, originalBytes);
    return;
  }
  const value = body[field] ?? '';
  const rawBytes = Buffer.byteLength(value, 'utf8');
  body[field] = cutToBytes(value, Math.max(0, rawBytes - excess - CUT_MARGIN_BYTES));
  recordCut(map, field, rawBytes);
}

function coverageGapFor(entry: PhaseLogDisplayEntry, originalBytes: number): PhaseLogDisplayEntry {
  return {
    seq: entry.seq,
    kind: 'coverage-gap',
    ts: entry.ts,
    body: { reason: 'display-truncation', count: 1, bytes: originalBytes },
    bodyTruncated: null
  };
}

/**
 * Returns `entry` itself when it serializes within `maxBytes`, otherwise a
 * shrunk copy, otherwise a `display-truncation` coverage gap.
 */
export function fitEntryToBudget(entry: PhaseLogDisplayEntry, maxBytes: number): PhaseLogDisplayEntry {
  const originalBytes = byteLengthOf(entry);
  if (originalBytes <= maxBytes) return entry;
  const body: MutableBody = { ...entry.body };
  const map: TruncationMap = { ...(entry.bodyTruncated ?? {}) };
  for (let shrinks = 0; ; shrinks += 1) {
    const bodyTruncated = Object.keys(map).length === 0 ? entry.bodyTruncated : map;
    const candidate: PhaseLogDisplayEntry = { ...entry, body, bodyTruncated };
    const size = byteLengthOf(candidate);
    if (size <= maxBytes) return candidate;
    if (shrinks === MAX_SHRINKS) break;
    const target = largestField(body);
    if (target === null) break;
    shrinkField(body, map, target.field, size - maxBytes);
  }
  return coverageGapFor(entry, originalBytes);
}
