/**
 * FR-R6-F04 (F04-B, FR-011, FR-015) — Domain store adapters for:
 * - `F05`: `ArtifactStoreAdapter` (`artifacts`, `artifact_locations`,
 *   `artifact_availability`, `artifact_publications`, `artifact_consumptions`,
 *   `artifact_derivations`, single-owner `artifact_pins`, and GC eligibility)
 * - `F10`: `ExecutionWorkspaceStoreAdapter` (`execution_workspaces`,
 *   `candidate_snapshots`, `integration_receipts`)
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  ArtifactAvailabilityRow,
  ArtifactLocationRow,
  ArtifactPinRow,
  ArtifactRow,
  CandidateSnapshotRow,
  ExecutionWorkspaceRow,
  IntegrationReceiptRow
} from '../../../contracts/sqlite-store/domain-adapter-types';
import type { NodeSqliteConnection } from '../sqlite-driver';

export class ArtifactStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public registerArtifact(params: {
    readonly artifactId: string;
    readonly contentSha256: string;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly kind: string;
    readonly createdByRunId?: string | null | undefined;
    readonly createdByAttemptId?: string | null | undefined;
    readonly location: {
      readonly locationId: string;
      readonly storageTier: 'inline_db' | 'cas_blob' | 'workspace_file';
      readonly uriOrRelpath: string;
      readonly inlineBytes?: Uint8Array | null | undefined;
    };
    readonly availabilityState?: 'available' | 'quarantined' | 'evicted' | 'missing' | undefined;
  }): ArtifactRow {
    const now = this.nowMs();
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO artifacts (
          artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params.artifactId,
        params.contentSha256,
        params.byteLength,
        params.mediaType,
        params.kind,
        params.createdByRunId ?? null,
        params.createdByAttemptId ?? null,
        now
      );

      this.conn.run(
        `INSERT INTO artifact_locations (
          location_id, artifact_id, storage_tier, uri_or_relpath, inline_bytes, verified_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        params.location.locationId,
        params.artifactId,
        params.location.storageTier,
        params.location.uriOrRelpath,
        params.location.inlineBytes ?? null,
        now
      );

      this.conn.run(
        `INSERT INTO artifact_availability (
          artifact_id, state, last_verified_at_ms, detail_json
        ) VALUES (?, ?, ?, '{}')`,
        params.artifactId,
        params.availabilityState ?? 'available',
        now
      );

      this.conn.exec('COMMIT');
    } catch (error) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw error;
    }

    return {
      artifactId: params.artifactId,
      contentSha256: params.contentSha256,
      byteLength: params.byteLength,
      mediaType: params.mediaType,
      kind: params.kind,
      createdByRunId: params.createdByRunId ?? null,
      createdByAttemptId: params.createdByAttemptId ?? null,
      createdAtMs: now
    };
  }

  public recordPublication(params: {
    readonly publicationId: string;
    readonly artifactId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly role: string;
  }): void {
    this.conn.run(
      `INSERT INTO artifact_publications (publication_id, artifact_id, run_id, step_id, attempt_id, role, published_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params.publicationId,
      params.artifactId,
      params.runId,
      params.stepId,
      params.attemptId,
      params.role,
      this.nowMs()
    );
  }

  public recordConsumption(params: {
    readonly consumptionId: string;
    readonly artifactId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly inputName: string;
  }): void {
    this.conn.run(
      `INSERT INTO artifact_consumptions (consumption_id, artifact_id, run_id, step_id, attempt_id, input_name, consumed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params.consumptionId,
      params.artifactId,
      params.runId,
      params.stepId,
      params.attemptId,
      params.inputName,
      this.nowMs()
    );
  }

  public recordDerivation(params: {
    readonly derivationId: string;
    readonly parentArtifactId: string;
    readonly childArtifactId: string;
    readonly transformKind: string;
  }): void {
    this.conn.run(
      `INSERT INTO artifact_derivations (derivation_id, parent_artifact_id, child_artifact_id, transform_kind, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      params.derivationId,
      params.parentArtifactId,
      params.childArtifactId,
      params.transformKind,
      this.nowMs()
    );
  }

  /**
   * Inserts an `artifact_pins` row. The SQLite `CHECK` constraint enforces that
   * exactly one of `ownerRunId`, `ownerAttemptId`, `ownerHandoffId`, or `ownerExportId`
   * is non-null.
   */
  public pinArtifact(params: {
    readonly pinId: string;
    readonly artifactId: string;
    readonly ownerRunId?: string | null | undefined;
    readonly ownerAttemptId?: string | null | undefined;
    readonly ownerHandoffId?: string | null | undefined;
    readonly ownerExportId?: string | null | undefined;
    readonly reason: string;
    readonly expiresAtMs?: number | null | undefined;
  }): ArtifactPinRow {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO artifact_pins (
        pin_id, artifact_id, owner_run_id, owner_attempt_id, owner_handoff_id, owner_export_id, reason, pinned_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.pinId,
      params.artifactId,
      params.ownerRunId ?? null,
      params.ownerAttemptId ?? null,
      params.ownerHandoffId ?? null,
      params.ownerExportId ?? null,
      params.reason,
      now,
      params.expiresAtMs ?? null
    );
    return {
      pinId: params.pinId,
      artifactId: params.artifactId,
      ownerRunId: params.ownerRunId ?? null,
      ownerAttemptId: params.ownerAttemptId ?? null,
      ownerHandoffId: params.ownerHandoffId ?? null,
      ownerExportId: params.ownerExportId ?? null,
      reason: params.reason,
      pinnedAtMs: now,
      expiresAtMs: params.expiresAtMs ?? null
    };
  }

  public unpinArtifact(pinId: string): void {
    this.conn.run(`DELETE FROM artifact_pins WHERE pin_id = ?`, pinId);
  }

  public getArtifactAvailability(artifactId: string): ArtifactAvailabilityRow | undefined {
    const row = this.conn.get<{
      artifact_id: string;
      state: ArtifactAvailabilityRow['state'];
      last_verified_at_ms: number;
      detail_json: string;
    }>(
      `SELECT artifact_id, state, last_verified_at_ms, detail_json
       FROM artifact_availability WHERE artifact_id = ?`,
      artifactId
    );
    if (!row) return undefined;
    return {
      artifactId: row.artifact_id,
      state: row.state,
      lastVerifiedAtMs: row.last_verified_at_ms,
      detailJson: row.detail_json
    };
  }

  public listLocations(artifactId: string): readonly ArtifactLocationRow[] {
    const rows = this.conn.all<{
      location_id: string;
      artifact_id: string;
      storage_tier: ArtifactLocationRow['storageTier'];
      uri_or_relpath: string;
      inline_bytes: Uint8Array | null;
      verified_at_ms: number;
    }>(
      `SELECT location_id, artifact_id, storage_tier, uri_or_relpath, inline_bytes, verified_at_ms
       FROM artifact_locations WHERE artifact_id = ? ORDER BY location_id ASC`,
      artifactId
    );
    return rows.map((r) => ({
      locationId: r.location_id,
      artifactId: r.artifact_id,
      storageTier: r.storage_tier,
      uriOrRelpath: r.uri_or_relpath,
      inlineBytes: r.inline_bytes,
      verifiedAtMs: r.verified_at_ms
    }));
  }

  /**
   * Lists artifacts eligible for garbage collection:
   * - `artifact_availability.state = 'available'`
   * - Zero active (non-expired) pins in `artifact_pins`
   * - Creating run is null or in a terminal state (`succeeded`, `failed`, `cancelled`, `aborted`)
   */
  public listGcEligibleArtifactIds(nowTimestampMs: number = this.nowMs()): readonly string[] {
    const rows = this.conn.all<{ artifact_id: string }>(
      `SELECT a.artifact_id
       FROM artifacts a
       INNER JOIN artifact_availability av ON av.artifact_id = a.artifact_id
       LEFT JOIN runs r ON r.run_id = a.created_by_run_id
       WHERE av.state = 'available'
         AND (r.run_id IS NULL OR r.status IN ('succeeded', 'failed', 'cancelled', 'aborted'))
         AND NOT EXISTS (
           SELECT 1 FROM artifact_pins p
           WHERE p.artifact_id = a.artifact_id
             AND (p.expires_at_ms IS NULL OR p.expires_at_ms > ?)
         )
       ORDER BY a.artifact_id ASC`,
      nowTimestampMs
    );
    return rows.map((r) => r.artifact_id);
  }
}

export class ExecutionWorkspaceStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public registerWorkspace(params: {
    readonly executionWorkspaceId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly strategy: 'worktree' | 'clone' | 'in_place';
    readonly rootRelpath: string;
    readonly baseCommitSha: string;
    readonly headCommitSha: string;
    readonly state?: ExecutionWorkspaceRow['state'] | undefined;
  }): ExecutionWorkspaceRow {
    const now = this.nowMs();
    const state = params.state ?? 'active';
    this.conn.run(
      `INSERT INTO execution_workspaces (
        execution_workspace_id, run_id, step_id, attempt_id, strategy,
        root_relpath, base_commit_sha, head_commit_sha, state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.executionWorkspaceId,
      params.runId,
      params.stepId,
      params.attemptId,
      params.strategy,
      params.rootRelpath,
      params.baseCommitSha,
      params.headCommitSha,
      state,
      now,
      now
    );
    return {
      executionWorkspaceId: params.executionWorkspaceId,
      runId: params.runId,
      stepId: params.stepId,
      attemptId: params.attemptId,
      strategy: params.strategy,
      rootRelpath: params.rootRelpath,
      baseCommitSha: params.baseCommitSha,
      headCommitSha: params.headCommitSha,
      state,
      createdAtMs: now,
      updatedAtMs: now
    };
  }

  public recordCandidateSnapshot(params: {
    readonly snapshotId: string;
    readonly executionWorkspaceId: string;
    readonly treeSha: string;
    readonly commitSha: string;
    readonly dirtyFileCount: number;
    readonly diffArtifactId?: string | null | undefined;
  }): CandidateSnapshotRow {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO candidate_snapshots (
        snapshot_id, execution_workspace_id, tree_sha, commit_sha, dirty_file_count, diff_artifact_id, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params.snapshotId,
      params.executionWorkspaceId,
      params.treeSha,
      params.commitSha,
      params.dirtyFileCount,
      params.diffArtifactId ?? null,
      now
    );
    this.conn.run(
      `UPDATE execution_workspaces SET head_commit_sha = ?, state = 'snapshot_ready', updated_at_ms = ?
       WHERE execution_workspace_id = ?`,
      params.commitSha,
      now,
      params.executionWorkspaceId
    );
    return {
      snapshotId: params.snapshotId,
      executionWorkspaceId: params.executionWorkspaceId,
      treeSha: params.treeSha,
      commitSha: params.commitSha,
      dirtyFileCount: params.dirtyFileCount,
      diffArtifactId: params.diffArtifactId ?? null,
      createdAtMs: now
    };
  }

  public recordIntegrationReceipt(params: {
    readonly receiptId: string;
    readonly executionWorkspaceId: string;
    readonly snapshotId: string;
    readonly targetBranch: string;
    readonly integratedCommitSha: string | null;
    readonly status: IntegrationReceiptRow['status'];
  }): IntegrationReceiptRow {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO integration_receipts (
        receipt_id, execution_workspace_id, snapshot_id, target_branch, integrated_commit_sha, status, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params.receiptId,
      params.executionWorkspaceId,
      params.snapshotId,
      params.targetBranch,
      params.integratedCommitSha,
      params.status,
      now
    );
    if (params.status === 'merged' || params.status === 'fast_forwarded') {
      this.conn.run(
        `UPDATE execution_workspaces SET state = 'integrated', updated_at_ms = ?
         WHERE execution_workspace_id = ?`,
        now,
        params.executionWorkspaceId
      );
    }
    return {
      receiptId: params.receiptId,
      executionWorkspaceId: params.executionWorkspaceId,
      snapshotId: params.snapshotId,
      targetBranch: params.targetBranch,
      integratedCommitSha: params.integratedCommitSha,
      status: params.status,
      recordedAtMs: now
    };
  }

  public getWorkspaceByAttempt(
    runId: string,
    stepId: string,
    attemptId: string
  ): ExecutionWorkspaceRow | undefined {
    const row = this.conn.get<{
      execution_workspace_id: string;
      run_id: string;
      step_id: string;
      attempt_id: string;
      strategy: ExecutionWorkspaceRow['strategy'];
      root_relpath: string;
      base_commit_sha: string;
      head_commit_sha: string;
      state: ExecutionWorkspaceRow['state'];
      created_at_ms: number;
      updated_at_ms: number;
    }>(
      `SELECT * FROM execution_workspaces WHERE run_id = ? AND step_id = ? AND attempt_id = ?`,
      runId,
      stepId,
      attemptId
    );
    if (!row) return undefined;
    return {
      executionWorkspaceId: row.execution_workspace_id,
      runId: row.run_id,
      stepId: row.step_id,
      attemptId: row.attempt_id,
      strategy: row.strategy,
      rootRelpath: row.root_relpath,
      baseCommitSha: row.base_commit_sha,
      headCommitSha: row.head_commit_sha,
      state: row.state,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    };
  }
}
