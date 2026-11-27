/**
 * FR-R6-F06 (T012, FR-016, research R11) — dimensions are bounded, closed-pattern values.
 * A path, prompt text or credential never becomes a grouping key.
 */
import { describe, expect, it } from 'vitest';
import {
  DIMENSION_MAX_BYTES,
  providerSessionRef,
  sanitizeDimension
} from '../../../src/services/usage-accounting/dimension-sanitizer';

// Built by concatenation so the repository secret scan never sees a literal key.
const FAKE_ANTHROPIC_KEY = 'sk-' + 'ant-api03-' + 'z'.repeat(40);

describe('dimension sanitizer (T012)', () => {
  it('keeps a known backend and a well-formed other backend', () => {
    expect(sanitizeDimension('backend', 'claude')).toEqual({ value: 'claude' });
    expect(sanitizeDimension('backend', 'acp.gemini')).toEqual({ value: 'acp.gemini' });
    expect(sanitizeDimension('backend', 'Claude')).toEqual({ excluded: true });
  });

  it('keeps model names with the provider punctuation', () => {
    for (const model of ['claude-sonnet-4-5', 'gpt-5.1-codex', 'vertex:gemini@2.5', 'Opus_5']) {
      expect(sanitizeDimension('model', model), model).toEqual({ value: model });
    }
  });

  it('checks phase and workflow revision ids', () => {
    expect(sanitizeDimension('phaseId', 'implement')).toEqual({ value: 'implement' });
    expect(sanitizeDimension('workflowRevision', 'wf.3')).toEqual({ value: 'wf.3' });
    expect(sanitizeDimension('phaseId', 'phase:1')).toEqual({ excluded: true });
  });

  it('treats an absent value as null, not as excluded', () => {
    expect(sanitizeDimension('model', undefined)).toEqual({ value: null });
    expect(sanitizeDimension('model', null)).toEqual({ value: null });
  });

  it.each([
    ['a path', '/Users/someone/project/src/index.ts'],
    ['a prompt sentence', 'please refactor the auth module'],
    ['an empty string', ''],
    ['a number', 42],
    ['a credential', FAKE_ANTHROPIC_KEY]
  ])('excludes %s', (_label, raw) => {
    expect(sanitizeDimension('model', raw)).toEqual({ excluded: true });
  });

  it('bounds a value at 256 UTF-8 bytes, counting multi-byte characters as bytes', () => {
    const atBound = 'a'.repeat(DIMENSION_MAX_BYTES);
    expect(Buffer.byteLength(atBound, 'utf8')).toBe(256);
    expect(sanitizeDimension('backend', 'a'.repeat(64))).toEqual({ value: 'a'.repeat(64) });
    // 86 three-byte characters are 258 bytes, under 128 characters.
    const multiByte = 'a' + '€'.repeat(86);
    expect(multiByte.length).toBeLessThan(128);
    expect(sanitizeDimension('model', multiByte)).toEqual({ excluded: true });
  });

  it('reduces a provider session id to a 32-hex reference', () => {
    const ref = providerSessionRef('session-0123456789');
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(providerSessionRef('session-0123456789')).toBe(ref);
    expect(providerSessionRef('session-other')).not.toBe(ref);
    expect(sanitizeDimension('providerSession', 'session-0123456789')).toEqual({ value: ref });
    expect(sanitizeDimension('providerSession', '')).toEqual({ excluded: true });
  });

  it('never throws on hostile input', () => {
    const hostile: unknown[] = [Symbol('x'), { toString: () => { throw new Error('boom'); } }, 'x'.repeat(100_000)];
    for (const raw of hostile) expect(() => sanitizeDimension('model', raw)).not.toThrow();
  });
});
