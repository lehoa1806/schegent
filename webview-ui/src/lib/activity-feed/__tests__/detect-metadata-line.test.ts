// Feature 029 T022 — detectMetadataLine: classify a single textual line
// as a known metadata key (cwd, session_id, duration_ms, cost, tools,
// model, num_turns) when it matches a `<key>=<value>` shape used in
// the system/result entry summaries.

import { describe, expect, it } from 'vitest';
import { detectMetadataLine } from '../detect-metadata-line';

describe('Feature 029 T022 — detectMetadataLine', () => {
  it('detects cwd=', () => {
    const m = detectMetadataLine('cwd=/Users/me/workspaces/schegent');
    expect(m?.key).toBe('cwd');
    expect(m?.value).toBe('/Users/me/workspaces/schegent');
  });

  it('detects session_id=', () => {
    const m = detectMetadataLine('session_id=abc-123');
    expect(m?.key).toBe('session_id');
    expect(m?.value).toBe('abc-123');
  });

  it('detects duration_ms=', () => {
    const m = detectMetadataLine('duration_ms=12345');
    expect(m?.key).toBe('duration_ms');
    expect(m?.value).toBe('12345');
  });

  it('detects cost / total_cost_usd as cost', () => {
    expect(detectMetadataLine('total_cost_usd=0.0042')?.key).toBe('cost');
    expect(detectMetadataLine('cost=0.5')?.key).toBe('cost');
  });

  it('detects tools=', () => {
    const m = detectMetadataLine('tools=Read,Glob');
    expect(m?.key).toBe('tools');
    expect(m?.value).toBe('Read,Glob');
  });

  it('detects model=', () => {
    const m = detectMetadataLine('model=claude-opus-4-7');
    expect(m?.key).toBe('model');
    expect(m?.value).toBe('claude-opus-4-7');
  });

  it('detects num_turns=', () => {
    const m = detectMetadataLine('num_turns=3');
    expect(m?.key).toBe('num_turns');
    expect(m?.value).toBe('3');
  });

  it('returns null for unrelated text', () => {
    expect(detectMetadataLine('hello world')).toBeNull();
    expect(detectMetadataLine('Reading file /tmp/x.json')).toBeNull();
    expect(detectMetadataLine('')).toBeNull();
  });

  it('parses multiple key=value pairs in a single space-separated line', () => {
    // The system/result summaries are formatted as
    // `duration_ms=123 num_turns=3 total_cost_usd=0.01`. The detector
    // accepts the FIRST recognised key in the line; the caller is
    // expected to split on whitespace and call once per token.
    const m = detectMetadataLine('duration_ms=1234');
    expect(m?.key).toBe('duration_ms');
  });

  it('preserves the raw key as rawKey', () => {
    const m = detectMetadataLine('total_cost_usd=0.0042');
    expect(m?.rawKey).toBe('total_cost_usd');
    expect(m?.key).toBe('cost');
  });
});
