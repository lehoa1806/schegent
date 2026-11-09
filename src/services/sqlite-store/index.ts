/**
 * FR-R6-F04 — Unified `SqliteApplicationStore` facade and barrel exports for
 * `F04-A` (SQLite Store Foundation, 7 Atomic Transaction Units, Migration,
 * Online Backup/Restore, Engine Qualification), `F04-B` (Domain Store Adapters
 * for `F05`–`F15`), and `F04-C` (Catalog, Policy, Model Catalog & Frozen
 * Execution Closures).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { StorageLocationRequest } from '../../contracts/sqlite-store/schema-types';
import { BackupRestoreService } from './backup-restore-service';
import { CatalogConfigStoreAdapter } from './catalog-config-store';
import { AgentRuntimeStoreAdapter } from './domain-adapters/agent-runtime-adapter';
import {
  ArtifactStoreAdapter,
  ExecutionWorkspaceStoreAdapter
} from './domain-adapters/artifact-working-state-adapters';
import { HandoffReviewStoreAdapter } from './domain-adapters/handoff-review-adapter';
import {
  ReportingStoreAdapter,
  TelemetryStoreAdapter
} from './domain-adapters/reporting-telemetry-adapters';
import {
  LogIndexStoreAdapter,
  RecoveryStoreAdapter,
  UsageStoreAdapter
} from './domain-adapters/usage-log-recovery-adapters';
import { CutoverAuthorityGuard, MigrationCoordinator } from './migration-coordinator';
import { SchemaBootstrapService } from './schema-bootstrap';
import { BoundedReadConnectionPool, NodeSqliteConnection } from './sqlite-driver';
import { resolveTrustedSqliteLocation } from './storage-location-resolver';
import { AtomicTransactionUnitsService } from './transaction-units';
import { WriterCoordinator } from './writer-coordinator';

export interface SqliteApplicationStoreOptions {
  readonly databasePath: string;
  readonly journalMode?: 'wal' | 'delete' | 'memory' | undefined;
  readonly nowMs?: (() => number) | undefined;
}

export class SqliteApplicationStore {
  public readonly writerConnection: NodeSqliteConnection;
  public readonly readPool: BoundedReadConnectionPool;
  public readonly writerCoordinator: WriterCoordinator;
  public readonly transactions: AtomicTransactionUnitsService;
  public readonly migration: MigrationCoordinator;
  public readonly cutoverGuard: CutoverAuthorityGuard;
  public readonly backupRestore: BackupRestoreService;

  // F04-B Domain Store Adapters
  public readonly artifacts: ArtifactStoreAdapter;
  public readonly usage: UsageStoreAdapter;
  public readonly logIndex: LogIndexStoreAdapter;
  public readonly recovery: RecoveryStoreAdapter;
  public readonly executionWorkspaces: ExecutionWorkspaceStoreAdapter;
  public readonly reporting: ReportingStoreAdapter;
  public readonly agentRuntime: AgentRuntimeStoreAdapter;
  public readonly telemetry: TelemetryStoreAdapter;
  public readonly handoffReview: HandoffReviewStoreAdapter;

  // F04-C Catalog, Model Catalog, Policy & Frozen Closure Store
  public readonly catalogConfig: CatalogConfigStoreAdapter;

  public readonly schemaVersion: number;
  public readonly strictTableCount: number;

  public constructor(options: SqliteApplicationStoreOptions) {
    const nowMs = options.nowMs ?? (() => Date.now());
    this.writerConnection = new NodeSqliteConnection({
      databasePath: options.databasePath,
      journalMode: options.journalMode
    });
    this.readPool = new BoundedReadConnectionPool(options.databasePath);

    try {
      const bootstrap = SchemaBootstrapService.bootstrapAndMigrate(this.writerConnection, nowMs);
      this.schemaVersion = bootstrap.schemaVersion;
      this.strictTableCount = bootstrap.strictTableCount;

      this.writerCoordinator = new WriterCoordinator(this.writerConnection, this.readPool, nowMs);
      this.transactions = new AtomicTransactionUnitsService(
        this.writerConnection,
        this.writerCoordinator,
        nowMs
      );
      this.migration = new MigrationCoordinator(this.writerConnection, nowMs);
      this.cutoverGuard = this.migration.authorityGuard;
      this.backupRestore = new BackupRestoreService(this.writerConnection, nowMs);

      this.artifacts = new ArtifactStoreAdapter(this.writerConnection, nowMs);
      this.usage = new UsageStoreAdapter(this.writerConnection);
      this.logIndex = new LogIndexStoreAdapter(this.writerConnection, nowMs);
      this.recovery = new RecoveryStoreAdapter(this.writerConnection, nowMs);
      this.executionWorkspaces = new ExecutionWorkspaceStoreAdapter(this.writerConnection, nowMs);
      this.reporting = new ReportingStoreAdapter(this.writerConnection, this.readPool, nowMs);
      this.agentRuntime = new AgentRuntimeStoreAdapter(this.writerConnection, nowMs);
      this.telemetry = new TelemetryStoreAdapter(this.writerConnection, nowMs);
      this.handoffReview = new HandoffReviewStoreAdapter(this.writerConnection, nowMs);

      this.catalogConfig = new CatalogConfigStoreAdapter(
        this.writerConnection,
        this.transactions,
        nowMs
      );
    } catch (err) {
      this.readPool.closeAll();
      this.writerConnection.close();
      throw err;
    }
  }

  public static openInMemory(options?: {
    readonly nowMs?: (() => number) | undefined;
  }): SqliteApplicationStore {
    return new SqliteApplicationStore({
      databasePath: ':memory:',
      journalMode: 'memory',
      nowMs: options?.nowMs
    });
  }

  public static async openAtTrustedLocation(
    request: StorageLocationRequest,
    nowMs?: () => number
  ): Promise<SqliteApplicationStore> {
    const resolution = await resolveTrustedSqliteLocation(request);
    if (resolution.status === 'refused') {
      throw new Error(`STORAGE_LOCATION_REFUSED:${resolution.reason}: ${resolution.operatorDiagnostic}`);
    }
    return new SqliteApplicationStore({
      databasePath: resolution.databasePath,
      journalMode: resolution.journalMode,
      nowMs
    });
  }

  public close(): void {
    this.readPool.closeAll();
    this.writerConnection.close();
  }
}

export * from './sqlite-driver';
export * from './storage-location-resolver';
export * from './schema-bootstrap';
export * from './writer-coordinator';
export * from './transaction-units';
export * from './migration-coordinator';
export * from './backup-restore-service';
export * from './catalog-config-store';
export * from './engine-qualification';
export * from './domain-adapters/artifact-working-state-adapters';
export * from './domain-adapters/usage-log-recovery-adapters';
export * from './domain-adapters/reporting-telemetry-adapters';
export * from './domain-adapters/agent-runtime-adapter';
export * from './domain-adapters/handoff-review-adapter';
