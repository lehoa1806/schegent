import type { AuditEntryFields } from '../audit/audit-entry';
import {
  classifyFatal,
  type EffectiveSignature,
  type FatalClassification,
  type FatalSource
} from '../lib/fatal-signature-registry';
import { extractRateLimitMessage, extractResetTimestamp } from './rate-limit-reset-extractor';

export type InvocationResult =
  | { kind: 'clean'; auditEntry: AuditEntryFields | null }
  | { kind: 'open_questions'; questions: string[]; auditEntry: AuditEntryFields | null }
  | {
      kind: 'remaining_issues';
      issues: Array<{ tag?: string; summary: string }>;
      auditEntry: AuditEntryFields | null;
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
  | { kind: 'transient_error'; exitCode: number; auditEntry: AuditEntryFields | null }
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
  if (inputs.exitCode !== null && inputs.exitCode !== 0) {
    if (!detectTerminationToken(inputs.stdout)) {
      return {
        kind: 'transient_error',
        exitCode: inputs.exitCode,
        auditEntry: inputs.auditEntry
      };
    }
    // Clean termination token found — fall through to contract-block
    // parsing. The model completed successfully despite the non-zero exit.
  }

  const tokenMatched = detectTerminationToken(inputs.stdout);
  const remainingIssues = extractRemainingIssues(inputs.stdout);
  const openQuestions = extractOpenQuestions(inputs.stdout);
  const blocksPresent =
    Number(tokenMatched) + Number(remainingIssues.length > 0) + Number(openQuestions.length > 0);

  if (blocksPresent === 0) {
    if (!inputs.auditEntry) {
      warnings.push('[constitution] missing audit log');
    }
    return {
      kind: 'remaining_issues',
      issues: [{ tag: 'constitution', summary: 'no contract block detected' }],
      auditEntry: inputs.auditEntry
    };
  }

  if (blocksPresent > 1) {
    warnings.push('[constitution] multiple contract blocks');
    if (tokenMatched) {
      return inputs.auditEntry
        ? { kind: 'clean', auditEntry: inputs.auditEntry }
        : { kind: 'clean', auditEntry: null };
    }
    if (remainingIssues.length > 0) {
      return { kind: 'remaining_issues', issues: remainingIssues, auditEntry: inputs.auditEntry };
    }
    return { kind: 'open_questions', questions: openQuestions, auditEntry: inputs.auditEntry };
  }

  if (tokenMatched) {
    if (!inputs.auditEntry) {
      warnings.push('[constitution] missing audit log on clean response');
      return { kind: 'clean', auditEntry: null };
    }
    return { kind: 'clean', auditEntry: inputs.auditEntry };
  }
  if (openQuestions.length > 0) {
    return { kind: 'open_questions', questions: openQuestions, auditEntry: inputs.auditEntry };
  }
  return { kind: 'remaining_issues', issues: remainingIssues, auditEntry: inputs.auditEntry };
}
