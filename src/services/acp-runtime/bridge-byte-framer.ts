/**
 * FR-R8-02 (02-03) — chunk-safe byte-level newline framer for maintained ACP stdio bridges.
 *
 * Enforces `maxLineBytes` on raw undecoded bytes BEFORE any UTF-8 decoding or line string
 * allocation so a newline-free flood stays bounded in O(maxLineBytes) memory, while preserving
 * multi-byte UTF-8 sequences split across arbitrary chunk boundaries (including 1-byte chunks).
 *
 * Zero `vscode` or `child_process` imports.
 */
import { ACP_MAX_CLI_LINE_BYTES } from '../../contracts/acp-runtime';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export type BridgeFramerEvent =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'overflow'; readonly limitBytes: number };

export class BridgeByteFramer {
  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private discarding = false;
  private overflowCount = 0;
  private droppedBytes = 0;
  private maxBufferedBytes = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public constructor(private readonly maxLineBytes: number = ACP_MAX_CLI_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError('BridgeByteFramer maxLineBytes must be a positive safe integer');
    }
  }

  public get currentPendingBytes(): number {
    return this.bufferedBytes;
  }

  public get peakPendingBytes(): number {
    return this.maxBufferedBytes;
  }

  public get overflowedLineCount(): number {
    return this.overflowCount;
  }

  public get discardedBytes(): number {
    return this.droppedBytes;
  }

  /** Feed one raw stdout chunk and emit complete lines or per-line overflow notifications. */
  public push(chunk: Uint8Array): readonly BridgeFramerEvent[] {
    if (chunk.byteLength === 0) return [];
    const events: BridgeFramerEvent[] = [];
    let offset = 0;

    while (offset < chunk.byteLength) {
      const newlineIdx = chunk.indexOf(NEWLINE, offset);
      if (newlineIdx === -1) {
        this.appendSegment(chunk.subarray(offset), events);
        break;
      }

      const segment = chunk.subarray(offset, newlineIdx);
      offset = newlineIdx + 1;

      if (this.discarding) {
        this.droppedBytes += segment.byteLength + 1;
        this.discarding = false;
        continue;
      }

      const effectiveEnd =
        segment.byteLength > 0 && segment[segment.byteLength - 1] === CARRIAGE_RETURN
          ? segment.byteLength - 1
          : segment.byteLength;
      const trimmedSegment = segment.subarray(0, effectiveEnd);

      if (this.bufferedBytes + trimmedSegment.byteLength > this.maxLineBytes) {
        this.enterOverflow(trimmedSegment.byteLength + 1, events);
        this.discarding = false;
        continue;
      }

      if (trimmedSegment.byteLength > 0) {
        this.recordSegment(trimmedSegment);
      }
      events.push({ kind: 'line', text: this.drainBufferedLine() });
    }

    return events;
  }

  /** Flush any trailing unterminated line at EOF. */
  public flush(): readonly BridgeFramerEvent[] {
    if (this.discarding) {
      this.discarding = false;
      this.chunks = [];
      this.bufferedBytes = 0;
      return [];
    }
    if (this.bufferedBytes === 0) return [];
    return [{ kind: 'line', text: this.drainBufferedLine() }];
  }

  private appendSegment(segment: Uint8Array, events: BridgeFramerEvent[]): void {
    if (segment.byteLength === 0) return;
    if (this.discarding) {
      this.droppedBytes += segment.byteLength;
      return;
    }
    if (this.bufferedBytes + segment.byteLength > this.maxLineBytes) {
      this.enterOverflow(segment.byteLength, events);
      return;
    }
    this.recordSegment(segment);
  }

  private recordSegment(segment: Uint8Array): void {
    // Copy the bounded slice so callers reusing or pooling larger read buffers are not retained.
    const copy = new Uint8Array(segment.byteLength);
    copy.set(segment);
    this.chunks.push(copy);
    this.bufferedBytes += copy.byteLength;
    if (this.bufferedBytes > this.maxBufferedBytes) {
      this.maxBufferedBytes = this.bufferedBytes;
    }
  }

  private enterOverflow(incomingBytes: number, events: BridgeFramerEvent[]): void {
    this.droppedBytes += this.bufferedBytes + incomingBytes;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.discarding = true;
    this.overflowCount += 1;
    events.push({ kind: 'overflow', limitBytes: this.maxLineBytes });
  }

  private drainBufferedLine(): string {
    if (this.bufferedBytes === 0) return '';
    let combined: Uint8Array;
    if (this.chunks.length === 1) {
      combined = this.chunks[0]!;
    } else {
      combined = new Uint8Array(this.bufferedBytes);
      let cursor = 0;
      for (const part of this.chunks) {
        combined.set(part, cursor);
        cursor += part.byteLength;
      }
    }
    this.chunks = [];
    this.bufferedBytes = 0;
    // Handle CRLF split across chunk boundary (\r at end of prior chunk, \n at start of next).
    const lineBytes =
      combined.byteLength > 0 && combined[combined.byteLength - 1] === CARRIAGE_RETURN
        ? combined.subarray(0, combined.byteLength - 1)
        : combined;
    return this.decoder.decode(lineBytes);
  }
}

