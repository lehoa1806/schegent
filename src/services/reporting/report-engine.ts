/**
 * FR-R6-F11 (FR-003..FR-006, FR-010, FR-022; research R1, R2, R9, R11, R13) — the report engine.
 *
 * `runReport` validates the query, takes an admission slot, then captures its sources
 * (report-capture.ts). The population digest and working-data estimate are reserved before the
 * rows are built, then the rows' own estimate; the report registers under a lease and answers its
 * first page. Every per-row pass runs through the work slicer, so the query deadline and the
 * caller's signal end it.
 *
 * `readPage`, `drillDown` and `closeReport` sweep expired reports first. Every operation refuses
 * an input whose key set is not exact with `invalid-query`.
 *
 * Saved reports (research R10) use two more entries: `rerunReport` runs a saved query at a new
 * cutoff under a new identity that carries `rerunOf`, and `recapture` re-reads a saved query's
 * population at its saved cutoff and accounting revision and answers only its digest; it holds an
 * admission slot and a reservation while it reads, and registers nothing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { randomUUID } from 'node:crypto';
import { REPORT_CALCULATION_VERSION } from '../../contracts/reporting/report-manifest';
import {
  reportCancelled,
  reportOk,
  reportRefused,
  type ReportProgress,
  type ReportProgressListener,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import { MAX_PAGE_BYTES, type ReportQuery } from '../../contracts/reporting/report-query';
import type { ReportCoverage, ReportPage, ReportRow, RootDrillDown } from '../../contracts/reporting/report-rows';
import { DIMENSION_VALUE_PATTERNS } from '../../contracts/usage-accounting/query-contract';
import { buildRunRows } from './report-aggregates';
import { captureReport, sourcesOf, type Capture, type ReportingLogger } from './report-capture';
import { encodeReportCursor, resolveReportCursor } from './report-cursor';
import { drillIntoRoot } from './report-drill-down';
import { canonicalQueryJson, queryDigest, validateReportQuery } from './report-query-validator';
import {
  measurePopulation,
  ReportSnapshots,
  type LiveReport,
  type ReportResources,
  type ReportSnapshotBounds,
  type ReservationTally
} from './report-snapshots';
import { toUtcIso } from './report-time';
import type { AccountingPort } from './report-usage';
import { createWorkSlicer, type WorkSlicer } from './work-slicer';
import type { CaptureConnection } from './snapshot-capture';

export type { ReportingLogger } from './report-capture';

/** The most roots, or attempts, one snapshot may hold (research R1). */
export const DEFAULT_SNAPSHOT_CAP = 100_000;
/** The query deadline (research R9). */
export const DEFAULT_QUERY_DEADLINE_MS = 5_000;

const INVALID_QUERY = reportRefused('invalid-query');

export interface ReportEngineBounds extends ReportSnapshotBounds {
  readonly snapshotCap?: number;
  readonly queryDeadlineMs?: number;
  readonly sliceMs?: number;
  /** The most serialised row bytes one page carries; a page always has at least one row. */
  readonly maxPageBytes?: number;
}

export interface ReportEngineOptions {
  /** Runs `read` against the run store's read connection. */
  readonly readSource: <T>(read: (source: CaptureConnection) => T) => T;
  readonly workspaceId: string;
  readonly nowMs: () => number;
  readonly monotonicMs: () => number;
  readonly hostTimezone: string;
  readonly accounting: AccountingPort | null;
  readonly bounds?: ReportEngineBounds;
  readonly logger?: ReportingLogger;
}

export interface ReportEngine {
  runReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ReportPage>>;
  /** Runs a saved report's query at a new cutoff; the new report carries `rerunOf`. */
  rerunReport(
    input: unknown,
    rerunOf: string,
    signal?: AbortSignal,
    progress?: ReportProgressListener
  ): Promise<ReportResult<ReportPage>>;
  /** Re-reads a saved query's population at its saved cutoff and revision; answers its digest. */
  recapture(
    input: unknown,
    cutoffMs: number,
    accountingRevision: number | null,
    signal?: AbortSignal
  ): Promise<ReportResult<{ readonly populationDigest: string }>>;
  readPage(input: unknown): ReportResult<ReportPage>;
  drillDown(input: unknown): ReportResult<RootDrillDown>;
  closeReport(input: unknown): ReportResult<{ readonly released: boolean }>;
  /** The live report an export reads; `expired` once its lease has ended. */
  useReport(reportId: string): ReportResult<LiveReport>;
  resources(): ReportResources;
}

interface RunContext {
  readonly reportId: string;
  readonly query: ReportQuery;
  readonly cutoffMs: number;
  readonly signal: AbortSignal | undefined;
  readonly rerunOf: string | undefined;
  readonly emit: (phase: ReportProgress['phase'], rowsDone: number, rowsTotal?: number) => void;
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => actual.includes(key)) ? record : undefined;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && DIMENSION_VALUE_PATTERNS.identifier.test(value);
}

function rowBytes(row: ReportRow): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
}

/** Creates the report engine of one workspace. */
export function createReportEngine(options: ReportEngineOptions): ReportEngine {
  const bounds = options.bounds ?? {};
  const snapshotCap = bounds.snapshotCap ?? DEFAULT_SNAPSHOT_CAP;
  const deadlineMs = bounds.queryDeadlineMs ?? DEFAULT_QUERY_DEADLINE_MS;
  const maxPageBytes = bounds.maxPageBytes ?? MAX_PAGE_BYTES;
  const snapshots = new ReportSnapshots(bounds);
  const { accounting } = options;
  const source = {
    readSource: options.readSource,
    workspaceId: options.workspaceId,
    accounting,
    snapshotCap,
    ...(options.logger !== undefined ? { logger: options.logger } : {})
  };

  function pageAt(report: LiveReport, offset: number): ReportPage {
    const rows: ReportRow[] = [];
    let bytes = 0;
    let next = offset;
    for (let row = report.rows.at(next); row !== undefined && rows.length < report.query.pageSize; row = report.rows.at(next)) {
      const size = rowBytes(row);
      if (rows.length > 0 && bytes + size > maxPageBytes) {
        break;
      }
      rows.push(row);
      bytes += size;
      next += 1;
    }
    return Object.freeze({
      reportId: report.reportId,
      outcome: 'complete',
      view: report.query.view,
      rows: Object.freeze(rows),
      cursor: next < report.rows.length ? encodeReportCursor(report.reportId, report.queryDigest, next) : null,
      rowCount: report.rows.length,
      sourceCutoffUtc: toUtcIso(report.sourceCutoffMs),
      accountingRevision: report.accountingRevision,
      calculationVersion: report.calculationVersion,
      coverage: report.coverage,
      timeBasis: report.timeBasis,
      omissions: report.omissions,
      ...(report.legacy !== undefined ? { legacy: report.legacy } : {}),
      ...(report.rerunOf !== undefined ? { rerunOf: report.rerunOf } : {})
    });
  }

  function slicerFor(signal: AbortSignal | undefined): WorkSlicer {
    return createWorkSlicer({
      monotonicMs: options.monotonicMs,
      deadlineAtMs: options.monotonicMs() + deadlineMs,
      ...(signal !== undefined ? { signal } : {}),
      ...(bounds.sliceMs !== undefined ? { sliceMs: bounds.sliceMs } : {})
    });
  }

  function newIdentity(): string {
    return randomUUID().replaceAll('-', '');
  }

  async function aggregate(
    context: RunContext,
    capture: Capture,
    slicer: WorkSlicer
  ): Promise<ReportResult<{ readonly rows: readonly ReportRow[]; readonly coverage: ReportCoverage }>> {
    if (capture.usage !== undefined) {
      context.emit('aggregating', 0, capture.usage.rows.length);
      return reportOk(capture.usage);
    }
    context.emit('aggregating', 0, capture.roots.length);
    return buildRunRows(context.query, { roots: capture.roots, attempts: capture.attempts }, slicer);
  }

  async function capturedReport(context: RunContext, tally: ReservationTally): Promise<ReportResult<LiveReport>> {
    const slicer = slicerFor(context.signal);
    context.emit('capturing', 0);
    const capture = captureReport(source, context.query, context.cutoffMs, context.signal);
    if (!capture.ok) {
      return capture;
    }
    const population = await measurePopulation(sourcesOf(capture.value), slicer);
    if (!population.ok) {
      return population;
    }
    const heldPopulation = snapshots.reserve(tally, population.value.bytes);
    if (!heldPopulation.ok) {
      return heldPopulation;
    }
    const built = await aggregate(context, capture.value, slicer);
    if (!built.ok) {
      return built;
    }
    // The usage view's rows are the captured rows, already reserved with the population.
    const measured = await measurePopulation(capture.value.usage === undefined ? [built.value.rows] : [], slicer);
    if (!measured.ok) {
      return measured;
    }
    const heldRows = snapshots.reserve(tally, measured.value.bytes);
    if (!heldRows.ok) {
      return heldRows;
    }
    context.emit('aggregating', built.value.rows.length, built.value.rows.length);
    return reportOk(
      Object.freeze({
        reportId: context.reportId,
        query: context.query,
        queryDigest: queryDigest(context.query),
        populationDigest: population.value.digest,
        sourceCutoffMs: context.cutoffMs,
        accountingRevision: capture.value.accountingRevision,
        calculationVersion: REPORT_CALCULATION_VERSION,
        roots: capture.value.roots,
        attempts: capture.value.attempts,
        rows: built.value.rows,
        coverage: built.value.coverage,
        timeBasis: context.query.view === 'usage' ? 'accounting-event' : 'root-created',
        omissions: capture.value.omissions,
        ...(capture.value.usage?.legacy !== undefined ? { legacy: capture.value.usage.legacy } : {}),
        ...(context.rerunOf !== undefined ? { rerunOf: context.rerunOf } : {})
      })
    );
  }

  async function run(
    input: unknown,
    rerunOf: string | undefined,
    signal: AbortSignal | undefined,
    progress: ReportProgressListener | undefined
  ): Promise<ReportResult<ReportPage>> {
    if (signal?.aborted === true) {
      return reportCancelled();
    }
    const startedMs = options.monotonicMs();
    const cutoffMs = options.nowMs();
    const validated = validateReportQuery(input, { nowMs: cutoffMs, hostTimezone: options.hostTimezone });
    if (!validated.ok) {
      return validated;
    }
    if (!snapshots.hasLeaseRoom(cutoffMs)) {
      return reportRefused('report-lease-limit');
    }
    const context: RunContext = {
      reportId: newIdentity(),
      query: validated.value,
      cutoffMs,
      signal,
      rerunOf,
      emit: (phase, rowsDone, rowsTotal) => {
        const elapsedMs = Math.max(0, options.monotonicMs() - startedMs);
        progress?.({ phase, rowsDone, ...(rowsTotal !== undefined ? { rowsTotal } : {}), elapsedMs });
      }
    };
    context.emit('admitting', 0);
    const parameterBytes = Buffer.byteLength(canonicalQueryJson(context.query), 'utf8');
    const admitted = await snapshots.admit(context.reportId, parameterBytes, signal);
    if (!admitted.ok) {
      return admitted;
    }
    const tally: ReservationTally = { bytes: 0 };
    try {
      const report = await capturedReport(context, tally);
      if (!report.ok) {
        return report;
      }
      const registered = snapshots.register(report.value, tally, options.nowMs());
      return registered.ok ? reportOk(pageAt(report.value, 0)) : registered;
    } finally {
      snapshots.releaseTally(tally);
      admitted.value.release();
    }
  }

  async function recapture(
    input: unknown,
    cutoffMs: number,
    accountingRevision: number | null,
    signal?: AbortSignal
  ): Promise<ReportResult<{ readonly populationDigest: string }>> {
    if (signal?.aborted === true) {
      return reportCancelled();
    }
    const validated = validateReportQuery(input, { nowMs: cutoffMs, hostTimezone: options.hostTimezone });
    if (!validated.ok) {
      return validated;
    }
    const query = validated.value;
    const admitted = await snapshots.admit(newIdentity(), Buffer.byteLength(canonicalQueryJson(query), 'utf8'), signal);
    if (!admitted.ok) {
      return admitted;
    }
    const tally: ReservationTally = { bytes: 0 };
    try {
      const capture = captureReport(source, query, cutoffMs, signal, accountingRevision ?? undefined);
      if (!capture.ok) {
        return capture;
      }
      const population = await measurePopulation(sourcesOf(capture.value), slicerFor(signal));
      if (!population.ok) {
        return population;
      }
      const held = snapshots.reserve(tally, population.value.bytes);
      return held.ok ? reportOk(Object.freeze({ populationDigest: population.value.digest })) : held;
    } finally {
      snapshots.releaseTally(tally);
      admitted.value.release();
    }
  }

  function readPage(input: unknown): ReportResult<ReportPage> {
    const record = exactRecord(input, ['cursor']);
    if (record === undefined) {
      return INVALID_QUERY;
    }
    const now = options.nowMs();
    snapshots.sweep(now);
    const resolved = resolveReportCursor(record.cursor, (reportId) => snapshots.lookup(reportId));
    if (!resolved.ok) {
      return resolved;
    }
    const used = snapshots.use(resolved.value.reportId, now);
    return used.ok ? reportOk(pageAt(used.value, resolved.value.offset)) : used;
  }

  function drillDown(input: unknown): ReportResult<RootDrillDown> {
    const record = exactRecord(input, ['reportId', 'rootId']);
    if (record === undefined || !isIdentifier(record.reportId) || !isIdentifier(record.rootId)) {
      return INVALID_QUERY;
    }
    const now = options.nowMs();
    snapshots.sweep(now);
    const used = snapshots.use(record.reportId, now);
    return used.ok ? drillIntoRoot(used.value, record.rootId, accounting, snapshotCap) : used;
  }

  function closeReport(input: unknown): ReportResult<{ readonly released: boolean }> {
    const record = exactRecord(input, ['reportId']);
    if (record === undefined || !isIdentifier(record.reportId)) {
      return INVALID_QUERY;
    }
    snapshots.sweep(options.nowMs());
    return reportOk(Object.freeze({ released: snapshots.close(record.reportId) }));
  }

  function useReport(reportId: string): ReportResult<LiveReport> {
    const now = options.nowMs();
    snapshots.sweep(now);
    return snapshots.use(reportId, now);
  }

  return Object.freeze({
    runReport: (input: unknown, signal?: AbortSignal, progress?: ReportProgressListener) => run(input, undefined, signal, progress),
    rerunReport: (input: unknown, rerunOf: string, signal?: AbortSignal, progress?: ReportProgressListener) =>
      run(input, rerunOf, signal, progress),
    recapture,
    readPage,
    drillDown,
    closeReport,
    useReport,
    resources: () => snapshots.resources()
  });
}
