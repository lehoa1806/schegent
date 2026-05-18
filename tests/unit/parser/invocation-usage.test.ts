import { describe, expect, it } from 'vitest';
import { extractInvocationUsageMetrics } from '../../../src/parser/invocation-usage';

describe('extractInvocationUsageMetrics', () => {
  it('extracts numeric fields from the latest stream-json result row', () => {
    const stdout = [
      '{"type":"result","duration_ms":100,"num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","duration_ms":250,"num_turns":2,"total_cost_usd":0.05,"usage":{"input_tokens":30,"output_tokens":40,"cache_creation_input_tokens":5,"cache_read_input_tokens":6}}'
    ].join('\n');

    expect(extractInvocationUsageMetrics(stdout)).toEqual({
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

    expect(extractInvocationUsageMetrics(stdout)).toEqual({
      outputTokens: 12
    });
  });

  it('returns null when stdout has no usable result metrics', () => {
    expect(extractInvocationUsageMetrics('plain output\n{"type":"assistant"}')).toBeNull();
  });
});
