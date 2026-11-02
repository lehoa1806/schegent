// Feature 251 (FR-R4-F04, contract T6, SC-011, FR-009, FR-030, FR-032, N1 to N4) — the retention inventory
// is checked against the real writers, from both ends.
//
// What it pins: in a temporary workspace the real writers (the transport store, the audit writer, the raw
// transcript writer, the failure recorder, the history description store, the metrics rollup writer and
// the runtime-log sink) create files, every file they created matches the `location` of at least one
// inventory row, and each row's bound states the value of the constant (or the settings default) its
// writer enforces. The rows' enumerated fields (`contentClass`, `sweptBy`, `onDelete`, `onExport`) are in
// their closed sets, every store §11 lists has a row, and N2, N3 and N4's decisions are stated in the
// words the contract fixes.
//
// Why: the filing's finding (O-12, O-15) is that the table listed nine stores while the product wrote
// more, and nothing compared the table with what is written. A path no row claims fails here by name.
// Each assertion that a row covers a file is paired with the control that the file exists.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { AuditLogWriter, AUDIT_ROTATION_DEFAULT_AGE_MS, AUDIT_ROTATION_DEFAULT_SIZE_BYTES } from '../../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import { SETTINGS_SCHEMA } from '../../../src/config/settings-schema';
import {
  FAILURE_RECORD_MAX_BYTES,
  FAILURE_RECORD_RETAINED_MAX
} from '../../../src/contracts/failure-record';
import { SanitizedLogger } from '../../../src/lib/logger';
import { RuntimeLogSink } from '../../../src/lib/runtime-log/runtime-log-sink';
import { MetricsRollupWriter, RETAINED_RECORDS_AFTER_TRIM, TRIM_THRESHOLD_BYTES } from '../../../src/metrics/metrics-rollup-writer';
import {
  TRANSPORT_FILE_MAX_BYTES,
  TRANSPORT_WORKSPACE_MAX_BYTES
} from '../../../src/monitor/transport/transport-policy';
import { createFailureRecorder } from '../../../src/services/failure-record/failure-record-service';
import { HISTORY_ORPHAN_GRACE_MS, HISTORY_SWEEP_MAX_REMOVALS, HistoryDescriptionStore } from '../../../src/services/history/history-description-store';
import { CHECKPOINT_MAX_AGE_MS, CHECKPOINT_MAX_TOTAL_BYTES } from '../../../src/services/run-checkpoint-retention';
import { renderRetentionDisclosure, retentionDisclosure, type RetentionInventoryRow } from '../../../src/services/retention-disclosure';
import { createTransportHarness, listFilesUnder, type TransportHarness } from '../monitor/transport/transport-harness';

const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const CONTENT_CLASSES = ['unredacted content', 'redacted content', 'metadata', 'state', 'recovery material'];
const SWEPT_BY = ['append', 'rotation', 'run-end', 'activation', 'settings-change', 'periodic', 'none'];
const ON_DELETE = ['removed', 'kept', 'kept (Run history)', 'n/a'];
const ON_EXPORT = ['included', 'included whole (shared)', 'omitted', 'n/a'];

/** §11's list: a store each row must cover, matched on the row's `store`. */
const REQUIRED_STORES: ReadonlyArray<readonly [string, RegExp]> = [
  ['audit log and archives', /audit log/i],
  ['cuts', /cuts/i],
  ['audit head checkpoint', /head checkpoint/i],
  ['audit generation sidecar', /generation sidecar/i],
  ['raw transcripts, retained', /raw.*transcript.*retained/i],
  ['raw transcripts, pending', /raw.*transcript.*pending/i],
  ['the raw OS-temp spool', /raw.*spool/i],
  ['Run diagnostics trees', /diagnostics/i],
  ['Run transport', /^Run transport/i],
  ['the transport stage', /transport stage/i],
  ['legacy transport generations', /legacy transport/i],
  ['failure records', /failure record/i],
  ['Run history descriptions', /history description/i],
  ['metrics rollup', /metrics rollup/i],
  ['runtime log', /runtime log/i],
  ['ownership records', /ownership/i],
  ['catalog', /catalog/i],
  ['.gitignore', /\.gitignore/i],
  ['recovery checkpoints', /recovery checkpoint/i],
  ['workspace memento state', /memento/i],
  ['the operator pseudonym', /pseudonym/i],
  ['export destinations', /export/i]
];

const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`;
const days = (ms: number): string => `${Math.round(ms / DAY_MS)} days`;
const grouped = (count: number): string => count.toLocaleString('en-US');
const settingDefault = (key: string): number => SETTINGS_SCHEMA[key]!.default as number;

/** The roots a location can start with outside the workspace; they are labels, never wildcards. */
const ROOT_LABELS = ['temp', 'globalStorage', 'workspaceState', 'destination'];
const SEGMENT_PLACEHOLDER = new RegExp(`<(?!(?:${ROOT_LABELS.join('|')})>)[^>]+>`, 'g');

/**
 * A row's `location` is one or more whitespace-separated path patterns; `<name>` stands for one segment's
 * worth, except a root label (`<temp>` and the like), which must appear literally. A root label that was a
 * wildcard would let any two-segment path under `.schegent/` match the destination row and hide a gap.
 */
function locationMatches(row: RetentionInventoryRow, relative: string): boolean {
  return row.location
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => {
      const pattern = token
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(SEGMENT_PLACEHOLDER, '[^/]+')
        .replace(/\*/g, '[^/]*');
      return new RegExp(`^${pattern}$`).test(relative);
    });
}

const rowsFor = (relative: string): RetentionInventoryRow[] => retentionDisclosure().filter((row) => locationMatches(row, relative));
const rowNamed = (pattern: RegExp): RetentionInventoryRow => {
  const row = retentionDisclosure().find((candidate) => pattern.test(candidate.store));
  if (row === undefined) throw new Error(`no inventory row matches ${pattern}`);
  return row;
};

let harness: TransportHarness;
/** Files the writers created, as inventory-style relative paths. */
let created: string[];

beforeAll(async () => {
  harness = await createTransportHarness({ setting: 'errors-only', rawMode: 'errors-only' });
  const workspaceRoot = harness.workspaceRoot;
  const logger = new SanitizedLogger([]);

  // Transport: a staged Run, one promoted to its Run file by a failed end, and a legacy generation an
  // earlier release left (no writer makes those any more, so the file is planted).
  harness.record('run-staged-251', 'a staged line');
  harness.record('run-failed-251', 'a failed line');
  await harness.flush();
  await harness.router.finalizeRun('run-failed-251', 'failed', new Set());
  await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, '.schegent', 'cli-transport.log'), '');
  await fs.writeFile(path.join(workspaceRoot, '.schegent', 'cli-transport.log.1'), '');

  // The audit log: a tiny size bound and one kept archive, so rotation leaves an archive, a cut record and
  // the generation sidecar beside the live log.
  const audit = new AuditLogWriter(
    {
      workspaceRoot,
      rotationSizeBytes: 1200,
      rotationMaxAgeMs: 365 * DAY_MS,
      retentionMaxArchives: 1,
      retentionMaxArchiveAgeMs: 365 * DAY_MS
    },
    logger
  );
  for (let n = 0; n < 8; n += 1) {
    await audit.append({
      runId: `run-${n}`,
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: { n },
      outcome: 'info'
    });
  }

  // The raw transcript writer: a pending transcript (errors-only), a retained one (always), and an open
  // spool capture under the harness's temp root.
  const raw = new RawTranscriptWriter(workspaceRoot, logger, harness.tempRoot);
  await raw.appendStart({ runId: 'run-pending-251', phase: 'speckit-plan', iteration: 1, prompt: 'p', mode: 'errors-only' });
  await raw.appendEnd({
    runId: 'run-pending-251', stdout: 'x', stderr: '', exitCode: 1, killed: false, timedOut: false, mode: 'errors-only'
  });
  await raw.appendStart({ runId: 'run-retained-251', phase: 'speckit-plan', iteration: 1, prompt: 'p', mode: 'always' });
  await raw.appendEnd({
    runId: 'run-retained-251', stdout: 'x', stderr: '', exitCode: 0, killed: false, timedOut: false, mode: 'always'
  });
  await raw.createInvocationCapture('run-spooled-251', 'errors-only');

  // The failure record, the history description, the metrics rollup and the runtime log.
  const recorder = createFailureRecorder({
    logger: { warn: vi.fn(), sanitize: (value: string) => logger.sanitize(value) },
    queue: { queueIdForExistingTask: () => 'default' },
    workspaceRoot,
    platform: 'linux'
  });
  await recorder.record({
    run: { id: 'run-failure-251', featureId: 'task-1', currentPhase: 'implement' },
    cause: 'last_phase_issues_remain',
    result: { kind: 'remaining_issues', issues: [{ tag: 'regression', summary: 'one case fails' }], auditEntry: null },
    iteration: 1,
    iterationCap: 3
  } as Parameters<typeof recorder.record>[0]);
  await new HistoryDescriptionStore({ workspaceRoot, logger: { warn: vi.fn() } as unknown as SanitizedLogger }).write(
    'run-history-251',
    'an operator description'
  );
  await new MetricsRollupWriter({ workspaceRoot, logger }).append({
    runId: 'run-rollup-251',
    terminalStatus: 'completed',
    startedAt: '2026-10-01T00:00:00.000Z',
    endedAt: '2026-10-01T00:05:00.000Z',
    durationMs: 300_000,
    phasesTotal: 1,
    phasesCompleted: 1,
    phasesSkipped: 0,
    backendInvocations: 1,
    costUsd: 0.1
  });
  const sink = new RuntimeLogSink({
    accessor: {
      read: () => ({ level: 'INFO', path: path.join(workspaceRoot, '.schegent', 'syslog'), maxBytes: 5 * MIB, maxGenerations: 3 })
    },
    fallbackLogger: logger
  });
  new SanitizedLogger([sink]).info('inventory-test line');
  await sink.flushAndDispose();

  const files = await listFilesUnder(workspaceRoot, harness.tempRoot);
  created = files.map((file) =>
    file.startsWith(workspaceRoot)
      ? path.relative(workspaceRoot, file).split(path.sep).join('/')
      : `<temp>/${path.relative(harness.tempRoot, file).split(path.sep).join('/')}`
  );
});

afterAll(async () => {
  await harness.dispose();
});

describe('every file the writers create has a row (SC-011)', () => {
  it('made files from every writer, so "every file" is not vacuous', () => {
    for (const marker of [
      /^\.schegent\/audit\.log$/,
      /^\.schegent\/audit\.log\.cuts$/,
      /^\.schegent\/audit-generation\.json$/,
      /^\.schegent\/sessions\/run-failed-251\/transport\.log$/,
      /^<temp>\/schegent-transport-[^/]+\/run-staged-251\.log$/,
      /^\.schegent\/sessions\/\.pending\/raw-run-pending-251\.log$/,
      /^\.schegent\/sessions\/raw-run-retained-251\.log$/,
      /^<temp>\/schegent-raw-spool-[^/]+\/stdout$/,
      /^\.schegent\/failure-records\//,
      /^\.schegent\/history\//,
      /^\.schegent\/metrics-rollup/,
      /^\.schegent\/syslog$/
    ]) {
      expect(
        created.some((file) => marker.test(file)),
        `no file matching ${marker} was created; created: ${created.join(', ')}`
      ).toBe(true);
    }
  });

  it('matches every created path to at least one row', () => {
    const unclaimed = created.filter((file) => rowsFor(file).length === 0);
    expect(unclaimed, `paths with no inventory row:\n${unclaimed.join('\n')}`).toEqual([]);
  });

  it.each([
    ['.schegent/audit.log.cuts', /cuts/i],
    ['.schegent/audit-generation.json', /generation sidecar/i],
    ['.schegent/sessions/run-x/transport.log', /^Run transport/i],
    ['.schegent/sessions/.pending/raw-run-x.log', /raw.*pending/i],
    ['.schegent/sessions/raw-run-x.log', /raw.*retained/i],
    ['.schegent/failure-records/failure-1.json', /failure record/i],
    ['.schegent/history/run-x.txt', /history description/i],
    ['.schegent/syslog', /runtime log/i]
  ])('claims %s with the row that names it', (file, store) => {
    expect(rowsFor(file).map((row) => row.store).some((name) => store.test(name)), `${file} is claimed by ${rowsFor(file).map((row) => row.store).join(' | ')}`).toBe(true);
  });
});

describe('every store §11 lists has a row (FR-009)', () => {
  it.each(REQUIRED_STORES)('has a row for %s', (_name, store) => {
    expect(retentionDisclosure().some((row) => store.test(row.store))).toBe(true);
  });

  it('has at least as many rows as §11 lists', () => {
    expect(retentionDisclosure().length).toBeGreaterThanOrEqual(REQUIRED_STORES.length);
  });
});

describe('the enumerated fields are in their closed sets (§11)', () => {
  it.each(retentionDisclosure().map((row) => [row.store, row] as const))('%s', (_store, row) => {
    expect(CONTENT_CLASSES).toContain(row.contentClass);
    expect(row.sweptBy.length, 'a row names how it is swept, or `none`').toBeGreaterThan(0);
    for (const sweep of row.sweptBy) expect(SWEPT_BY).toContain(sweep);
    expect(ON_DELETE).toContain(row.onDelete);
    expect(ON_EXPORT).toContain(row.onExport);
    expect(row.location.length).toBeGreaterThan(0);
    expect(row.bounds.length, `${row.store} needs a bound`).toBeGreaterThan(10);
    expect(row.liveProtection.length, `${row.store} needs a live-protection statement`).toBeGreaterThan(0);
    expect(row.source, `${row.store} must name where its bound came from`).toMatch(/\.ts|schegent\./);
    // `unredacted content` and `redacted: false` are one fact, stated twice: they cannot disagree.
    expect(row.contentClass === 'unredacted content' || row.contentClass === 'recovery material').toBe(!row.redacted);
  });

  it('keeps `none` alone in sweptBy', () => {
    for (const row of retentionDisclosure()) {
      if (row.sweptBy.includes('none')) expect(row.sweptBy, row.store).toEqual(['none']);
    }
  });

  it('never prints a resolved path in a location', () => {
    for (const row of retentionDisclosure()) {
      expect(row.location, row.store).not.toMatch(/\/Users\/|\/home\/|\/var\/folders\/|[A-Z]:\\/);
    }
  });
});

describe('a store the inventory says is swept at activation has the call that does it (FR-R4-F04 G1, G2)', () => {
  // The inventory is a promise to the operator, and two rows broke it in opposite directions. The history
  // descriptions were disclosed as swept at activation while nothing called the sweep. The audit log's
  // archives were pruned at activation, by the owner, and disclosed as pruned at rotation only. Each row is
  // tied to the call that makes its claim true, so removing the call (or the word) fails here by name.
  const CALL_SITES: ReadonlyArray<readonly [string, RegExp, string, string]> = [
    ['the audit log', /^Structured audit log/i, 'src/activation/stage2-producers.ts', 'auditWriter.runArchiveMaintenance()'],
    ['the history descriptions', /^Run history descriptions/i, 'src/activation/evidence-wiring.ts', 'await sweepHistoryDescriptions(']
  ];

  it.each(CALL_SITES)('%s names `activation`, and the call site is there', (_name, store, file, call) => {
    const row = retentionDisclosure().find((candidate) => store.test(candidate.store));
    expect(row, 'the row must exist').toBeDefined();
    expect(row?.sweptBy, 'the row must name the activation sweep').toContain('activation');
    const source = readFileSync(path.resolve(__dirname, '..', '..', '..', file), 'utf8');
    expect(source, `${file} must still make the call the row's "activation" rests on`).toContain(call);
  });
});

describe('each bound states the constant its writer enforces (N1)', () => {
  const cases: ReadonlyArray<readonly [string, RegExp, readonly string[]]> = [
    [
      'the audit log',
      /^Structured audit log/i,
      [mib(AUDIT_ROTATION_DEFAULT_SIZE_BYTES), days(AUDIT_ROTATION_DEFAULT_AGE_MS)]
    ],
    ['the metrics rollup (N2)', /metrics rollup/i, [grouped(RETAINED_RECORDS_AFTER_TRIM), mib(TRIM_THRESHOLD_BYTES), 'totals carried forward']],
    ['failure records', /failure record/i, [`${FAILURE_RECORD_RETAINED_MAX}`, `${FAILURE_RECORD_MAX_BYTES / 1024} KiB`]],
    ['history descriptions', /history description/i, [`${HISTORY_ORPHAN_GRACE_MS / HOUR_MS} hours`, `${HISTORY_SWEEP_MAX_REMOVALS}`]],
    [
      'the runtime log (N3)',
      /runtime log/i,
      [
        mib(settingDefault('schegent.logging.runtimeLogMaxBytes')),
        `${settingDefault('schegent.logging.runtimeLogMaxGenerations')} generations`,
        'no age bound, by decision'
      ]
    ],
    [
      'raw transcripts',
      /raw.*transcript.*retained/i,
      [`${settingDefault('schegent.logging.sessionRetentionMaxAgeDays')} days`, mib(settingDefault('schegent.logging.sessionRetentionMaxBytes'))]
    ],
    ['Run transport', /^Run transport/i, [mib(TRANSPORT_FILE_MAX_BYTES), mib(TRANSPORT_WORKSPACE_MAX_BYTES)]],
    ['recovery checkpoints', /recovery checkpoint/i, [days(CHECKPOINT_MAX_AGE_MS), mib(CHECKPOINT_MAX_TOTAL_BYTES)]]
  ];

  it.each(cases)('%s', (_name, store, expected) => {
    const row = rowNamed(store);
    for (const fragment of expected) {
      expect(row.bounds, `${row.store} bounds must contain "${fragment}"`).toContain(fragment);
    }
  });

  it('names the rollup trim in the words the contract fixes (N2)', () => {
    expect(rowNamed(/metrics rollup/i).bounds).toContain(
      `trimmed to the newest ${grouped(RETAINED_RECORDS_AFTER_TRIM)} records when it passes ${mib(TRIM_THRESHOLD_BYTES)}; totals carried forward`
    );
  });

  it('states the stall threshold is a constant, not a setting (N4)', () => {
    const rendered = renderRetentionDisclosure();
    expect(rendered).toMatch(/90-second stall threshold is a constant/i);
  });

  it('gives the runtime log a decision, with its reason (N3)', () => {
    const row = rowNamed(/runtime log/i);
    expect(row.bounds).toMatch(/sanitized host diagnostics/i);
    expect(row.sweptBy).not.toContain('periodic');
  });
});

describe('the rendering carries every row (T158)', () => {
  it('has one table line per row, plus a header and a rule', () => {
    const table = renderRetentionDisclosure()
      .split('\n')
      .filter((line) => line.startsWith('|'));
    expect(table).toHaveLength(retentionDisclosure().length + 2);
  });

  it('is wider than the old five columns', () => {
    const header = renderRetentionDisclosure().split('\n')[0]!;
    expect(header.split('|').length - 2).toBeGreaterThan(5);
    for (const column of ['Store', 'Location', 'Content', 'Bounds', 'Swept by', 'Live protection', 'On delete', 'On export', 'Derived from']) {
      expect(header).toContain(column);
    }
  });
});
