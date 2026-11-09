/**
 * FR-R6-F04 (F04-B, FR-019) — `HandoffReviewStoreAdapter` for `F15`:
 * Queries and updates `accepted_results`, `result_values`, `handoffs`,
 * `handoff_sources`, `input_envelopes`, `input_bindings`, `handoff_approvals`,
 * `handoff_delivery_observations`, `review_loops`, `review_reports`, `findings`,
 * `finding_dispositions`, and `fix_claims`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  AcceptedResultRow,
  FindingRow,
  HandoffRow,
  ReviewLoopRow
} from '../../../contracts/sqlite-store/domain-adapter-types';
import type { NodeSqliteConnection } from '../sqlite-driver';

export class HandoffReviewStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public recordHandoffApproval(params: {
    readonly approvalId: string;
    readonly handoffId: string;
    readonly approverId: string;
    readonly decision: 'approved' | 'rejected';
    readonly notes: string;
  }): void {
    const now = this.nowMs();
    const nextStatus = params.decision === 'approved' ? 'approved' : 'rejected';
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO handoff_approvals (approval_id, handoff_id, approver_id, decision, notes, decided_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        params.approvalId,
        params.handoffId,
        params.approverId,
        params.decision,
        params.notes,
        now
      );
      this.conn.run(
        `UPDATE handoffs SET status = ?, revision = revision + 1, updated_at_ms = ? WHERE handoff_id = ?`,
        nextStatus,
        now,
        params.handoffId
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  public recordHandoffDeliveryObservation(params: {
    readonly observationId: string;
    readonly handoffId: string;
    readonly consumerAttemptId: string;
    readonly deliveryStatus: 'delivered' | 'acknowledged' | 'failed';
  }): void {
    const now = this.nowMs();
    const nextHandoffStatus =
      params.deliveryStatus === 'acknowledged'
        ? 'consumed'
        : params.deliveryStatus === 'delivered'
          ? 'delivered'
          : 'prepared';
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO handoff_delivery_observations (observation_id, handoff_id, consumer_attempt_id, delivery_status, observed_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        params.observationId,
        params.handoffId,
        params.consumerAttemptId,
        params.deliveryStatus,
        now
      );
      this.conn.run(
        `UPDATE handoffs SET status = ?, revision = revision + 1, updated_at_ms = ? WHERE handoff_id = ?`,
        nextHandoffStatus,
        now,
        params.handoffId
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  public getHandoff(handoffId: string): HandoffRow | undefined {
    const row = this.conn.get<{
      handoff_id: string;
      run_id: string;
      from_step_id: string;
      to_step_id: string;
      revision: number;
      status: HandoffRow['status'];
      created_at_ms: number;
      updated_at_ms: number;
    }>(`SELECT * FROM handoffs WHERE handoff_id = ?`, handoffId);
    if (!row) return undefined;
    return {
      handoffId: row.handoff_id,
      runId: row.run_id,
      fromStepId: row.from_step_id,
      toStepId: row.to_step_id,
      revision: row.revision,
      status: row.status,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    };
  }

  public getAcceptedResult(resultId: string): AcceptedResultRow | undefined {
    const row = this.conn.get<{
      result_id: string;
      run_id: string;
      step_id: string;
      attempt_id: string;
      schema_id: string;
      revision: number;
      status: AcceptedResultRow['status'];
      accepted_at_ms: number;
    }>(`SELECT * FROM accepted_results WHERE result_id = ?`, resultId);
    if (!row) return undefined;
    return {
      resultId: row.result_id,
      runId: row.run_id,
      stepId: row.step_id,
      attemptId: row.attempt_id,
      schemaId: row.schema_id,
      revision: row.revision,
      status: row.status,
      acceptedAtMs: row.accepted_at_ms
    };
  }

  public getReviewLoop(reviewLoopId: string): ReviewLoopRow | undefined {
    const row = this.conn.get<{
      review_loop_id: string;
      run_id: string;
      step_id: string;
      iteration: number;
      max_iterations: number;
      status: ReviewLoopRow['status'];
      revision: number;
      updated_at_ms: number;
    }>(`SELECT * FROM review_loops WHERE review_loop_id = ?`, reviewLoopId);
    if (!row) return undefined;
    return {
      reviewLoopId: row.review_loop_id,
      runId: row.run_id,
      stepId: row.step_id,
      iteration: row.iteration,
      maxIterations: row.max_iterations,
      status: row.status,
      revision: row.revision,
      updatedAtMs: row.updated_at_ms
    };
  }

  public listFindingsForLoop(reviewLoopId: string): readonly FindingRow[] {
    const rows = this.conn.all<{
      finding_id: string;
      review_loop_id: string;
      report_id: string;
      severity: FindingRow['severity'];
      category: string;
      file_path: string;
      line_number: number;
      summary: string;
      status: FindingRow['status'];
      created_at_ms: number;
      updated_at_ms: number;
    }>(`SELECT * FROM findings WHERE review_loop_id = ? ORDER BY finding_id ASC`, reviewLoopId);
    return rows.map((r) => ({
      findingId: r.finding_id,
      reviewLoopId: r.review_loop_id,
      reportId: r.report_id,
      severity: r.severity,
      category: r.category,
      filePath: r.file_path,
      lineNumber: r.line_number,
      summary: r.summary,
      status: r.status,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms
    }));
  }
}
