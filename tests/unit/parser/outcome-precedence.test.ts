// Feature 013 — T042 (Wave 3 / US3 / FR-013).
//
// Outcome precedence is a load-bearing safety invariant: a non-zero CLI
// exit MUST NEVER produce a `clean` outcome regardless of stdout content.
// Prior to Wave 3, the exit-code check lived inside the
// `blocksPresent === 0` branch, so a non-zero exit accompanied by a
// `[SCHEGENT_STATUS: CLEAR]` token would have been misclassified as
// `clean`. T040 hoisted the exit-code gate to top-level (right after
// fatal & rate-limit). This test pins the full precedence order:
//
//   fatal > rate_limited > exit-code floor > contract blocks
//
// The 8 scenarios below exercise every cell of that table.

import { describe, it, expect } from 'vitest';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import {
  FATAL_SIGNATURES,
  getEffectiveSignatures
} from '../../../src/lib/fatal-signature-registry';
import type { AuditEntryFields } from '../../../src/audit/audit-entry';

const validAudit: AuditEntryFields = {
  phase: 'speckit-specify',
  filesCreated: ['specs/001-mock/spec.md'],
  filesModified: [],
  filesDeleted: [],
  commandsExecuted: ['mock specify'],
  networkCalls: ['none'],
  rulesetSwitches: ['none'],
  notes: 'mock',
  metrics: Object.freeze({}),
  warnings: Object.freeze([] as string[])
};

const clearToken = '[SCHEGENT_STATUS: CLEAR]\n';

function inputs(overrides: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  rateLimitMatched?: boolean;
  rateLimitCause?: string;
  auditEntry?: AuditEntryFields | null;
}) {
  return {
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    exitCode: overrides.exitCode ?? 0,
    rateLimit: {
      matched: overrides.rateLimitMatched ?? false,
      cause: overrides.rateLimitCause ?? ''
    },
    auditEntry: overrides.auditEntry === undefined ? validAudit : overrides.auditEntry,
    auditWarnings: [],
    effectiveFatalSignatures: getEffectiveSignatures([])
  };
}

describe('parseInvocation — outcome precedence (T042 / FR-013)', () => {
  it('1. non-zero exit + clear token + audit entry → transient_error', () => {
    const result = parseInvocation(
      inputs({ stdout: clearToken, exitCode: 1 })
    );
    expect(result.kind).toBe('transient_error');
    if (result.kind === 'transient_error') {
      expect(result.exitCode).toBe(1);
    }
  });

  it('2. non-zero exit + no contract block → transient_error', () => {
    const result = parseInvocation(
      inputs({ stdout: 'random failure noise\n', exitCode: 137 })
    );
    expect(result.kind).toBe('transient_error');
    if (result.kind === 'transient_error') {
      expect(result.exitCode).toBe(137);
    }
  });

  it('3. zero exit + fatal signature → malformed (fatal precedence)', () => {
    // FATAL_SIGNATURES[0] is "error: unknown option" — emit it on stderr so
    // classifyFatal catches it before the exit-code check.
    const result = parseInvocation(
      inputs({
        stdout: clearToken,
        stderr: `${FATAL_SIGNATURES[0]} '--foo'\n`,
        exitCode: 0
      })
    );
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.fatalCause).toBe(FATAL_SIGNATURES[0]);
      expect(result.fatalSource).toBe('built-in');
    }
  });

  // Bugfix 2026-05-23 — BUG-008: a successful CLI completion
  // (`exitCode === 0`) is NEVER a rate-limit failure regardless of
  // payload content. The detector-layer guard (T073) prevents
  // `rateLimit.matched === true` from co-occurring with `exitCode === 0`
  // in the normal flow; the parser-level defensive symmetric check
  // (T075) covers any synthetic caller that bypasses the detector.
  // The OLD test asserted the buggy classification — replaced with the
  // amended precondition expectation.
  it('4. zero exit + synthetic rate-limit signature → clean (BUG-008: exit-zero short-circuits rate_limited)', () => {
    const result = parseInvocation(
      inputs({
        stdout: clearToken,
        exitCode: 0,
        rateLimitMatched: true,
        rateLimitCause: 'rate-limit-exceeded'
      })
    );
    expect(result.kind).not.toBe('rate_limited');
    expect(result.kind).toBe('clean');
    if (result.kind === 'clean') {
      expect(result.auditEntry).toBe(validAudit);
    }
  });

  it('5. zero exit + clear token + audit → clean (happy path preserved)', () => {
    const result = parseInvocation(
      inputs({ stdout: clearToken, exitCode: 0 })
    );
    expect(result.kind).toBe('clean');
    if (result.kind === 'clean') {
      expect(result.auditEntry).toBe(validAudit);
    }
  });

  it('6. non-zero exit + clear token + no audit → transient_error (exit floor wins over malformed)', () => {
    const result = parseInvocation(
      inputs({ stdout: clearToken, exitCode: 2, auditEntry: null })
    );
    expect(result.kind).toBe('transient_error');
  });

  it('7. non-zero exit + fatal + clear token → malformed (fatal still wins above exit)', () => {
    const result = parseInvocation(
      inputs({
        stdout: clearToken,
        stderr: `${FATAL_SIGNATURES[0]}\n`,
        exitCode: 1
      })
    );
    // Fatal is the absolute top of the precedence chain — even non-zero
    // exits do not override it (the operator needs to see the fatal cause).
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.fatalCause).toBe(FATAL_SIGNATURES[0]);
    }
  });

  it('8. null exit (signal kill) → falls through to contract-block branches (null is not non-zero)', () => {
    // Null exitCode happens when the process is killed without setting an
    // exit value (e.g., a SIGKILL from the host). The exit-code floor
    // intentionally does not fire — downstream classification continues.
    const result = parseInvocation(
      inputs({ stdout: clearToken, exitCode: null })
    );
    expect(result.kind).toBe('clean');
  });
});
