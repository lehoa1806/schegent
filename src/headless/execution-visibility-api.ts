/**
 * FR-R6-F12, FR-R6-F10, FR-R6-F13, FR-R6-F14, FR-R6-F15 — headless execution visibility and
 * runtime posture reader.
 *
 * Reads bounded SQLite projections for attempt hierarchy, evidence availability (`F05`), live log
 * stream/gap state (`F07`), durable recovery handoff certainty (`F08`), normalized ACP runtime
 * activity (`F13`), isolated lane & candidate integration state (`F10`), phase-context handoffs and
 * review-loop finding counts (`F15`), and OTLP telemetry export health/preview (`F14`).
 *
 * Zero filesystem paths, credentials, prompts, transcripts or findings prose leave this module.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { isFailureCause } from '../contracts/failure-cause';
import type {
  AttemptVisibilityRow,
  ExecutionAcpVisibility,
  ExecutionAttemptVisibility,
  ExecutionLaneCandidateVisibility,
  ExecutionLiveLogVisibility,
  ExecutionRecoveryVisibility,
  NormalizedAcpActivityState,
  RuntimePostureVisibility,
  VisibilityDataQuality,
  VisibilityRecoveryPosture,
  VisibilityStreamState
} from '../contracts/sidebar-ipc/execution-visibility';
import type {
  ReportEvidenceReference,
  RootReviewLoopSummary
} from '../contracts/reporting/report-rows';
import { TELEMETRY_EXPORT_BOUNDS } from '../contracts/telemetry-export';
import { comparisonRevision } from '../services/change-review/comparison-revision';
import type { SqliteApplicationStore } from '../services/sqlite-store';
import type { TelemetryHostService } from '../services/telemetry-host/telemetry-host-service';
import type { PhaseContextApi } from './phase-context-api';

const MAX_ATTEMPTS_PER_ROOT = 128;
const MAX_EVIDENCE_REFS_PER_ROOT = 64;
const MAX_REVIEW_LOOPS_PER_ROOT = 32;
const DEFAULT_LIVE_LANE_CAP = 4;

export interface ExecutionVisibilityApiDeps {
  readonly scopeId: string;
  readonly getSqliteStore: () => SqliteApplicationStore | null;
  readonly getPhaseContextApi: () => PhaseContextApi;
  readonly getTelemetryHost: () => TelemetryHostService | null;
  readonly isLanesEnabled: () => boolean;
}

export interface ExecutionVisibilityApi {
  readAttemptVisibility(request: {
    readonly rootExecutionId: string;
    readonly invocationId?: string;
    readonly attemptId?: string;
  }): ExecutionAttemptVisibility;
  readRuntimePosture(): RuntimePostureVisibility;
}

function scrub(value: string): string {
  return value.replaceAll('/', ':').replaceAll('\\', ':');
}

function scrubOpt(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? scrub(value) : null;
}

interface SqlRunRow {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly frozen_closure_id: string | null;
  readonly status: string;
  readonly invocation_count: number;
  readonly backend_kind: string | null;
  readonly model_id: string | null;
  readonly profile_id: string | null;
  readonly lane_id: string | null;
}

interface SqlAttemptRow {
  readonly attempt_id: string;
  readonly step_index: number;
  readonly phase_id: string | null;
  readonly attempt_number: number;
  readonly status: string;
  readonly exit_code: number | null;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly backend_kind: string | null;
  readonly model_id: string | null;
  readonly profile_id: string | null;
  readonly lane_id: string | null;
  readonly failure_cause: string | null;
}

interface SqlEvidenceRow {
  readonly artifact_id: string;
  readonly owner_run_id: string;
  readonly owner_attempt_id: string | null;
  readonly store_kind: string;
  readonly availability: string;
  readonly byte_size: number;
  readonly retention_class: string;
}

interface SqlReviewRow {
  readonly loop_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly iteration: number;
  readonly verdict: string;
  readonly ledger_json: string;
}

function emptyAttemptVisibility(rootExecutionId: string): ExecutionAttemptVisibility {
  return {
    available: false,
    unavailableReason: 'store-unavailable',
    rootExecutionId: scrub(rootExecutionId),
    hierarchy: {
      rootStatus: null,
      workflowId: null,
      frozenDefinitionId: null,
      invocationCount: 0,
      attemptCount: 0,
      dataQuality: 'unknown',
      attempts: []
    },
    evidence: [],
    liveLog: { streamState: 'unknown', segmentCount: 0, gapCount: 0 },
    recovery: { posture: 'not-recorded', reasonCode: null },
    acp: {
      runtimeState: 'not-recorded',
      profileId: null,
      backendKind: null,
      modelId: null,
      liveObservations: 0,
      pendingPermissions: 0
    },
    lane: {
      mode: 'shared-workspace',
      laneId: null,
      laneState: null,
      candidateId: null,
      integrationRequestId: null,
      integrationState: null,
      targetRef: null,
      comparisonRevision: null
    },
    handoffs: [],
    reviewLoops: []
  };
}

function parseReviewLoopCounts(ledgerJson: string): {
  readonly candidateRef: string | null;
  readonly openFindings: number;
  readonly resolvedFindings: number;
  readonly totalFindings: number;
} {
  try {
    const parsed = JSON.parse(ledgerJson) as {
      readonly candidateRef?: unknown;
      readonly findings?: unknown;
      readonly snapshot?: { readonly findings?: unknown } | null;
    };
    const rawFindings = parsed.snapshot?.findings ?? parsed.findings;
    const findings = Array.isArray(rawFindings) ? rawFindings : [];
    let openFindings = 0;
    let resolvedFindings = 0;
    for (const raw of findings) {
      const item = raw as { readonly status?: unknown } | null;
      if (item?.status === 'resolved') resolvedFindings += 1;
      else openFindings += 1;
    }
    return {
      candidateRef: typeof parsed.candidateRef === 'string' ? scrub(parsed.candidateRef) : null,
      openFindings,
      resolvedFindings,
      totalFindings: findings.length
    };
  } catch {
    return { candidateRef: null, openFindings: 0, resolvedFindings: 0, totalFindings: 0 };
  }
}

function readLiveLogVisibility(
  store: SqliteApplicationStore,
  rootExecutionId: string
): ExecutionLiveLogVisibility {
  const conn = store.writerConnection;
  const streams = conn.all<{ readonly stream_key: string; readonly capture_mode: string }>(
    `SELECT stream_key, capture_mode FROM live_log_streams
     WHERE stream_key LIKE ? OR stream_key LIKE ?
     ORDER BY updated_at_ms DESC LIMIT 32`,
    `${rootExecutionId}%`,
    `%:${rootExecutionId}:%`
  );
  if (streams.length === 0) {
    return { streamState: 'not-recorded' as VisibilityStreamState, segmentCount: 0, gapCount: 0 };
  }
  let segmentCount = 0;
  let gapCount = 0;
  let allDisabled = true;
  for (const s of streams) {
    if (s.capture_mode !== 'disabled') allDisabled = false;
    const seg = conn.get<{ readonly c: number }>(
      `SELECT COUNT(*) AS c FROM live_log_segments WHERE stream_key = ?`,
      s.stream_key
    );
    const gap = conn.get<{ readonly c: number }>(
      `SELECT COUNT(*) AS c FROM live_log_coverage WHERE stream_key = ?`,
      s.stream_key
    );
    segmentCount += seg?.c ?? 0;
    gapCount += gap?.c ?? 0;
  }
  let streamState: VisibilityStreamState;
  if (allDisabled) {
    streamState = 'not-captured';
  } else if (gapCount > 0) {
    streamState = 'partial';
  } else if (segmentCount > 0) {
    streamState = 'captured';
  } else {
    streamState = 'unknown';
  }
  return { streamState, segmentCount, gapCount };
}

function readRecoveryVisibility(
  store: SqliteApplicationStore,
  scopeId: string,
  rootExecutionId: string
): ExecutionRecoveryVisibility {
  const conn = store.writerConnection;
  const row = conn.get<{
    readonly handoff_id: string;
    readonly state: string;
    readonly current_revision: number | null;
  }>(
    `SELECT handoff_id, state, current_revision FROM recovery_handoffs
     WHERE workspace_id = ? AND root_execution_id = ?
     ORDER BY updated_at_ms DESC LIMIT 1`,
    scopeId,
    rootExecutionId
  );
  if (row === undefined) {
    return { posture: 'not-recorded', reasonCode: null };
  }
  let certainty: string | null = null;
  if (row.current_revision !== null) {
    const rev = conn.get<{ readonly certainty: string }>(
      `SELECT certainty FROM recovery_handoff_revisions
       WHERE handoff_id = ? AND revision_no = ?`,
      row.handoff_id,
      row.current_revision
    );
    certainty = rev?.certainty ?? null;
  }
  const latestDelivery = conn.get<{
    readonly outcome: string;
    readonly outcome_reason: string | null;
  }>(
    `SELECT outcome, outcome_reason FROM recovery_handoff_deliveries
     WHERE handoff_id = ?
     ORDER BY recorded_at_ms DESC LIMIT 1`,
    row.handoff_id
  );
  let posture: VisibilityRecoveryPosture = 'verified';
  let reasonCode: string | null = null;
  if (
    row.state === 'uncertain' ||
    certainty === 'uncertain' ||
    certainty === 'unknown' ||
    latestDelivery?.outcome === 'uncertain'
  ) {
    posture = 'uncertain';
    reasonCode = latestDelivery?.outcome_reason ?? certainty ?? row.state;
  } else if (row.state === 'unsupported' || latestDelivery?.outcome === 'refused') {
    posture = 'degraded';
    reasonCode = latestDelivery?.outcome_reason ?? row.state;
  }
  return { posture, reasonCode: scrubOpt(reasonCode) };
}

function readAcpVisibility(
  store: SqliteApplicationStore,
  attempts: readonly AttemptVisibilityRow[],
  selectedAttemptId: string | undefined,
  runRow: SqlRunRow | undefined
): ExecutionAcpVisibility {
  const conn = store.writerConnection;
  const targetAttempt =
    (selectedAttemptId !== undefined
      ? attempts.find((a) => a.attemptId === selectedAttemptId)
      : undefined) ?? attempts.at(-1);
  const attemptId = targetAttempt?.attemptId ?? null;
  const profileId = targetAttempt?.profileId ?? scrubOpt(runRow?.profile_id);
  const backendKind = targetAttempt?.backendKind ?? scrubOpt(runRow?.backend_kind);
  const modelId = targetAttempt?.modelId ?? scrubOpt(runRow?.model_id);

  if (attemptId === null && profileId === null) {
    return {
      runtimeState: 'not-recorded',
      profileId: null,
      backendKind,
      modelId,
      liveObservations: 0,
      pendingPermissions: 0
    };
  }

  const obsRows =
    attemptId === null
      ? []
      : conn.all<{ readonly kind: string }>(
          `SELECT kind FROM acp_observation_ledger
           WHERE attempt_id = ? AND origin = 'live'
           ORDER BY observed_at_ms DESC LIMIT 64`,
          attemptId
        );
  const authRows =
    attemptId === null
      ? []
      : conn.all<{ readonly decision: string }>(
          `SELECT decision FROM acp_authorization_receipts
           WHERE attempt_id = ? AND request_kind = 'permission'
           ORDER BY recorded_at_ms DESC LIMIT 32`,
          attemptId
        );

  const liveObservations = obsRows.length;
  const latestKind = obsRows.at(0)?.kind ?? null;
  let pendingPermissions = 0;
  for (const obs of obsRows) {
    if (obs.kind === 'permission-requested') pendingPermissions += 1;
  }
  const decidedPermissions = authRows.length;
  const unresolvedPermissions = Math.max(0, pendingPermissions - decidedPermissions);

  let runtimeState: NormalizedAcpActivityState = 'not-recorded';
  if (unresolvedPermissions > 0) {
    runtimeState = 'awaiting-permission';
  } else if (latestKind !== null) {
    if (latestKind.includes('cancel') || targetAttempt?.status === 'cancelled') {
      runtimeState = 'canceled';
    } else if (latestKind.includes('uncertain') || latestKind.includes('timeout')) {
      runtimeState = 'uncertain';
    } else if (
      latestKind.includes('disconnect') ||
      latestKind.includes('closed') ||
      targetAttempt?.completedAtMs !== null
    ) {
      runtimeState = 'disconnected';
    } else {
      runtimeState = 'connected';
    }
  } else if (profileId !== null) {
    runtimeState = targetAttempt?.completedAtMs === null ? 'connected' : 'disconnected';
  }

  return {
    runtimeState,
    profileId,
    backendKind,
    modelId,
    liveObservations,
    pendingPermissions: unresolvedPermissions
  };
}

function readLaneVisibility(
  store: SqliteApplicationStore,
  scopeId: string,
  rootExecutionId: string
): ExecutionLaneCandidateVisibility {
  const conn = store.writerConnection;
  const lane = conn.get<{
    readonly lane_id: string;
    readonly state: string;
  }>(
    `SELECT lane_id, state FROM execution_lanes
     WHERE workspace_id = ? AND root_execution_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    scopeId,
    rootExecutionId
  );
  if (lane === undefined) {
    return {
      mode: 'shared-workspace',
      laneId: null,
      laneState: null,
      candidateId: null,
      integrationRequestId: null,
      integrationState: null,
      targetRef: null,
      comparisonRevision: null
    };
  }
  const candidate = conn.get<{ readonly candidate_id: string }>(
    `SELECT candidate_id FROM lane_candidates
     WHERE lane_id = ?
     ORDER BY candidate_seq DESC LIMIT 1`,
    lane.lane_id
  );
  const req = conn.get<{
    readonly request_id: string;
    readonly candidate_id: string;
    readonly candidate_commit: string;
    readonly target_ref: string;
    readonly expected_target_commit: string;
    readonly profile_revision: number;
    readonly profile_digest: string;
    readonly state: string;
  }>(
    `SELECT request_id, candidate_id, candidate_commit, target_ref, expected_target_commit,
       profile_revision, profile_digest, state
     FROM lane_integration_requests
     WHERE lane_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    lane.lane_id
  );
  const computedRevision =
    req === undefined
      ? null
      : comparisonRevision({
          candidateCommit: req.candidate_commit,
          targetRef: req.target_ref,
          targetCommit: req.expected_target_commit,
          profileRevision: req.profile_revision,
          profileDigest: req.profile_digest
        });
  return {
    mode: 'isolated-lane',
    laneId: lane.lane_id,
    laneState: lane.state,
    candidateId: req?.candidate_id ?? candidate?.candidate_id ?? null,
    integrationRequestId: req?.request_id ?? null,
    integrationState: req?.state ?? null,
    targetRef: req?.target_ref ?? null,
    comparisonRevision: computedRevision
  };
}

export function createExecutionVisibilityApi(
  deps: ExecutionVisibilityApiDeps
): ExecutionVisibilityApi {
  return {
    readAttemptVisibility(request): ExecutionAttemptVisibility {
      const store = deps.getSqliteStore();
      if (store === null) {
        return emptyAttemptVisibility(request.rootExecutionId);
      }
      try {
        const conn = store.writerConnection;
        const runRow = conn.get<SqlRunRow>(
          `SELECT run_id, workflow_id, frozen_closure_id, status, invocation_count,
             backend_kind, model_id, profile_id, lane_id
           FROM runs
           WHERE workspace_id = ? AND run_id = ?`,
          deps.scopeId,
          request.rootExecutionId
        );
        const attemptRows = conn.all<SqlAttemptRow>(
          `SELECT a.attempt_id, s.step_index, s.phase_id, a.attempt_number, a.status,
             a.exit_code, a.started_at_ms, a.completed_at_ms,
             COALESCE(a.backend_kind, r.backend_kind) AS backend_kind,
             COALESCE(a.model_id, r.model_id) AS model_id,
             COALESCE(a.profile_id, r.profile_id) AS profile_id,
             COALESCE(a.lane_id, r.lane_id) AS lane_id,
             a.failure_cause
           FROM attempts a
           JOIN steps s ON s.step_id = a.step_id
           JOIN runs r ON r.run_id = a.run_id
           WHERE r.workspace_id = ? AND a.run_id = ?
           ORDER BY s.step_index ASC, a.attempt_number ASC, a.attempt_id ASC
           LIMIT ?`,
          deps.scopeId,
          request.rootExecutionId,
          MAX_ATTEMPTS_PER_ROOT
        );

        const attempts: AttemptVisibilityRow[] = attemptRows.map((row) => ({
          attemptId: scrub(row.attempt_id),
          stepIndex: row.step_index,
          phaseId: scrubOpt(row.phase_id),
          attemptNumber: row.attempt_number,
          status: scrub(row.status),
          exitCode: row.exit_code,
          startedAtMs: row.started_at_ms,
          completedAtMs: row.completed_at_ms,
          backendKind: scrubOpt(row.backend_kind),
          modelId: scrubOpt(row.model_id),
          profileId: scrubOpt(row.profile_id),
          laneId: scrubOpt(row.lane_id),
          failureCause:
            row.failure_cause !== null && isFailureCause(row.failure_cause)
              ? row.failure_cause
              : row.failure_cause !== null
                ? 'other'
                : null
        }));

        const evidenceRows = conn.all<SqlEvidenceRow>(
          `SELECT artifact_id, owner_run_id, owner_attempt_id, store_kind, availability,
             byte_size, retention_class
           FROM artifact_lifecycle
           WHERE owner_run_id = ?
           ORDER BY artifact_id ASC LIMIT ?`,
          request.rootExecutionId,
          MAX_EVIDENCE_REFS_PER_ROOT
        );
        const evidence: ReportEvidenceReference[] = evidenceRows.map((row) => ({
          artifactId: scrub(row.artifact_id),
          rootId: scrub(row.owner_run_id),
          attemptId: scrubOpt(row.owner_attempt_id),
          storeKind: scrub(row.store_kind),
          availability: scrub(row.availability),
          byteSize: row.byte_size,
          retentionClass: scrub(row.retention_class)
        }));

        const liveLog = readLiveLogVisibility(store, request.rootExecutionId);
        const recovery = readRecoveryVisibility(store, deps.scopeId, request.rootExecutionId);
        const acp = readAcpVisibility(store, attempts, request.attemptId, runRow);
        const lane = readLaneVisibility(store, deps.scopeId, request.rootExecutionId);
        const handoffs = deps.getPhaseContextApi().listRunHandoffs(request.rootExecutionId);

        const reviewRows = conn.all<SqlReviewRow>(
          `SELECT loop_id, run_id, node_id, iteration, verdict, ledger_json
           FROM phase_review_loop_ledgers
           WHERE run_id = ?
           ORDER BY updated_at_ms DESC LIMIT ?`,
          request.rootExecutionId,
          MAX_REVIEW_LOOPS_PER_ROOT
        );
        const reviewLoops: RootReviewLoopSummary[] = reviewRows.map((row) => ({
          loopId: scrub(row.loop_id),
          rootId: scrub(row.run_id),
          nodeId: scrub(row.node_id),
          iteration: row.iteration,
          verdict: scrub(row.verdict),
          ...parseReviewLoopCounts(row.ledger_json)
        }));

        let dataQuality: VisibilityDataQuality = 'unknown';
        if (runRow !== undefined) {
          const hasDegradedEvidence = evidence.some(
            (item) => item.availability !== 'present' && item.availability !== 'pending'
          );
          dataQuality =
            hasDegradedEvidence || liveLog.gapCount > 0 ? 'partial' : 'authoritative';
        }

        const distinctSteps = new Set(attempts.map((a) => a.stepIndex)).size;
        const invocationCount =
          runRow !== undefined && runRow.invocation_count > 0
            ? runRow.invocation_count
            : distinctSteps;

        return {
          available: true,
          unavailableReason: null,
          rootExecutionId: scrub(request.rootExecutionId),
          hierarchy: {
            rootStatus: scrubOpt(runRow?.status),
            workflowId: scrubOpt(runRow?.workflow_id),
            frozenDefinitionId: scrubOpt(runRow?.frozen_closure_id),
            invocationCount,
            attemptCount: attempts.length,
            dataQuality,
            attempts
          },
          evidence,
          liveLog: {
            streamState:
              (liveLog.streamState as string) === 'not-recorded' ? 'unknown' : liveLog.streamState,
            segmentCount: liveLog.segmentCount,
            gapCount: liveLog.gapCount
          },
          recovery,
          acp,
          lane,
          handoffs,
          reviewLoops
        };
      } catch {
        return emptyAttemptVisibility(request.rootExecutionId);
      }
    },

    readRuntimePosture(): RuntimePostureVisibility {
      const store = deps.getSqliteStore();
      const telemetryHost = deps.getTelemetryHost();
      const lanesEnabled = deps.isLanesEnabled();

      let activeLanes = 0;
      let totalLanes = 0;
      let pendingIntegrations = 0;
      let pendingCopyCount = 0;
      let exportedCopyCount = 0;
      let droppedCopyCount = 0;
      let activeSeriesCount = 0;

      if (store !== null) {
        try {
          const conn = store.writerConnection;
          activeLanes =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM execution_lanes
               WHERE workspace_id = ? AND state IN ('preparing', 'active', 'paused')`,
              deps.scopeId
            )?.c ?? 0;
          totalLanes =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM execution_lanes WHERE workspace_id = ?`,
              deps.scopeId
            )?.c ?? 0;
          pendingIntegrations =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM lane_integration_requests
               WHERE workspace_id = ? AND state IN ('queued', 'verifying', 'awaiting-review', 'landing')`,
              deps.scopeId
            )?.c ?? 0;
          pendingCopyCount =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM telemetry_export_ledger WHERE state = 'pending'`
            )?.c ?? 0;
          exportedCopyCount =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM telemetry_export_ledger WHERE state = 'exported'`
            )?.c ?? 0;
          droppedCopyCount =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM telemetry_export_ledger WHERE state = 'dropped'`
            )?.c ?? 0;
          activeSeriesCount =
            conn.get<{ readonly c: number }>(
              `SELECT COUNT(*) AS c FROM telemetry_cardinality_sets`
            )?.c ?? 0;
        } catch {
          // Keep zeroed defaults when store is unavailable or closed.
        }
      }

      const status = telemetryHost?.getStatus() ?? null;
      const evalKind = status?.evaluation.kind ?? 'disabled';
      const evalReason =
        status !== null && status.evaluation.kind === 'refused'
          ? status.evaluation.reason
          : status?.health.lastError ?? null;
      const overflowCount = status?.health.coverage.overflow ?? 0;

      return {
        available: store !== null,
        lanes: {
          enabled: lanesEnabled,
          liveLaneCap: DEFAULT_LIVE_LANE_CAP,
          activeLanes,
          totalLanes,
          pendingIntegrations
        },
        telemetry: {
          enabled: evalKind === 'authorized',
          stateKind: status?.health.state ?? evalKind,
          reasonCode: evalReason,
          protocol: evalKind === 'authorized' ? 'otlp-http-json' : null,
          contentPolicyMode: status?.preview.requestedContentPolicy ?? 'metadata-only',
          pendingCopyCount,
          exportedCopyCount,
          droppedCopyCount,
          spooledBatchCount: status?.spooledBatches ?? 0,
          spooledBytes: status?.spooledBytes ?? 0,
          spoolCeilingBytes: TELEMETRY_EXPORT_BOUNDS.diskSpoolBytes,
          activeSeriesCount,
          seriesCap: TELEMETRY_EXPORT_BOUNDS.attributeSetsMax,
          overflowCount,
          previewSummary:
            status?.preview.redactionLimitsDisclosure ??
            'Metrics only (metadata-only allowlist). Content export is unsupported and refused.'
        }
      };
    }
  };
}
