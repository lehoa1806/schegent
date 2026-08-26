import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';
import type { BackendRunnerKind } from '../contracts/backend-kinds';

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
const MS_PER_SECOND = 1_000;

type MutableInvocationUsageMetrics = {
  -readonly [K in keyof InvocationUsageMetrics]?: InvocationUsageMetrics[K];
};

/**
 * The field names one backend uses for the values `InvocationUsageMetrics` holds.
 *
 * FR-R3-098 — one reader, three vocabularies. A field absent here is a field that
 * backend does not report, and the metric stays `undefined` rather than being
 * derived: `totalCostUsd` is claude-only because codex and agy report no price at
 * all, and a dollar figure computed from token counts and a hard-coded rate table
 * would put a fabricated number in an evidence record.
 */
interface BackendUsageVocabulary {
  /** Cheap substring gate before `JSON.parse`; every marker must be present. */
  readonly lineMarkers: readonly string[];
  /** Terminal-row discriminator, read off the parsed record. */
  readonly isUsageRow: (rec: Record<string, unknown>) => boolean;
  /** Where the per-turn fields live: the row itself, or a nested envelope. */
  readonly body: (rec: Record<string, unknown>) => Record<string, unknown> | null;
  /** Turn-level field names inside `body`. */
  readonly durationMs?: string;
  readonly durationSeconds?: string;
  readonly numTurns?: string;
  readonly totalCostUsd?: string;
  /** Token-count field names inside `body.usage`. */
  readonly tokens: {
    readonly inputTokens?: string;
    readonly outputTokens?: string;
    readonly cacheCreationInputTokens?: string;
    readonly cacheReadInputTokens?: string;
  };
}

const USAGE_VOCABULARIES: Readonly<Record<BackendRunnerKind, BackendUsageVocabulary>> =
  Object.freeze({
    // `{"type":"result", …}` with `usage` and the cost on the row itself.
    claude: {
      lineMarkers: ['"type"', '"result"'],
      isUsageRow: (rec) => rec.type === 'result',
      body: (rec) => rec,
      durationMs: 'duration_ms',
      numTurns: 'num_turns',
      totalCostUsd: 'total_cost_usd',
      tokens: {
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        cacheCreationInputTokens: 'cache_creation_input_tokens',
        cacheReadInputTokens: 'cache_read_input_tokens'
      }
    },
    // `{"type":"turn.completed","usage":{…}}` — the terminal row is not named
    // `result`, which is why the pre-FR-R3-098 marker pair never saw it. No cost,
    // no duration and no turn count are reported; only tokens.
    //
    // DELIBERATELY DROPPED: `reasoning_output_tokens`. See the note on agy below.
    codex: {
      lineMarkers: ['"type"', '"turn.completed"'],
      isUsageRow: (rec) => rec.type === 'turn.completed',
      body: (rec) => rec,
      tokens: {
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        cacheCreationInputTokens: 'cache_write_input_tokens',
        cacheReadInputTokens: 'cached_input_tokens'
      }
    },
    // `{"event":"result","result":{…,"usage":{…}}}` — keyed on `event`, with no
    // top-level `type` at all, and seconds where this interface holds
    // milliseconds.
    //
    // DELIBERATELY DROPPED, both backends: `thinking_tokens` (agy) and
    // `reasoning_output_tokens` (codex) have no member on
    // `InvocationUsageMetrics`, and adding one reaches the audit-entry
    // well-known list, the phase-end payload projection, the metrics IPC
    // contract and the dashboard. That is an evidence-schema change with its own
    // acceptance, not a field mapping — and a member wired half-way is the
    // written-but-never-read defect this item exists to close. Dropping is
    // reversible; the counts stay in the raw transcript either way.
    //
    // DELIBERATELY DROPPED: agy's `total_tokens`, which is `input + output` and
    // would be a second authority for a number already carried by two fields.
    agy: {
      lineMarkers: ['"event"', '"result"'],
      isUsageRow: (rec) => rec.event === 'result',
      body: (rec) => asRecord(rec.result),
      durationSeconds: 'duration_seconds',
      numTurns: 'num_turns',
      tokens: {
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        cacheReadInputTokens: 'cache_read_tokens'
      }
    }
  });

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
  field: string | undefined,
  source: Record<string, unknown>
): void {
  if (field === undefined) return;
  const parsed = finiteNumber(source[field]);
  if (parsed !== undefined) out[key] = parsed;
}

function assignInteger(
  out: MutableInvocationUsageMetrics,
  key: keyof InvocationUsageMetrics,
  field: string | undefined,
  source: Record<string, unknown>
): void {
  if (field === undefined) return;
  const parsed = finiteInteger(source[field]);
  if (parsed !== undefined) out[key] = parsed;
}

function metricsFromUsageRow(
  rec: Record<string, unknown>,
  vocab: BackendUsageVocabulary
): InvocationUsageMetrics | null {
  if (!vocab.isUsageRow(rec)) return null;
  const body = vocab.body(rec);
  if (!body) return null;

  const out: MutableInvocationUsageMetrics = {};
  assignNumber(out, 'cliDurationMs', vocab.durationMs, body);
  if (vocab.durationSeconds !== undefined) {
    // The one unit conversion in the table. Rounded to whole milliseconds so a
    // duration reads the same way whichever backend produced it; the discarded
    // remainder is sub-millisecond.
    const seconds = finiteNumber(body[vocab.durationSeconds]);
    if (seconds !== undefined) out.cliDurationMs = Math.round(seconds * MS_PER_SECOND);
  }
  assignInteger(out, 'numTurns', vocab.numTurns, body);
  assignNumber(out, 'totalCostUsd', vocab.totalCostUsd, body);

  const usage = asRecord(body.usage);
  if (usage) {
    assignInteger(out, 'inputTokens', vocab.tokens.inputTokens, usage);
    assignInteger(out, 'outputTokens', vocab.tokens.outputTokens, usage);
    assignInteger(
      out,
      'cacheCreationInputTokens',
      vocab.tokens.cacheCreationInputTokens,
      usage
    );
    assignInteger(out, 'cacheReadInputTokens', vocab.tokens.cacheReadInputTokens, usage);
  }

  return Object.keys(out).length > 0 ? out : null;
}

function metricsFromLine(
  rawLine: string,
  vocab: BackendUsageVocabulary
): InvocationUsageMetrics | null {
  const line = rawLine.trim();
  for (const marker of vocab.lineMarkers) {
    if (!line.includes(marker)) return null;
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_USAGE_JSON_LINE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A malformed line carries no metrics. On the final line this is the normal
    // case rather than an error: the stream may still be open, so a half-written
    // tail simply means there is nothing to read here yet.
    return null;
  }
  const record = asRecord(parsed);
  return record ? metricsFromUsageRow(record, vocab) : null;
}

/**
 * Extract numeric usage/cost fields from a backend's terminal envelope row.
 *
 * FR-R3-098 — the extractor is told which backend it is reading rather than
 * inferring it: the caller knows, and a parser that guesses its own input format
 * is a parser that can guess wrong. All three vocabularies live in one table in
 * this module, because a sibling parser per backend is the duplicate-authority
 * shape (`FR-082`) that drifts from the original.
 *
 * The raw stdout buffer is already capped by the runner; this parser still avoids
 * parsing arbitrary prose and only attempts JSON.parse on short lines carrying
 * that backend's markers. Last usage row wins, matching the phase-log metadata
 * strip's "latest value wins" behavior.
 */
export function extractInvocationUsageMetrics(
  stdout: ZippedStreamBuffer | string,
  backend: BackendRunnerKind
): InvocationUsageMetrics | null {
  const vocab = USAGE_VOCABULARIES[backend];
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

      const metrics = metricsFromLine(rawLine, vocab);
      if (metrics) latest = metrics;
    }
  }

  // Check the final line, which a stream that ended without a newline leaves here.
  if (activeLine.length > 0) {
    const metrics = metricsFromLine(activeLine, vocab);
    if (metrics) latest = metrics;
  }

  return latest;
}
