/**
 * FR-R6-F04 (F04-B, FR-012, FR-013, FR-014) — Domain store adapters for:
 * - `F06`: `UsageStoreAdapter` (`usage_observations`, `usage_corrections`,
 *   `usage_accounting_applications`, `attempt_usage_revisions`)
 * - `F07`: `LogIndexStoreAdapter` (`log_streams`, `log_segments`, `log_gaps`)
 * - `F08`: `RecoveryStoreAdapter` (`recovery_manifests`, `recovery_sources`)
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  AttemptUsageRevisionRow,
  LogGapRow,
  LogSegmentRow,
  LogStreamRow,
  RecoveryManifestRow,
  RecoverySourceRow,
  UsageCorrectionRow,
  UsageObservationRow
} from '../../../contracts/sqlite-store/domain-adapter-types';
import type { NodeSqliteConnection } from '../sqlite-driver';

export class UsageStoreAdapter {
  private readonly conn: NodeSqliteConnection;

  public constructor(conn: NodeSqliteConnection) {
    this.conn = conn;
  }

  public getAttemptUsageRevision(attemptId: string): AttemptUsageRevisionRow | undefined {
    const row = this.conn.get<{
      attempt_id: string;
      run_id: string;
      revision: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cached_tokens: number;
      total_cost_microdollars: number;
      completeness: AttemptUsageRevisionRow['completeness'];
      updated_at_ms: number;
    }>(`SELECT * FROM attempt_usage_revisions WHERE attempt_id = ?`, attemptId);
    if (!row) return undefined;
    return {
      attemptId: row.attempt_id,
      runId: row.run_id,
      revision: row.revision,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalCachedTokens: row.total_cached_tokens,
      totalCostMicrodollars: row.total_cost_microdollars,
      completeness: row.completeness,
      updatedAtMs: row.updated_at_ms
    };
  }

  public listObservationsForAttempt(attemptId: string): readonly UsageObservationRow[] {
    const rows = this.conn.all<{
      observation_id: string;
      run_id: string;
      step_id: string;
      attempt_id: string;
      provider: string;
      model_id: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost_microdollars: number;
      source_kind: UsageObservationRow['sourceKind'];
      observed_at_ms: number;
    }>(
      `SELECT * FROM usage_observations WHERE attempt_id = ? ORDER BY observed_at_ms ASC, observation_id ASC`,
      attemptId
    );
    return rows.map((r) => ({
      observationId: r.observation_id,
      runId: r.run_id,
      stepId: r.step_id,
      attemptId: r.attempt_id,
      provider: r.provider,
      modelId: r.model_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cachedTokens: r.cached_tokens,
      costMicrodollars: r.cost_microdollars,
      sourceKind: r.source_kind,
      observedAtMs: r.observed_at_ms
    }));
  }

  public listCorrectionsForObservation(observationId: string): readonly UsageCorrectionRow[] {
    const rows = this.conn.all<{
      correction_id: string;
      observation_id: string;
      reason: string;
      delta_input_tokens: number;
      delta_output_tokens: number;
      delta_cost_microdollars: number;
      pricing_version: string;
      created_at_ms: number;
    }>(
      `SELECT * FROM usage_corrections WHERE observation_id = ? ORDER BY created_at_ms ASC, correction_id ASC`,
      observationId
    );
    return rows.map((r) => ({
      correctionId: r.correction_id,
      observationId: r.observation_id,
      reason: r.reason,
      deltaInputTokens: r.delta_input_tokens,
      deltaOutputTokens: r.delta_output_tokens,
      deltaCostMicrodollars: r.delta_cost_microdollars,
      pricingVersion: r.pricing_version,
      createdAtMs: r.created_at_ms
    }));
  }
}

export class LogIndexStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public openStream(params: {
    readonly streamId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly channel: LogStreamRow['channel'];
  }): LogStreamRow {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO log_streams (
        stream_id, run_id, step_id, attempt_id, channel, total_bytes, segment_count, closed, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      params.streamId,
      params.runId,
      params.stepId,
      params.attemptId,
      params.channel,
      now,
      now
    );
    return {
      streamId: params.streamId,
      runId: params.runId,
      stepId: params.stepId,
      attemptId: params.attemptId,
      channel: params.channel,
      totalBytes: 0,
      segmentCount: 0,
      closed: 0,
      createdAtMs: now,
      updatedAtMs: now
    };
  }

  public appendSegment(params: {
    readonly segmentId: string;
    readonly streamId: string;
    readonly segmentSeq: number;
    readonly startByteOffset: number;
    readonly endByteOffset: number;
    readonly lineCount: number;
    readonly contentSha256: string;
    readonly relativePath: string;
  }): LogSegmentRow {
    const now = this.nowMs();
    const byteDelta = Math.max(0, params.endByteOffset - params.startByteOffset);
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO log_segments (
          segment_id, stream_id, segment_seq, start_byte_offset, end_byte_offset, line_count, content_sha256, relative_path, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params.segmentId,
        params.streamId,
        params.segmentSeq,
        params.startByteOffset,
        params.endByteOffset,
        params.lineCount,
        params.contentSha256,
        params.relativePath,
        now
      );
      this.conn.run(
        `UPDATE log_streams SET
           total_bytes = total_bytes + ?,
           segment_count = segment_count + 1,
           updated_at_ms = ?
         WHERE stream_id = ?`,
        byteDelta,
        now,
        params.streamId
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
      segmentId: params.segmentId,
      streamId: params.streamId,
      segmentSeq: params.segmentSeq,
      startByteOffset: params.startByteOffset,
      endByteOffset: params.endByteOffset,
      lineCount: params.lineCount,
      contentSha256: params.contentSha256,
      relativePath: params.relativePath,
      createdAtMs: now
    };
  }

  public recordGap(params: {
    readonly gapId: string;
    readonly streamId: string;
    readonly afterSegmentSeq: number;
    readonly droppedBytes: number;
    readonly reason: LogGapRow['reason'];
  }): LogGapRow {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO log_gaps (gap_id, stream_id, after_segment_seq, dropped_bytes, reason, recorded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      params.gapId,
      params.streamId,
      params.afterSegmentSeq,
      params.droppedBytes,
      params.reason,
      now
    );
    return {
      gapId: params.gapId,
      streamId: params.streamId,
      afterSegmentSeq: params.afterSegmentSeq,
      droppedBytes: params.droppedBytes,
      reason: params.reason,
      recordedAtMs: now
    };
  }

  public closeStream(streamId: string): void {
    this.conn.run(
      `UPDATE log_streams SET closed = 1, updated_at_ms = ? WHERE stream_id = ?`,
      this.nowMs(),
      streamId
    );
  }

  public listSegments(streamId: string): readonly LogSegmentRow[] {
    const rows = this.conn.all<{
      segment_id: string;
      stream_id: string;
      segment_seq: number;
      start_byte_offset: number;
      end_byte_offset: number;
      line_count: number;
      content_sha256: string;
      relative_path: string;
      created_at_ms: number;
    }>(`SELECT * FROM log_segments WHERE stream_id = ? ORDER BY segment_seq ASC`, streamId);
    return rows.map((r) => ({
      segmentId: r.segment_id,
      streamId: r.stream_id,
      segmentSeq: r.segment_seq,
      startByteOffset: r.start_byte_offset,
      endByteOffset: r.end_byte_offset,
      lineCount: r.line_count,
      contentSha256: r.content_sha256,
      relativePath: r.relative_path,
      createdAtMs: r.created_at_ms
    }));
  }
}

export class RecoveryStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public recordRecoveryManifest(params: {
    readonly manifestId: string;
    readonly runId: string;
    readonly stepId?: string | null | undefined;
    readonly attemptId?: string | null | undefined;
    readonly frozenClosureId?: string | null | undefined;
    readonly classification: RecoveryManifestRow['classification'];
    readonly actionTaken: string;
    readonly sources: ReadonlyArray<{
      readonly sourceId: string;
      readonly sourceKind: RecoverySourceRow['sourceKind'];
      readonly sourceRef: string;
      readonly digestSha256: string;
      readonly verified: boolean;
    }>;
  }): RecoveryManifestRow {
    const now = this.nowMs();
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO recovery_manifests (
          manifest_id, run_id, step_id, attempt_id, frozen_closure_id, classification, action_taken, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params.manifestId,
        params.runId,
        params.stepId ?? null,
        params.attemptId ?? null,
        params.frozenClosureId ?? null,
        params.classification,
        params.actionTaken,
        now
      );

      for (const src of params.sources) {
        this.conn.run(
          `INSERT INTO recovery_sources (source_id, manifest_id, source_kind, source_ref, digest_sha256, verified)
           VALUES (?, ?, ?, ?, ?, ?)`,
          src.sourceId,
          params.manifestId,
          src.sourceKind,
          src.sourceRef,
          src.digestSha256,
          src.verified ? 1 : 0
        );
      }
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
      manifestId: params.manifestId,
      runId: params.runId,
      stepId: params.stepId ?? null,
      attemptId: params.attemptId ?? null,
      frozenClosureId: params.frozenClosureId ?? null,
      classification: params.classification,
      actionTaken: params.actionTaken,
      createdAtMs: now
    };
  }

  public listSourcesForManifest(manifestId: string): readonly RecoverySourceRow[] {
    const rows = this.conn.all<{
      source_id: string;
      manifest_id: string;
      source_kind: RecoverySourceRow['sourceKind'];
      source_ref: string;
      digest_sha256: string;
      verified: 0 | 1;
    }>(`SELECT * FROM recovery_sources WHERE manifest_id = ? ORDER BY source_id ASC`, manifestId);
    return rows.map((r) => ({
      sourceId: r.source_id,
      manifestId: r.manifest_id,
      sourceKind: r.source_kind,
      sourceRef: r.source_ref,
      digestSha256: r.digest_sha256,
      verified: r.verified
    }));
  }
}
