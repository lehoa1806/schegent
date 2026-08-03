// Feature 084 T011 — the one place that decides how a string may be written.
//
// Two questions look similar and are not:
//
//   1. Can this text be written as a plain scalar and read back byte-identical?
//      `plainScalarDefect` answers it, and BOTH the scanner and the serializer
//      use that answer — the scanner to refuse a plain scalar it should never
//      have been handed, the serializer to decide it must quote. A second copy
//      of this rule would eventually drift, and drift here is silent round-trip
//      corruption rather than a visible error (research R5).
//
//   2. Would another reader re-type this text as a boolean, a number, or null?
//      `looksTyped` answers it. Our own parser never types a scalar, so this
//      question is about the documents we hand to other tools. It is an
//      emit-side concern only: `version: 3` must still be readable.
//
// Errors are values; nothing here throws.

/** Style a value must be emitted in. */
export type ScalarStyle = 'plain' | 'double' | 'block';

/** Indicators the grammar excludes from `plain_first`, with why each is out. */
export const PLAIN_FIRST_EXCLUDED: ReadonlyMap<string, string> = new Map([
  ['&', 'anchors are not part of this format'],
  ['*', 'aliases are not part of this format'],
  ['!', 'tags are not part of this format'],
  ['{', 'flow mappings are not part of this format'],
  ['[', 'flow sequences are not part of this format'],
  ['}', 'flow mappings are not part of this format'],
  [']', 'flow sequences are not part of this format'],
  ['>', 'folded scalars are not part of this format'],
  ["'", 'single-quoted scalars are not part of this format'],
  ['%', 'directives are not part of this format'],
  ['@', 'reserved indicator'],
  ['`', 'reserved indicator'],
  [',', 'flow separators are not part of this format'],
  ['?', 'complex keys are not part of this format'],
  [':', 'a value may not begin with a colon'],
  // Feature 085 T009: the format now HAS block sequences, so the old wording
  // was wrong in both places this fires — `key: - a`, where a sequence may not
  // be inline, and `- - a`, where a sequence may not be another's entry.
  ['-', "a value may not begin with '- '"],
  ['#', 'a value may not begin with a comment marker']
]);

/**
 * `-`, `?` and `:` are indicators only where they actually act as one: at the
 * end of the value, or followed by a space. `-1` and `?key` are ordinary plain
 * scalars in YAML's own `ns-plain-first`, and refusing them outright would both
 * reject well-formed documents and misreport `version: -1` as a block sequence.
 */
const CONDITIONAL_FIRST: ReadonlySet<string> = new Set(['-', '?', ':']);

const BOOLEAN_LIKE = /^(?:y|n|yes|no|true|false|on|off)$/i;
const NULL_LIKE = /^(?:null|~)$/i;
const DECIMAL_LIKE = /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][-+]?\d+)?$/;
const RADIX_LIKE = /^[-+]?0[xXoObB][0-9a-fA-F_]+$/;
const SPECIAL_FLOAT_LIKE = /^[-+]?\.(?:inf|nan)$/i;
const SEXAGESIMAL_LIKE = /^[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?$/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}$/;
const DELETE_CODE = 0x7f;

function controlCharacterAt(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === DELETE_CODE) return i;
  }
  return -1;
}

/**
 * Why `value` cannot be written as a plain scalar, or `null` if it can.
 *
 * "Can" means the scanner reads the emitted line back as exactly this string —
 * not merely that some YAML reader would accept it.
 */
export function plainScalarDefect(value: string): string | null {
  if (value.length === 0) {
    return 'an empty value must be quoted';
  }
  if (value.includes('\n') || value.includes('\r')) {
    return 'a plain scalar is a single line';
  }
  if (value.startsWith(' ')) {
    return 'a leading space would be lost';
  }
  if (value.endsWith(' ')) {
    return 'a trailing space would be lost';
  }
  const first = value[0];
  const excluded = PLAIN_FIRST_EXCLUDED.get(first);
  const indicates = !CONDITIONAL_FIRST.has(first) || value.length === 1 || value[1] === ' ';
  if (excluded !== undefined && indicates) {
    return excluded;
  }
  if (value.includes('\t')) {
    return 'a tab may not appear in a plain scalar';
  }
  const control = controlCharacterAt(value);
  if (control !== -1) {
    return 'a control character may not appear in a plain scalar';
  }
  if (value.includes(': ')) {
    return "a plain scalar may not contain ': '";
  }
  if (value.endsWith(':')) {
    return 'a plain scalar may not end with a colon';
  }
  if (value.includes(' #')) {
    return 'a plain scalar may not contain a comment marker';
  }
  return null;
}

/**
 * Whether another reader would resolve this text to a non-string type. Our own
 * parser never does; this exists so the documents we write survive tools that
 * do (research R5).
 */
export function looksTyped(value: string): boolean {
  return (
    BOOLEAN_LIKE.test(value) ||
    NULL_LIKE.test(value) ||
    DECIMAL_LIKE.test(value) ||
    RADIX_LIKE.test(value) ||
    SPECIAL_FLOAT_LIKE.test(value) ||
    SEXAGESIMAL_LIKE.test(value) ||
    DATE_LIKE.test(value)
  );
}

/** Whether `value` must be emitted quoted rather than plain. */
export function requiresQuoting(value: string): boolean {
  return plainScalarDefect(value) !== null || looksTyped(value);
}

/**
 * `|-` clips the final line break and takes its indentation from the first
 * content line, so a value that ends in a newline, carries a carriage return,
 * opens with indentation, contains a whitespace-only line, or contains a raw
 * control character cannot survive it. Those fall back to double quotes, where
 * every one of them is representable as an escape.
 */
function blockLiteralIsLossless(value: string): boolean {
  if (!value.includes('\n')) return false;
  if (value.includes('\r')) return false;
  if (value.endsWith('\n')) return false;

  const lines = value.split('\n');
  if (lines[0].startsWith(' ') || lines[0].startsWith('\t')) return false;
  for (const line of lines) {
    if (line.length > 0 && line.trim().length === 0) return false;
    const control = controlCharacterAt(line);
    if (control !== -1 && line[control] !== '\t') return false;
  }
  return true;
}

/** The single style decision the serializer makes for every scalar. */
export function chooseScalarStyle(value: string): ScalarStyle {
  if (blockLiteralIsLossless(value)) return 'block';
  return requiresQuoting(value) ? 'double' : 'plain';
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t'
};

/** Emit `value` as a double-quoted scalar the scanner decodes back exactly. */
export function quoteDouble(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const escape = ESCAPES[char];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = value.charCodeAt(i);
    out +=
      code < 0x20 || code === DELETE_CODE
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : char;
  }
  return `${out}"`;
}
