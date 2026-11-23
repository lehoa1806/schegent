// Feature 020 T027 — per-field UTF-8 byte cap with char-boundary snap.
// See specs/020-phase-level-logs/contracts/phase-log-service.md §5 and
// research.md §6.

import { isSentinel } from './live-log-entry-budget';
import type { PhaseLogDisplayEntry, ToolArgumentValue } from './types';

const CAPPED_FIELDS = [
  'text',
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

export interface TruncateCaps {
  readonly perFieldBytes: number;
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
    const { value, originalLength } = truncateUtf8(raw, caps.perFieldBytes);
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
