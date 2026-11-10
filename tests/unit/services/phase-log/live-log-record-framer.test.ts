// FR-R6-F07 (FR-007, NFR-002) — byte-level record framing.

import { describe, expect, it } from 'vitest';
import {
  RecordFramer,
  type FramedItem
} from '../../../../src/services/phase-log/live-log-record-framer';
import {
  LIVE_LOG_READ_CHUNK_BYTES,
  LIVE_LOG_RESIDUAL_MAX_BYTES
} from '../../../../src/contracts/phase-log-bounds';

function drain(framer: RecordFramer): FramedItem[] {
  const out: FramedItem[] = [];
  for (let item = framer.next(); item !== null; item = framer.next()) out.push(item);
  return out;
}

function feedInChunks(framer: RecordFramer, bytes: Buffer, chunk: number): FramedItem[] {
  const out: FramedItem[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    framer.feed(bytes.subarray(i, i + chunk));
    out.push(...drain(framer));
    expect(framer.retainedBytes).toBeLessThanOrEqual(
      LIVE_LOG_RESIDUAL_MAX_BYTES + LIVE_LOG_READ_CHUNK_BYTES
    );
  }
  return out;
}

describe('RecordFramer (FR-R6-F07)', () => {
  it('decodes a 4-byte UTF-8 character split across two feeds', () => {
    const framer = new RecordFramer(0);
    const bytes = Buffer.from('{"text":"a\u{1F600}b"}\n', 'utf8');
    const split = bytes.indexOf(0xf0) + 2;
    framer.feed(bytes.subarray(0, split));
    expect(drain(framer)).toEqual([]);
    framer.feed(bytes.subarray(split));
    const items = drain(framer);
    expect(items).toEqual([{ kind: 'record', value: { text: 'a\u{1F600}b' }, end: bytes.length }]);
  });

  it('returns records with their absolute end offsets', () => {
    const framer = new RecordFramer(100);
    framer.feed(Buffer.from('{"a":1}\n{"b":2}\n{"c"', 'utf8'));
    const items = drain(framer);
    expect(items).toEqual([
      { kind: 'record', value: { a: 1 }, end: 108 },
      { kind: 'record', value: { b: 2 }, end: 116 }
    ]);
    expect(framer.consumedOffset).toBe(116);
    expect(framer.retainedBytes).toBe(4);
  });

  it('discards an oversized record, keeps its bound, and recovers at the next newline', () => {
    const framer = new RecordFramer(0);
    const giant = Buffer.alloc(LIVE_LOG_RESIDUAL_MAX_BYTES * 3, 0x61);
    const stream = Buffer.concat([giant, Buffer.from('\n{"ok":true}\n', 'utf8')]);
    const items = feedInChunks(framer, stream, 100_000);
    expect(items).toEqual([
      { kind: 'oversized-record', at: LIVE_LOG_RESIDUAL_MAX_BYTES },
      { kind: 'discard-ended', end: giant.length + 1, bytes: giant.length },
      { kind: 'record', value: { ok: true }, end: stream.length }
    ]);
  });

  it('reports the same oversized items whether the record arrives whole or in pieces', () => {
    const giant = Buffer.concat([
      Buffer.alloc(LIVE_LOG_RESIDUAL_MAX_BYTES + 10, 0x62),
      Buffer.from('\n', 'utf8')
    ]);
    const whole = new RecordFramer(0);
    whole.feed(giant);
    const pieces = new RecordFramer(0);
    expect(feedInChunks(pieces, giant, 4096)).toEqual(drain(whole));
  });

  it('reports one oversized-record for a stream that never ends its record', () => {
    const framer = new RecordFramer(0);
    const items = feedInChunks(framer, Buffer.alloc(LIVE_LOG_RESIDUAL_MAX_BYTES * 4, 0x63), 65536);
    expect(items.filter((i) => i.kind === 'oversized-record')).toHaveLength(1);
    expect(framer.retainedBytes).toBe(0);
  });

  it('reports a malformed record as a parse omission at its end offset', () => {
    const framer = new RecordFramer(0);
    framer.feed(Buffer.from('{"a":1}\n{not json\n{"b":2}\n', 'utf8'));
    expect(drain(framer)).toEqual([
      { kind: 'record', value: { a: 1 }, end: 8 },
      { kind: 'parse-omission', end: 18, bytes: 9 },
      { kind: 'record', value: { b: 2 }, end: 26 }
    ]);
  });

  it('treats blank lines as neither records nor omissions', () => {
    const framer = new RecordFramer(0);
    framer.feed(Buffer.from('\n\r\n  \n{"a":1}\n', 'utf8'));
    expect(drain(framer)).toEqual([{ kind: 'record', value: { a: 1 }, end: 14 }]);
  });

  it('starts over at the offset it is reset to', () => {
    const framer = new RecordFramer(0);
    framer.feed(Buffer.alloc(LIVE_LOG_RESIDUAL_MAX_BYTES + 1, 0x64));
    expect(drain(framer).at(0)?.kind).toBe('oversized-record');
    framer.reset(500);
    framer.feed(Buffer.from('{"z":0}\n', 'utf8'));
    expect(drain(framer)).toEqual([{ kind: 'record', value: { z: 0 }, end: 508 }]);
  });
});
