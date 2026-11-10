// FR-R6-F11 — shared live-report fixtures for the export tests (T028..T032).
import type { ReportQuery } from '../../../src/contracts/reporting/report-query';
import type { ReportRow, RootRow, UsageRow } from '../../../src/contracts/reporting/report-rows';
import type { LiveReport } from '../../../src/services/reporting/report-snapshots';

export const EXPORT_REPORT_ID = 'a'.repeat(32);
export const EXPORT_CUTOFF_MS = 1_800_000_000_000;

const BIDI_OVERRIDE = String.fromCodePoint(0x202e);

export function rootRow(rootId: string, workflowId: string, durationMs: number | null): RootRow {
  return Object.freeze({
    kind: 'root',
    rootId,
    workflowId,
    frozenDefinitionId: null,
    outcome: 'succeeded',
    createdUtc: '2027-01-15T08:00:00.000Z',
    durationMs,
    attempts: 1
  });
}

/** Two roots, one with a formula-like, bidirectional workflow name and an unknown duration. */
export const HOSTILE_ROOT_ROWS: readonly ReportRow[] = Object.freeze([
  rootRow('r1', 'build', 1_200),
  rootRow('r2', '=HYPERLINK("x")' + BIDI_OVERRIDE + 'evil', null)
]);

/** One usage row whose cost total is beyond 2^53 and whose token total is exact. */
export const UNSAFE_USAGE_ROW: UsageRow = Object.freeze({
  kind: 'usage',
  key: Object.freeze({ backend: 'claude', model: null }),
  attempts: 2,
  roots: 1,
  measures: Object.freeze([
    Object.freeze({
      measure: 'input_tokens',
      unit: 'count',
      total: '12',
      completeness: 'known',
      coverage: Object.freeze({ known: 2, denominator: 2 })
    }),
    Object.freeze({
      measure: 'cost',
      unit: 'usd',
      total: '90071992547409930.123456',
      reportedTotal: '90071992547409930.123456',
      estimatedTotal: '0.000000',
      completeness: 'partial',
      coverage: Object.freeze({ known: 1, denominator: 2 })
    })
  ]),
  invocations: 'not-recorded'
});

export function reportQuery(view: ReportQuery['view'] = 'attempt-detail'): ReportQuery {
  return Object.freeze({
    view,
    range: Object.freeze({ startMs: EXPORT_CUTOFF_MS - 86_400_000, endMs: EXPORT_CUTOFF_MS }),
    timezone: 'UTC',
    filters: Object.freeze({}),
    groupBy: Object.freeze([]),
    sort: 'root-created-desc',
    pageSize: 50
  });
}

export function liveReport(rows: readonly ReportRow[], overrides: Partial<LiveReport> = {}): LiveReport {
  return Object.freeze({
    reportId: EXPORT_REPORT_ID,
    query: reportQuery(),
    queryDigest: 'd'.repeat(64),
    populationDigest: 'p'.repeat(64),
    sourceCutoffMs: EXPORT_CUTOFF_MS,
    accountingRevision: null,
    calculationVersion: 1,
    roots: Object.freeze([]),
    attempts: Object.freeze([]),
    rows,
    coverage: Object.freeze({ roots: rows.length, attempts: rows.length, unknownDurations: 1 }),
    timeBasis: 'root-created',
    omissions: Object.freeze([Object.freeze({ what: 'accountingRevision', reason: 'accounting-unavailable' })]),
    ...overrides
  });
}
