// Feature 020 T045 — PhaseLogTailSession.
//
// Owns the per-stream offset, partial-line buffer, monotonic entry
// sequence, and the synthetic `tail-ended` emission on dispose. The
// watcher mechanism (`fs.watch` vs polling) is decided and owned by
// the registry (T046); this session only exposes `tick()` (re-read
// from current offset) and `dispose(reason)` (close + emit terminator).
//
// Invariants:
//   - Body strings ARE sanitized at the IPC boundary (here) before
//     `pushToWebview`. On-disk bytes are NEVER altered.
//   - Entries are projected via `projectStreamJsonlLine`, then
//     truncated via `truncateDisplayEntryBody`, then sanitized via
//     `sanitizeDisplayEntryBody`. Order matters: projection first
//     (drops framing), then truncation (bounds size), then sanitization
//     (final boundary scrub).
//   - Feature 098 (PRIV-01): that last step is the SHARED sanitizer,
//     not a local field loop. This session held its own five-field list
//     that omitted `toolName`, `systemSubtype` and the nested
//     `toolArguments` subtree the reader already scrubbed, so a secret
//     was masked on reopen and shipped in the clear while live. Do not
//     reintroduce a local copy — see `phase-log-sanitizer.ts`.
//   - `entrySeq` is monotonic per session, starting at 1.
//   - `tick()` is idempotent if no new bytes have arrived.
//   - After `dispose()`, further `tick()` calls are no-ops and no
//     further pushes are emitted.
//
// See contracts/phase-log-service.md §7.

import * as fs from 'node:fs/promises';
import { openWithinRootByPath } from '../../lib/safe-open';
import type {
  PhaseLogDisplayEntry,
  PhaseLogSelection
} from './types';
import { parseStreamJsonlBytes } from './phase-log-jsonl-parser';
import { projectStreamJsonlLine } from './phase-log-display-projector';
import { sanitizeDisplayEntryBody } from './phase-log-sanitizer';
import { truncateDisplayEntryBody } from './phase-log-truncator';
import { readBoundedRange, readBoundedTail } from '../../lib/bounded-read';

export type TailEndedReason = 'webview-stop' | 'webview-dispose' | 'phase-complete';

export interface PhaseLogEntryPushPayload {
  readonly tailSessionId: string;
  readonly entrySeq: number;
  readonly entry: PhaseLogDisplayEntry;
}

export interface PhaseLogTailSessionDeps {
  readonly sessionId: string;
  /**
   * FR-R3-080 (T1071) — the trusted root the tailed file must sit under.
   *
   * Required, not optional: a tail session with no root would open its file by
   * pathname, which is the state this migration exists to leave. The registry
   * already holds the workspace root — it composes `filePath` from it — so this
   * costs one line at the one construction site.
   */
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly selection: PhaseLogSelection;
  readonly pushToWebview: (msg: PhaseLogEntryPushPayload) => void;
  readonly sanitize: (s: string) => string;
  readonly caps: { readonly perFieldBytes: number };
}

export class PhaseLogTailSession {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly selection: PhaseLogSelection;

  private readonly pushToWebview: (msg: PhaseLogEntryPushPayload) => void;
  private readonly sanitize: (s: string) => string;
  private readonly caps: { readonly perFieldBytes: number };

  private offset = 0;
  private partial = '';
  /**
   * FR-R3-052 — bytes never read because the file exceeded the bound. Reported,
   * not swallowed: a tail that silently starts 4 GiB in looks like a short log.
   */
  private skippedLeadingBytes = 0;
  private seq = 0;
  private skipped = 0;
  private disposed = false;
  private inTick = false;

  constructor(deps: PhaseLogTailSessionDeps) {
    this.sessionId = deps.sessionId;
    this.workspaceRoot = deps.workspaceRoot;
    this.filePath = deps.filePath;
    this.selection = deps.selection;
    this.pushToWebview = deps.pushToWebview;
    this.sanitize = deps.sanitize;
    this.caps = deps.caps;
  }

  get skippedLines(): number {
    return this.skipped;
  }

  /**
   * FR-R3-052 — bytes at the start of the stream this session never read,
   * because the file already exceeded the read bound when it opened.
   *
   * Exposed beside `skippedLines` rather than kept private: a counter nothing can
   * read is a silent cap, and a tail that quietly begins 4 GiB in looks exactly
   * like a short log to whoever is reading it.
   */
  get skippedLeadingByteCount(): number {
    return this.skippedLeadingBytes;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.inTick) return;
    this.inTick = true;
    try {
      let handle: fs.FileHandle | null = null;
      // FR-R3-080 (T1071) — the components walked, not just the leaf opened.
      // A refusal is treated exactly as an absent file was: non-fatal, wait for
      // the next tick, state preserved. A tail is a view, and a view that
      // cannot prove its file is one that shows nothing rather than one that
      // shows whatever the path now points at.
      const opened = await openWithinRootByPath(this.workspaceRoot, this.filePath, {
        flags: 'r'
      });
      if (opened.outcome === 'refused') return;
      handle = opened.handle;
      try {
        const stat = await handle.stat();
        if (stat.size < this.offset) {
          // File truncated externally (rotation, manual truncate). Reset
          // the offset to start so we don't read past EOF and don't
          // re-emit already-emitted entries via partial-line confusion.
          this.offset = 0;
          this.partial = '';
        }
        if (stat.size === this.offset) {
          // No new bytes; the partial buffer (if any) stays in place.
          return;
        }
        // FR-R3-052 (H-03) — was `Buffer.alloc(stat.size - this.offset)`, and on
        // the FIRST tick `offset` is 0, so it allocated the entire file. A phase
        // log left by a rotation that never happened is multi-GiB with no attacker
        // involved.
        //
        // On that first tick the tail is what matters: an operator opening a log
        // wants what just happened. Afterwards `offset` is a real position and
        // this reads forward from it, bounded, in fixed chunks.
        const range =
          this.offset === 0
            ? await readBoundedTail(handle, stat.size)
            : await readBoundedRange(handle, this.offset, stat.size - this.offset);
        if (range.bytes.length === 0) return;
        this.offset = range.nextOffset;
        if (range.skippedBytes > 0) this.skippedLeadingBytes += range.skippedBytes;
        const slice = range.bytes;
        const { parsedLines, skippedLines, partialTrailingBuffer } =
          parseStreamJsonlBytes(slice, this.partial);
        this.partial = partialTrailingBuffer;
        this.skipped += skippedLines;
        for (const line of parsedLines) {
          const projected = projectStreamJsonlLine(line);
          if (!projected) continue; // framing kinds dropped
          const truncated = truncateDisplayEntryBody(projected, this.caps);
          const sanitized = sanitizeDisplayEntryBody(truncated, this.sanitize);
          this.seq += 1;
          const stamped: PhaseLogDisplayEntry = { ...sanitized, seq: this.seq };
          this.pushToWebview({
            tailSessionId: this.sessionId,
            entrySeq: this.seq,
            entry: stamped
          });
        }
      } finally {
        try {
          await handle.close();
        } catch {
          // best-effort
        }
      }
    } finally {
      this.inTick = false;
    }
  }

  async dispose(reason: TailEndedReason): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.seq += 1;
    const final: PhaseLogDisplayEntry = {
      seq: this.seq,
      kind: 'tail-ended',
      ts: null,
      body: { reason },
      bodyTruncated: null
    };
    this.pushToWebview({
      tailSessionId: this.sessionId,
      entrySeq: this.seq,
      entry: final
    });
  }
}
