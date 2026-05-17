import { describe, it, expect } from 'vitest';
import {
  RATE_LIMIT_MATCHERS,
  detectCreditError,
  detectStatusOk
} from '../../../src/parser/credit-error-detector';

describe('detectCreditError', () => {
  it('detects rate-limit phrases in stderr', () => {
    const result = detectCreditError('error: rate limit exceeded', null);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('rate-limit');
  });

  it('detects "too many requests" wording', () => {
    const result = detectCreditError('429 Too Many Requests', null);
    expect(result.matched).toBe(true);
  });

  it('detects exit code 429 even without matching stderr', () => {
    const result = detectCreditError('Connection error', 429);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('rate-limit');
  });

  it('detects credits exhausted message', () => {
    const result = detectCreditError('credits exhausted, please top up', null);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('credits-exhausted');
  });

  it('detects quota exceeded message', () => {
    const result = detectCreditError('your monthly quota exceeded for tokens', null);
    expect(result.matched).toBe(true);
    expect(result.cause).toBe('quota-exceeded');
  });

  it('is case-insensitive', () => {
    const result = detectCreditError('RATE LIMIT EXCEEDED', null);
    expect(result.matched).toBe(true);
  });

  it('returns no match for unrelated stderr', () => {
    const result = detectCreditError('TypeError: cannot read property of undefined', 1);
    expect(result.matched).toBe(false);
    expect(result.cause).toBe('');
  });

  it('returns no match for empty stderr and exit code 0', () => {
    const result = detectCreditError('', 0);
    expect(result.matched).toBe(false);
  });

  // Feature 027 — US2 acceptance scenarios. The new
  // `/out of (extra )?usage/i` matcher routes the operator-visible
  // "You're out of extra usage" message through the rate-limit path
  // instead of the transient-error 15-minute path.
  describe('out-of-usage matcher (Feature 027 US2)', () => {
    it('matches "You\'re out of extra usage" with cause out-of-usage', () => {
      const result = detectCreditError("You're out of extra usage", 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-usage');
    });

    it('matches "You\'re out of usage" (no "extra") with cause out-of-usage', () => {
      const result = detectCreditError("You're out of usage", 1);
      expect(result.matched).toBe(true);
      expect(result.cause).toBe('out-of-usage');
    });

    it('does NOT match "You\'re out of bandwidth"', () => {
      const result = detectCreditError("You're out of bandwidth", 1);
      // "bandwidth" is a non-quota resource; this string must NOT route
      // through the rate-limit path. May fall to fatal/transient downstream.
      expect(result.cause).not.toBe('out-of-usage');
    });

    it('is case-insensitive on the new phrase', () => {
      const result = detectCreditError('YOU ARE OUT OF EXTRA USAGE', 1);
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
