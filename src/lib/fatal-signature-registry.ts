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

export type FatalStream = 'stdout' | 'stderr';

/**
 * Streams a built-in signature can legitimately originate on.
 *
 * A signature is a diagnostic the CLI *emits about itself*. Scanning for
 * one on a stream it never originates on cannot detect anything — it can
 * only produce false positives, because both streams also carry text the
 * CLI is merely transporting (tool results, file contents, model output).
 * `error: unknown option` is an argument-parse diagnostic and is stderr-only
 * by origin; a stdout occurrence is necessarily something the CLI was
 * carrying, not something it reported. See the 2026-08-16 incident recorded
 * on `SIGNATURE_STREAMS` below.
 *
 * Operator additions carry no scope and are scanned on both streams: the
 * `schegent.fatalSignatures` setting is a bare string list and widening it
 * would be an operator-facing schema change. The line-scoping in
 * `incremental-fatal-scanner.ts` is what keeps a transported payload from
 * arming those.
 */
const BOTH_STREAMS = ['stdout', 'stderr'] as const;
const STDERR_ONLY = ['stderr'] as const;

export interface FatalSignatureSpec {
  readonly pattern: FatalSignature;
  readonly streams: ReadonlyArray<FatalStream>;
}

/*
 * Per-signature stream scope (2026-08-16).
 *
 * `error: unknown option` was scanned on stdout as well as stderr. On
 * 2026-08-16 a `speckit-implement` phase read this repository's own
 * ARCHITECTURE.md, which documents this registry and quotes the pattern
 * verbatim. The file arrived on stdout inside a stream-json `tool_result`,
 * the scan matched it, and the phase was failed at 3.6 hours with exit
 * code 0 — the documentation of the trap sprang the trap. Scoping the
 * entry to the stream its comment always said it came from removes the
 * only stream on which it can be a false positive.
 */
export const SIGNATURE_STREAMS: ReadonlyArray<FatalSignatureSpec> = Object.freeze([
  { pattern: "error: unknown option", streams: STDERR_ONLY },
  { pattern: "Autocompact is thrashing", streams: BOTH_STREAMS }
]);

/**
 * The code-resident floor, patterns only. Kept as a string list so the
 * "adding a signature is a one-line edit" guarantee and every existing
 * membership assertion hold unchanged; `SIGNATURE_STREAMS` above carries
 * the scope for each entry and is the array to edit when adding one.
 */
export const FATAL_SIGNATURES: ReadonlyArray<FatalSignature> = Object.freeze(
  SIGNATURE_STREAMS.map((entry) => entry.pattern)
);

export type FatalSource = 'built-in' | 'operator-defined';

export interface EffectiveSignature {
  readonly pattern: FatalSignature;
  readonly source: FatalSource;
  /**
   * Streams this entry may be scanned on. Operator entries carry both.
   * Optional so a hand-built signature keeps the pre-scoping behavior:
   * absent means both, which can only ever admit a match, never suppress
   * one — the permissive direction is the safe default for detection.
   */
  readonly streams?: ReadonlyArray<FatalStream>;
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
 * Longest line still eligible to be a CLI diagnostic. Observed diagnostics
 * are well under 1 KB; stream-json envelopes carrying a file routinely run
 * to tens of KB. Set with generous headroom over the former and well under
 * the latter.
 */
export const MAX_DIAGNOSTIC_LINE_LENGTH = 4096;

/**
 * Whether a single line could be a diagnostic the CLI emitted about itself,
 * as opposed to text it was merely transporting.
 *
 * Both streams carry transported payload — in `--output-format stream-json`
 * stdout is one JSON envelope per line, and those envelopes carry tool
 * results, i.e. the full text of every file the agent reads. A signature
 * quoted inside such a payload is not the CLI reporting anything, and
 * treating it as one failed a run on 2026-08-16 (see `SIGNATURE_STREAMS`).
 *
 * Two cheap tests, neither of which transported content can pass, because
 * content cannot escape the envelope carrying it:
 *   - a line opening with `{` or `[` is a structured envelope;
 *   - a line over `MAX_DIAGNOSTIC_LINE_LENGTH` is not a diagnostic.
 *
 * This is the single definition of that rule. `classifyFatal` below and the
 * streaming scanner in `incremental-fatal-scanner.ts` both consult it, so
 * the retained-text oracle and the whole-stream oracle cannot disagree.
 */
export function isDiagnosticLine(line: string): boolean {
  if (line.length === 0 || line.length > MAX_DIAGNOSTIC_LINE_LENGTH) return false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === ' ' || char === '\t' || char === '\r') continue;
    return char !== '{' && char !== '[';
  }
  return false;
}

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
  for (const entry of SIGNATURE_STREAMS) {
    if (seen.has(entry.pattern)) continue;
    seen.add(entry.pattern);
    result.push(
      Object.freeze({ pattern: entry.pattern, source: 'built-in' as const, streams: entry.streams })
    );
  }
  for (const addition of operatorAdditions) {
    if (typeof addition !== 'string') continue;
    if (addition.length === 0) continue;
    if (seen.has(addition)) continue;
    seen.add(addition);
    result.push(
      Object.freeze({
        pattern: addition,
        source: 'operator-defined' as const,
        streams: BOTH_STREAMS
      })
    );
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
  const stdoutLines = diagnosticLinesOf(stdout);
  const stderrLines = diagnosticLinesOf(stderr);
  for (const entry of list) {
    // `streams` is optional only for callers constructing an
    // EffectiveSignature by hand; absent means both, as before scoping.
    const streams = entry.streams ?? BOTH_STREAMS;
    if (streams.includes('stdout') && containsPattern(stdoutLines, entry.pattern)) {
      return { matched: true, signature: entry.pattern, stream: 'stdout', source: entry.source };
    }
    if (streams.includes('stderr') && containsPattern(stderrLines, entry.pattern)) {
      return { matched: true, signature: entry.pattern, stream: 'stderr', source: entry.source };
    }
  }
  return { matched: false };
}

/**
 * The lines of `text` that could be diagnostics, per `isDiagnosticLine`.
 *
 * Walks by newline index rather than `split('\n')` so an over-length line
 * is rejected before it is sliced. Retained stream text runs to megabytes
 * and is overwhelmingly long stream-json envelopes; materializing every
 * one of them to throw it away would spike memory on the same path
 * `tests/perf/sustained-evidence-path.test.ts` pins as bounded.
 */
function diagnosticLinesOf(text: string): ReadonlyArray<string> {
  const lines: string[] = [];
  if (text.length === 0) return lines;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const length = end - start;
    if (length > 0 && length <= MAX_DIAGNOSTIC_LINE_LENGTH) {
      const line = text.slice(start, end);
      if (isDiagnosticLine(line)) lines.push(line);
    }
    start = end + 1;
  }
  return lines;
}

function containsPattern(lines: ReadonlyArray<string>, pattern: string): boolean {
  for (const line of lines) {
    if (line.includes(pattern)) return true;
  }
  return false;
}
