import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  RATE_LIMIT_MATCHERS,
  detectCreditError
} from '../../../src/parser/credit-error-detector';

describe('detectCreditError', () => {
  it('detects rate-limit phrases in stderr', () => {
    const result = detectCreditError('', 'error: rate limit exceeded', null);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('rate-limit');
  });

  it('detects "too many requests" wording', () => {
    const result = detectCreditError('', '429 Too Many Requests', null);
    expect(result.matched).toBe(true);
  });

  it('detects exit code 429 even without matching stderr', () => {
    const result = detectCreditError('', 'Connection error', 429);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('rate-limit');
  });

  it('detects credits exhausted message', () => {
    const result = detectCreditError('', 'credits exhausted, please top up', null);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('credits-exhausted');
  });

  it('detects quota exceeded message', () => {
    const result = detectCreditError('', 'your monthly quota exceeded for tokens', null);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('quota-exceeded');
  });

  it('is case-insensitive', () => {
    const result = detectCreditError('', 'RATE LIMIT EXCEEDED', null);
    expect(result.matched).toBe(true);
  });

  it('returns no match for unrelated stderr', () => {
    const result = detectCreditError('', 'TypeError: cannot read property of undefined', 1);
    expect(result.matched).toBe(false);
    expect(result.cause).toBe('');
  });

  it('returns no match for empty stdout, stderr and exit code 0', () => {
    const result = detectCreditError('', '', 0);
    expect(result.matched).toBe(false);
  });

  // Feature 027 — US2 acceptance scenarios. The new
  // `/out of (extra )?usage/i` matcher routes the operator-visible
  // "You're out of extra usage" message through the rate-limit path
  // instead of the transient-error 15-minute path.
  describe('out-of-usage matcher (Feature 027 US2)', () => {
    it('matches "You\'re out of extra usage" with cause out-of-usage', () => {
      const result = detectCreditError('', "You're out of extra usage", 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-usage');
    });

    it('matches "You\'re out of usage" (no "extra") with cause out-of-usage', () => {
      const result = detectCreditError('', "You're out of usage", 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-usage');
    });

    it('does NOT match "You\'re out of bandwidth"', () => {
      const result = detectCreditError('', "You're out of bandwidth", 1);
      // "bandwidth" is a non-quota resource; this string must NOT route
      // through the rate-limit path. May fall to fatal/transient downstream.
      expect(result.cause).not.toBe('out-of-usage');
    });

    it('is case-insensitive on the new phrase', () => {
      const result = detectCreditError('', 'YOU ARE OUT OF EXTRA USAGE', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-usage');
    });

    it('places out-of-usage matcher at index 1 (after rate-limit, before credits-exhausted)', () => {
      // FR-014 — matcher precedence: rate-limit first (preserved),
      // out-of-usage second (new), credits-exhausted third (preserved).
      // Index 0: rate-limit; Index 1: out-of-usage; Index 2:
      // credits-exhausted; Index 3: quota-exceeded.
      expect(RATE_LIMIT_MATCHERS[0].cause).toBe('rate-limit');
      expect(RATE_LIMIT_MATCHERS[1].cause).toBe('out-of-usage');
      expect(RATE_LIMIT_MATCHERS[2].cause).toBe('credits-exhausted');
      expect(RATE_LIMIT_MATCHERS[3].cause).toBe('quota-exceeded');
    });
  });

  // BUG-009 — the CLI emits "You've hit your session limit" on stderr
  // when the five-hour session quota is exhausted.
  describe('session-limit matcher (BUG-009)', () => {
    it('matches "You\'ve hit your session limit" with cause session-limit', () => {
      const result = detectCreditError(
        '',
        "You've hit your session limit · resets 6:50am (Asia/Saigon)",
        1
      );
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('session-limit');
    });

    it('matches "session limit" case-insensitively', () => {
      const result = detectCreditError('', 'SESSION LIMIT exceeded', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('session-limit');
    });

    it('does NOT match on exit code 0 (BUG-008 gate)', () => {
      const result = detectCreditError(
        '',
        "You've hit your session limit · resets 6:50am (Asia/Saigon)",
        0
      );
      expect(result.matched).toBe(false);
    });

    it('is at matcher index 4 (after quota-exceeded)', () => {
      expect(RATE_LIMIT_MATCHERS[4].cause).toBe('session-limit');
    });
  });
  // Feature 066 — US2 acceptance scenarios. The detector now scans the
  // trailing ~20-line window of stdout for the stream-json
  // `rate_limit_event` envelope and the `out_of_credits` overage
  // reason. `out_of_credits` wins over `rate_limit_event` so the
  // hard-cap signal routes through the past-timestamp safety guard.
  //
  // FR-R4-F02 (T037a, maintainer decision (b), 2026-10-28): FR-012 counts a
  // stdout event only as a record whose own `type` is `rate_limit_event` and
  // whose `rate_limit_info.status` is `rejected`. Each event below that is
  // meant to match carries that status; a status-less event and a bare
  // substring no longer match. Rows #10 and #12 were not among the failures
  // and keep their inputs, which are no longer records; the genuine-record
  // cases for both are in credit-error-detector-records.test.ts.
  describe('stdout trailing-window scan (Feature 066 US2)', () => {
    it('matches a generic rejected rate_limit_event record with cause rate-limit (row #7)', () => {
      const stdout =
        '{"type":"rate_limit_event","subtype":"unified","rate_limit_info":{"status":"rejected"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('matches a rate_limit_event payload carrying out_of_credits with cause out-of-credits (row #8)', () => {
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-credits');
    });

    it('does NOT match a bare out_of_credits substring (row #9, reversed by FR-012)', () => {
      // A substring is not a record: only `rate_limit_info.status === "rejected"` blocks.
      const stdout = '...out_of_credits...';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(false);
      expect(result.cause).toBe('');
    });

    it('stderr wins over stdout when both match — preserves FR-007 byte-for-byte (row #10)', () => {
      const stdout = '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}';
      const stderr = 'rate limit exceeded';
      const result = detectCreditError(stdout, stderr, 1);
      expect(result.matched).toBe(true);
      // Stderr regex returns 'rate-limit' first; the stdout scan is
      // never consulted.
      expect(result.cause).toBe('rate-limit');
    });

    it('finds a rejected record inside the trailing 20-line window, and not the bare event name (row #11)', () => {
      // The signal is a record. The bare event name that stood on the last
      // line before FR-012 is not one, so the second half expects no match.
      const record =
        '{"type":"rate_limit_event","subtype":"unified","rate_limit_info":{"status":"rejected"}}';
      const found = detectCreditError(`${'a\n'.repeat(100)}${record}`, '', 1);
      expect(found.matched).toBe(true);
      expect(found.cause).toBe('rate-limit');

      const bare = detectCreditError(`${'a\n'.repeat(100)}rate_limit_event`, '', 1);
      expect(bare.matched).toBe(false);
      expect(bare.cause).toBe('');
    });

    it('does NOT match a signal outside the trailing window (row #12)', () => {
      // `rate_limit_event` lives at the very start; the last 20 lines
      // contain only `x` characters, so the scan returns no-match.
      const stdout = `rate_limit_event${'\nx'.repeat(100)}`;
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(false);
      expect(result.cause).toBe('');
    });

    it('out_of_credits wins over rate_limit_event within the same line (FR-006)', () => {
      // Both substrings present on the same line; the more specific
      // hard-cap signal must win.
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.cause).toBe('out-of-credits');
    });

    it('most recent line wins when multiple rate-limit lines appear (spec edge case)', () => {
      // Older out_of_credits, newer plain rate_limit_event — the
      // detector reports the most recent emission so the cause matches
      // the current CLI state, not stale history.
      const stdout = [
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}',
        '{"type":"assistant","message":{}}',
        '{"type":"rate_limit_event","subtype":"unified","rate_limit_info":{"status":"rejected"}}'
      ].join('\n');
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('newer out_of_credits wins over older plain rate_limit_event (most-recent-line rule)', () => {
      const stdout = [
        '{"type":"rate_limit_event","subtype":"unified","rate_limit_info":{"status":"rejected"}}',
        '{"type":"assistant","message":{}}',
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}'
      ].join('\n');
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-credits');
    });

    it('returns no match when stdout has no rate-limit signal AND stderr is empty AND exit is 1', () => {
      const result = detectCreditError('plain harmless output\n', '', 1);
      expect(result.matched).toBe(false);
      expect(result.cause).toBe('');
    });

    it('substring matching is case-sensitive — uppercase OUT_OF_CREDITS does NOT match', () => {
      const result = detectCreditError('OUT_OF_CREDITS', '', 1);
      expect(result.matched).toBe(false);
    });

    // BUG-008 — exit-zero short-circuit. The detector MUST return
    // matched:false for a successful CLI completion regardless of
    // stderr/stdout content. The CLI exits 0 even when carrying a
    // soft-warn `rate_limit_event` payload at ~90% quota
    // (`rate_limit_info.status === 'allowed_warning'`); without this
    // gate the stderr regex or stdout scan would hijack the run.
    describe('BUG-008 exit-zero short-circuit', () => {
      it('returns no match when stderr carries a courtesy rate-limit phrase but exitCode is 0 (BUG-008 repro)', () => {
        const result = detectCreditError('', 'rate limit warning approaching cap', 0);
        expect(result.matched).toBe(false);
        expect(result.cause).toBe('');
      });

      it('returns no match when stdout carries an allowed_warning rate_limit_event but exitCode is 0', () => {
        const stdout =
          '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1779520200}}';
        const result = detectCreditError(stdout, '', 0);
        expect(result.matched).toBe(false);
        expect(result.cause).toBe('');
      });

      it('regression — genuine stdout rate_limit_event with rejected status on non-zero exit still matches', () => {
        const stdout =
          '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779520200}}';
        const result = detectCreditError(stdout, '', 1);
        expect(result.matched).toBe(true);
        expect(result.cause).toBe('rate-limit');
      });

      it('regression — genuine stderr "rate limit" phrase on non-zero exit still matches', () => {
        const result = detectCreditError('', 'rate limit', 1);
        expect(result.matched).toBe(true);
        expect(result.cause).toBe('rate-limit');
      });

      it('regression — exitCode 429 MATCH path is unaffected (429 is non-zero)', () => {
        const result = detectCreditError('', '', 429);
        expect(result.matched).toBe(true);
        expect(result.cause).toBe('rate-limit');
      });

      it('sanity — empty inputs with exitCode 0 returns no match', () => {
        const result = detectCreditError('', '', 0);
        expect(result.matched).toBe(false);
        expect(result.cause).toBe('');
      });
    });

    it('scans within an order of magnitude of a 200-byte input on a 1MB stdout buffer (SC-005)', () => {
      // Build a 1MB stdout buffer with the signal in the last line. The
      // signal is a rejected record (FR-012); the bare text that stood here
      // before is asserted below not to match.
      const record =
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}';
      const padLine = 'a'.repeat(99) + '\n';
      const padding = padLine.repeat(Math.ceil(1_000_000 / padLine.length));
      const stdout = padding + record;
      const small = record;

      const t0 = performance.now();
      const smallResult = detectCreditError(small, '', 1);
      const t1 = performance.now();
      const largeResult = detectCreditError(stdout, '', 1);
      const t2 = performance.now();

      expect(smallResult.cause).toBe('out-of-credits');
      expect(largeResult.cause).toBe('out-of-credits');
      // The bare text is not a record, on a small buffer and on a large one.
      expect(detectCreditError('out_of_credits', '', 1).matched).toBe(false);
      expect(detectCreditError(`${padding}out_of_credits`, '', 1).matched).toBe(false);

      // Soft bound: the large-input call should finish well within an
      // order of magnitude of the small-input call PLUS a generous
      // wall-clock budget for noisy CI machines.
      const smallMs = t1 - t0;
      const largeMs = t2 - t1;
      expect(largeMs).toBeLessThan(50);
      // Sanity: the small-input baseline is essentially zero; the test
      // primarily guards against accidental O(n^2) regressions.
      expect(smallMs).toBeLessThan(50);
    });
  });

  // FR-R3-197 (T1874) — the CLI writes `rate_limit_info.status` as `allowed`,
  // `allowed_warning` or `rejected`. Only `rejected` is a block. The fixture
  // is the event observed in run 777491f8, ids elided; it carries
  // `"overageStatus":"rejected"` beside `"status":"allowed"`.
  describe('allowed rate_limit_event status (FR-R3-197, T1874)', () => {
    const observed = readFileSync(
      resolve(__dirname, '../../fixtures/rate-limit/rate-limit-allowed-observed.txt'),
      'utf8'
    ).trim();

    it('U1 — the observed allowed event on exit 143 is not a rate limit', () => {
      const result = detectCreditError(observed, '', 143);
      expect(result).toEqual({ matched: false, cause: '' });
    });

    it('U2 — the same event with status rejected is a rate limit', () => {
      const rejected = observed.replace('"status":"allowed"', '"status":"rejected"');
      expect(rejected).not.toBe(observed);
      const result = detectCreditError(rejected, '', 143);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('U3 — an allowed event that names out_of_credits is not out-of-credits (D2)', () => {
      const spent = observed.replace('org_level_disabled', 'out_of_credits');
      expect(spent).not.toBe(observed);
      const result = detectCreditError(spent, '', 1);
      expect(result.matched).toBe(false);
    });

    it('U4 — an allowed_warning event that names out_of_credits is not out-of-credits (D2)', () => {
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","overageDisabledReason":"out_of_credits"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(false);
    });

    it('U5 — an allow event (one space) that names out_of_credits is not out-of-credits (D2)', () => {
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"status": "allow","overageDisabledReason":"out_of_credits"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(false);
    });

    it('U6 — an earlier rejected event is still found beneath a later allowed event', () => {
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1716000000}}\n' + observed;
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('U7 — an allowed event written with one space after the colon is not a rate limit', () => {
      const spaced = observed.replace('"status":"allowed"', '"status": "allowed"');
      expect(spaced).not.toBe(observed);
      const result = detectCreditError(spaced, '', 1);
      expect(result.matched).toBe(false);
    });

    it('U8 — a rejected event carrying overageStatus allowed is still a rate limit', () => {
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageStatus":"allowed"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('U9 — an allowed_warning event on a non-zero exit is not a rate limit', () => {
      const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(false);
    });

    it('U10 — a stderr rate-limit phrase beside an allowed event still wins', () => {
      const result = detectCreditError(observed, 'rate limit exceeded', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });
  });
});
