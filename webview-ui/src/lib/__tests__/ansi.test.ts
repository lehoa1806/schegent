// Feature 068 (T015 / US2) — pure-helper unit test for the ANSI SGR
// stripper used by SystemTab.svelte's CLI command block. The helper has
// no DOM access and no exceptions, so it is exercised purely through
// string inputs and outputs.

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../ansi';

describe('stripAnsi (Feature 068 T015 / US2)', () => {
  it('returns empty string for non-string input', () => {
    expect(stripAnsi(undefined as unknown as string)).toBe('');
    expect(stripAnsi(null as unknown as string)).toBe('');
    expect(stripAnsi(123 as unknown as string)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips a single ANSI color escape', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips multiple ANSI escapes (color + bold + reset)', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mbold red\x1b[0m')).toBe('bold red');
  });

  it('strips ANSI escapes with multi-parameter SGR sequences', () => {
    expect(stripAnsi('\x1b[1;31;47mfancy\x1b[0m')).toBe('fancy');
  });

  it('preserves plain text without any ANSI codes', () => {
    expect(stripAnsi('claude --print --model claude-opus-4-7 ...')).toBe(
      'claude --print --model claude-opus-4-7 ...'
    );
  });

  it('preserves newlines and tabs surrounding stripped escapes', () => {
    expect(stripAnsi('line-1\n\x1b[31mred\x1b[0m\n\tline-3')).toBe('line-1\nred\n\tline-3');
  });

  it('does not modify text when the input has no escape character', () => {
    const input = 'just some text with [31m brackets but no escape';
    expect(stripAnsi(input)).toBe(input);
  });
});
