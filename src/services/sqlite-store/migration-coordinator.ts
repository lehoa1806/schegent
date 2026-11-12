/**
 * FR-R6-F04 (F04-A, FR-010, FR-024, SC-008) — Interruption-safe 7-stage
 * migration coordinator, quarantine ledger for corrupt/unknown-future-version
 * records, and `CutoverAuthorityGuard` old-reader refusal.
 *
 * Stages:
 * 1. `prepare-copy`
 * 2. `import`
 * 3. `quiesce/reconcile`
 * 4. `validate`
 * 5. `publish-authority`
 * 6. `retain-source`
 * 7. `retire-source`
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import {
  MIGRATION_STAGES,
  SQLITE_SCHEMA_CURRENT_VERSION,
  type MigrationQuarantineRow,
  type MigrationStageName,
  type RunStatus,
  type StorageAuthority
} from '../../contracts/sqlite-store/schema-types';
import type { NodeSqliteConnection } from './sqlite-driver';
import type {
  LegacyCatalogClassification,
  LegacyCatalogMigrationSection
} from '../../contracts/artifact-lifecycle/legacy-preservation-types';

const LEGACY_CATALOG_PREVIEW_PREFIX = 'legacy-catalog-';
const LEGACY_CATALOG_PREVIEW_HEX_LENGTH = 32;

export interface LegacyRunRecordInput {
  readonly recordKey: string;
  readonly rawJson: string;
}

export interface LegacyWorkspaceSnapshotInput {
  readonly migrationId: string;
  readonly scopeId: string;
  readonly maxSupportedLegacySchemaVersion?: number | undefined;
  readonly runRecords: readonly LegacyRunRecordInput[];
  readonly deltaRunRecords?: readonly LegacyRunRecordInput[] | undefined;
  readonly failAtStage?: MigrationStageName | undefined;
  /**
   * Copies the caller's non-run legacy state inside the `import` stage transaction (F04-FR-13/14).
   * Running it there, before `validate` and `publish-authority`, means SQLite authority is never
   * published over a partial copy: a throw rolls the stage back and leaves authority `legacy`,
   * and the next run copies again from the still-authoritative legacy source.
   */
  readonly importOperationalDocuments?: ((conn: NodeSqliteConnection, nowMs: number) => void) | undefined;
}

export interface ParsedLegacyRunPayload {
  readonly schemaVersion?: number;
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly workflowId?: string;
  readonly status?: RunStatus;
  readonly revision?: number;
  readonly priority?: number;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

export interface MigrationStageStatusRow {
  readonly migrationId: string;
  readonly stage: MigrationStageName;
  readonly status: 'in_progress' | 'pending' | 'completed' | 'failed' | 'blocked';
  readonly recordsProcessed: number;
  readonly quarantinedCount: number;
  readonly checksumSha256: string;
  readonly updatedAtMs: number;
}

export interface CutoverSentinelRow {
  readonly scopeId: string;
  readonly authority: StorageAuthority;
  readonly stage: string;
  readonly cutoverEpoch: number;
  readonly legacyDigestSha256: string;
  readonly sqliteDigestSha256: string;
  readonly updatedAtMs: number;
}

export interface MigrationPipelineOutcome {
  readonly completed: boolean;
  readonly authority: StorageAuthority;
  readonly currentStage: MigrationStageName;
  readonly importedRuns: number;
  readonly quarantinedRecords: number;
  readonly failureReason?: string | undefined;
}

/**
 * Guard inspected by legacy Memento / JSON readers and writers (`F04-NFR-05`).
 * Once `cutover_sentinel.authority` transitions to `'sqlite'` or `'retired_legacy'`,
 * legacy readers/writers are refused so older code paths cannot silently mutate
 * pre-cutover state.
 */
export class CutoverAuthorityGuard {
  private readonly conn: NodeSqliteConnection;

  public constructor(conn: NodeSqliteConnection) {
    this.conn = conn;
  }

  public getSentinel(scopeId: string): CutoverSentinelRow | undefined {
    const row = this.conn.get<{
      scope_id: string;
      authority: StorageAuthority;
      stage: string;
      cutover_epoch: number;
      legacy_digest_sha256: string;
      sqlite_digest_sha256: string;
      updated_at_ms: number;
    }>(
      `SELECT scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms
       FROM cutover_sentinel WHERE scope_id = ?`,
      scopeId
    );
    if (!row) return undefined;
    return {
      scopeId: row.scope_id,
      authority: row.authority,
      stage: row.stage,
      cutoverEpoch: row.cutover_epoch,
      legacyDigestSha256: row.legacy_digest_sha256,
      sqliteDigestSha256: row.sqlite_digest_sha256,
      updatedAtMs: row.updated_at_ms
    };
  }

  public checkLegacyAccessAllowed(scopeId: string):
    | { readonly allowed: true; readonly authority: StorageAuthority }
    | { readonly allowed: false; readonly authority: StorageAuthority; readonly reasonCode: 'SQLITE_AUTHORITY_ACTIVE'; readonly message: string } {
    const sentinel = this.getSentinel(scopeId);
    const authority: StorageAuthority = sentinel?.authority ?? 'legacy';
    if (authority === 'sqlite' || authority === 'retired_legacy') {
      return {
        allowed: false,
        authority,
        reasonCode: 'SQLITE_AUTHORITY_ACTIVE',
        message:
          `Refused legacy state access for scope '${scopeId}': SQLite store is authoritative ` +
          `(authority=${authority}, epoch=${sentinel?.cutoverEpoch ?? 0}).`
      };
    }
    return { allowed: true, authority };
  }
}

export class MigrationCoordinator {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;
  public readonly authorityGuard: CutoverAuthorityGuard;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
    this.authorityGuard = new CutoverAuthorityGuard(conn);
  }

  /**
   * FR-R6-F05 (T035, FR-013) — the legacy-catalog section of the migration
   * preview. Read-only: it touches no table, no stage ledger and no cutover
   * sentinel. The preview id is derived from the classification's basis
   * revision, so the same catalog state always yields the same id, and the
   * staleness inputs let a later apply refuse a catalog that moved.
   */
  public previewLegacyCatalog(classification: LegacyCatalogClassification): LegacyCatalogMigrationSection {
    const digest = createHash('sha256').update(classification.basisRevision, 'utf8').digest('hex');
    return {
      section: 'legacy-catalog',
      previewId: `${LEGACY_CATALOG_PREVIEW_PREFIX}${digest.slice(0, LEGACY_CATALOG_PREVIEW_HEX_LENGTH)}`,
      staleness: {
        manifestGeneration: classification.manifestGeneration,
        basisRevision: classification.basisRevision
      },
      classification
    };
  }

  public listStageLedger(migrationId: string): readonly MigrationStageStatusRow[] {
    const rows = this.conn.all<{
      migration_id: string;
      stage: MigrationStageName;
      status: 'in_progress' | 'pending' | 'completed' | 'failed' | 'blocked';
      records_processed: number;
      quarantined_count: number;
      checksum_sha256: string;
      updated_at_ms: number;
    }>(
      `SELECT migration_id, stage, status, records_processed, quarantined_count, checksum_sha256, updated_at_ms
       FROM migration_ledger WHERE migration_id = ?`,
      migrationId
    );
    return rows.map((r) => ({
      migrationId: r.migration_id,
      stage: r.stage,
      status: r.status,
      recordsProcessed: r.records_processed,
      quarantinedCount: r.quarantined_count,
      checksumSha256: r.checksum_sha256,
      updatedAtMs: r.updated_at_ms
    }));
  }

  public listQuarantineEntries(migrationId?: string): readonly MigrationQuarantineRow[] {
    const rows = migrationId
      ? this.conn.all<{
          quarantine_id: string;
          migration_id: string;
          source_surface: string;
          source_record_key: string;
          reason_code: MigrationQuarantineRow['reasonCode'];
          detected_schema_version: number | null;
          raw_payload: string;
          diagnostic_json: string;
          resolved: 0 | 1;
          created_at_ms: number;
        }>(
          `SELECT * FROM migration_quarantine WHERE migration_id = ? ORDER BY quarantine_id ASC`,
          migrationId
        )
      : this.conn.all<{
          quarantine_id: string;
          migration_id: string;
          source_surface: string;
          source_record_key: string;
          reason_code: MigrationQuarantineRow['reasonCode'];
          detected_schema_version: number | null;
          raw_payload: string;
          diagnostic_json: string;
          resolved: 0 | 1;
          created_at_ms: number;
        }>(`SELECT * FROM migration_quarantine ORDER BY quarantine_id ASC`);

    return rows.map((r) => ({
      quarantineId: r.quarantine_id,
      migrationId: r.migration_id,
      sourceSurface: r.source_surface,
      sourceRecordKey: r.source_record_key,
      reasonCode: r.reason_code,
      detectedSchemaVersion: r.detected_schema_version,
      rawPayload: r.raw_payload,
      diagnosticJson: r.diagnostic_json,
      resolved: r.resolved,
      createdAtMs: r.created_at_ms
    }));
  }

  public resolveQuarantineEntry(quarantineId: string): void {
    this.conn.run(
      `UPDATE migration_quarantine SET resolved = 1 WHERE quarantine_id = ?`,
      quarantineId
    );
  }

  /**
   * Executes the 7-stage migration pipeline through `retain-source` (stages 1..6).
   * If interrupted at any pre-cutover stage (`prepare-copy`, `import`,
   * `quiesce/reconcile`, `validate`), `authority` remains `'legacy'` and re-invoking
   * `runMigrationThroughRetainSource` resumes idempotently.
   */
  public runMigrationThroughRetainSource(
    input: LegacyWorkspaceSnapshotInput
  ): MigrationPipelineOutcome {
    const maxVersion = input.maxSupportedLegacySchemaVersion ?? SQLITE_SCHEMA_CURRENT_VERSION;
    const allRecords = [...input.runRecords, ...(input.deltaRunRecords ?? [])];
    const legacyDigest = createHash('sha256')
      .update(allRecords.map((r) => `${r.recordKey}:${r.rawJson}`).join('\n'))
      .digest('hex');

    const stagesToRun: readonly MigrationStageName[] = [
      'prepare-copy',
      'import',
      'quiesce/reconcile',
      'validate',
      'publish-authority',
      'retain-source'
    ];

    let importedRuns = 0;
    let quarantinedRecords = 0;

    for (const stage of stagesToRun) {
      this.conn.exec('BEGIN IMMEDIATE');
      try {
        const now = this.nowMs();

        if (input.failAtStage === stage) {
          throw new Error(`MIGRATION_FAILPOINT:${stage}`);
        }

        if (stage === 'prepare-copy') {
          this.conn.run(
            `INSERT INTO cutover_sentinel (
              scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms
            ) VALUES (?, 'legacy', 'prepare-copy', 0, ?, '', ?)
            ON CONFLICT(scope_id) DO UPDATE SET
              stage = CASE WHEN cutover_sentinel.authority IN ('sqlite', 'retired_legacy') THEN cutover_sentinel.stage ELSE 'prepare-copy' END,
              legacy_digest_sha256 = excluded.legacy_digest_sha256,
              updated_at_ms = excluded.updated_at_ms`,
            input.scopeId,
            legacyDigest,
            now
          );
          this.upsertStageLedger(input.migrationId, stage, 'completed', input.runRecords.length, 0, legacyDigest, now);
        } else if (stage === 'import') {
          const res = this.importRecordsBatch(
            input.migrationId,
            input.scopeId,
            input.runRecords,
            maxVersion,
            now
          );
          input.importOperationalDocuments?.(this.conn, now);
          importedRuns += res.imported;
          quarantinedRecords += res.quarantined;
          this.upsertStageLedger(
            input.migrationId,
            stage,
            'completed',
            res.imported,
            res.quarantined,
            legacyDigest,
            now
          );
        } else if (stage === 'quiesce/reconcile') {
          const res = this.importRecordsBatch(
            input.migrationId,
            input.scopeId,
            input.deltaRunRecords ?? [],
            maxVersion,
            now
          );
          importedRuns += res.imported;
          quarantinedRecords += res.quarantined;
          this.upsertStageLedger(
            input.migrationId,
            stage,
            'completed',
            res.imported,
            res.quarantined,
            legacyDigest,
            now
          );
        } else if (stage === 'validate') {
          const fkErrors = this.conn.runForeignKeyCheck();
          if (fkErrors.length > 0) {
            throw new Error(`MIGRATION_VALIDATION_FK_ERROR: ${fkErrors.length} violations`);
          }
          const sqliteRuns = this.conn.all<{ run_id: string; revision: number }>(
            `SELECT run_id, revision FROM runs WHERE workspace_id = ? ORDER BY run_id ASC`,
            input.scopeId
          );
          const sqliteDigest = createHash('sha256')
            .update(sqliteRuns.map((r) => `${r.run_id}:${r.revision}`).join('|'))
            .digest('hex');

          this.conn.run(
            `UPDATE cutover_sentinel SET stage = 'validate', sqlite_digest_sha256 = ?, updated_at_ms = ? WHERE scope_id = ?`,
            sqliteDigest,
            now,
            input.scopeId
          );
          this.upsertStageLedger(
            input.migrationId,
            stage,
            'completed',
            sqliteRuns.length,
            quarantinedRecords,
            sqliteDigest,
            now
          );
        } else if (stage === 'publish-authority') {
          this.conn.run(
            `UPDATE cutover_sentinel SET
               authority = 'sqlite',
               stage = 'publish-authority',
               cutover_epoch = cutover_epoch + 1,
               updated_at_ms = ?
             WHERE scope_id = ?`,
            now,
            input.scopeId
          );
          this.upsertStageLedger(
            input.migrationId,
            stage,
            'completed',
            importedRuns,
            quarantinedRecords,
            legacyDigest,
            now
          );
        } else if (stage === 'retain-source') {
          this.conn.run(
            `UPDATE cutover_sentinel SET stage = 'retain-source', updated_at_ms = ? WHERE scope_id = ?`,
            now,
            input.scopeId
          );
          this.upsertStageLedger(
            input.migrationId,
            stage,
            'completed',
            importedRuns,
            quarantinedRecords,
            legacyDigest,
            now
          );
        }

        this.conn.exec('COMMIT');
      } catch (error) {
        try {
          this.conn.exec('ROLLBACK');
        } catch {
          // Ignore
        }
        const now = this.nowMs();
        this.upsertStageLedger(
          input.migrationId,
          stage,
          'failed',
          importedRuns,
          quarantinedRecords,
          legacyDigest,
          now
        );
        const sentinel = this.authorityGuard.getSentinel(input.scopeId);
        return {
          completed: false,
          authority: sentinel?.authority ?? 'legacy',
          currentStage: stage,
          importedRuns,
          quarantinedRecords,
          failureReason: error instanceof Error ? error.message : String(error)
        };
      }
    }

    const sentinel = this.authorityGuard.getSentinel(input.scopeId);
    const totalImported = Number(
      this.conn.scalar(`SELECT COUNT(*) FROM runs WHERE workspace_id = ?`, input.scopeId) ?? 0
    );
    const totalQuarantined = Number(
      this.conn.scalar(
        `SELECT COUNT(*) FROM migration_quarantine WHERE migration_id = ?`,
        input.migrationId
      ) ?? 0
    );

    return {
      completed: true,
      authority: sentinel?.authority ?? 'sqlite',
      currentStage: 'retain-source',
      importedRuns: totalImported,
      quarantinedRecords: totalQuarantined
    };
  }

  /**
   * Stage 7 (`retire-source`): Permitted only when `authority === 'sqlite'` and
   * zero unresolved quarantine records exist for `migrationId`.
   */
  public retireLegacySource(
    migrationId: string,
    scopeId: string
  ):
    | { readonly retired: true; readonly authority: 'retired_legacy' }
    | { readonly retired: false; readonly reason: string; readonly unresolvedQuarantineCount: number } {
    const unresolvedCount = Number(
      this.conn.scalar(
        `SELECT COUNT(*) FROM migration_quarantine WHERE migration_id = ? AND resolved = 0`,
        migrationId
      ) ?? 0
    );
    const now = this.nowMs();

    if (unresolvedCount > 0) {
      this.upsertStageLedger(
        migrationId,
        'retire-source',
        'blocked',
        0,
        unresolvedCount,
        'blocked-by-quarantine',
        now
      );
      return {
        retired: false,
        reason: `Cannot retire legacy source while ${unresolvedCount} quarantined record(s) remain unresolved`,
        unresolvedQuarantineCount: unresolvedCount
      };
    }

    const sentinel = this.authorityGuard.getSentinel(scopeId);
    if (!sentinel || sentinel.authority !== 'sqlite') {
      return {
        retired: false,
        reason: `Cannot retire legacy source before publish-authority completes (current=${sentinel?.authority ?? 'none'})`,
        unresolvedQuarantineCount: 0
      };
    }

    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `UPDATE cutover_sentinel SET authority = 'retired_legacy', stage = 'retire-source', updated_at_ms = ? WHERE scope_id = ?`,
        now,
        scopeId
      );
      this.upsertStageLedger(
        migrationId,
        'retire-source',
        'completed',
        0,
        0,
        sentinel.sqliteDigestSha256,
        now
      );
      this.conn.exec('COMMIT');
      return { retired: true, authority: 'retired_legacy' };
    } catch (error) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw error;
    }
  }

  private importRecordsBatch(
    migrationId: string,
    scopeId: string,
    records: readonly LegacyRunRecordInput[],
    maxSupportedSchemaVersion: number,
    now: number
  ): { readonly imported: number; readonly quarantined: number } {
    let imported = 0;
    let quarantined = 0;

    for (const rec of records) {
      let parsed: ParsedLegacyRunPayload;
      try {
        parsed = JSON.parse(rec.rawJson) as ParsedLegacyRunPayload;
      } catch (err) {
        quarantined += 1;
        this.insertQuarantine(
          migrationId,
          'workspaceState:schegent.runs',
          rec.recordKey,
          'corrupt_json',
          null,
          rec.rawJson,
          { error: err instanceof Error ? err.message : 'Invalid JSON' },
          now
        );
        continue;
      }

      const version = parsed.schemaVersion ?? 1;
      if (version > maxSupportedSchemaVersion) {
        quarantined += 1;
        this.insertQuarantine(
          migrationId,
          'workspaceState:schegent.runs',
          rec.recordKey,
          'unknown_future_version',
          version,
          rec.rawJson,
          { maxSupportedSchemaVersion, detectedVersion: version },
          now
        );
        continue;
      }

      if (!parsed.runId || !parsed.workflowId) {
        quarantined += 1;
        this.insertQuarantine(
          migrationId,
          'workspaceState:schegent.runs',
          rec.recordKey,
          'schema_violation',
          version,
          rec.rawJson,
          { missingFields: ['runId', 'workflowId'] },
          now
        );
        continue;
      }

      const status = parsed.status ?? 'queued';
      const revision = Math.max(1, parsed.revision ?? 1);
      const createdAtMs = parsed.createdAtMs ?? now;
      const updatedAtMs = parsed.updatedAtMs ?? now;

      this.conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          revision = MAX(runs.revision, excluded.revision),
          updated_at_ms = excluded.updated_at_ms`,
        parsed.runId,
        parsed.workspaceId ?? scopeId,
        parsed.workflowId,
        status,
        revision,
        createdAtMs,
        updatedAtMs
      );

      this.conn.run(
        `INSERT INTO execution_summary_revisions (
          run_id, workspace_id, workflow_id, status, revision, step_count, completed_step_count,
          attempt_count, open_finding_count, total_tokens, total_cost_microdollars, duration_ms, started_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          revision = MAX(execution_summary_revisions.revision, excluded.revision),
          updated_at_ms = excluded.updated_at_ms`,
        parsed.runId,
        parsed.workspaceId ?? scopeId,
        parsed.workflowId,
        status,
        revision,
        updatedAtMs
      );

      imported += 1;
    }

    return { imported, quarantined };
  }

  private insertQuarantine(
    migrationId: string,
    sourceSurface: string,
    sourceRecordKey: string,
    reasonCode: MigrationQuarantineRow['reasonCode'],
    detectedSchemaVersion: number | null,
    rawPayload: string,
    diagnostic: Record<string, unknown>,
    now: number
  ): void {
    const quarantineId = `quar-${migrationId}-${sourceRecordKey}`;
    this.conn.run(
      `INSERT INTO migration_quarantine (
        quarantine_id, migration_id, source_surface, source_record_key, reason_code,
        detected_schema_version, raw_payload, diagnostic_json, resolved, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(quarantine_id) DO UPDATE SET
        reason_code = excluded.reason_code,
        raw_payload = excluded.raw_payload,
        diagnostic_json = excluded.diagnostic_json`,
      quarantineId,
      migrationId,
      sourceSurface,
      sourceRecordKey,
      reasonCode,
      detectedSchemaVersion,
      rawPayload,
      JSON.stringify(diagnostic),
      now
    );
  }

  private upsertStageLedger(
    migrationId: string,
    stage: MigrationStageName,
    status: MigrationStageStatusRow['status'],
    recordsProcessed: number,
    quarantinedCount: number,
    checksumSha256: string,
    now: number
  ): void {
    if (!(MIGRATION_STAGES as readonly string[]).includes(stage)) {
      throw new Error(`Unknown migration stage: ${stage}`);
    }
    this.conn.run(
      `INSERT INTO migration_ledger (
        migration_id, stage, status, records_processed, quarantined_count, checksum_sha256, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(migration_id, stage) DO UPDATE SET
        status = excluded.status,
        records_processed = excluded.records_processed,
        quarantined_count = excluded.quarantined_count,
        checksum_sha256 = excluded.checksum_sha256,
        updated_at_ms = excluded.updated_at_ms`,
      migrationId,
      stage,
      status,
      recordsProcessed,
      quarantinedCount,
      checksumSha256,
      now
    );
  }
}
