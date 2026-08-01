import * as zlib from 'zlib';

/**
 * A rotating in-memory buffer that compresses string chunks to prevent
 * excessive Node.js heap usage (OOM) for long LLM outputs, without
 * arbitrarily truncating data.
 */
export class ZippedStreamBuffer {
  private readonly compressedChunks: Buffer[] = [];
  private activeBuffer = '';
  private readonly flushThreshold: number;

  constructor(flushThresholdBytes = 1024 * 1024) {
    this.flushThreshold = flushThresholdBytes;
  }

  public append(chunk: string): void {
    if (chunk.length === 0) return;
    this.activeBuffer += chunk;
    // We use rough string length. For UTF-16, length * 2 is byte size.
    // For safety, assume string length > flushThreshold is enough to trigger.
    if (this.activeBuffer.length > this.flushThreshold) {
      this.flushActive();
    }
  }

  private flushActive(): void {
    if (this.activeBuffer.length === 0) return;
    const buf = Buffer.from(this.activeBuffer, 'utf8');
    const compressed = zlib.gzipSync(buf);
    this.compressedChunks.push(compressed);
    this.activeBuffer = '';
  }

  /**
   * Finalizes the buffer and returns true if it's completely empty.
   */
  public finalize(): boolean {
    this.flushActive();
    return this.compressedChunks.length === 0;
  }

  /**
   * Decompresses the stream sequentially and yields uncompressed string chunks.
   * This allows parsers to process massive logs without a single huge string in memory.
   */
  public *decompressStream(): IterableIterator<string> {
    for (const chunk of this.compressedChunks) {
      yield zlib.gunzipSync(chunk).toString('utf8');
    }
    if (this.activeBuffer.length > 0) {
      yield this.activeBuffer;
    }
  }

  /**
   * Unzips the chunks from end to start until we have accumulated at least
   * `lineBudget` lines, and returns only those trailing lines.
   */
  public getTrailingLines(lineBudget: number): string {
    if (lineBudget <= 0) return '';
    
    let trailing = this.activeBuffer;
    let newlines = countNewlines(trailing);

    if (newlines >= lineBudget) {
      return sliceTrailingLines(trailing, lineBudget);
    }

    for (let i = this.compressedChunks.length - 1; i >= 0; i--) {
      const decompressed = zlib.gunzipSync(this.compressedChunks[i]).toString('utf8');
      trailing = decompressed + trailing;
      newlines = countNewlines(trailing);
      if (newlines >= lineBudget) {
        return sliceTrailingLines(trailing, lineBudget);
      }
    }

    return trailing;
  }
}

function countNewlines(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 0x0a) count++;
  }
  return count;
}

function sliceTrailingLines(str: string, lineBudget: number): string {
  let newlines = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    if (str.charCodeAt(i) === 0x0a) {
      newlines++;
      if (newlines >= lineBudget) {
        return str.slice(i + 1);
      }
    }
  }
  return str;
}
