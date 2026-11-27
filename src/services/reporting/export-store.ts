/**
 * FR-R6-F11 (FR-015, NFR-003; data-model "Export record") — the `report_exports` rows.
 *
 * A record is written `pending` before any file is created and ends in exactly one terminal state:
 * `completed`, `cancelled`, `limited` or `failed`. No transition leaves a terminal state: every
 * update is guarded by `state = 'pending'`, so a late or repeated write changes nothing and
 * reports `false`.
 *
 * The partial unique index admits one `pending` export per workspace, across windows; a second
 * insert is refused `export-busy`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { ExportFormat } from '../../contracts/reporting/report-manifest';
import type { FailureReason, LimitReason } from '../../contracts/reporting/report-outcomes';
import type { NodeSqliteConnection } from '../sqlite-store';

/** SQLite's extended result code for a UNIQUE constraint violation. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export type ExportState = 'pending' | 'completed' | 'failed' | 'cancelled' | 'limited';
export type ExportTerminalState = 'failed' | 'cancelled' | 'limited';
/** A failed record names the destination case when a file appeared before publication. */
export type ExportOutcomeReason = FailureReason | LimitReason | 'destination-exists';

export interface PendingExport {
  readonly exportId: string;
  readonly workspaceId: string;
  readonly reportId: string;
  readonly format: ExportFormat;
  /** The resolved anchor directory; read only by reconciliation, never shown. */
  readonly stagingDir: string;
  readonly finalName: string;
  readonly dataPartialName: string;
  readonly manifestPartialName: string;
  readonly overwrite: boolean;
  readonly createdMs: number;
}

export interface ExportRecord extends PendingExport {
  readonly state: ExportState;
  readonly reason: string | null;
  readonly rowCount: number | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
  readonly completedMs: number | null;
}

export interface CompletedExport {
  readonly rowCount: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly completedMs: number;
}

export type InsertPendingResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'export-busy' };

interface ExportRow {
  readonly export_id: string;
  readonly workspace_id: string;
  readonly report_id: string;
  readonly format: ExportFormat;
  readonly state: ExportState;
  readonly staging_dir: string;
  readonly final_name: string;
  readonly data_partial_name: string;
  readonly manifest_partial_name: string;
  readonly overwrite: number;
  readonly outcome_reason: string | null;
  readonly row_count: number | null;
  readonly byte_length: number | null;
  readonly content_sha256: string | null;
  readonly created_at_ms: number;
  readonly completed_at_ms: number | null;
}

const COLUMNS = `export_id, workspace_id, report_id, format, state, staging_dir, final_name,
  data_partial_name, manifest_partial_name, overwrite, outcome_reason, row_count, byte_length,
  content_sha256, created_at_ms, completed_at_ms`;

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE;
}

function pendingOf(row: ExportRow): PendingExport & { readonly state: ExportState } {
  return {
    exportId: row.export_id,
    workspaceId: row.workspace_id,
    reportId: row.report_id,
    format: row.format,
    stagingDir: row.staging_dir,
    finalName: row.final_name,
    dataPartialName: row.data_partial_name,
    manifestPartialName: row.manifest_partial_name,
    overwrite: row.overwrite === 1,
    createdMs: row.created_at_ms,
    state: row.state
  };
}

function recordOf(row: ExportRow): ExportRecord {
  return {
    ...pendingOf(row),
    reason: row.outcome_reason,
    rowCount: row.row_count,
    byteLength: row.byte_length,
    sha256: row.content_sha256,
    completedMs: row.completed_at_ms
  };
}

export class ExportStore {
  public constructor(private readonly conn: NodeSqliteConnection) {}

  /** Records `pending` before any file exists; a second pending export is `export-busy`. */
  public insertPending(entry: PendingExport): InsertPendingResult {
    try {
      this.conn.run(
        `INSERT INTO report_exports (export_id, workspace_id, report_id, format, state, staging_dir,
           final_name, data_partial_name, manifest_partial_name, overwrite, created_at_ms)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        entry.exportId,
        entry.workspaceId,
        entry.reportId,
        entry.format,
        entry.stagingDir,
        entry.finalName,
        entry.dataPartialName,
        entry.manifestPartialName,
        entry.overwrite ? 1 : 0,
        entry.createdMs
      );
      return { ok: true };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: 'export-busy' };
      throw error;
    }
  }

  /** Marks a pending export completed; `false` when it was no longer pending. */
  public complete(exportId: string, result: CompletedExport): boolean {
    const { changes } = this.conn.run(
      `UPDATE report_exports SET state = 'completed', outcome_reason = NULL, row_count = ?,
         byte_length = ?, content_sha256 = ?, completed_at_ms = ?
       WHERE export_id = ? AND state = 'pending'`,
      result.rowCount,
      result.byteLength,
      result.sha256,
      result.completedMs,
      exportId
    );
    return changes === 1;
  }

  /** Ends a pending export incomplete; `false` when it was no longer pending. */
  public finish(
    exportId: string,
    state: ExportTerminalState,
    reason: ExportOutcomeReason | null,
    completedMs: number
  ): boolean {
    const { changes } = this.conn.run(
      `UPDATE report_exports SET state = ?, outcome_reason = ?, completed_at_ms = ?
       WHERE export_id = ? AND state = 'pending'`,
      state,
      reason,
      completedMs,
      exportId
    );
    return changes === 1;
  }

  public get(exportId: string): ExportRecord | null {
    const row = this.conn.get<ExportRow>(`SELECT ${COLUMNS} FROM report_exports WHERE export_id = ?`, exportId);
    return row === undefined ? null : recordOf(row);
  }

  /** The workspace's pending exports, for reconciliation, oldest first. */
  public pendingRows(workspaceId: string): readonly (PendingExport & { readonly state: ExportState })[] {
    return this.conn
      .all<ExportRow>(
        `SELECT ${COLUMNS} FROM report_exports WHERE workspace_id = ? AND state = 'pending'
         ORDER BY created_at_ms, export_id`,
        workspaceId
      )
      .map(pendingOf);
  }
}
