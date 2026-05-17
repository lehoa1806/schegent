// Feature 031 T035 — wake-up session-log block reader.
//
// Scans `<wakeup home>/session.log` for the block whose header carries
// `id=<correlationId>` and returns the projected body capped at
// `SESSION_PROJECTION_MAX_BYTES` (32 KB). The on-disk file is composed
// by the headless runner (`src/headless/wakeup-runner.ts` via the
// writer landing in US3) — this module is the read counterpart used by
// the host IPC dispatcher in `src/ui/sidebar/message-router.ts`.
//
// Invariants:
//
//   (a) Fresh-read-per-request. No in-memory cache. A subsequent write
//       is visible on the next call. This trades a few extra disk
//       reads for predictable freshness; the operator triggers reads
//       one at a time from the UI so the IO cost is acceptable.
//   (b) UUIDv4 shape gate. Even though the host IPC dispatcher checks
//       the shape first, the reader gates again as defense-in-depth
//       — a non-canonical id resolves to `unknown-correlation-id`
//       BEFORE any filesystem read.
//   (c) Single sanitization point. The injected `sanitize` callback
//       (the host's `SanitizedLogger.sanitize`) is invoked exactly
//       once per block read. The on-disk bytes are also sanitized at
//       write time (defense in depth); the reader's pass is the IPC
//       boundary pass and is the SINGLE PASS this layer performs.
//   (d) Block boundary scan. Each block begins with
//       `BLOCK_HEADER_PREFIX` and ends at the NEXT
//       `BLOCK_HEADER_PREFIX` boundary (or EOF). The reader matches
//       the id substring inside the header line; the body is every
//       byte AFTER the header line up to (but not including) the next
//       header or EOF.
//   (e) 32 KB projection cap. If the on-disk body exceeds
//       `SESSION_PROJECTION_MAX_BYTES`, the reader returns the last
//       32 KB sanitized tail and sets `bodyTruncated: true`. The
//       `fullBlockBytesOnDisk` field surfaces the pre-projection byte
//       count so the UI can render a "see full file" affordance.
//   (f) `vscode`-import-free. The reader uses `node:fs/promises` only
//       so it remains usable from any host service module without
//       reaching the VS Code namespace transitively.
//
// HARD RULES (CLAUDE.md):
//   * `SECRET_PATTERNS` is the SINGLE redaction source — the reader
//     accepts an injected sanitize callback and MUST NOT carry its
//     own sanitizer. The dispatcher injects `SanitizedLogger.sanitize`.
//   * Operator-supplied paths are NEVER accepted by this reader. The
//     dispatcher composes `sessionLogPath` from the internal
//     `<globalStorageUri>/wakeup/` convention and passes the absolute
//     path to this function.

import { promises as fs } from 'node:fs';
import {
  BLOCK_HEADER_PREFIX,
  BLOCK_HEADER_SUFFIX,
  SESSION_PROJECTION_MAX_BYTES
} from './session-log-constants';

/** Canonical RFC 4122 UUIDv4 — 36 chars, lowercase hex, version=4, variant in 8-b. */
const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Parsed metadata projected from the block header line. Fields mirror
 * the contract's success-response shape (excluding the
 * `correlationId` which the caller already has).
 *
 * `outcome` collapses the runner's `status` → 'succeeded' | 'failed'
 * since `skipped` and `timed-out` records never write a session block.
 * A header with an unrecognised status defaults to 'failed' (closed
 * vocabulary on the wire; the unrecognised value is intentionally
 * unobservable to the operator).
 */
export interface SessionBlockHeader {
  readonly capturedAtMs: number;
  readonly trigger: 'scheduled' | 'manual';
  readonly model: string;
  readonly outcome: 'succeeded' | 'failed';
}

export type ReadSessionBlockResult =
  | {
      readonly outcome: 'success';
      readonly header: SessionBlockHeader;
      readonly body: string;
      readonly bodyTruncated: boolean;
      readonly fullBlockBytesOnDisk: number;
    }
  | { readonly outcome: 'unknown-correlation-id' }
  | { readonly outcome: 'session-log-unavailable' };

/**
 * Read the session-log block for `correlationId`.
 *
 * @param correlationId - canonical RFC 4122 UUIDv4 of the invocation
 * @param sessionLogPath - absolute path to `<globalStorageUri>/wakeup/session.log`
 * @param sanitize - the host's `SanitizedLogger.sanitize` callback;
 *   invoked exactly once on the projected body
 */
export async function readSessionBlock(
  correlationId: string,
  sessionLogPath: string,
  sanitize: (input: string) => string
): Promise<ReadSessionBlockResult> {
  // Defense-in-depth UUIDv4 shape gate. The dispatcher checks first;
  // the reader checks again so a misuse from a unit-test or future
  // caller never composes a filesystem read with a non-canonical id.
  if (!UUIDV4_RE.test(correlationId)) {
    return { outcome: 'unknown-correlation-id' };
  }

  let raw: string;
  try {
    raw = await fs.readFile(sessionLogPath, 'utf8');
  } catch {
    // ENOENT, EACCES, EISDIR — all collapse to the same operator-facing
    // signal. The IPC dispatcher logs the sanitized cause at the
    // boundary; the reader does not.
    return { outcome: 'session-log-unavailable' };
  }

  const block = locateBlock(raw, correlationId);
  if (block === null) return { outcome: 'unknown-correlation-id' };

  const header = parseHeader(block.headerLine);
  if (header === null) return { outcome: 'unknown-correlation-id' };

  const fullBlockBytesOnDisk = Buffer.byteLength(block.body, 'utf8');
  const truncated = fullBlockBytesOnDisk > SESSION_PROJECTION_MAX_BYTES;
  const projectedBytes = truncated
    ? tailBytes(block.body, SESSION_PROJECTION_MAX_BYTES)
    : block.body;
  const body = sanitize(projectedBytes);

  return {
    outcome: 'success',
    header,
    body,
    bodyTruncated: truncated,
    fullBlockBytesOnDisk
  };
}

interface LocatedBlock {
  readonly headerLine: string;
  readonly body: string;
}

/**
 * Scan `raw` for the block whose header carries `id=<correlationId>`.
 * The match is a substring search on the header line; the body is
 * every byte AFTER the header's trailing newline up to the start of
 * the next header line (or EOF).
 *
 * Returns null if no block matches.
 */
function locateBlock(raw: string, correlationId: string): LocatedBlock | null {
  const idMarker = `id=${correlationId}`;
  let cursor = 0;
  while (cursor < raw.length) {
    const headerStart = raw.indexOf(BLOCK_HEADER_PREFIX, cursor);
    if (headerStart === -1) return null;
    const headerLineEnd = raw.indexOf('\n', headerStart);
    if (headerLineEnd === -1) return null;
    const headerLine = raw.substring(headerStart, headerLineEnd);
    if (headerLine.includes(idMarker)) {
      const bodyStart = headerLineEnd + 1;
      const nextHeader = raw.indexOf(BLOCK_HEADER_PREFIX, bodyStart);
      const bodyEnd = nextHeader === -1 ? raw.length : nextHeader;
      return {
        headerLine,
        body: raw.substring(bodyStart, bodyEnd)
      };
    }
    cursor = headerLineEnd + 1;
  }
  return null;
}

/**
 * Parse the block header line into its structured fields.
 *
 * Expected format:
 *   `=== wakeup-block <iso> id=<uuid> trigger=<src> model=<id> status=<status> ===`
 *
 * Returns null if the header is malformed (missing fields, bad ISO,
 * bad enum value); the caller collapses null → `unknown-correlation-id`
 * since a malformed header is indistinguishable from a missing block
 * for the read flow.
 */
function parseHeader(headerLine: string): SessionBlockHeader | null {
  // Strip the prefix + suffix to get the inner key=value tokens.
  if (!headerLine.startsWith(BLOCK_HEADER_PREFIX)) return null;
  if (!headerLine.endsWith(BLOCK_HEADER_SUFFIX)) return null;
  const inner = headerLine.substring(
    BLOCK_HEADER_PREFIX.length,
    headerLine.length - BLOCK_HEADER_SUFFIX.length
  );
  // Tokens are space-separated: `<iso>` then `key=value`* pairs.
  const tokens = inner.trim().split(/\s+/);
  if (tokens.length < 5) return null;
  const iso = tokens[0];
  const capturedAtMs = Date.parse(iso);
  if (!Number.isFinite(capturedAtMs)) return null;

  const kv = new Map<string, string>();
  for (let i = 1; i < tokens.length; i++) {
    const eq = tokens[i].indexOf('=');
    if (eq <= 0) continue;
    kv.set(tokens[i].substring(0, eq), tokens[i].substring(eq + 1));
  }

  const triggerRaw = kv.get('trigger');
  const trigger: 'scheduled' | 'manual' =
    triggerRaw === 'manual' ? 'manual' : 'scheduled';
  const model = kv.get('model') ?? 'runner-default';
  const statusRaw = kv.get('status');
  const outcome: 'succeeded' | 'failed' =
    statusRaw === 'succeeded' ? 'succeeded' : 'failed';

  return { capturedAtMs, trigger, model, outcome };
}

/**
 * Return the last `maxBytes` of a UTF-8 string, byte-bounded. Slice
 * by bytes (not characters) because the cap is a wire/storage budget.
 * Multi-byte runes that straddle the boundary are truncated cleanly —
 * acceptable for log-projection output.
 */
function tailBytes(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.byteLength <= maxBytes) return input;
  return bytes.subarray(bytes.byteLength - maxBytes).toString('utf8');
}
