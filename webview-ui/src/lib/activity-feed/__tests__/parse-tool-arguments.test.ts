// Feature 029 T011 — parseToolArguments: produces an ordered list of
// rendered tool arguments from a PhaseLogDisplayEntry. Prefers the
// typed body.toolArguments shape; falls back to JSON-parsing
// body.toolInput when the typed payload is absent.

import { describe, expect, it } from 'vitest';
import { parseToolArguments } from '../parse-tool-arguments';
import type { PhaseLogDisplayEntry } from '../../../../../src/services/phase-log/types';

function entry(over: Partial<PhaseLogDisplayEntry['body']>): PhaseLogDisplayEntry {
  return {
    seq: 1,
    kind: 'tool-use',
    ts: null,
    body: over,
    bodyTruncated: null
  } as PhaseLogDisplayEntry;
}

describe('Feature 029 T011 — parseToolArguments', () => {
  it('prefers body.toolArguments when present', () => {
    const e = entry({
      toolName: 'Read',
      toolArguments: { file_path: '/x', offset: 10 }
    });
    const r = parseToolArguments(e);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.length).toBe(2);
      expect(r.args[0].key).toBe('file_path');
      expect(r.args[1].key).toBe('offset');
    }
  });

  it('falls back to JSON-parsing toolInput when toolArguments is absent', () => {
    const e = entry({
      toolName: 'Read',
      toolInput: JSON.stringify({ file_path: '/y', offset: 5 })
    });
    const r = parseToolArguments(e);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.length).toBe(2);
      expect(r.args[0].key).toBe('file_path');
    }
  });

  it('returns ok:false with raw text when JSON parse fails', () => {
    const e = entry({
      toolName: 'Custom',
      toolInput: 'this is not json at all'
    });
    const r = parseToolArguments(e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rawText).toBe('this is not json at all');
    }
  });

  it('returns ok:true with empty args when input is undefined and toolArguments is undefined', () => {
    const e = entry({ toolName: 'NoArgs' });
    const r = parseToolArguments(e);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).toEqual([]);
    }
  });

  it('preserves key order of toolArguments object', () => {
    const e = entry({
      toolName: 'Custom',
      toolArguments: { z: 1, a: 2, m: 3 }
    });
    const r = parseToolArguments(e);
    if (r.ok) {
      expect(r.args.map((a) => a.key)).toEqual(['z', 'a', 'm']);
    }
  });

  it('handles bare-string toolArguments by wrapping in a synthetic value key', () => {
    // The host wraps bare-string inputs as { value: '...' }. parseToolArguments
    // surfaces that shape unchanged.
    const e = entry({
      toolName: 'Custom',
      toolArguments: { value: 'free-form prompt' }
    });
    const r = parseToolArguments(e);
    if (r.ok) {
      expect(r.args[0].key).toBe('value');
    }
  });

  it('classifies multi-line string values via classifyArgValue', () => {
    const multiLine = 'line 1\nline 2\nline 3';
    const e = entry({
      toolName: 'Write',
      toolArguments: { file_path: '/a.md', content: multiLine }
    });
    const r = parseToolArguments(e);
    if (r.ok) {
      const contentArg = r.args.find((a) => a.key === 'content');
      expect(contentArg).toBeDefined();
      expect(contentArg?.classification.kind).toBe('multiline');
    }
  });

  it('does not throw when toolArguments is the elision sentinel {__elided: true}', () => {
    const e = entry({
      toolName: 'Custom',
      toolArguments: { __elided: true }
    });
    const r = parseToolArguments(e);
    expect(r.ok).toBe(true);
  });

  it('does not throw when toolArguments is the truncation sentinel {__truncated: true}', () => {
    const e = entry({
      toolName: 'Custom',
      toolArguments: { __truncated: true, originalBytes: 9999 }
    });
    const r = parseToolArguments(e);
    expect(r.ok).toBe(true);
  });
});
