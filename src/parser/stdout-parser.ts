import type { AuditEntryFields } from '../audit/audit-entry';
import {
  classifyFatal,
  type EffectiveSignature,
  type FatalClassification,
  type FatalSource
} from '../lib/fatal-signature-registry';
import type { TrailingRegion } from './audit-log-parser';
import { extractRateLimitMessage, extractResetTimestamp } from './rate-limit-reset-extractor';

/**
 * Feature 107 (FR-029) — `warnings` is optional on the non-`malformed`
 * variants.
 *
 * Before this feature the field existed on `malformed` alone, so every
 * `warnings.push` on a path that resolved to `clean`, `remaining_issues`, or
 * `open_questions` built a string and dropped it. Three constitution warnings
 * were unreachable that way, and a warning that is constructed and discarded
 * is the same defect as a gate that cannot fail. Both consumers in
 * `phase-runner.ts` already duck-type `'warnings' in result`, so widening the
 * type is what delivers them.
 */
export type InvocationResult =
  | { kind: 'clean'; auditEntry: AuditEntryFields | null; warnings?: string[] }
  | {
      kind: 'open_questions';
      questions: string[];
      auditEntry: AuditEntryFields | null;
      warnings?: string[];
    }
  | {
      kind: 'remaining_issues';
      issues: Array<{ tag?: string; summary: string }>;
      auditEntry: AuditEntryFields | null;
      warnings?: string[];
    }
  | {
      kind: 'rate_limited';
      cause: string;
      auditEntry: AuditEntryFields | null;
      // Feature 027 — pre-buffer parsed reset epoch (ms). Null when no
      // parseable reset was found in the CLI stdout/stderr; the controller
      // falls back to the fixed `RATE_LIMIT_BACKOFF_MS` in that case.
      resetsAtMs?: number | null;
      // Bugfix 2026-05-15 — BUG-002 (FR-017): short summary of the CLI's
      // rate-limit message text (≤240 chars). Flows into the controller's
      // debug log line before `backoffForCause`. Null when no rate-limit
      // signal was found in either buffer.
      rateLimitMessage?: string | null;
    }
  // Feature 011 — FR-001: a non-zero CLI exit that matches neither
  // `classifyFatal` nor the rate-limit pattern, and produces no contract
  // block, is classified as `transient_error`. The controller schedules a
  // 15-min delayed retry.
  // Feature 107 — `warnings` reaches here too, and this is the path where it
  // matters most: a non-zero exit carrying an out-of-region token is an
  // attempted upgrade of a failing run, and that is precisely the event an
  // operator needs to see.
  | {
      kind: 'transient_error';
      exitCode: number;
      auditEntry: AuditEntryFields | null;
      warnings?: string[];
    }
  | {
      kind: 'malformed';
      warnings: string[];
      auditEntry: AuditEntryFields | null;
      fatalCause?: string;
      // Feature 011 FR-037 — when malformed is the fatal-signature path,
      // attribute the matched signature to its registry source. Absent
      // when `fatalCause` is unset (non-fatal malformed paths).
      fatalSource?: FatalSource;
    };

const TERMINATION_REGEX = /\[SCHEGENT_STATUS:\s*(CLEAR|DONE|RESOLVED)\]/i;
const OPEN_HEADING_REGEX = /^\s*(Open|Remaining)\s+(questions|clarifications):\s*$/i;
const ISSUES_HEADING_REGEX =
  /^\s*(Remaining issues|Failed with \d+ errors?|Failing with \d+ issues?):?\s*$/i;
const BULLET_REGEX = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const TAGGED_BULLET_REGEX =
  /^\s*(?:[-*]|\d+\.)\s+(?:\[([a-z][a-z0-9-]*)\]\s+)?(.+?)\s*$/;

export function detectTerminationToken(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (TERMINATION_REGEX.test(line)) {
      return true;
    }
  }
  return false;
}

// Feature 107 (FR-012) — fence delimiters are triple-backtick sequences at
// line start after trimming. A fixed-string comparison, never a regex: this
// runs over attacker-influenced input and must not backtrack. Tilde fences and
// indented code blocks are deliberately not tracked; a token inside one warns
// nothing and still resolves, which is the pre-107 behavior.
const FENCE_DELIMITER = '```';

interface RegionScan {
  /** Tokens found in the region, at any fence depth. */
  count: number;
  /** Of those, how many sat inside an open fence. */
  fencedCount: number;
}

/**
 * Feature 107 (FR-007, FR-012, FR-013) — scan the trailing region for the
 * termination token, tracking fence depth from zero.
 *
 * Depth starts at zero *inside the region* (plan D4) by construction: nothing
 * before the region is read. Carrying fence state in from the head would let
 * content preceding the audit block change how the region is interpreted,
 * which is exactly the coupling this feature removes. Work is linear in the
 * region's length.
 */
function scanRegion(region: string): RegionScan {
  let inFence = false;
  let count = 0;
  let fencedCount = 0;
  for (const line of region.split(/\r?\n/)) {
    if (line.trim().startsWith(FENCE_DELIMITER)) {
      // A delimiter line is structure, not content: it toggles and is not
      // itself searched. This is why a backtick-*decorated* token (a single
      // backtick) still matches — it is not a delimiter.
      inFence = !inFence;
      continue;
    }
    if (TERMINATION_REGEX.test(line)) {
      count += 1;
      if (inFence) fencedCount += 1;
    }
  }
  return { count, fencedCount };
}

/**
 * Feature 107 (FR-010) — locate tokens the model printed outside the region.
 *
 * This is the same per-line test the parser already ran over the whole stream
 * before this feature, so it adds no work; only the *decision* moved into the
 * region. Fence tracking deliberately does not run here (FR-013) — the head
 * can be tens of megabytes and nothing out here is actionable anyway.
 */
function scanOutsideRegion(stdout: string, regionText: string): { count: number; firstLine: number } {
  // Bounded by line count, not by byte length: the region is rejoined with
  // '\n', so on CRLF input its length no longer matches the bytes it came from.
  const lines = stdout.split(/\r?\n/);
  const headLineCount = lines.length - regionText.split('\n').length;
  let count = 0;
  let firstLine = 0;
  for (let i = 0; i < headLineCount; i++) {
    if (TERMINATION_REGEX.test(lines[i])) {
      count += 1;
      if (firstLine === 0) firstLine = i + 1;
    }
  }
  return { count, firstLine };
}

/**
 * Feature 107 (FR-007, FR-009, FR-010, FR-011) — the one place the host decides
 * whether it saw its own termination token.
 *
 * With a region, only the region decides; anything found outside it is
 * reported by position and count and otherwise ignored. Without a region the
 * whole-stdout scan is kept — a run whose audit block was cut by the retention
 * window is a real, recoverable shape, not an attack — but an acceptance made
 * that way is labeled so it is never indistinguishable from a bounded one.
 */
function detectTermination(
  stdout: string,
  region: TrailingRegion | undefined,
  warnings: string[]
): boolean {
  if (!region?.present) {
    const matched = detectTerminationToken(stdout);
    if (matched) warnings.push('[constitution] token accepted without audit block');
    return matched;
  }

  const { count, fencedCount } = scanRegion(region.text);
  if (count > 1) {
    warnings.push(`[constitution] multiple termination tokens in audit region (${count} found)`);
  }
  if (fencedCount > 0) {
    warnings.push(
      `[constitution] termination token inside a code fence (${fencedCount} of ${count} in region)`
    );
  }
  const outside = scanOutsideRegion(stdout, region.text);
  if (outside.count > 0) {
    // FR-014 — position and count only. The surrounding bytes are
    // attacker-influenced and must not reach an operator-facing log.
    warnings.push(
      `[constitution] termination token outside audit region (${outside.count} occurrence${outside.count === 1 ? '' : 's'}, first at line ${outside.firstLine})`
    );
  }
  return count > 0;
}

export function extractOpenQuestions(stdout: string): string[] {
  return extractBulletsAfter(stdout, OPEN_HEADING_REGEX);
}

export function extractRemainingIssues(stdout: string): Array<{ tag?: string; summary: string }> {
  const lines = stdout.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => ISSUES_HEADING_REGEX.test(line));
  if (headingIndex === -1) return [];
  const items: Array<{ tag?: string; summary: string }> = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    const match = TAGGED_BULLET_REGEX.exec(line);
    if (!match) {
      if (BULLET_REGEX.test(line)) continue;
      break;
    }
    const tag = match[1];
    const summary = match[2];
    items.push(tag ? { tag, summary } : { summary });
  }
  return items;
}

function extractBulletsAfter(stdout: string, headingRegex: RegExp): string[] {
  const lines = stdout.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => headingRegex.test(line));
  if (headingIndex === -1) return [];
  const items: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    const match = BULLET_REGEX.exec(line);
    if (!match) break;
    items.push(match[1]);
  }
  return items;
}

import type { ApiErrorMetadata } from './stream-json-unwrapper';

export interface ParseInputs {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  rateLimit: { matched: boolean; cause: string };
  auditEntry: AuditEntryFields | null;
  auditWarnings: string[];
  apiError?: ApiErrorMetadata | null;
  /**
   * Feature 011 FR-033 — operator-additive fatal signatures merged with
   * the code-resident floor. When omitted the parser uses the built-in
   * floor only, preserving the pre-011 behavior for callers that have
   * not been updated (e.g. tests).  */
  effectiveFatalSignatures?: ReadonlyArray<EffectiveSignature>;
  /**
   * Result of the runner's incremental scan over every byte the invocation
   * emitted (`RawInvocationOutput.streamFatalMatch`).
   *
   * `inputs.stdout` is post-retention text: above `MAX_STREAM_BUFFER_BYTES`
   * it is a head plus a rolling tail, so `classifyFatal` cannot see a
   * signature in the discarded middle. A `matched` value here is used in
   * place of that scan. It is only ever consulted when it matched, so it
   * can add a classification the retained text would have missed and can
   * never suppress one — the code-resident floor is unchanged either way.
   */
  streamFatalMatch?: FatalClassification;
  /**
   * Feature 107 (FR-003) — the trailing region published by
   * `parseAuditLogBlock` over this same `stdout` string. Both control reads
   * consume one string, so the boundary is computed once and the two layers
   * cannot disagree.
   *
   * When omitted the parser behaves exactly as it did before this feature —
   * the whole-stdout scan — which keeps every caller that has not been updated
   * working. That path is labeled at the point of acceptance (FR-009) so a
   * degraded read is never mistaken for a bounded one.
   */
  region?: TrailingRegion;
}

export function parseInvocation(inputs: ParseInputs): InvocationResult {
  const warnings = [...inputs.auditWarnings];

  // Feature 010 — FR-001/002/006: fatal classification runs BEFORE any
  // other detection (including rate-limit). A registered signature in
  // either stream halts the run on this invocation regardless of exit
  // code or block presence. Exit-code-only detection is not sufficient.
  const fatal = inputs.streamFatalMatch?.matched
    ? inputs.streamFatalMatch
    : classifyFatal(inputs.stdout, inputs.stderr, inputs.effectiveFatalSignatures);
  if (fatal.matched) {
    return {
      kind: 'malformed',
      warnings: [fatal.signature, ...warnings],
      auditEntry: inputs.auditEntry,
      fatalCause: fatal.signature,
      fatalSource: fatal.source
    };
  }

  // Bugfix 2026-05-23 — BUG-008: defensive symmetric check.
  // `detectCreditError` already returns `matched: false` on `exitCode === 0`,
  // so this guard is belt-and-suspenders: it prevents a future caller
  // that constructs a synthetic `rateLimit.matched = true` against a
  // successful invocation (e.g., a test harness, a replay-from-fixture
  // path, or a code change in a different layer) from routing through
  // the `rate_limited` branch. A successful CLI completion is by
  // definition not a rate-limit failure regardless of payload content.
  if (inputs.rateLimit.matched && inputs.exitCode !== 0) {
    // Feature 027 — parse the CLI's reported reset epoch (when present)
    // so the controller can schedule a dynamic delayed retry instead of
    // the fixed 60-minute fallback. Bugfix 2026-05-15 — BUG-002: pass
    // stderr too so the canonical plain-mode emission (`You're out of
    // extra usage · resets <time> (<tz>)` on stderr) is reachable.
    const { resetsAtMs } = extractResetTimestamp(inputs.stdout, inputs.stderr, Date.now(), {
      // BUG-009 — this branch is gated by `exitCode !== 0`, so
      // `allowed_warning` records carry load-bearing reset epochs.
      includeWarningStatus: true
    });
    const rateLimitMessage = extractRateLimitMessage(inputs.stdout, inputs.stderr);
    return {
      kind: 'rate_limited',
      cause: inputs.rateLimit.cause,
      auditEntry: inputs.auditEntry,
      resetsAtMs,
      rateLimitMessage
    };
  }
  // Feature 030 BUG-00x — apiError takes precedence over missing audit log
  // and is handled regardless of exitCode. If an API error (e.g. overloaded)
  // interrupted the stream, the payload is fatally malformed.
  if (inputs.apiError) {
    // Drop the noisy '[constitution] missing audit log' if the stream was aborted
    const filteredWarnings = warnings.filter(w => !w.startsWith('[constitution]'));
    filteredWarnings.push(`[api_error] ${inputs.apiError.terminalReason || 'unknown'}`);
    return {
      kind: 'malformed',
      warnings: filteredWarnings,
      auditEntry: inputs.auditEntry
    };
  }

  // Feature 013 — FR-013/T040 (Wave 3): a non-zero CLI exit that survived
  // the fatal-signature and rate-limit gates above maps to `transient_error`
  // UNLESS the model produced a clean termination token. The CLI can exit
  // non-zero due to internal execution errors (e.g., `error_during_execution`
  // subtype) while the model successfully completed its task. When a clean
  // token is present, we fall through to the contract-block parsing below
  // so the successful result is preserved.
  //
  // Precedence: fatal > rate_limited > api_error > exit-code floor (without clean token)
  //             > contract blocks > remaining-issues default.
  //
  // Feature 107 — the token this floor consults is now region-scoped, so an
  // injected string can no longer buy a fall-through past a non-zero exit.
  // Detection happens once, before the floor, because it accumulates warnings
  // and a second call would double them.
  const tokenMatched = detectTermination(inputs.stdout, inputs.region, warnings);
  if (inputs.exitCode !== null && inputs.exitCode !== 0) {
    if (!tokenMatched) {
      return {
        kind: 'transient_error',
        exitCode: inputs.exitCode,
        auditEntry: inputs.auditEntry,
        warnings
      };
    }
    // Clean termination token found — fall through to contract-block
    // parsing. The model completed successfully despite the non-zero exit.
  }

  const remainingIssues = extractRemainingIssues(inputs.stdout);
  const openQuestions = extractOpenQuestions(inputs.stdout);
  const blocksPresent =
    Number(tokenMatched) + Number(remainingIssues.length > 0) + Number(openQuestions.length > 0);

  // Feature 107 (FR-030) — every return below carries `warnings`. Each of the
  // three `warnings.push` calls in this tail predates the feature and, until
  // the variants gained the field, wrote to an array nobody read.
  if (blocksPresent === 0) {
    if (!inputs.auditEntry) {
      warnings.push('[constitution] missing audit log');
    }
    return {
      kind: 'remaining_issues',
      issues: [{ tag: 'constitution', summary: 'no contract block detected' }],
      auditEntry: inputs.auditEntry,
      warnings
    };
  }

  if (blocksPresent > 1) {
    warnings.push('[constitution] multiple contract blocks');
    if (tokenMatched) {
      return { kind: 'clean', auditEntry: inputs.auditEntry, warnings };
    }
    if (remainingIssues.length > 0) {
      return {
        kind: 'remaining_issues',
        issues: remainingIssues,
        auditEntry: inputs.auditEntry,
        warnings
      };
    }
    return {
      kind: 'open_questions',
      questions: openQuestions,
      auditEntry: inputs.auditEntry,
      warnings
    };
  }

  if (tokenMatched) {
    if (!inputs.auditEntry) {
      warnings.push('[constitution] missing audit log on clean response');
      return { kind: 'clean', auditEntry: null, warnings };
    }
    return { kind: 'clean', auditEntry: inputs.auditEntry, warnings };
  }
  if (openQuestions.length > 0) {
    return {
      kind: 'open_questions',
      questions: openQuestions,
      auditEntry: inputs.auditEntry,
      warnings
    };
  }
  return {
    kind: 'remaining_issues',
    issues: remainingIssues,
    auditEntry: inputs.auditEntry,
    warnings
  };
}
