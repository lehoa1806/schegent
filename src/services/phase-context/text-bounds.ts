/**
 * FR-R6-F15 (F15-A; FR-017, NFR-001; research R3) — the rules every piece of source text
 * passes before it may enter a manifest: a size in UTF-8 bytes, well-formed text, and no
 * control character that could end a quoted line, hide text from a reader or change the order
 * a reader sees it in.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export type TextFault = 'empty' | 'too-long' | 'ill-formed' | 'control-character';

const TAB = 0x09;
const LINE_FEED = 0x0a;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const LAST_C1_CONTROL = 0x9f;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
/** The bidirectional embeddings and overrides: text after one can be shown in another order. */
const BIDI_EMBEDDING_FIRST = 0x202a;
const BIDI_EMBEDDING_LAST = 0x202e;
/** The bidirectional isolates and the character that ends one. */
const BIDI_ISOLATE_FIRST = 0x2066;
const BIDI_ISOLATE_LAST = 0x2069;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isForbiddenControl(unit: number): boolean {
  if (unit < FIRST_PRINTABLE) return unit !== TAB && unit !== LINE_FEED;
  if (unit >= DELETE && unit <= LAST_C1_CONTROL) return true;
  if (unit === LINE_SEPARATOR || unit === PARAGRAPH_SEPARATOR) return true;
  if (unit >= BIDI_EMBEDDING_FIRST && unit <= BIDI_EMBEDDING_LAST) return true;
  return unit >= BIDI_ISOLATE_FIRST && unit <= BIDI_ISOLATE_LAST;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= LOW_SURROGATE_FIRST && unit <= LOW_SURROGATE_LAST;
}

/** The first fault found in the code units of the text, or `null`. */
function unitFault(text: string): TextFault | null {
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    if (isLowSurrogate(unit)) return 'ill-formed';
    if (isHighSurrogate(unit)) {
      if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) return 'ill-formed';
      index += 2;
      continue;
    }
    if (isForbiddenControl(unit)) return 'control-character';
    index += 1;
  }
  return null;
}

/**
 * What is wrong with the text, or `null`. A text of exactly `maxBytes` is accepted. A tab and a
 * line feed are the only control characters allowed. The bidirectional embeddings, overrides
 * and isolates (U+202A to U+202E, U+2066 to U+2069) are refused as control characters; the
 * directional marks and the zero-width characters, which right-to-left prose needs, are not.
 */
export function textFault(text: string, maxBytes: number): TextFault | null {
  if (text.length === 0) return 'empty';
  // A character is at least one byte, so more code units than bytes allowed is already too long.
  if (text.length > maxBytes) return 'too-long';
  const fault = unitFault(text);
  if (fault !== null) return fault;
  return utf8Bytes(text) > maxBytes ? 'too-long' : null;
}
