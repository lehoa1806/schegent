import { describe, it, expect } from 'vitest';
import {
  extractOpenQuestions,
  extractRemainingIssues,
  parseInvocation
} from '../../../src/parser/stdout-parser';
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

describe('extractOpenQuestions', () => {
  it('extracts dash-bulleted questions under "Open questions:"', () => {
    const stdout = ['Open questions:', '- What auth method?', '- Multi-tenant?'].join('\n');
    expect(extractOpenQuestions(stdout)).toEqual(['What auth method?', 'Multi-tenant?']);
  });

  it('accepts the heading variant "Remaining clarifications:"', () => {
    const stdout = ['Remaining clarifications:', '* Field length?'].join('\n');
    expect(extractOpenQuestions(stdout)).toEqual(['Field length?']);
  });

  it('supports numbered bullets', () => {
    const stdout = ['Open questions:', '1. First?', '2. Second?'].join('\n');
    expect(extractOpenQuestions(stdout)).toEqual(['First?', 'Second?']);
  });

  it('stops at a blank line', () => {
    const stdout = ['Open questions:', '- Q1', '', '- not part of the list'].join('\n');
    expect(extractOpenQuestions(stdout)).toEqual(['Q1']);
  });

  it('returns an empty array when the heading is absent', () => {
    expect(extractOpenQuestions('Just some output')).toEqual([]);
  });

  it('is case-insensitive on the heading', () => {
    const stdout = ['OPEN QUESTIONS:', '- Q1'].join('\n');
    expect(extractOpenQuestions(stdout)).toEqual(['Q1']);
  });
});

describe('extractRemainingIssues', () => {
  it('extracts plain bullets without tags', () => {
    const stdout = ['Remaining issues:', '- Spec inconsistency', '- Missing acceptance criteria'].join('\n');
    expect(extractRemainingIssues(stdout)).toEqual([
      { summary: 'Spec inconsistency' },
      { summary: 'Missing acceptance criteria' }
    ]);
  });

  it('extracts tagged bullets with category prefixes', () => {
    const stdout = ['Remaining issues:', '- [coverage] missing edge case', '- [duplication] FR-001 redundant'].join('\n');
    expect(extractRemainingIssues(stdout)).toEqual([
      { tag: 'coverage', summary: 'missing edge case' },
      { tag: 'duplication', summary: 'FR-001 redundant' }
    ]);
  });

  it('accepts the "Failed with N errors" heading variant', () => {
    const stdout = ['Failed with 2 errors:', '- broken parser', '- missing import'].join('\n');
    expect(extractRemainingIssues(stdout)).toEqual([
      { summary: 'broken parser' },
      { summary: 'missing import' }
    ]);
  });

  it('returns an empty array when no heading is present', () => {
    expect(extractRemainingIssues('All good')).toEqual([]);
  });
});

describe('parseInvocation — block mutual exclusion and edge cases', () => {
  it('returns clean when termination token is alone with audit', () => {
    const stdout = ['work done', '[SCHEGENT_STATUS: CLEAR]'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('clean');
  });

  it('returns clean with missing audit entry when token present but audit missing', () => {
    const result = parseInvocation({
      stdout: '[SCHEGENT_STATUS: CLEAR]',
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: null,
      auditWarnings: []
    });
    expect(result.kind).toBe('clean');
    if (result.kind === 'clean') {
      expect(result.auditEntry).toBeNull();
    }
  });

  it('returns open_questions when only the open-questions block is present', () => {
    const stdout = ['Open questions:', '- need more detail'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('open_questions');
    if (result.kind === 'open_questions') {
      expect(result.questions).toEqual(['need more detail']);
    }
  });

  it('returns remaining_issues when only the remaining-issues block is present', () => {
    const stdout = ['Remaining issues:', '- [coverage] gap A'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('remaining_issues');
    if (result.kind === 'remaining_issues') {
      expect(result.issues).toEqual([{ tag: 'coverage', summary: 'gap A' }]);
    }
  });

  it('returns rate_limited when rateLimit matched, regardless of body', () => {
    const result = parseInvocation({
      stdout: '[SCHEGENT_STATUS: CLEAR]',
      stderr: '429 too many requests',
      exitCode: 1,
      rateLimit: { matched: true, cause: 'rate_limit' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('rate_limited');
  });

  it('reports remaining_issues with constitution warning when no block detected', () => {
    const result = parseInvocation({
      stdout: 'no contract block here',
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('remaining_issues');
    if (result.kind === 'remaining_issues') {
      expect(result.issues[0].tag).toBe('constitution');
    }
  });

  it('warns when multiple contract blocks coexist but still resolves', () => {
    const stdout = ['[SCHEGENT_STATUS: CLEAR]', 'Open questions:', '- ambiguous'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('clean');
  });
});

describe('parseInvocation — fatal-signature precedence (010, T011/T014)', () => {
  const FATAL_TEXT = "error: unknown option";

  it('classifies fatal stderr ahead of a valid CLEAR contract block, regardless of exit code 0', () => {
    const stdout = ['work done', '[SCHEGENT_STATUS: CLEAR]'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: FATAL_TEXT,
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.fatalCause).toBe(FATAL_TEXT);
      expect(result.warnings).toContain(FATAL_TEXT);
    }
  });

  it('classifies fatal stderr ahead of CLEAR with non-zero exit', () => {
    const stdout = '[SCHEGENT_STATUS: CLEAR]';
    const result = parseInvocation({
      stdout,
      stderr: FATAL_TEXT,
      exitCode: 1,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.fatalCause).toBe(FATAL_TEXT);
    }
  });

  it('preserves clean classification when no fatal signature matches', () => {
    const stdout = ['[SCHEGENT_STATUS: CLEAR]'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: 'noise without the fatal substring',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('clean');
  });

  it('preserves open_questions classification when no fatal signature matches', () => {
    const stdout = ['Open questions:', '- pending'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('open_questions');
  });

  it('preserves remaining_issues classification when no fatal signature matches', () => {
    const stdout = ['Remaining issues:', '- [coverage] gap'].join('\n');
    const result = parseInvocation({
      stdout,
      stderr: '',
      exitCode: 0,
      rateLimit: { matched: false, cause: '' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('remaining_issues');
  });

  // T014: precedence over rate-limit recovery.
  it('beats rate-limit recovery when both signatures appear (T014)', () => {
    const result = parseInvocation({
      stdout: '',
      stderr: `${FATAL_TEXT} ... and also 429 too many requests`,
      exitCode: 1,
      rateLimit: { matched: true, cause: 'rate-limit' },
      auditEntry: validAudit,
      auditWarnings: []
    });
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.fatalCause).toBe(FATAL_TEXT);
    }
  });
});
