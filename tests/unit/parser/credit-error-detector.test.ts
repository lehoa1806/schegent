import { describe, it, expect } from 'vitest';
import {
  RATE_LIMIT_MATCHERS,
  detectCreditError,
  detectStatusOk
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

  // Feature 066 — US2 acceptance scenarios. The detector now scans the
  // trailing ~20-line window of stdout for the stream-json
  // `rate_limit_event` envelope and the `out_of_credits` overage
  // reason. `out_of_credits` wins over `rate_limit_event` so the
  // hard-cap signal routes through the past-timestamp safety guard.
  describe('stdout trailing-window scan (Feature 066 US2)', () => {
    it('matches a generic rate_limit_event substring with cause rate-limit (row #7)', () => {
      const stdout = '{"type":"rate_limit_event","subtype":"unified"}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('matches a rate_limit_event payload carrying out_of_credits with cause out-of-credits (row #8)', () => {
      const stdout =
        '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-credits');
    });

    it('matches a bare out_of_credits substring with cause out-of-credits (row #9)', () => {
      const stdout = '...out_of_credits...';
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-credits');
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

    it('finds the signal inside the trailing 20-line window (row #11)', () => {
      const stdout = `${'a\n'.repeat(100)}rate_limit_event`;
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
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
        '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}';
      const result = detectCreditError(stdout, '', 1);
      expect(result.cause).toBe('out-of-credits');
    });

    it('most recent line wins when multiple rate-limit lines appear (spec edge case)', () => {
      // Older out_of_credits, newer plain rate_limit_event — the
      // detector reports the most recent emission so the cause matches
      // the current CLI state, not stale history.
      const stdout = [
        '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}',
        '{"type":"assistant","message":{}}',
        '{"type":"rate_limit_event","subtype":"unified"}'
      ].join('\n');
      const result = detectCreditError(stdout, '', 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('rate-limit');
    });

    it('newer out_of_credits wins over older plain rate_limit_event (most-recent-line rule)', () => {
      const stdout = [
        '{"type":"rate_limit_event","subtype":"unified"}',
        '{"type":"assistant","message":{}}',
        '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}'
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
      // Build a 1MB stdout buffer with the signal in the last line.
      const padLine = 'a'.repeat(99) + '\n';
      const padding = padLine.repeat(Math.ceil(1_000_000 / padLine.length));
      const stdout = padding + 'out_of_credits';
      const small = 'out_of_credits';

      const t0 = performance.now();
      const smallResult = detectCreditError(small, '', 1);
      const t1 = performance.now();
      const largeResult = detectCreditError(stdout, '', 1);
      const t2 = performance.now();

      expect(smallResult.cause).toBe('out-of-credits');
      expect(largeResult.cause).toBe('out-of-credits');

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
});

describe('detectStatusOk', () => {
  it('returns true when status reports credits available', () => {
    expect(detectStatusOk('Your credits are available')).toBe(true);
  });

  it('returns true when status reports system OK', () => {
    expect(detectStatusOk('Status: ok')).toBe(true);
  });

  it('returns true when quota has reset', () => {
    expect(detectStatusOk('quota has been reset')).toBe(true);
  });

  it('returns false for an error response', () => {
    expect(detectStatusOk('error: subscription expired')).toBe(false);
  });

  it('returns false for empty output', () => {
    expect(detectStatusOk('')).toBe(false);
  });
});
