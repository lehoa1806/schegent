import type { AuditEntryFields } from '../audit/audit-entry';
import { containsTerminationToken } from '../contracts/phase-output-contract';
import type { EvidencePolicyOrigin, PhaseEvidencePolicy } from '../contracts/process-definitions';
import {
  classifyFatal,
  type EffectiveSignature,
  type FatalClassification,
  type FatalSource
} from '../lib/fatal-signature-registry';
import type { RawInvocationOutput } from '../runner/invocation-result';
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
      issues: Array<{ tag?: string; summary: string; source?: 'host' }>;
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
  // FR-R3-198 — the turn ended unfinished, decided from the runner's turn-end
  // facts (`ParseInputs.turnEnd`) and never from the exit status. `warnings`
  // always carries `incomplete-turn:<cause>`.
  | {
      kind: 'incomplete_turn';
      cause: IncompleteTurnCause;
      auditEntry: AuditEntryFields | null;
      warnings: string[];
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

/**
 * FR-R3-198 — why a turn counts as unfinished. `background-work-open` names it
 * whenever that fact holds, even on a turn that also settled: the open work is
 * what the resume has to finish.
 */
export type IncompleteTurnCause = 'background-work-open' | 'no-contract-block';

const OPEN_HEADING_REGEX = /^\s*(Open|Remaining)\s+(questions|clarifications):\s*$/i;
const ISSUES_HEADING_REGEX =
  /^\s*(Remaining issues|Failed with \d+ errors?|Failing with \d+ issues?):?\s*$/i;
const BULLET_REGEX = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const TAGGED_BULLET_REGEX =
  /^\s*(?:[-*]|\d+\.)\s+(?:\[([a-z][a-z0-9-]*)\]\s+)?(.+?)\s*$/;

export function detectTerminationToken(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (containsTerminationToken(line)) {
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
    if (containsTerminationToken(line)) {
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
    if (containsTerminationToken(lines[i])) {
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
  region: TrailingRegion,
  warnings: string[]
): boolean {
  if (!region.present) {
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

export function extractRemainingIssues(
  stdout: string
): Array<{ tag?: string; summary: string; source?: 'host' }> {
  const lines = stdout.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => ISSUES_HEADING_REGEX.test(line));
  if (headingIndex === -1) return [];
  const items: Array<{ tag?: string; summary: string; source?: 'host' }> = [];
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

/**
 * Record a missing audit block at the volume the Phase asked for.
 *
 * `'required'` is the default and today's behaviour, unchanged: the absence is a
 * constitution violation and is warned about. `'best-effort'` records it as an
 * expectation that was not met rather than a rule that was broken. `'none'`
 * declares that this Phase produces no audit block, so its absence is not news
 * and no warning is written.
 *
 * Every branch still ADVANCES exactly as before. This chooses what is said about
 * the absence, not what follows from it — see `ParseInputs.evidencePolicy` for
 * why the field cannot tighten.
 */
/**
 * FR-R3-096 — does this Phase's declared evidence policy WITHHOLD a clean
 * advance when the backend produced no audit block?
 *
 * Only when an author asked for it. `'required'` alone is not enough and never
 * can be: `pipeline-snapshot.ts` wrote that value into every Phase that declared
 * nothing, so the stored value describes the whole population rather than a
 * decision. The origin is what separates them, and **absence reads as
 * defaulted** — which is every snapshot taken before the origin existed, and
 * every caller that has not been updated to pass one.
 *
 * `'best-effort'` and `'none'` withhold nothing however they were declared:
 * relaxing was always available, and this item added only the tightening half.
 */
/**
 * The refusal itself, in the vocabulary the parser already uses for a
 * constitution violation.
 *
 * `remaining_issues` rather than a failure: `mapOutcome` turns it into
 * `issues_remain`, which gives the Phase its next iteration to produce the block
 * and fails only at the cap. The no-contract-block path a few lines below has
 * classified a missing audit block this way since before the field existed, so
 * an authored `required` reaches the same place by the same route rather than
 * inventing a second terminal shape for one setting.
 */
function withheldForMissingEvidence(warnings: string[]): InvocationResult {
  return {
    kind: 'remaining_issues',
    issues: [
      {
        tag: 'constitution',
        summary: 'this Phase declares evidencePolicy required and produced no audit block',
        source: 'host'
      }
    ],
    auditEntry: null,
    warnings
  };
}

function withholdsCleanAdvance(inputs: ParseInputs): boolean {
  return (
    (inputs.evidencePolicy ?? 'required') === 'required' &&
    inputs.evidencePolicyDeclaredAt === 'phase-definition'
  );
}

/**
 * One missing-audit warning, at the volume the Phase asked for, or `null` to drop
 * it. Warnings about anything else pass through untouched.
 */
function relabelMissingAuditWarning(
  warning: string,
  policy: PhaseEvidencePolicy | undefined
): string | null {
  const relaxed = RELAXED_MISSING_AUDIT.get(warning);
  if (relaxed === undefined) return warning;
  const effective = policy ?? 'required';
  if (effective === 'none') return null;
  return effective === 'best-effort' ? relaxed : warning;
}

/**
 * The `best-effort` spelling of each `required` missing-audit warning.
 *
 * A `Map` rather than an object literal because the lookup is genuinely partial —
 * most warnings passing through here are about something else entirely — and
 * `Record<string, string>` would have TypeScript believe every key hits. Not a
 * style preference: it made the `undefined` check below read as dead code, which
 * `no-unnecessary-condition` correctly flagged. `.get()` returns
 * `string | undefined`, so the check is load-bearing and now says so.
 */
const RELAXED_MISSING_AUDIT: ReadonlyMap<string, string> = new Map([
  ['[constitution] missing audit log', '[evidence] audit log absent, best-effort'],
  [
    '[constitution] missing audit log on clean response',
    '[evidence] audit log absent on clean response, best-effort'
  ]
]);

function pushMissingAuditWarning(
  warnings: string[],
  policy: PhaseEvidencePolicy | undefined,
  requiredText: '[constitution] missing audit log' | '[constitution] missing audit log on clean response'
): void {
  const relabelled = relabelMissingAuditWarning(requiredText, policy);
  if (relabelled !== null && !warnings.includes(relabelled)) warnings.push(relabelled);
}

export interface ParseInputs {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  rateLimit: { matched: boolean; cause: string };
  auditEntry: AuditEntryFields | null;
  auditWarnings: string[];
  /**
   * FR-R3-086 follow-up (S12) — the Phase's declared evidence policy.
   *
   * It governs how the ABSENCE of an audit block is REPORTED, and — since
   * FR-R3-096 — whether that absence also WITHHOLDS a clean advance. The second
   * half applies only when `evidencePolicyDeclaredAt` says an author asked for
   * it; see that field for why the value alone cannot decide.
   *
   * Optional, defaulting to `'required'`, so every existing caller and every
   * persisted snapshot behaves exactly as before.
   */
  evidencePolicy?: PhaseEvidencePolicy | undefined;
  /**
   * FR-R3-096 — whether `evidencePolicy` was authored or defaulted.
   *
   * Enforcement reads this and not the value. `'phase-definition'` is the only
   * setting that withholds advancement; `'default'` and **absence** behave
   * exactly as the field did before enforcement existed, which is what makes
   * every already-persisted snapshot and every un-updated caller safe without a
   * version comparison.
   */
  evidencePolicyDeclaredAt?: EvidencePolicyOrigin | undefined;
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
   * With no complete marker pair it is `NO_REGION`, and the parser falls back
   * to the whole-stdout scan. That path is labeled at the point of acceptance
   * (FR-009) so a degraded read is never mistaken for a bounded one.
   *
   * FR-R3-199 — required. While it was optional, the evals corpus omitted it,
   * and every clean case passed on a token printed where the host never reads
   * one.
   */
  region: TrailingRegion;
  /**
   * FR-R3-198 — the runner's turn-end facts. The phase runner passes `raw`, and
   * the eval harness a case's literal.
   *
   * Optional: absent, the invocation is classified exactly as before.
   */
  turnEnd?: Pick<
    RawInvocationOutput,
    'completedAwaitingExit' | 'backgroundWorkOpenAtResult' | 'killed'
  >;
}

/**
 * FR-R3-198 — the cause an unfinished turn would carry, or null when the facts
 * allow none: they are absent, neither is set, or the invocation was killed. An
 * operator cancel can end with `killed` set and a non-null exit code, and must
 * not be resumed.
 */
function incompleteTurnCause(turnEnd: ParseInputs['turnEnd']): IncompleteTurnCause | null {
  if (turnEnd === undefined || turnEnd.killed === true) return null;
  if (turnEnd.backgroundWorkOpenAtResult === true) return 'background-work-open';
  if (turnEnd.completedAwaitingExit === true) return 'no-contract-block';
  return null;
}

/**
 * FR-R3-198 — whether the turn settled: the CLI's result was the last thing
 * seen, and the host ended a process that had not exited (D6). A killed
 * invocation never settled.
 */
function turnSettled(turnEnd: ParseInputs['turnEnd']): boolean {
  if (turnEnd === undefined || turnEnd.killed === true) return false;
  return turnEnd.completedAwaitingExit === true;
}

export function parseInvocation(inputs: ParseInputs): InvocationResult {
  // S12 — the policy is applied at the MERGE, not at one push site. The
  // "missing audit log" warning has two independent producers: this module and
  // `audit-log-parser.ts`, which reaches here through `inputs.auditWarnings`. A
  // policy that gated only the local push would leave `'none'` still warning,
  // which is what the first run of the S12 tests found.
  const warnings = inputs.auditWarnings.map((warning) =>
    relabelMissingAuditWarning(warning, inputs.evidencePolicy)
  ).filter((warning): warning is string => warning !== null);

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
  //
  // FR-R4-F02 (contract L3 G8, G9) — and not on a settled turn whose CLI result was not an error. A
  // settled turn is one whose result was the last thing seen and which the host ended with its own
  // SIGTERM, so its exit status says nothing about the turn; with no `apiError` the CLI's own result
  // came last and was not a failure, and rate-limit evidence somewhere in the capture does not
  // override it. That turn is decided by the later branches, as at exit 0. A genuine failure keeps
  // this branch: an unsettled or killed turn, or a result with `is_error`. `apiError` is read as
  // `=== null`, the unwrapper's "no error" answer, so a caller that passes no `apiError` at all
  // (absent, like an absent `turnEnd`) is classified exactly as before. Lifecycle facts decide;
  // the clean token and the contract blocks are not inputs here. The fatal-signature branch above
  // keeps first place, and `turnSettled` is read, not edited (FR-R4-F12 owns it).
  if (
    inputs.rateLimit.matched &&
    inputs.exitCode !== 0 &&
    !(turnSettled(inputs.turnEnd) && inputs.apiError === null)
  ) {
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
  // Precedence: fatal > rate_limited > api_error > incomplete_turn
  //             > exit-code floor (without clean token)
  //             > contract blocks > remaining-issues default.
  //
  // Feature 107 — the token this floor consults is now region-scoped, so an
  // injected string can no longer buy a fall-through past a non-zero exit.
  // Detection happens once, before the floor, because it accumulates warnings
  // and a second call would double them.
  const tokenMatched = detectTermination(inputs.stdout, inputs.region, warnings);
  // FR-R3-198 — the two extractors are pure, so they run here, ahead of the
  // incomplete-turn arm, which needs to know whether any block is present.
  const remainingIssues = extractRemainingIssues(inputs.stdout);
  const openQuestions = extractOpenQuestions(inputs.stdout);
  const blocksPresent =
    Number(tokenMatched) + Number(remainingIssues.length > 0) + Number(openQuestions.length > 0);

  // FR-R3-198 — a turn that left work open in the background, or settled, and
  // printed no contract block is unfinished (data-model §5). The facts decide,
  // never the exit status: a settled turn's exit is the host's own SIGTERM.
  const unfinishedCause = incompleteTurnCause(inputs.turnEnd);
  if (unfinishedCause !== null && blocksPresent === 0) {
    warnings.push(`incomplete-turn:${unfinishedCause}`);
    return {
      kind: 'incomplete_turn',
      cause: unfinishedCause,
      auditEntry: inputs.auditEntry,
      warnings
    };
  }

  // FR-R3-198 (D6) — on a settled turn the block decides, as it would at exit
  // 0, so the floor is skipped. Open work alone does not skip it.
  const blockDecides = turnSettled(inputs.turnEnd) && blocksPresent > 0;
  if (inputs.exitCode !== null && inputs.exitCode !== 0 && !blockDecides) {
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

  // Feature 107 (FR-030) — every return below carries `warnings`. Each of the
  // three `warnings.push` calls in this tail predates the feature and, until
  // the variants gained the field, wrote to an array nobody read.
  if (blocksPresent === 0) {
    if (!inputs.auditEntry) {
      pushMissingAuditWarning(warnings, inputs.evidencePolicy, '[constitution] missing audit log');
    }
    return {
      kind: 'remaining_issues',
      issues: [{ tag: 'constitution', summary: 'no contract block detected', source: 'host' }],
      auditEntry: inputs.auditEntry,
      warnings
    };
  }

  if (blocksPresent > 1) {
    warnings.push('[constitution] multiple contract blocks');
    if (tokenMatched) {
      if (!inputs.auditEntry && withholdsCleanAdvance(inputs)) {
        return withheldForMissingEvidence(warnings);
      }
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
      pushMissingAuditWarning(
        warnings,
        inputs.evidencePolicy,
        '[constitution] missing audit log on clean response'
      );
      // FR-R3-096 — the tightening half. Before this, a Phase that declared
      // `required` and produced no audit block advanced clean anyway, which made
      // all three settings mean the same thing.
      if (withholdsCleanAdvance(inputs)) return withheldForMissingEvidence(warnings);
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
