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
import type {
  AttemptAcpAttribution,
  AttemptHandoffSummary,
  ReportEvidenceReference,
  RootReviewLoopSummary
} from '../../contracts/reporting/report-rows';

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
  readonly evidenceRefs?: readonly ReportEvidenceReference[];
  readonly acpAttributions?: readonly AttemptAcpAttribution[];
  readonly handoffSummaries?: readonly AttemptHandoffSummary[];
  readonly reviewSummaries?: readonly RootReviewLoopSummary[];
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

function scrubSeparators(value: string): string {
  return value.replaceAll('/', ':').replaceAll('\\', ':');
}

function scrubOptionalSeparators(value: string | null): string | null {
  return value === null ? null : scrubSeparators(value);
}

interface EvidenceRecord {
  readonly artifact_id: string;
  readonly owner_run_id: string;
  readonly owner_attempt_id: string | null;
  readonly store_kind: string;
  readonly availability: string;
  readonly byte_size: number;
  readonly retention_class: string;
}

interface AcpAttributionRecord {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly backend_kind: string | null;
  readonly model_id: string | null;
  readonly profile_id: string | null;
  readonly lane_id: string | null;
  readonly live_observations: number;
}

interface HandoffSummaryRecord {
  readonly handoff_id: string;
  readonly run_id: string;
  readonly source_attempt_id: string;
  readonly target_phase_id: string;
  readonly revision: number;
  readonly status: string;
  readonly record_bytes: number;
}

interface ReviewLoopRecord {
  readonly loop_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly iteration: number;
  readonly verdict: string;
  readonly ledger_json: string;
}

function parseReviewCounts(ledgerJson: string): {
  readonly candidateRef: string | null;
  readonly openFindings: number;
  readonly resolvedFindings: number;
  readonly totalFindings: number;
} {
  try {
    const parsed = JSON.parse(ledgerJson) as {
      readonly candidateRef?: unknown;
      readonly snapshot?: { readonly findings?: readonly { readonly status?: unknown }[] };
    };
    const findings = Array.isArray(parsed.snapshot?.findings) ? parsed.snapshot.findings : [];
    let openFindings = 0;
    let resolvedFindings = 0;
    for (const item of findings) {
      if (item?.status === 'resolved') resolvedFindings += 1;
      else openFindings += 1;
    }
    return {
      candidateRef:
        typeof parsed.candidateRef === 'string' ? scrubSeparators(parsed.candidateRef) : null,
      openFindings,
      resolvedFindings,
      totalFindings: findings.length
    };
  } catch {
    return { candidateRef: null, openFindings: 0, resolvedFindings: 0, totalFindings: 0 };
  }
}

function readAuxiliaryMetadata(
  conn: CaptureConnection,
  head: readonly [string, number, number],
  filter: FilterClause,
  endMs: number,
  cap: number
): Partial<Pick<CapturedRuns, 'evidenceRefs' | 'acpAttributions' | 'handoffSummaries' | 'reviewSummaries'>> {
  const evidenceRows = conn.all<EvidenceRecord>(
    `SELECT al.artifact_id, al.owner_run_id, al.owner_attempt_id, al.store_kind, al.availability,
       al.byte_size, al.retention_class
     FROM artifact_lifecycle al
     JOIN runs r ON r.run_id = al.owner_run_id
     WHERE ${ROOT_RANGE} ${filter.sql} AND al.created_at_ms < ?
     ORDER BY al.owner_run_id, al.artifact_id LIMIT ?`,
    ...head,
    ...filter.params,
    endMs,
    cap
  );
  const attributionRows = conn.all<AcpAttributionRecord>(
    `SELECT a.attempt_id, a.run_id,
       COALESCE(a.backend_kind, r.backend_kind) AS backend_kind,
       COALESCE(a.model_id, r.model_id) AS model_id,
       COALESCE(a.profile_id, r.profile_id) AS profile_id,
       COALESCE(a.lane_id, r.lane_id) AS lane_id,
       (SELECT COUNT(*) FROM acp_observation_ledger obs
          WHERE obs.attempt_id = a.attempt_id AND obs.origin = 'live' AND obs.observed_at_ms < ?) AS live_observations
     FROM attempts a
     JOIN runs r ON r.run_id = a.run_id
     WHERE ${ROOT_RANGE} ${filter.sql}
     ORDER BY a.run_id, a.attempt_id LIMIT ?`,
    endMs,
    ...head,
    ...filter.params,
    cap
  );
  const handoffRows = conn.all<HandoffSummaryRecord>(
    `SELECT phr.handoff_id, phr.run_id, phr.source_attempt_id, phr.target_phase_id,
       phr.revision, phr.status, phr.record_bytes
     FROM phase_handoff_records phr
     JOIN runs r ON r.run_id = phr.run_id
     WHERE ${ROOT_RANGE} ${filter.sql} AND phr.created_at_ms < ?
     ORDER BY phr.run_id, phr.handoff_id LIMIT ?`,
    ...head,
    ...filter.params,
    endMs,
    cap
  );
  const reviewRows = conn.all<ReviewLoopRecord>(
    `SELECT prl.loop_id, prl.run_id, prl.node_id, prl.iteration, prl.verdict, prl.ledger_json
     FROM phase_review_loop_ledgers prl
     JOIN runs r ON r.run_id = prl.run_id
     WHERE ${ROOT_RANGE} ${filter.sql} AND prl.updated_at_ms < ?
     ORDER BY prl.run_id, prl.loop_id LIMIT ?`,
    ...head,
    ...filter.params,
    endMs,
    cap
  );

  const evidenceRefs = evidenceRows.map((row) =>
    Object.freeze({
      artifactId: scrubSeparators(row.artifact_id),
      rootId: scrubSeparators(row.owner_run_id),
      attemptId: scrubOptionalSeparators(row.owner_attempt_id),
      storeKind: scrubSeparators(row.store_kind),
      availability: scrubSeparators(row.availability),
      byteSize: row.byte_size,
      retentionClass: scrubSeparators(row.retention_class)
    })
  );

  const acpAttributions = attributionRows
    .filter(
      (row) =>
        row.backend_kind !== null ||
        row.model_id !== null ||
        row.profile_id !== null ||
        row.lane_id !== null ||
        row.live_observations > 0
    )
    .map((row) =>
      Object.freeze({
        attemptId: scrubSeparators(row.attempt_id),
        rootId: scrubSeparators(row.run_id),
        backendKind: scrubOptionalSeparators(row.backend_kind),
        modelId: scrubOptionalSeparators(row.model_id),
        profileId: scrubOptionalSeparators(row.profile_id),
        laneId: scrubOptionalSeparators(row.lane_id),
        liveObservations: row.live_observations
      })
    );

  const handoffSummaries = handoffRows.map((row) =>
    Object.freeze({
      handoffId: scrubSeparators(row.handoff_id),
      rootId: scrubSeparators(row.run_id),
      sourceAttemptId: scrubSeparators(row.source_attempt_id),
      targetPhaseId: scrubSeparators(row.target_phase_id),
      revision: row.revision,
      status: scrubSeparators(row.status),
      recordBytes: row.record_bytes
    })
  );

  const reviewSummaries = reviewRows.map((row) => {
    const counts = parseReviewCounts(row.ledger_json);
    return Object.freeze({
      loopId: scrubSeparators(row.loop_id),
      rootId: scrubSeparators(row.run_id),
      nodeId: scrubSeparators(row.node_id),
      iteration: row.iteration,
      verdict: scrubSeparators(row.verdict),
      ...counts
    });
  });

  return {
    ...(evidenceRefs.length > 0 ? { evidenceRefs: Object.freeze(evidenceRefs) } : {}),
    ...(acpAttributions.length > 0 ? { acpAttributions: Object.freeze(acpAttributions) } : {}),
    ...(handoffSummaries.length > 0 ? { handoffSummaries: Object.freeze(handoffSummaries) } : {}),
    ...(reviewSummaries.length > 0 ? { reviewSummaries: Object.freeze(reviewSummaries) } : {})
  };
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
  const aux = roots.length > 0 ? readAuxiliaryMetadata(conn, head, filter, endMs, request.cap) : {};
  return reportOk(
    Object.freeze({
      roots: Object.freeze(roots.map(toRoot)),
      attempts: Object.freeze(attempts.map(toAttempt)),
      ...aux
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
