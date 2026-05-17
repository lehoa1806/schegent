// Feature 031 — wake-up session-log block writer.
//
// Composes one block per spawning wake-up invocation and appends it
// atomically to `<globalStorageUri>/wakeup/session.log`. Pairs with
// `session-log-reader.ts` which scans the same file by `correlationId`.
//
// Block shape (single source of truth — must mirror the reader's
// `BLOCK_HEADER_PREFIX` / `BLOCK_HEADER_SUFFIX` scan):
//
//   === wakeup-block <iso> id=<uuid> trigger=<src> model=<id> status=<status> ===\n
//   <body bytes — already sanitized by the caller — ending with \n>
//
// Invariants:
//
//   (a) Caller-sanitized body. This writer is a SINK — it never carries
//       its own sanitizer. The runner sanitizes the SessionCaptureRing
//       output once via `SanitizedLogger.sanitize` and hands the result
//       in. The block body is written verbatim. The reader sanitizes
//       again at the IPC boundary (defense-in-depth, single
//       `SECRET_PATTERNS` source from `src/lib/logger.ts`).
//   (b) O_APPEND semantics. Uses `fs.appendFile`, which opens with
//       `O_APPEND` on POSIX and the equivalent atomic-append flag on
//       Win32. Two concurrent appends from different processes do not
//       interleave at the kernel level.
//   (c) Never throws. ENOSPC / EACCES / EBUSY / EROFS (and other
//       errno-carrying failures) collapse to a closed-vocabulary
//       `'write-failed'` outcome with a canonicalized reason
//       (`'session-log-write-failed:<lower-case-errno>'`). The runner
//       records the reason on the InvocationRecord and continues —
//       the priming spawn MUST never block on disk hygiene.
//   (d) Soft cap trim at the 32 MB block boundary. After each
//       successful append, if the on-disk size exceeds
//       `SESSION_LOG_MAX_BYTES`, the writer drops the oldest *complete*
//       blocks from the head until the file is at or below the cap.
//       The remaining head MUST always start at `BLOCK_HEADER_PREFIX`
//       — no partial mid-block bytes survive.
//   (e) Hard cap defense-in-depth at 128 MB. If a hand-edit corruption
//       breaks the block-boundary scan and the file balloons past
//       `SESSION_LOG_HARD_CAP_BYTES`, the writer emergency-truncates
//       to the last ~64 MB at the next block boundary (or to size 0
//       with a `hard-cap-emergency-truncate` annotation if no
//       boundary is found in the surviving tail). The newly composed
//       block is then appended to whatever remains.
//   (f) Recursive parent dir create. If `<wakeup home>/` does not
//       exist, the writer creates it (and any missing intermediate
//       parents) before the first append.
//   (g) `vscode`-import-free. The wake-up runner bundles this module
//       into `dist/wakeup-runner.js` which runs OUTSIDE the extension
//       host — reaching the VS Code namespace would blow up the
//       OS-scheduler spawn (014 hard rule, retained for 031).
//
// HARD RULES (CLAUDE.md):
//   * `SECRET_PATTERNS` is the SINGLE redaction source. This module
//     does NOT carry a sanitizer — the caller is responsible for the
//     single pass.
//   * Operator-supplied paths are NEVER accepted by this writer. The
//     caller (the headless runner) composes `sessionLogPath` from the
//     internal `<globalStorageUri>/wakeup/` convention.

import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  BLOCK_HEADER_PREFIX,
  BLOCK_HEADER_SUFFIX,
  SESSION_LOG_HARD_CAP_BYTES,
  SESSION_LOG_MAX_BYTES
} from './session-log-constants';

/**
 * Structured header fields composed into the block's first line.
 *
 *   `=== wakeup-block <iso> id=<uuid> trigger=<src> model=<id> status=<status> ===`
 *
 * Values are emitted VERBATIM into the header line — no escaping,
 * no quoting. The caller is responsible for never embedding a `\n`
 * or `=` into a free-form field; today only `model` is operator-set
 * and the upstream validator already rejects newlines/whitespace.
 */
export interface AppendBlockHeader {
  /** ISO-8601 UTC timestamp at invocation start (no millis suffix required). */
  readonly iso: string;
  /** UUIDv4 correlation id of this invocation. */
  readonly correlationId: string;
  /** Wake-up trigger source. */
  readonly trigger: 'scheduled' | 'manual';
  /** Effective model id (resolved by the runner — defaults to `runner-default`). */
  readonly model: string;
  /**
   * Final outcome enum — mirrors the InvocationRecord's `status`
   * vocabulary. `skipped` / `timed-out` are valid wire values but
   * never reach this writer (lock-skipped → no block at all;
   * `timed-out` is a terminal failure that DOES write a block).
   */
  readonly status: 'succeeded' | 'failed' | 'timed-out';
}

export interface AppendBlockOptions {
  /** Absolute path to `<globalStorageUri>/wakeup/session.log`. */
  readonly sessionLogPath: string;
  readonly header: AppendBlockHeader;
  /**
   * Caller-sanitized body. MUST end with a trailing newline. The
   * writer does NOT add a newline; the bytes are passed verbatim
   * into the file so a missing trailing newline causes the next
   * block's header to land on the same line — visible to the
   * operator and fixable by the upstream call site.
   */
  readonly body: string;
  /**
   * Test-only override of the soft cap. Production callers omit
   * this — the writer uses `SESSION_LOG_MAX_BYTES`. Unit tests pass
   * a small value (e.g. 1 KB) so retention trim can be exercised
   * without writing megabytes.
   */
  readonly maxBytesOverride?: number;
  /**
   * Test-only override of the hard cap. Production callers omit
   * this. Tests pin this above `maxBytesOverride` to exercise the
   * emergency-truncate path.
   */
  readonly hardCapOverride?: number;
}

export type AppendBlockResult =
  | {
      readonly outcome: 'appended';
      readonly bytesAppended: number;
      readonly trimmed: boolean;
      readonly trimAnnotation?: 'hard-cap-emergency-truncate';
    }
  | {
      readonly outcome: 'write-failed';
      readonly reason: string;
    };

/**
 * Append one wake-up block to `sessionLogPath`. Never throws —
 * disk/IO failures collapse to a closed-vocabulary
 * `'write-failed'` outcome.
 */
export async function appendBlock(
  options: AppendBlockOptions
): Promise<AppendBlockResult> {
  const softCap = options.maxBytesOverride ?? SESSION_LOG_MAX_BYTES;
  const hardCap = options.hardCapOverride ?? SESSION_LOG_HARD_CAP_BYTES;

  const composed = composeBlock(options.header, options.body);
  const composedBytes = Buffer.byteLength(composed, 'utf8');

  // (1) Ensure the parent dir exists. Recursive mkdir is idempotent
  // and tolerates the dir already existing. If mkdir fails (e.g. the
  // parent of the wakeup home is unwritable), we collapse the error
  // to the canonical write-failed shape WITHOUT throwing.
  try {
    await fs.mkdir(dirname(options.sessionLogPath), { recursive: true });
  } catch (err) {
    return {
      outcome: 'write-failed',
      reason: canonicalizeErrno(err)
    };
  }

  // (2) Hard-cap defense-in-depth scan BEFORE append. If the file is
  // already past the hard cap (corruption or hand-edit), emergency-
  // truncate to a clean tail (or zero) and annotate the result.
  let trimmed = false;
  let trimAnnotation: 'hard-cap-emergency-truncate' | undefined;
  try {
    const existing = await readIfExists(options.sessionLogPath);
    if (existing !== null && existing.length > hardCap) {
      const emergency = emergencyTruncate(existing, hardCap);
      await fs.writeFile(options.sessionLogPath, emergency, 'utf8');
      trimmed = true;
      trimAnnotation = 'hard-cap-emergency-truncate';
    }
  } catch (err) {
    return {
      outcome: 'write-failed',
      reason: canonicalizeErrno(err)
    };
  }

  // (3) Atomic append.
  try {
    await fs.appendFile(options.sessionLogPath, composed, 'utf8');
  } catch (err) {
    return {
      outcome: 'write-failed',
      reason: canonicalizeErrno(err)
    };
  }

  // (4) Soft-cap retention pass at block boundary.
  try {
    const stat = await fs.stat(options.sessionLogPath);
    if (stat.size > softCap) {
      const raw = await fs.readFile(options.sessionLogPath, 'utf8');
      const trimmedContent = trimAtBlockBoundary(raw, softCap);
      if (trimmedContent !== null && trimmedContent.length < raw.length) {
        await fs.writeFile(options.sessionLogPath, trimmedContent, 'utf8');
        trimmed = true;
      } else if (trimmedContent === null && raw.length > hardCap) {
        // The soft-cap scan failed (no block boundaries found) AND the
        // file is past the hard cap — fall through to emergency
        // truncate of the post-append content.
        const emergency = emergencyTruncate(raw, hardCap);
        await fs.writeFile(options.sessionLogPath, emergency, 'utf8');
        trimmed = true;
        trimAnnotation = 'hard-cap-emergency-truncate';
      }
    }
  } catch (err) {
    // The append itself succeeded. A trim failure is non-fatal — we
    // surface it so the operator's audit pipeline can see the issue
    // but the priming invocation result is still 'appended'. Use the
    // 'write-failed' shape with a distinct prefix so callers can tell
    // it apart from a pre-append failure.
    return {
      outcome: 'write-failed',
      reason: canonicalizeErrno(err)
    };
  }

  return {
    outcome: 'appended',
    bytesAppended: composedBytes,
    trimmed,
    ...(trimAnnotation !== undefined ? { trimAnnotation } : {})
  };
}

/**
 * Compose the block's leading header line + body. The header is the
 * canonical form scanned by `session-log-reader.ts` and trimmed at
 * by the retention pass.
 */
function composeBlock(header: AppendBlockHeader, body: string): string {
  const line =
    `${BLOCK_HEADER_PREFIX}${header.iso} id=${header.correlationId} ` +
    `trigger=${header.trigger} model=${header.model} status=${header.status}` +
    `${BLOCK_HEADER_SUFFIX}\n`;
  return line + body;
}

/**
 * Trim `raw` at the soft cap by dropping the oldest *complete*
 * blocks from the head until the surviving tail fits in `softCap`
 * bytes AND starts at a block boundary. Returns the trimmed string,
 * or `null` if no block boundary was found at all (caller falls
 * through to the hard-cap emergency truncate).
 */
function trimAtBlockBoundary(raw: string, softCap: number): string | null {
  // Locate every block-boundary index in document order.
  const boundaries: number[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const next = raw.indexOf(BLOCK_HEADER_PREFIX, cursor);
    if (next === -1) break;
    boundaries.push(next);
    cursor = next + BLOCK_HEADER_PREFIX.length;
  }
  if (boundaries.length === 0) return null;

  // Walk boundaries from oldest → newest. Drop the head until the
  // resulting suffix size is <= softCap. The newest block always
  // survives (we never trim past the last boundary).
  for (let i = 0; i < boundaries.length; i++) {
    const trialStart = boundaries[i];
    const trialSize = Buffer.byteLength(raw.substring(trialStart), 'utf8');
    if (trialSize <= softCap) {
      return raw.substring(trialStart);
    }
  }
  // Even keeping only the newest block exceeds the soft cap. Return
  // the newest block alone — the priming run prefers a too-large
  // last block over losing it entirely.
  return raw.substring(boundaries[boundaries.length - 1]);
}

/**
 * Emergency truncate for the hard-cap path. Keeps the last `target`
 * bytes (with `target = floor(hardCap / 2)`) re-anchored at the
 * next block boundary. If no block boundary exists in the surviving
 * tail (corruption), returns an empty string.
 */
function emergencyTruncate(raw: string, hardCap: number): string {
  const targetBytes = Math.floor(hardCap / 2);
  // Convert to a byte-bounded tail; UTF-8 multi-byte runes that
  // straddle the boundary are truncated cleanly here (the next
  // block boundary scan ignores any leading garbage).
  const buf = Buffer.from(raw, 'utf8');
  if (buf.byteLength <= targetBytes) {
    // Nothing to drop — return the original. The caller already
    // verified `raw.length > hardCap` so this should not occur, but
    // we guard against it for safety.
    return raw;
  }
  const tailBuf = buf.subarray(buf.byteLength - targetBytes);
  const tail = tailBuf.toString('utf8');
  const nextBoundary = tail.indexOf(BLOCK_HEADER_PREFIX);
  if (nextBoundary === -1) {
    // No clean block boundary in the surviving tail — zero out the
    // file. The next append composes a fresh block at offset 0.
    return '';
  }
  return tail.substring(nextBoundary);
}

/**
 * Read the file if it exists. Returns null on ENOENT; rethrows
 * other errors so the caller can collapse them via
 * `canonicalizeErrno`.
 */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Collapse an errno-carrying Error into a canonical
 * `'session-log-write-failed:<errno>'` string. Non-errno failures
 * (plain `Error` with no `code`) collapse to
 * `'session-log-write-failed:unknown'`.
 */
function canonicalizeErrno(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) {
    return `session-log-write-failed:${code.toLowerCase()}`;
  }
  return 'session-log-write-failed:unknown';
}
