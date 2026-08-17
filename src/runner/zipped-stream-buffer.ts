import * as zlib from 'zlib';

/**
 * Per-stream retention ceiling.
 *
 * Raised from 4 MiB on 2026-08-16: a single xhigh planning phase emitted
 * 4.8 MiB of stream-json and tripped the cap, and because exceeding it
 * forces `failClosedOnTruncatedOutput` to discard an otherwise clean
 * classification, the run was failed on output *volume* rather than on
 * anything in the output. 64 MiB is ~13x that phase's observed size.
 *
 * The binding cost is not this number: retention is ~0.66x the cap
 * (compressed head + raw tail), while classification used to peak at
 * several multiples of it by materializing the whole stream. That
 * amplification was removed from `stream-json-unwrapper.ts` in the same
 * change; raising the cap without it would have put peak heap in the
 * hundreds of MiB per invocation, times two buffers, times concurrent runs.
 */
export const MAX_STREAM_BUFFER_BYTES = 64 * 1024 * 1024;
export const STREAM_TRUNCATION_MARKER = '\n[SCHEGENT_OUTPUT_TRUNCATED]\n';
const TAIL_SEGMENT_MAX_BYTES = 64 * 1024;

/**
 * Bounded output buffer for backend stdout/stderr.
 *
 * The first half of the byte budget is retained as a gzip-compressed head and
 * the second half as a rolling tail. This preserves startup/session metadata
 * and terminal status/error output without allowing a noisy subprocess to grow
 * extension-host memory without limit.
 */
export class ZippedStreamBuffer {
  private readonly compressedHeadChunks: Buffer[] = [];
  private activeHead = '';
  private tailChunks: Buffer[] = [];
  private tailChunkStart = 0;
  private tailHeadOffset = 0;
  private readonly tailSegmentBytes: number;
  private activeTail: Buffer;
  private activeTailStart = 0;
  private activeTailEnd = 0;
  private readonly flushThreshold: number;
  private readonly maxBytes: number;
  private readonly headLimit: number;
  private headBytes = 0;
  private tailBytes = 0;
  private observedBytes = 0;

  constructor(
    flushThresholdBytes = 1024 * 1024,
    maxBytes = MAX_STREAM_BUFFER_BYTES
  ) {
    if (!Number.isSafeInteger(flushThresholdBytes) || flushThresholdBytes < 1) {
      throw new Error('flushThresholdBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('maxBytes must be a positive safe integer');
    }
    this.flushThreshold = flushThresholdBytes;
    this.maxBytes = maxBytes;
    this.headLimit = Math.floor(maxBytes / 2);
    // Four bytes is the longest valid UTF-8 sequence. Keeping the staging
    // segment at least that large lets appendTail avoid splitting a code point
    // even in the tiny-cap buffers used by tests.
    this.tailSegmentBytes = Math.max(
      4,
      Math.min(TAIL_SEGMENT_MAX_BYTES, maxBytes)
    );
    this.activeTail = Buffer.allocUnsafe(this.tailSegmentBytes);
  }

  public get truncated(): boolean {
    return this.observedBytes > this.maxBytes;
  }

  public get totalBytes(): number {
    return this.observedBytes;
  }

  public get retainedBytes(): number {
    return this.headBytes + this.tailBytes;
  }

  /** Number of retained tail allocations (bounded by bytes/segment + two). */
  public get retainedTailChunkCount(): number {
    return (
      this.tailChunks.length - this.tailChunkStart +
      (this.activeTailEnd > this.activeTailStart ? 1 : 0)
    );
  }

  public append(chunk: string): void {
    if (chunk.length === 0) return;
    const bytes = Buffer.from(chunk, 'utf8');
    this.observedBytes += bytes.length;

    let offset = 0;
    const headRemaining = this.headLimit - this.headBytes;
    if (headRemaining > 0) {
      const requestedTake = Math.min(headRemaining, bytes.length);
      let take = utf8SafePrefixLength(bytes, requestedTake);
      if (take < requestedTake) {
        // Keep the earliest complete code point in the head when it fits the
        // total cap, even if it crosses the nominal 50/50 split. Routing that
        // code point to the tail and filling the head from a later append
        // would reorder the logical stream.
        const sequenceLength = utf8SequenceLength(bytes[take]);
        if (
          take + sequenceLength <= bytes.length &&
          this.headBytes + take + sequenceLength <= this.maxBytes
        ) {
          take += sequenceLength;
        }
      }
      const retainedHead = bytes.subarray(0, take).toString('utf8');
      this.activeHead += retainedHead;
      this.headBytes += take;
      offset = take;
      if (Buffer.byteLength(this.activeHead, 'utf8') >= this.flushThreshold) {
        this.flushActiveHead();
      }
      this.trimTail();
    }

    if (offset < bytes.length && this.maxBytes - this.headBytes > 0) {
      this.appendTail(bytes.subarray(offset));
    }
  }

  private appendTail(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      let available = this.tailSegmentBytes - this.activeTailEnd;
      if (available === 0) {
        this.flushActiveTail();
        available = this.tailSegmentBytes;
      }

      const requestedTake = Math.min(available, bytes.length - offset);
      const remaining = bytes.subarray(offset);
      const take = utf8SafePrefixLength(remaining, requestedTake);
      if (take === 0) {
        // The next complete code point does not fit in the remainder of the
        // staging segment. Seal it early and place the code point intact in a
        // fresh segment. tailSegmentBytes is always >= 4, so this progresses.
        this.flushActiveTail();
        continue;
      }

      bytes.copy(this.activeTail, this.activeTailEnd, offset, offset + take);
      this.activeTailEnd += take;
      this.tailBytes += take;
      offset += take;
      this.trimTail();
    }
  }

  private flushActiveTail(): void {
    if (this.activeTailEnd > this.activeTailStart) {
      this.tailChunks.push(
        Buffer.from(this.activeTail.subarray(this.activeTailStart, this.activeTailEnd))
      );
    }
    this.activeTail = Buffer.allocUnsafe(this.tailSegmentBytes);
    this.activeTailStart = 0;
    this.activeTailEnd = 0;
  }

  private flushActiveHead(): void {
    if (this.activeHead.length === 0) return;
    this.compressedHeadChunks.push(
      zlib.gzipSync(Buffer.from(this.activeHead, 'utf8'))
    );
    this.activeHead = '';
  }

  private trimTail(): void {
    // A UTF-8 code point can straddle the nominal head boundary. Transfer
    // those unused head bytes to the rolling tail so output below maxBytes is
    // preserved exactly and retainedBytes never exceeds the hard cap.
    const effectiveTailLimit = this.maxBytes - this.headBytes;
    while (this.tailBytes > effectiveTailLimit) {
      const overflow = this.tailBytes - effectiveTailLimit;
      const first = this.tailChunks[this.tailChunkStart];
      if (first) {
        const available = first.length - this.tailHeadOffset;
        if (available <= overflow) {
          this.tailChunkStart++;
          this.tailHeadOffset = 0;
          this.tailBytes -= available;
        } else {
          const nextStart = utf8SafeStartOffset(
            first,
            this.tailHeadOffset + overflow
          );
          this.tailBytes -= nextStart - this.tailHeadOffset;
          this.tailHeadOffset = nextStart;
        }
        continue;
      }

      const nextStart = utf8SafeStartOffset(
        this.activeTail.subarray(0, this.activeTailEnd),
        this.activeTailStart + overflow
      );
      this.tailBytes -= nextStart - this.activeTailStart;
      this.activeTailStart = nextStart;
      if (this.activeTailStart >= this.activeTailEnd) {
        this.activeTailStart = 0;
        this.activeTailEnd = 0;
      }
    }

    // Moving indices make each eviction O(1). Compact only after a generous
    // threshold so the occasional O(n) slice is amortized and stale Buffer
    // references cannot accumulate without bound.
    if (
      this.tailChunkStart >= 64 &&
      this.tailChunkStart * 2 >= this.tailChunks.length
    ) {
      this.tailChunks = this.tailChunks.slice(this.tailChunkStart);
      this.tailChunkStart = 0;
    }
  }

  /** Finalize pending compression and return true when no bytes were seen. */
  public finalize(): boolean {
    this.flushActiveHead();
    return this.observedBytes === 0;
  }

  /**
   * Yield retained output in logical order. A stable marker identifies the
   * omitted middle when the hard byte cap was exceeded.
   */
  public *decompressStream(): IterableIterator<string> {
    for (const chunk of this.compressedHeadChunks) {
      yield zlib.gunzipSync(chunk).toString('utf8');
    }
    if (this.activeHead.length > 0) yield this.activeHead;
    if (this.truncated) yield STREAM_TRUNCATION_MARKER;
    for (let i = this.tailChunkStart; i < this.tailChunks.length; i++) {
      const chunk = this.tailChunks[i];
      const start = i === this.tailChunkStart ? this.tailHeadOffset : 0;
      if (start < chunk.length) yield chunk.subarray(start).toString('utf8');
    }
    if (this.activeTailEnd > this.activeTailStart) {
      yield this.activeTail
        .subarray(this.activeTailStart, this.activeTailEnd)
        .toString('utf8');
    }
  }

  /** Return at most `lineBudget` trailing retained lines. */
  public getTrailingLines(lineBudget: number): string {
    if (lineBudget <= 0) return '';

    let trailing = this.tailText();
    let newlines = countNewlines(trailing);
    if (newlines >= lineBudget) {
      return sliceTrailingLines(trailing, lineBudget);
    }

    if (this.truncated) {
      // The rolling tail is normally sufficient for trailing-line callers,
      // but a mostly single-line stream can leave it below their scan budget.
      // In that case preserve enough of the retained head for startup fatal /
      // authentication signals to remain classifiable. Keep the truncation
      // marker between the disjoint regions so text cannot be joined into a
      // synthetic token or signature across the omitted middle.
      const tailLines = retainedLineCount(trailing);
      if (tailLines >= lineBudget) return sliceTrailingLines(trailing, lineBudget);

      const headBudget = lineBudget - tailLines;
      let head = this.activeHead;
      let headLines = retainedLineCount(head);
      for (
        let i = this.compressedHeadChunks.length - 1;
        i >= 0 && headLines < headBudget;
        i--
      ) {
        head = zlib.gunzipSync(this.compressedHeadChunks[i]).toString('utf8') + head;
        headLines = retainedLineCount(head);
      }
      head = sliceTrailingLines(head, headBudget);
      if (head.length === 0) return trailing;
      return head + STREAM_TRUNCATION_MARKER + trailing;
    }

    trailing = this.activeHead + trailing;
    newlines = countNewlines(trailing);
    if (newlines >= lineBudget) return sliceTrailingLines(trailing, lineBudget);

    for (let i = this.compressedHeadChunks.length - 1; i >= 0; i--) {
      trailing =
        zlib.gunzipSync(this.compressedHeadChunks[i]).toString('utf8') + trailing;
      if (countNewlines(trailing) >= lineBudget) {
        return sliceTrailingLines(trailing, lineBudget);
      }
    }
    return trailing;
  }

  private tailText(): string {
    const pieces: string[] = [];
    for (let i = this.tailChunkStart; i < this.tailChunks.length; i++) {
      const chunk = this.tailChunks[i];
      const start = i === this.tailChunkStart ? this.tailHeadOffset : 0;
      if (start < chunk.length) pieces.push(chunk.subarray(start).toString('utf8'));
    }
    if (this.activeTailEnd > this.activeTailStart) {
      pieces.push(
        this.activeTail
          .subarray(this.activeTailStart, this.activeTailEnd)
          .toString('utf8')
      );
    }
    return pieces.join('');
  }
}

function utf8SafePrefixLength(value: Buffer, requestedLength: number): number {
  if (requestedLength >= value.length) return value.length;
  let length = requestedLength;
  while (length > 0 && isUtf8ContinuationByte(value[length])) length--;
  const leadLength = utf8SequenceLength(value[length]);
  if (leadLength > 1 && length + leadLength > requestedLength) return length;
  return requestedLength;
}

function utf8SafeStartOffset(value: Buffer, requestedOffset: number): number {
  let offset = Math.min(requestedOffset, value.length);
  while (offset < value.length && isUtf8ContinuationByte(value[offset])) offset++;
  return offset;
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function utf8SequenceLength(value: number | undefined): number {
  if (value === undefined || (value & 0x80) === 0) return 1;
  if ((value & 0xe0) === 0xc0) return 2;
  if ((value & 0xf0) === 0xe0) return 3;
  if ((value & 0xf8) === 0xf0) return 4;
  return 1;
}

function countNewlines(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 0x0a) count++;
  }
  return count;
}

function retainedLineCount(value: string): number {
  return value.length === 0 ? 0 : countNewlines(value) + 1;
}

function sliceTrailingLines(value: string, lineBudget: number): string {
  let newlines = 0;
  for (let i = value.length - 1; i >= 0; i--) {
    if (value.charCodeAt(i) === 0x0a) {
      newlines++;
      if (newlines >= lineBudget) return value.slice(i + 1);
    }
  }
  return value;
}
