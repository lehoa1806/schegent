/**
 * Typed, self-contained `node:worker_threads` entry module for read-only
 * chunked run-snapshot capture (`run-snapshot.worker.js` when bundled by esbuild;
 * executed directly from `.ts` source via Node's native erasable-TS type stripping
 * in Vitest).
 *
 * Erasable-only TypeScript syntax and zero runtime relative imports (`import type`
 * only) are mandatory so Node can execute this module directly without a loader.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type {
  AttemptStatus,
  ReportFilterKey,
  ReportFilters,
  RunOutcome
} from '../../contracts/reporting/report-query';
import type {
  AttemptAcpAttribution,
  AttemptHandoffSummary,
  ReportEvidenceReference,
  ReportOmission,
  RootReviewLoopSummary
} from '../../contracts/reporting/report-rows';
import type {
  CaptureRequest,
  SnapshotAttempt,
  SnapshotRoot
} from './snapshot-capture';

export interface RunSnapshotWorkerConfig {
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
  readonly chunkSize: number;
  readonly failureCauses: readonly string[];
  readonly causeNotRecorded: string;
  readonly causeOther: string;
  readonly truncationReason: string;
}

export type RunSnapshotWorkerRequestEnvelope =
  | { readonly kind: 'capture'; readonly id: number; readonly request: CaptureRequest }
  | { readonly kind: 'ack'; readonly id: number };

export type RunSnapshotWorkerChunkTarget =
  | 'roots'
  | 'attempts'
  | 'evidenceRefs'
  | 'acpAttributions'
  | 'handoffSummaries'
  | 'reviewSummaries';

export type RunSnapshotWorkerResponseMessage =
  | {
      readonly id: number;
      readonly kind: 'chunk';
      readonly target: RunSnapshotWorkerChunkTarget;
      readonly rows: readonly unknown[];
    }
  | {
      readonly id: number;
      readonly kind: 'done';
      readonly omissions: readonly ReportOmission[];
      readonly sqlReadMs: number;
      readonly totalWorkerMs: number;
    }
  | {
      readonly id: number;
      readonly kind: 'limited';
      readonly limit: 'snapshot-rows';
      readonly sqlReadMs: number;
      readonly totalWorkerMs: number;
    }
  | {
      readonly id: number;
      readonly kind: 'error';
      readonly errorCode: string;
      readonly totalWorkerMs: number;
    };

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

interface ChunkItem {
  readonly target: RunSnapshotWorkerChunkTarget;
  readonly rows: readonly unknown[];
}

interface ActiveStream {
  readonly id: number;
  readonly chunks: Array<ChunkItem | null>;
  index: number;
  readonly omissions: readonly ReportOmission[];
  readonly sqlReadMs: number;
  readonly started: number;
}

type CaptureOutcome =
  | { readonly kind: 'limited'; readonly limit: 'snapshot-rows'; readonly sqlReadMs: number }
  | {
      readonly kind: 'stream';
      readonly chunks: Array<ChunkItem | null>;
      readonly omissions: readonly ReportOmission[];
      readonly sqlReadMs: number;
      readonly started: number;
    };

const ROOT_COLUMNS =
  'r.run_id, r.workflow_id, r.frozen_closure_id, r.status, r.started_at_ms, r.completed_at_ms, r.created_at_ms, r.terminal_reason';
const ROOT_RANGE = 'r.workspace_id = ? AND r.created_at_ms >= ? AND r.created_at_ms < ?';
const ROOT_ORDER = 'ORDER BY r.created_at_ms, r.run_id';
const ATTEMPT_COLUMNS =
  'a.attempt_id, a.run_id, s.step_index, s.phase_id, a.attempt_number, a.status, a.exit_code, a.started_at_ms, a.completed_at_ms';
const ATTEMPT_FROM =
  'FROM runs r JOIN attempts a ON a.run_id = r.run_id JOIN steps s ON s.step_id = a.step_id';
const ATTEMPT_ORDER =
  'ORDER BY r.created_at_ms, r.run_id, s.step_index, a.attempt_number, a.attempt_id';

const FILTER_COLUMNS: Readonly<Partial<Record<ReportFilterKey, string>>> = {
  rootId: 'r.run_id',
  workflowId: 'r.workflow_id',
  frozenDefinitionId: 'r.frozen_closure_id',
  outcome: 'r.status'
};

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function filterClause(filters: ReportFilters): { readonly sql: string; readonly params: readonly string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    const values = filters[key as ReportFilterKey];
    if (values === undefined || values.length === 0) continue;
    parts.push(`AND ${column} IN (${placeholders(values.length)})`);
    params.push(...values);
  }
  return { sql: parts.join(' '), params };
}

function scrubSeparators(value: string): string {
  return value.replaceAll('/', ':').replaceAll('\\', ':');
}

function scrubOptionalSeparators(value: string | null): string | null {
  return value === null ? null : scrubSeparators(value);
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
      if (item.status === 'resolved') resolvedFindings += 1;
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
    // Malformed review ledger JSON falls back to zero counts, matching `snapshot-capture.ts`.
    return { candidateRef: null, openFindings: 0, resolvedFindings: 0, totalFindings: 0 };
  }
}

function startRunSnapshotWorker(cfg: RunSnapshotWorkerConfig): void {
  if (parentPort === null) return;
  const port = parentPort;
  const knownCauses = new Set<string>(cfg.failureCauses);

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

  const mapFailureCause = (terminalReason: string | null): string => {
    if (terminalReason === null) return cfg.causeNotRecorded;
    return knownCauses.has(terminalReason) ? terminalReason : cfg.causeOther;
  };

  const toRoot = (record: RootRecord): SnapshotRoot => ({
    completedAtMs: record.completed_at_ms,
    createdAtMs: record.created_at_ms,
    failureCause: mapFailureCause(record.terminal_reason),
    frozenDefinitionId: record.frozen_closure_id,
    rootId: record.run_id,
    startedAtMs: record.started_at_ms,
    status: record.status,
    workflowId: record.workflow_id
  });

  const toAttempt = (record: AttemptRecord): SnapshotAttempt => ({
    attemptId: record.attempt_id,
    attemptNumber: record.attempt_number,
    completedAtMs: record.completed_at_ms,
    exitCode: record.exit_code,
    phaseId: record.phase_id,
    rootId: record.run_id,
    startedAtMs: record.started_at_ms,
    status: record.status,
    stepIndex: record.step_index
  });

  const enqueueChunks = (
    queue: Array<ChunkItem | null>,
    target: RunSnapshotWorkerChunkTarget,
    rows: readonly unknown[]
  ): void => {
    const chunkSize = cfg.chunkSize;
    for (let i = 0; i < rows.length; i += chunkSize) {
      queue.push({ target, rows: rows.slice(i, i + chunkSize) });
    }
  };

  const executeCapture = (request: CaptureRequest): CaptureOutcome => {
    const started = performance.now();
    const filter = filterClause(request.filters);
    const endMs = Math.min(request.range.endMs, request.cutoffMs);
    const head: readonly SQLInputValue[] = [request.workspaceId, request.range.startMs, endMs];
    const cap = request.cap;
    const limit = cap + 1;

    let rawRoots: readonly RootRecord[] | null = [];
    let rawAttempts: readonly AttemptRecord[] | null = [];
    let rawEvidence: readonly EvidenceRecord[] | null = [];
    let rawAttribution: readonly AcpAttributionRecord[] | null = [];
    let rawHandoff: readonly HandoffSummaryRecord[] | null = [];
    let rawReview: readonly ReviewLoopRecord[] | null = [];
    const omissions: ReportOmission[] = [];
    let sqlReadMs = 0;

    db.exec('BEGIN DEFERRED');
    try {
      rawRoots = queryAll<RootRecord>(
        `SELECT ${ROOT_COLUMNS} FROM runs r WHERE ${ROOT_RANGE} ${filter.sql} ${ROOT_ORDER} LIMIT ?`,
        ...head,
        ...filter.params,
        limit
      );
      if (rawRoots.length > cap) {
        sqlReadMs = performance.now() - started;
        return { kind: 'limited', limit: 'snapshot-rows', sqlReadMs };
      }
      rawAttempts = queryAll<AttemptRecord>(
        `SELECT ${ATTEMPT_COLUMNS} ${ATTEMPT_FROM} WHERE ${ROOT_RANGE} ${filter.sql} ${ATTEMPT_ORDER} LIMIT ?`,
        ...head,
        ...filter.params,
        limit
      );
      if (rawAttempts.length > cap) {
        sqlReadMs = performance.now() - started;
        return { kind: 'limited', limit: 'snapshot-rows', sqlReadMs };
      }
      if (rawRoots.length > 0) {
        rawEvidence = queryAll<EvidenceRecord>(
          'SELECT al.artifact_id, al.owner_run_id, al.owner_attempt_id, al.store_kind, al.availability, al.byte_size, al.retention_class ' +
            'FROM artifact_lifecycle al JOIN runs r ON r.run_id = al.owner_run_id ' +
            `WHERE ${ROOT_RANGE} ${filter.sql} AND al.created_at_ms < ? ORDER BY al.owner_run_id, al.artifact_id LIMIT ?`,
          ...head,
          ...filter.params,
          endMs,
          limit
        );
        if (rawEvidence.length > cap) {
          omissions.push({ what: 'evidenceRefs', reason: cfg.truncationReason });
          rawEvidence = rawEvidence.slice(0, cap);
        }

        const hasObservations =
          queryAll<{ readonly ok: number }>('SELECT 1 AS ok FROM acp_observation_ledger LIMIT 1')
            .length > 0;
        rawAttribution = hasObservations
          ? queryAll<AcpAttributionRecord>(
              'SELECT a.attempt_id, a.run_id, ' +
                'COALESCE(a.backend_kind, r.backend_kind) AS backend_kind, ' +
                'COALESCE(a.model_id, r.model_id) AS model_id, ' +
                'COALESCE(a.profile_id, r.profile_id) AS profile_id, ' +
                'COALESCE(a.lane_id, r.lane_id) AS lane_id, ' +
                "(SELECT COUNT(*) FROM acp_observation_ledger obs WHERE obs.attempt_id = a.attempt_id AND obs.origin = 'live' AND obs.observed_at_ms < ?) AS live_observations " +
                `FROM attempts a JOIN runs r ON r.run_id = a.run_id WHERE ${ROOT_RANGE} ${filter.sql} ` +
                'AND (a.backend_kind IS NOT NULL OR r.backend_kind IS NOT NULL OR a.model_id IS NOT NULL OR r.model_id IS NOT NULL ' +
                'OR a.profile_id IS NOT NULL OR r.profile_id IS NOT NULL OR a.lane_id IS NOT NULL OR r.lane_id IS NOT NULL ' +
                "OR EXISTS (SELECT 1 FROM acp_observation_ledger obs WHERE obs.attempt_id = a.attempt_id AND obs.origin = 'live' AND obs.observed_at_ms < ?)) " +
                'ORDER BY a.run_id, a.attempt_id LIMIT ?',
              endMs,
              ...head,
              ...filter.params,
              endMs,
              limit
            )
          : queryAll<AcpAttributionRecord>(
              'SELECT a.attempt_id, a.run_id, ' +
                'COALESCE(a.backend_kind, r.backend_kind) AS backend_kind, ' +
                'COALESCE(a.model_id, r.model_id) AS model_id, ' +
                'COALESCE(a.profile_id, r.profile_id) AS profile_id, ' +
                'COALESCE(a.lane_id, r.lane_id) AS lane_id, 0 AS live_observations ' +
                `FROM attempts a JOIN runs r ON r.run_id = a.run_id WHERE ${ROOT_RANGE} ${filter.sql} ` +
                'AND (a.backend_kind IS NOT NULL OR r.backend_kind IS NOT NULL OR a.model_id IS NOT NULL OR r.model_id IS NOT NULL ' +
                'OR a.profile_id IS NOT NULL OR r.profile_id IS NOT NULL OR a.lane_id IS NOT NULL OR r.lane_id IS NOT NULL) ' +
                'ORDER BY a.run_id, a.attempt_id LIMIT ?',
              ...head,
              ...filter.params,
              limit
            );
        if (rawAttribution.length > cap) {
          omissions.push({ what: 'acpAttributions', reason: cfg.truncationReason });
          rawAttribution = rawAttribution.slice(0, cap);
        }

        rawHandoff = queryAll<HandoffSummaryRecord>(
          'SELECT phr.handoff_id, phr.run_id, phr.source_attempt_id, phr.target_phase_id, phr.revision, phr.status, phr.record_bytes ' +
            'FROM phase_handoff_records phr JOIN runs r ON r.run_id = phr.run_id ' +
            `WHERE ${ROOT_RANGE} ${filter.sql} AND phr.status IN ('accepted', 'ready', 'intent', 'delivered', 'uncertain') AND phr.created_at_ms < ? ` +
            'ORDER BY phr.run_id, phr.handoff_id LIMIT ?',
          ...head,
          ...filter.params,
          endMs,
          limit
        );
        if (rawHandoff.length > cap) {
          omissions.push({ what: 'handoffSummaries', reason: cfg.truncationReason });
          rawHandoff = rawHandoff.slice(0, cap);
        }

        rawReview = queryAll<ReviewLoopRecord>(
          'SELECT prl.loop_id, prl.run_id, prl.node_id, prl.iteration, prl.verdict, prl.ledger_json ' +
            'FROM phase_review_loop_ledgers prl JOIN runs r ON r.run_id = prl.run_id ' +
            `WHERE ${ROOT_RANGE} ${filter.sql} AND prl.updated_at_ms < ? ORDER BY prl.run_id, prl.loop_id LIMIT ?`,
          ...head,
          ...filter.params,
          endMs,
          limit
        );
        if (rawReview.length > cap) {
          omissions.push({ what: 'reviewSummaries', reason: cfg.truncationReason });
          rawReview = rawReview.slice(0, cap);
        }
      }
      sqlReadMs = performance.now() - started;
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure on closed/reset handle.
      }
    }

    // Transaction is already closed here so WAL checkpoints are never held while streaming chunks.
    const chunks: Array<ChunkItem | null> = [];
    if (rawRoots.length > 0) enqueueChunks(chunks, 'roots', rawRoots.map(toRoot));
    rawRoots = null;
    if (rawAttempts.length > 0) enqueueChunks(chunks, 'attempts', rawAttempts.map(toAttempt));
    rawAttempts = null;

    if (rawEvidence.length > 0) {
      const mappedEvidence: ReportEvidenceReference[] = rawEvidence.map((row) => ({
        artifactId: scrubSeparators(row.artifact_id),
        rootId: scrubSeparators(row.owner_run_id),
        attemptId: scrubOptionalSeparators(row.owner_attempt_id),
        storeKind: scrubSeparators(row.store_kind),
        availability: scrubSeparators(row.availability),
        byteSize: row.byte_size,
        retentionClass: scrubSeparators(row.retention_class)
      }));
      enqueueChunks(chunks, 'evidenceRefs', mappedEvidence);
      rawEvidence = null;
    }

    if (rawAttribution.length > 0) {
      const mappedAttribution: AttemptAcpAttribution[] = rawAttribution
        .filter(
          (row) =>
            row.backend_kind !== null ||
            row.model_id !== null ||
            row.profile_id !== null ||
            row.lane_id !== null ||
            row.live_observations > 0
        )
        .map((row) => ({
          attemptId: scrubSeparators(row.attempt_id),
          rootId: scrubSeparators(row.run_id),
          backendKind: scrubOptionalSeparators(row.backend_kind),
          modelId: scrubOptionalSeparators(row.model_id),
          profileId: scrubOptionalSeparators(row.profile_id),
          laneId: scrubOptionalSeparators(row.lane_id),
          liveObservations: row.live_observations
        }));
      rawAttribution = null;
      if (mappedAttribution.length > 0) enqueueChunks(chunks, 'acpAttributions', mappedAttribution);
    }

    if (rawHandoff.length > 0) {
      const mappedHandoff: AttemptHandoffSummary[] = rawHandoff.map((row) => ({
        handoffId: scrubSeparators(row.handoff_id),
        rootId: scrubSeparators(row.run_id),
        sourceAttemptId: scrubSeparators(row.source_attempt_id),
        targetPhaseId: scrubSeparators(row.target_phase_id),
        revision: row.revision,
        status: scrubSeparators(row.status),
        recordBytes: row.record_bytes
      }));
      enqueueChunks(chunks, 'handoffSummaries', mappedHandoff);
      rawHandoff = null;
    }

    if (rawReview.length > 0) {
      const mappedReview: RootReviewLoopSummary[] = rawReview.map((row) => ({
        loopId: scrubSeparators(row.loop_id),
        rootId: scrubSeparators(row.run_id),
        nodeId: scrubSeparators(row.node_id),
        iteration: row.iteration,
        verdict: scrubSeparators(row.verdict),
        ...parseReviewCounts(row.ledger_json)
      }));
      enqueueChunks(chunks, 'reviewSummaries', mappedReview);
      rawReview = null;
    }

    return { kind: 'stream', chunks, omissions, sqlReadMs, started };
  };

  let activeStream: ActiveStream | null = null;

  const sendNextChunk = (): void => {
    if (activeStream === null) return;
    if (activeStream.index < activeStream.chunks.length) {
      const next = activeStream.chunks.at(activeStream.index);
      activeStream.chunks[activeStream.index] = null;
      activeStream.index += 1;
      if (next !== null && next !== undefined) {
        const msg: RunSnapshotWorkerResponseMessage = {
          id: activeStream.id,
          kind: 'chunk',
          target: next.target,
          rows: next.rows
        };
        port.postMessage(msg);
      }
      return;
    }
    const done = activeStream;
    activeStream = null;
    const msg: RunSnapshotWorkerResponseMessage = {
      id: done.id,
      kind: 'done',
      omissions: done.omissions,
      sqlReadMs: done.sqlReadMs,
      totalWorkerMs: performance.now() - done.started
    };
    port.postMessage(msg);
  };

  port.on('message', (envelope: RunSnapshotWorkerRequestEnvelope) => {
    if (envelope.kind === 'ack') {
      if (activeStream !== null && activeStream.id === envelope.id) {
        sendNextChunk();
      }
      return;
    }
    const started = performance.now();
    try {
      const outcome = executeCapture(envelope.request);
      if (outcome.kind === 'limited') {
        const msg: RunSnapshotWorkerResponseMessage = {
          id: envelope.id,
          kind: 'limited',
          limit: outcome.limit,
          sqlReadMs: outcome.sqlReadMs,
          totalWorkerMs: performance.now() - started
        };
        port.postMessage(msg);
        return;
      }
      activeStream = {
        id: envelope.id,
        chunks: outcome.chunks,
        index: 0,
        omissions: outcome.omissions,
        sqlReadMs: outcome.sqlReadMs,
        started
      };
      sendNextChunk();
    } catch (err: unknown) {
      activeStream = null;
      const code =
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        typeof (err as { readonly code?: unknown }).code === 'string'
          ? (err as { readonly code: string }).code
          : 'WORKER_SQL_ERROR';
      const msg: RunSnapshotWorkerResponseMessage = {
        id: envelope.id,
        kind: 'error',
        errorCode: code,
        totalWorkerMs: performance.now() - started
      };
      port.postMessage(msg);
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
  startRunSnapshotWorker(workerData as RunSnapshotWorkerConfig);
}
