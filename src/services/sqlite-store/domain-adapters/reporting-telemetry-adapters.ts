/**
 * FR-R6-F04 (F04-B, FR-006, FR-016, FR-018) — Domain store adapters for:
 * - `F11`: `ReportingStoreAdapter` (`execution_summary_revisions`,
 *   `aggregate_revisions`, `report_manifests`, `report_leases`,
 *   `export_operations`, and keyset pagination anchored at cutoff revision `S`
 *   without joining raw `attempts`, `log_segments`, or `findings`)
 * - `F14`: `TelemetryStoreAdapter` (`telemetry_destinations`,
 *   `telemetry_export_copies`, `telemetry_delivery_receipts`,
 *   `telemetry_cardinality_sets`)
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  AggregateRevisionRow,
  ExecutionSummaryRevisionRow,
  ExportOperationRow,
  KeysetPageRequest,
  KeysetPageResult,
  ReportLeaseRow,
  ReportManifestRow,
  TelemetryCardinalitySetRow,
  TelemetryDeliveryReceiptRow,
  TelemetryDestinationRow,
  TelemetryExportCopyRow
} from '../../../contracts/sqlite-store/domain-adapter-types';
import type { BoundedReadConnectionPool, NodeSqliteConnection } from '../sqlite-driver';

export class ReportingStoreAdapter {
  private readonly writerConn: NodeSqliteConnection;
  private readonly readPool: BoundedReadConnectionPool;
  private readonly nowMs: () => number;

  public constructor(
    writerConn: NodeSqliteConnection,
    readPool: BoundedReadConnectionPool,
    nowMs: () => number = () => Date.now()
  ) {
    this.writerConn = writerConn;
    this.readPool = readPool;
    this.nowMs = nowMs;
  }

  /**
   * Executes a single bounded keyset-paginated read over `execution_summary_revisions`
   * anchored at `request.cutoffRevision` (`S`).
   * Never joins raw `attempts`, `log_segments`, or `findings` (`FR-006`, `FR-016`).
   */
  public queryExecutionSummariesKeysetPage(
    request: KeysetPageRequest
  ): KeysetPageResult<ExecutionSummaryRevisionRow> {
    const limit = Math.max(1, Math.min(200, request.pageSize));
    const cutoff = request.cursor?.cutoffRevision ?? request.cutoffRevision;

    return this.readPool.withReadConnection(this.writerConn, (conn) => {
      const rows = request.cursor
        ? conn.all<{
            run_id: string;
            workspace_id: string;
            workflow_id: string;
            status: string;
            revision: number;
            step_count: number;
            completed_step_count: number;
            attempt_count: number;
            open_finding_count: number;
            total_tokens: number;
            total_cost_microdollars: number;
            duration_ms: number;
            started_at_ms: number | null;
            updated_at_ms: number;
          }>(
            `SELECT *
             FROM execution_summary_revisions
             WHERE workspace_id = ?
               AND revision <= ?
               AND (? IS NULL OR status = ?)
               AND (
                 updated_at_ms < ?
                 OR (updated_at_ms = ? AND run_id < ?)
               )
             ORDER BY updated_at_ms DESC, run_id DESC
             LIMIT ?`,
            request.workspaceId,
            cutoff,
            request.statusFilter ?? null,
            request.statusFilter ?? null,
            request.cursor.lastUpdatedAtMs,
            request.cursor.lastUpdatedAtMs,
            request.cursor.lastRunId,
            limit
          )
        : conn.all<{
            run_id: string;
            workspace_id: string;
            workflow_id: string;
            status: string;
            revision: number;
            step_count: number;
            completed_step_count: number;
            attempt_count: number;
            open_finding_count: number;
            total_tokens: number;
            total_cost_microdollars: number;
            duration_ms: number;
            started_at_ms: number | null;
            updated_at_ms: number;
          }>(
            `SELECT *
             FROM execution_summary_revisions
             WHERE workspace_id = ?
               AND revision <= ?
               AND (? IS NULL OR status = ?)
             ORDER BY updated_at_ms DESC, run_id DESC
             LIMIT ?`,
            request.workspaceId,
            cutoff,
            request.statusFilter ?? null,
            request.statusFilter ?? null,
            limit
          );

      const items: ExecutionSummaryRevisionRow[] = rows.map((r) => ({
        runId: r.run_id,
        workspaceId: r.workspace_id,
        workflowId: r.workflow_id,
        status: r.status,
        revision: r.revision,
        stepCount: r.step_count,
        completedStepCount: r.completed_step_count,
        attemptCount: r.attempt_count,
        openFindingCount: r.open_finding_count,
        totalTokens: r.total_tokens,
        totalCostMicrodollars: r.total_cost_microdollars,
        durationMs: r.duration_ms,
        startedAtMs: r.started_at_ms,
        updatedAtMs: r.updated_at_ms
      }));

      const lastItem = items.length === limit ? items[items.length - 1] : undefined;
      return {
        items,
        cutoffRevision: cutoff,
        nextCursor: lastItem
          ? {
              cutoffRevision: cutoff,
              lastUpdatedAtMs: lastItem.updatedAtMs,
              lastRunId: lastItem.runId
            }
          : null
      };
    });
  }

  public getAggregateRevision(scopeKey: string): AggregateRevisionRow | undefined {
    return this.readPool.withReadConnection(this.writerConn, (conn) => {
      const row = conn.get<{
        scope_key: string;
        revision: number;
        run_count: number;
        succeeded_count: number;
        failed_count: number;
        total_tokens: number;
        total_cost_microdollars: number;
        updated_at_ms: number;
      }>(`SELECT * FROM aggregate_revisions WHERE scope_key = ?`, scopeKey);
      if (!row) return undefined;
      return {
        scopeKey: row.scope_key,
        revision: row.revision,
        runCount: row.run_count,
        succeededCount: row.succeeded_count,
        failedCount: row.failed_count,
        totalTokens: row.total_tokens,
        totalCostMicrodollars: row.total_cost_microdollars,
        updatedAtMs: row.updated_at_ms
      };
    });
  }

  public createReportManifest(params: {
    readonly reportId: string;
    readonly scopeKey: string;
    readonly cutoffRevision: number;
    readonly format: ReportManifestRow['format'];
    readonly artifactId?: string | null | undefined;
  }): ReportManifestRow {
    const now = this.nowMs();
    this.writerConn.run(
      `INSERT INTO report_manifests (report_id, scope_key, cutoff_revision, format, artifact_id, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      params.reportId,
      params.scopeKey,
      params.cutoffRevision,
      params.format,
      params.artifactId ?? null,
      now
    );
    return {
      reportId: params.reportId,
      scopeKey: params.scopeKey,
      cutoffRevision: params.cutoffRevision,
      format: params.format,
      artifactId: params.artifactId ?? null,
      createdAtMs: now
    };
  }

  public acquireReportLease(params: {
    readonly leaseId: string;
    readonly reportId: string;
    readonly holderId: string;
    readonly cutoffRevision: number;
    readonly ttlMs: number;
  }): ReportLeaseRow {
    const now = this.nowMs();
    const expiresAtMs = now + Math.max(1, params.ttlMs);
    this.writerConn.run(
      `INSERT INTO report_leases (lease_id, report_id, holder_id, cutoff_revision, acquired_at_ms, expires_at_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      params.leaseId,
      params.reportId,
      params.holderId,
      params.cutoffRevision,
      now,
      expiresAtMs
    );
    return {
      leaseId: params.leaseId,
      reportId: params.reportId,
      holderId: params.holderId,
      cutoffRevision: params.cutoffRevision,
      acquiredAtMs: now,
      expiresAtMs,
      status: 'active'
    };
  }

  public recordExportOperation(params: {
    readonly exportId: string;
    readonly reportId: string;
    readonly destinationRelpath: string;
    readonly status: ExportOperationRow['status'];
    readonly byteLength: number;
    readonly contentSha256?: string | null | undefined;
  }): ExportOperationRow {
    const now = this.nowMs();
    const completedAtMs = params.status === 'completed' ? now : null;
    this.writerConn.run(
      `INSERT INTO export_operations (export_id, report_id, destination_relpath, status, byte_length, content_sha256, completed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params.exportId,
      params.reportId,
      params.destinationRelpath,
      params.status,
      params.byteLength,
      params.contentSha256 ?? null,
      completedAtMs
    );
    return {
      exportId: params.exportId,
      reportId: params.reportId,
      destinationRelpath: params.destinationRelpath,
      status: params.status,
      byteLength: params.byteLength,
      contentSha256: params.contentSha256 ?? null,
      completedAtMs
    };
  }
}

export class TelemetryStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public registerDestination(params: {
    readonly destinationId: string;
    readonly kind: TelemetryDestinationRow['kind'];
    readonly endpointOrPath: string;
    readonly enabled?: boolean | undefined;
  }): TelemetryDestinationRow {
    const now = this.nowMs();
    const enabled = params.enabled === false ? 0 : 1;
    this.conn.run(
      `INSERT INTO telemetry_destinations (destination_id, kind, endpoint_or_path, enabled, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      params.destinationId,
      params.kind,
      params.endpointOrPath,
      enabled,
      now
    );
    return {
      destinationId: params.destinationId,
      kind: params.kind,
      endpointOrPath: params.endpointOrPath,
      enabled,
      createdAtMs: now
    };
  }

  public enqueueExportCopy(params: {
    readonly copyId: string;
    readonly destinationId: string;
    readonly sourceCommitUnit: string;
    readonly sourceRevision: number;
    readonly payloadJson: string;
  }): TelemetryExportCopyRow {
    const now = this.nowMs();
    const payloadBytes = Buffer.byteLength(params.payloadJson, 'utf8');
    this.conn.run(
      `INSERT INTO telemetry_export_copies (
        copy_id, destination_id, source_commit_unit, source_revision, payload_json, payload_bytes, status, retry_count, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      params.copyId,
      params.destinationId,
      params.sourceCommitUnit,
      params.sourceRevision,
      params.payloadJson,
      payloadBytes,
      now,
      now
    );
    return {
      copyId: params.copyId,
      destinationId: params.destinationId,
      sourceCommitUnit: params.sourceCommitUnit,
      sourceRevision: params.sourceRevision,
      payloadJson: params.payloadJson,
      payloadBytes,
      status: 'queued',
      retryCount: 0,
      createdAtMs: now,
      updatedAtMs: now
    };
  }

  public recordDeliveryReceipt(params: {
    readonly deliveryId: string;
    readonly copyId: string;
    readonly destinationId: string;
    readonly statusCode: number;
    readonly diagnosticText: string;
    readonly markStatus: 'sent' | 'failed' | 'dead_letter';
  }): TelemetryDeliveryReceiptRow {
    const now = this.nowMs();
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO telemetry_delivery_receipts (delivery_id, copy_id, destination_id, status_code, delivered_at_ms, diagnostic_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
        params.deliveryId,
        params.copyId,
        params.destinationId,
        params.statusCode,
        now,
        params.diagnosticText
      );
      this.conn.run(
        `UPDATE telemetry_export_copies SET
           status = ?,
           retry_count = CASE WHEN ? = 'sent' THEN retry_count ELSE retry_count + 1 END,
           updated_at_ms = ?
         WHERE copy_id = ?`,
        params.markStatus,
        params.markStatus,
        now,
        params.copyId
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

    return {
      deliveryId: params.deliveryId,
      copyId: params.copyId,
      destinationId: params.destinationId,
      statusCode: params.statusCode,
      deliveredAtMs: now,
      diagnosticText: params.diagnosticText
    };
  }

  public recordCardinalityAttribute(params: {
    readonly metricFamily: string;
    readonly attributeKey: string;
    readonly attributeValue: string;
    readonly maxDistinctPerKey: number;
  }):
    | { readonly admitted: true; readonly row: TelemetryCardinalitySetRow }
    | { readonly admitted: false; readonly reason: 'CARDINALITY_CAP_REACHED'; readonly currentDistinct: number } {
    const now = this.nowMs();
    const existing = this.conn.get<{ first_seen_at_ms: number }>(
      `SELECT first_seen_at_ms FROM telemetry_cardinality_sets
       WHERE metric_family = ? AND attribute_key = ? AND attribute_value = ?`,
      params.metricFamily,
      params.attributeKey,
      params.attributeValue
    );
    if (existing) {
      return {
        admitted: true,
        row: {
          metricFamily: params.metricFamily,
          attributeKey: params.attributeKey,
          attributeValue: params.attributeValue,
          firstSeenAtMs: existing.first_seen_at_ms
        }
      };
    }

    const count = Number(
      this.conn.scalar(
        `SELECT COUNT(*) FROM telemetry_cardinality_sets WHERE metric_family = ? AND attribute_key = ?`,
        params.metricFamily,
        params.attributeKey
      ) ?? 0
    );
    if (count >= params.maxDistinctPerKey) {
      return {
        admitted: false,
        reason: 'CARDINALITY_CAP_REACHED',
        currentDistinct: count
      };
    }

    this.conn.run(
      `INSERT INTO telemetry_cardinality_sets (metric_family, attribute_key, attribute_value, first_seen_at_ms)
       VALUES (?, ?, ?, ?)`,
      params.metricFamily,
      params.attributeKey,
      params.attributeValue,
      now
    );
    return {
      admitted: true,
      row: {
        metricFamily: params.metricFamily,
        attributeKey: params.attributeKey,
        attributeValue: params.attributeValue,
        firstSeenAtMs: now
      }
    };
  }
}
