/**
 * FR-R6-F11 (FR-003, FR-011, FR-023; research R1, R12) — the run snapshot capture.
 *
 * One synchronous read transaction reads a report's whole run population: the roots of one
 * workspace created in `[start, min(end, cutoff))` that pass the filters, then the attempts of
 * those roots joined to their step. The rows are copied into frozen plain objects, so later pages
 * never see a root change under them.
 *
 * Every statement is fixed text with bound parameters only; a filter adds an `IN` list built from
 * its placeholder count, never from a value. `terminal_reason` is reduced to a failure cause here,
 * so its free text never leaves this file. More than `cap` roots or attempts is the typed limit
 * `snapshot-rows` (`LIMIT cap + 1`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { isFailureCause } from '../../contracts/failure-cause';
import type {
  AttemptStatus,
  ReportFilterKey,
  ReportFilters,
  ReportRange,
  RunOutcome
} from '../../contracts/reporting/report-query';
import { reportLimited, reportOk, type ReportResult } from '../../contracts/reporting/report-outcomes';

/** The failure cause of a root whose `terminal_reason` is null. */
export const CAUSE_NOT_RECORDED = 'not-recorded';
/** The failure cause of a root whose `terminal_reason` is not a known cause. */
export const CAUSE_OTHER = 'other';

export interface SnapshotRoot {
  readonly rootId: string;
  readonly workflowId: string;
  readonly frozenDefinitionId: string | null;
  readonly status: RunOutcome;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly createdAtMs: number;
  readonly failureCause: string;
}

export interface SnapshotAttempt {
  readonly attemptId: string;
  readonly rootId: string;
  readonly stepIndex: number;
  readonly phaseId: string | null;
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly exitCode: number | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
}

export interface CapturedRuns {
  readonly roots: readonly SnapshotRoot[];
  readonly attempts: readonly SnapshotAttempt[];
}

export interface CaptureRequest {
  readonly workspaceId: string;
  readonly range: ReportRange;
  /** The query-start clock reading; nothing created at or after it is read. */
  readonly cutoffMs: number;
  readonly filters: ReportFilters;
  /** The most roots, and the most attempts, a snapshot may hold. */
  readonly cap: number;
}

/** The two connection methods the capture uses, so a test can observe them. */
export interface CaptureConnection {
  exec(sql: string): void;
  all<T>(sql: string, ...params: (string | number)[]): T[];
}

const ROOT_COLUMNS = `r.run_id, r.workflow_id, r.frozen_closure_id, r.status, r.started_at_ms,
  r.completed_at_ms, r.created_at_ms, r.terminal_reason`;
const ROOT_RANGE = `r.workspace_id = ? AND r.created_at_ms >= ? AND r.created_at_ms < ?`;
const ROOT_ORDER = `ORDER BY r.created_at_ms, r.run_id`;
const ATTEMPT_COLUMNS = `a.attempt_id, a.run_id, s.step_index, s.phase_id, a.attempt_number, a.status,
  a.exit_code, a.started_at_ms, a.completed_at_ms`;
const ATTEMPT_FROM = `FROM runs r JOIN attempts a ON a.run_id = r.run_id JOIN steps s ON s.step_id = a.step_id`;
const ATTEMPT_ORDER = `ORDER BY r.created_at_ms, r.run_id, s.step_index, a.attempt_number, a.attempt_id`;

/** The root read with no filter; parameters are workspace, start, end and limit. */
export const CAPTURE_ROOTS_SQL = `SELECT ${ROOT_COLUMNS} FROM runs r WHERE ${ROOT_RANGE} ${ROOT_ORDER} LIMIT ?`;
/** The attempt read with no filter; parameters are workspace, start, end and limit. */
export const CAPTURE_ATTEMPTS_SQL = `SELECT ${ATTEMPT_COLUMNS} ${ATTEMPT_FROM} WHERE ${ROOT_RANGE} ${ATTEMPT_ORDER} LIMIT ?`;

/** The run column each run-derived filter narrows; usage filters never reach the run store. */
const FILTER_COLUMNS: Readonly<Partial<Record<ReportFilterKey, string>>> = Object.freeze({
  rootId: 'r.run_id',
  workflowId: 'r.workflow_id',
  frozenDefinitionId: 'r.frozen_closure_id',
  outcome: 'r.status'
});

interface RootRecord {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly frozen_closure_id: string | null;
  readonly status: RunOutcome;
  readonly started_at_ms: number | null;
  readonly completed_at_ms: number | null;
  readonly created_at_ms: number;
  readonly terminal_reason: string | null;
}

interface AttemptRecord {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly phase_id: string | null;
  readonly attempt_number: number;
  readonly status: AttemptStatus;
  readonly exit_code: number | null;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
}

interface FilterClause {
  readonly sql: string;
  readonly params: readonly string[];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function filterClause(filters: ReportFilters): FilterClause {
  const parts: string[] = [];
  const params: string[] = [];
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    const values = filters[key as ReportFilterKey];
    if (values === undefined || values.length === 0) {
      continue;
    }
    parts.push(`AND ${column} IN (${placeholders(values.length)})`);
    params.push(...values);
  }
  return { sql: parts.join(' '), params };
}

/** Research R12: a known cause is kept, null is `not-recorded`, any other text is `other`. */
export function mapFailureCause(terminalReason: string | null): string {
  if (terminalReason === null) {
    return CAUSE_NOT_RECORDED;
  }
  return isFailureCause(terminalReason) ? terminalReason : CAUSE_OTHER;
}

function toRoot(record: RootRecord): SnapshotRoot {
  return Object.freeze({
    rootId: record.run_id,
    workflowId: record.workflow_id,
    frozenDefinitionId: record.frozen_closure_id,
    status: record.status,
    startedAtMs: record.started_at_ms,
    completedAtMs: record.completed_at_ms,
    createdAtMs: record.created_at_ms,
    failureCause: mapFailureCause(record.terminal_reason)
  });
}

function toAttempt(record: AttemptRecord): SnapshotAttempt {
  return Object.freeze({
    attemptId: record.attempt_id,
    rootId: record.run_id,
    stepIndex: record.step_index,
    phaseId: record.phase_id,
    attemptNumber: record.attempt_number,
    status: record.status,
    exitCode: record.exit_code,
    startedAtMs: record.started_at_ms,
    completedAtMs: record.completed_at_ms
  });
}

function readPopulation(conn: CaptureConnection, request: CaptureRequest): ReportResult<CapturedRuns> {
  const filter = filterClause(request.filters);
  const endMs = Math.min(request.range.endMs, request.cutoffMs);
  const head = [request.workspaceId, request.range.startMs, endMs] as const;
  const limit = request.cap + 1;
  const roots = conn.all<RootRecord>(
    `SELECT ${ROOT_COLUMNS} FROM runs r WHERE ${ROOT_RANGE} ${filter.sql} ${ROOT_ORDER} LIMIT ?`,
    ...head,
    ...filter.params,
    limit
  );
  if (roots.length > request.cap) {
    return reportLimited('snapshot-rows');
  }
  const attempts = conn.all<AttemptRecord>(
    `SELECT ${ATTEMPT_COLUMNS} ${ATTEMPT_FROM} WHERE ${ROOT_RANGE} ${filter.sql} ${ATTEMPT_ORDER} LIMIT ?`,
    ...head,
    ...filter.params,
    limit
  );
  if (attempts.length > request.cap) {
    return reportLimited('snapshot-rows');
  }
  return reportOk(
    Object.freeze({
      roots: Object.freeze(roots.map(toRoot)),
      attempts: Object.freeze(attempts.map(toAttempt))
    })
  );
}

/**
 * Reads the run population of one report in one read transaction. A read failure rolls the
 * transaction back and is rethrown; the caller maps it to `source-read-failed`.
 */
export function captureRunSnapshot(conn: CaptureConnection, request: CaptureRequest): ReportResult<CapturedRuns> {
  conn.exec('BEGIN');
  let result: ReportResult<CapturedRuns>;
  try {
    result = readPopulation(conn, request);
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
  conn.exec('COMMIT');
  return result;
}
