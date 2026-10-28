// FR-R4-F02 (spec 240, T030; contract L2 G7; standing rule 6) — the pinning matrix.
//
// Every input the existing rate-limit tests and fixtures feed the classifier, with the outcome the
// code at `5d700407` gave it: whether `detectCreditError` matched, the cause it named, and the
// status `parseInvocation` returned for it. The matrix is written and run at HEAD BEFORE the
// classifier changes (US5 T035, T036), and after them every row has to read the same: a row that
// would change is a finding to report, never a row to edit.
//
// Nine rows were reported that way and the maintainer decided on 2026-10-28 (decision (b), T037c) to
// edit them: FR-012 stops matching a stdout event that carries no `rejected` status and a bare
// substring, which contract L2 G7 had not allowed for. Each is marked `// FR-012` below. Six
// (d16, d17, d22, d23, o01, o02) gain `"status":"rejected"`, so they pin that a genuine record keeps
// its HEAD outcome (SC-007); three (d18, d20, d31) held a bare substring and now pin no match. Every
// other row reads as it did at HEAD.
//
// Sources: every literal input of `credit-error-detector.test.ts` (ids `d..`), every file in
// `tests/fixtures/rate-limit/` as stdout and, for the two text fixtures, as stderr (`f-..`), and
// the inputs the `stdout-parser-rate-limited` and `stdout-parser-out-of-credits` suites build
// (`p..`, `o..`). The raw stdout feeds the detector, the unwrapped text feeds the parser, as
// `phase-runner.ts` composes them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_REGION } from '../../../src/parser/audit-log-parser';
import { detectCreditError } from '../../../src/parser/credit-error-detector';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import { unwrapStreamJson } from '../../../src/parser/stream-json-unwrapper';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures/rate-limit', name), 'utf8').trim();
}

const observed = fixture('rate-limit-allowed-observed.txt');

interface MatrixCase {
  readonly id: string;
  readonly source: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** The outcome at `5d700407`, except in the nine rows marked `// FR-012`. */
  readonly matched: boolean;
  readonly cause: string;
  readonly status: string;
}

const CASES: readonly MatrixCase[] = [
  { id: "d01-stderr-rate-limit-exceeded", source: "credit-error-detector.test.ts", stdout: "", stderr: "error: rate limit exceeded", exitCode: null, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d02-stderr-429-too-many-requests", source: "credit-error-detector.test.ts", stdout: "", stderr: "429 Too Many Requests", exitCode: null, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d03-exit-429-no-stderr-match", source: "credit-error-detector.test.ts", stdout: "", stderr: "Connection error", exitCode: 429, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d04-credits-exhausted", source: "credit-error-detector.test.ts", stdout: "", stderr: "credits exhausted, please top up", exitCode: null, matched: true, cause: "credits-exhausted", status: "rate_limited" },
  { id: "d05-quota-exceeded", source: "credit-error-detector.test.ts", stdout: "", stderr: "your monthly quota exceeded for tokens", exitCode: null, matched: true, cause: "quota-exceeded", status: "rate_limited" },
  { id: "d06-uppercase-rate-limit", source: "credit-error-detector.test.ts", stdout: "", stderr: "RATE LIMIT EXCEEDED", exitCode: null, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d07-unrelated-stderr", source: "credit-error-detector.test.ts", stdout: "", stderr: "TypeError: cannot read property of undefined", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d08-empty-exit-0", source: "credit-error-detector.test.ts", stdout: "", stderr: "", exitCode: 0, matched: false, cause: "", status: "remaining_issues" },
  { id: "d09-out-of-extra-usage", source: "credit-error-detector.test.ts", stdout: "", stderr: "You're out of extra usage", exitCode: 1, matched: true, cause: "out-of-usage", status: "rate_limited" },
  { id: "d10-out-of-usage", source: "credit-error-detector.test.ts", stdout: "", stderr: "You're out of usage", exitCode: 1, matched: true, cause: "out-of-usage", status: "rate_limited" },
  { id: "d11-out-of-bandwidth", source: "credit-error-detector.test.ts", stdout: "", stderr: "You're out of bandwidth", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d12-uppercase-out-of-extra-usage", source: "credit-error-detector.test.ts", stdout: "", stderr: "YOU ARE OUT OF EXTRA USAGE", exitCode: 1, matched: true, cause: "out-of-usage", status: "rate_limited" },
  { id: "d13-session-limit-resets", source: "credit-error-detector.test.ts", stdout: "", stderr: "You've hit your session limit · resets 6:50am (Asia/Saigon)", exitCode: 1, matched: true, cause: "session-limit", status: "rate_limited" },
  { id: "d14-session-limit-uppercase", source: "credit-error-detector.test.ts", stdout: "", stderr: "SESSION LIMIT exceeded", exitCode: 1, matched: true, cause: "session-limit", status: "rate_limited" },
  { id: "d15-session-limit-exit-0", source: "credit-error-detector.test.ts", stdout: "", stderr: "You've hit your session limit · resets 6:50am (Asia/Saigon)", exitCode: 0, matched: false, cause: "", status: "remaining_issues" },
  { id: "d16-row7-generic-event-substring", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"subtype\":\"unified\",\"rate_limit_info\":{\"status\":\"rejected\"}}", stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" }, // FR-012: status added
  { id: "d17-row8-event-with-out-of-credits", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"overageDisabledReason\":\"out_of_credits\"}}", stderr: "", exitCode: 1, matched: true, cause: "out-of-credits", status: "rate_limited" }, // FR-012: status added
  { id: "d18-row9-bare-out-of-credits", source: "credit-error-detector.test.ts", stdout: "...out_of_credits...", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" }, // FR-012: bare substring, no match
  { id: "d19-row10-stderr-wins-over-stdout", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"overageDisabledReason\":\"out_of_credits\"}}", stderr: "rate limit exceeded", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d20-row11-signal-inside-window", source: "credit-error-detector.test.ts", stdout: 'a\n'.repeat(100) + 'rate_limit_event', stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" }, // FR-012: bare substring, no match
  { id: "d21-row12-signal-outside-window", source: "credit-error-detector.test.ts", stdout: 'rate_limit_event' + '\nx'.repeat(100), stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d22-most-recent-line-plain-event", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"overageDisabledReason\":\"out_of_credits\"}}\n{\"type\":\"assistant\",\"message\":{}}\n{\"type\":\"rate_limit_event\",\"subtype\":\"unified\",\"rate_limit_info\":{\"status\":\"rejected\"}}", stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" }, // FR-012: status added
  { id: "d23-newer-out-of-credits-wins", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"subtype\":\"unified\",\"rate_limit_info\":{\"status\":\"rejected\"}}\n{\"type\":\"assistant\",\"message\":{}}\n{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"overageDisabledReason\":\"out_of_credits\"}}", stderr: "", exitCode: 1, matched: true, cause: "out-of-credits", status: "rate_limited" }, // FR-012: status added
  { id: "d24-harmless-stdout-exit-1", source: "credit-error-detector.test.ts", stdout: "plain harmless output\n", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d25-uppercase-out-of-credits", source: "credit-error-detector.test.ts", stdout: "OUT_OF_CREDITS", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d26-stderr-courtesy-phrase-exit-0", source: "credit-error-detector.test.ts", stdout: "", stderr: "rate limit warning approaching cap", exitCode: 0, matched: false, cause: "", status: "remaining_issues" },
  { id: "d27-allowed-warning-exit-0", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"resetsAt\":1779520200}}", stderr: "", exitCode: 0, matched: false, cause: "", status: "remaining_issues" },
  { id: "d28-rejected-event-exit-1", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"resetsAt\":1779520200}}", stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d29-stderr-bare-rate-limit", source: "credit-error-detector.test.ts", stdout: "", stderr: "rate limit", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d30-exit-429-empty-streams", source: "credit-error-detector.test.ts", stdout: "", stderr: "", exitCode: 429, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d31-small-bare-out-of-credits", source: "credit-error-detector.test.ts", stdout: "out_of_credits", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" }, // FR-012: bare substring, no match
  { id: "d32-observed-allowed-exit-143", source: "credit-error-detector.test.ts", stdout: observed, stderr: "", exitCode: 143, matched: false, cause: "", status: "transient_error" },
  { id: "d33-observed-rejected-exit-143", source: "credit-error-detector.test.ts", stdout: observed.replace('"status":"allowed"', '"status":"rejected"'), stderr: "", exitCode: 143, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d34-allowed-naming-out-of-credits", source: "credit-error-detector.test.ts", stdout: observed.replace('org_level_disabled', 'out_of_credits'), stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d35-allowed-warning-naming-out-of-credits", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"overageDisabledReason\":\"out_of_credits\"}}", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d36-allow-alias-naming-out-of-credits", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\": \"allow\",\"overageDisabledReason\":\"out_of_credits\"}}", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d37-earlier-rejected-under-later-allowed", source: "credit-error-detector.test.ts", stdout: '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1716000000}}\n' + observed, stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d38-allowed-spaced", source: "credit-error-detector.test.ts", stdout: observed.replace('"status":"allowed"', '"status": "allowed"'), stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d39-rejected-with-overage-allowed", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"overageStatus\":\"allowed\"}}", stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "d40-allowed-warning-exit-1", source: "credit-error-detector.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\"}}", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "d41-stderr-phrase-beside-allowed-event", source: "credit-error-detector.test.ts", stdout: observed, stderr: "rate limit exceeded", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-out-of-extra-usage-plain-stdout-exit-1", source: "tests/fixtures/rate-limit", stdout: fixture('out-of-extra-usage-plain.txt'), stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "f-out-of-extra-usage-plain-stdout-exit-143", source: "tests/fixtures/rate-limit", stdout: fixture('out-of-extra-usage-plain.txt'), stderr: "", exitCode: 143, matched: false, cause: "", status: "transient_error" },
  { id: "f-out-of-extra-usage-stream-json-stdout-exit-1", source: "tests/fixtures/rate-limit", stdout: fixture('out-of-extra-usage-stream-json.txt'), stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-out-of-extra-usage-stream-json-stdout-exit-143", source: "tests/fixtures/rate-limit", stdout: fixture('out-of-extra-usage-stream-json.txt'), stderr: "", exitCode: 143, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-rate-limit-allow-status-stdout-exit-1", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-allow-status.txt'), stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-rate-limit-allow-status-stdout-exit-143", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-allow-status.txt'), stderr: "", exitCode: 143, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-rate-limit-allowed-observed-stdout-exit-1", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-allowed-observed.txt'), stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "f-rate-limit-allowed-observed-stdout-exit-143", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-allowed-observed.txt'), stderr: "", exitCode: 143, matched: false, cause: "", status: "transient_error" },
  { id: "f-rate-limit-no-reset-info-stdout-exit-1", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-no-reset-info.txt'), stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "f-rate-limit-no-reset-info-stdout-exit-143", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-no-reset-info.txt'), stderr: "", exitCode: 143, matched: false, cause: "", status: "transient_error" },
  { id: "f-rate-limit-past-epoch-stdout-exit-1", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-past-epoch.txt'), stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-rate-limit-past-epoch-stdout-exit-143", source: "tests/fixtures/rate-limit", stdout: fixture('rate-limit-past-epoch.txt'), stderr: "", exitCode: 143, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "f-out-of-extra-usage-plain-stderr-exit-1", source: "tests/fixtures/rate-limit", stdout: "", stderr: fixture('out-of-extra-usage-plain.txt'), exitCode: 1, matched: true, cause: "out-of-usage", status: "rate_limited" },
  { id: "f-rate-limit-no-reset-info-stderr-exit-1", source: "tests/fixtures/rate-limit", stdout: "", stderr: fixture('rate-limit-no-reset-info.txt'), exitCode: 1, matched: true, cause: "out-of-usage", status: "rate_limited" },
  { id: "p01-reset-epoch-with-stderr-phrase", source: "stdout-parser-rate-limited.test.ts", stdout: `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779520200}}`, stderr: "over rate limit", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "p02-no-reset-info-over-rate-limit", source: "stdout-parser-rate-limited.test.ts", stdout: "no rate-limit info in this output", stderr: "over rate limit", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" },
  { id: "p03-out-of-usage-cause", source: "stdout-parser-rate-limited.test.ts", stdout: "", stderr: "You're out of extra usage", exitCode: 1, matched: true, cause: "out-of-usage", status: "rate_limited" },
  { id: "p04-transient-type-error", source: "stdout-parser-rate-limited.test.ts", stdout: "", stderr: "TypeError", exitCode: 1, matched: false, cause: "", status: "transient_error" },
  { id: "p05-clean-token-exit-0", source: "stdout-parser-rate-limited.test.ts", stdout: "[SCHEGENT_STATUS: CLEAR]", stderr: "", exitCode: 0, matched: false, cause: "", status: "clean" },
  { id: "p06-plain-output-exit-0", source: "stdout-parser-rate-limited.test.ts", stdout: "plain output\n", stderr: "", exitCode: 0, matched: false, cause: "", status: "remaining_issues" },
  { id: "o01-out-of-credits-event", source: "stdout-parser-out-of-credits.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"rejected\",\"overageDisabledReason\":\"out_of_credits\"}}", stderr: "", exitCode: 1, matched: true, cause: "out-of-credits", status: "rate_limited" }, // FR-012: status added
  { id: "o02-generic-event", source: "stdout-parser-out-of-credits.test.ts", stdout: "{\"type\":\"rate_limit_event\",\"subtype\":\"unified\",\"rate_limit_info\":{\"status\":\"rejected\"}}", stderr: "", exitCode: 1, matched: true, cause: "rate-limit", status: "rate_limited" }, // FR-012: status added
  { id: "o03-no-signal-exit-1", source: "stdout-parser-out-of-credits.test.ts", stdout: "", stderr: "", exitCode: 1, matched: false, cause: "", status: "transient_error" },
];

describe('FR-R4-F02 T030 — the rate-limit pinning matrix (outcomes at 5d700407, nine rows amended by FR-012)', () => {
  it('has one row per input, with unique ids', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    // A floor, not a count: an emptied table would pass every row below.
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  for (const c of CASES) {
    it(`${c.id} (${c.source})`, () => {
      const rateLimit = detectCreditError(c.stdout, c.stderr, c.exitCode);
      const unwrapped = unwrapStreamJson(c.stdout);
      const parsed = parseInvocation({
        stdout: unwrapped.text,
        stderr: c.stderr,
        exitCode: c.exitCode,
        rateLimit,
        auditEntry: null,
        auditWarnings: [],
        region: NO_REGION,
        apiError: unwrapped.apiError
      });
      expect({ matched: rateLimit.matched, cause: rateLimit.cause, status: parsed.kind }).toEqual({
        matched: c.matched,
        cause: c.cause,
        status: c.status
      });
    });
  }
});
