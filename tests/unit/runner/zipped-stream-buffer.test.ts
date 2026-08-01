import { describe, expect, it } from 'vitest';
import {
  STREAM_TRUNCATION_MARKER,
  ZippedStreamBuffer
} from '../../../src/runner/zipped-stream-buffer';

function read(buffer: ZippedStreamBuffer): string {
  return Array.from(buffer.decompressStream()).join('');
}

describe('ZippedStreamBuffer', () => {
  it('preserves complete output below the byte cap', () => {
    const buffer = new ZippedStreamBuffer(4, 32);
    buffer.append('alpha');
    buffer.append('\nbeta');
    buffer.finalize();

    expect(read(buffer)).toBe('alpha\nbeta');
    expect(buffer.truncated).toBe(false);
    expect(buffer.totalBytes).toBe(10);
    expect(buffer.retainedBytes).toBe(10);
  });

  it('retains a bounded head and tail with an explicit truncation marker', () => {
    const buffer = new ZippedStreamBuffer(4, 12);
    buffer.append('0123456789ABCDEFGHIJ');
    buffer.finalize();

    expect(read(buffer)).toBe(`012345${STREAM_TRUNCATION_MARKER}EFGHIJ`);
    expect(buffer.truncated).toBe(true);
    expect(buffer.totalBytes).toBe(20);
    expect(buffer.retainedBytes).toBe(12);
  });

  it('keeps the newest tail as later chunks arrive', () => {
    const buffer = new ZippedStreamBuffer(4, 10);
    buffer.append('head-');
    buffer.append('old-tail');
    buffer.append('new-tail');
    buffer.finalize();

    expect(buffer.retainedBytes).toBeLessThanOrEqual(10);
    expect(read(buffer)).toContain('head-');
    expect(read(buffer).endsWith('-tail')).toBe(true);
  });

  it('coalesces high-volume one-byte writes into bounded tail storage', () => {
    const buffer = new ZippedStreamBuffer(256, 4096);
    for (let i = 0; i < 250_000; i++) buffer.append('x');
    buffer.finalize();

    expect(buffer.truncated).toBe(true);
    expect(buffer.retainedBytes).toBeLessThanOrEqual(4096);
    expect(buffer.retainedTailChunkCount).toBeLessThanOrEqual(4);
    expect(read(buffer).endsWith('x'.repeat(2048))).toBe(true);
  });

  it('never emits replacement characters when the cap crosses UTF-8 sequences', () => {
    const buffer = new ZippedStreamBuffer(4, 10);
    buffer.append('ab🙂cd🙂ef');
    buffer.finalize();

    const retained = read(buffer);
    expect(retained).not.toContain('\uFFFD');
    expect(retained).toBe(`ab🙂${STREAM_TRUNCATION_MARKER}ef`);
    expect(buffer.retainedBytes).toBeLessThanOrEqual(10);
  });

  it('preserves all UTF-8 bytes below the cap when a code point crosses the head boundary', () => {
    const buffer = new ZippedStreamBuffer(4, 10);
    buffer.append('ab🙂cd');
    buffer.finalize();

    expect(read(buffer)).toBe('ab🙂cd');
    expect(buffer.truncated).toBe(false);
    expect(buffer.totalBytes).toBe(8);
    expect(buffer.retainedBytes).toBe(8);
  });

  it('keeps tiny-cap retention bounded and UTF-8-safe across later head fills', () => {
    const buffer = new ZippedStreamBuffer(1, 2);
    buffer.append('漢');
    buffer.append('\0');
    buffer.append('é');
    buffer.finalize();

    expect(buffer.truncated).toBe(true);
    expect(buffer.retainedBytes).toBeLessThanOrEqual(2);
    expect(read(buffer)).not.toContain('\uFFFD');
  });

  it('keeps a first multibyte code point whole when it exactly fits the cap', () => {
    const buffer = new ZippedStreamBuffer(1, 4);
    buffer.append('🙂');
    buffer.finalize();

    expect(read(buffer)).toBe('🙂');
    expect(buffer.retainedBytes).toBe(4);
    expect(buffer.truncated).toBe(false);
  });

  it('returns trailing lines from the retained tail after truncation', () => {
    const buffer = new ZippedStreamBuffer(4, 24);
    buffer.append('prefix-prefix\nignored\nterminal-one\nterminal-two');
    buffer.finalize();

    expect(buffer.getTrailingLines(1)).toBe('terminal-two');
  });

  it('includes retained head evidence when a truncated tail does not fill the scan budget', () => {
    const buffer = new ZippedStreamBuffer(4, 32);
    buffer.append('AUTHENTICATION FAILED:' + 'x'.repeat(128));
    buffer.finalize();

    const trailing = buffer.getTrailingLines(50);
    expect(trailing).toContain('AUTHENTICATION');
    expect(trailing).toContain(STREAM_TRUNCATION_MARKER);
    expect(trailing.endsWith('x'.repeat(16))).toBe(true);
  });

  it('reports an empty finalized buffer', () => {
    const buffer = new ZippedStreamBuffer(4, 12);
    expect(buffer.finalize()).toBe(true);
    expect(read(buffer)).toBe('');
  });

  it('rejects invalid bounds', () => {
    expect(() => new ZippedStreamBuffer(0, 12)).toThrow();
    expect(() => new ZippedStreamBuffer(4, 0)).toThrow();
  });
});
