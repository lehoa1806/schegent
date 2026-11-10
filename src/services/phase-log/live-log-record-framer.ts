// FR-R6-F07 (FR-007, NFR-002) — byte-level record framing for live logs.
//
// The framer replaces the tail's string residual. It holds bytes, splits only
// on 0x0A and decodes complete records only. 0x0A never occurs inside a
// multibyte UTF-8 sequence, so a split can never fall inside a character.
//
// It is pull-based: the caller feeds a chunk, then pulls items one at a time,
// so the caller can stop pulling when it runs out of delivery credit without
// the framer buffering decoded output.
//
// Bounds. A partial record is retained up to LIVE_LOG_RESIDUAL_MAX_BYTES; past
// that the framer reports `oversized-record` once, drops what it holds and
// discards until the next newline. With one chunk fed at a time the buffered
// bytes stay within one read chunk plus the residual bound.
//
// Determinism. Every item carries an absolute byte position that does not
// depend on how the source was chunked: a record or omission ends at its
// newline, and an oversized record is reported at its start plus the bound.
// Replay from an earlier offset therefore reproduces the same positions.

import { LIVE_LOG_RESIDUAL_MAX_BYTES } from '../../contracts/phase-log-bounds';

const NEWLINE_BYTE = 0x0a;

export type FramedItem =
  | { readonly kind: 'record'; readonly value: unknown; readonly end: number }
  | { readonly kind: 'parse-omission'; readonly end: number; readonly bytes: number }
  | { readonly kind: 'oversized-record'; readonly at: number }
  | { readonly kind: 'discard-ended'; readonly end: number; readonly bytes: number };

export class RecordFramer {
  private buffer: Buffer = Buffer.alloc(0);
  /** Absolute offset of `buffer[0]`. */
  private bufferStart: number;
  /** Index in `buffer` of the first byte not yet consumed. */
  private position = 0;
  private discarding = false;
  private discardedBytes = 0;
  private readonly pendingItems: FramedItem[] = [];
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly residualMaxBytes: number;

  constructor(startOffset: number, residualMaxBytes: number = LIVE_LOG_RESIDUAL_MAX_BYTES) {
    this.bufferStart = startOffset;
    this.residualMaxBytes = residualMaxBytes;
  }

  /** Bytes held and not yet framed. */
  get retainedBytes(): number {
    return this.buffer.length - this.position;
  }

  /** Absolute offset just past the last byte consumed. */
  get consumedOffset(): number {
    return this.bufferStart + this.position;
  }

  /** Absolute offset just past the last byte fed. */
  get fedOffset(): number {
    return this.bufferStart + this.buffer.length;
  }

  reset(offset: number): void {
    this.buffer = Buffer.alloc(0);
    this.bufferStart = offset;
    this.position = 0;
    this.discarding = false;
    this.discardedBytes = 0;
    this.pendingItems.length = 0;
  }

  feed(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const kept = this.buffer.subarray(this.position);
    this.bufferStart += this.position;
    this.position = 0;
    this.buffer = kept.length === 0 ? Buffer.from(chunk) : Buffer.concat([kept, chunk]);
  }

  /** The next framed item, or null when more bytes are needed. */
  next(): FramedItem | null {
    for (;;) {
      const queued = this.pendingItems.shift();
      if (queued !== undefined) return queued;
      if (this.discarding) {
        const ended = this.continueDiscard();
        if (ended === null) return null;
        return ended;
      }
      const newline = this.buffer.indexOf(NEWLINE_BYTE, this.position);
      if (newline === -1) return this.holdPartial();
      const item = this.frameLine(newline);
      if (item !== null) return item;
    }
  }

  private holdPartial(): FramedItem | null {
    const pending = this.buffer.length - this.position;
    if (pending <= this.residualMaxBytes) return null;
    const at = this.consumedOffset + this.residualMaxBytes;
    this.discarding = true;
    this.discardedBytes = pending;
    this.dropBuffered();
    return { kind: 'oversized-record', at };
  }

  private continueDiscard(): FramedItem | null {
    const newline = this.buffer.indexOf(NEWLINE_BYTE, this.position);
    if (newline === -1) {
      this.discardedBytes += this.buffer.length - this.position;
      this.dropBuffered();
      return null;
    }
    this.discardedBytes += newline - this.position;
    this.position = newline + 1;
    this.discarding = false;
    const bytes = this.discardedBytes;
    this.discardedBytes = 0;
    return { kind: 'discard-ended', end: this.consumedOffset, bytes };
  }

  private frameLine(newline: number): FramedItem | null {
    const start = this.consumedOffset;
    const line = this.buffer.subarray(this.position, newline);
    this.position = newline + 1;
    const end = this.consumedOffset;
    if (line.length > this.residualMaxBytes) {
      this.pendingItems.push({ kind: 'discard-ended', end, bytes: line.length });
      return { kind: 'oversized-record', at: start + this.residualMaxBytes };
    }
    const text = this.decoder.decode(line);
    if (text.trim().length === 0) return null;
    try {
      return { kind: 'record', value: JSON.parse(text) as unknown, end };
    } catch {
      return { kind: 'parse-omission', end, bytes: line.length };
    }
  }

  private dropBuffered(): void {
    this.bufferStart += this.buffer.length;
    this.buffer = Buffer.alloc(0);
    this.position = 0;
  }
}
