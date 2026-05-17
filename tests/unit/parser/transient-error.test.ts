// Feature 011 — FR-001 disjoint classification invariant.
//
// Every non-zero CLI exit must map to EXACTLY ONE of:
//   1. `fatal_cli`     — classifyFatal matched (feature 010 fail-fast)
//   2. `rate_limit`    — rateLimit.matched (60-min delayed retry)
//   3. `transient_error` — all others (15-min delayed retry)
//
// A clean exit (exitCode 0 with a contract block) must map to NONE of
// these classes.

import { describe, it, expect } from 'vitest';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import type { ParseInputs } from '../../../src/parser/stdout-parser';
import type { AuditEntryFields } from '../../../src/audit/audit-entry';

function baseInputs(overrides: Partial<ParseInputs> = {}): ParseInputs {
  const audit: AuditEntryFields = {
    phase: 'speckit-specify',
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    commandsExecuted: [],
    networkCalls: [],
    rulesetSwitches: [],
    notes: '',
    metrics: {},
    warnings: []
  };
  return {
    stdout: '',
    stderr: '',
    exitCode: 1,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit,
    auditWarnings: [],
    ...overrides
  };
}

describe('FR-001 disjoint classification (transient-error vs fatal vs rate-limit vs clean)', () => {
  it('clean exit with [SCHEGENT_STATUS: DONE] is `clean` (not transient_error)', () => {
    const result = parseInvocation(
      baseInputs({
        stdout: '[SCHEGENT_STATUS: DONE]\n',
        exitCode: 0
      })
    );
    expect(result.kind).toBe('clean');
  });

  it('non-zero exit with no fatal signature, no rate-limit, no block → `transient_error`', () => {
    const result = parseInvocation(baseInputs({ exitCode: 1 }));
    expect(result.kind).toBe('transient_error');
    if (result.kind === 'transient_error') {
      expect(result.exitCode).toBe(1);
    }
  });

  it('non-zero exit with a registered fatal signature → `malformed` (fatal_cli path, takes precedence)', () => {
    const result = parseInvocation(
      baseInputs({
        stderr: "error: unknown option",
        exitCode: 1
      })
    );
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.fatalCause).toBeTruthy();
    }
  });

  it('non-zero exit with rateLimit.matched=true → `rate_limited` (takes precedence over transient_error)', () => {
    const result = parseInvocation(
      baseInputs({
        exitCode: 1,
        rateLimit: { matched: true, cause: 'over-rate-limit' }
      })
    );
    expect(result.kind).toBe('rate_limited');
  });

  it('exit code 0 without a contract block does NOT classify as transient_error', () => {
    // Per stdout-parser.ts logic, blocksPresent === 0 + exitCode 0 falls through
    // to remaining_issues constitution-contract path (not transient_error).
    const result = parseInvocation(baseInputs({ exitCode: 0 }));
    expect(result.kind).not.toBe('transient_error');
  });

  it('null exit code with no blocks does NOT classify as transient_error', () => {
    // Per stdout-parser.ts logic: exitCode === null fails the `exitCode !== 0`
    // gate and falls through to the constitution-contract path.
    const result = parseInvocation(baseInputs({ exitCode: null }));
    expect(result.kind).not.toBe('transient_error');
  });

  it('disjointness: a transient_error result is mutually exclusive with malformed/rate_limited/clean', () => {
    const result = parseInvocation(baseInputs({ exitCode: 1 }));
    expect(result.kind).toBe('transient_error');
    expect(['malformed', 'rate_limited', 'clean']).not.toContain(result.kind);
  });
});
