/**
 * FR-R6-F05 US3 (FR-014, FR-015) — the `preservation_operations` and
 * `preservation_targets` rows legacy preservation persists.
 *
 * Keys are workspace-relative and stay in the database; the projection handed
 * to callers (`SourcePreservationOperation`) carries ordinals, digests and
 * outcomes only.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  PreservationOperationState,
  PreservationTargetOutcome,
  SourcePreservationOperation
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { NodeSqliteConnection } from '../sqlite-store';

export interface PreservationTargetRow {
  readonly operation_id: string;
  readonly target_ordinal: number;
  readonly source_key: string;
  readonly destination_key: string | null;
  readonly source_digest: string | null;
  readonly destination_digest: string | null;
  readonly outcome: PreservationTargetOutcome;
  readonly updated_at_ms: number;
}

interface PreservationOperationRow {
  readonly operation_id: string;
  readonly state: PreservationOperationState;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

/** A target row with the state of the operation that owns it. */
export interface LatestPreservationTarget extends PreservationTargetRow {
  readonly operation_state: PreservationOperationState;
}

export interface NewPreservationTarget {
  readonly sourceKey: string;
  readonly destinationKey: string | null;
  readonly sourceDigest: string | null;
}

/** Operation states an interruption can leave behind; reconciliation resolves them. */
export const IN_FLIGHT_PRESERVATION_STATES: readonly PreservationOperationState[] = ['planned', 'copying', 'verifying'];

export class PreservationRows {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public insertOperation(
    operationId: string,
    workspaceId: string,
    previewId: string,
    targets: readonly NewPreservationTarget[]
  ): void {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO preservation_operations (operation_id, workspace_id, preview_id, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'planned', ?, ?)`,
      operationId,
      workspaceId,
      previewId,
      now,
      now
    );
    targets.forEach((target, ordinal) => {
      this.conn.run(
        `INSERT INTO preservation_targets
           (operation_id, target_ordinal, source_key, destination_key, source_digest, destination_digest, outcome, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL, 'preserved-in-place', ?)`,
        operationId,
        ordinal,
        target.sourceKey,
        target.destinationKey,
        target.sourceDigest,
        now
      );
    });
  }

  public setState(operationId: string, state: PreservationOperationState): void {
    this.conn.run(
      `UPDATE preservation_operations SET state = ?, updated_at_ms = ? WHERE operation_id = ?`,
      state,
      this.nowMs(),
      operationId
    );
  }

  public setOutcome(
    operationId: string,
    ordinal: number,
    outcome: PreservationTargetOutcome,
    destinationDigest: string | null
  ): void {
    this.conn.run(
      `UPDATE preservation_targets SET outcome = ?, destination_digest = ?, updated_at_ms = ?
       WHERE operation_id = ? AND target_ordinal = ?`,
      outcome,
      destinationDigest,
      this.nowMs(),
      operationId,
      ordinal
    );
  }

  /** The quarantined copy is gone: the destination key is cleared, its digest kept as the record. */
  public markDestinationPurged(operationId: string, ordinal: number): void {
    this.conn.run(
      `UPDATE preservation_targets SET destination_key = NULL, updated_at_ms = ?
       WHERE operation_id = ? AND target_ordinal = ?`,
      this.nowMs(),
      operationId,
      ordinal
    );
  }

  public targets(operationId: string): readonly PreservationTargetRow[] {
    return this.conn.all<PreservationTargetRow>(
      `SELECT * FROM preservation_targets WHERE operation_id = ? ORDER BY target_ordinal`,
      operationId
    );
  }

  /** The newest target row per source key, with its operation's state. */
  public latestBySourceKey(): ReadonlyMap<string, LatestPreservationTarget> {
    const rows = this.conn.all<LatestPreservationTarget>(
      `SELECT t.*, o.state AS operation_state
         FROM preservation_targets t JOIN preservation_operations o ON o.operation_id = t.operation_id
        ORDER BY t.rowid`
    );
    return new Map(rows.map((row) => [row.source_key, row]));
  }

  public projection(operationId: string): SourcePreservationOperation | null {
    const operation = this.conn.get<PreservationOperationRow>(
      `SELECT operation_id, state, created_at_ms, updated_at_ms FROM preservation_operations WHERE operation_id = ?`,
      operationId
    );
    if (operation === undefined) return null;
    return {
      operationId: operation.operation_id,
      state: operation.state,
      targets: this.targets(operationId).map((row) => ({
        ordinal: row.target_ordinal,
        sourceDigest: row.source_digest,
        destinationDigest: row.destination_digest,
        outcome: row.outcome
      })),
      createdAtMs: operation.created_at_ms,
      updatedAtMs: operation.updated_at_ms
    };
  }
}
