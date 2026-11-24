/**
 * FR-R8-03 (03-03) — Read-only `node:worker_threads` query executor for usage accounting.
 *
 * Keeps retention-limit (1,000,000-observation) aggregate reads off the extension-host event loop
 * (`<= 50 ms p95` host-thread blocking) while preserving exact `runAccountingQuery` semantics,
 * read-only SQLite isolation (`readOnly: true`, `PRAGMA query_only = ON`, `trusted_schema = OFF`),
 * bounded FIFO queueing, and real mid-read cancellation via `AbortSignal` -> `worker.terminate()`.
 *
 * Uses a self-contained `eval: true` worker bootstrap (matching `src/services/result-operator.ts`)
 * so it runs identically in Vitest and in the single-file bundled `dist/extension.js` VSIX without
 * extra esbuild entry points. Falls back transparently to synchronous execution for `:memory:` DBs.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { Worker } from 'node:worker_threads';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../contracts/sqlite-store/schema-types';
import {
  ACCOUNTING_CALCULATION_VERSION,
  ACCOUNTING_POLICY_VERSION,
  ATTEMPT_OUTCOMES,
  MEASURES,
  OCCUPANCY_MEASURES,
  type AccountingBounds,
  type AccountingResult
} from '../../contracts/usage-accounting/accounting-types';
import {
  DIMENSION_VALUE_PATTERNS,
  MAX_QUERY_CURSOR_CHARS,
  MAX_REPORTED_GAP_KINDS,
  type AccountingQueryRequest,
  type AccountingQueryResponse
} from '../../contracts/usage-accounting/query-contract';

const MAX_PENDING_QUERIES = 64;
const IDLE_WORKER_TTL_MS = 10_000;

export interface AccountingWorkerQueryMetrics {
  readonly queueWaitMs: number;
  readonly workerExecMs: number;
}

export interface AccountingWorkerQueryOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onMetrics?: ((metrics: AccountingWorkerQueryMetrics) => void) | undefined;
}

interface WorkerConfigPayload {
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
  readonly policyVersion: number;
  readonly calculationVersion: number;
  readonly maxQueryCursorChars: number;
  readonly maxReportedGapKinds: number;
  readonly attemptOutcomes: readonly string[];
  readonly measures: readonly string[];
  readonly occupancyMeasures: readonly string[];
  readonly patterns: {
    readonly backend: string;
    readonly model: string;
    readonly identifier: string;
    readonly utcDay: string;
  };
}

interface WorkerRequestEnvelope {
  readonly id: number;
  readonly request: AccountingQueryRequest & { readonly limit: number };
  readonly bounds: AccountingBounds;
}

interface WorkerResponseEnvelope {
  readonly id: number;
  readonly result?: AccountingResult<AccountingQueryResponse> | undefined;
  readonly errorCode?: string | undefined;
  readonly execMs?: number | undefined;
}

interface QueuedQuery {
  readonly id: number;
  readonly request: AccountingQueryRequest & { readonly limit: number };
  readonly bounds: AccountingBounds;
  readonly enqueuedAtMs: number;
  readonly signal: AbortSignal | undefined;
  readonly onMetrics: ((metrics: AccountingWorkerQueryMetrics) => void) | undefined;
  readonly resolve: (result: AccountingResult<AccountingQueryResponse>) => void;
  abortCleanup?: (() => void) | undefined;
}

const WORKER_BOOTSTRAP_SCRIPT = `
'use strict';
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const cfg = workerData;
const PATTERNS = {
  backend: new RegExp(cfg.patterns.backend),
  model: new RegExp(cfg.patterns.model),
  identifier: new RegExp(cfg.patterns.identifier),
  utcDay: new RegExp(cfg.patterns.utcDay)
};
const OCCUPANCY_SET = new Set(cfg.occupancyMeasures);
const OCCUPANCY_LIST = cfg.occupancyMeasures.map((m) => "'" + m + "'").join(', ');
const MONEY_MEASURES = new Set(['cost', 'credits']);
const VISIBLE = 'c.from_revision <= ? AND (c.to_revision IS NULL OR c.to_revision > ?)';
const OVERFLOW_MESSAGE = /integer overflow/i;
const QUERY_CURSOR_VERSION = '2';
const CURSOR_SEPARATOR = '~';
const QUERY_DIGEST_PATTERN = /^[0-9a-f]{32}$/;
const SUM_TEXT = /^-?\\d{1,20}$/;
const MICROS_PER_UNIT = 1000000n;
const DIMENSION_SQL = {
  backend: 'a.backend',
  model: 'a.model',
  workflowRevision: 'a.workflow_revision',
  phaseId: 'a.phase_id',
  attemptOutcome: 'a.outcome',
  utcDay: 'substr(a.first_event_utc, 1, 10)'
};

const db = new DatabaseSync(cfg.databasePath, {
  open: true,
  enableForeignKeyConstraints: true,
  enableDoubleQuotedStringLiterals: false,
  readOnly: true
});

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  if (!row) return undefined;
  const keys = Object.keys(row);
  return keys.length > 0 ? row[keys[0]] : undefined;
}

db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = ' + Number(cfg.busyTimeoutMs));
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
  throw Object.assign(new Error('read-only pragma verification failed'), { code: 'PRAGMA_VERIFICATION_FAILED' });
}

function refuse(code, detail) {
  return { ok: false, refusal: detail === undefined ? { code } : { code, detail } };
}

function parseSumText(text) {
  if (text === null || text === undefined) return 0n;
  if (!SUM_TEXT.test(text)) throw new Error('sum is not an exact integer');
  return BigInt(text);
}

function formatMicros(micros) {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const whole = magnitude / MICROS_PER_UNIT;
  const fraction = (magnitude % MICROS_PER_UNIT).toString().padStart(6, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + fraction;
}

function isDimensionValue(dimension, value) {
  switch (dimension) {
    case 'backend': return PATTERNS.backend.test(value);
    case 'model': return PATTERNS.model.test(value);
    case 'workflowRevision':
    case 'phaseId': return PATTERNS.identifier.test(value);
    case 'attemptOutcome': return cfg.attemptOutcomes.includes(value);
    case 'utcDay': return PATTERNS.utcDay.test(value);
    default: return false;
  }
}

function computeQueryDigest(request) {
  const filters = {};
  if (request.filters !== undefined) {
    for (const key of Object.keys(request.filters).sort()) {
      const value = request.filters[key];
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

function decodeQueryCursor(cursor, groupBy, expectedDigest) {
  if (cursor.length > cfg.maxQueryCursorChars) return undefined;
  const parts = cursor.split(CURSOR_SEPARATOR);
  if (parts.length !== groupBy.length + 3 || parts[0] !== QUERY_CURSOR_VERSION) return undefined;
  const revisionText = parts[1] ?? '';
  if (!/^[1-9]\\d{0,15}$/.test(revisionText)) return undefined;
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  const queryDigest = parts[2] ?? '';
  if (!QUERY_DIGEST_PATTERN.test(queryDigest) || queryDigest !== expectedDigest) return undefined;
  const keys = parts.slice(3);
  const valid = keys.every((key, index) => key === '' || isDimensionValue(groupBy[index], key));
  return valid ? { revision, queryDigest, keys } : undefined;
}

function encodeQueryCursor(revision, queryDigest, keys) {
  return [QUERY_CURSOR_VERSION, String(revision), queryDigest, ...keys].join(CURSOR_SEPARATOR);
}

function groupList(count, prefix = '') {
  return Array.from({ length: count }, (_, index) => prefix + 'g' + String(index)).join(', ');
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function attemptScope(request, revision) {
  const groupColumns = request.groupBy.map((dim, idx) => 'ifnull(' + DIMENSION_SQL[dim] + ", '') AS g" + String(idx));
  const conditions = [];
  const params = [];
  if (revision !== undefined) {
    conditions.push('EXISTS (SELECT 1 FROM accounting_contributions c WHERE c.attempt_id = a.attempt_id AND ' + VISIBLE + ')');
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
      if (value !== undefined) {
        conditions.push(DIMENSION_SQL[dim] + ' = ?');
        params.push(value);
      }
    }
  }
  if (request.rootIds !== undefined) {
    conditions.push('a.root_id IN (' + placeholders(request.rootIds.length) + ')');
    params.push(...request.rootIds);
  }
  const columns = [...groupColumns, 'a.attempt_id', 'a.root_id', 'a.last_event_utc'].join(', ');
  const where = conditions.length === 0 ? '' : ' WHERE ' + conditions.join(' AND ');
  return { sql: 'SELECT ' + columns + ' FROM accounting_attempts a' + where, params };
}

function readGroups(scope, dimensions, after, limit) {
  if (dimensions === 0) {
    const row = db.prepare('SELECT count(*) AS attempts, count(DISTINCT root_id) AS roots FROM (' + scope.sql + ')').get(...scope.params);
    const attempts = Number(row?.attempts ?? 0);
    return attempts === 0 ? [] : [{ keys: [], attempts, roots: Number(row?.roots ?? 0) }];
  }
  const groups = groupList(dimensions);
  const keyset = after === undefined ? '' : 'WHERE (' + groups + ') > (' + placeholders(dimensions) + ')';
  const rows = db.prepare(
    'SELECT ' + groups + ', count(*) AS attempts, count(DISTINCT root_id) AS roots FROM (' + scope.sql + ') ' + keyset +
      ' GROUP BY ' + groups + ' ORDER BY ' + groups + ' LIMIT ?'
  ).all(...scope.params, ...(after ?? []), limit);
  return rows.map((row) => ({
    keys: Array.from({ length: dimensions }, (_, index) => String(row['g' + String(index)])),
    attempts: Number(row.attempts),
    roots: Number(row.roots)
  }));
}

function groupKeyOf(row, dimensions) {
  return JSON.stringify(Array.from({ length: dimensions }, (_, index) => String(row['g' + String(index)])));
}

function pageRange(groups, dimensions) {
  if (dimensions === 0) return { sql: '1 = 1', params: [] };
  const first = groups[0];
  const last = groups[groups.length - 1];
  const columns = groupList(dimensions, 's.');
  return {
    sql: '(' + columns + ') >= (' + placeholders(dimensions) + ') AND (' + columns + ') <= (' + placeholders(dimensions) + ')',
    params: [...first.keys, ...last.keys]
  };
}

function measureFilter(measures) {
  if (measures === undefined) return { sql: '1 = 1', params: [] };
  return { sql: 'c.measure IN (' + placeholders(measures.length) + ')', params: measures };
}

function readMeasureAggregates(request, groups, revision) {
  const dimensions = request.groupBy.length;
  const joinScope = attemptScope(request);
  const range = pageRange(groups, dimensions);
  const filter = measureFilter(request.measures);
  const groupColumns = dimensions === 0 ? '' : groupList(dimensions, 's.') + ', ';
  const from = 'FROM (' + joinScope.sql + ') s JOIN accounting_contributions c ON c.attempt_id = s.attempt_id AND ' + VISIBLE +
    ' WHERE ' + range.sql + ' AND ' + filter.sql;
  const params = [...joinScope.params, revision, revision, ...range.params, ...filter.params];
  const aggregates = new Map();
  const sums = db.prepare(
    'SELECT ' + groupColumns + 'c.measure AS measure, c.unit AS unit,' +
    " CAST(SUM(CASE WHEN c.measure IN (" + OCCUPANCY_LIST + ") OR c.cost_origin IS 'estimated' THEN NULL ELSE c.quantity END) AS TEXT) AS lane_text," +
    " CAST(SUM(CASE WHEN c.cost_origin IS 'estimated' THEN c.quantity END) AS TEXT) AS estimated_text," +
    " count(DISTINCT c.attempt_id) - count(DISTINCT CASE WHEN c.cost_origin IS 'estimated' OR c.completeness <> 'known' OR c.quantity IS NULL THEN c.attempt_id END) AS known," +
    " MAX(CASE WHEN c.completeness = 'conflicting' THEN 1 ELSE 0 END) AS has_conflicting " +
    from + ' GROUP BY ' + groupColumns + 'c.measure, c.unit'
  ).all(...params);
  let hasOccupancy = false;
  for (const row of sums) {
    if (OCCUPANCY_SET.has(row.measure)) hasOccupancy = true;
    const groupKey = groupKeyOf(row, dimensions);
    aggregates.set(groupKey + '\\0' + row.measure + '\\0' + row.unit, {
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
  const partition = groupColumns + 'c.measure, c.unit';
  const latest = db.prepare(
    'SELECT * FROM (SELECT ' + groupColumns + 'c.measure AS measure, c.unit AS unit, CAST(c.quantity AS TEXT) AS quantity_text,' +
    ' ROW_NUMBER() OVER (PARTITION BY ' + partition + ' ORDER BY s.last_event_utc DESC, s.attempt_id DESC, c.invocation_ordinal DESC) AS position ' +
    from + ' AND c.measure IN (' + OCCUPANCY_LIST + ") AND c.completeness = 'known' AND c.quantity IS NOT NULL) WHERE position = 1"
  ).all(...params);
  for (const row of latest) {
    const aggregate = aggregates.get(groupKeyOf(row, dimensions) + '\\0' + row.measure + '\\0' + row.unit);
    if (aggregate !== undefined) aggregate.laneTotal = parseSumText(row.quantity_text);
  }
  return aggregates;
}

function formatQuantity(measure, value) {
  return MONEY_MEASURES.has(measure) ? formatMicros(value) : value.toString();
}

function completenessOf(known, denominator, hasConflicting) {
  if (hasConflicting) return 'conflicting';
  if (known >= denominator) return 'known';
  return known === 0 ? 'unknown' : 'partial';
}

function toMeasureTotal(aggregate, denominator) {
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

function compareMeasures(left, right) {
  const byMeasure = cfg.measures.indexOf(left.measure) - cfg.measures.indexOf(right.measure);
  if (byMeasure !== 0) return byMeasure;
  if (left.unit === right.unit) return 0;
  return left.unit < right.unit ? -1 : 1;
}

function buildRows(request, groups, aggregates, maxUnitsPerRowMeasure) {
  const byGroup = new Map();
  for (const aggregate of aggregates.values()) {
    const list = byGroup.get(aggregate.groupKey) ?? [];
    list.push(aggregate);
    byGroup.set(aggregate.groupKey, list);
  }
  return groups.map((group) => {
    const key = {};
    request.groupBy.forEach((dimension, index) => {
      const value = group.keys[index] ?? '';
      key[dimension] = value === '' ? null : value;
    });
    const sorted = (byGroup.get(JSON.stringify(group.keys)) ?? []).sort(compareMeasures);
    const kept = [];
    const seenPerMeasure = new Map();
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
}

function executeQuery(request, bounds) {
  const started = performance.now();
  const overDeadline = () => performance.now() - started > bounds.queryDeadlineMs;
  if (overDeadline()) return refuse('deadline-exceeded');
  if (request.limit > bounds.maxQueryLimit) return refuse('invalid-query', 'limit');

  const dimensions = request.groupBy.length;
  const queryDigest = computeQueryDigest(request);
  const cursor = request.cursor === undefined ? undefined : decodeQueryCursor(request.cursor, request.groupBy, queryDigest);
  if (request.cursor !== undefined && (cursor === undefined || dimensions === 0)) return refuse('invalid-query', 'cursor');

  // Execute all multi-statement reads inside a single WAL read snapshot so concurrent host writes
  // (e.g. outcome updates, pruneExpired compaction, restore) cannot tear groups against aggregates.
  let inReadTransaction = false;
  db.exec('BEGIN DEFERRED');
  inReadTransaction = true;
  try {
    const latest = Number(scalar('SELECT COALESCE(MAX(revision), 0) FROM accounting_revisions') ?? 0);
    if (request.asOfRevision !== undefined && request.asOfRevision > latest) return refuse('invalid-query', 'asOfRevision');
    if (cursor !== undefined && request.asOfRevision !== undefined && cursor.revision !== request.asOfRevision) return refuse('invalid-query', 'cursor');
    if (cursor !== undefined && cursor.revision > latest) return refuse('invalid-query', 'cursor');
    const revision = cursor?.revision ?? request.asOfRevision ?? latest;
    const floor = Number(scalar('SELECT COALESCE(MIN(revision), 0) FROM accounting_revisions') ?? 0);
    if (revision < floor) return { ok: false, refusal: { code: 'revision-compacted' } };

    let rows = [];
    let nextCursor;
    if (revision > 0) {
      const scope = attemptScope(request, revision);
      const fetched = readGroups(scope, dimensions, cursor?.keys, request.limit + 1);
      const groups = fetched.slice(0, request.limit);
      if (fetched.length > request.limit) nextCursor = encodeQueryCursor(revision, queryDigest, groups[groups.length - 1].keys);
      if (overDeadline()) return refuse('deadline-exceeded');
      if (groups.length > 0) {
        let aggregates;
        try {
          aggregates = readMeasureAggregates(request, groups, revision);
        } catch (error) {
          if (error instanceof Error && OVERFLOW_MESSAGE.test(error.message)) return refuse('aggregate-overflow');
          throw error;
        }
        rows = buildRows(request, groups, aggregates, bounds.maxUnitsPerRowMeasure);
      }
    }
    if (overDeadline()) return refuse('deadline-exceeded');

    const cutoffIngestSeq = revision === 0 ? 0 : Number(scalar('SELECT cutoff_ingest_seq FROM accounting_revisions WHERE revision = ?', revision) ?? 0);
    const unattributedCount = Number(scalar("SELECT count(*) FROM accounting_observations WHERE disposition = 'unattributed'") ?? 0);
    const gaps = db.prepare(
      'SELECT gap_kind AS kind, SUM(count) AS total FROM accounting_gaps GROUP BY gap_kind ORDER BY total DESC, kind LIMIT ?'
    ).all(cfg.maxReportedGapKinds).map((row) => ({ kind: row.kind, count: Number(row.total) }));

    let legacy;
    if (request.includeLegacy === true) {
      const row = db.prepare(
        'SELECT imported_runs, CAST(legacy_cost_micros AS TEXT) AS cost_text, boundary_run_id, boundary_terminal_utc, reconciliation FROM accounting_legacy_epoch WHERE epoch_id = 1'
      ).get();
      legacy = {
        runCount: Number(row?.imported_runs ?? 0),
        costMicros: row?.cost_text ?? '0',
        boundaryRunId: row?.boundary_run_id ?? null,
        boundaryTerminalUtc: row?.boundary_terminal_utc ?? null,
        reconciliation: row?.reconciliation ?? null,
        detail: 'unavailable'
      };
    }

    const response = {
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
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > bounds.maxResponseBytes) return refuse('response-too-large');
    return { ok: true, value: response };
  } finally {
    if (inReadTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors if the connection was already reset/closed.
      }
    }
  }
}

parentPort.on('message', (envelope) => {
  const started = performance.now();
  try {
    const result = executeQuery(envelope.request, envelope.bounds);
    parentPort.postMessage({ id: envelope.id, result, execMs: performance.now() - started });
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'WORKER_SQL_ERROR';
    parentPort.postMessage({ id: envelope.id, errorCode: code, execMs: performance.now() - started });
  }
});
`;

export function isFileBackedSqlitePath(databasePath: string): boolean {
  return databasePath.length > 0 && databasePath !== ':memory:' && !databasePath.startsWith('file::memory:');
}

export interface AccountingQueryWorkerClient {
  query(
    request: AccountingQueryRequest & { readonly limit: number },
    bounds: AccountingBounds,
    options?: AccountingWorkerQueryOptions
  ): Promise<AccountingResult<AccountingQueryResponse>>;
  close(): Promise<void>;
  /** Number of times a worker thread was spawned (diagnostics/tests). */
  readonly spawnCount: number;
  /** Number of times an in-flight worker was terminated for abort or deadline (diagnostics/tests). */
  readonly terminationCount: number;
}

export function createAccountingQueryWorkerClient(
  databasePath: string,
  options?: {
    readonly busyTimeoutMs?: number | undefined;
    readonly maxPendingQueries?: number | undefined;
    readonly idleTtlMs?: number | undefined;
    readonly onErrorCode?: ((errorCode: string) => void) | undefined;
  }
): AccountingQueryWorkerClient {
  const busyTimeoutMs = options?.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  const maxPending = options?.maxPendingQueries ?? MAX_PENDING_QUERIES;
  const idleTtlMs = options?.idleTtlMs ?? IDLE_WORKER_TTL_MS;

  let worker: Worker | null = null;
  let active: QueuedQuery | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let spawns = 0;
  let terminations = 0;
  const queue: QueuedQuery[] = [];
  const pendingTerminations = new Set<Promise<unknown>>();

  function trackTermination(dying: Worker): Promise<number> {
    const p = dying.terminate();
    const settled = p.finally(() => {
      pendingTerminations.delete(settled);
    });
    pendingTerminations.add(settled);
    return p;
  }

  const workerData: WorkerConfigPayload = {
    databasePath,
    busyTimeoutMs,
    policyVersion: ACCOUNTING_POLICY_VERSION,
    calculationVersion: ACCOUNTING_CALCULATION_VERSION,
    maxQueryCursorChars: MAX_QUERY_CURSOR_CHARS,
    maxReportedGapKinds: MAX_REPORTED_GAP_KINDS,
    attemptOutcomes: [...ATTEMPT_OUTCOMES],
    measures: [...MEASURES],
    occupancyMeasures: [...OCCUPANCY_MEASURES],
    patterns: {
      backend: DIMENSION_VALUE_PATTERNS.backend.source,
      model: DIMENSION_VALUE_PATTERNS.model.source,
      identifier: DIMENSION_VALUE_PATTERNS.identifier.source,
      utcDay: DIMENSION_VALUE_PATTERNS.utcDay.source
    }
  };

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearActiveTimer(): void {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
  }

  function scheduleIdleShutdown(): void {
    clearIdleTimer();
    if (worker === null || active !== null || queue.length > 0) return;
    worker.unref();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (worker !== null && active === null && queue.length === 0) {
        const dying = worker;
        worker = null;
        void trackTermination(dying);
      }
    }, idleTtlMs);
    idleTimer.unref();
  }

  function terminateCurrentWorker(): Promise<number> {
    clearIdleTimer();
    const dying = worker;
    worker = null;
    if (dying === null) return Promise.resolve(0);
    terminations += 1;
    return trackTermination(dying);
  }

  function finishActive(
    current: QueuedQuery,
    result: AccountingResult<AccountingQueryResponse>,
    workerExecMs: number,
    queueWaitMs: number
  ): void {
    if (active !== current) return;
    active = null;
    clearActiveTimer();
    current.abortCleanup?.();
    current.abortCleanup = undefined;
    try {
      current.onMetrics?.({ queueWaitMs, workerExecMs });
    } catch {
      // Metrics observer faults must not break query resolution.
    }
    current.resolve(result);
    pump();
  }

  function ensureWorker(): Worker {
    if (worker !== null) return worker;
    spawns += 1;
    const spawned = new Worker(WORKER_BOOTSTRAP_SCRIPT, {
      eval: true,
      workerData
    });
    spawned.on('message', (msg: WorkerResponseEnvelope) => {
      if (worker !== spawned || active === null || msg.id !== active.id) return;
      const current = active;
      if (msg.result !== undefined) {
        finishActive(current, msg.result, msg.execMs ?? 0, 0);
        return;
      }
      options?.onErrorCode?.(msg.errorCode ?? 'WORKER_SQL_ERROR');
      finishActive(current, { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } }, msg.execMs ?? 0, 0);
    });
    spawned.on('error', (err: Error) => {
      if (worker !== spawned) return;
      const code = (err as { code?: unknown }).code;
      options?.onErrorCode?.(typeof code === 'string' ? code : 'WORKER_ERROR');
      worker = null;
      if (active !== null) {
        const current = active;
        finishActive(current, { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } }, 0, 0);
      }
    });
    spawned.on('exit', () => {
      if (worker !== spawned) return;
      worker = null;
      if (active !== null) {
        const current = active;
        finishActive(current, { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } }, 0, 0);
      }
    });
    worker = spawned;
    return spawned;
  }

  function pump(): void {
    if (closed || active !== null) return;
    const next = queue.shift();
    if (next === undefined) {
      scheduleIdleShutdown();
      return;
    }
    if (next.signal?.aborted === true) {
      next.abortCleanup?.();
      next.abortCleanup = undefined;
      next.resolve({ ok: false, refusal: { code: 'deadline-exceeded' } });
      pump();
      return;
    }

    clearIdleTimer();
    const queueWaitMs = Math.max(0, performance.now() - next.enqueuedAtMs);
    const originalOnMetrics = next.onMetrics;
    const wrapped: QueuedQuery = {
      ...next,
      onMetrics:
        originalOnMetrics !== undefined
          ? (m) => originalOnMetrics({ queueWaitMs, workerExecMs: m.workerExecMs })
          : undefined
    };
    active = wrapped;

    const abortInFlight = (): void => {
      if (active !== wrapped) return;
      void terminateCurrentWorker();
      finishActive(wrapped, { ok: false, refusal: { code: 'deadline-exceeded' } }, 0, queueWaitMs);
    };

    next.abortCleanup?.();
    if (wrapped.signal !== undefined) {
      if (wrapped.signal.aborted) {
        abortInFlight();
        return;
      }
      const onAbort = (): void => abortInFlight();
      wrapped.signal.addEventListener('abort', onAbort, { once: true });
      wrapped.abortCleanup = () => wrapped.signal?.removeEventListener('abort', onAbort);
    }

    const timeoutMs = Math.max(1, wrapped.bounds.queryDeadlineMs);
    activeTimer = setTimeout(() => {
      abortInFlight();
    }, timeoutMs);

    try {
      const target = ensureWorker();
      target.ref();
      const envelope: WorkerRequestEnvelope = {
        id: wrapped.id,
        request: wrapped.request,
        bounds: wrapped.bounds
      };
      target.postMessage(envelope);
    } catch {
      options?.onErrorCode?.('WORKER_DISPATCH_FAILED');
      void terminateCurrentWorker();
      finishActive(wrapped, { ok: false, refusal: { code: 'store-error', detail: 'queryAsync' } }, 0, queueWaitMs);
    }
  }

  return {
    get spawnCount(): number {
      return spawns;
    },
    get terminationCount(): number {
      return terminations;
    },
    query(request, bounds, queryOptions) {
      if (closed) {
        return Promise.resolve({ ok: false, refusal: { code: 'store-unavailable' } });
      }
      const signal = queryOptions?.signal;
      if (signal?.aborted === true) {
        return Promise.resolve({ ok: false, refusal: { code: 'deadline-exceeded' } });
      }
      if (queue.length >= maxPending) {
        return Promise.resolve({ ok: false, refusal: { code: 'store-error', detail: 'query-queue-full' } });
      }
      return new Promise<AccountingResult<AccountingQueryResponse>>((resolve) => {
        const entry: QueuedQuery = {
          id: nextId++,
          request,
          bounds,
          enqueuedAtMs: performance.now(),
          signal,
          onMetrics: queryOptions?.onMetrics,
          resolve
        };
        if (signal !== undefined) {
          const onQueuedAbort = (): void => {
            const idx = queue.indexOf(entry);
            if (idx >= 0) {
              queue.splice(idx, 1);
              entry.abortCleanup = undefined;
              resolve({ ok: false, refusal: { code: 'deadline-exceeded' } });
            }
          };
          signal.addEventListener('abort', onQueuedAbort, { once: true });
          entry.abortCleanup = () => signal.removeEventListener('abort', onQueuedAbort);
        }
        queue.push(entry);
        pump();
      });
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      clearIdleTimer();
      clearActiveTimer();
      const pending = queue.splice(0, queue.length);
      for (const entry of pending) {
        entry.abortCleanup?.();
        entry.resolve({ ok: false, refusal: { code: 'store-unavailable' } });
      }
      const current = active;
      active = null;
      if (current !== null) {
        current.abortCleanup?.();
        current.resolve({ ok: false, refusal: { code: 'store-unavailable' } });
      }
      const dying = worker;
      worker = null;
      if (dying !== null) {
        void trackTermination(dying);
      }
      closePromise = Promise.allSettled([...pendingTerminations]).then(() => undefined);
      return closePromise;
    }
  };
}
