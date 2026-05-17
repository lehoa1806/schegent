// Feature 029 T014 — pure parser that produces an ordered
// ParsedToolArgument[] from a tool-use entry. Prefers the typed
// `body.toolArguments` payload (added in T005); falls back to
// JSON-parsing the legacy `body.toolInput` string when the typed
// payload is absent. On parse failure, returns the raw text so the
// renderer can display it inside a MultiLineCodeBlock.

import { classifyArgValue } from './classify-arg-value';
import type {
  ParseToolArgumentsResult,
  ParsedToolArgument,
  ToolArgumentValue
} from './types';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';

function isPlainObject(v: unknown): v is { [k: string]: ToolArgumentValue } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function recordToArgs(
  rec: { [k: string]: ToolArgumentValue }
): ParsedToolArgument[] {
  const out: ParsedToolArgument[] = [];
  for (const [k, v] of Object.entries(rec)) {
    out.push({
      key: k,
      value: v,
      classification: classifyArgValue(v, k)
    });
  }
  return out;
}

export function parseToolArguments(
  entry: PhaseLogDisplayEntry
): ParseToolArgumentsResult {
  // Path 1 — typed payload from host. The host has already sanitized
  // string leaves and may have replaced the value with one of two
  // sentinels (`__elided` or `__truncated`); both flow through as
  // legitimate object payloads — the renderer surfaces them as labels.
  const typed = entry.body.toolArguments;
  if (typed !== undefined) {
    if (isPlainObject(typed)) {
      return { ok: true, args: recordToArgs(typed) };
    }
    // Defensive: should never happen (the host wraps bare strings as
    // `{value: '...'}`), but render as a single-key arg so we don't
    // throw inside a hot render path.
    return {
      ok: true,
      args: [
        {
          key: 'value',
          value: typed,
          classification: classifyArgValue(typed, 'value')
        }
      ]
    };
  }
  // Path 2 — legacy string fallback. Old iteration manifests written
  // before this feature ships only emit `toolInput` as a stringified
  // JSON blob. Try to parse it; on failure, surface the raw text so
  // the renderer can display the bytes inside a code block.
  const raw = entry.body.toolInput;
  if (raw === undefined || raw === '') {
    return { ok: true, args: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, rawText: raw };
  }
  if (isPlainObject(parsed)) {
    return { ok: true, args: recordToArgs(parsed as { [k: string]: ToolArgumentValue }) };
  }
  // The string parsed to something non-object (a bare string, number,
  // array, etc.) — wrap it so the renderer can still display it.
  return {
    ok: true,
    args: [
      {
        key: 'value',
        value: parsed as ToolArgumentValue,
        classification: classifyArgValue(parsed as ToolArgumentValue, 'value')
      }
    ]
  };
}
