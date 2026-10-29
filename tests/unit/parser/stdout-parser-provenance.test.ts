/**
 * FR-R4-F15 (feature 243) — contract T1: the parser marks the two issues the host substitutes.
 *
 * `specs/243-retained-failure-diagnostics/contracts/tags-and-phase-text.md` T6.1 and T6.2, and T6.3
 * (the shared blank-line fixture through the parser and the record builder), which is added with the
 * builder. An agent's own `[constitution]` bullet is a claim like any other; only the host's
 * substitutes carry `source: 'host'`, and the carried prompt text is byte-identical either way.
 */
import { describe, it, expect } from 'vitest';
import { NO_REGION } from '../../../src/parser/audit-log-parser';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import type { InvocationResult, ParseInputs } from '../../../src/parser/stdout-parser';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import { buildFailureRecord } from '../../../src/services/failure-record/record-builder';
import {
  expectedParse,
  stdout as blankLineStdout,
  unreadBulletTexts
} from '../../fixtures/parser/remaining-issues-blank-line';

const REST: Omit<ParseInputs, 'stdout' | 'exitCode'> = {
  stderr: '',
  rateLimit: { matched: false, cause: '' },
  auditEntry: null,
  auditWarnings: [],
  region: NO_REGION
};

type ParsedIssue = { tag?: string; summary: string; source?: 'host' };

function issuesOf(result: InvocationResult): ParsedIssue[] {
  if (result.kind !== 'remaining_issues') throw new Error(`expected remaining_issues, got ${result.kind}`);
  return result.issues as ParsedIssue[];
}

describe('parser provenance (T6.1)', () => {
  it('marks the no-contract-block substitute as host', () => {
    const result = parseInvocation({ ...REST, stdout: 'finished, nothing to report', exitCode: 0 });
    expect(issuesOf(result)).toEqual([
      { tag: 'constitution', summary: 'no contract block detected', source: 'host' }
    ]);
  });

  it('marks the missing-evidence substitute as host', () => {
    const result = parseInvocation({
      ...REST,
      stdout: 'all done\n[SCHEGENT_STATUS: CLEAR]\n',
      exitCode: 0,
      evidencePolicy: 'required',
      evidencePolicyDeclaredAt: 'phase-definition'
    });
    expect(issuesOf(result)).toEqual([
      {
        tag: 'constitution',
        summary: 'this Phase declares evidencePolicy required and produced no audit block',
        source: 'host'
      }
    ]);
  });

  it('leaves agent bullets without a source key, the agent constitution bullet included', () => {
    const stdout = [
      'Remaining issues:',
      '- [constitution] x',
      '- [needs-decision] y',
      '- z'
    ].join('\n');
    const issues = issuesOf(parseInvocation({ ...REST, stdout, exitCode: 0 }));
    expect(issues).toEqual([
      { tag: 'constitution', summary: 'x' },
      { tag: 'needs-decision', summary: 'y' },
      { summary: 'z' }
    ]);
    for (const issue of issues) expect('source' in issue).toBe(false);
  });

  it('does not set a source on any open question', () => {
    const result = parseInvocation({
      ...REST,
      stdout: ['Open questions:', '- which branch?'].join('\n'),
      exitCode: 0
    });
    expect(result).toMatchObject({ kind: 'open_questions', questions: ['which branch?'] });
    expect(JSON.stringify(result)).not.toContain('"source"');
  });

  it('control: a blank line after the heading still yields the host substitute, not agent bullets', () => {
    const stdout = ['Remaining issues:', '', '- [regression] a'].join('\n');
    const issues = issuesOf(parseInvocation({ ...REST, stdout, exitCode: 0 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('host');
  });
});

describe('carried prompt text is unchanged by provenance (T6.2, pin)', () => {
  const builder = new PromptBuilder();
  const base = {
    phase: 'speckit-analyze' as const,
    iteration: 2,
    iterationCap: 10,
    featureDescription: 'desc',
    featureDir: null
  };

  it('renders byte-identical text for carried issues with and without source host', () => {
    const plain: ParsedIssue[] = [
      { tag: 'constitution', summary: 'no contract block detected' },
      { tag: 'regression', summary: 'one case fails' },
      { summary: 'untagged' }
    ];
    const marked: ParsedIssue[] = plain.map((issue, index) =>
      index === 0 ? { ...issue, source: 'host' } : issue
    );
    expect(builder.build({ ...base, carriedIssues: marked })).toBe(
      builder.build({ ...base, carriedIssues: plain })
    );
  });

  it('control: the carried issue text is present, so equality is not vacuous', () => {
    const prompt = builder.build({
      ...base,
      carriedIssues: [{ tag: 'constitution', summary: 'no contract block detected', source: 'host' } as ParsedIssue]
    });
    expect(prompt).toContain('- [constitution] no contract block detected\n');
    expect(prompt).not.toContain('source: host');
    expect(prompt).not.toContain('[host]');
  });
});

describe('the shared blank-line fixture (T6.3, FR-027)', () => {
  const logger = new SanitizedLogger([]);
  const context = {
    queueId: 'default',
    failedAt: '2026-10-28T14:30:05.123Z',
    suffix: '0a1b2c3d',
    sanitize: (value: string): string => logger.sanitize(value),
    workspaceRoot: '/ws/proj',
    platform: 'linux' as NodeJS.Platform
  };
  const run = { id: 'run-1', featureId: 'task-1', currentPhase: 'implement' };

  function recordFor(stdout: string) {
    const result = parseInvocation({ ...REST, stdout, exitCode: 0 });
    const record = buildFailureRecord({ run, cause: 'last_phase_issues_remain', result }, context);
    return { result, record };
  }

  it('parses to the fixture\'s expected value, which FR-R4-104 owns', () => {
    expect(parseInvocation({ ...REST, stdout: blankLineStdout, exitCode: 0 })).toEqual(expectedParse);
  });

  it('builds a record with exactly one host entry and neither agent bullet anywhere', () => {
    const { record } = recordFor(blankLineStdout);
    expect(record?.issueState).toBe('listed');
    expect(record?.entries).toEqual([
      { kind: 'issue', summary: 'no contract block detected', tag: 'constitution', source: 'host' }
    ]);
    const text = JSON.stringify(record);
    for (const bullet of unreadBulletTexts) expect(text).not.toContain(bullet);
  });

  it('control: the same stdout without the blank line yields two agent entries', () => {
    const withoutBlank = blankLineStdout.replace('Remaining issues:\n\n', 'Remaining issues:\n');
    expect(withoutBlank).not.toBe(blankLineStdout);
    const { record } = recordFor(withoutBlank);
    expect(record?.entries.map((entry) => [entry.tag, entry.source, entry.summary])).toEqual([
      ['regression', 'agent', unreadBulletTexts[0]],
      ['needs-decision', 'agent', unreadBulletTexts[1]]
    ]);
  });
});
