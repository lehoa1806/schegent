import { describe, it, expect } from 'vitest';
import {
  mapOutcome,
  mapTerminationReason,
  summarize,
  truncationFields,
  STDOUT_SUMMARY_LIMIT
} from '../../../src/controller/phase-outcome-mapper';
import type { InvocationResult } from '../../../src/parser/stdout-parser';
import type { AuditEntryFields } from '../../../src/audit/audit-entry';

const cleanAudit = (): AuditEntryFields => ({
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
});

const r = {
  clean: (): InvocationResult => ({ kind: 'clean', auditEntry: cleanAudit() }),
  openQuestions: (): InvocationResult => ({
    kind: 'open_questions',
    questions: ['q'],
    auditEntry: null
  }),
  remainingIssues: (): InvocationResult => ({
    kind: 'remaining_issues',
    issues: [{ summary: 's' }],
    auditEntry: null
  }),
  rateLimited: (): InvocationResult => ({
    kind: 'rate_limited',
    cause: 'usage_limit',
    auditEntry: null
  }),
  transientError: (): InvocationResult => ({
    kind: 'transient_error',
    exitCode: 1,
    auditEntry: null
  }),
  malformed: (fatalCause?: string): InvocationResult => ({
    kind: 'malformed',
    warnings: [],
    auditEntry: null,
    ...(fatalCause ? { fatalCause, fatalSource: 'built-in' as const } : {})
  })
};

describe('mapOutcome', () => {
  it('clean → clean', () => {
    expect(mapOutcome(r.clean(), 0)).toBe('clean');
  });
  it('open_questions → issues_remain', () => {
    expect(mapOutcome(r.openQuestions(), 0)).toBe('issues_remain');
  });
  it('remaining_issues → issues_remain', () => {
    expect(mapOutcome(r.remainingIssues(), 0)).toBe('issues_remain');
  });
  it('rate_limited → rate_limited', () => {
    expect(mapOutcome(r.rateLimited(), 0)).toBe('rate_limited');
  });
  it('transient_error → transient_error', () => {
    expect(mapOutcome(r.transientError(), 1)).toBe('transient_error');
  });
  it('malformed with fatalCause → failed (regardless of exitCode)', () => {
    expect(mapOutcome(r.malformed('parse-fail'), 0)).toBe('failed');
    expect(mapOutcome(r.malformed('parse-fail'), 1)).toBe('failed');
    expect(mapOutcome(r.malformed('parse-fail'), null)).toBe('failed');
  });
  it('malformed without fatalCause + non-zero exitCode → failed', () => {
    expect(mapOutcome(r.malformed(), 1)).toBe('failed');
  });
  it('malformed without fatalCause + zero exitCode → issues_remain', () => {
    expect(mapOutcome(r.malformed(), 0)).toBe('issues_remain');
  });
  it('malformed without fatalCause + null exitCode → issues_remain', () => {
    expect(mapOutcome(r.malformed(), null)).toBe('issues_remain');
  });
});

describe('mapTerminationReason', () => {
  it('clean → token', () => {
    expect(mapTerminationReason(r.clean(), 0)).toBe('token');
  });
  it('open_questions → open_questions', () => {
    expect(mapTerminationReason(r.openQuestions(), 0)).toBe('open_questions');
  });
  it('remaining_issues → remaining_issues', () => {
    expect(mapTerminationReason(r.remainingIssues(), 0)).toBe('remaining_issues');
  });
  it('rate_limited → rate_limit', () => {
    expect(mapTerminationReason(r.rateLimited(), 0)).toBe('rate_limit');
  });
  it('transient_error → error', () => {
    expect(mapTerminationReason(r.transientError(), 1)).toBe('error');
  });
  it('malformed with fatalCause → error', () => {
    expect(mapTerminationReason(r.malformed('parse-fail'), 0)).toBe('error');
  });
  it('malformed without fatalCause + non-zero exitCode → error', () => {
    expect(mapTerminationReason(r.malformed(), 1)).toBe('error');
  });
  it('malformed without fatalCause + zero exitCode → remaining_issues', () => {
    expect(mapTerminationReason(r.malformed(), 0)).toBe('remaining_issues');
  });
  it('malformed without fatalCause + null exitCode → remaining_issues', () => {
    expect(mapTerminationReason(r.malformed(), null)).toBe('remaining_issues');
  });
});

describe('summarize / STDOUT_SUMMARY_LIMIT', () => {
  it('STDOUT_SUMMARY_LIMIT equals 4 KiB', () => {
    expect(STDOUT_SUMMARY_LIMIT).toBe(4 * 1024);
  });
  it('empty input → empty output', () => {
    expect(summarize('')).toBe('');
  });
  it('input shorter than limit → identity', () => {
    expect(summarize('hello')).toBe('hello');
  });
  it('input equal to limit → identity', () => {
    const text = 'a'.repeat(STDOUT_SUMMARY_LIMIT);
    expect(summarize(text)).toBe(text);
    expect(summarize(text).length).toBe(STDOUT_SUMMARY_LIMIT);
  });
  it('input longer than limit → truncated to limit', () => {
    const text = 'a'.repeat(STDOUT_SUMMARY_LIMIT + 1000);
    expect(summarize(text).length).toBe(STDOUT_SUMMARY_LIMIT);
  });
});

describe('truncationFields', () => {
  it('returns empty object when neither flag is true', () => {
    expect(truncationFields({})).toEqual({});
    expect(truncationFields({ stdoutTruncated: false, stderrTruncated: false })).toEqual({});
  });
  it('sets stdoutTruncated only when raw.stdoutTruncated is true', () => {
    expect(truncationFields({ stdoutTruncated: true })).toEqual({ stdoutTruncated: true });
  });
  it('sets stderrTruncated only when raw.stderrTruncated is true', () => {
    expect(truncationFields({ stderrTruncated: true })).toEqual({ stderrTruncated: true });
  });
  it('sets both when both are true', () => {
    expect(truncationFields({ stdoutTruncated: true, stderrTruncated: true })).toEqual({
      stdoutTruncated: true,
      stderrTruncated: true
    });
  });
});
