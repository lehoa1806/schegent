import { isDiagnosticLine } from '../lib/fatal-signature-registry';
import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';

/**
 * FR-R4-F02 (contract L2 G6) — the first matcher's bare `429` alternative is replaced by qualified
 * forms, so `took 429 ms` and `request id 4290` no longer count. The 429 is accepted on an HTTP
 * status line (`HTTP/1.1 429`), after `status` or `code` (`status: 429`, `code=429`), and beside
 * `too many requests` or `rate limit`, where the retained `rate.?limit` and `too\s+many\s+requests`
 * alternatives already match the line. The named forms (`rate_limit_error`, `rate limit exceeded`,
 * `rate limited`, `rate limit reached`, `too many requests`) are subsumed by those two retained
 * alternatives, which is what keeps every pinned stderr outcome (FR-013).
 */
export const RATE_LIMIT_MATCHERS: ReadonlyArray<{ regex: RegExp; cause: string }> = Object.freeze([
  {
    regex: /(?:rate.?limit|too\s+many\s+requests|HTTP\/\d(?:\.\d)?\s+429\b|\b(?:status|code)[:= ]+429\b)/i,
    cause: 'rate-limit'
  },
  // Feature 027 FR-014 — operator-visible "You're out of extra usage"
  // (and the "extra"-omitted variant) routes through the rate-limit
  // path so it picks up the dynamic backoff instead of the 15-minute
  // transient-error path. Anchored on "out of (extra )?usage" so
  // unrelated "out of bandwidth/space/etc." strings do NOT match.
  { regex: /out of (?:extra )?usage/i, cause: 'out-of-usage' },
  { regex: /credits?.{0,20}(exhausted|insufficient|depleted)/i, cause: 'credits-exhausted' },
  { regex: /quota.{0,20}exceeded/i, cause: 'quota-exceeded' },
  // BUG-009 — the CLI emits "You've hit your session limit · resets
  // <time> (<tz>)" on stderr when the five-hour session quota is
  // exhausted. Without this matcher the error is misclassified as
  // `transient_error` and the dynamic-backoff reset time is never
  // extracted.
  { regex: /session.?limit/i, cause: 'session-limit' }
]);

export interface CreditDetectionResult {
  matched: boolean;
  cause: string;
  // Feature 027 — optional parsed reset epoch (ms). `detectCreditError`
  // itself does NOT populate this field (it has access to `stderr`
  // only); callers populate it from `extractResetTimestamp(stdout)` per
  // FR-006.
  resetsAtMs?: number | null;
}

// Feature 066 — trailing-window size for the stdout scan. Sized to
// comfortably contain a stream-json `rate_limit_event` payload (~3
// lines) plus surrounding context. The window cap keeps detection cost
// bounded for long sessions (SC-005).
const STDOUT_TRAILING_WINDOW_LINES = 20;

/**
 * FR-R4-F02 (contract L1 G1) — the longest line the stdout scan will parse as a record. A genuine
 * `rate_limit_event` is a few hundred bytes; a line past this is a transcript payload, not the CLI
 * reporting anything, and is not read.
 */
export const RATE_LIMIT_RECORD_MAX_CHARS = 65_536;

const RATE_LIMIT_EVENT_TYPE = 'rate_limit_event';
const REJECTED_STATUS = 'rejected';
const OUT_OF_CREDITS_VALUE = 'out_of_credits';

export interface RateLimitRecord {
  readonly blocking: true;
  readonly cause: 'out-of-credits' | 'rate-limit';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * FR-R4-F02 (contract L1 G1 to G3) — read one stdout line as a genuine blocking record, or as
 * nothing. A line counts only when it is at most `RATE_LIMIT_RECORD_MAX_CHARS`, opens `{` after
 * trimming, parses as a JSON object whose OWN `type` is `rate_limit_event`, and carries
 * `rate_limit_info.status === 'rejected'`. Anything else is not a record: a name quoted inside a
 * tool payload, an event nested under another key, an `allowed` or `allowed_warning` or `allow` or
 * absent or unknown status, in any JSON spacing.
 *
 * The cause is `out-of-credits` when an own string-valued property of `rate_limit_info` equals
 * `out_of_credits`, as a field and never as a substring; nested payloads are not inspected.
 *
 * The `includes` test only skips the parse of lines that cannot be a record, which is most of the
 * trailing window; it decides nothing, because a record must contain the type literal.
 */
export function readRateLimitRecord(line: string): RateLimitRecord | null {
  if (line.length === 0 || line.length > RATE_LIMIT_RECORD_MAX_CHARS) return null;
  if (!line.includes(RATE_LIMIT_EVENT_TYPE)) return null;
  const text = line.trim();
  if (text.charCodeAt(0) !== 0x7b) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !hasOwn(parsed, 'type') || parsed.type !== RATE_LIMIT_EVENT_TYPE) {
    return null;
  }
  const info = hasOwn(parsed, 'rate_limit_info') ? parsed.rate_limit_info : undefined;
  if (!isPlainObject(info) || !hasOwn(info, 'status') || info.status !== REJECTED_STATUS) return null;
  const namesOutOfCredits = Object.keys(info).some(
    (key) => hasOwn(info, key) && info[key] === OUT_OF_CREDITS_VALUE
  );
  return { blocking: true, cause: namesOutOfCredits ? 'out-of-credits' : 'rate-limit' };
}

function trailingWindow(buffer: string, lineBudget: number): string {
  if (buffer.length === 0) return buffer;
  let newlines = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer.charCodeAt(i) === 0x0a) {
      newlines++;
      if (newlines >= lineBudget) {
        return buffer.slice(i + 1);
      }
    }
  }
  return buffer;
}

function scanWindowForRateLimit(window: string): string | null {
  // Walk lines from the end backwards. The FIRST (MOST RECENT) line that
  // carries a rate-limit signal determines the cause. Within that line,
  // `out_of_credits` wins over the generic `rate_limit_event` envelope
  // (FR-006), unless the line's status lets the request through (FR-R3-197 D2).
  let lineEnd = window.length;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window.charCodeAt(i) === 0x0a) {
      const line = window.slice(i + 1, lineEnd);
      const cause = matchLine(line);
      if (cause !== null) return cause;
      lineEnd = i;
    }
  }
  // Handle the head of the window (no leading newline).
  if (lineEnd > 0) {
    const cause = matchLine(window.slice(0, lineEnd));
    if (cause !== null) return cause;
  }
  return null;
}

function matchLine(line: string): string | null {
  // Feature 027 BUG-008 and FR-R3-197 are now structural rather than spelled out: only a `rejected`
  // status is a block, so `allowed`, `allowed_warning`, `allow` and anything else never reach here,
  // and an allowed event that names `out_of_credits` as its overage reason is not out-of-credits
  // (D2) because the cause is read only from a blocking record.
  return readRateLimitRecord(line)?.cause ?? null;
}

/**
 * FR-R4-F02 (contract L2 G5) — the first matcher, in order, that matches ANY diagnostic line of
 * `text`. Each matcher is tested per line and only on lines `isDiagnosticLine()` accepts, the
 * oracle hard rule 17 names: a line opening `{` or `[` is a structured envelope and a line past the
 * diagnostic length is not one, so text the CLI is merely transporting cannot match. Matcher order
 * still decides which cause wins, as it did when the whole text was tested once per matcher.
 */
function matchStderr(text: string): string | null {
  const diagnosticLines = text.split('\n').filter(isDiagnosticLine);
  if (diagnosticLines.length === 0) return null;
  for (const { regex, cause } of RATE_LIMIT_MATCHERS) {
    if (diagnosticLines.some((line) => regex.test(line))) return cause;
  }
  return null;
}

export function detectCreditError(
  stdout: ZippedStreamBuffer | string,
  stderr: ZippedStreamBuffer | string,
  exitCode: number | null
): CreditDetectionResult {
  // BUG-008 — a successful CLI completion (exit 0) is never a rate-limit
  // failure regardless of stderr/stdout content. The CLI exits 0 even
  // when carrying a soft-warn `rate_limit_event` payload at ~90% quota
  // (`rate_limit_info.status === 'allowed_warning'`); without this gate
  // the stderr regex below would match the courtesy warning phrase and
  // hijack the successful run into a multi-hour delayed-retry backoff.
  // The existing `exitCode === 429` MATCH path below is unaffected — 429
  // is by definition non-zero.
  if (exitCode === 0) {
    return { matched: false, cause: '' };
  }
  // Stderr precedence (FR-007) — existing behavior preserved
  // byte-for-byte. Any stderr match short-circuits before stdout is
  // consulted, so the existing fixture matrix routes identically.
  const stderrStr = typeof stderr === 'string' ? stderr : stderr.getTrailingLines(50);
  const stderrCause = matchStderr(stderrStr);
  if (stderrCause !== null) {
    return { matched: true, cause: stderrCause };
  }
  if (exitCode === 429) {
    return { matched: true, cause: 'rate-limit' };
  }
  // Feature 066 — stdout trailing-window scan (FR-002..FR-006). Stream-
  // json mode emits `rate_limit_event` (and the embedded
  // `out_of_credits` overage reason) to stdout; the stderr scan above
  // misses it. The scan reads the trailing window line-by-line from
  // the END backwards, so the most recent CLI emission determines the
  // cause (spec edge case: "Multiple rate-limit lines").
  const stdoutStr = typeof stdout === 'string' ? stdout : stdout.getTrailingLines(STDOUT_TRAILING_WINDOW_LINES);
  if (stdoutStr.length > 0) {
    const window = trailingWindow(stdoutStr, STDOUT_TRAILING_WINDOW_LINES);
    const cause = scanWindowForRateLimit(window);
    if (cause !== null) {
      return { matched: true, cause };
    }
  }
  return { matched: false, cause: '' };
}
