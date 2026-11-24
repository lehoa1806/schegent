import { describe, expect, it } from 'vitest';
import { BridgeByteFramer } from '../../../../src/services/acp-runtime/bridge-byte-framer';

describe('BridgeByteFramer (FR-R8-02 / 02-03)', () => {
  it('reassembles UTF-8 multibyte characters split across arbitrary chunk boundaries', () => {
    const framer = new BridgeByteFramer(1024);
    const line = '{"text":"hello 🌍 café 日本語"}\n';
    const raw = Buffer.from(line, 'utf8');

    const events = [];
    for (let i = 0; i < raw.length; i += 3) {
      events.push(...framer.push(raw.subarray(i, i + 3)));
    }
    events.push(...framer.flush());

    expect(events).toEqual([{ kind: 'line', text: '{"text":"hello 🌍 café 日本語"}' }]);
    expect(framer.overflowedLineCount).toBe(0);
    expect(framer.currentPendingBytes).toBe(0);
  });

  it('strips trailing CR on CRLF and flushes trailing unterminated lines cleanly', () => {
    const framer = new BridgeByteFramer(128);
    const first = framer.push(Buffer.from('{"a":1}\r\n{"b":2}', 'utf8'));
    const rest = framer.flush();

    expect(first).toEqual([{ kind: 'line', text: '{"a":1}' }]);
    expect(rest).toEqual([{ kind: 'line', text: '{"b":2}' }]);
    expect(framer.overflowedLineCount).toBe(0);
  });

  it('accepts a line at exactly maxLineBytes and overflows on maxLineBytes + 1 before UTF-8 decode', () => {
    const limit = 32;
    const framer = new BridgeByteFramer(limit);

    const exact = 'a'.repeat(limit);
    expect(framer.push(Buffer.from(`${exact}\n`, 'utf8'))).toEqual([{ kind: 'line', text: exact }]);
    expect(framer.overflowedLineCount).toBe(0);
    expect(framer.peakPendingBytes).toBe(limit);

    // Push a 10x oversized newline-free stream in chunks — currentPendingBytes MUST remain 0 while discarding.
    const chunk = Buffer.alloc(64, 0x78); // 'x'
    const overflowEvents = [];
    for (let i = 0; i < 8; i += 1) {
      overflowEvents.push(...framer.push(chunk));
      expect(framer.currentPendingBytes).toBe(0);
    }
    // Single overflow signal per oversized line, even across many chunks!
    expect(overflowEvents).toEqual([{ kind: 'overflow', limitBytes: limit }]);
    expect(framer.overflowedLineCount).toBe(1);
    expect(framer.discardedBytes).toBeGreaterThan(0);

    // Once a newline arrives, the next valid line recovers cleanly.
    const recovered = framer.push(Buffer.from('tail\n{"ok":true}\n', 'utf8'));
    expect(recovered).toEqual([{ kind: 'line', text: '{"ok":true}' }]);
    expect(framer.overflowedLineCount).toBe(1);
    expect(framer.currentPendingBytes).toBe(0);
  });

  it('bounds memory when a single huge chunk contains no newline and ends at EOF', () => {
    const limit = 64;
    const framer = new BridgeByteFramer(limit);
    const huge = Buffer.alloc(64 * 1024, 0x7a);

    const pushed = framer.push(huge);
    const flushed = framer.flush();

    expect(pushed).toEqual([{ kind: 'overflow', limitBytes: limit }]);
    expect(flushed).toEqual([]);
    expect(framer.overflowedLineCount).toBe(1);
    expect(framer.currentPendingBytes).toBe(0);
    expect(framer.peakPendingBytes).toBeLessThanOrEqual(limit);
  });
});
