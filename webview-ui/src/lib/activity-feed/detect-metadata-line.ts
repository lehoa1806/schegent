// Feature 029 T026 — pure detector that maps a single
// `<key>=<value>` token (as it appears in PhaseLogDisplayEntry
// `system.systemSummary` / `result.resultSummary` strings) to a
// typed MetadataLine. Unknown keys return null.

import type { MetadataKey, MetadataLine } from './types';

const KEY_MAP: Record<string, MetadataKey> = {
  cwd: 'cwd',
  session_id: 'session_id',
  duration_ms: 'duration_ms',
  cost: 'cost',
  total_cost_usd: 'cost',
  tools: 'tools',
  model: 'model',
  num_turns: 'num_turns'
};

// Match `key=value` where `value` is everything up to the next
// whitespace OR end-of-input. Captures the raw key as group 1 and
// the value as group 2.
const KEY_VALUE_RE = /^([a-z_][a-z0-9_]*)=(\S.*?)?$/i;

export function detectMetadataLine(line: string): MetadataLine | null {
  if (line.length === 0) return null;
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const m = KEY_VALUE_RE.exec(trimmed);
  if (m === null) return null;
  const rawKey = m[1];
  const value = m[2] ?? '';
  const canonical = KEY_MAP[rawKey];
  if (canonical === undefined) return null;
  return { key: canonical, rawKey, value };
}

// Helper for callers that need to split a multi-token line
// (system/result summaries are formatted as
// `duration_ms=123 num_turns=3 total_cost_usd=0.01`). Splits on
// whitespace and returns one MetadataLine per recognised token,
// preserving order.
export function detectMetadataLinesFromSummary(summary: string): MetadataLine[] {
  if (summary.length === 0) return [];
  const tokens = summary.split(/\s+/);
  const out: MetadataLine[] = [];
  for (const token of tokens) {
    const m = detectMetadataLine(token);
    if (m !== null) out.push(m);
  }
  return out;
}
