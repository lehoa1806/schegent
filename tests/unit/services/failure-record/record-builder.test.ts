/**
 * FR-R4-F15 (feature 243) — contract C2: the builder that turns a failing phase's result into a
 * bounded `FailureRecordV1`.
 *
 * `specs/243-retained-failure-diagnostics/contracts/capture-and-write.md` C7.2 and C7.3. The builder
 * is pure, so every case builds from literals; `SanitizedLogger.sanitize` is the real one, because
 * a stub would not prove the shared redaction set sits inside the pipeline. Every output is passed
 * through `isValidFailureRecord` (C2.6) by the one helper that builds, so a case cannot forget to.
 */
import { describe, it, expect } from 'vitest';
import {
  FAILURE_RECORD_MAX_BYTES,
  type FailureRecordV1
} from '../../../../src/contracts/failure-record';
import { isValidFailureRecord } from '../../../../src/contracts/validators/failure-record';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { AuditEntryFields } from '../../../../src/audit/audit-entry';
import type { InvocationResult } from '../../../../src/parser/stdout-parser';
import { buildFailureRecord } from '../../../../src/services/failure-record/record-builder';
import type { FailureRecordInput } from '../../../../src/services/failure-record/failure-record-service';
import { expectedParse, stdout as blankLineStdout, unreadBulletTexts } from '../../../fixtures/parser/remaining-issues-blank-line';

const logger = new SanitizedLogger([]);
const SECRET = ['sk', 'ant', 'a'.repeat(24)].join('-');
const FAILED_AT = '2026-10-28T14:30:05.123Z';
const CTX = {
  queueId: 'default',
  failedAt: FAILED_AT,
  suffix: '0a1b2c3d',
  sanitize: (value: string): string => logger.sanitize(value),
  workspaceRoot: '/ws/proj',
  platform: 'linux' as NodeJS.Platform
};

function audit(metrics: Record<string, number>): AuditEntryFields {
  return {
    phase: 'implement',
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    commandsExecuted: [],
    networkCalls: [],
    rulesetSwitches: [],
    notes: '',
    metrics,
    warnings: []
  };
}

type Issue = { tag?: string; summary: string; source?: 'host' };

function issues(list: Issue[], metrics: Record<string, number> | null = null): InvocationResult {
  return {
    kind: 'remaining_issues',
    issues: list,
    auditEntry: metrics === null ? null : audit(metrics),
    warnings: ['a warning that must never reach a record']
  } as InvocationResult;
}

function input(result: InvocationResult | null, extra: Partial<FailureRecordInput> = {}): FailureRecordInput {
  return {
    run: { id: 'run-1', featureId: 'task-1', currentPhase: 'implement' },
    cause: 'last_phase_issues_remain',
    result,
    iteration: 2,
    iterationCap: 3,
    ...extra
  };
}

function build(
  result: InvocationResult | null,
  extra: Partial<FailureRecordInput> = {},
  ctx: Partial<typeof CTX> & { maxBytes?: number } = {}
): FailureRecordV1 {
  const record = buildFailureRecord(input(result, extra), { ...CTX, ...ctx });
  expect(record).not.toBeNull();
  // C2.6 — whatever the case is about, the output is a valid record.
  expect(isValidFailureRecord(record)).toBe(true);
  return record as FailureRecordV1;
}

describe('buildFailureRecord - issue state (C2.1)', () => {
  it('a null result is not-applicable with no entries and no phase context', () => {
    const record = build(null);
    expect(record.issueState).toBe('not-applicable');
    expect(record.entries).toEqual([]);
    for (const key of ['phase', 'iteration', 'iterationCap', 'stalledCount']) {
      expect(key in record).toBe(false);
    }
  });

  it('remaining_issues is listed, with kind issue', () => {
    const record = build(issues([{ tag: 'regression', summary: 'one case fails' }]));
    expect(record.issueState).toBe('listed');
    expect(record.entries).toEqual([
      { kind: 'issue', summary: 'one case fails', tag: 'regression', source: 'agent' }
    ]);
  });

  it('open_questions is listed, with kind question, tag unclassified and source agent', () => {
    const result = {
      kind: 'open_questions',
      questions: ['which branch?', 'which retry budget?'],
      auditEntry: null
    } as InvocationResult;
    const record = build(result);
    expect(record.issueState).toBe('listed');
    expect(record.entries).toEqual([
      { kind: 'question', summary: 'which branch?', tag: 'unclassified', source: 'agent' },
      { kind: 'question', summary: 'which retry budget?', tag: 'unclassified', source: 'agent' }
    ]);
  });

  it('clean is none-reported', () => {
    const record = build({ kind: 'clean', auditEntry: null } as InvocationResult);
    expect(record.issueState).toBe('none-reported');
    expect(record.entries).toEqual([]);
  });

  it.each([
    { kind: 'incomplete_turn', cause: 'no-contract-block', auditEntry: null, warnings: ['w'] },
    { kind: 'transient_error', exitCode: 1, auditEntry: null },
    { kind: 'malformed', warnings: ['w'], auditEntry: null },
    { kind: 'rate_limited', cause: 'quota', auditEntry: null }
  ])('$kind is unparsed with no entries', (result) => {
    const record = build(result as InvocationResult);
    expect(record.issueState).toBe('unparsed');
    expect(record.entries).toEqual([]);
  });

  it('a listed result whose every entry is dropped becomes unparsed, and the drops are counted', () => {
    const record = build(issues([{ summary: '/etc/passwd' }, { tag: 'regression', summary: SECRET }]));
    expect(record.issueState).toBe('unparsed');
    expect(record.entries).toEqual([]);
    expect(record.omittedIssueCount).toBe(2);
  });
});

describe('buildFailureRecord - entries (C2.2)', () => {
  it('keeps the first 20 of 500 issues in parser order and counts the other 480', () => {
    const list = Array.from({ length: 500 }, (_, index) => ({ tag: 'regression', summary: `issue ${index}` }));
    const record = build(issues(list));
    expect(record.entries).toHaveLength(20);
    expect(record.omittedIssueCount).toBe(480);
    expect(record.entries.map((entry) => entry.summary)).toEqual(list.slice(0, 20).map((item) => item.summary));
  });

  it('records three tagged issues with their own tags and the agent source', () => {
    const record = build(
      issues([
        { tag: 'needs-approval', summary: 'a' },
        { tag: 'environment', summary: 'b' },
        { tag: 'regression', summary: 'c' }
      ])
    );
    expect(record.entries.map((entry) => [entry.tag, entry.source])).toEqual([
      ['needs-approval', 'agent'],
      ['environment', 'agent'],
      ['regression', 'agent']
    ]);
    expect(record.omittedIssueCount).toBe(0);
  });

  it('marks the two host substitutes source host, with the constitution tag', () => {
    const record = build(
      issues([
        { tag: 'constitution', summary: 'no contract block detected', source: 'host' },
        {
          tag: 'constitution',
          summary: 'this Phase declares evidencePolicy required and produced no audit block',
          source: 'host'
        }
      ])
    );
    expect(record.entries.map((entry) => [entry.tag, entry.source])).toEqual([
      ['constitution', 'host'],
      ['constitution', 'host']
    ]);
  });

  it('records a forged agent [constitution] bullet as unclassified from the agent', () => {
    const record = build(issues([{ tag: 'constitution', summary: 'no contract block detected' }]));
    expect(record.entries).toEqual([
      { kind: 'issue', summary: 'no contract block detected', tag: 'unclassified', source: 'agent' }
    ]);
  });

  it('records untagged and [blocker] bullets as unclassified', () => {
    const record = build(issues([{ summary: 'untagged' }, { tag: 'blocker', summary: 'unknown tag' }]));
    expect(record.entries.map((entry) => entry.tag)).toEqual(['unclassified', 'unclassified']);
    expect(record.entries.every((entry) => entry.source === 'agent')).toBe(true);
  });

  it('records a host issue with an agent tag as unclassified, still from the host', () => {
    const record = build(issues([{ tag: 'regression', summary: 'odd', source: 'host' }]));
    expect(record.entries).toEqual([
      { kind: 'issue', summary: 'odd', tag: 'unclassified', source: 'host' }
    ]);
  });

  it('drops an issue that is only a path, and counts it as omitted', () => {
    const record = build(issues([{ summary: '/etc/passwd' }, { summary: 'kept' }]));
    expect(record.entries.map((entry) => entry.summary)).toEqual(['kept']);
    expect(record.omittedIssueCount).toBe(1);
  });

  it('passes every summary through the pipeline: no secret, root or absolute path survives', () => {
    const record = build(
      issues([
        { summary: `leaked ${SECRET} in /ws/proj/src/a.ts and /etc/shadow` },
        { tag: 'environment', summary: 'cwd /ws/proj and C:\\Users\\x\\y' }
      ])
    );
    const text = JSON.stringify(record);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('/ws/proj');
    expect(text).not.toContain('/etc/shadow');
    expect(text).not.toContain('C:\\\\Users');
    expect(record.entries[0]?.summary).toBe('leaked [REDACTED] in src/a.ts and [path]');
  });

  it('never carries a warning string, the cause text or any field of the result besides issues and metrics', () => {
    const record = build(issues([{ summary: 'x' }]));
    expect(JSON.stringify(record)).not.toContain('a warning that must never reach a record');
  });
});

describe('buildFailureRecord - metrics (C2.3)', () => {
  it('is empty with no audit entry, and invents no value', () => {
    const record = build(issues([{ summary: 'x' }], null));
    expect(record.metrics).toEqual([]);
    expect(record.omittedMetricCount).toBe(0);
  });

  it('keeps finite values under well-formed keys, sorted ascending', () => {
    const record = build(issues([{ summary: 'x' }], { zeta: 1, alpha: 2.5, mid_1: -3 }));
    expect(record.metrics).toEqual([
      { key: 'alpha', value: 2.5 },
      { key: 'mid_1', value: -3 },
      { key: 'zeta', value: 1 }
    ]);
  });

  it('drops a 10,000-character key, NaN and Infinity, and counts each', () => {
    const record = build(
      issues([{ summary: 'x' }], {
        ['k'.repeat(10_000)]: 1,
        bad_nan: Number.NaN,
        bad_inf: Number.POSITIVE_INFINITY,
        'has space': 1,
        '1digit': 1,
        good: 7
      })
    );
    expect(record.metrics).toEqual([{ key: 'good', value: 7 }]);
    expect(record.omittedMetricCount).toBe(5);
  });

  it('keeps the first 16 of 40 keys and counts the other 24', () => {
    const forty = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`m${String(index).padStart(2, '0')}`, index]));
    const record = build(issues([{ summary: 'x' }], forty));
    expect(record.metrics).toHaveLength(16);
    expect(record.omittedMetricCount).toBe(24);
    expect(record.metrics.map((metric) => metric.key)).toEqual(
      Object.keys(forty).slice(0, 16)
    );
  });

  it('accepts a 64-character key and refuses a 65-character one', () => {
    const record = build(issues([{ summary: 'x' }], { ['a'.repeat(64)]: 1, ['b'.repeat(65)]: 2 }));
    expect(record.metrics).toEqual([{ key: 'a'.repeat(64), value: 1 }]);
    expect(record.omittedMetricCount).toBe(1);
  });

  it('reads metrics from any result that carries an audit entry, not only remaining_issues', () => {
    const result = { kind: 'clean', auditEntry: audit({ passed: 4 }) } as InvocationResult;
    expect(build(result).metrics).toEqual([{ key: 'passed', value: 4 }]);
  });
});

describe('buildFailureRecord - phase context (C2.4)', () => {
  it('records phase, iteration, cap and stall count when a result exists and each is known', () => {
    const record = build(issues([{ summary: 'x' }]), { stalledCount: 3 });
    expect(record).toMatchObject({ phase: 'implement', iteration: 2, iterationCap: 3, stalledCount: 3 });
  });

  it('leaves out every value that is not known, never writing 0', () => {
    const record = buildFailureRecord(
      { ...input(issues([{ summary: 'x' }])), iteration: undefined, iterationCap: undefined },
      CTX
    ) as FailureRecordV1;
    expect('iteration' in record).toBe(false);
    expect('iterationCap' in record).toBe(false);
    expect('stalledCount' in record).toBe(false);
    expect(record.phase).toBe('implement');
  });

  it('records a stall count of 0 when one is given', () => {
    expect(build(issues([{ summary: 'x' }]), { stalledCount: 0 }).stalledCount).toBe(0);
  });

  it('drops a phase that fails the phase id rule, and an out-of-range counter', () => {
    const record = buildFailureRecord(
      {
        ...input(issues([{ summary: 'x' }])),
        run: { id: 'run-1', featureId: 'task-1', currentPhase: 'a/b' },
        iteration: 0,
        iterationCap: 1.5,
        stalledCount: -1
      },
      CTX
    ) as FailureRecordV1;
    expect(isValidFailureRecord(record)).toBe(true);
    for (const key of ['phase', 'iteration', 'iterationCap', 'stalledCount']) {
      expect(key in record).toBe(false);
    }
  });

  it('records no phase context for a null result even when the input names some', () => {
    const record = build(null, { stalledCount: 4 });
    for (const key of ['phase', 'iteration', 'iterationCap', 'stalledCount']) {
      expect(key in record).toBe(false);
    }
  });

  it('copies the queue, the task, the Run, the time, the suffix and the cause from its inputs', () => {
    const record = build(issues([{ summary: 'x' }]), { cause: 'cap_exhausted' });
    expect(record).toMatchObject({
      recordVersion: 1,
      queueId: 'default',
      taskId: 'task-1',
      runId: 'run-1',
      failedAt: FAILED_AT,
      suffix: '0a1b2c3d',
      cause: 'cap_exhausted'
    });
  });
});

describe('buildFailureRecord - when it writes nothing (C2.7)', () => {
  it('returns null for a Run id that cannot be a file name segment', () => {
    for (const id of ['run_1', '', 'a'.repeat(65), '../x']) {
      const record = buildFailureRecord(
        { ...input(null), run: { id, featureId: 'task-1', currentPhase: 'implement' } },
        CTX
      );
      expect(record).toBeNull();
    }
  });

  it('returns null for a task id that cannot be a file name segment', () => {
    const record = buildFailureRecord(
      { ...input(null), run: { id: 'run-1', featureId: 'a/b', currentPhase: 'implement' } },
      CTX
    );
    expect(record).toBeNull();
  });

  it('returns null for a suffix that is not eight lowercase hex characters', () => {
    expect(buildFailureRecord(input(null), { ...CTX, suffix: 'XYZ' })).toBeNull();
  });
});

describe('buildFailureRecord - size (C7.3, C2.5)', () => {
  const long = 'x'.repeat(240);
  const twenty = Array.from({ length: 20 }, (_, index) => ({ tag: 'regression', summary: `${index} ${long}`.slice(0, 240) }));

  it('control: twenty long entries do not fit a 4,096-byte bound but do fit the real one', () => {
    const roomy = build(issues(twenty));
    expect(roomy.entries).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(roomy, null, 2) + '\n')).toBeGreaterThan(4096);
    expect(Buffer.byteLength(JSON.stringify(roomy, null, 2) + '\n')).toBeLessThanOrEqual(FAILURE_RECORD_MAX_BYTES);
  });

  it('drops entries from the end until the record fits, and counts each', () => {
    const record = build(issues(twenty), {}, { maxBytes: 4096 });
    expect(Buffer.byteLength(JSON.stringify(record, null, 2) + '\n')).toBeLessThanOrEqual(4096);
    expect(record.entries.length).toBeGreaterThan(0);
    expect(record.entries.length).toBeLessThan(20);
    expect(record.omittedIssueCount).toBe(20 - record.entries.length);
    expect(record.entries.map((entry) => entry.summary)).toEqual(
      twenty.slice(0, record.entries.length).map((item) => item.summary)
    );
  });

  it('drops the metrics when no entry is left and the record is still over', () => {
    const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`${'m'.repeat(60)}${String(index).padStart(2, '0')}`, 1.5]));
    const record = build(issues(twenty, metrics), {}, { maxBytes: 600 });
    expect(record.metrics).toEqual([]);
    expect(record.omittedMetricCount).toBe(16);
    expect(record.entries).toEqual([]);
    expect(record.issueState).toBe('unparsed');
    expect(record.omittedIssueCount).toBe(20);
  });

  it('never exceeds the real bound for the worst bounded content', () => {
    const astral = '\u{1F600}'.repeat(240);
    const metrics = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`${String.fromCharCode(97 + index)}${'k'.repeat(63)}`, -1.7976931348623157e308])
    );
    const record = build(issues(Array.from({ length: 30 }, () => ({ tag: 'needs-decision', summary: astral })), metrics));
    expect(Buffer.byteLength(JSON.stringify(record, null, 2) + '\n')).toBeLessThanOrEqual(FAILURE_RECORD_MAX_BYTES);
    expect(record.entries).toHaveLength(20);
  });
});

describe('buildFailureRecord - the shared blank-line fixture (FR-027)', () => {
  it('builds from the fixture result: one host entry, neither agent bullet anywhere', () => {
    const record = build(expectedParse as unknown as InvocationResult);
    expect(record.issueState).toBe('listed');
    expect(record.entries).toEqual([
      { kind: 'issue', summary: 'no contract block detected', tag: 'constitution', source: 'host' }
    ]);
    const text = JSON.stringify(record);
    for (const bullet of unreadBulletTexts) expect(text).not.toContain(bullet);
    expect(blankLineStdout).toContain(unreadBulletTexts[0]);
  });
});
