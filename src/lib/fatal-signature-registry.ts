/*
 * Fatal Signature Registry (feature 010 — pipeline-resilience).
 *
 * A code-resident allowlist of verbatim substrings. When the Claude CLI
 * emits one of these on stdout or stderr (independently scanned), the
 * active phase aborts within the current invocation (FR-001/002/004).
 *
 * Adding a new signature requires editing FATAL_SIGNATURES alone. No
 * parser, controller, or audit-pipeline change is needed — that is the
 * extensibility guarantee surface (FR-001). Operator-facing config does
 * not influence this registry (Constitution IV — code-level allowlist).
 *
 * Feature 011 extension: operators MAY contribute *additive* entries
 * via `schegent.fatalSignatures` (workspace settings). Those additions
 * are merged at registry-read time into an `EffectiveSignature[]`. The
 * code-resident floor remains immutable — operators cannot remove or
 * re-order built-ins (CLAUDE.md 010 T12 hard rule preserved per FR-038).
 *
 * Scan order is pinned: built-ins first in registry order, then
 * operator-defined entries in insertion order. For each, scan stdout
 * first, then stderr. Return on first match. Built-ins-first ordering
 * guarantees that when both a built-in and an operator addition match
 * the same text, the built-in wins — attribution is deterministic.
 *
 * Public surface: FATAL_SIGNATURES, the FatalSignature / FatalStream /
 * FatalMatch / NoFatalMatch / FatalClassification / EffectiveSignature
 * type aliases, getEffectiveSignatures(), and classifyFatal().
 */

export type FatalSignature = string;

// v1 entry: surfaces when the operator's Claude credits are exhausted.
// Verbatim text comes from CLI stderr observed in the field.
export const FATAL_SIGNATURES: ReadonlyArray<FatalSignature> = Object.freeze([
  "error: unknown option",
  "Autocompact is thrashing"
]);

export type FatalStream = 'stdout' | 'stderr';

export type FatalSource = 'built-in' | 'operator-defined';

export interface EffectiveSignature {
  readonly pattern: FatalSignature;
  readonly source: FatalSource;
}

export interface FatalMatch {
  readonly matched: true;
  readonly signature: FatalSignature;
  readonly stream: FatalStream;
  readonly source: FatalSource;
}

export interface NoFatalMatch {
  readonly matched: false;
}

export type FatalClassification = FatalMatch | NoFatalMatch;

/**
 * Compute the merged effective signature list per FR-033 / FR-038.
 *
 * Algorithm:
 *   1. Built-ins first, mapped to `{ pattern, source: 'built-in' }`.
 *   2. For each operator addition:
 *      - skip if it duplicates a built-in (built-in keeps its `source`),
 *      - skip if a prior operator entry with the same pattern was added.
 *   3. Return a frozen array.
 *
 * The returned array's built-in entries are ALWAYS a superset of
 * `FATAL_SIGNATURES`. No operator input can remove or demote the floor.
 */
export function getEffectiveSignatures(
  operatorAdditions: readonly string[]
): ReadonlyArray<EffectiveSignature> {
  const result: EffectiveSignature[] = [];
  const seen = new Set<string>();
  for (const pattern of FATAL_SIGNATURES) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    result.push(Object.freeze({ pattern, source: 'built-in' as const }));
  }
  for (const addition of operatorAdditions) {
    if (typeof addition !== 'string') continue;
    if (addition.length === 0) continue;
    if (seen.has(addition)) continue;
    seen.add(addition);
    result.push(Object.freeze({ pattern: addition, source: 'operator-defined' as const }));
  }
  return Object.freeze(result);
}

/**
 * Classify (stdout, stderr) against the supplied effective signature
 * list. Returns the first match in scan order with full attribution
 * (`signature`, `stream`, `source`). When `effective` is omitted the
 * built-in floor is used — keeps the (stdout, stderr) signature
 * backwards-compatible for existing call sites that have not yet
 * threaded the operator-defined list through (010 callers).
 */
export function classifyFatal(
  stdout: string,
  stderr: string,
  effective?: ReadonlyArray<EffectiveSignature>
): FatalClassification {
  const list = effective ?? getEffectiveSignatures([]);
  for (const entry of list) {
    if (stdout.includes(entry.pattern)) {
      return { matched: true, signature: entry.pattern, stream: 'stdout', source: entry.source };
    }
    if (stderr.includes(entry.pattern)) {
      return { matched: true, signature: entry.pattern, stream: 'stderr', source: entry.source };
    }
  }
  return { matched: false };
}
