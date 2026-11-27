/**
 * Typed, self-contained `node:worker_threads` entry module for read-only
 * usage-accounting aggregate queries (`accounting-query.worker.js` when bundled
 * by esbuild; executed directly from `.ts` source via Node's native erasable-TS
 * type stripping in Vitest).
 *
 * Erasable-only TypeScript syntax and zero runtime relative imports (`import type`
 * only) are mandatory so Node can execute this module directly without a loader.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type {
  AccountingBounds,
  AccountingResult,
  Completeness,
  GapKind,
  Measure,
  Reconciliation
} from '../../contracts/usage-accounting/accounting-types';
import type {
  AccountingDimension,
  AccountingMeasureTotal,
  AccountingQueryRequest,
  AccountingQueryResponse,
  AccountingRow,
  GapSummary,
  LegacyEpochSummary
} from '../../contracts/usage-accounting/query-contract';

export interface AccountingWorkerConfigPayload {
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
  readonly policyVersion: 1;
  readonly calculationVersion: 1;
  readonly maxQueryCursorChars: number;
  readonly maxReportedGapKinds: number;
  readonly attemptOutcomes: readonly string[];
  readonly measures: readonly Measure[];
  readonly occupancyMeasures: readonly Measure[];
  readonly patterns: {
    readonly backend: string;
    readonly model: string;
    readonly identifier: string;
    readonly utcDay: string;
  };
}

export interface AccountingWorkerRequestEnvelope {
  readonly id: number;
  readonly request: AccountingQueryRequest & { readonly limit: number };
  readonly bounds: AccountingBounds;
}

export interface AccountingWorkerResponseEnvelope {
  readonly id: number;
  readonly result?: AccountingResult<AccountingQueryResponse> | undefined;
  readonly errorCode?: string | undefined;
  readonly execMs?: number | undefined;
}

type Refusal<T> = AccountingResult<T> & { readonly ok: false };

interface DecodedCursor {
  readonly revision: number;
  readonly queryDigest: string;
  readonly keys: readonly string[];
}

interface ScopeSql {
  readonly sql: string;
  readonly params: readonly SQLInputValue[];
}

interface GroupRow {
  readonly keys: readonly string[];
  readonly attempts: number;
  readonly roots: number;
}

interface MeasureAggregate {
  readonly groupKey: string;
  readonly measure: Measure;
  readonly unit: string;
  laneTotal: bigint;
  estimatedTotal: bigint;
  known: number;
  hasConflicting: boolean;
}

interface RawGroup {
  readonly [key: string]: unknown;
  readonly attempts: number | bigint;
  readonly roots: number | bigint;
}

interface RawAggregate {
  readonly [key: string]: unknown;
  readonly measure: Measure;
  readonly unit: string;
  readonly lane_text: string | null;
  readonly estimated_text: string | null;
  readonly known: number | bigint;
  readonly has_conflicting: number | bigint;
}

interface RawLatest {
  readonly [key: string]: unknown;
  readonly measure: Measure;
  readonly unit: string;
  readonly quantity_text: string;
}

interface RawGapSummary {
  readonly kind: GapKind;
  readonly total: number | bigint;
}

interface RawEpoch {
  readonly imported_runs: number | bigint;
  readonly cost_text: string;
  readonly boundary_run_id: string | null;
  readonly boundary_terminal_utc: string | null;
  readonly reconciliation: Reconciliation | null;
}

const MONEY_MEASURES: ReadonlySet<Measure> = new Set<Measure>(['cost', 'credits']);
const VISIBLE = 'c.from_revision <= ? AND (c.to_revision IS NULL OR c.to_revision > ?)';
const OVERFLOW_MESSAGE = /integer overflow/i;
const QUERY_CURSOR_VERSION = '2';
const CURSOR_SEPARATOR = '~';
const QUERY_DIGEST_PATTERN = /^[0-9a-f]{32}$/;
const SUM_TEXT = /^-?\d{1,20}$/;
const MICROS_PER_UNIT = 1_000_000n;

const DIMENSION_SQL: Readonly<Record<AccountingDimension, string>> = {
  backend: 'a.backend',
  model: 'a.model',
  workflowRevision: 'a.workflow_revision',
  phaseId: 'a.phase_id',
  attemptOutcome: 'a.outcome',
  utcDay: 'substr(a.first_event_utc, 1, 10)'
};

function refuse<T>(
  code: 'invalid-query' | 'aggregate-overflow' | 'deadline-exceeded' | 'response-too-large',
  detail?: string
): Refusal<T> {
  return { ok: false, refusal: detail === undefined ? { code } : { code, detail } };
}

function parseSumText(text: string | null): bigint {
  if (text === null) return 0n;
  if (!SUM_TEXT.test(text)) throw new Error('sum is not an exact integer');
  return BigInt(text);
}

function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const whole = magnitude / MICROS_PER_UNIT;
  const fraction = (magnitude % MICROS_PER_UNIT).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function computeQueryDigest(request: AccountingQueryRequest): string {
  const filters: Record<string, string> = {};
  if (request.filters !== undefined) {
    for (const key of Object.keys(request.filters).sort()) {
      const value = request.filters[key as AccountingDimension];
      if (value !== undefined) filters[key] = value;
    }
  }
  const canonical = {
    groupBy: [...request.groupBy],
    from: request.from ?? null,
    to: request.to ?? null,
    filters,
    measures: request.measures === undefined ? null : [...new Set(request.measures)].sort(),
    rootIds: request.rootIds === undefined ? null : [...new Set(request.rootIds)].sort(),
    includeLegacy: request.includeLegacy === true
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 32);
}

function encodeQueryCursor(revision: number, queryDigest: string, keys: readonly string[]): string {
  return [QUERY_CURSOR_VERSION, String(revision), queryDigest, ...keys].join(CURSOR_SEPARATOR);
}

function groupList(count: number, prefix = ''): string {
  return Array.from({ length: count }, (_, index) => `${prefix}g${String(index)}`).join(', ');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function groupKeyOf(row: Readonly<Record<string, unknown>>, dimensions: number): string {
  return JSON.stringify(
    Array.from({ length: dimensions }, (_, index) => String(row[`g${String(index)}`]))
  );
}

function pageRange(groups: readonly GroupRow[], dimensions: number): ScopeSql {
  if (dimensions === 0) return { sql: '1 = 1', params: [] };
  const first = groups.at(0);
  const last = groups.at(-1);
  if (first === undefined || last === undefined) return { sql: '1 = 1', params: [] };
  const columns = groupList(dimensions, 's.');
  return {
    sql: `(${columns}) >= (${placeholders(dimensions)}) AND (${columns}) <= (${placeholders(dimensions)})`,
    params: [...first.keys, ...last.keys]
  };
}

function measureFilter(measures: readonly Measure[] | undefined): ScopeSql {
  if (measures === undefined) return { sql: '1 = 1', params: [] };
  return { sql: `c.measure IN (${placeholders(measures.length)})`, params: measures };
}

function formatQuantity(measure: Measure, value: bigint): string {
  return MONEY_MEASURES.has(measure) ? formatMicros(value) : value.toString();
}

function completenessOf(known: number, denominator: number, hasConflicting: boolean): Completeness {
  if (hasConflicting) return 'conflicting';
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
    completeness: completenessOf(aggregate.known, denominator, aggregate.hasConflicting),
    coverage: { known: aggregate.known, denominator }
  };
}

function attemptScope(request: AccountingQueryRequest, revision?: number): ScopeSql {
  const groupColumns = request.groupBy.map(
    (dim, idx) => `ifnull(${DIMENSION_SQL[dim]}, '') AS g${String(idx)}`
  );
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];
  if (revision !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM accounting_contributions c WHERE c.attempt_id = a.attempt_id AND ${VISIBLE})`
    );
    params.push(revision, revision);
  }
  if (request.from !== undefined) {
    conditions.push('a.first_event_utc >= ?');
    params.push(request.from);
  }
  if (request.to !== undefined) {
    conditions.push('a.first_event_utc < ?');
    params.push(request.to);
  }
  if (request.filters !== undefined) {
    for (const [dim, value] of Object.entries(request.filters)) {
      conditions.push(`${DIMENSION_SQL[dim as AccountingDimension]} = ?`);
      params.push(value);
    }
  }
  if (request.rootIds !== undefined) {
    conditions.push(`a.root_id IN (${placeholders(request.rootIds.length)})`);
    params.push(...request.rootIds);
  }
  const columns = [...groupColumns, 'a.attempt_id', 'a.root_id', 'a.last_event_utc'].join(', ');
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  return { sql: `SELECT ${columns} FROM accounting_attempts a${where}`, params };
}

function startAccountingQueryWorker(cfg: AccountingWorkerConfigPayload): void {
  if (parentPort === null) return;
  const port = parentPort;

  const patterns = {
    backend: new RegExp(cfg.patterns.backend),
    model: new RegExp(cfg.patterns.model),
    identifier: new RegExp(cfg.patterns.identifier),
    utcDay: new RegExp(cfg.patterns.utcDay)
  };
  const occupancySet = new Set<Measure>(cfg.occupancyMeasures);
  const occupancyList = cfg.occupancyMeasures.map((m) => `'${m}'`).join(', ');

  const db = new DatabaseSync(cfg.databasePath, {
    open: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    readOnly: true
  });

  const scalar = (sql: string, ...params: readonly SQLInputValue[]): unknown => {
    const row = db.prepare(sql).get(...params);
    if (row === undefined) return undefined;
    const keys = Object.keys(row);
    const firstKey = keys.at(0);
    return firstKey !== undefined ? row[firstKey] : undefined;
  };

  const queryGet = <T>(sql: string, ...params: readonly SQLInputValue[]): T | undefined =>
    db.prepare(sql).get(...params) as unknown as T | undefined;

  const queryAll = <T>(sql: string, ...params: readonly SQLInputValue[]): readonly T[] =>
    db.prepare(sql).all(...params) as unknown as readonly T[];

  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${String(Number(cfg.busyTimeoutMs))}`);
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA query_only = ON');

  if (
    Number(scalar('PRAGMA foreign_keys') ?? 0) !== 1 ||
    Number(scalar('PRAGMA trusted_schema') ?? 1) !== 0 ||
    Number(scalar('PRAGMA temp_store') ?? 0) !== 2 ||
    Number(scalar('PRAGMA query_only') ?? 0) !== 1
  ) {
    db.close();
    const err = new Error('read-only pragma verification failed') as Error & { code: string };
    err.code = 'PRAGMA_VERIFICATION_FAILED';
    throw err;
  }

  const isDimensionValue = (dimension: AccountingDimension, value: string): boolean => {
    switch (dimension) {
      case 'backend':
        return patterns.backend.test(value);
      case 'model':
        return patterns.model.test(value);
      case 'workflowRevision':
      case 'phaseId':
        return patterns.identifier.test(value);
      case 'attemptOutcome':
        return cfg.attemptOutcomes.includes(value);
      case 'utcDay':
        return patterns.utcDay.test(value);
    }
  };

  const decodeQueryCursor = (
    cursor: string,
    groupBy: readonly AccountingDimension[],
    expectedDigest: string
  ): DecodedCursor | undefined => {
    if (cursor.length > cfg.maxQueryCursorChars) return undefined;
    const parts = cursor.split(CURSOR_SEPARATOR);
    if (parts.length !== groupBy.length + 3 || parts[0] !== QUERY_CURSOR_VERSION) return undefined;
    const revisionText = parts[1] ?? '';
    if (!/^[1-9]\d{0,15}$/.test(revisionText)) return undefined;
    const revision = Number(revisionText);
    if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
    const queryDigest = parts[2] ?? '';
    if (!QUERY_DIGEST_PATTERN.test(queryDigest) || queryDigest !== expectedDigest) return undefined;
    const keys = parts.slice(3);
    const valid = keys.every((key, index) => {
      const dim = groupBy.at(index);
      return dim !== undefined && (key === '' || isDimensionValue(dim, key));
    });
    return valid ? { revision, queryDigest, keys } : undefined;
  };

  const readGroups = (
    scope: ScopeSql,
    dimensions: number,
    after: readonly string[] | undefined,
    limit: number
  ): GroupRow[] => {
    if (dimensions === 0) {
      const row = queryGet<RawGroup>(
        `SELECT count(*) AS attempts, count(DISTINCT root_id) AS roots FROM (${scope.sql})`,
        ...scope.params
      );
      const attempts = Number(row?.attempts ?? 0);
      return attempts === 0 ? [] : [{ keys: [], attempts, roots: Number(row?.roots ?? 0) }];
    }
    const groups = groupList(dimensions);
    const keyset = after === undefined ? '' : `WHERE (${groups}) > (${placeholders(dimensions)})`;
    const rows = queryAll<RawGroup>(
      `SELECT ${groups}, count(*) AS attempts, count(DISTINCT root_id) AS roots FROM (${scope.sql}) ${keyset} ` +
        `GROUP BY ${groups} ORDER BY ${groups} LIMIT ?`,
      ...scope.params,
      ...(after ?? []),
      limit
    );
    return rows.map((row) => ({
      keys: Array.from({ length: dimensions }, (_, index) => String(row[`g${String(index)}`])),
      attempts: Number(row.attempts),
      roots: Number(row.roots)
    }));
  };

  const readMeasureAggregates = (
    request: AccountingQueryRequest,
    groups: readonly GroupRow[],
    revision: number
  ): Map<string, MeasureAggregate> => {
    const dimensions = request.groupBy.length;
    const joinScope = attemptScope(request);
    const range = pageRange(groups, dimensions);
    const filter = measureFilter(request.measures);
    const groupColumns = dimensions === 0 ? '' : `${groupList(dimensions, 's.')}, `;
    const from =
      `FROM (${joinScope.sql}) s JOIN accounting_contributions c ON c.attempt_id = s.attempt_id AND ${VISIBLE} ` +
      `WHERE ${range.sql} AND ${filter.sql}`;
    const params: readonly SQLInputValue[] = [
      ...joinScope.params,
      revision,
      revision,
      ...range.params,
      ...filter.params
    ];
    const aggregates = new Map<string, MeasureAggregate>();
    const sums = queryAll<RawAggregate>(
      `SELECT ${groupColumns}c.measure AS measure, c.unit AS unit,` +
        ` CAST(SUM(CASE WHEN c.measure IN (${occupancyList}) OR c.cost_origin IS 'estimated' THEN NULL ELSE c.quantity END) AS TEXT) AS lane_text,` +
        " CAST(SUM(CASE WHEN c.cost_origin IS 'estimated' THEN c.quantity END) AS TEXT) AS estimated_text," +
        " count(DISTINCT c.attempt_id) - count(DISTINCT CASE WHEN c.cost_origin IS 'estimated' OR c.completeness <> 'known' OR c.quantity IS NULL THEN c.attempt_id END) AS known," +
        " MAX(CASE WHEN c.completeness = 'conflicting' THEN 1 ELSE 0 END) AS has_conflicting " +
        `${from} GROUP BY ${groupColumns}c.measure, c.unit`,
      ...params
    );
    let hasOccupancy = false;
    for (const row of sums) {
      if (occupancySet.has(row.measure)) hasOccupancy = true;
      const groupKey = groupKeyOf(row, dimensions);
      aggregates.set(`${groupKey}\0${row.measure}\0${row.unit}`, {
        groupKey,
        measure: row.measure,
        unit: row.unit,
        laneTotal: parseSumText(row.lane_text),
        estimatedTotal: parseSumText(row.estimated_text),
        known: Number(row.known),
        hasConflicting: Number(row.has_conflicting) > 0
      });
    }
    if (!hasOccupancy) return aggregates;
    const partition = `${groupColumns}c.measure, c.unit`;
    const latest = queryAll<RawLatest>(
      `SELECT * FROM (SELECT ${groupColumns}c.measure AS measure, c.unit AS unit, CAST(c.quantity AS TEXT) AS quantity_text,` +
        ` ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY s.last_event_utc DESC, s.attempt_id DESC, c.invocation_ordinal DESC) AS position ` +
        `${from} AND c.measure IN (${occupancyList}) AND c.completeness = 'known' AND c.quantity IS NOT NULL) WHERE position = 1`,
      ...params
    );
    for (const row of latest) {
      const aggregate = aggregates.get(
        `${groupKeyOf(row, dimensions)}\0${row.measure}\0${row.unit}`
      );
      if (aggregate !== undefined) aggregate.laneTotal = parseSumText(row.quantity_text);
    }
    return aggregates;
  };

  const compareMeasures = (left: MeasureAggregate, right: MeasureAggregate): number => {
    const byMeasure = cfg.measures.indexOf(left.measure) - cfg.measures.indexOf(right.measure);
    if (byMeasure !== 0) return byMeasure;
    if (left.unit === right.unit) return 0;
    return left.unit < right.unit ? -1 : 1;
  };

  const buildRows = (
    request: AccountingQueryRequest,
    groups: readonly GroupRow[],
    aggregates: ReadonlyMap<string, MeasureAggregate>,
    maxUnitsPerRowMeasure: number
  ): AccountingRow[] => {
    const byGroup = new Map<string, MeasureAggregate[]>();
    for (const aggregate of aggregates.values()) {
      const list = byGroup.get(aggregate.groupKey) ?? [];
      list.push(aggregate);
      byGroup.set(aggregate.groupKey, list);
    }
    return groups.map((group) => {
      const key: Partial<Record<AccountingDimension, string | null>> = {};
      request.groupBy.forEach((dimension, index) => {
        const value = group.keys[index] ?? '';
        key[dimension] = value === '' ? null : value;
      });
      const sorted = (byGroup.get(JSON.stringify(group.keys)) ?? []).sort(compareMeasures);
      const kept: AccountingMeasureTotal[] = [];
      const seenPerMeasure = new Map<Measure, number>();
      let omittedUnitCount = 0;
      for (const item of sorted) {
        const seen = seenPerMeasure.get(item.measure) ?? 0;
        if (seen < maxUnitsPerRowMeasure) {
          seenPerMeasure.set(item.measure, seen + 1);
          kept.push(toMeasureTotal(item, group.attempts));
        } else {
          omittedUnitCount += 1;
        }
      }
      return {
        key,
        attempts: group.attempts,
        roots: group.roots,
        measures: kept,
        ...(omittedUnitCount > 0 ? { omittedUnitCount } : {})
      };
    });
  };

  const executeQuery = (
    request: AccountingQueryRequest & { readonly limit: number },
    bounds: AccountingBounds
  ): AccountingResult<AccountingQueryResponse> => {
    const started = performance.now();
    const overDeadline = (): boolean => performance.now() - started > bounds.queryDeadlineMs;
    if (overDeadline()) return refuse('deadline-exceeded');
    if (request.limit > bounds.maxQueryLimit) return refuse('invalid-query', 'limit');

    const dimensions = request.groupBy.length;
    const queryDigest = computeQueryDigest(request);
    const cursor =
      request.cursor === undefined
        ? undefined
        : decodeQueryCursor(request.cursor, request.groupBy, queryDigest);
    if (request.cursor !== undefined && (cursor === undefined || dimensions === 0)) {
      return refuse('invalid-query', 'cursor');
    }

    // Execute all multi-statement reads inside a single WAL read snapshot so concurrent host writes
    // (e.g. outcome updates, pruneExpired compaction, restore) cannot tear groups against aggregates.
    db.exec('BEGIN DEFERRED');
    try {
      const latest = Number(
        scalar('SELECT COALESCE(MAX(revision), 0) FROM accounting_revisions') ?? 0
      );
      if (request.asOfRevision !== undefined && request.asOfRevision > latest) {
        return refuse('invalid-query', 'asOfRevision');
      }
      if (
        cursor !== undefined &&
        request.asOfRevision !== undefined &&
        cursor.revision !== request.asOfRevision
      ) {
        return refuse('invalid-query', 'cursor');
      }
      if (cursor !== undefined && cursor.revision > latest) return refuse('invalid-query', 'cursor');
      const revision = cursor?.revision ?? request.asOfRevision ?? latest;
      const floor = Number(
        scalar('SELECT COALESCE(MIN(revision), 0) FROM accounting_revisions') ?? 0
      );
      if (revision < floor) return { ok: false, refusal: { code: 'revision-compacted' } };

      let rows: AccountingRow[] = [];
      let nextCursor: string | undefined;
      if (revision > 0) {
        const scope = attemptScope(request, revision);
        const fetched = readGroups(scope, dimensions, cursor?.keys, request.limit + 1);
        const groups = fetched.slice(0, request.limit);
        const lastGroup = groups.at(-1);
        if (fetched.length > request.limit && lastGroup !== undefined) {
          nextCursor = encodeQueryCursor(revision, queryDigest, lastGroup.keys);
        }
        if (overDeadline()) return refuse('deadline-exceeded');
        if (groups.length > 0) {
          let aggregates: Map<string, MeasureAggregate>;
          try {
            aggregates = readMeasureAggregates(request, groups, revision);
          } catch (error: unknown) {
            if (error instanceof Error && OVERFLOW_MESSAGE.test(error.message)) {
              return refuse('aggregate-overflow');
            }
            throw error;
          }
          rows = buildRows(request, groups, aggregates, bounds.maxUnitsPerRowMeasure);
        }
      }
      if (overDeadline()) return refuse('deadline-exceeded');

      const cutoffIngestSeq =
        revision === 0
          ? 0
          : Number(
              scalar(
                'SELECT cutoff_ingest_seq FROM accounting_revisions WHERE revision = ?',
                revision
              ) ?? 0
            );
      const unattributedCount = Number(
        scalar(
          "SELECT count(*) FROM accounting_observations WHERE disposition = 'unattributed'"
        ) ?? 0
      );
      const gaps: GapSummary[] = queryAll<RawGapSummary>(
        'SELECT gap_kind AS kind, SUM(count) AS total FROM accounting_gaps GROUP BY gap_kind ORDER BY total DESC, kind LIMIT ?',
        cfg.maxReportedGapKinds
      ).map((row) => ({ kind: row.kind, count: Number(row.total) }));

      let legacy: LegacyEpochSummary | undefined;
      if (request.includeLegacy === true) {
        const row = queryGet<RawEpoch>(
          'SELECT imported_runs, CAST(legacy_cost_micros AS TEXT) AS cost_text, boundary_run_id, boundary_terminal_utc, reconciliation FROM accounting_legacy_epoch WHERE epoch_id = 1'
        );
        legacy = {
          runCount: Number(row?.imported_runs ?? 0),
          costMicros: row?.cost_text ?? '0',
          boundaryRunId: row?.boundary_run_id ?? null,
          boundaryTerminalUtc: row?.boundary_terminal_utc ?? null,
          reconciliation: row?.reconciliation ?? null,
          detail: 'unavailable'
        };
      }

      const response: AccountingQueryResponse = {
        revision,
        cutoffIngestSeq,
        policyVersion: cfg.policyVersion,
        calculationVersion: cfg.calculationVersion,
        rows,
        ...(legacy !== undefined ? { legacy } : {}),
        unattributedCount,
        gaps,
        ...(nextCursor !== undefined ? { nextCursor } : {})
      };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > bounds.maxResponseBytes) {
        return refuse('response-too-large');
      }
      return { ok: true, value: response };
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors if the connection was already reset/closed.
      }
    }
  };

  port.on('message', (envelope: AccountingWorkerRequestEnvelope) => {
    const started = performance.now();
    try {
      const result = executeQuery(envelope.request, envelope.bounds);
      const reply: AccountingWorkerResponseEnvelope = {
        id: envelope.id,
        result,
        execMs: performance.now() - started
      };
      port.postMessage(reply);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        typeof (err as { readonly code?: unknown }).code === 'string'
          ? (err as { readonly code: string }).code
          : 'WORKER_SQL_ERROR';
      const reply: AccountingWorkerResponseEnvelope = {
        id: envelope.id,
        errorCode: code,
        execMs: performance.now() - started
      };
      port.postMessage(reply);
    }
  });
}

if (
  !isMainThread &&
  parentPort !== null &&
  workerData !== null &&
  typeof workerData === 'object' &&
  'databasePath' in workerData &&
  typeof (workerData as { readonly databasePath?: unknown }).databasePath === 'string'
) {
  startAccountingQueryWorker(workerData as AccountingWorkerConfigPayload);
}
