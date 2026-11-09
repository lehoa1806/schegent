/**
 * FR-R6-F06 (T034, FR-006, research R3) — the parser says whether it subtracted a session
 * baseline from Claude's cumulative cost. `totalCostUsd` keeps the value it had before the
 * marker existed; the marker only adds what the figure means.
 */
import { describe, expect, it } from 'vitest';
import { extractInvocationUsageMetrics } from '../../../src/parser/invocation-usage';

const CLAUDE_ROW = '{"type":"result","num_turns":1,"total_cost_usd":0.75,"usage":{"output_tokens":4}}';

describe('extractInvocationUsageMetrics costBaseline (T034)', () => {
  it('marks a cost at or above the baseline as subtracted, and keeps the difference', () => {
    expect(extractInvocationUsageMetrics(CLAUDE_ROW, 'claude', 0.5)).toStrictEqual({
      numTurns: 1,
      outputTokens: 4,
      totalCostUsd: 0.25,
      costBaseline: 'subtracted'
    });
    expect(extractInvocationUsageMetrics(CLAUDE_ROW, 'claude', 0)).toStrictEqual({
      numTurns: 1,
      outputTokens: 4,
      totalCostUsd: 0.75,
      costBaseline: 'subtracted'
    });
    expect(extractInvocationUsageMetrics(CLAUDE_ROW, 'claude', 0.75)).toStrictEqual({
      numTurns: 1,
      outputTokens: 4,
      totalCostUsd: 0,
      costBaseline: 'subtracted'
    });
  });

  it('marks a cost below the baseline as below-baseline, and keeps the whole cumulative figure', () => {
    expect(extractInvocationUsageMetrics(CLAUDE_ROW, 'claude', 0.9)).toStrictEqual({
      numTurns: 1,
      outputTokens: 4,
      totalCostUsd: 0.75,
      costBaseline: 'below-baseline'
    });
  });

  it('marks a cost with no baseline as absent, and keeps the whole cumulative figure', () => {
    expect(extractInvocationUsageMetrics(CLAUDE_ROW, 'claude')).toStrictEqual({
      numTurns: 1,
      outputTokens: 4,
      totalCostUsd: 0.75,
      costBaseline: 'absent'
    });
  });

  it('adds no marker when no cost was reported', () => {
    const noCost = '{"type":"result","num_turns":1,"usage":{"output_tokens":4}}';
    const metrics = extractInvocationUsageMetrics(noCost, 'claude', 0.5);
    expect(metrics).toStrictEqual({ numTurns: 1, outputTokens: 4 });
    expect(metrics !== null && Object.hasOwn(metrics, 'costBaseline')).toBe(false);
  });

  it('gives Codex and agy output no costBaseline key', () => {
    const codex = '{"type":"turn.completed","total_cost_usd":9.99,"usage":{"input_tokens":3}}';
    const agy = '{"event":"result","result":{"total_cost_usd":9.99,"usage":{"input_tokens":3}}}';
    for (const metrics of [
      extractInvocationUsageMetrics(codex, 'codex', 1),
      extractInvocationUsageMetrics(agy, 'agy', 1),
      extractInvocationUsageMetrics(codex, 'codex'),
      extractInvocationUsageMetrics(agy, 'agy')
    ]) {
      expect(metrics).toStrictEqual({ inputTokens: 3 });
      expect(metrics !== null && Object.hasOwn(metrics, 'costBaseline')).toBe(false);
    }
  });
});
