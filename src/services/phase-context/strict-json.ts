/**
 * FR-R6-F15 (F15-A; FR-028, NFR-006; research R9) — the strict parser of a review artifact.
 *
 * A reviewer's report and a fixer's claims are text an agent wrote. `JSON.parse` would keep
 * the last of two equal keys, give `__proto__` a meaning and read a text of any depth, so the
 * text is read here instead: one pass, a bound on its bytes, its depth and its values, and one
 * reason when it is refused. The bounds and rules match the result-operator worker's parser.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { utf8Bytes } from './text-bounds';

export interface StrictJsonLimits {
  readonly maxBytes: number;
  /** The outermost value is at depth 1; a plain value inside a list is one level deeper. */
  readonly maxDepth: number;
  /** Every value counts once, a record or list as well as each value in it. A key does not. */
  readonly maxValues: number;
}

export type StrictJsonReason = 'oversized' | 'too-deep' | 'too-many-values' | 'duplicate-key' | 'forbidden-key' | 'malformed';

export type StrictJsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: StrictJsonReason };

/** Keys that would reach a prototype if a later reader assigned them. */
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'prototype', 'constructor'];

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const OPEN_LIST = 0x5b;
const CLOSE_LIST = 0x5d;
const OPEN_RECORD = 0x7b;
const CLOSE_RECORD = 0x7d;
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const LOWER_U = 0x75;
const HEX_DIGITS = 4;
const HEX_RADIX = 16;

/** What a short escape stands for, by the code of the character after the backslash. */
const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [QUOTE, '"'],
  [BACKSLASH, String.fromCharCode(BACKSLASH)],
  [0x2f, '/'],
  [0x62, String.fromCharCode(0x08)],
  [0x66, String.fromCharCode(0x0c)],
  [0x6e, String.fromCharCode(LINE_FEED)],
  [0x72, String.fromCharCode(CARRIAGE_RETURN)],
  [0x74, String.fromCharCode(TAB)]
]);

const LITERALS: readonly (readonly [string, unknown])[] = [
  ['true', true],
  ['false', false],
  ['null', null]
];

/** Returned in place of a value once the text is refused. */
const FAULT = Symbol('strict-json-fault');

function isDigit(unit: number): boolean {
  return unit >= DIGIT_ZERO && unit <= DIGIT_NINE;
}

function hexValue(unit: number): number {
  if (isDigit(unit)) return unit - DIGIT_ZERO;
  const lower = unit | SPACE;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

class Reader {
  private position = 0;
  private values = 0;
  private reason: StrictJsonReason = 'malformed';

  constructor(
    private readonly text: string,
    private readonly limits: StrictJsonLimits
  ) {}

  /** The one value of the text, or `FAULT` when anything else follows it. */
  document(): unknown {
    const value = this.value(1);
    if (value === FAULT) return FAULT;
    this.skipSpace();
    return this.position === this.text.length ? value : this.fail('malformed');
  }

  faultReason(): StrictJsonReason {
    return this.reason;
  }

  private fail(reason: StrictJsonReason): typeof FAULT {
    this.reason = reason;
    return FAULT;
  }

  private unit(): number {
    return this.text.charCodeAt(this.position);
  }

  private skipSpace(): void {
    for (;;) {
      const unit = this.unit();
      if (unit !== SPACE && unit !== TAB && unit !== LINE_FEED && unit !== CARRIAGE_RETURN) return;
      this.position += 1;
    }
  }

  private value(depth: number): unknown {
    if (depth > this.limits.maxDepth) return this.fail('too-deep');
    this.skipSpace();
    if (this.position >= this.text.length) return this.fail('malformed');
    this.values += 1;
    if (this.values > this.limits.maxValues) return this.fail('too-many-values');
    const unit = this.unit();
    if (unit === OPEN_RECORD) return this.record(depth);
    if (unit === OPEN_LIST) return this.list(depth);
    if (unit === QUOTE) return this.string();
    if (unit === MINUS || isDigit(unit)) return this.number();
    return this.literal();
  }

  private literal(): unknown {
    for (const [word, value] of LITERALS) {
      if (this.text.startsWith(word, this.position)) {
        this.position += word.length;
        return value;
      }
    }
    return this.fail('malformed');
  }

  private digits(): boolean {
    const start = this.position;
    while (isDigit(this.unit())) this.position += 1;
    return this.position > start;
  }

  private number(): unknown {
    const start = this.position;
    if (this.unit() === MINUS) this.position += 1;
    if (this.unit() === DIGIT_ZERO) this.position += 1;
    else if (!this.digits()) return this.fail('malformed');
    if (this.unit() === DOT) {
      this.position += 1;
      if (!this.digits()) return this.fail('malformed');
    }
    if (this.unit() === LOWER_E || this.unit() === UPPER_E) {
      this.position += 1;
      if (this.unit() === PLUS || this.unit() === MINUS) this.position += 1;
      if (!this.digits()) return this.fail('malformed');
    }
    const value = Number(this.text.slice(start, this.position));
    return Number.isFinite(value) ? value : this.fail('malformed');
  }

  /** The character an escape stands for; the position is on the character after the backslash. */
  private escape(): string | typeof FAULT {
    const unit = this.unit();
    const short = SHORT_ESCAPES.get(unit);
    if (short !== undefined) {
      this.position += 1;
      return short;
    }
    if (unit !== LOWER_U) return this.fail('malformed');
    let code = 0;
    for (let offset = 1; offset <= HEX_DIGITS; offset += 1) {
      const digit = hexValue(this.text.charCodeAt(this.position + offset));
      if (digit < 0) return this.fail('malformed');
      code = code * HEX_RADIX + digit;
    }
    this.position += HEX_DIGITS + 1;
    return String.fromCharCode(code);
  }

  private string(): string | typeof FAULT {
    this.position += 1;
    let decoded = '';
    let segmentStart = this.position;
    for (;;) {
      const unit = this.unit();
      // `charCodeAt` past the end is NaN, which no comparison below accepts.
      if (Number.isNaN(unit) || unit < SPACE) return this.fail('malformed');
      if (unit === QUOTE) {
        decoded += this.text.slice(segmentStart, this.position);
        this.position += 1;
        return decoded;
      }
      if (unit !== BACKSLASH) {
        this.position += 1;
        continue;
      }
      decoded += this.text.slice(segmentStart, this.position);
      this.position += 1;
      const escaped = this.escape();
      if (escaped === FAULT) return FAULT;
      decoded += escaped;
      segmentStart = this.position;
    }
  }

  private list(depth: number): unknown {
    this.position += 1;
    const items: unknown[] = [];
    this.skipSpace();
    if (this.unit() === CLOSE_LIST) {
      this.position += 1;
      return items;
    }
    for (;;) {
      const item = this.value(depth + 1);
      if (item === FAULT) return FAULT;
      items.push(item);
      this.skipSpace();
      const unit = this.unit();
      this.position += 1;
      if (unit === CLOSE_LIST) return items;
      if (unit !== COMMA) return this.fail('malformed');
    }
  }

  /** One key of a record: text, not forbidden and not yet in the record. */
  private key(record: Record<string, unknown>): string | typeof FAULT {
    this.skipSpace();
    if (this.unit() !== QUOTE) return this.fail('malformed');
    const key = this.string();
    if (key === FAULT) return FAULT;
    if (FORBIDDEN_KEYS.includes(key)) return this.fail('forbidden-key');
    if (Object.hasOwn(record, key)) return this.fail('duplicate-key');
    this.skipSpace();
    if (this.unit() !== COLON) return this.fail('malformed');
    this.position += 1;
    return key;
  }

  private record(depth: number): unknown {
    this.position += 1;
    const record: Record<string, unknown> = {};
    this.skipSpace();
    if (this.unit() === CLOSE_RECORD) {
      this.position += 1;
      return record;
    }
    for (;;) {
      const key = this.key(record);
      if (key === FAULT) return FAULT;
      const value = this.value(depth + 1);
      if (value === FAULT) return FAULT;
      record[key] = value;
      this.skipSpace();
      const unit = this.unit();
      this.position += 1;
      if (unit === CLOSE_RECORD) return record;
      if (unit !== COMMA) return this.fail('malformed');
    }
  }
}

/**
 * The value the text states, or the reason it is refused. The size is checked first, in UTF-8
 * bytes; after that the first fault met in the order of the text decides the reason.
 */
export function parseStrictJson(text: string, limits: StrictJsonLimits): StrictJsonResult {
  const input: unknown = text;
  if (typeof input !== 'string') return { ok: false, reason: 'malformed' };
  // A character is at least one byte, so more code units than bytes allowed is already too large.
  if (input.length > limits.maxBytes || utf8Bytes(input) > limits.maxBytes) return { ok: false, reason: 'oversized' };
  const reader = new Reader(input, limits);
  const value = reader.document();
  return value === FAULT ? { ok: false, reason: reader.faultReason() } : { ok: true, value };
}
