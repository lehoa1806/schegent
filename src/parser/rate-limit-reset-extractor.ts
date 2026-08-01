/**
 * Feature 027 — Dynamic Quota Reset Countdown
 *
 * Pure parser that extracts the Claude CLI's rate-limit reset timestamp
 * from captured stdout and stderr buffers.
 *
 * Hard invariants (validated by tests):
 *   - Never throws on any input.
 *   - Linear time in `stdout.length + stderr.length` (no catastrophic backtracking).
 *   - Pure: no I/O, no `Date.now()` inside the body (clock is injected).
 *   - Deterministic for any fixed `(stdout, stderr, now)`.
 *   - No module-level mutable state.
 *
 * Algorithm (Bugfix 2026-05-15 — BUG-002):
 *   1. Stream-json path on stdout (preferred). Scan lines in reverse for a
 *      `rate_limit_event` with `status !== "allow"` and a finite-positive
 *      `resetsAt` (seconds). Return `resetsAt * 1000` on first match.
 *      Stream-json on stderr is NOT scanned — not part of the CLI contract.
 *   2. Plain-text path on stdout (fallback). Scan for the strict middle-dot
 *      form `· resets <H[:M] [am|pm]> (<tz>)`. Resolve `tz` via IANA probe →
 *      fixed offset → fail. Compose the epoch in the resolved zone with
 *      `now`'s calendar date, then roll forward 24h when the candidate
 *      is > 12 hours in the past relative to `now`.
 *   3. Plain-text path on stderr (BUG-002 fix). SAME regex and composition
 *      logic; reaches the canonical plain-mode emission point where the CLI
 *      prints `You're out of extra usage · resets <time> (<tz>)` on stderr.
 *   4. No match on any path → `{ resetsAtMs: null }`.
 */

import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';

export interface ExtractResetTimestampResult {
  readonly resetsAtMs: number | null;
}

/**
 * Bugfix 2026-05-15 — BUG-002: derive a short, human-readable summary of
 * the CLI's rate-limit message for the operator-visible debug log line
 * (FR-017). Precedence mirrors the extractor: plain-text on stdout →
 * plain-text on stderr → stream-json record summary on stdout. Returns
 * `null` when no rate-limit signal was found in either buffer.
 *
 * The returned string is trimmed and truncated to ≤240 chars. It is NOT
 * pre-sanitized here — the `SanitizedLogger.write()` path applies
 * `SECRET_PATTERNS` redaction at log-emit time, which is the single
 * source of truth for redaction per the CLAUDE.md hard rule.
 */
export function extractRateLimitMessage(
  stdout: ZippedStreamBuffer | string,
  stderr: ZippedStreamBuffer | string
): string | null {
  const getBufString = (b: ZippedStreamBuffer | string) => typeof b === 'string' ? b : b.getTrailingLines(50);
  
  for (const buf of [stdout, stderr]) {
    if (!buf) continue;
    const str = getBufString(buf);
    const lines = str.split(/\r?\n/);
    for (const line of lines) {
      if (line.indexOf('· resets') !== -1 || /out of (extra )?usage/i.test(line)) {
        return line.trim().slice(0, RATE_LIMIT_MESSAGE_MAX_LEN);
      }
    }
  }
  if (stdout) {
    const str = getBufString(stdout);
    const lines = str.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.indexOf('rate_limit_event') !== -1) {
        return trimmed.slice(0, RATE_LIMIT_MESSAGE_MAX_LEN);
      }
    }
  }
  return null;
}

const RATE_LIMIT_MESSAGE_MAX_LEN = 240;

// Bugfix 2026-05-23 — BUG-008: the upstream `rate_limit_info.status` enum
// has three known values — `allow`, `allowed_warning`, `rejected`. Only
// `rejected` is a hard quota block. `allowed_warning` is the ~90% quota
// soft-warn the CLI emits on a successful run; it MUST NOT contribute its
// future `resetsAt` epoch to the dynamic-backoff calculation.
const SAFE_RATE_LIMIT_STATUSES: ReadonlySet<string> = new Set([
  'allow',
  'allowed_warning'
]);

// BUG-009 — when the caller knows the invocation failed (non-zero exit),
// `allowed_warning` records carry a valid `resetsAt` that should be
// extracted. This strict set only skips `allow`.
const STRICT_SAFE_STATUSES: ReadonlySet<string> = new Set([
  'allow'
]);

/**
 * BUG-009 — optional parameters for `extractResetTimestamp`.
 */
export interface ExtractResetTimestampOptions {
  /**
   * When true, include `allowed_warning` records in the stream-json scan.
   * Callers set this when the CLI exited non-zero, meaning the warning
   * accompanies a genuine failure and its `resetsAt` is load-bearing.
   * Default: false (BUG-008 behavior preserved).
   */
  includeWarningStatus?: boolean;
}

const PLAIN_TEXT_PATTERN =
  /·[ \t]+resets[ \t]+(\d{1,2}):(\d{2})[ \t]*(am|pm)?[ \t]*\(([^)]+)\)/i;
const OFFSET_PATTERN = /^([+-])(\d{2}):?(\d{2})$/;
const MS_PER_HOUR = 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * MS_PER_HOUR;
const ONE_DAY_MS = 24 * MS_PER_HOUR;

export function extractResetTimestamp(
  stdout: ZippedStreamBuffer | string,
  stderr: ZippedStreamBuffer | string,
  now: number,
  opts?: ExtractResetTimestampOptions
): ExtractResetTimestampResult {
  const safeSet = opts?.includeWarningStatus
    ? STRICT_SAFE_STATUSES
    : SAFE_RATE_LIMIT_STATUSES;
  // Stream-json path (preferred) — stdout ONLY. The CLI emits stream-json
  // on stdout when `--output-format stream-json` is active; stream-json on
  // stderr is not part of the CLI contract.
  if (stdout) {
    const str = typeof stdout === 'string' ? stdout : stdout.getTrailingLines(50);
    const lines = str.split(/\r?\n/);

    // Fast-fail order: shape check (cheap), then a substring guard for the
    // `rate_limit_event` discriminator (cheap), then JSON.parse (expensive)
    // — this keeps the loop strictly linear even on adversarial buffers
    // with many `{...}` shape-matching but non-rate-limit lines.
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.length < 2 || trimmed.charCodeAt(0) !== 0x7b /* { */) continue;
      if (trimmed.charCodeAt(trimmed.length - 1) !== 0x7d /* } */) continue;
      if (trimmed.indexOf('rate_limit_event') === -1) continue;
      // The common non-actionable events are `status: "allow"` and
      // `status: "allowed_warning"` (the ~90% quota soft-warn — BUG-008).
      // Skip the canonical compact/pretty JSON shapes before JSON.parse;
      // this keeps large stdout buffers with frequent safe events under
      // the perf budget.
      //
      // BUG-009 — when `includeWarningStatus` is true the safeSet only
      // contains `"allow"`, so `allowed_warning` records fall through to
      // JSON.parse and yield their `resetsAt`. The `allowed_warning`
      // substring check is conditional on the safeSet.

      // Always skip `"status":"allow"` (exact) — need to NOT skip
      // `"allowed_warning"`. Check for `allowed_warning` first (longer
      // match); if present, only skip when the safeSet includes it.
      const hasAllowedWarning =
        trimmed.indexOf('"status":"allowed_warning"') !== -1 ||
        trimmed.indexOf('"status": "allowed_warning"') !== -1;

      if (hasAllowedWarning) {
        if (safeSet.has('allowed_warning')) continue;
        // Fall through — parse the record to extract resetsAt.
      } else {
        // No `allowed_warning` substring. Check for bare `"allow"`.
        const hasAllow =
          trimmed.indexOf('"status":"allow"') !== -1 ||
          trimmed.indexOf('"status": "allow"') !== -1;
        if (hasAllow) continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      const rec = obj as Record<string, unknown>;
      if (rec.type !== 'rate_limit_event') continue;
      const info = rec.rate_limit_info;
      if (!info || typeof info !== 'object') continue;
      const infoRec = info as Record<string, unknown>;
      // Bugfix 2026-05-23 — BUG-008 / BUG-009: use the caller-selected
      // safe-set. Default skips both `allow` and `allowed_warning`;
      // `includeWarningStatus` narrows to `allow` only.
      if (typeof infoRec.status === 'string' && safeSet.has(infoRec.status)) {
        continue;
      }
      const resetsAt = infoRec.resetsAt;
      if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) continue;
      return { resetsAtMs: resetsAt * 1000 };
    }
  }

  // Plain-text path: stdout first, then stderr. First match wins.
  // (Bugfix 2026-05-15 — BUG-002: stderr scan added because the canonical
  // plain-mode rate-limit emission lands on stderr when the CLI exits
  // non-zero in plain mode — the default operator configuration.)
  const stdoutStr = typeof stdout === 'string' ? stdout : stdout.getTrailingLines(50);
  const stderrStr = typeof stderr === 'string' ? stderr : stderr.getTrailingLines(50);
  const stdoutMs = extractPlainText(stdoutStr, now);
  if (stdoutMs !== null) return { resetsAtMs: stdoutMs };
  const stderrMs = extractPlainText(stderrStr, now);
  if (stderrMs !== null) return { resetsAtMs: stderrMs };
  return { resetsAtMs: null };
}

/**
 * Run the plain-text middle-dot pattern against a single buffer. Returns
 * the composed epoch (ms) on match, or null on no-match / unresolvable
 * timezone / out-of-range time-of-day.
 */
function extractPlainText(buf: string, now: number): number | null {
  if (!buf) return null;

  const match = PLAIN_TEXT_PATTERN.exec(buf);
  if (!match) return null;

  const hoursRaw = Number(match[1]);
  const minutes = Number(match[2]);
  const meridian = match[3] ? match[3].toLowerCase() : null;
  const tzText = match[4];

  if (!Number.isInteger(hoursRaw) || !Number.isInteger(minutes)) return null;
  if (minutes < 0 || minutes > 59) return null;

  let hours24: number;
  if (meridian) {
    if (hoursRaw < 1 || hoursRaw > 12) return null;
    if (meridian === 'am') {
      hours24 = hoursRaw === 12 ? 0 : hoursRaw;
    } else {
      hours24 = hoursRaw === 12 ? 12 : hoursRaw + 12;
    }
  } else {
    if (hoursRaw < 0 || hoursRaw > 23) return null;
    hours24 = hoursRaw;
  }

  const candidate = composeEpochInZone(now, hours24, minutes, tzText);
  if (candidate === null) return null;

  if (now - candidate > TWELVE_HOURS_MS) {
    return candidate + ONE_DAY_MS;
  }
  return candidate;
}

/**
 * Compose a Unix epoch (ms) for the wall-clock `(hours24, minutes)` on
 * `now`'s calendar date in the resolved timezone.
 *
 * Resolution order:
 *   1. IANA name via `Intl.DateTimeFormat` probe.
 *   2. Fixed offset like `+07:00` or `-0500`.
 *   3. Fail → return null.
 */
function composeEpochInZone(
  now: number,
  hours24: number,
  minutes: number,
  tzText: string
): number | null {
  // Tier 1: IANA name.
  if (isValidIana(tzText)) {
    return composeViaIana(now, hours24, minutes, tzText);
  }
  // Tier 2: fixed offset.
  const offMatch = OFFSET_PATTERN.exec(tzText);
  if (offMatch) {
    const sign = offMatch[1] === '-' ? -1 : 1;
    const offH = Number(offMatch[2]);
    const offM = Number(offMatch[3]);
    if (offH > 14 || offM > 59) return null;
    return composeViaOffset(now, hours24, minutes, sign, offH, offM);
  }
  // Tier 3: fail.
  return null;
}

function isValidIana(tzText: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tzText });
    return true;
  } catch {
    return false;
  }
}

function composeViaIana(
  now: number,
  hours24: number,
  minutes: number,
  tz: string
): number {
  // Discover the calendar date in zone `tz` at instant `now`, then
  // compose a UTC instant whose zone-local clock is (hours24, minutes)
  // on that same calendar date. Two-pass convergence handles DST.
  const parts = formatPartsInZone(now, tz);
  const yyyy = parts.year;
  const mm = parts.month;
  const dd = parts.day;

  let candidate = Date.UTC(yyyy, mm - 1, dd, hours24, minutes, 0, 0);
  for (let i = 0; i < 2; i++) {
    const observed = formatPartsInZone(candidate, tz);
    const observedInstant = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
      0
    );
    const wantInstant = Date.UTC(yyyy, mm - 1, dd, hours24, minutes, 0, 0);
    const delta = wantInstant - observedInstant;
    if (delta === 0) break;
    candidate += delta;
  }
  return candidate;
}

function composeViaOffset(
  now: number,
  hours24: number,
  minutes: number,
  sign: 1 | -1,
  offH: number,
  offM: number
): number {
  // Calendar date in the offset zone at instant `now`.
  const shifted = now + sign * (offH * MS_PER_HOUR + offM * 60 * 1000);
  const d = new Date(shifted);
  const yyyy = d.getUTCFullYear();
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return Date.UTC(yyyy, mm - 1, dd, hours24, minutes, 0, 0) -
    sign * (offH * MS_PER_HOUR + offM * 60 * 1000);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function formatPartsInZone(instant: number, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute')
  };
}
