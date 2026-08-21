import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';

export interface InvocationUsageMetrics {
  readonly cliDurationMs?: number;
  readonly numTurns?: number;
  readonly totalCostUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

const MAX_USAGE_JSON_LINE_BYTES = 256 * 1024;

type MutableInvocationUsageMetrics = {
  -readonly [K in keyof InvocationUsageMetrics]?: InvocationUsageMetrics[K];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const num = finiteNumber(value);
  return num !== undefined && Number.isInteger(num) ? num : undefined;
}

function assignNumber(
  out: MutableInvocationUsageMetrics,
  key: keyof InvocationUsageMetrics,
  value: unknown
): void {
  const parsed = finiteNumber(value);
  if (parsed !== undefined) out[key] = parsed;
}

function assignInteger(
  out: MutableInvocationUsageMetrics,
  key: keyof InvocationUsageMetrics,
  value: unknown
): void {
  const parsed = finiteInteger(value);
  if (parsed !== undefined) out[key] = parsed;
}

function metricsFromResultRecord(rec: Record<string, unknown>): InvocationUsageMetrics | null {
  if (rec.type !== 'result') return null;

  const out: MutableInvocationUsageMetrics = {};
  assignNumber(out, 'cliDurationMs', rec.duration_ms);
  assignInteger(out, 'numTurns', rec.num_turns);
  assignNumber(out, 'totalCostUsd', rec.total_cost_usd);

  const usage = asRecord(rec.usage);
  if (usage) {
    assignInteger(out, 'inputTokens', usage.input_tokens);
    assignInteger(out, 'outputTokens', usage.output_tokens);
    assignInteger(out, 'cacheCreationInputTokens', usage.cache_creation_input_tokens);
    assignInteger(out, 'cacheReadInputTokens', usage.cache_read_input_tokens);
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract numeric usage/cost fields from Claude stream-json result rows.
 *
 * The raw stdout buffer is already capped by the runner; this parser still
 * avoids parsing arbitrary prose and only attempts JSON.parse on short lines
 * that carry both the `"type"` and `"result"` markers. Last result row wins,
 * matching the phase-log metadata strip's "latest value wins" behavior.
 */
export function extractInvocationUsageMetrics(
  stdout: ZippedStreamBuffer | string
): InvocationUsageMetrics | null {
  let latest: InvocationUsageMetrics | null = null;
  const chunks = typeof stdout === 'string' ? [stdout] : stdout.decompressStream();
  
  let activeLine = '';
  for (const chunk of chunks) {
    if (!chunk) continue;
    let chunkIdx = 0;
    while (chunkIdx < chunk.length) {
      const newlineIdx = chunk.indexOf('\n', chunkIdx);
      if (newlineIdx === -1) {
        activeLine += chunk.slice(chunkIdx);
        break;
      }
      
      const rawLine = activeLine + chunk.slice(chunkIdx, newlineIdx);
      activeLine = '';
      chunkIdx = newlineIdx + 1;
      
      const line = rawLine.trim();
      if (!line.includes('"type"') || !line.includes('"result"')) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_USAGE_JSON_LINE_BYTES) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(parsed);
      if (!record) continue;
      const metrics = metricsFromResultRecord(record);
      if (metrics) latest = metrics;
    }
  }

  // Check the final line
  if (activeLine.length > 0) {
    const line = activeLine.trim();
    if (line.includes('"type"') && line.includes('"result"') && Buffer.byteLength(line, 'utf8') <= MAX_USAGE_JSON_LINE_BYTES) {
      try {
        const parsed = JSON.parse(line);
        const record = asRecord(parsed);
        if (record) {
          const metrics = metricsFromResultRecord(record);
          if (metrics) latest = metrics;
        }
      } catch {
        // A half-written tail is the normal case, not an error: this is the last line
        // of a stream that may still be open, so an unparseable one means there are no
        // metrics here yet. The loop above discards the same failure with `continue`.
      }
    }
  }

  return latest;
}
