import { describe, expect, it } from 'vitest';
import {
  extractInvocationUsageMetrics,
  type InvocationUsageMetrics
} from '../../../src/parser/invocation-usage';

describe('extractInvocationUsageMetrics', () => {
  it('extracts numeric fields from the stream-json result rows, summed for claude (FR-R3-198)', () => {
    const stdout = [
      '{"type":"result","duration_ms":100,"num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","duration_ms":250,"num_turns":2,"total_cost_usd":0.05,"usage":{"input_tokens":30,"output_tokens":40,"cache_creation_input_tokens":5,"cache_read_input_tokens":6}}'
    ].join('\n');

    // FR-010: claude's counters sum over the rows; the cost is the last row's.
    expect(extractInvocationUsageMetrics(stdout, 'claude')).toEqual({
      cliDurationMs: 350,
      numTurns: 3,
      totalCostUsd: 0.05,
      inputTokens: 40,
      outputTokens: 60,
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

// FR-R3-198 (FR-010, FR-011) — a woken invocation writes one `result` row per
// turn. Each row counts its own turn's tokens, turns and duration, while
// `total_cost_usd` is the session's running total.
describe('extractInvocationUsageMetrics FR-R3-198 (T1882)', () => {
  const tokenTotal = (metrics: InvocationUsageMetrics | null): number =>
    (metrics?.inputTokens ?? 0) +
    (metrics?.outputTokens ?? 0) +
    (metrics?.cacheCreationInputTokens ?? 0) +
    (metrics?.cacheReadInputTokens ?? 0);

  it('U1, U2: sums every result row\'s counters and takes the cost from the last row', () => {
    const stdout = [
      '{"type":"result","subtype":"success","duration_ms":3000,"num_turns":2,"total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":200,"cache_creation_input_tokens":3000,"cache_read_input_tokens":40000}}',
      '{"type":"system","subtype":"task_notification","task_id":"<id>","status":"completed"}',
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","duration_ms":1000,"num_turns":1,"total_cost_usd":0.03,"usage":{"input_tokens":1,"output_tokens":20,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000}}'
    ].join('\n');
    expect(extractInvocationUsageMetrics(stdout, 'claude')).toEqual({
      cliDurationMs: 4_000,
      numTurns: 3,
      totalCostUsd: 0.03,
      inputTokens: 11,
      outputTokens: 220,
      cacheCreationInputTokens: 3_300,
      cacheReadInputTokens: 44_000
    });

    // A field no row reports stays absent rather than summing to zero.
    const noCache = [
      '{"type":"result","num_turns":1,"usage":{"output_tokens":2}}',
      '{"type":"result","num_turns":1,"usage":{"output_tokens":3}}'
    ].join('\n');
    expect(extractInvocationUsageMetrics(noCache, 'claude')).toStrictEqual({
      numTurns: 2,
      outputTokens: 5
    });
  });

  it('U3: one result row gives exactly that row\'s values', () => {
    const stdout =
      '{"type":"result","subtype":"success","duration_ms":3193,"num_turns":2,"total_cost_usd":0.0024,"usage":{"input_tokens":9,"output_tokens":1489,"cache_creation_input_tokens":12000,"cache_read_input_tokens":28000}}';
    expect(extractInvocationUsageMetrics(stdout, 'claude')).toStrictEqual({
      cliDurationMs: 3_193,
      numTurns: 2,
      totalCostUsd: 0.0024,
      inputTokens: 9,
      outputTokens: 1_489,
      cacheCreationInputTokens: 12_000,
      cacheReadInputTokens: 28_000
    });
  });

  it('U5: subtracts the session baseline from the cumulative cost (K3)', () => {
    const row = '{"type":"result","num_turns":1,"total_cost_usd":0.75}';
    expect(extractInvocationUsageMetrics(row, 'claude', 0.5)).toEqual({
      numTurns: 1,
      totalCostUsd: 0.25
    });
    // A cumulative below the baseline means the CLI restarted the session's
    // counter, so the whole figure counts.
    expect(extractInvocationUsageMetrics(row, 'claude', 0.9)).toEqual({
      numTurns: 1,
      totalCostUsd: 0.75
    });
    expect(extractInvocationUsageMetrics(row, 'claude')).toEqual({
      numTurns: 1,
      totalCostUsd: 0.75
    });
  });

  it('A1: gives T1875\'s totals, 68 876 tokens in 3 turns and 4 251 ms (SC-005)', () => {
    // The capture was not kept (A6): row totals are the filing's, the field split is synthetic.
    const stdout = [
      '{"type":"result","subtype":"success","duration_ms":3193,"num_turns":2,"total_cost_usd":0.0024,"usage":{"input_tokens":9,"output_tokens":1489,"cache_creation_input_tokens":12000,"cache_read_input_tokens":28000}}',
      '{"type":"system","subtype":"task_notification","task_id":"<id>","status":"completed"}',
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","duration_ms":1058,"num_turns":1,"total_cost_usd":0.003214365,"usage":{"input_tokens":3,"output_tokens":375,"cache_creation_input_tokens":1200,"cache_read_input_tokens":25800}}'
    ].join('\n');
    const metrics = extractInvocationUsageMetrics(stdout, 'claude');
    expect(metrics).toEqual({
      cliDurationMs: 4_251,
      numTurns: 3,
      totalCostUsd: 0.003214365,
      inputTokens: 12,
      outputTokens: 1_864,
      cacheCreationInputTokens: 13_200,
      cacheReadInputTokens: 53_800
    });
    expect(tokenTotal(metrics)).toBe(68_876);
  });

  it('A1b: adds the zero-turn row the CLI writes after SIGTERM, which counts 0 turns', () => {
    // Run `777491f8` finalize attempt 1's two `result` rows and the lines between
    // them, trimmed to the fields read here, ids elided.
    const stdout = [
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":46523,"num_turns":8,"stop_reason":"end_turn","session_id":"<id>","total_cost_usd":23.040391799999984,"usage":{"input_tokens":14,"cache_creation_input_tokens":90889,"cache_read_input_tokens":682683,"output_tokens":4496}}',
      '{"type":"system","subtype":"task_notification","task_id":"<id>","status":"stopped"}',
      '{"type":"system","subtype":"task_updated","task_id":"<id>"}',
      '{"type":"system","subtype":"background_tasks_changed","tasks":[]}',
      '{"type":"system","subtype":"task_notification","task_id":"<id>","status":"stopped"}',
      '{"type":"system","subtype":"init","session_id":"<id>"}',
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":36,"num_turns":0,"stop_reason":null,"session_id":"<id>","total_cost_usd":23.040391799999984,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}'
    ].join('\n');
    expect(extractInvocationUsageMetrics(stdout, 'claude')).toEqual({
      cliDurationMs: 46_559,
      numTurns: 8,
      totalCostUsd: 23.040391799999984,
      inputTokens: 14,
      outputTokens: 4_496,
      cacheCreationInputTokens: 90_889,
      cacheReadInputTokens: 682_683
    });
  });
});
