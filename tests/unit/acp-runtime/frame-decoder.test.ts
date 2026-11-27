// FR-R6-F13 T004 — newline framing with byte bounds (research R2, FR-013, FR-017, SC-004).
import { describe, expect, it } from 'vitest';

import { FrameDecoder } from '../../../src/services/acp-runtime/frame-decoder';

const ENCODER = new TextEncoder();
const bytes = (text: string): Uint8Array => ENCODER.encode(text);
const MIB = 1024 * 1024;

function messagesOf(decoder: FrameDecoder, chunk: Uint8Array): unknown[] {
  const result = decoder.push(chunk);
  if (!result.ok) throw new Error(`unexpected failure ${result.reason}`);
  return result.messages;
}

describe('FrameDecoder', () => {
  it('decodes one message per line and holds a partial line until its newline', () => {
    const decoder = new FrameDecoder();
    expect(messagesOf(decoder, bytes('{"a":1}\n{"b":'))).toEqual([{ a: 1 }]);
    expect(messagesOf(decoder, bytes('2}'))).toEqual([]);
    expect(messagesOf(decoder, bytes('\n'))).toEqual([{ b: 2 }]);
  });

  it('drops one trailing carriage return and skips blank lines', () => {
    const decoder = new FrameDecoder();
    expect(messagesOf(decoder, bytes('\n\r\n  \n{"a":1}\r\n'))).toEqual([{ a: 1 }]);
  });

  it('reassembles a multi-byte character split across chunks', () => {
    const decoder = new FrameDecoder();
    const line = bytes('{"t":"été"}\n');
    const split = 7;
    expect(messagesOf(decoder, line.subarray(0, split))).toEqual([]);
    expect(messagesOf(decoder, line.subarray(split))).toEqual([{ t: 'été' }]);
  });

  it('fails malformed-frame on invalid UTF-8', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(Uint8Array.of(0x7b, 0xff, 0x7d, 0x0a));
    expect(result).toEqual({ ok: false, reason: 'malformed-frame' });
  });

  it('fails malformed-frame on a line that is not JSON', () => {
    expect(new FrameDecoder().push(bytes('{not json\n'))).toEqual({ ok: false, reason: 'malformed-frame' });
  });

  it('fails frame-oversized on a complete line over 2 MiB', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(bytes(`"${'x'.repeat(2 * MIB)}"\n`));
    expect(result).toEqual({ ok: false, reason: 'frame-oversized' });
  });

  it('accepts a line of exactly 2 MiB', () => {
    const decoder = new FrameDecoder();
    const body = `"${'x'.repeat(2 * MIB - 2)}"`;
    expect(messagesOf(decoder, bytes(`${body}\n`))).toHaveLength(1);
  });

  it('fails frame-oversized on a remainder over 2 MiB that has no newline yet', () => {
    const decoder = new FrameDecoder();
    expect(messagesOf(decoder, bytes('x'.repeat(MIB)))).toEqual([]);
    expect(decoder.push(bytes('x'.repeat(MIB + 1)))).toEqual({ ok: false, reason: 'frame-oversized' });
  });

  it('fails pending-bytes-exceeded before holding more than 8 MiB', () => {
    const decoder = new FrameDecoder();
    expect(messagesOf(decoder, bytes('x'.repeat(16)))).toEqual([]);
    const result = decoder.push(new Uint8Array(8 * MIB));
    expect(result).toEqual({ ok: false, reason: 'pending-bytes-exceeded' });
  });

  it('decodes a large chunk of many small lines within the bounds', () => {
    const decoder = new FrameDecoder();
    const line = '{"n":1}\n';
    const messages = messagesOf(decoder, bytes(line.repeat(1000)));
    expect(messages).toHaveLength(1000);
  });

  it('returns the same failure for every push after a failure', () => {
    const decoder = new FrameDecoder();
    decoder.push(bytes('{bad\n'));
    expect(decoder.push(bytes('{"a":1}\n'))).toEqual({ ok: false, reason: 'malformed-frame' });
  });
});
