/**
 * FR-R6-F11 (FR-013; research R6) — CSV profile, version 1.
 *
 * - RFC 4180 framing: every field is quoted, an embedded `"` is doubled, records end with CRLF,
 *   UTF-8 with no byte-order mark.
 * - A text cell is `text:` plus the escaped value. Invisible, control and bidirectional characters
 *   become `\u{XXXX}` (uppercase hex, at least four digits); a backslash becomes `\\`; a value
 *   longer than 4,096 code points is cut there and followed by `\u{2026}[truncated]`. A lone
 *   surrogate is escaped too, so no cell carries a code point UTF-8 cannot encode.
 * - A number cell is its decimal digits. An integer beyond ±(2^53 − 1), or a decimal with more
 *   than 15 significant digits, is `number:` plus its exact digits.
 * - An unknown value is the empty field `""`.
 *
 * The writer counts each transformation it applies, per cell, for the manifest.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { CSV_TRANSFORMATIONS, type CsvTransformation } from '../../contracts/reporting/report-manifest';

/** The most code points a text cell keeps. */
export const CSV_TEXT_LIMIT = 4_096;
/** The most significant digits a decimal keeps without a `number:` prefix. */
export const CSV_SIGNIFICANT_DIGITS = 15;

const TEXT_PREFIX = 'text:';
const NUMBER_PREFIX = 'number:';
const TRUNCATION_MARK = '\\u{2026}[truncated]';
const FIELD_SEPARATOR = ',';
const RECORD_END = '\r\n';
const NUMBER_GRAMMAR = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const HEX_DIGITS = 4;

/** A cell before encoding: text, a number (or its exact decimal digits), or unknown. */
export type CsvCell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number | string }
  | null;

/**
 * Inclusive code-point ranges written as `\u{XXXX}`: controls, format and bidirectional
 * characters, separators, surrogates, and every Unicode default-ignorable code point (variation
 * selectors, tags, Hangul fillers, the combining grapheme joiner) or other invisible format
 * control. A fixed table, not a Unicode property, so the bytes do not move with the runtime's
 * Unicode version. Prepended concatenation marks (U+0600..0605 and kin) are drawn, so stay.
 */
const ESCAPED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
];

function isEscaped(codePoint: number): boolean {
  return ESCAPED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

function escapeOf(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(HEX_DIGITS, '0')}}`;
}

function quoted(content: string): string {
  return `"${content.replaceAll('"', '""')}"`;
}

function significantDigits(digits: string): number {
  const unsigned = digits.startsWith('-') ? digits.slice(1) : digits;
  return unsigned.replace('.', '').replace(/^0+/, '').length;
}

function isBeyondSafe(digits: string): boolean {
  const magnitude = BigInt(digits.startsWith('-') ? digits.slice(1) : digits);
  return magnitude > MAX_SAFE;
}

function digitsOf(value: number | string): string | undefined {
  if (typeof value === 'string') {
    return NUMBER_GRAMMAR.test(value) ? value : undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const digits = Number.isInteger(value) ? BigInt(value).toString() : String(value);
  return NUMBER_GRAMMAR.test(digits) ? digits : undefined;
}

/** Counts the transformations one profile writer has applied. */
export class CsvTransformationCounter {
  private readonly counts = new Map<CsvTransformation, number>(CSV_TRANSFORMATIONS.map((name) => [name, 0]));

  add(name: CsvTransformation): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /** Every transformation, in profile order, with its count. */
  snapshot(): readonly { readonly name: CsvTransformation; readonly count: number }[] {
    return Object.freeze(CSV_TRANSFORMATIONS.map((name) => Object.freeze({ name, count: this.counts.get(name) ?? 0 })));
  }
}

/** The encoded field of a text cell. */
export function csvTextField(value: string, counter: CsvTransformationCounter): string {
  const codePoints = Array.from(value);
  const truncated = codePoints.length > CSV_TEXT_LIMIT;
  let escaped = false;
  let body = '';
  for (const character of truncated ? codePoints.slice(0, CSV_TEXT_LIMIT) : codePoints) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isEscaped(codePoint)) {
      escaped = true;
      body += escapeOf(codePoint);
    } else {
      body += character === '\\' ? '\\\\' : character;
    }
  }
  counter.add('text-prefix');
  if (escaped) {
    counter.add('control-escaped');
  }
  if (truncated) {
    counter.add('truncated');
    body += TRUNCATION_MARK;
  }
  return quoted(TEXT_PREFIX + body);
}

/** The encoded field of a number cell; a value outside the decimal grammar is written as text. */
export function csvNumberField(value: number | string, counter: CsvTransformationCounter): string {
  const digits = digitsOf(value);
  if (digits === undefined) {
    return csvTextField(String(value), counter);
  }
  const isDecimal = digits.includes('.');
  const prefixed = isDecimal ? significantDigits(digits) > CSV_SIGNIFICANT_DIGITS : isBeyondSafe(digits);
  if (!prefixed) {
    return quoted(digits);
  }
  counter.add('number-prefixed');
  return quoted(NUMBER_PREFIX + digits);
}

/** The encoded field of any cell; an unknown value is `""`. */
export function csvField(cell: CsvCell, counter: CsvTransformationCounter): string {
  if (cell === null) {
    return quoted('');
  }
  return cell.kind === 'text' ? csvTextField(cell.value, counter) : csvNumberField(cell.value, counter);
}

/** One CRLF-terminated record. */
export function csvRecord(cells: readonly CsvCell[], counter: CsvTransformationCounter): string {
  return cells.map((cell) => csvField(cell, counter)).join(FIELD_SEPARATOR) + RECORD_END;
}

/** The header record: every column name is a text cell. */
export function csvHeader(columns: readonly string[], counter: CsvTransformationCounter): string {
  return csvRecord(
    columns.map((value) => ({ kind: 'text', value })),
    counter
  );
}
