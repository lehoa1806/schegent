// Feature 020 T027 — per-field UTF-8 byte cap with char-boundary snap.
// See specs/020-phase-level-logs/contracts/phase-log-service.md §5 and
// research.md §6.

import { REDACTION_SENTINEL } from '../../lib/logger';
import {
  AGENT_DISPLAY_TITLE_MAX_CHARS,
  AGENT_DISPLAY_TITLE_PRE_CAP_CHARS,
  sanitizeAgentDisplayTitle
} from '../acp-runtime/agent-identifier';
import { isSentinel } from './live-log-entry-budget';
import type { PhaseLogDisplayEntry, ToolArgumentValue } from './types';

/** Lookahead past `perFieldBytes` sanitized before final byte capping (SR-A2 #2 / CR-A2 #3). */
export const TRUNCATE_SANITIZE_LOOKAHEAD_BYTES = 4_096;

/**
 * Linear-time truncated-JWT detectors used ONLY when lookahead slicing cut a whitespace-free
 * token mid-token (SR-A2 #2 / SR-A3 #1) so an oversized JWT (including post-dot 0..5 char tails
 * and glued-prefix headers) whose closing segment fell past the lookahead fails closed.
 */
const TRUNCATED_JWT_RE =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*eyJ[A-Za-z0-9_-]{6,})[A-Za-z0-9_-]+\.(?:[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{0,5}$)/;
const TRUNCATED_JWT_HEADER_RE =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*eyJ[A-Za-z0-9_-]{64,})[A-Za-z0-9_-]+$/;
const PEM_HEADER_RE = /-----BEGIN [A-Z0-9 ]+-----/g;
const WHITESPACE_CHAR_RE = /\s/;

const CAPPED_FIELDS = [
  'text',
  'toolName',
  'toolInput',
  'toolResult',
  'systemSummary',
  'resultSummary'
] as const;
type CappedField = (typeof CAPPED_FIELDS)[number];

interface TruncateResult {
  readonly value: string;
  readonly originalLength: number | null;
}

function truncateUtf8(value: string, capBytes: number): TruncateResult {
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength <= capBytes) {
    return { value, originalLength: null };
  }
  // Every UTF-16 code unit encodes to at least 1 UTF-8 byte, so the first
  // `capBytes` code units are guaranteed to cover any prefix <= `capBytes` bytes.
  // Slicing before `Buffer.from` avoids multi-MiB buffer allocations on oversized
  // fields, then snaps back to a valid UTF-8 boundary (continuation bytes are
  // 10xxxxxx, 0x80..0xBF).
  const maxCodeUnits = Math.max(0, capBytes);
  const candidate = value.length > maxCodeUnits ? value.slice(0, maxCodeUnits) : value;
  const buf = Buffer.from(candidate, 'utf8');
  let cut = Math.min(maxCodeUnits, buf.length);
  // Walk left until the byte AT the cut position is a leading byte
  // (i.e. NOT a continuation byte). If we cut at byte `cut`, the bytes
  // included are [0, cut). The first byte excluded is at index `cut`.
  // If byte[cut] is a continuation byte, byte[cut-1..cut] is a partial
  // codepoint — back up.
  while (cut > 0 && cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut -= 1;
  const truncated = buf.subarray(0, cut).toString('utf8');
  return { value: truncated, originalLength: byteLength };
}

function lastWhitespaceIndex(value: string): number {
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (WHITESPACE_CHAR_RE.test(value.charAt(i))) {
      return i;
    }
  }
  return -1;
}

function hasNonWhitespaceBefore(value: string, endIndex: number): boolean {
  for (let i = 0; i < endIndex; i += 1) {
    if (!WHITESPACE_CHAR_RE.test(value.charAt(i))) {
      return true;
    }
  }
  return false;
}

function pemHeaderEndSpanning(value: string, wsIdx: number): number {
  const windowStart = Math.max(0, wsIdx - 80);
  const windowEnd = Math.min(value.length, wsIdx + 80);
  const snippet = value.slice(windowStart, windowEnd);
  PEM_HEADER_RE.lastIndex = 0;
  let match = PEM_HEADER_RE.exec(snippet);
  while (match !== null) {
    const absStart = windowStart + match.index;
    const absEnd = absStart + match[0].length;
    if (absStart < wsIdx && absEnd > wsIdx) {
      return absEnd;
    }
    match = PEM_HEADER_RE.exec(snippet);
  }
  return -1;
}

/**
 * SR-A2 #2 / CR-A2 #3 — when a capped body field exceeds `capBytes` and a caller `sanitize`
 * function is supplied, sanitize a bounded lookahead prefix (`capBytes + 4096` bytes) BEFORE
 * snapping to `capBytes`, dropping any incomplete trailing token split at the lookahead boundary
 * and failing closed on truncated oversized JWTs or secret-pull tails.
 */
function truncateWithSanitize(
  raw: string,
  capBytes: number,
  sanitize: (s: string) => string
): TruncateResult {
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes <= capBytes) {
    return { value: raw, originalLength: null };
  }

  const lookaheadCap = capBytes + TRUNCATE_SANITIZE_LOOKAHEAD_BYTES;
  const lookahead = truncateUtf8(raw, lookaheadCap);
  const cutAtLookahead = lookahead.originalLength !== null;
  let candidate = lookahead.value;
  let singleBlobCut = false;

  if (cutAtLookahead && candidate.length > 0) {
    const lastChar = candidate.charAt(candidate.length - 1);
    const nextChar = raw.charAt(candidate.length);
    const cutMidToken = !WHITESPACE_CHAR_RE.test(lastChar) && !WHITESPACE_CHAR_RE.test(nextChar);
    if (cutMidToken) {
      const lastWs = lastWhitespaceIndex(candidate);
      if (lastWs > 0 && hasNonWhitespaceBefore(candidate, lastWs)) {
        const pemEnd = pemHeaderEndSpanning(candidate, lastWs);
        candidate = pemEnd !== -1 ? candidate.slice(0, pemEnd) : candidate.slice(0, lastWs);
      } else {
        singleBlobCut = true;
        if (TRUNCATED_JWT_RE.test(candidate) || TRUNCATED_JWT_HEADER_RE.test(candidate)) {
          return {
            value: truncateUtf8(REDACTION_SENTINEL, capBytes).value,
            originalLength: rawBytes
          };
        }
      }
    }
  }

  let sanitized = sanitize(candidate);
  // SR-A3 #2: fail closed directly to `REDACTION_SENTINEL` whenever a single whitespace-free blob
  // was cut mid-token at the lookahead boundary and redaction mutated it, blocking sentinel
  // injection and secret-pull tails.
  if (singleBlobCut && sanitized !== candidate) {
    sanitized = REDACTION_SENTINEL;
  }

  const { value } = truncateUtf8(sanitized, capBytes);
  return { value, originalLength: rawBytes };
}

export interface TruncateCaps {
  readonly perFieldBytes: number;
  readonly sanitize?: ((s: string) => string) | undefined;
}

type SafeJsonStringifyResult =
  | { readonly ok: true; readonly text: string; readonly byteLength: number }
  | { readonly ok: false };

function safeJsonStringifyByteLength(value: ToolArgumentValue): SafeJsonStringifyResult {
  let text: unknown;
  try {
    text = JSON.stringify(value);
  } catch {
    return { ok: false };
  }
  if (typeof text !== 'string') {
    return { ok: false };
  }
  return { ok: true, text, byteLength: Buffer.byteLength(text, 'utf8') };
}

export function truncateDisplayEntryBody(
  entry: PhaseLogDisplayEntry,
  caps: TruncateCaps
): PhaseLogDisplayEntry {
  const newBody: { [k: string]: unknown } = { ...entry.body };
  const truncatedMap: { [k: string]: { originalLength: number } } = {};
  let anyTruncated = false;
  for (const field of CAPPED_FIELDS) {
    const raw = (entry.body as Partial<Record<CappedField, string>>)[field];
    if (typeof raw !== 'string') continue;
    if (field === 'toolName') {
      const rawBytes = Buffer.byteLength(raw, 'utf8');
      const fieldCapBytes = Math.min(caps.perFieldBytes, AGENT_DISPLAY_TITLE_MAX_CHARS);
      if (rawBytes > fieldCapBytes) {
        // SR-312-1 / SR-A3 #3: strip ANSI/bidi/controls and run both built-in and caller
        // `caps.sanitize` BEFORE the 4096 pre-cap slice and 128-byte UTF-8 cap so secrets
        // straddling either boundary or preceded by invisible/ANSI padding are never sliced
        // into unredacted partial tokens.
        const preCleaned = sanitizeAgentDisplayTitle(
          raw,
          AGENT_DISPLAY_TITLE_PRE_CAP_CHARS,
          caps.sanitize
        );
        const { value } = truncateUtf8(preCleaned ?? 'tool', fieldCapBytes);
        newBody[field] = value;
        truncatedMap[field] = { originalLength: rawBytes };
        anyTruncated = true;
      }
      continue;
    }
    const { value, originalLength } =
      caps.sanitize !== undefined
        ? truncateWithSanitize(raw, caps.perFieldBytes, caps.sanitize)
        : truncateUtf8(raw, caps.perFieldBytes);
    if (originalLength !== null) {
      newBody[field] = value;
      // Record the BYTE length of the original string, per FR-026 /
      // research.md §6.
      truncatedMap[field] = { originalLength };
      anyTruncated = true;
    }
  }
  // Feature 029 — apply the same per-field byte cap to `toolArguments`
  // (measured against the JSON-stringified shape). If oversized or
  // unserializable (cyclic, BigInt, throwing/undefined `toJSON`), fail
  // closed by replacing with a typed truncation sentinel so downstream
  // sanitizer/budget code never sees unserializable shapes. The legacy
  // `toolInput` string remains the canonical truncation source for
  // fallback rendering.
  const args = entry.body.toolArguments;
  if (args !== undefined && !isSentinel(args)) {
    const serialized = safeJsonStringifyByteLength(args);
    if (!serialized.ok) {
      const originalBytes = caps.perFieldBytes + 1;
      newBody['toolArguments'] = { __truncated: true, originalBytes };
      truncatedMap['toolArguments'] = { originalLength: originalBytes };
      anyTruncated = true;
    } else if (serialized.byteLength > caps.perFieldBytes) {
      newBody['toolArguments'] = { __truncated: true, originalBytes: serialized.byteLength };
      truncatedMap['toolArguments'] = { originalLength: serialized.byteLength };
      anyTruncated = true;
    }
  }
  return {
    ...entry,
    body: newBody as PhaseLogDisplayEntry['body'],
    bodyTruncated: anyTruncated
      ? (truncatedMap as PhaseLogDisplayEntry['bodyTruncated'])
      : null
  };
}
