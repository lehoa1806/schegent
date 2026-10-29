/**
 * FR-R4-F15 (feature 243) — contract R: the failure record's shape, its closed sets, its file name
 * and the one validator the host reader and the webview share.
 *
 * `specs/243-retained-failure-diagnostics/contracts/failure-record.md` R4.1 to R4.7. Each row of
 * the V table in `data-model.md` §4 has one case that violates it alone, so a validator that stops
 * checking a rule fails exactly one `it`.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_ISSUE_TAGS,
  FAILURE_RECORD_MAX_BYTES,
  FAILURE_RECORD_MAX_ENTRIES,
  FAILURE_RECORD_MAX_METRICS,
  FAILURE_RECORD_METRIC_KEY_MAX,
  FAILURE_RECORD_SUMMARY_MAX,
  HOST_ISSUE_TAGS,
  normalizeIssueTag,
  recordFileName,
  type FailureRecordV1,
  type RecordEntry
} from '../../../src/contracts/failure-record';
import { isValidFailureRecord, parseRecordName } from '../../../src/contracts/validators/failure-record';

const FAILED_AT = '2026-10-28T14:30:05.123Z';
const MAX_ID = 'a'.repeat(64);

function validRecord(overrides: Record<string, unknown> = {}): FailureRecordV1 {
  return {
    recordVersion: 1,
    queueId: 'default',
    taskId: 'task-1',
    runId: 'run-1',
    failedAt: FAILED_AT,
    suffix: '0a1b2c3d',
    cause: 'last_phase_issues_remain',
    phase: 'implement',
    iteration: 2,
    iterationCap: 3,
    stalledCount: 0,
    issueState: 'listed',
    entries: [{ kind: 'issue', summary: 'one case still fails', tag: 'regression', source: 'agent' }],
    omittedIssueCount: 0,
    metrics: [{ key: 'tests_failed', value: 1 }],
    omittedMetricCount: 0,
    ...overrides
  } as FailureRecordV1;
}

function entry(overrides: Record<string, unknown> = {}): RecordEntry {
  return { kind: 'issue', summary: 'x', tag: 'unclassified', source: 'agent', ...overrides } as RecordEntry;
}

function without(record: FailureRecordV1, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

describe('contract R - tag normalization (R4.1, R4.2)', () => {
  it('R4.1 every agent tag is kept for an agent issue and every host tag for a host issue', () => {
    for (const tag of AGENT_ISSUE_TAGS) expect(normalizeIssueTag(tag, 'agent')).toBe(tag);
    for (const tag of HOST_ISSUE_TAGS) expect(normalizeIssueTag(tag, 'host')).toBe(tag);
  });

  it('R4.1 a host issue never keeps an agent tag, and an agent issue never keeps a host tag', () => {
    for (const tag of AGENT_ISSUE_TAGS) expect(normalizeIssueTag(tag, 'host')).toBe('unclassified');
    for (const tag of HOST_ISSUE_TAGS) expect(normalizeIssueTag(tag, 'agent')).toBe('unclassified');
  });

  it('R4.1 a host issue with no tag is unclassified', () => {
    expect(normalizeIssueTag(undefined, 'host')).toBe('unclassified');
  });

  it.each(['constitution', 'blocker', 'Regression', 'needs_approval', '', ' regression'])(
    'R4.2 the agent tag %j is unclassified',
    (tag) => {
      expect(normalizeIssueTag(tag, 'agent')).toBe('unclassified');
    }
  );

  it('R4.2 a missing agent tag is unclassified', () => {
    expect(normalizeIssueTag(undefined, 'agent')).toBe('unclassified');
  });
});

describe('contract R - file name (R4.3, R4.4)', () => {
  const typical = { failedAt: FAILED_AT, suffix: '0a1b2c3d', runId: 'run-1', taskId: 'task-1' };
  const longest = { failedAt: '2026-01-02T03:04:05.006Z', suffix: 'ffffffff', runId: MAX_ID, taskId: MAX_ID };
  const identities = [
    typical,
    longest,
    { failedAt: '1999-12-31T23:59:59.999Z', suffix: '00000000', runId: 'R', taskId: '9' }
  ];

  it.each(identities)('R4.3 round trips %j', (identity) => {
    const name = recordFileName(identity);
    expect(name).not.toBeNull();
    const parsed = parseRecordName(name as string);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      suffix: identity.suffix,
      runId: identity.runId,
      taskId: identity.taskId,
      failedAtMs: Date.parse(identity.failedAt)
    });
  });

  it('R4.3 writes the stamp as YYYYMMDDTHHmmssSSSZ in UTC', () => {
    expect(recordFileName(typical)).toBe('20261028T143005123Z_0a1b2c3d_run-1_task-1.json');
  });

  it('R4.3 the longest name is 163 characters', () => {
    expect(recordFileName(longest)).toHaveLength(163);
  });

  it.each([
    ['an underscore in the run id', { runId: 'run_1' }],
    ['a dot-dot run id', { runId: '..' }],
    ['a path separator in the task id', { taskId: 'a/b' }],
    ['a backslash in the task id', { taskId: 'a\\b' }],
    ['an uppercase suffix', { suffix: '0A1B2C3D' }],
    ['a short suffix', { suffix: 'abc' }],
    ['an empty run id', { runId: '' }],
    ['a 65-character task id', { taskId: 'a'.repeat(65) }],
    ['an unparseable time', { failedAt: 'yesterday' }]
  ])('R4.4 refuses %s when naming', (_label, patch) => {
    expect(recordFileName({ ...typical, ...patch })).toBeNull();
  });

  it.each([
    'x.json',
    '.pending',
    'notes.txt',
    '20261028T143005123Z_0a1b2c3d_run-1_task-1.json.tmp',
    '20261028T143005123Z_0a1b2c3d_run-1_task-1_extra.json',
    '20261028T143005123Z_0A1B2C3D_run-1_task-1.json',
    '20261028T143005123Z_0a1b2c3d_run-1_task-1.lock',
    '20261028T143005123Z_0a1b2c3d_run-1_task-1.json/',
    '../20261028T143005123Z_0a1b2c3d_run-1_task-1.json',
    '20261328T143005123Z_0a1b2c3d_run-1_task-1.json',
    ''
  ])('R4.4 %j does not parse as a record name', (name) => {
    expect(parseRecordName(name)).toBeNull();
  });
});

describe('contract R - the validator accepts a record at each bound (R4.5)', () => {
  it('R4.5 accepts a typical record', () => {
    expect(isValidFailureRecord(validRecord())).toBe(true);
  });

  it('R4.5 accepts 20 entries of 240 code points, astral ones included, and 16 metrics with 64-character keys, within 32,768 bytes', () => {
    const astral = '\u{1F600}'.repeat(FAILURE_RECORD_SUMMARY_MAX);
    expect(Array.from(astral)).toHaveLength(240);
    const entries = Array.from({ length: FAILURE_RECORD_MAX_ENTRIES }, () =>
      entry({ summary: astral, tag: 'needs-decision' })
    );
    const metrics = Array.from({ length: FAILURE_RECORD_MAX_METRICS }, (_, index) => ({
      key: `${String.fromCharCode(97 + index)}${'k'.repeat(FAILURE_RECORD_METRIC_KEY_MAX - 1)}`,
      value: -1.7976931348623157e308
    }));
    const record = validRecord({ entries, metrics, omittedIssueCount: 480, omittedMetricCount: 4 });
    expect(isValidFailureRecord(record)).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(record, null, 2) + '\n');
    expect(bytes).toBeLessThanOrEqual(FAILURE_RECORD_MAX_BYTES);
  });

  it('R4.5 accepts each issue state with its entry count', () => {
    for (const state of ['none-reported', 'unparsed'] as const) {
      expect(isValidFailureRecord(validRecord({ issueState: state, entries: [] }))).toBe(true);
    }
    const notApplicable = without(
      validRecord({ issueState: 'not-applicable', entries: [] }),
      'phase',
      'iteration',
      'iterationCap',
      'stalledCount'
    );
    expect(isValidFailureRecord(notApplicable)).toBe(true);
  });

  it('R4.5 accepts a record with no phase context at all when a phase result exists', () => {
    const bare = without(validRecord(), 'phase', 'iteration', 'iterationCap', 'stalledCount');
    expect(isValidFailureRecord(bare)).toBe(true);
  });

  it('R4.5 accepts a question and a host entry in their own forms', () => {
    const entries = [
      entry({ kind: 'question', summary: 'which branch?' }),
      entry({ summary: 'no contract block detected', tag: 'constitution', source: 'host' })
    ];
    expect(isValidFailureRecord(validRecord({ entries }))).toBe(true);
  });

  it('R4.5 accepts the name it was read from, and refuses another', () => {
    const name = recordFileName({ failedAt: FAILED_AT, suffix: '0a1b2c3d', runId: 'run-1', taskId: 'task-1' });
    const parsed = parseRecordName(name as string);
    expect(isValidFailureRecord(validRecord(), parsed ?? undefined)).toBe(true);
    expect(isValidFailureRecord(validRecord({ runId: 'run-2' }), parsed ?? undefined)).toBe(false);
    expect(isValidFailureRecord(validRecord({ taskId: 'task-2' }), parsed ?? undefined)).toBe(false);
    expect(isValidFailureRecord(validRecord({ suffix: 'ffffffff' }), parsed ?? undefined)).toBe(false);
    expect(
      isValidFailureRecord(validRecord({ failedAt: '2026-10-28T14:30:05.124Z' }), parsed ?? undefined)
    ).toBe(false);
  });
});

describe('contract R - each rule violated once (R4.6)', () => {
  const twentyOne = Array.from({ length: 21 }, () => entry());
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['21 entries', validRecord({ entries: twentyOne, omittedIssueCount: 0 })],
    ['a 241-code-point summary', validRecord({ entries: [entry({ summary: 'a'.repeat(241) })] })],
    ['an empty summary', validRecord({ entries: [entry({ summary: '' })] })],
    ['a control character in a summary', validRecord({ entries: [entry({ summary: 'a\u0007b' })] })],
    ['a format character in a summary', validRecord({ entries: [entry({ summary: 'a‮b' })] })],
    ['a line separator in a summary', validRecord({ entries: [entry({ summary: 'a b' })] })],
    ['a host source with an agent tag', validRecord({ entries: [entry({ tag: 'regression', source: 'host' })] })],
    ['an agent source with the constitution tag', validRecord({ entries: [entry({ tag: 'constitution' })] })],
    ['a tag outside the closed set', validRecord({ entries: [entry({ tag: 'blocker' })] })],
    ['a source outside the closed set', validRecord({ entries: [entry({ source: 'operator' })] })],
    ['a question with a tag', validRecord({ entries: [entry({ kind: 'question', tag: 'regression' })] })],
    ['a question from the host', validRecord({ entries: [entry({ kind: 'question', tag: 'unclassified', source: 'host' })] })],
    ['an entry kind outside the closed set', validRecord({ entries: [entry({ kind: 'warning' })] })],
    ['an entry with an extra key', validRecord({ entries: [entry({ extra: 1 })] })],
    ['an extra key', validRecord({ transcript: 'x' })],
    ['recordVersion 2', validRecord({ recordVersion: 2 })],
    ['a missing recordVersion', without(validRecord(), 'recordVersion')],
    ['a missing runId', without(validRecord(), 'runId')],
    ['a non-finite metric', validRecord({ metrics: [{ key: 'a', value: Number.NaN }] })],
    ['an infinite metric', validRecord({ metrics: [{ key: 'a', value: Number.POSITIVE_INFINITY }] })],
    ['a string metric value', validRecord({ metrics: [{ key: 'a', value: '1' }] })],
    ['unsorted metric keys', validRecord({ metrics: [{ key: 'b', value: 1 }, { key: 'a', value: 2 }] })],
    ['duplicate metric keys', validRecord({ metrics: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] })],
    ['a metric key with a space', validRecord({ metrics: [{ key: 'a b', value: 1 }] })],
    ['a metric key starting with a digit', validRecord({ metrics: [{ key: '1a', value: 1 }] })],
    ['a 65-character metric key', validRecord({ metrics: [{ key: 'a'.repeat(65), value: 1 }] })],
    [
      '17 metrics',
      validRecord({
        metrics: Array.from({ length: 17 }, (_, index) => ({ key: `k${String(index).padStart(2, '0')}`, value: 1 }))
      })
    ],
    ['a phase field with not-applicable', validRecord({ issueState: 'not-applicable', entries: [] })],
    [
      'an iteration field with not-applicable',
      without(validRecord({ issueState: 'not-applicable', entries: [] }), 'phase', 'iterationCap', 'stalledCount')
    ],
    ['entries with none-reported', validRecord({ issueState: 'none-reported' })],
    ['no entries with listed', validRecord({ entries: [] })],
    ['an unknown issue state', validRecord({ issueState: 'maybe' })],
    ['an unknown cause', validRecord({ cause: 'because' })],
    ['a queue id that is dot-dot', validRecord({ queueId: '..' })],
    ['a queue id with a slash', validRecord({ queueId: 'a/b' })],
    ['a task id with an underscore', validRecord({ taskId: 'task_1' })],
    ['a run id of 65 characters', validRecord({ runId: 'a'.repeat(65) })],
    ['a suffix in uppercase', validRecord({ suffix: '0A1B2C3D' })],
    ['a failedAt that does not round trip', validRecord({ failedAt: '2026-10-28T14:30:05Z' })],
    ['a failedAt that is not a date', validRecord({ failedAt: 'tomorrow' })],
    ['a phase with a slash', validRecord({ phase: 'a/b' })],
    ['an iteration of 0', validRecord({ iteration: 0 })],
    ['a fractional iteration cap', validRecord({ iterationCap: 1.5 })],
    ['a negative stall count', validRecord({ stalledCount: -1 })],
    ['a negative omitted issue count', validRecord({ omittedIssueCount: -1 })],
    ['a fractional omitted metric count', validRecord({ omittedMetricCount: 0.5 })],
    ['an unsafe omitted count', validRecord({ omittedIssueCount: Number.MAX_SAFE_INTEGER + 2 })]
  ];

  it.each(cases)('R4.6 refuses %s', (_label, value) => {
    expect(isValidFailureRecord(value)).toBe(false);
  });

  it('R4.6 control: the unmodified record is valid, so a refusal above names its own rule', () => {
    expect(isValidFailureRecord(validRecord())).toBe(true);
  });
});

describe('contract R - hostile values (R4.7)', () => {
  it('R4.7 refuses a getter and does not run it', () => {
    let ran = false;
    const hostile = { ...validRecord() } as Record<string, unknown>;
    Object.defineProperty(hostile, 'queueId', {
      enumerable: true,
      get() {
        ran = true;
        return 'default';
      }
    });
    expect(isValidFailureRecord(hostile)).toBe(false);
    expect(ran).toBe(false);
  });

  it('R4.7 refuses a getter inside an entry and inside the entries array', () => {
    const inner = entry();
    Object.defineProperty(inner, 'summary', { enumerable: true, get: () => 'x' });
    expect(isValidFailureRecord(validRecord({ entries: [inner] }))).toBe(false);
    const entries: unknown[] = [];
    Object.defineProperty(entries, '0', { enumerable: true, get: () => entry() });
    expect(isValidFailureRecord(validRecord({ entries }))).toBe(false);
  });

  it('R4.7 refuses an array where the object belongs, null and primitives', () => {
    for (const value of [[], [validRecord()], null, undefined, 'record', 7, true]) {
      expect(isValidFailureRecord(value)).toBe(false);
    }
  });

  it('R4.7 refuses an own __proto__ key', () => {
    const parsed: unknown = JSON.parse(JSON.stringify(validRecord()).replace('{', '{"__proto__":{"x":1},'));
    expect(isValidFailureRecord(parsed)).toBe(false);
  });

  it('R4.7 refuses an object with another prototype', () => {
    class Other {}
    const hostile = Object.assign(new Other(), validRecord());
    expect(isValidFailureRecord(hostile)).toBe(false);
  });

  it('R4.7 does not throw for a proxy that throws on every trap', () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        }
      }
    );
    expect(() => isValidFailureRecord(proxy)).not.toThrow();
    expect(isValidFailureRecord(proxy)).toBe(false);
  });

  it('R4.7 does not throw for a cycle', () => {
    const cyclic = validRecord() as unknown as Record<string, unknown>;
    cyclic['self'] = cyclic;
    expect(isValidFailureRecord(cyclic)).toBe(false);
  });
});
