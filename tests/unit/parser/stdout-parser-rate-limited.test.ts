// Feature 027 — US1: assert `parseInvocation` populates `resetsAtMs` on
// the `rate_limited` variant when extractResetTimestamp finds a parseable
// reset epoch in the captured stdout.

import { describe, it, expect } from 'vitest';
import { parseInvocation } from '../../../src/parser/stdout-parser';

describe('parseInvocation — rate_limited.resetsAtMs (Feature 027)', () => {
  it('populates a finite resetsAtMs when stream-json rate_limit_event with rejected status is in stdout', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${future}}}`;
    const result = parseInvocation({
      stdout,
      stderr: 'over rate limit',
      exitCode: 1,
      rateLimit: { matched: true, cause: 'rate-limit' },
      auditEntry: null,
      auditWarnings: []
    });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.resetsAtMs).toBe(future * 1000);
  });

  it('sets resetsAtMs to null when no parseable reset is present', () => {
    const result = parseInvocation({
      stdout: 'no rate-limit info in this output',
      stderr: 'over rate limit',
      exitCode: 1,
      rateLimit: { matched: true, cause: 'rate-limit' },
      auditEntry: null,
      auditWarnings: []
    });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.resetsAtMs ?? null).toBeNull();
  });

  it('preserves the cause string verbatim on the rate_limited variant', () => {
    const result = parseInvocation({
      stdout: '',
      stderr: "You're out of extra usage",
      exitCode: 1,
      rateLimit: { matched: true, cause: 'out-of-usage' },
      auditEntry: null,
      auditWarnings: []
    });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.cause).toBe('out-of-usage');
  });

  it('non-rate-limit paths do not carry a resetsAtMs (variant shape unchanged)', () => {
    const result = parseInvocation({
      stdout: '',
      stderr: 'TypeError',
      exitCode: 1,
      rateLimit: { matched: false, cause: '' },
      auditEntry: null,
      auditWarnings: []
    });
    expect(result.kind).toBe('transient_error');
  });

  // Bugfix 2026-05-23 — BUG-008: defensive symmetric check. A successful
  // CLI completion (exitCode === 0) MUST NOT route through the
  // `rate_limited` branch even if a caller constructs a synthetic
  // `rateLimit.matched = true` — the existing detector-layer guard
  // already prevents this in the normal flow, but the parser-level
  // belt-and-suspenders gate covers replay-from-fixture and test-harness
  // callers.
  describe('BUG-008 defensive exitCode !== 0 check', () => {
    it('synthetic matched=true with exitCode 0 does NOT route through rate_limited (with token → clean)', () => {
      const result = parseInvocation({
        stdout: '[SCHEGENT_STATUS: CLEAR]',
        stderr: '',
        exitCode: 0,
        rateLimit: { matched: true, cause: 'rate-limit' },
        auditEntry: { entryRaw: '{}', entryParsed: {} } as never,
        auditWarnings: []
      });
      expect(result.kind).not.toBe('rate_limited');
      expect(result.kind).toBe('clean');
    });

    it('synthetic matched=true with exitCode 0 and no contract block falls through to remaining_issues default', () => {
      const result = parseInvocation({
        stdout: 'plain output\n',
        stderr: '',
        exitCode: 0,
        rateLimit: { matched: true, cause: 'rate-limit' },
        auditEntry: null,
        auditWarnings: []
      });
      expect(result.kind).not.toBe('rate_limited');
      // No contract block + exit-zero falls through to the default
      // remaining_issues branch (the existing fall-through path).
      expect(result.kind).toBe('remaining_issues');
    });

    it('regression — genuine matched=true with non-zero exitCode still routes through rate_limited', () => {
      const future = Math.floor(Date.now() / 1000) + 600;
      const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${future}}}`;
      const result = parseInvocation({
        stdout,
        stderr: '',
        exitCode: 1,
        rateLimit: { matched: true, cause: 'rate-limit' },
        auditEntry: null,
        auditWarnings: []
      });
      expect(result.kind).toBe('rate_limited');
      if (result.kind !== 'rate_limited') return;
      expect(result.resetsAtMs).toBe(future * 1000);
    });
  });
});
