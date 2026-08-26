import { describe, expect, it } from 'vitest';
import { extractInvocationUsageMetrics } from '../../../src/parser/invocation-usage';

describe('extractInvocationUsageMetrics', () => {
  it('extracts numeric fields from the latest stream-json result row', () => {
    const stdout = [
      '{"type":"result","duration_ms":100,"num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","duration_ms":250,"num_turns":2,"total_cost_usd":0.05,"usage":{"input_tokens":30,"output_tokens":40,"cache_creation_input_tokens":5,"cache_read_input_tokens":6}}'
    ].join('\n');

    expect(extractInvocationUsageMetrics(stdout, 'claude')).toEqual({
      cliDurationMs: 250,
      numTurns: 2,
      totalCostUsd: 0.05,
      inputTokens: 30,
      outputTokens: 40,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 6
    });
  });

  it('ignores malformed, non-result, non-numeric, and negative values', () => {
    const stdout = [
      '{"type":"system","duration_ms":10}',
      '{"type":"result","duration_ms":"100","num_turns":1.5,"total_cost_usd":-1,"usage":{"input_tokens":"x","output_tokens":12}}',
      '{not json}'
    ].join('\n');

    expect(extractInvocationUsageMetrics(stdout, 'claude')).toEqual({
      outputTokens: 12
    });
  });

  it('returns null when stdout has no usable result metrics', () => {
    expect(extractInvocationUsageMetrics('plain output\n{"type":"assistant"}', 'claude')).toBeNull();
  });

  it('reads a metrics row that ends the stream without a trailing newline', () => {
    // The tail path is separate from the per-line loop and is the one a live
    // stream actually hits, so it gets its own case per backend vocabulary.
    expect(
      extractInvocationUsageMetrics('{"type":"turn.completed","usage":{"output_tokens":6}}', 'codex')
    ).toEqual({ outputTokens: 6 });
  });

  it('keeps the latest usage row when a backend emits more than one', () => {
    const stdout = [
      '{"event":"result","result":{"num_turns":1,"usage":{"output_tokens":1}}}',
      '{"event":"result","result":{"num_turns":2,"usage":{"output_tokens":9}}}'
    ].join('\n');
    expect(extractInvocationUsageMetrics(stdout, 'agy')).toEqual({
      numTurns: 2,
      outputTokens: 9
    });
  });

  it('never invents a cost for a backend that reports none', () => {
    // FR-R3-098 — the mapping table has no `totalCostUsd` entry for codex or
    // agy, so even a row carrying a cost-shaped field cannot produce one. The
    // ban is on DERIVING a price; this pins that no path reads one either.
    const codex = '{"type":"turn.completed","total_cost_usd":9.99,"usage":{"input_tokens":3}}';
    const agy = '{"event":"result","result":{"total_cost_usd":9.99,"usage":{"input_tokens":3}}}';
    expect(extractInvocationUsageMetrics(codex, 'codex')).toEqual({ inputTokens: 3 });
    expect(extractInvocationUsageMetrics(agy, 'agy')).toEqual({ inputTokens: 3 });
  });

  it('does not read one backend\'s envelope with another\'s vocabulary', () => {
    const codexRow = '{"type":"turn.completed","usage":{"input_tokens":7}}';
    expect(extractInvocationUsageMetrics(codexRow, 'claude')).toBeNull();
    expect(extractInvocationUsageMetrics(codexRow, 'agy')).toBeNull();
  });
});
