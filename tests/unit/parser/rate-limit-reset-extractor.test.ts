// Feature 027 — US1 contract tests for `extractResetTimestamp`.
//
// Implements the 31-row fixture matrix from
// `specs/027-dynamic-quota-reset-countdown/contracts/rate-limit-reset-extractor.md`.
//
// Bugfix 2026-05-15 — BUG-002: widened signature to `(stdout, stderr, now)`.
// Every plain-text row is exercised TWICE — once on the stdout argument
// (stderr empty), once on the stderr argument (stdout empty). Results MUST
// be identical across the pair. Rows 26-31 cover the new stderr surface,
// scan order, and double-empty edge.

import { describe, it, expect } from 'vitest';
import { extractResetTimestamp } from '../../../src/parser/rate-limit-reset-extractor';

/**
 * Compose an epoch (ms) for a given wall-clock time-of-day in the given
 * IANA zone on the given local date, by adjusting the equivalent UTC
 * instant to land on the matching zone-local hour/minute.
 *
 * The implementation uses `Intl.DateTimeFormat` to discover the zone's
 * offset on the candidate UTC instant, then corrects.
 */
function composeZonedEpoch(
  yyyy: number,
  mm: number,
  dd: number,
  hours: number,
  minutes: number,
  tz: string
): number {
  // Start with the wall-clock interpreted as UTC, then iteratively
  // correct by the zone's offset at that instant. Two passes is enough
  // for stable zones (no DST transition within the day's two-hour
  // boundary).
  let utc = Date.UTC(yyyy, mm - 1, dd, hours, minutes, 0, 0);
  for (let i = 0; i < 2; i++) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(new Date(utc));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const seenY = get('year');
    const seenM = get('month');
    const seenD = get('day');
    let seenH = get('hour');
    if (seenH === 24) seenH = 0;
    const seenMin = get('minute');
    const seenInstant = Date.UTC(seenY, seenM - 1, seenD, seenH, seenMin, 0, 0);
    const wantInstant = Date.UTC(yyyy, mm - 1, dd, hours, minutes, 0, 0);
    const delta = wantInstant - seenInstant;
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

function composeOffsetEpoch(
  yyyy: number,
  mm: number,
  dd: number,
  hours: number,
  minutes: number,
  offsetHours: number,
  offsetMinutes: number,
  sign: 1 | -1
): number {
  const utcHours = hours - sign * offsetHours;
  const utcMinutes = minutes - sign * offsetMinutes;
  return Date.UTC(yyyy, mm - 1, dd, utcHours, utcMinutes, 0, 0);
}

describe('extractResetTimestamp — stream-json path on stdout (rows 1-8)', () => {
  it('row 1: rejected event with finite resetsAt → returns resetsAt * 1000', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1715000000}}';
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBe(1715000000_000);
  });

  it('row 2: status "allow" → line skipped, no plain-text fallback either', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"allow","resetsAt":1715000000}}';
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBeNull();
  });

  it('row 3: rejected event without resetsAt → skipped', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}';
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBeNull();
  });

  it('row 4: resetsAt = 0 (non-positive) → skipped', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":0}}';
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBeNull();
  });

  it('row 5: resetsAt non-number ("abc") → skipped', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":"abc"}}';
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBeNull();
  });

  it('row 6: allow then rejected → last rejected wins', () => {
    const stdout = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allow","resetsAt":1715000000}}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1716000000}}'
    ].join('\n');
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBe(1716000000_000);
  });

  it('row 7: two rejected events with different resetsAt → last wins (reverse scan)', () => {
    const stdout = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1715000000}}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1716000000}}'
    ].join('\n');
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBe(1716000000_000);
  });

  it('row 8: stream-json AND plain-text both on stdout → stream-json wins', () => {
    const stdout = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1715000000}}',
      "You're out of extra usage · resets 1:10am (Asia/Saigon)"
    ].join('\n');
    expect(extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs).toBe(1715000000_000);
  });

  it('row 8b (BUG-002): stream-json on stderr is NOT scanned (stdout-only by CLI contract)', () => {
    // Stream-json discriminator placed in stderr — must NOT match.
    const stderr = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1715000000}}';
    expect(extractResetTimestamp('', stderr, 1700000000_000).resetsAtMs).toBeNull();
  });
});

describe('extractResetTimestamp — plain-text path (rows 9-22) exercised on stdout AND stderr', () => {
  // Anchor `now` to Saigon-local 2026-05-15 noon. 01:10 same day is
  // ~10h50m in the past, BELOW the 12-hour roll-forward threshold,
  // so the candidate stays on the same day.
  const now = composeZonedEpoch(2026, 5, 15, 12, 0, 'Asia/Saigon');

  /**
   * Helper: run the same input through the extractor twice — once on
   * stdout (stderr empty), once on stderr (stdout empty). Both calls
   * MUST return the same `resetsAtMs`. This is the BUG-002 invariant.
   */
  function expectIdenticalOnBothBuffers(
    input: string,
    nowArg: number,
    assertResult: (resetsAtMs: number | null) => void
  ): void {
    const fromStdout = extractResetTimestamp(input, '', nowArg).resetsAtMs;
    const fromStderr = extractResetTimestamp('', input, nowArg).resetsAtMs;
    expect(fromStdout).toBe(fromStderr);
    assertResult(fromStdout);
  }

  it('row 9: "· resets 1:10am (Asia/Saigon)" → composed Saigon-local 01:10 same day', () => {
    const input = "You're out of extra usage · resets 1:10am (Asia/Saigon)";
    const expected = composeZonedEpoch(2026, 5, 15, 1, 10, 'Asia/Saigon');
    expectIdenticalOnBothBuffers(input, now, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 10: "· resets 1:10 AM (Asia/Saigon)" → same as row 9 (space + uppercase)', () => {
    const input = "stuff · resets 1:10 AM (Asia/Saigon)";
    const expected = composeZonedEpoch(2026, 5, 15, 1, 10, 'Asia/Saigon');
    expectIdenticalOnBothBuffers(input, now, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 11: "· resets 13:10 (UTC)" no meridian, 24h → UTC 13:10', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 12, 0, 0);
    const input = "· resets 13:10 (UTC)";
    const expected = Date.UTC(2026, 4, 15, 13, 10, 0);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 12: "· resets 1:10pm (+07:00)" → +07:00 13:10', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 5, 0, 0); // 12:00 +07
    const input = "· resets 1:10pm (+07:00)";
    const expected = composeOffsetEpoch(2026, 5, 15, 13, 10, 7, 0, 1);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 13: "· resets 1:10pm (-0500)" → -05:00 13:10', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 17, 0, 0); // 12:00 -05
    const input = "· resets 1:10pm (-0500)";
    const expected = composeOffsetEpoch(2026, 5, 15, 13, 10, 5, 0, -1);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 14: "· resets 12:00am (UTC)" → UTC midnight same day (delta = 12h is not > 12h)', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 12, 0, 0);
    const input = "· resets 12:00am (UTC)";
    // 12:00am same UTC day is exactly 12h in the past — threshold is
    // strict-greater, so candidate stays on the same day.
    const expected = Date.UTC(2026, 4, 15, 0, 0, 0);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 15: "· resets 12:00pm (UTC)" → UTC noon', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 6, 0, 0); // 06:00 UTC
    const input = "· resets 12:00pm (UTC)";
    const expected = Date.UTC(2026, 4, 15, 12, 0, 0);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 16: time < now wall-clock in zone → rolls forward 24h', () => {
    // now: Saigon 23:50. parsed: 01:10am — 22h in the past → rolls forward.
    const nowSaigon = composeZonedEpoch(2026, 5, 15, 23, 50, 'Asia/Saigon');
    const input = "· resets 1:10am (Asia/Saigon)";
    const expected = composeZonedEpoch(2026, 5, 16, 1, 10, 'Asia/Saigon');
    expectIdenticalOnBothBuffers(input, nowSaigon, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 17: time > 12h past relative to now → rolls forward 24h', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 20, 0, 0); // 20:00 UTC
    const input = "· resets 02:00 (UTC)";
    // Same-day 02:00 is 18h in the past → roll forward to next day 02:00.
    const expected = Date.UTC(2026, 4, 16, 2, 0, 0);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 18: time 5h past relative to now → does NOT roll forward', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 15, 0, 0); // 15:00 UTC
    const input = "· resets 10:00 (UTC)"; // 5h past
    const expected = Date.UTC(2026, 4, 15, 10, 0, 0);
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
    });
  });

  it('row 19: non-IANA tzText "(PST)" → platform-dependent (null or number)', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 12, 0, 0);
    const input = "· resets 1:10am (PST)";
    // Some runtimes accept "PST" as a valid IANA legacy alias; others
    // don't. The contract treats invalid as null but accept either
    // outcome here so the test is platform-portable: when valid, we
    // expect a number; when invalid, null. The stdout/stderr surfaces
    // MUST agree on the outcome.
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got === null || typeof got === 'number').toBe(true);
    });
  });

  it('row 20: invalid offset "(+99:99)" → null', () => {
    const nowUtc = Date.UTC(2026, 4, 15, 12, 0, 0);
    const input = "· resets 1:10am (+99:99)";
    expectIdenticalOnBothBuffers(input, nowUtc, (got) => {
      expect(got).toBeNull();
    });
  });

  it('row 21: "resets at 1:10am (Asia/Saigon)" no middle dot → null', () => {
    const input = "resets at 1:10am (Asia/Saigon)";
    expectIdenticalOnBothBuffers(input, now, (got) => {
      expect(got).toBeNull();
    });
  });

  it('row 22: "this resets on Tuesday" narrative → null', () => {
    const input = "this resets on Tuesday";
    expectIdenticalOnBothBuffers(input, now, (got) => {
      expect(got).toBeNull();
    });
  });
});

describe('extractResetTimestamp — empty/no-match (rows 23-24)', () => {
  it('row 23: empty stdout AND empty stderr → null', () => {
    expect(extractResetTimestamp('', '', 1715000000_000).resetsAtMs).toBeNull();
  });

  it('row 24: stdout with no JSON and no middle dot → null', () => {
    expect(extractResetTimestamp('hello world\nnothing here\n', '', 1715000000_000).resetsAtMs).toBeNull();
  });
});

describe('extractResetTimestamp — invariants', () => {
  it('row 25: 1MB random stdout buffer returns within 100ms (no catastrophic backtracking)', () => {
    const chunk = 'lorem ipsum dolor sit amet ';
    const buf = chunk.repeat(40000); // ~1MB
    const t0 = Date.now();
    const res = extractResetTimestamp(buf, '', 1700000000_000);
    const elapsed = Date.now() - t0;
    expect(res.resetsAtMs).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });

  it('never throws on adversarial input', () => {
    expect(() => extractResetTimestamp('\u{1F600}\n}}{{{}\n· resets ', '', 0)).not.toThrow();
    expect(() => extractResetTimestamp('{"type":"rate_limit_event"', '', 0)).not.toThrow(); // truncated JSON
    expect(() => extractResetTimestamp('', '\u{1F600}\n}}{{{}\n· resets ', 0)).not.toThrow();
  });

  it('is deterministic for the same (stdout, stderr, now)', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1715000000}}';
    const a = extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs;
    const b = extractResetTimestamp(stdout, '', 1700000000_000).resetsAtMs;
    expect(a).toBe(b);
  });
});

// Bugfix 2026-05-15 — BUG-002. Matrix rows 26-31 cover the new stderr
// surface, scan order, double-empty edge, and stderr adversarial perf.
describe('extractResetTimestamp — BUG-002 stderr surface (rows 26-31)', () => {
  it('row 26: stderr-only "· resets 12:10am (Asia/Saigon)", stdout empty → Saigon-local 00:10', () => {
    // Anchor `now` to Saigon noon so 00:10 is ~12h in the past, NOT > 12h
    // (threshold is strict-greater); candidate stays on the same day.
    const now = composeZonedEpoch(2026, 5, 15, 12, 0, 'Asia/Saigon');
    const stderr = '· resets 12:10am (Asia/Saigon)';
    const expected = composeZonedEpoch(2026, 5, 15, 0, 10, 'Asia/Saigon');
    const got = extractResetTimestamp('', stderr, now).resetsAtMs;
    expect(got).not.toBeNull();
    expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
  });

  it('row 27: canonical full plain-mode message on stderr → Saigon-local 01:10', () => {
    const now = composeZonedEpoch(2026, 5, 15, 12, 0, 'Asia/Saigon');
    const stderr = "You're out of extra usage · resets 1:10am (Asia/Saigon)";
    const expected = composeZonedEpoch(2026, 5, 15, 1, 10, 'Asia/Saigon');
    const got = extractResetTimestamp('', stderr, now).resetsAtMs;
    expect(got).not.toBeNull();
    expect(Math.abs((got as number) - expected)).toBeLessThan(1000);
  });

  it('row 28: stdout AND stderr both contain plain-text matches → stdout wins', () => {
    // Same time-of-day in two different zones picked so they map to
    // unambiguously different epochs.
    const nowUtc = Date.UTC(2026, 4, 15, 6, 0, 0);
    const stdout = '· resets 10:00 (UTC)'; // UTC 10:00 → Date.UTC(...,10,0,0)
    const stderr = '· resets 10:00 (+07:00)'; // +07:00 10:00 → UTC 03:00
    const expectedStdout = Date.UTC(2026, 4, 15, 10, 0, 0);
    const got = extractResetTimestamp(stdout, stderr, nowUtc).resetsAtMs;
    expect(got).not.toBeNull();
    expect(Math.abs((got as number) - expectedStdout)).toBeLessThan(1000);
  });

  it('row 29: stream-json on stdout + plain-text mirror on stderr → stream-json wins', () => {
    const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1715000000}}';
    const stderr = "You're out of extra usage · resets 1:10am (Asia/Saigon)";
    expect(extractResetTimestamp(stdout, stderr, 1700000000_000).resetsAtMs).toBe(1715000000_000);
  });

  it('row 30: empty stdout AND empty stderr → null', () => {
    expect(extractResetTimestamp('', '', 1700000000_000).resetsAtMs).toBeNull();
  });

  it('row 31: 1MB random stderr buffer returns within 100ms (no catastrophic backtracking)', () => {
    const chunk = 'lorem ipsum dolor sit amet ';
    const buf = chunk.repeat(40000); // ~1MB
    const t0 = Date.now();
    const res = extractResetTimestamp('', buf, 1700000000_000);
    const elapsed = Date.now() - t0;
    expect(res.resetsAtMs).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });
});
