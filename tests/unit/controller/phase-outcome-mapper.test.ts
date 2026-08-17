import { describe, it, expect } from 'vitest';
import {
  mapOutcome,
  mapTerminationReason,
  summarize,
  STDOUT_SUMMARY_LIMIT,
  OUTPUT_TRUNCATED_WARNING
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
  }),
  truncated: (fatalCause?: string): InvocationResult => ({
    kind: 'malformed',
    warnings: [OUTPUT_TRUNCATED_WARNING],
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
  it('truncated output → transient_error, not failed', () => {
    // "We could not classify this output" is not "we classified it as a
    // failure". `transient_error` still halts the phase — it never
    // advances — but it takes the delayed-retry path instead of the
    // required-phase run-terminal halt, which used to discard the rest of
    // the pipeline for output volume alone.
    expect(mapOutcome(r.truncated(), 0)).toBe('transient_error');
    expect(mapOutcome(r.truncated(), 1)).toBe('transient_error');
    expect(mapOutcome(r.truncated(), null)).toBe('transient_error');
  });
  it('truncated output with a fatalCause → failed', () => {
    // Evidence outranks doubt: a fatal signature found by the runner's
    // incremental scan is terminal even though retention truncated.
    expect(mapOutcome(r.truncated('parse-fail'), 0)).toBe('failed');
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
  it('truncated output → error, matching its transient_error outcome', () => {
    // The two causes diverge in `mapOutcome` but agree here: the
    // 'transient_error' outcome's own reason is 'error' as well.
    expect(mapTerminationReason(r.truncated(), 0)).toBe('error');
    expect(mapTerminationReason(r.truncated('parse-fail'), 0)).toBe('error');
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

