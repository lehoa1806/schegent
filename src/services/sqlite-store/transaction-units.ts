/**
 * FR-R6-F04 (F04-A, FR-003, SC-002..SC-004) — The seven atomic transaction
 * units executed inside `BEGIN IMMEDIATE` with expected-revision CAS,
 * window-primacy/lock lease fencing, durable `operation_receipts` idempotency,
 * and `state_change_outbox` publication. Zero `vscode` imports (hard-rules rule 13).
 */

import { createHash } from 'node:crypto';
import type {
  AdmissionCommitRequest,
  AtomicTransactionUnitName,
  CatalogPublicationCommitRequest,
  HandoffAcceptanceCommitRequest,
  IdempotencyEnvelope,
  LeaseFenceRow,
  LeaseFenceToken,
  OperationReceiptRow,
  RetentionCommitRequest,
  ReviewAcceptanceCommitRequest,
  TerminalAcceptanceCommitRequest,
  TransactionUnitOutcome,
  UsageCorrectionCommitRequest,
  WriterPriorityLane
} from '../../contracts/sqlite-store/schema-types';
import { SanitizedLogger } from '../../lib/logger';
import type { NodeSqliteConnection } from './sqlite-driver';
import type { WriterCoordinator } from './writer-coordinator';

const DIAGNOSTIC_SANITIZER = new SanitizedLogger();

function sanitizeSqlDiagnostic(message: string): string {
  return DIAGNOSTIC_SANITIZER.sanitize(message).slice(0, 240);
}

export class AtomicTransactionUnitsService {
  private readonly conn: NodeSqliteConnection;
  private readonly writer: WriterCoordinator;
  private readonly nowMs: () => number;

  public constructor(
    conn: NodeSqliteConnection,
    writer: WriterCoordinator,
    nowMs: () => number = () => Date.now()
  ) {
    this.conn = conn;
    this.writer = writer;
    this.nowMs = nowMs;
  }

  public acquireOrRenewLeaseFence(params: {
    readonly fenceScope: string;
    readonly resourceId: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly ttlMs: number;
  }): LeaseFenceRow {
    const now = this.nowMs();
    const expiresAtMs = now + Math.max(1, params.ttlMs);
    this.conn.run(
      `INSERT INTO lease_fences (fence_scope, resource_id, owner_id, epoch, acquired_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fence_scope, resource_id) DO UPDATE SET
         owner_id = excluded.owner_id, epoch = excluded.epoch,
         acquired_at_ms = excluded.acquired_at_ms, expires_at_ms = excluded.expires_at_ms
       WHERE excluded.epoch >= lease_fences.epoch`,
      params.fenceScope, params.resourceId, params.ownerId, params.epoch, now, expiresAtMs
    );
    const row = this.conn.get<{
      fence_scope: string; resource_id: string; owner_id: string;
      epoch: number; acquired_at_ms: number; expires_at_ms: number;
    }>(
      `SELECT fence_scope, resource_id, owner_id, epoch, acquired_at_ms, expires_at_ms
       FROM lease_fences WHERE fence_scope = ? AND resource_id = ?`,
      params.fenceScope, params.resourceId
    );
    if (!row || row.owner_id !== params.ownerId || row.epoch !== params.epoch) {
      throw new Error(`FENCE_EPOCH_REGRESSION: cannot acquire fence with lower epoch ${params.epoch}`);
    }
    return {
      fenceScope: row.fence_scope, resourceId: row.resource_id, ownerId: row.owner_id,
      epoch: row.epoch, acquiredAtMs: row.acquired_at_ms, expiresAtMs: row.expires_at_ms
    };
  }

  private checkIdempotencyReceipt<T>(
    commitUnit: AtomicTransactionUnitName,
    envelope: IdempotencyEnvelope
  ): TransactionUnitOutcome<T> | null {
    const existing = this.conn.get<{
      commit_unit: AtomicTransactionUnitName; request_sha256: string;
      resulting_revision: number; response_json: string;
    }>(
      `SELECT commit_unit, request_sha256, resulting_revision, response_json
       FROM operation_receipts WHERE scope_kind = ? AND scope_id = ? AND idempotency_key = ?`,
      envelope.scopeKind, envelope.scopeId, envelope.idempotencyKey
    );
    if (!existing) return null;
    if (existing.request_sha256 !== envelope.requestSha256) {
      return {
        status: 'rejected', commitUnit, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: `Idempotency key '${envelope.idempotencyKey}' replayed with mismatched payload digest`
      };
    }
    return {
      status: 'committed', commitUnit, revision: existing.resulting_revision,
      replayed: true, value: JSON.parse(existing.response_json) as T
    };
  }

  private verifyFence(
    commitUnit: AtomicTransactionUnitName,
    fence: LeaseFenceToken,
    now: number
  ): TransactionUnitOutcome<never> | null {
    const row = this.conn.get<{ owner_id: string; epoch: number; expires_at_ms: number }>(
      `SELECT owner_id, epoch, expires_at_ms FROM lease_fences WHERE fence_scope = ? AND resource_id = ?`,
      fence.fenceScope, fence.resourceId
    );
    if (!row || row.owner_id !== fence.ownerId || row.epoch !== fence.epoch) {
      return {
        status: 'rejected', commitUnit, code: 'FENCE_MISMATCH',
        message: `Lease fence mismatch for ${fence.fenceScope}:${fence.resourceId}`
      };
    }
    if (row.expires_at_ms < now) {
      return {
        status: 'rejected', commitUnit, code: 'FENCE_EXPIRED',
        message: `Lease fence expired at ${row.expires_at_ms} (now=${now})`
      };
    }
    return null;
  }

  private recordOutboxAndReceipt<T>(
    commitUnit: AtomicTransactionUnitName,
    envelope: IdempotencyEnvelope,
    revision: number,
    value: T,
    now: number
  ): number {
    const responseJson = JSON.stringify(value);
    const outboxRes = this.conn.run(
      `INSERT INTO state_change_outbox (commit_unit, scope_kind, scope_id, revision, payload_json, created_at_ms, delivered_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      commitUnit, envelope.scopeKind, envelope.scopeId, revision, responseJson, now
    );
    this.conn.run(
      `INSERT INTO operation_receipts (scope_kind, scope_id, idempotency_key, commit_unit, request_sha256, resulting_revision, response_json, committed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      envelope.scopeKind, envelope.scopeId, envelope.idempotencyKey,
      commitUnit, envelope.requestSha256, revision, responseJson, now
    );
    return Number(outboxRes.lastInsertRowid);
  }

  private runAtomicUnit<T>(
    commitUnit: AtomicTransactionUnitName,
    lane: WriterPriorityLane,
    payloadBytes: number,
    envelope: IdempotencyEnvelope,
    fence: LeaseFenceToken | null,
    body: (now: number) =>
      | { readonly ok: true; readonly revision: number; readonly value: T }
      | TransactionUnitOutcome<T>
  ): TransactionUnitOutcome<T> {
    const writeOutcome = this.writer.executeSerializedWrite(lane, payloadBytes, 4, (conn) => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const replayedOrMismatch = this.checkIdempotencyReceipt<T>(commitUnit, envelope);
        if (replayedOrMismatch !== null) {
          conn.exec('ROLLBACK');
          return replayedOrMismatch;
        }
        const now = this.nowMs();
        if (fence !== null) {
          const fenceRejection = this.verifyFence(commitUnit, fence, now);
          if (fenceRejection !== null) {
            conn.exec('ROLLBACK');
            return fenceRejection;
          }
        }
        const outcome = body(now);
        if ('status' in outcome) {
          conn.exec('ROLLBACK');
          return outcome;
        }
        const outboxSeq = this.recordOutboxAndReceipt(
          commitUnit, envelope, outcome.revision, outcome.value, now
        );
        conn.exec('COMMIT');
        return {
          status: 'committed' as const, commitUnit, revision: outcome.revision,
          replayed: false, outboxSeq, value: outcome.value
        };
      } catch (error) {
        try {
          conn.exec('ROLLBACK');
        } catch {
          // Ignore rollback error
        }
        const rawMessage = error instanceof Error ? error.message : String(error);
        const code = rawMessage.startsWith('FAILPOINT_INJECTED:')
          ? ('FAILPOINT_INJECTED' as const)
          : /FOREIGN KEY constraint failed/i.test(rawMessage)
            ? ('FOREIGN_KEY_VIOLATION' as const)
            : /SQLITE_BUSY|SQLITE_FULL|database is locked/i.test(rawMessage)
              ? ('STORAGE_BUSY_OR_FULL' as const)
              : ('CONSTRAINT_VIOLATION' as const);
        return {
          status: 'rejected' as const, commitUnit, code,
          message: sanitizeSqlDiagnostic(rawMessage)
        };
      }
    });

    if (!writeOutcome.admitted) {
      return {
        status: 'rejected', commitUnit, code: writeOutcome.code, message: writeOutcome.message
      };
    }
    return writeOutcome.result;
  }

  /** 1. `Admission`: Atomically admits/updates run, inputs, queue claim, step/attempt, summary, and aggregate. */
  public executeAdmission(
    request: AdmissionCommitRequest
  ): TransactionUnitOutcome<{ readonly runId: string; readonly queueEntryId: string; readonly revision: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Admission', 'standard', payloadBytes, request.idempotency, request.fence,
      (now) => {
        const existingRun = this.conn.get<{ revision: number }>(
          `SELECT revision FROM runs WHERE run_id = ?`, request.run.runId
        );
        const currentRevision = existingRun?.revision ?? 0;
        if (currentRevision !== request.expectedRevision) {
          return {
            status: 'rejected', commitUnit: 'Admission', code: 'STALE_REVISION',
            message: `Expected run revision ${request.expectedRevision}, found ${currentRevision}`,
            currentRevision
          };
        }

        const nextRevision = currentRevision + 1;
        const runStatus = request.run.status ?? 'running';
        const startedAtMs = runStatus === 'running' ? now : null;
        const initialStepId = request.run.initialStep?.stepId ?? null;

        if (currentRevision === 0) {
          this.conn.run(
            `INSERT INTO runs (run_id, workspace_id, workflow_id, frozen_closure_id, status, revision, current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
            request.run.runId, request.run.workspaceId, request.run.workflowId,
            request.run.frozenClosureId ?? null, runStatus, nextRevision,
            initialStepId, startedAtMs, now, now
          );
        } else {
          this.conn.run(
            `UPDATE runs SET status = ?, revision = ?, current_step_id = ?, started_at_ms = COALESCE(started_at_ms, ?), updated_at_ms = ? WHERE run_id = ?`,
            runStatus, nextRevision, initialStepId, startedAtMs, now, request.run.runId
          );
        }
        if (request.failpointStep === 'after_run_insert') throw new Error('FAILPOINT_INJECTED:after_run_insert');

        if (request.run.inputs) {
          for (const [key, val] of Object.entries(request.run.inputs)) {
            const valJson = JSON.stringify(val);
            const digest = createHash('sha256').update(valJson).digest('hex');
            this.conn.run(
              `INSERT INTO run_inputs (run_id, input_key, value_json, redacted_digest_sha256) VALUES (?, ?, ?, ?)
               ON CONFLICT(run_id, input_key) DO UPDATE SET value_json = excluded.value_json, redacted_digest_sha256 = excluded.redacted_digest_sha256`,
              request.run.runId, key, valJson, digest
            );
          }
        }

        const queueEntryId = `q-${request.run.runId}`;
        const queueState = runStatus === 'running' ? 'claimed' : 'queued';
        this.conn.run(
          `INSERT INTO queue_entries (queue_entry_id, run_id, priority, state, claimed_by, claim_epoch, enqueued_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET priority = excluded.priority, state = excluded.state, claimed_by = excluded.claimed_by, claim_epoch = excluded.claim_epoch, updated_at_ms = excluded.updated_at_ms`,
          queueEntryId, request.run.runId, request.run.priority, queueState,
          request.run.claimedBy ?? request.fence.ownerId,
          request.run.claimEpoch ?? request.fence.epoch, now, now
        );
        if (request.failpointStep === 'after_queue_insert') throw new Error('FAILPOINT_INJECTED:after_queue_insert');

        let stepCount = 0;
        let attemptCount = 0;
        if (request.run.initialStep) {
          const step = request.run.initialStep;
          stepCount = 1;
          this.conn.run(
            `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(step_id) DO UPDATE SET status = excluded.status, revision = steps.revision + 1, current_attempt_id = excluded.current_attempt_id, updated_at_ms = excluded.updated_at_ms`,
            step.stepId, request.run.runId, step.stepIndex, step.phaseId,
            step.status ?? 'running', step.attemptId ?? null, now
          );
          if (step.attemptId) {
            attemptCount = 1;
            this.conn.run(
              `INSERT INTO attempts (attempt_id, run_id, step_id, attempt_number, status, exit_code, started_at_ms, completed_at_ms) VALUES (?, ?, ?, 1, 'running', NULL, ?, NULL)`,
              step.attemptId, request.run.runId, step.stepId, now
            );
          }
        }

        this.conn.run(
          `INSERT INTO execution_summary_revisions (run_id, workspace_id, workflow_id, status, revision, step_count, completed_step_count, attempt_count, open_finding_count, total_tokens, total_cost_microdollars, duration_ms, started_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, revision = excluded.revision, step_count = MAX(execution_summary_revisions.step_count, excluded.step_count), attempt_count = MAX(execution_summary_revisions.attempt_count, excluded.attempt_count), started_at_ms = COALESCE(execution_summary_revisions.started_at_ms, excluded.started_at_ms), updated_at_ms = excluded.updated_at_ms`,
          request.run.runId, request.run.workspaceId, request.run.workflowId,
          runStatus, nextRevision, stepCount, attemptCount, startedAtMs, now
        );

        this.conn.run(
          `INSERT INTO aggregate_revisions (scope_key, revision, run_count, succeeded_count, failed_count, total_tokens, total_cost_microdollars, updated_at_ms)
           VALUES (?, 1, ?, 0, 0, 0, 0, ?)
           ON CONFLICT(scope_key) DO UPDATE SET revision = aggregate_revisions.revision + 1, run_count = aggregate_revisions.run_count + ?, updated_at_ms = excluded.updated_at_ms`,
          request.run.workspaceId, currentRevision === 0 ? 1 : 0, now, currentRevision === 0 ? 1 : 0
        );
        if (request.failpointStep === 'before_receipt') throw new Error('FAILPOINT_INJECTED:before_receipt');

        return {
          ok: true, revision: nextRevision,
          value: { runId: request.run.runId, queueEntryId, revision: nextRevision }
        };
      }
    );
  }

  /** 2. `Terminal acceptance`: Admitted on reserved `settlement` lane. */
  public executeTerminalAcceptance(
    request: TerminalAcceptanceCommitRequest
  ): TransactionUnitOutcome<{ readonly runId: string; readonly terminalStatus: string; readonly revision: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Terminal acceptance', 'settlement', payloadBytes, request.idempotency, request.fence,
      (now) => {
        const existingRun = this.conn.get<{
          workspace_id: string; revision: number; started_at_ms: number | null;
        }>(
          `SELECT workspace_id, revision, started_at_ms FROM runs WHERE run_id = ?`,
          request.settlement.runId
        );
        if (!existingRun || existingRun.revision !== request.expectedRevision) {
          return {
            status: 'rejected', commitUnit: 'Terminal acceptance', code: 'STALE_REVISION',
            message: `Expected run revision ${request.expectedRevision}, found ${existingRun?.revision ?? 0}`,
            currentRevision: existingRun?.revision ?? 0
          };
        }

        const nextRevision = existingRun.revision + 1;
        const completedAtMs = request.settlement.completedAtMs ?? now;
        this.conn.run(
          `UPDATE runs SET status = ?, revision = ?, completed_at_ms = ?, terminal_reason = ?, updated_at_ms = ? WHERE run_id = ?`,
          request.settlement.terminalStatus, nextRevision, completedAtMs,
          request.settlement.terminalReason, now, request.settlement.runId
        );
        if (request.failpointStep === 'after_run_update') throw new Error('FAILPOINT_INJECTED:after_run_update');

        const queueTerminalState = request.settlement.terminalStatus === 'cancelled' ? 'cancelled' : 'completed';
        this.conn.run(
          `UPDATE queue_entries SET state = ?, updated_at_ms = ? WHERE run_id = ?`,
          queueTerminalState, now, request.settlement.runId
        );
        if (request.failpointStep === 'after_queue_release') throw new Error('FAILPOINT_INJECTED:after_queue_release');

        if (request.settlement.stepSettlement) {
          const stepSettle = request.settlement.stepSettlement;
          this.conn.run(
            `UPDATE steps SET status = ?, revision = revision + 1, updated_at_ms = ? WHERE step_id = ? AND run_id = ?`,
            stepSettle.status, now, stepSettle.stepId, request.settlement.runId
          );
          if (stepSettle.attemptId) {
            this.conn.run(
              `UPDATE attempts SET status = ?, exit_code = ?, completed_at_ms = ? WHERE attempt_id = ? AND run_id = ?`,
              stepSettle.attemptStatus ?? (stepSettle.status === 'succeeded' ? 'succeeded' : 'failed'),
              stepSettle.exitCode ?? (stepSettle.status === 'succeeded' ? 0 : 1),
              completedAtMs, stepSettle.attemptId, request.settlement.runId
            );
          }
        }

        const durationMs = existingRun.started_at_ms !== null ? Math.max(0, completedAtMs - existingRun.started_at_ms) : 0;
        const completedSteps = Number(
          this.conn.scalar(`SELECT COUNT(*) FROM steps WHERE run_id = ? AND status = 'succeeded'`, request.settlement.runId) ?? 0
        );
        this.conn.run(
          `UPDATE execution_summary_revisions SET status = ?, revision = ?, completed_step_count = ?, duration_ms = ?, updated_at_ms = ? WHERE run_id = ?`,
          request.settlement.terminalStatus, nextRevision, completedSteps, durationMs, now, request.settlement.runId
        );

        const incSucceeded = request.settlement.terminalStatus === 'succeeded' ? 1 : 0;
        const incFailed = request.settlement.terminalStatus === 'failed' || request.settlement.terminalStatus === 'aborted' ? 1 : 0;
        this.conn.run(
          `UPDATE aggregate_revisions SET revision = revision + 1, succeeded_count = succeeded_count + ?, failed_count = failed_count + ?, updated_at_ms = ? WHERE scope_key = ?`,
          incSucceeded, incFailed, now, existingRun.workspace_id
        );
        if (request.failpointStep === 'before_receipt') throw new Error('FAILPOINT_INJECTED:before_receipt');

        return {
          ok: true, revision: nextRevision,
          value: { runId: request.settlement.runId, terminalStatus: request.settlement.terminalStatus, revision: nextRevision }
        };
      }
    );
  }

  /** 3. `Handoff acceptance`: Atomically records accepted result, handoff, envelope, bindings, and pins. */
  public executeHandoffAcceptance(
    request: HandoffAcceptanceCommitRequest
  ): TransactionUnitOutcome<{ readonly handoffId: string; readonly resultId: string; readonly revision: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Handoff acceptance', 'standard', payloadBytes, request.idempotency, request.fence,
      (now) => {
        const existingRun = this.conn.get<{ revision: number }>(
          `SELECT revision FROM runs WHERE run_id = ?`, request.handoff.runId
        );
        if (!existingRun || existingRun.revision !== request.expectedRevision) {
          return {
            status: 'rejected', commitUnit: 'Handoff acceptance', code: 'STALE_REVISION',
            message: `Expected run revision ${request.expectedRevision}, found ${existingRun?.revision ?? 0}`,
            currentRevision: existingRun?.revision ?? 0
          };
        }

        const nextRevision = existingRun.revision + 1;
        this.conn.run(`UPDATE runs SET revision = ?, updated_at_ms = ? WHERE run_id = ?`, nextRevision, now, request.handoff.runId);
        this.conn.run(
          `INSERT INTO accepted_results (result_id, run_id, step_id, attempt_id, schema_id, revision, status, accepted_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)`,
          request.handoff.resultId, request.handoff.runId, request.handoff.stepId,
          request.handoff.attemptId, request.handoff.schemaId, nextRevision, now
        );
        for (const val of request.handoff.values) {
          this.conn.run(
            `INSERT INTO result_values (result_id, field_path, value_type, value_text, artifact_id) VALUES (?, ?, ?, ?, ?)`,
            request.handoff.resultId, val.fieldPath, val.valueType, val.valueText, val.artifactId ?? null
          );
        }
        if (request.failpointStep === 'after_result_insert') throw new Error('FAILPOINT_INJECTED:after_result_insert');

        this.conn.run(
          `INSERT INTO handoffs (handoff_id, run_id, from_step_id, to_step_id, revision, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`,
          request.handoff.handoffId, request.handoff.runId, request.handoff.stepId,
          request.handoff.toStepId, nextRevision, now, now
        );
        this.conn.run(
          `INSERT INTO handoff_sources (handoff_id, source_result_id, source_artifact_id, role) VALUES (?, ?, NULL, 'primary_result')`,
          request.handoff.handoffId, request.handoff.resultId
        );
        this.conn.run(
          `INSERT INTO input_envelopes (envelope_id, handoff_id, target_run_id, target_step_id, schema_version, digest_sha256, created_at_ms) VALUES (?, ?, ?, ?, 1, ?, ?)`,
          request.handoff.envelopeId, request.handoff.handoffId, request.handoff.runId,
          request.handoff.toStepId, request.handoff.envelopeDigestSha256, now
        );
        for (const binding of request.handoff.bindings) {
          this.conn.run(
            `INSERT INTO input_bindings (envelope_id, param_name, bound_value_json, source_field_path) VALUES (?, ?, ?, ?)`,
            request.handoff.envelopeId, binding.paramName, binding.boundValueJson, binding.sourceFieldPath
          );
        }
        if (request.failpointStep === 'after_handoff_insert') throw new Error('FAILPOINT_INJECTED:after_handoff_insert');

        if (request.handoff.pinArtifactIds) {
          for (const artifactId of request.handoff.pinArtifactIds) {
            this.conn.run(
              `INSERT INTO artifact_pins (pin_id, artifact_id, owner_run_id, owner_attempt_id, owner_handoff_id, owner_export_id, reason, pinned_at_ms, expires_at_ms) VALUES (?, ?, NULL, NULL, ?, NULL, 'handoff_retention', ?, NULL)`,
              `pin-ho-${request.handoff.handoffId}-${artifactId}`, artifactId, request.handoff.handoffId, now
            );
          }
        }
        if (request.failpointStep === 'before_receipt') throw new Error('FAILPOINT_INJECTED:before_receipt');

        return {
          ok: true, revision: nextRevision,
          value: { handoffId: request.handoff.handoffId, resultId: request.handoff.resultId, revision: nextRevision }
        };
      }
    );
  }

  /** 4. `Review acceptance`: Atomically updates review loop, report, findings, dispositions, claims, and gate. */
  public executeReviewAcceptance(
    request: ReviewAcceptanceCommitRequest
  ): TransactionUnitOutcome<{ readonly reviewLoopId: string; readonly reportId: string; readonly openFindings: number; readonly revision: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Review acceptance', 'standard', payloadBytes, request.idempotency, request.fence,
      (now) => {
        const existingLoop = this.conn.get<{ revision: number }>(
          `SELECT revision FROM review_loops WHERE review_loop_id = ?`, request.review.reviewLoopId
        );
        const currentRevision = existingLoop?.revision ?? 0;
        if (currentRevision !== request.expectedRevision) {
          return {
            status: 'rejected', commitUnit: 'Review acceptance', code: 'STALE_REVISION',
            message: `Expected review loop revision ${request.expectedRevision}, found ${currentRevision}`,
            currentRevision
          };
        }

        const nextRevision = currentRevision + 1;
        this.conn.run(
          `INSERT INTO review_loops (review_loop_id, run_id, step_id, iteration, max_iterations, status, revision, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(review_loop_id) DO UPDATE SET iteration = excluded.iteration, status = excluded.status, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms`,
          request.review.reviewLoopId, request.review.runId, request.review.stepId,
          request.review.iteration, request.review.maxIterations, request.review.loopStatus, nextRevision, now
        );
        if (request.failpointStep === 'after_loop_upsert') throw new Error('FAILPOINT_INJECTED:after_loop_upsert');

        this.conn.run(
          `INSERT INTO review_reports (report_id, review_loop_id, iteration, reviewer_role, verdict, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
          request.review.reportId, request.review.reviewLoopId, request.review.iteration,
          request.review.reviewerRole, request.review.verdict, now
        );

        for (const f of request.review.findings) {
          this.conn.run(
            `INSERT INTO findings (finding_id, review_loop_id, report_id, severity, category, file_path, line_number, summary, status, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(finding_id) DO UPDATE SET status = excluded.status, updated_at_ms = excluded.updated_at_ms`,
            f.findingId, request.review.reviewLoopId, request.review.reportId,
            f.severity, f.category, f.filePath, f.lineNumber, f.summary, f.status, now, now
          );
          if (f.disposition) {
            this.conn.run(
              `INSERT INTO finding_dispositions (disposition_id, finding_id, disposition, actor_id, rationale, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
              f.disposition.dispositionId, f.findingId, f.disposition.disposition,
              f.disposition.actorId, f.disposition.rationale, now
            );
          }
          if (f.fixClaim) {
            this.conn.run(
              `INSERT INTO fix_claims (claim_id, finding_id, claimant_attempt_id, commit_sha, status, claimed_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
              f.fixClaim.claimId, f.findingId, f.fixClaim.claimantAttemptId,
              f.fixClaim.commitSha, f.fixClaim.status, now
            );
          }
        }
        if (request.failpointStep === 'after_findings_insert') throw new Error('FAILPOINT_INJECTED:after_findings_insert');

        if (request.review.gateUpdate) {
          const gate = request.review.gateUpdate;
          this.conn.run(
            `INSERT INTO gates (gate_id, run_id, step_id, gate_type, status, decided_by, decided_at_ms, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(gate_id) DO UPDATE SET status = excluded.status, decided_by = excluded.decided_by, decided_at_ms = excluded.decided_at_ms, notes = excluded.notes`,
            gate.gateId, request.review.runId, request.review.stepId,
            gate.gateType, gate.status, gate.decidedBy, now, gate.notes
          );
        }

        const openFindings = Number(
          this.conn.scalar(
            `SELECT COUNT(*) FROM findings f INNER JOIN review_loops rl ON rl.review_loop_id = f.review_loop_id WHERE rl.run_id = ? AND f.status IN ('open', 'claimed')`,
            request.review.runId
          ) ?? 0
        );
        this.conn.run(
          `UPDATE execution_summary_revisions SET open_finding_count = ?, revision = revision + 1, updated_at_ms = ? WHERE run_id = ?`,
          openFindings, now, request.review.runId
        );
        if (request.failpointStep === 'before_receipt') throw new Error('FAILPOINT_INJECTED:before_receipt');

        return {
          ok: true, revision: nextRevision,
          value: { reviewLoopId: request.review.reviewLoopId, reportId: request.review.reportId, openFindings, revision: nextRevision }
        };
      }
    );
  }

  /** 5. `Usage/correction`: Append-only usage observation or repricing correction with revision advancement. */
  public executeUsageCorrection(
    request: UsageCorrectionCommitRequest
  ): TransactionUnitOutcome<{ readonly attemptId: string; readonly totalTokens: number; readonly totalCostMicrodollars: number; readonly revision: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Usage/correction', 'standard', payloadBytes, request.idempotency, null,
      (now) => {
        const existingRev = this.conn.get<{
          revision: number; total_input_tokens: number; total_output_tokens: number;
          total_cached_tokens: number; total_cost_microdollars: number;
        }>(
          `SELECT revision, total_input_tokens, total_output_tokens, total_cached_tokens, total_cost_microdollars FROM attempt_usage_revisions WHERE attempt_id = ?`,
          request.usage.attemptId
        );
        const currentRevision = existingRev?.revision ?? 0;
        if (currentRevision !== request.expectedRevision) {
          return {
            status: 'rejected', commitUnit: 'Usage/correction', code: 'STALE_REVISION',
            message: `Expected attempt usage revision ${request.expectedRevision}, found ${currentRevision}`,
            currentRevision
          };
        }

        let deltaInput = 0;
        let deltaOutput = 0;
        let deltaCached = 0;
        let deltaCost = 0;

        if (request.usage.observation) {
          const obs = request.usage.observation;
          this.conn.run(
            `INSERT INTO usage_observations (observation_id, run_id, step_id, attempt_id, provider, model_id, input_tokens, output_tokens, cached_tokens, cost_microdollars, source_kind, observed_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            obs.observationId, request.usage.runId, request.usage.stepId,
            request.usage.attemptId, obs.provider, obs.modelId,
            obs.inputTokens, obs.outputTokens, obs.cachedTokens,
            obs.costMicrodollars, obs.sourceKind, now
          );
          deltaInput += obs.inputTokens;
          deltaOutput += obs.outputTokens;
          deltaCached += obs.cachedTokens;
          deltaCost += obs.costMicrodollars;
        }

        if (request.usage.correction) {
          const corr = request.usage.correction;
          this.conn.run(
            `INSERT INTO usage_corrections (correction_id, observation_id, reason, delta_input_tokens, delta_output_tokens, delta_cost_microdollars, pricing_version, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            corr.correctionId, corr.observationId, corr.reason,
            corr.deltaInputTokens, corr.deltaOutputTokens, corr.deltaCostMicrodollars,
            corr.pricingVersion, now
          );
          deltaInput += corr.deltaInputTokens;
          deltaOutput += corr.deltaOutputTokens;
          deltaCost += corr.deltaCostMicrodollars;
        }
        if (request.failpointStep === 'after_observation') throw new Error('FAILPOINT_INJECTED:after_observation');

        const nextRevision = currentRevision + 1;
        this.conn.run(
          `INSERT INTO usage_accounting_applications (application_id, run_id, attempt_id, observation_id, correction_id, applied_revision, applied_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          request.usage.applicationId, request.usage.runId, request.usage.attemptId,
          request.usage.observation?.observationId ?? null,
          request.usage.correction?.correctionId ?? null, nextRevision, now
        );
        if (request.failpointStep === 'after_application') throw new Error('FAILPOINT_INJECTED:after_application');

        const totalInput = (existingRev?.total_input_tokens ?? 0) + deltaInput;
        const totalOutput = (existingRev?.total_output_tokens ?? 0) + deltaOutput;
        const totalCached = (existingRev?.total_cached_tokens ?? 0) + deltaCached;
        const totalCost = (existingRev?.total_cost_microdollars ?? 0) + deltaCost;

        this.conn.run(
          `INSERT INTO attempt_usage_revisions (attempt_id, run_id, revision, total_input_tokens, total_output_tokens, total_cached_tokens, total_cost_microdollars, completeness, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(attempt_id) DO UPDATE SET revision = excluded.revision, total_input_tokens = excluded.total_input_tokens, total_output_tokens = excluded.total_output_tokens, total_cached_tokens = excluded.total_cached_tokens, total_cost_microdollars = excluded.total_cost_microdollars, completeness = excluded.completeness, updated_at_ms = excluded.updated_at_ms`,
          request.usage.attemptId, request.usage.runId, nextRevision,
          totalInput, totalOutput, totalCached, totalCost, request.usage.completeness, now
        );

        const deltaTokens = deltaInput + deltaOutput;
        this.conn.run(
          `UPDATE execution_summary_revisions SET total_tokens = total_tokens + ?, total_cost_microdollars = total_cost_microdollars + ?, revision = revision + 1, updated_at_ms = ? WHERE run_id = ?`,
          deltaTokens, deltaCost, now, request.usage.runId
        );

        const runRow = this.conn.get<{ workspace_id: string }>(`SELECT workspace_id FROM runs WHERE run_id = ?`, request.usage.runId);
        if (runRow) {
          this.conn.run(
            `UPDATE aggregate_revisions SET total_tokens = total_tokens + ?, total_cost_microdollars = total_cost_microdollars + ?, revision = revision + 1, updated_at_ms = ? WHERE scope_key = ?`,
            deltaTokens, deltaCost, now, runRow.workspace_id
          );
        }
        if (request.failpointStep === 'before_receipt') throw new Error('FAILPOINT_INJECTED:before_receipt');

        return {
          ok: true, revision: nextRevision,
          value: { attemptId: request.usage.attemptId, totalTokens: totalInput + totalOutput, totalCostMicrodollars: totalCost, revision: nextRevision }
        };
      }
    );
  }

  /** 6. `Catalog publication`: Atomically inserts immutable definition version, dependencies, head pointer, and catalog revision. */
  public executeCatalogPublication(
    request: CatalogPublicationCommitRequest
  ): TransactionUnitOutcome<{ readonly definitionId: string; readonly definitionVersionId: string; readonly catalogRevision: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Catalog publication', 'standard', payloadBytes, request.idempotency, null,
      (now) => {
        const revScope = request.publication.scope === 'global' ? 'global' : 'workspace';
        const existingRevRow = this.conn.get<{ revision: number }>(
          `SELECT revision FROM catalog_revisions WHERE scope = ?`, revScope
        );
        const currentRevision = existingRevRow?.revision ?? 0;
        if (currentRevision !== request.expectedRevision) {
          return {
            status: 'rejected', commitUnit: 'Catalog publication', code: 'STALE_REVISION',
            message: `Expected catalog revision ${request.expectedRevision} for scope '${revScope}', found ${currentRevision}`,
            currentRevision
          };
        }

        const pub = request.publication;
        this.conn.run(
          `INSERT INTO definitions (definition_id, scope, layer, slug, display_name, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(definition_id) DO UPDATE SET display_name = excluded.display_name`,
          pub.definitionId, pub.scope, pub.layer, pub.slug, pub.displayName, now
        );
        this.conn.run(
          `INSERT INTO definition_versions (definition_version_id, definition_id, version_number, status, canonical_yaml, digest_sha256, schema_version, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          pub.definitionVersionId, pub.definitionId, pub.versionNumber,
          pub.status, pub.canonicalYaml, pub.digestSha256, pub.schemaVersion, now
        );
        if (request.failpointStep === 'after_version_insert') throw new Error('FAILPOINT_INJECTED:after_version_insert');

        if (pub.dependencies) {
          for (const dep of pub.dependencies) {
            this.conn.run(
              `INSERT INTO definition_dependencies (from_version_id, to_definition_id, dep_layer, dep_order) VALUES (?, ?, ?, ?)`,
              pub.definitionVersionId, dep.toDefinitionId, dep.depLayer, dep.depOrder
            );
          }
        }

        const nextRevision = currentRevision + 1;
        const publishedVer = pub.promoteAsPublished ? pub.definitionVersionId : null;
        const draftVer = !pub.promoteAsPublished && pub.status === 'draft' ? pub.definitionVersionId : null;
        this.conn.run(
          `INSERT INTO catalog_heads (definition_id, published_version_id, draft_version_id, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(definition_id) DO UPDATE SET
             published_version_id = COALESCE(excluded.published_version_id, catalog_heads.published_version_id),
             draft_version_id = CASE WHEN ? = 1 THEN excluded.draft_version_id ELSE COALESCE(excluded.draft_version_id, catalog_heads.draft_version_id) END,
             revision = catalog_heads.revision + 1, updated_at_ms = excluded.updated_at_ms`,
          pub.definitionId, publishedVer, draftVer, 1, now, pub.promoteAsPublished ? 1 : 0
        );
        this.conn.run(`UPDATE catalog_revisions SET revision = ?, updated_at_ms = ? WHERE scope = ?`, nextRevision, now, revScope);
        this.conn.run(`UPDATE catalog_revisions SET revision = revision + 1, updated_at_ms = ? WHERE scope = 'combined'`, now);

        if (request.failpointStep === 'after_head_update' || request.failpointStep === 'before_receipt') {
          throw new Error(`FAILPOINT_INJECTED:${request.failpointStep}`);
        }
        return {
          ok: true, revision: nextRevision,
          value: { definitionId: pub.definitionId, definitionVersionId: pub.definitionVersionId, catalogRevision: nextRevision }
        };
      }
    );
  }

  /** 7. `Retention`: Sweeps expired report leases, delivered outbox rows, and unpinned artifacts of terminal runs. */
  public executeRetention(
    request: RetentionCommitRequest
  ): TransactionUnitOutcome<{ readonly expiredLeases: number; readonly evictedArtifacts: number; readonly purgedOutboxRows: number }> {
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    return this.runAtomicUnit(
      'Retention', 'background', payloadBytes, request.idempotency, null,
      (now) => {
        const leaseRes = this.conn.run(
          `UPDATE report_leases SET status = 'expired' WHERE status = 'active' AND expires_at_ms <= ?`,
          request.cutoffTimestampMs
        );
        const outboxRes = this.conn.run(
          `DELETE FROM state_change_outbox WHERE delivered_at_ms IS NOT NULL AND delivered_at_ms <= ?`,
          request.cutoffTimestampMs
        );
        if (request.failpointStep === 'after_receipt_sweep') throw new Error('FAILPOINT_INJECTED:after_receipt_sweep');

        this.conn.run(`DELETE FROM artifact_pins WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?`, request.cutoffTimestampMs);
        const evictRes = this.conn.run(
          `UPDATE artifact_availability SET state = 'evicted', last_verified_at_ms = ?
           WHERE state = 'available' AND artifact_id IN (
             SELECT a.artifact_id FROM artifacts a LEFT JOIN runs r ON r.run_id = a.created_by_run_id
             WHERE a.created_at_ms <= ?
               AND (r.run_id IS NULL OR r.status IN ('succeeded', 'failed', 'cancelled', 'aborted'))
               AND NOT EXISTS (SELECT 1 FROM artifact_pins p WHERE p.artifact_id = a.artifact_id)
           )`,
          now, request.cutoffTimestampMs
        );
        if (request.failpointStep === 'after_artifact_sweep' || request.failpointStep === 'before_receipt') {
          throw new Error(`FAILPOINT_INJECTED:${request.failpointStep}`);
        }
        return {
          ok: true, revision: 1,
          value: { expiredLeases: leaseRes.changes, evictedArtifacts: evictRes.changes, purgedOutboxRows: outboxRes.changes }
        };
      }
    );
  }

  public getOperationReceipt(
    scopeKind: string,
    scopeId: string,
    idempotencyKey: string
  ): OperationReceiptRow | undefined {
    const row = this.conn.get<{
      scope_kind: string; scope_id: string; idempotency_key: string;
      commit_unit: AtomicTransactionUnitName; request_sha256: string;
      resulting_revision: number; response_json: string; committed_at_ms: number;
    }>(
      `SELECT scope_kind, scope_id, idempotency_key, commit_unit, request_sha256, resulting_revision, response_json, committed_at_ms
       FROM operation_receipts WHERE scope_kind = ? AND scope_id = ? AND idempotency_key = ?`,
      scopeKind, scopeId, idempotencyKey
    );
    if (!row) return undefined;
    return {
      scopeKind: row.scope_kind, scopeId: row.scope_id, idempotencyKey: row.idempotency_key,
      commitUnit: row.commit_unit, requestSha256: row.request_sha256,
      resultingRevision: row.resulting_revision, responseJson: row.response_json,
      committedAtMs: row.committed_at_ms
    };
  }
}
