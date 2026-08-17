/*
 * Streaming counterpart to `classifyFatal` (feature 010 / 011).
 *
 * `classifyFatal` scans the text the runner *retained*. Above the stream
 * cap the retained text is a head plus a rolling tail, so a signature in
 * the discarded middle is invisible to it — which is why truncation had
 * to be treated as unclassifiable regardless of what the retained text
 * said. This scanner runs on every chunk as it arrives, so its coverage
 * is the whole observed stream whether or not retention truncated.
 *
 * It reproduces `classifyFatal`'s answer rather than approximating it.
 * Two properties do that work:
 *
 *   - `classifyFatal` returns the LOWEST-INDEX entry that matches anywhere,
 *     not the earliest match in the text. Tracking the best (lowest) index
 *     seen so far and only scanning entries below it converges on the same
 *     entry no matter how the stream was chunked.
 *   - It checks stdout before stderr for each entry, so a tie between the
 *     two streams resolves to stdout. `combineStreamScans` applies the same
 *     rule to two per-stream scanners.
 *
 * The operator-additive list is passed in per invocation and never held
 * here beyond the scanner's own lifetime, preserving the "never cache the
 * operator-additive fatal-signature setting across phase invocations" rule.
 *
 * ---------------------------------------------------------------------
 * Line scoping (2026-08-16)
 *
 * A signature is a diagnostic the CLI emits *about itself*. Both streams
 * also carry text the CLI is merely transporting — in `--output-format
 * stream-json`, stdout is one JSON envelope per line and those envelopes
 * carry tool results, i.e. the full text of every file the agent reads.
 * Scanning raw bytes could not tell the two apart.
 *
 * On 2026-08-16 that cost a run: a `speckit-implement` phase read this
 * repository's ARCHITECTURE.md, which documents this very registry and
 * quotes `error: unknown option` verbatim. The file arrived inside a
 * `tool_result` envelope, the byte scan matched, and the phase failed at
 * 3.6 hours with exit code 0.
 *
 * So the scan is now line-oriented, and a line is scanned only when it
 * could be a diagnostic:
 *
 *   - a line whose first non-whitespace character is `{` or `[` is a
 *     structured envelope, and transported payload is always *inside* one;
 *   - a line longer than `MAX_DIAGNOSTIC_LINE_LENGTH` is not a diagnostic
 *     (real ones are short) and is the shape a large tool result takes.
 *
 * Neither test can be satisfied by file content, because file content
 * cannot escape the envelope that carries it. Both are cheap: a character
 * check and a length check, no JSON parse.
 */

import {
  getEffectiveSignatures,
  isDiagnosticLine,
  MAX_DIAGNOSTIC_LINE_LENGTH,
  type EffectiveSignature,
  type FatalClassification,
  type FatalStream
} from './fatal-signature-registry';

export class IncrementalFatalScanner {
  private readonly list: ReadonlyArray<EffectiveSignature>;
  private readonly stream: FatalStream;
  private partial = '';
  /** Set once the in-progress line is disqualified; cleared at each newline. */
  private partialDisqualified = false;
  private bestIndex: number | null = null;

  constructor(stream: FatalStream, list?: ReadonlyArray<EffectiveSignature>) {
    this.stream = stream;
    this.list = list ?? getEffectiveSignatures([]);
  }

  /** Feed the next chunk of this stream, in order. */
  public append(chunk: string): void {
    if (chunk.length === 0) return;
    // Index 0 is the best attainable answer; nothing later can improve it.
    if (this.bestIndex === 0) return;

    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      if (newline === -1) {
        this.growPartial(chunk.slice(start));
        return;
      }
      this.growPartial(chunk.slice(start, newline));
      this.scanPartial();
      this.partial = '';
      this.partialDisqualified = false;
      if (this.bestIndex === 0) return;
      start = newline + 1;
    }
  }

  /**
   * Scan the trailing line, if any. A stream whose last line has no
   * terminating newline still gets classified.
   */
  public finalize(): void {
    if (this.partial.length === 0) return;
    this.scanPartial();
    this.partial = '';
    this.partialDisqualified = false;
  }

  private growPartial(segment: string): void {
    if (this.partialDisqualified) return;
    // Length is monotonic, so a line already over the cap can only stay
    // over it: stop retaining one as soon as it crosses. This is the only
    // early exit — the structured-envelope test needs the whole line, since
    // a partial that is still all whitespace has not decided yet.
    if (this.partial.length + segment.length > MAX_DIAGNOSTIC_LINE_LENGTH) {
      this.partial = '';
      this.partialDisqualified = true;
      return;
    }
    this.partial += segment;
  }

  private scanPartial(): void {
    if (this.partialDisqualified || !isDiagnosticLine(this.partial)) return;
    const limit = this.bestIndex ?? this.list.length;
    for (let i = 0; i < limit; i++) {
      const entry = this.list[i];
      if (entry.streams !== undefined && !entry.streams.includes(this.stream)) continue;
      if (this.partial.includes(entry.pattern)) {
        this.bestIndex = i;
        return;
      }
    }
  }

  /** Registry index of the best match seen, or `null` when none matched. */
  public get matchedIndex(): number | null {
    return this.bestIndex;
  }

  public get matchedSignature(): EffectiveSignature | null {
    return this.bestIndex === null ? null : this.list[this.bestIndex];
  }
}

/**
 * Resolve two per-stream scanners into a single classification using
 * `classifyFatal`'s ordering: lower registry index wins outright, and
 * stdout wins a tie because it is checked first for each entry.
 */
export function combineStreamScans(
  stdout: IncrementalFatalScanner,
  stderr: IncrementalFatalScanner
): FatalClassification {
  const stdoutIndex = stdout.matchedIndex;
  const stderrIndex = stderr.matchedIndex;
  if (stdoutIndex === null && stderrIndex === null) return { matched: false };

  const stdoutWins =
    stdoutIndex !== null && (stderrIndex === null || stdoutIndex <= stderrIndex);
  const entry = (stdoutWins ? stdout : stderr).matchedSignature;
  if (!entry) return { matched: false };

  return {
    matched: true,
    signature: entry.pattern,
    stream: stdoutWins ? 'stdout' : 'stderr',
    source: entry.source
  };
}
