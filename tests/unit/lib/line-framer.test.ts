import { describe, it, expect } from 'vitest';
import { LineFramer, DEFAULT_MAX_LINE_UNITS } from '../../../src/lib/line-framer';

describe('LineFramer bounds what it retains (FR-R3-052 / H-03)', () => {
  it('frames a conforming stream exactly as the old splitLines did', () => {
    const framer = new LineFramer();
    expect(framer.append('one\ntwo\nthr').lines).toEqual(['one', 'two']);
    expect(framer.retainedUnits).toBe(3);
    expect(framer.append('ee\n').lines).toEqual(['three']);
    expect(framer.retainedUnits).toBe(0);
  });

  it('drops empty lines, as the framing it replaces did', () => {
    expect(new LineFramer().append('a\n\n\nb\n').lines).toEqual(['a', 'b']);
  });

  it('never retains more than the limit, however much arrives', () => {
    const framer = new LineFramer(1024);
    for (let i = 0; i < 4096; i += 1) framer.append('x'.repeat(1024));
    expect(framer.retainedUnits).toBeLessThanOrEqual(1024);
  });

  it('emits one truncated line for an oversized record, not many bogus ones', () => {
    // The reason for the discard state: without it, a 4 MiB newline-free record
    // becomes thousands of "lines" that every downstream consumer treats as real
    // output.
    const framer = new LineFramer(100);
    const out = framer.append('y'.repeat(4096));
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toHaveLength(100);
    expect(out.truncatedLines).toBe(1);
    expect(out.droppedUnits).toBe(4096 - 100);
  });

  it('resumes cleanly at the newline after a truncation', () => {
    const framer = new LineFramer(10);
    framer.append('z'.repeat(50));
    const out = framer.append('tail\nnext\n');
    // `tail` belongs to the truncated record and is discarded; `next` is a real
    // line and must survive.
    expect(out.lines).toEqual(['next']);
    expect(out.droppedUnits).toBe(4);
    expect(framer.retainedUnits).toBe(0);
  });

  it('counts every truncation and every dropped unit across calls', () => {
    const framer = new LineFramer(10);
    framer.append('a'.repeat(25) + '\n');
    framer.append('b'.repeat(30) + '\n');
    expect(framer.totals.truncatedLines).toBe(2);
    expect(framer.totals.droppedUnits).toBe(15 + 20);
  });

  it('does not truncate a line that is exactly at the limit', () => {
    const framer = new LineFramer(10);
    const out = framer.append('c'.repeat(10) + '\n');
    expect(out.lines).toEqual(['c'.repeat(10)]);
    expect(out.truncatedLines).toBe(0);
  });

  it('surfaces a trailing record with no newline on flush', () => {
    const framer = new LineFramer();
    framer.append('no newline here');
    expect(framer.flush().lines).toEqual(['no newline here']);
    expect(framer.flush().lines).toEqual([]);
  });

  it('discards the tail of a truncated record on flush rather than re-emitting it', () => {
    const framer = new LineFramer(5);
    framer.append('d'.repeat(20));
    expect(framer.flush().lines).toEqual([]);
  });

  it('splits a line arriving one character at a time identically', () => {
    // The runner's shape: `stdoutLineBuffer += char`. Same output required.
    const framer = new LineFramer();
    const lines: string[] = [];
    for (const ch of 'alpha\nbeta\n') lines.push(...framer.append(ch).lines);
    expect(lines).toEqual(['alpha', 'beta']);
  });

  it('rejects a nonsense limit rather than accepting it', () => {
    expect(() => new LineFramer(0)).toThrow(/positive integer/);
    expect(() => new LineFramer(-1)).toThrow(/positive integer/);
    expect(() => new LineFramer(1.5)).toThrow(/positive integer/);
  });

  it('defaults to a limit well above any real record', () => {
    expect(DEFAULT_MAX_LINE_UNITS).toBe(1024 * 1024);
  });
});
