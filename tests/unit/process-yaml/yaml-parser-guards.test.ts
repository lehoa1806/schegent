// Feature 084 T008/T009 — the pre-parse guards.
//
// The size bound only does its job if it short-circuits: an over-sized
// document must be refused without the scanner ever running over it. That is
// asserted here with a spy rather than inferred from the refusal code, because
// the refusal code would look identical if the bound were checked afterwards
// (FR-011, SC-015, QS-8, QS-12).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';
import {
  parseDocumentBytes,
  parseDocumentText
} from '../../../src/services/process-yaml/yaml-parser';

const { scanSpy } = vi.hoisted(() => ({ scanSpy: vi.fn() }));

vi.mock('../../../src/services/process-yaml/yaml-scanner', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/process-yaml/yaml-scanner')>();
  return {
    ...actual,
    scanDocument: (text: string) => {
      scanSpy(text);
      return actual.scanDocument(text);
    }
  };
});

const BOM = '\uFEFF';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('yaml-parser — size bound (FR-011)', () => {
  beforeEach(() => {
    scanSpy.mockClear();
  });

  it('refuses an over-sized document without entering the scanner', () => {
    const oversized = new Uint8Array(PHASE_YAML_MAX_BYTES + 1).fill(0x61);
    const result = parseDocumentBytes(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('too-large');
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('enters the scanner for a document at the bound', () => {
    const atBound = encode(`kind: Phase\n${'#'.repeat(PHASE_YAML_MAX_BYTES - 12)}\n`.slice(0, PHASE_YAML_MAX_BYTES));
    expect(atBound.byteLength).toBeLessThanOrEqual(PHASE_YAML_MAX_BYTES);
    parseDocumentBytes(atBound);
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it('applies the bound to decoded text as well', () => {
    const result = parseDocumentText('a'.repeat(PHASE_YAML_MAX_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('too-large');
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('counts encoded bytes, not code units', () => {
    // Four encoded bytes but two UTF-16 code units per astral code point: a
    // string well under the bound in `.length` is over it in bytes.
    const text = '\u{1F600}'.repeat(PHASE_YAML_MAX_BYTES / 4 + 1);
    expect(text.length).toBeLessThan(PHASE_YAML_MAX_BYTES);
    const result = parseDocumentText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('too-large');
  });
});

describe('yaml-parser — unreadable input (QS-12)', () => {
  beforeEach(() => {
    scanSpy.mockClear();
  });

  it('refuses a byte-order mark rather than stripping it', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('kind: Phase\n')]);
    const result = parseDocumentBytes(withBom);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unreadable');
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('refuses a decoded byte-order mark on the text path', () => {
    const result = parseDocumentText(BOM + 'kind: Phase\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unreadable');
  });

  it('refuses invalid UTF-8 rather than repairing it', () => {
    const result = parseDocumentBytes(new Uint8Array([0x6b, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unreadable');
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('accepts well-formed multi-byte UTF-8', () => {
    const result = parseDocumentBytes(encode('name: café \u{1F600}\n'));
    expect(result.ok).toBe(true);
  });
});
