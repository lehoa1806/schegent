// FR-R6-F13 T010 — the bounded, sanitized stderr tail (FR-017, research R7).
import { describe, expect, it } from 'vitest';

import { StderrTail } from '../../../src/services/acp-runtime/stderr-tail';

const ENCODER = new TextEncoder();
const KIB = 1024;

describe('StderrTail', () => {
  it('keeps the last 64 KiB only', () => {
    const tail = new StderrTail();
    tail.push(ENCODER.encode('a'.repeat(40 * KIB)));
    tail.push(ENCODER.encode('b'.repeat(40 * KIB)));
    const text = tail.text();
    expect(text).toHaveLength(64 * KIB);
    expect(text.startsWith('a'.repeat(24 * KIB))).toBe(true);
    expect(text.endsWith('b'.repeat(40 * KIB))).toBe(true);
  });

  it('keeps the newest bytes of one chunk larger than the bound', () => {
    const tail = new StderrTail(8);
    tail.push(ENCODER.encode('0123456789'));
    expect(tail.text()).toBe('23456789');
  });

  it('removes C0, DEL and C1 control characters except newline and tab', () => {
    const tail = new StderrTail();
    const esc = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    const csi = String.fromCharCode(0x9b);
    tail.push(ENCODER.encode(`a${bell}b${esc}[31mc${del}d${csi}e\tf\ng\r`));
    expect(tail.text()).toBe('ab[31mcde\tf\ng');
  });

  it('is empty before any output', () => {
    expect(new StderrTail().text()).toBe('');
  });
});
