// Feature 098 (PRIV-01) — the single boundary scrub for phase-log
// display entries.
//
// Two call sites project the same on-disk `stream.jsonl` bytes into the
// webview: `phase-log-reader.ts` when an operator reopens a finished
// phase, and `phase-log-tail-session.ts` while one is still in flight.
// They each owned a field list, and the lists had drifted — the tail's
// covered five fields where the reader's covered seven, and the tail
// never descended into `toolArguments` at all. The result was a
// redaction that depended on *when* you looked: reopen a phase and a
// token was masked; watch the same phase live and it was not.
//
// The `tool-use` shape makes that concrete. `projectStreamJsonlLine`
// emits a tool's input twice — JSON-stringified into `toolInput` and
// structured into `toolArguments` — so scrubbing only the first ships a
// masked string next to its cleartext original in one message. Two
// lists cannot hold that invariant; one list can.
//
// Redaction itself is NOT implemented here. `sanitize` is the host's
// `SanitizedLogger.sanitize`, injected by both callers, so
// `SECRET_PATTERNS` stays the single source of truth (see CLAUDE.md,
// "Never fork the redaction set"). This module decides *what* is
// scrubbed; the logger decides *how*.
//
// Note this field set is deliberately NOT the truncator's `CAPPED_FIELDS`
// in `phase-log-truncator.ts`, despite the overlap. Those answer
// different questions — which fields can grow unbounded, versus which
// fields can carry operator content — and merging them would silently
// couple a size decision to a privacy one.

import type { PhaseLogDisplayEntry, ToolArgumentValue } from './types';

/**
 * Every `PhaseLogDisplayEntry['body']` field the projector can populate
 * from CLI output. Excludes `isError` (boolean) and `reason` (a closed
 * enum of tail-ended reasons), neither of which carries operator text.
 */
export const SANITIZED_BODY_FIELDS = [
  'text',
  'toolName',
  'toolInput',
  'toolResult',
  'systemSubtype',
  'systemSummary',
  'resultSummary'
] as const;

export type SanitizableBodyField = (typeof SANITIZED_BODY_FIELDS)[number];

/**
 * Recursively sanitize the string leaves of a `ToolArgumentValue`,
 * preserving object/array shape and non-string leaves. Keys are NOT
 * sanitized — they are well-known argument names, not values.
 *
 * Returns the input reference unchanged when nothing matched, so callers
 * can use identity to decide whether to allocate a new body.
 */
export function sanitizeToolArguments(
  value: ToolArgumentValue,
  sanitize: (s: string) => string
): { readonly value: ToolArgumentValue; readonly mutated: boolean } {
  if (typeof value === 'string') {
    if (value.length === 0) return { value, mutated: false };
    const cleaned = sanitize(value);
    if (cleaned === value) return { value, mutated: false };
    return { value: cleaned, mutated: true };
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { value, mutated: false };
  }
  if (Array.isArray(value)) {
    const out: ToolArgumentValue[] = [];
    let mutated = false;
    for (const item of value) {
      const r = sanitizeToolArguments(item, sanitize);
      out.push(r.value);
      if (r.mutated) mutated = true;
    }
    return { value: mutated ? out : value, mutated };
  }
  // Plain object.
  const out: { [k: string]: ToolArgumentValue } = {};
  let mutated = false;
  for (const [k, v] of Object.entries(value as object)) {
    const r = sanitizeToolArguments(v as ToolArgumentValue, sanitize);
    out[k] = r.value;
    if (r.mutated) mutated = true;
  }
  return { value: mutated ? out : value, mutated };
}

/**
 * Scrub every operator-content field of a display entry's body, flat and
 * nested. Returns the input entry unchanged when nothing matched.
 *
 * Call this LAST, after projection and truncation: truncation bounds the
 * bytes, sanitization is the final boundary scrub.
 */
export function sanitizeDisplayEntryBody(
  entry: PhaseLogDisplayEntry,
  sanitize: (s: string) => string
): PhaseLogDisplayEntry {
  const next: { [k: string]: unknown } = { ...entry.body };
  let mutated = false;
  for (const field of SANITIZED_BODY_FIELDS) {
    const raw = (entry.body as Partial<Record<SanitizableBodyField, string>>)[field];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const cleaned = sanitize(raw);
    if (cleaned !== raw) {
      next[field] = cleaned;
      mutated = true;
    }
  }
  const args = entry.body.toolArguments;
  if (args !== undefined) {
    const r = sanitizeToolArguments(args, sanitize);
    if (r.mutated) {
      next['toolArguments'] = r.value;
      mutated = true;
    }
  }
  if (!mutated) return entry;
  return { ...entry, body: next as PhaseLogDisplayEntry['body'] };
}
