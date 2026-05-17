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
//     truncated via `truncateDisplayEntryBody`, then sanitized
//     field-by-field via the injected `sanitize` callback. Order
//     matters: projection first (drops framing), then truncation
//     (bounds size), then sanitization (final boundary scrub).
//   - `entrySeq` is monotonic per session, starting at 1.
//   - `tick()` is idempotent if no new bytes have arrived.
//   - After `dispose()`, further `tick()` calls are no-ops and no
//     further pushes are emitted.
//
// See contracts/phase-log-service.md §7.

import * as fs from 'node:fs/promises';
import type {
  PhaseLogDisplayEntry,
  PhaseLogSelection
} from './types';
import { parseStreamJsonlBytes } from './phase-log-jsonl-parser';
import { projectStreamJsonlLine } from './phase-log-display-projector';
import { truncateDisplayEntryBody } from './phase-log-truncator';

export type TailEndedReason = 'webview-stop' | 'webview-dispose' | 'phase-complete';

export interface PhaseLogEntryPushPayload {
  readonly tailSessionId: string;
  readonly entrySeq: number;
  readonly entry: PhaseLogDisplayEntry;
}

export interface PhaseLogTailSessionDeps {
  readonly sessionId: string;
  readonly filePath: string;
  readonly selection: PhaseLogSelection;
  readonly pushToWebview: (msg: PhaseLogEntryPushPayload) => void;
  readonly sanitize: (s: string) => string;
  readonly caps: { readonly perFieldBytes: number };
}

const CAPPED_FIELDS = [
  'text',
  'toolInput',
  'toolResult',
  'systemSummary',
  'resultSummary'
] as const;

export class PhaseLogTailSession {
  readonly sessionId: string;
  readonly filePath: string;
  readonly selection: PhaseLogSelection;

  private readonly pushToWebview: (msg: PhaseLogEntryPushPayload) => void;
  private readonly sanitize: (s: string) => string;
  private readonly caps: { readonly perFieldBytes: number };

  private offset = 0;
  private partial = '';
  private seq = 0;
  private skipped = 0;
  private disposed = false;
  private inTick = false;

  constructor(deps: PhaseLogTailSessionDeps) {
    this.sessionId = deps.sessionId;
    this.filePath = deps.filePath;
    this.selection = deps.selection;
    this.pushToWebview = deps.pushToWebview;
    this.sanitize = deps.sanitize;
    this.caps = deps.caps;
  }

  get skippedLines(): number {
    return this.skipped;
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
      try {
        handle = await fs.open(this.filePath, 'r');
      } catch {
        // File may be temporarily absent between watcher events. A
        // missing file at tick time is non-fatal — wait for the next
        // tick. Skipped lines/seq state is preserved.
        return;
      }
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
        const length = stat.size - this.offset;
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, this.offset);
        if (bytesRead <= 0) return;
        this.offset += bytesRead;
        const slice = bytesRead === length ? buf : buf.subarray(0, bytesRead);
        const { parsedLines, skippedLines, partialTrailingBuffer } =
          parseStreamJsonlBytes(slice, this.partial);
        this.partial = partialTrailingBuffer;
        this.skipped += skippedLines;
        for (const line of parsedLines) {
          const projected = projectStreamJsonlLine(line);
          if (!projected) continue; // framing kinds dropped
          const truncated = truncateDisplayEntryBody(projected, this.caps);
          const sanitized = this.sanitizeBody(truncated);
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

  private sanitizeBody(entry: PhaseLogDisplayEntry): PhaseLogDisplayEntry {
    const body = { ...entry.body } as { [k: string]: unknown };
    for (const field of CAPPED_FIELDS) {
      const raw = body[field];
      if (typeof raw === 'string') {
        body[field] = this.sanitize(raw);
      }
    }
    return {
      ...entry,
      body: body as PhaseLogDisplayEntry['body']
    };
  }
}
