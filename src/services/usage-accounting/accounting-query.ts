/**
 * FR-R6-F06 (FR-017, FR-018, FR-022, NFR-003) — bounded, revisioned aggregate reads.
 *
 * Every read is pinned to one committed revision: a contribution counts when it was opened at or
 * before that revision and not closed by it. Sums are exact: SQLite adds the int64 quantities
 * with `SUM`, which raises on overflow (never `TOTAL`, which rounds through a double), and the
 * text form is parsed as a bigint. An overflow is refused as `aggregate-overflow`.
 *
 * Rows are keyset-paged over the group key. A cursor pins its revision, so later pages read the
 * same snapshot as the first.
 *
 * Decisions (recorded in the feature review):
 * - The time range is half-open over the attempt's first event time.
 * - A row's attempts are those with any contribution visible at the revision.
 * - Coverage counts attempts, not contributions: an attempt is known for a measure only when
 *   every one of its invocations has a known, reported value.
 * - Occupancy measures report the latest known value by attempt event time, never a sum.
 * - The attempt dimensions (outcome included) are the current values, not as-of values.
 * - `unattributedCount` and `gaps` are current counts, not as-of counts.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  ACCOUNTING_CALCULATION_VERSION,
  ACCOUNTING_POLICY_VERSION,
  ATTEMPT_OUTCOMES,
  GAP_KINDS,
  MEASURES,
  OCCUPANCY_MEASURES,
  type AccountingBounds,
  type AccountingResult,
  type Completeness,
  type GapKind,
  type Measure,
  type Reconciliation
} from '../../contracts/usage-accounting/accounting-types';
import {
  DIMENSION_VALUE_PATTERNS,
  MAX_REPORTED_GAP_KINDS,
  type AccountingDimension,
  type AccountingGapRow,
  type AccountingMeasureTotal,
  type AccountingQueryRequest,
  type AccountingQueryResponse,
  type AccountingRow,
  type GapSummary,
  type LegacyEpochSummary,
  type ReadGapsRequest,
  type ReadGapsResponse
} from '../../contracts/usage-accounting/query-contract';
import type { NodeSqliteConnection } from '../sqlite-store';
import { compactionFloor } from './accounting-retention';
import { formatMicros, parseSumText } from './exact-quantities';
import { latestRevision } from './projection';

export interface QueryContext {
  readonly bounds: AccountingBounds;
  readonly monotonicMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

type SqlParam = string | number | bigint | null;
type Refusal<T> = AccountingResult<T> & { readonly ok: false };

const CURSOR_VERSION = '1';
const CURSOR_SEPARATOR = '~';
const MONEY_MEASURES: ReadonlySet<Measure> = new Set<Measure>(['cost', 'credits']);
const OCCUPANCY_LIST = [...OCCUPANCY_MEASURES].map((measure) => `'${measure}'`).join(', ');
const VISIBLE = 'c.from_revision <= ? AND (c.to_revision IS NULL OR c.to_revision > ?)';
const OVERFLOW_MESSAGE = /integer overflow/i;

const DIMENSION_SQL: Readonly<Record<AccountingDimension, string>> = {
  backend: 'a.backend',
  model: 'a.model',
  workflowRevision: 'a.workflow_revision',
  phaseId: 'a.phase_id',
  attemptOutcome: 'a.outcome',
  utcDay: 'substr(a.first_event_utc, 1, 10)'
};

function refuse<T>(code: 'invalid-query' | 'aggregate-overflow' | 'deadline-exceeded' | 'response-too-large', detail?: string): Refusal<T> {
  return { ok: false, refusal: detail === undefined ? { code } : { code, detail } };
}

function isDimensionValue(dimension: AccountingDimension, value: string): boolean {
  switch (dimension) {
    case 'backend':
      return DIMENSION_VALUE_PATTERNS.backend.test(value);
    case 'model':
      return DIMENSION_VALUE_PATTERNS.model.test(value);
    case 'workflowRevision':
    case 'phaseId':
      return DIMENSION_VALUE_PATTERNS.identifier.test(value);
    case 'attemptOutcome':
      return (ATTEMPT_OUTCOMES as readonly string[]).includes(value);
    case 'utcDay':
      return DIMENSION_VALUE_PATTERNS.utcDay.test(value);
  }
}

interface DecodedCursor {
  readonly revision: number;
  readonly keys: readonly string[];
}

/** `1~<revision>~<key>...`; an empty key is the null bucket. */
function decodeQueryCursor(cursor: string, groupBy: readonly AccountingDimension[]): DecodedCursor | undefined {
  const parts = cursor.split(CURSOR_SEPARATOR);
  if (parts.length !== groupBy.length + 2 || parts.at(0) !== CURSOR_VERSION) return undefined;
  const revisionText = parts.at(1) ?? '';
  if (!/^[1-9]\d{0,15}$/.test(revisionText)) return undefined;
  const keys = parts.slice(2);
  const valid = keys.every((key, index) => key === '' || isDimensionValue(groupBy.at(index) as AccountingDimension, key));
  return valid ? { revision: Number(revisionText), keys } : undefined;
}

function encodeQueryCursor(revision: number, keys: readonly string[]): string {
  return [CURSOR_VERSION, String(revision), ...keys].join(CURSOR_SEPARATOR);
}

interface ScopeSql {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

/** The attempts in scope: visible at the revision, inside the time range, matching the filters. */
function attemptScope(request: AccountingQueryRequest, revision: number): ScopeSql {
  const groupColumns = request.groupBy.map((dimension, index) => `ifnull(${DIMENSION_SQL[dimension]}, '') AS g${String(index)}`);
  const conditions = [`EXISTS (SELECT 1 FROM accounting_contributions c WHERE c.attempt_id = a.attempt_id AND ${VISIBLE})`];
  const params: SqlParam[] = [revision, revision];
  if (request.from !== undefined) {
    conditions.push('a.first_event_utc >= ?');
    params.push(request.from);
  }
  if (request.to !== undefined) {
    conditions.push('a.first_event_utc < ?');
    params.push(request.to);
  }
  for (const [dimension, value] of Object.entries(request.filters ?? {})) {
    conditions.push(`${DIMENSION_SQL[dimension as AccountingDimension]} = ?`);
    params.push(value);
  }
  const columns = [...groupColumns, 'a.attempt_id', 'a.root_id', 'a.last_event_utc'].join(', ');
  return { sql: `SELECT ${columns} FROM accounting_attempts a WHERE ${conditions.join(' AND ')}`, params };
}

function groupList(count: number, prefix = ''): string {
  return Array.from({ length: count }, (_, index) => `${prefix}g${String(index)}`).join(', ');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

interface GroupRow {
  readonly keys: readonly string[];
  readonly attempts: number;
  readonly roots: number;
}

type RawGroup = Record<string, unknown> & { readonly attempts: number | bigint; readonly roots: number | bigint };

function readGroups(conn: NodeSqliteConnection, scope: ScopeSql, dimensions: number, after: readonly string[] | undefined, limit: number): GroupRow[] {
  if (dimensions === 0) {
    const row = conn.get<RawGroup>(`SELECT count(*) AS attempts, count(DISTINCT root_id) AS roots FROM (${scope.sql})`, ...scope.params);
    const attempts = Number(row?.attempts ?? 0);
    return attempts === 0 ? [] : [{ keys: [], attempts, roots: Number(row?.roots ?? 0) }];
  }
  const groups = groupList(dimensions);
  const keyset = after === undefined ? '' : `WHERE (${groups}) > (${placeholders(dimensions)})`;
  const rows = conn.all<RawGroup>(
    `SELECT ${groups}, count(*) AS attempts, count(DISTINCT root_id) AS roots FROM (${scope.sql}) ${keyset}
      GROUP BY ${groups} ORDER BY ${groups} LIMIT ?`,
    ...scope.params,
    ...(after ?? []),
    limit
  );
  return rows.map((row) => ({
    keys: Array.from({ length: dimensions }, (_, index) => String(row[`g${String(index)}`])),
    attempts: Number(row.attempts),
    roots: Number(row.roots)
  }));
}

interface MeasureAggregate {
  readonly groupKey: string;
  readonly measure: Measure;
  readonly unit: string;
  laneTotal: bigint;
  estimatedTotal: bigint;
  known: number;
}

type RawAggregate = Record<string, unknown> & {
  readonly measure: Measure;
  readonly unit: string;
  readonly lane_text: string | null;
  readonly estimated_text: string | null;
  readonly known: number | bigint;
};

type RawLatest = Record<string, unknown> & { readonly measure: Measure; readonly unit: string; readonly quantity_text: string };

function groupKeyOf(row: Record<string, unknown>, dimensions: number): string {
  return JSON.stringify(Array.from({ length: dimensions }, (_, index) => String(row[`g${String(index)}`])));
}

interface PageRange {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

function pageRange(groups: readonly GroupRow[], dimensions: number): PageRange {
  if (dimensions === 0) return { sql: '1 = 1', params: [] };
  const first = groups.at(0) as GroupRow;
  const last = groups.at(-1) as GroupRow;
  const columns = groupList(dimensions, 's.');
  return {
    sql: `(${columns}) >= (${placeholders(dimensions)}) AND (${columns}) <= (${placeholders(dimensions)})`,
    params: [...first.keys, ...last.keys]
  };
}

function measureFilter(measures: readonly Measure[] | undefined): PageRange {
  if (measures === undefined) return { sql: '1 = 1', params: [] };
  return { sql: `c.measure IN (${placeholders(measures.length)})`, params: measures };
}

/** Sums per (group, measure, unit). Throws the store's overflow error for the caller to map. */
function readMeasureAggregates(
  conn: NodeSqliteConnection,
  scope: ScopeSql,
  request: AccountingQueryRequest,
  groups: readonly GroupRow[],
  revision: number
): Map<string, MeasureAggregate> {
  const dimensions = request.groupBy.length;
  const range = pageRange(groups, dimensions);
  const filter = measureFilter(request.measures);
  const groupColumns = dimensions === 0 ? '' : `${groupList(dimensions, 's.')}, `;
  const from = `FROM (${scope.sql}) s JOIN accounting_contributions c ON c.attempt_id = s.attempt_id AND ${VISIBLE}
    WHERE ${range.sql} AND ${filter.sql}`;
  const params = [...scope.params, revision, revision, ...range.params, ...filter.params];
  const aggregates = new Map<string, MeasureAggregate>();
  const sums = conn.all<RawAggregate>(
    `SELECT ${groupColumns}c.measure AS measure, c.unit AS unit,
       CAST(SUM(CASE WHEN c.measure IN (${OCCUPANCY_LIST}) OR c.cost_origin IS 'estimated' THEN NULL ELSE c.quantity END) AS TEXT) AS lane_text,
       CAST(SUM(CASE WHEN c.cost_origin IS 'estimated' THEN c.quantity END) AS TEXT) AS estimated_text,
       count(DISTINCT c.attempt_id)
         - count(DISTINCT CASE WHEN c.cost_origin IS 'estimated' OR c.completeness <> 'known' OR c.quantity IS NULL THEN c.attempt_id END) AS known
     ${from} GROUP BY ${groupColumns}c.measure, c.unit`,
    ...params
  );
  for (const row of sums) {
    const groupKey = groupKeyOf(row, dimensions);
    aggregates.set(`${groupKey}\0${row.measure}\0${row.unit}`, {
      groupKey,
      measure: row.measure,
      unit: row.unit,
      laneTotal: parseSumText(row.lane_text),
      estimatedTotal: parseSumText(row.estimated_text),
      known: Number(row.known)
    });
  }
  const partition = `${groupColumns}c.measure, c.unit`;
  const latest = conn.all<RawLatest>(
    `SELECT * FROM (
       SELECT ${groupColumns}c.measure AS measure, c.unit AS unit, CAST(c.quantity AS TEXT) AS quantity_text,
              ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY s.last_event_utc DESC, s.attempt_id DESC, c.invocation_ordinal DESC) AS position
       ${from} AND c.measure IN (${OCCUPANCY_LIST}) AND c.completeness = 'known' AND c.quantity IS NOT NULL
     ) WHERE position = 1`,
    ...params
  );
  for (const row of latest) {
    const aggregate = aggregates.get(`${groupKeyOf(row, dimensions)}\0${row.measure}\0${row.unit}`);
    if (aggregate !== undefined) aggregate.laneTotal = parseSumText(row.quantity_text);
  }
  return aggregates;
}

function formatQuantity(measure: Measure, value: bigint): string {
  return MONEY_MEASURES.has(measure) ? formatMicros(value) : value.toString();
}

function completenessOf(known: number, denominator: number): Completeness {
  if (known >= denominator) return 'known';
  return known === 0 ? 'unknown' : 'partial';
}

function toMeasureTotal(aggregate: MeasureAggregate, denominator: number): AccountingMeasureTotal {
  const total = formatQuantity(aggregate.measure, aggregate.laneTotal);
  return {
    measure: aggregate.measure,
    unit: aggregate.unit,
    total,
    ...(aggregate.measure === 'cost'
      ? { reportedTotal: total, estimatedTotal: formatQuantity('cost', aggregate.estimatedTotal) }
      : {}),
    completeness: completenessOf(aggregate.known, denominator),
    coverage: { known: aggregate.known, denominator }
  };
}

function compareMeasures(left: MeasureAggregate, right: MeasureAggregate): number {
  const byMeasure = MEASURES.indexOf(left.measure) - MEASURES.indexOf(right.measure);
  if (byMeasure !== 0) return byMeasure;
  if (left.unit === right.unit) return 0;
  return left.unit < right.unit ? -1 : 1;
}

function buildRows(request: AccountingQueryRequest, groups: readonly GroupRow[], aggregates: Map<string, MeasureAggregate>): AccountingRow[] {
  const byGroup = new Map<string, MeasureAggregate[]>();
  for (const aggregate of aggregates.values()) {
    const list = byGroup.get(aggregate.groupKey) ?? [];
    list.push(aggregate);
    byGroup.set(aggregate.groupKey, list);
  }
  return groups.map((group) => {
    const key: Partial<Record<AccountingDimension, string | null>> = {};
    request.groupBy.forEach((dimension, index) => {
      const value = group.keys.at(index) ?? '';
      key[dimension] = value === '' ? null : value;
    });
    const measures = (byGroup.get(JSON.stringify(group.keys)) ?? []).sort(compareMeasures);
    return { key, attempts: group.attempts, roots: group.roots, measures: measures.map((item) => toMeasureTotal(item, group.attempts)) };
  });
}

function readGapSummary(conn: NodeSqliteConnection): GapSummary[] {
  return conn
    .all<{ kind: GapKind; total: number | bigint }>(
      `SELECT gap_kind AS kind, SUM(count) AS total FROM accounting_gaps GROUP BY gap_kind ORDER BY total DESC, kind LIMIT ?`,
      MAX_REPORTED_GAP_KINDS
    )
    .map((row) => ({ kind: row.kind, count: Number(row.total) }));
}

interface RawEpoch {
  readonly imported_runs: number | bigint;
  readonly cost_text: string;
  readonly boundary_run_id: string | null;
  readonly boundary_terminal_utc: string | null;
  readonly reconciliation: Reconciliation | null;
}

function readLegacySummary(conn: NodeSqliteConnection): LegacyEpochSummary {
  const row = conn.get<RawEpoch>(
    `SELECT imported_runs, CAST(legacy_cost_micros AS TEXT) AS cost_text, boundary_run_id, boundary_terminal_utc, reconciliation
       FROM accounting_legacy_epoch WHERE epoch_id = 1`
  );
  return {
    runCount: Number(row?.imported_runs ?? 0),
    costMicros: row?.cost_text ?? '0',
    boundaryRunId: row?.boundary_run_id ?? null,
    boundaryTerminalUtc: row?.boundary_terminal_utc ?? null,
    reconciliation: row?.reconciliation ?? null,
    detail: 'unavailable'
  };
}

function cutoffOf(conn: NodeSqliteConnection, revision: number): number {
  if (revision === 0) return 0;
  return Number(conn.scalar('SELECT cutoff_ingest_seq FROM accounting_revisions WHERE revision = ?', revision) ?? 0);
}

function resolveRevision(conn: NodeSqliteConnection, request: AccountingQueryRequest, cursor: DecodedCursor | undefined): AccountingResult<number> {
  const latest = latestRevision(conn);
  if (request.asOfRevision !== undefined && request.asOfRevision > latest) return refuse('invalid-query', 'asOfRevision');
  if (cursor !== undefined && request.asOfRevision !== undefined && cursor.revision !== request.asOfRevision) {
    return refuse('invalid-query', 'cursor');
  }
  if (cursor !== undefined && cursor.revision > latest) return refuse('invalid-query', 'cursor');
  const revision = cursor?.revision ?? request.asOfRevision ?? latest;
  if (revision < compactionFloor(conn)) return { ok: false, refusal: { code: 'revision-compacted' } };
  return { ok: true, value: revision };
}

/** Runs a validated query. Store errors other than an overflow propagate to the facade. */
export function runAccountingQuery(
  conn: NodeSqliteConnection,
  request: AccountingQueryRequest & { readonly limit: number },
  ctx: QueryContext
): AccountingResult<AccountingQueryResponse> {
  const started = ctx.monotonicMs();
  const overDeadline = (): boolean => ctx.signal?.aborted === true || ctx.monotonicMs() - started > ctx.bounds.queryDeadlineMs;
  if (overDeadline()) return refuse('deadline-exceeded');
  if (request.limit > ctx.bounds.maxQueryLimit) return refuse('invalid-query', 'limit');

  const dimensions = request.groupBy.length;
  const cursor = request.cursor === undefined ? undefined : decodeQueryCursor(request.cursor, request.groupBy);
  if (request.cursor !== undefined && (cursor === undefined || dimensions === 0)) return refuse('invalid-query', 'cursor');
  const resolved = resolveRevision(conn, request, cursor);
  if (!resolved.ok) return resolved;
  const revision = resolved.value;

  let rows: AccountingRow[] = [];
  let nextCursor: string | undefined;
  if (revision > 0) {
    const scope = attemptScope(request, revision);
    const fetched = readGroups(conn, scope, dimensions, cursor?.keys, request.limit + 1);
    const groups = fetched.slice(0, request.limit);
    if (fetched.length > request.limit) nextCursor = encodeQueryCursor(revision, (groups.at(-1) as GroupRow).keys);
    if (overDeadline()) return refuse('deadline-exceeded');
    if (groups.length > 0) {
      let aggregates: Map<string, MeasureAggregate>;
      try {
        aggregates = readMeasureAggregates(conn, scope, request, groups, revision);
      } catch (error) {
        if (error instanceof Error && OVERFLOW_MESSAGE.test(error.message)) return refuse('aggregate-overflow');
        throw error;
      }
      rows = buildRows(request, groups, aggregates);
    }
  }
  if (overDeadline()) return refuse('deadline-exceeded');

  const response: AccountingQueryResponse = {
    revision,
    cutoffIngestSeq: cutoffOf(conn, revision),
    policyVersion: ACCOUNTING_POLICY_VERSION,
    calculationVersion: ACCOUNTING_CALCULATION_VERSION,
    rows,
    ...(request.includeLegacy === true ? { legacy: readLegacySummary(conn) } : {}),
    unattributedCount: Number(conn.scalar("SELECT count(*) FROM accounting_observations WHERE disposition = 'unattributed'") ?? 0),
    gaps: readGapSummary(conn),
    ...(nextCursor !== undefined ? { nextCursor } : {})
  };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > ctx.bounds.maxResponseBytes) return refuse('response-too-large');
  return { ok: true, value: response };
}

/** `1~<kind>~<scope>`; the kind is a closed enum, so the scope is everything after it. */
function decodeGapCursor(cursor: string): { readonly kind: string; readonly scope: string } | undefined {
  const first = cursor.indexOf(CURSOR_SEPARATOR);
  const second = cursor.indexOf(CURSOR_SEPARATOR, first + 1);
  if (first < 0 || second < 0 || cursor.slice(0, first) !== CURSOR_VERSION) return undefined;
  const kind = cursor.slice(first + 1, second);
  const scope = cursor.slice(second + 1);
  if (!(GAP_KINDS as readonly string[]).includes(kind) || scope.length === 0) return undefined;
  return { kind, scope };
}

interface RawGap {
  readonly gap_kind: GapKind;
  readonly scope_key: string;
  readonly count: number | bigint;
  readonly first_seen_utc: string;
  readonly last_seen_utc: string;
}

/** One keyset page of the counted gaps, ordered by kind then scope. */
export function readGapsPage(
  conn: NodeSqliteConnection,
  request: ReadGapsRequest & { readonly limit: number }
): AccountingResult<ReadGapsResponse> {
  const after = request.cursor === undefined ? undefined : decodeGapCursor(request.cursor);
  if (request.cursor !== undefined && after === undefined) return refuse('invalid-query', 'cursor');
  const keyset = after === undefined ? '' : 'WHERE (gap_kind, scope_key) > (?, ?)';
  const fetched = conn.all<RawGap>(
    `SELECT gap_kind, scope_key, count, first_seen_utc, last_seen_utc FROM accounting_gaps ${keyset}
      ORDER BY gap_kind, scope_key LIMIT ?`,
    ...(after === undefined ? [] : [after.kind, after.scope]),
    request.limit + 1
  );
  const page = fetched.slice(0, request.limit);
  const gaps: AccountingGapRow[] = page.map((row) => ({
    kind: row.gap_kind,
    scopeKey: row.scope_key,
    count: Number(row.count),
    firstSeenUtc: row.first_seen_utc,
    lastSeenUtc: row.last_seen_utc
  }));
  const last = page.at(-1);
  const nextCursor =
    fetched.length > request.limit && last !== undefined
      ? [CURSOR_VERSION, last.gap_kind, last.scope_key].join(CURSOR_SEPARATOR)
      : undefined;
  return { ok: true, value: { gaps, ...(nextCursor !== undefined ? { nextCursor } : {}) } };
}
