// Feature 031 T034 — wake-up session capture ring buffer.
//
// The headless wake-up runner spawns the Claude CLI subprocess and
// captures its stdout + stderr. Captured bytes flow into this bounded
// 64 KB FIFO ring (the cap is `SESSION_CAPTURE_MAX_BYTES` from
// `src/wakeup/session-log-constants.ts`). At end of invocation the
// captured bytes pass through `SanitizedLogger.sanitize` exactly once
// — the on-disk session-log block and the compact 4 KB `rawResponse`
// projection BOTH derive from that single sanitized buffer.
//
// Invariants pinned by `tests/unit/wakeup/session-capture-ring.test.ts`:
//
//   (a) Capture ≤ `SESSION_CAPTURE_MAX_BYTES` (64 KB): no eviction;
//       `truncated === false`.
//   (b) Capture > 64 KB: FIFO eviction of oldest bytes;
//       `truncated === true`. The most recent 64 KB survive.
//   (c) `projection` is the last `SESSION_CAPTURE_PROJECTION_BYTES`
//       (4 KB) of the sanitized full buffer (i.e. one pass; never
//       two). Used as the legacy `rawResponse` field on
//       `InvocationRecord`.
//   (d) `OUT:` / `ERR:` stream prefixes are preserved verbatim in
//       both `full` and `projection`.
//
// HARD RULES (CLAUDE.md):
//   * `SECRET_PATTERNS` is the SINGLE redaction source — this module
//     does NOT carry its own sanitizer; the caller injects the
//     `SanitizedLogger.sanitize` callback at finalize.
//   * `vscode`-import-free — the runner bundle ships as a standalone
//     CommonJS entry under `dist/wakeup-runner.js`.

import { SESSION_CAPTURE_MAX_BYTES } from './session-log-constants';

/**
 * 4 KB cap on the compact `rawResponse` projection. The wake-up runner
 * writes this onto the JSONL `InvocationRecord.rawResponse` field so
 * the existing UI surface (the "View recent runs" 5-row log) continues
 * to render the most recent tail of the captured stream. The full
 * 64 KB capture lands in the on-disk session-log block; the compact
 * projection is for the small UI preview, the body panel reads the
 * full block via `CMD_READ_WAKEUP_SESSION_LOG`.
 *
 * Kept module-local — not in `session-log-constants.ts` — because it
 * is specifically a ring-projection size and shares no semantics with
 * the larger session-log/IPC caps.
 */
export const SESSION_CAPTURE_PROJECTION_BYTES = 4 * 1024;

export type CaptureStream = 'out' | 'err';

interface CaptureChunk {
  readonly bytes: Buffer;
}

export interface SessionCaptureFinalizeResult {
  /** Sanitized full capture, ≤ `SESSION_CAPTURE_MAX_BYTES`. */
  readonly full: string;
  /** Sanitized last 4 KB tail, ≤ `SESSION_CAPTURE_PROJECTION_BYTES`. */
  readonly projection: string;
  /** True iff total appended bytes exceeded the 64 KB cap and FIFO eviction ran. */
  readonly truncated: boolean;
}

/**
 * Bounded 64 KB FIFO ring for stdout + stderr capture during a single
 * wake-up invocation. Each `append` prefixes the chunk with the stream
 * tag (`OUT: ` / `ERR: `). At `finalize`, the buffer is concatenated,
 * sanitized exactly once, and the compact projection is derived from
 * the sanitized tail.
 *
 * Usage:
 *   const ring = new SessionCaptureRing();
 *   child.stdout.on('data', (b) => ring.append('out', String(b)));
 *   child.stderr.on('data', (b) => ring.append('err', String(b)));
 *   const { full, projection, truncated } = ring.finalize(logger.sanitize.bind(logger));
 */
export class SessionCaptureRing {
  private readonly chunks: CaptureChunk[] = [];
  private _bytesAppended = 0;
  private _bytesBuffered = 0;
  private _truncated = false;

  /**
   * Append a stdout or stderr chunk. The stream prefix (`OUT: ` /
   * `ERR: `) is prepended verbatim so the on-disk block carries an
   * interleaved log of which stream each line came from.
   *
   * Pathologically large chunks are accepted; the FIFO eviction loop
   * trims the head until `_bytesBuffered <= SESSION_CAPTURE_MAX_BYTES`.
   * Bytes that have been evicted are NOT counted again; the
   * `bytesAppended()` accessor returns the lifetime byte count
   * (pre-eviction) which is what the eviction-watcher reads to decide
   * when to stop pushing.
   */
  public append(stream: CaptureStream, chunk: string): void {
    const prefix = stream === 'out' ? 'OUT: ' : 'ERR: ';
    const composed = prefix + chunk;
    const bytes = Buffer.from(composed, 'utf8');
    this.chunks.push({ bytes });
    this._bytesAppended += bytes.byteLength;
    this._bytesBuffered += bytes.byteLength;
    this.evictHeadIfNeeded();
  }

  /**
   * Lifetime byte count (pre-eviction). Tests use this to decide when
   * to stop pushing during the FIFO-eviction probe.
   */
  public bytesAppended(): number {
    return this._bytesAppended;
  }

  /**
   * Materialize the captured bytes, sanitize via the injected callback
   * exactly once, and derive the compact projection from the sanitized
   * tail. The ring is single-finalize; calling `finalize` twice is not
   * supported (the runner only finalizes at end of invocation).
   */
  public finalize(sanitize: (input: string) => string): SessionCaptureFinalizeResult {
    const concatenated = Buffer.concat(
      this.chunks.map((c) => c.bytes),
      this._bytesBuffered
    ).toString('utf8');
    const sanitized = sanitize(concatenated);
    const projection = tailBytes(sanitized, SESSION_CAPTURE_PROJECTION_BYTES);
    return {
      full: sanitized,
      projection,
      truncated: this._truncated
    };
  }

  private evictHeadIfNeeded(): void {
    while (this._bytesBuffered > SESSION_CAPTURE_MAX_BYTES && this.chunks.length > 0) {
      const head = this.chunks[0];
      const headBytes = head.bytes.byteLength;
      const overflow = this._bytesBuffered - SESSION_CAPTURE_MAX_BYTES;
      if (headBytes <= overflow) {
        // Drop the entire head chunk.
        this.chunks.shift();
        this._bytesBuffered -= headBytes;
      } else {
        // Partial-eviction of the head chunk. Slice off the leading
        // `overflow` bytes so the residual fits exactly.
        const remainder = head.bytes.subarray(overflow);
        this.chunks[0] = { bytes: remainder };
        this._bytesBuffered -= overflow;
      }
      this._truncated = true;
    }
  }
}

/**
 * Return the last `maxBytes` of a UTF-8 string, byte-bounded. We slice
 * by bytes (not characters) because the cap is a wire/storage budget,
 * not a glyph budget. Multi-byte runes that straddle the boundary are
 * truncated cleanly — this is acceptable for log preview output.
 */
function tailBytes(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.byteLength <= maxBytes) return input;
  return bytes.subarray(bytes.byteLength - maxBytes).toString('utf8');
}
