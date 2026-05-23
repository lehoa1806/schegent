// Feature 066 — US1: end-to-end test that stdout-only `rate_limit_event`
// payloads with `out_of_credits` overage reason flow through the full
// parser stack (`detectCreditError` → `parseInvocation`) and land in
// the `rate_limited` discriminator with cause `'out-of-credits'`.

import { describe, it, expect } from 'vitest';
import { detectCreditError } from '../../../src/parser/credit-error-detector';
import { parseInvocation } from '../../../src/parser/stdout-parser';

describe('parseInvocation — stdout-only out-of-credits routing (Feature 066)', () => {
  it('produces a rate_limited result with cause out-of-credits', () => {
    const stdout =
      '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}';
    const stderr = '';
    const exitCode = 1;

    const rateLimit = detectCreditError(stdout, stderr, exitCode);
    expect(rateLimit.matched).toBe(true);
    expect(rateLimit.cause).toBe('out-of-credits');

    const result = parseInvocation({
      stdout,
      stderr,
      exitCode,
      rateLimit,
      auditEntry: null,
      auditWarnings: []
    });

    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.cause).toBe('out-of-credits');
  });

  it('produces a rate_limited result for a generic stdout rate_limit_event with cause rate-limit', () => {
    const stdout = '{"type":"rate_limit_event","subtype":"unified"}';
    const stderr = '';
    const exitCode = 1;

    const rateLimit = detectCreditError(stdout, stderr, exitCode);
    expect(rateLimit.matched).toBe(true);
    expect(rateLimit.cause).toBe('rate-limit');

    const result = parseInvocation({
      stdout,
      stderr,
      exitCode,
      rateLimit,
      auditEntry: null,
      auditWarnings: []
    });

    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.cause).toBe('rate-limit');
  });

  it('SC-004: non-rate-limit non-zero exit still produces transient_error (no over-detection)', () => {
    const stdout = '';
    const stderr = '';
    const exitCode = 1;

    const rateLimit = detectCreditError(stdout, stderr, exitCode);
    expect(rateLimit.matched).toBe(false);

    const result = parseInvocation({
      stdout,
      stderr,
      exitCode,
      rateLimit,
      auditEntry: null,
      auditWarnings: []
    });

    expect(result.kind).toBe('transient_error');
  });
});
