import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';

export const RATE_LIMIT_MATCHERS: ReadonlyArray<{ regex: RegExp; cause: string }> = Object.freeze([
  { regex: /(?:rate.?limit|too\s+many\s+requests|429)/i, cause: 'rate-limit' },
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

// Feature 066 — stdout substrings (case-sensitive, as emitted by the
// upstream CLI). Within a single line `out_of_credits` wins over the
// generic `rate_limit_event` envelope (FR-006) — the more-specific
// hard-cap signal must route through the past-timestamp safety guard
// in `backoffForCause`. Across multiple lines the detector settles on
// the MOST RECENT signal-bearing line (spec edge case: "Multiple
// rate-limit lines").
const STDOUT_OUT_OF_CREDITS_SIGIL = 'out_of_credits';
const STDOUT_RATE_LIMIT_EVENT_SIGIL = 'rate_limit_event';

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
  // Walk lines from the end backwards. The FIRST line we encounter
  // (i.e., the MOST RECENT line) that carries a rate-limit signal
  // determines the cause. Within that line, `out_of_credits` wins over
  // the generic `rate_limit_event` envelope (FR-006).
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
  if (line.length === 0) return null;
  const hasRateLimitEvent = line.includes(STDOUT_RATE_LIMIT_EVENT_SIGIL);
  const hasOutOfCredits = line.includes(STDOUT_OUT_OF_CREDITS_SIGIL);
  if (hasOutOfCredits) return 'out-of-credits';
  if (hasRateLimitEvent) {
    // Feature 027 BUG-008 — soft-warn `rate_limit_event` payloads must not
    // be classified as hard rate limits during a trailing-window scan on an
    // aborted/interrupted run.
    if (line.includes('"status":"allowed_warning"') || line.includes('"status": "allowed_warning"')) {
      return null;
    }
    if (line.includes('"status":"allow"') || line.includes('"status": "allow"')) {
      return null;
    }
    return 'rate-limit';
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
  for (const { regex, cause } of RATE_LIMIT_MATCHERS) {
    if (regex.test(stderrStr)) {
      return { matched: true, cause };
    }
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

export function detectStatusOk(stdout: ZippedStreamBuffer | string): boolean {
  const chunks = typeof stdout === 'string' ? [stdout] : stdout.decompressStream();
  for (const chunk of chunks) {
    if (/credit.{0,30}(available|ok|restored)/i.test(chunk)) return true;
    if (/status.{0,30}(ok|healthy|ready)/i.test(chunk)) return true;
    if (/\bquota.{0,20}(available|reset)/i.test(chunk)) return true;
  }
  return false;
}
