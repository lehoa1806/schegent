/**
 * FR-R7-18 (`N03`, `FR-003`, `SC-003`, Contract 3) — Automated disposable-workspace
 * rehearsal of `repo/docs/operations/incident-recovery-guide.md` and
 * `repo/docs/operations/sqlite-rollback-runbook.md`.
 *
 * Exercises all three observed operator symptoms end-to-end with zero real-clock sleeps:
 * 1. Future schema / `min_reader_version` refusal (verbatim diagnostics + zero live DB mutation),
 *    verified schema-8 offline rollback with surviving evidence & resumed writes, and missing
 *    external artifact byte outcomes (lifecycle tombstones pass vs live missing/corrupt bytes
 *    refuse pre-commit with `EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT`).
 * 2. Quarantined Memento writer (GC-04) via a controllable deterministic scheduler asserting
 *    `MEMENTO_WRITE_DEADLINE_MS === 5000`: `storage-write-timeout` -> `storage-write-quarantined`
 *    -> `queue-state-unavailable` -> GC-04 late-settle auto-recovery (`land` & `fail`) +
 *    superseded-token safety, non-destructive window reload, and last-resort reset preserving
 *    `.schegent/audit.log` and raw session transcripts.
 * 3. Stuck execution lane in a real disposable Git repository: `preparing` (`lane-bound-reached`
 *    -> `provisioning-interrupted`), `verifying` (`integration-busy` -> `queued`), `landing`
 *    (`blocked`/`landing-not-applied`, `landed`, `uncertain` with commit triple + `cancelRequest`
 *    `acknowledged-uncertain`), `root-missing`, `containment-refused`, `cleanup-interrupted`,
 *    cleanup keep guards (`lane-pinned`, `lane-dirty`, `worktree-locked`), clean `completeLane` ->
 *    `releaseLane('eligible')` -> `cleanupLanes` preserving `candidate` ref, unowned worktree,
 *    primary checkout, SQLite receipts, and audit chain, plus clean next-lane provisioning.
 * 4. Verbatim diagnostic parity and operator entry-point link assertions against the live docs.
 */

import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAuditChainAt } from '../../src/audit/audit-chain';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import {
  readLaneSnapshotFromService,
  runInspectExecutionLanes,
  runRecoverExecutionLane,
  type LaneRecoveryCommandUi
} from '../../src/commands/execution-lane-recovery';
import { appendResetAuditEvent } from '../../src/commands/reset';
import type { VerificationProfile } from '../../src/contracts/execution-lanes';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { createWorkspaceExternalDependencyInspector } from '../../src/headless/backup-restore-api';
import {
  cleanupLanes as apiCleanupLanes,
  completeLane as apiCompleteLane,
  freezeCandidate as apiFreezeCandidate,
  landRequest as apiLandRequest,
  provisionLane as apiProvisionLane,
  reconcile as apiReconcile,
  releaseLane as apiReleaseLane,
  requestIntegration as apiRequestIntegration,
  verifyRequest as apiVerifyRequest
} from '../../src/headless/execution-lanes-api';
import { SanitizedLogger } from '../../src/lib/logger';
import { narrowMode } from '../../src/lib/narrow-mode';
import { QueueManager } from '../../src/queue/queue-manager';
import {
  classifyEnqueueFailure,
  ENQUEUE_STORAGE_FAULT_TOAST,
  QUEUE_STATE_UNAVAILABLE
} from '../../src/services/enqueue-failure';
import { createExecFileGitRunner, type LaneGitRunner } from '../../src/services/execution-lanes/git-runner';
import { IntegrationStore } from '../../src/services/execution-lanes/integration-store';
import { LaneService, type LaneServiceDeps } from '../../src/services/execution-lanes/lane-service';
import { LaneStore } from '../../src/services/execution-lanes/lane-store';
import { createRunLaneCoordinator } from '../../src/services/execution-lanes/run-lane-binding';
import {
  BackupRestoreService,
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  parseAndValidateBackupManifest,
  relocateLegacySqliteStore,
  SchemaBootstrapService,
  SqliteApplicationStore,
  verifyBackupStandalone,
  verifyBackupStandaloneAsync
} from '../../src/services/sqlite-store';
import { SqliteUnsupportedSchemaError } from '../../src/services/sqlite-store/schema-bootstrap';
import type { Scheduler, SchedulerHandle } from '../../src/state/lock';
import {
  MEMENTO_WRITE_DEADLINE_MS,
  StorageWriteQuarantinedError,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';
import { createFixtureRepo, type FixtureRepo } from '../unit/execution-lanes/fixture-repo';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function createCapturingLogger(): { readonly logger: SanitizedLogger; readonly lines: string[] } {
  const lines: string[] = [];
  const logger = new SanitizedLogger([{ appendLine: (line) => lines.push(line) }]);
  return { logger, lines };
}

class ControllableScheduler implements Scheduler {
  private readonly pending = new Map<number, { readonly fn: () => void; readonly ms: number }>();
  private nextId = 1;
  readonly recordedDelays: number[] = [];

  setInterval(fn: () => void, ms: number): SchedulerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.recordedDelays.push(ms);
    this.pending.set(id, { fn, ms });
    return {
      clear: () => {
        this.pending.delete(id);
      }
    };
  }

  get activeCount(): number {
    return this.pending.size;
  }

  fireNext(): number {
    const first = this.pending.entries().next();
    if (first.done) throw new Error('ControllableScheduler has no pending timer to fire');
    const [, entry] = first.value;
    entry.fn();
    return entry.ms;
  }
}

class ControllableMemento implements Memento {
  readonly data = new Map<string, unknown>();
  hangKey: string | null = null;
  private readonly held: Array<(outcome: 'land' | 'fail') => void> = [];

  settleHeld(outcome: 'land' | 'fail'): boolean {
    const next = this.held.shift();
    if (!next) return false;
    next(outcome);
    return true;
  }

  get heldCount(): number {
    return this.held.length;
  }

  get<T>(key: string): T | undefined {
    if (!this.data.has(key)) return undefined;
    return structuredClone(this.data.get(key)) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.hangKey === key) {
      return new Promise<void>((resolve, reject) => {
        this.held.push((outcome) => {
          if (outcome === 'fail') {
            reject(new Error(`late write failure for ${key}`));
            return;
          }
          if (value === undefined) this.data.delete(key);
          else this.data.set(key, structuredClone(value));
          resolve();
        });
      });
    }
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, structuredClone(value));
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const tempRoots: string[] = [];
const fixtures: FixtureRepo[] = [];
const connections: NodeSqliteConnection[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const conn of connections.splice(0)) {
    try {
      conn.close();
    } catch {
      // Already closed in test body.
    }
  }
  for (const fixture of fixtures.splice(0)) {
    fixture.dispose();
  }
  for (const dir of tempRoots.splice(0)) {
    await removeTempRoot(dir);
  }
});

describe('FR-R7-18 (N03) Operator Incident Recovery Guide Rehearsals', () => {
  describe('Symptom 1: Future schema / min_reader_version refusal, schema-8 rollback & missing external bytes', () => {
    it('rehearses verbatim schema/min_reader refusals with zero live DB mutation, verified schema-8 rollback, surviving evidence, and service resumption', async () => {
      const rootDir = await makeTempDir('schegent-inc-s1-');
      const workspaceRoot = path.join(rootDir, 'workspace');
      const storageRoot = path.join(rootDir, 'global-storage');
      await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });

      const scopeId = 'scope-inc-s1';
      const now = 1_763_950_000_000;
      const liveDir = path.join(storageRoot, 'sqlite', scopeId);
      await fs.mkdir(liveDir, { recursive: true, mode: 0o700 });
      const liveDbPath = path.join(liveDir, 'schegent-state.db');

      // Seed surviving workspace evidence outside SQLite: audit log + raw session transcript.
      const { logger } = createCapturingLogger();
      const auditWriter = new AuditLogWriter({ workspaceRoot }, logger);
      await auditWriter.append({
        runId: 'run-pre-s9',
        phase: 'implement',
        iteration: 1,
        eventType: 'phase-end',
        payload: { outcome: 'completed' },
        outcome: 'success'
      });
      const transcriptDir = path.join(workspaceRoot, '.schegent', 'transcripts');
      await fs.mkdir(transcriptDir, { recursive: true, mode: 0o700 });
      const transcriptPath = path.join(transcriptDir, 'run-pre-s9.log');
      await fs.writeFile(transcriptPath, 'pre-upgrade-transcript-line\n', 'utf8');

      const schema8Migrations = BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8);

      // 1. Bootstrap schema-8 store, seed data, and take verified pre-upgrade backup.
      let backupDatabasePath = '';
      let manifestPath = '';
      const s8Conn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
      try {
        expect(SchemaBootstrapService.bootstrapAndMigrate(s8Conn, () => now, schema8Migrations).schemaVersion).toBe(8);
        s8Conn.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
            current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
          ) VALUES ('run-pre-s9', ?, 'wf-pre', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
          scopeId,
          now,
          now + 1000,
          now,
          now + 1000
        );
        const backupSvc = new BackupRestoreService(s8Conn, () => now);
        const bkp = await backupSvc.createOnlineBackup({
          backupId: 'bkp-pre-s9',
          scopeId,
          trustedRootDir: storageRoot,
          relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
        });
        backupDatabasePath = bkp.backupDatabasePath;
        manifestPath = bkp.manifestPath;
        expect(bkp.manifest.schemaVersion).toBe(8);
      } finally {
        s8Conn.close();
      }

      // 2. Upgrade live DB to schema 9 (min_reader_version = 9) and write post-upgrade state.
      const s9Conn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
      try {
        expect(SchemaBootstrapService.bootstrapAndMigrate(s9Conn, () => now + 60_000).schemaVersion).toBe(9);
        s9Conn.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
            current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
          ) VALUES ('run-post-s9', ?, 'wf-post', NULL, 'succeeded', 1, NULL, ?, ?, 'post', ?, ?)`,
          scopeId,
          now + 60_000,
          now + 61_000,
          now + 60_000,
          now + 61_000
        );
        s9Conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        s9Conn.close();
      }

      const liveShaBeforeRefusal = sha256Hex(await fs.readFile(liveDbPath));

      // 3a. Older schema-8 build refuses fail-closed with verbatim UNSUPPORTED_MIN_READER_VERSION.
      const olderReaderConn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
      try {
        let caught: unknown;
        try {
          SchemaBootstrapService.bootstrapAndMigrate(olderReaderConn, () => now + 120_000, schema8Migrations);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SqliteUnsupportedSchemaError);
        const err = caught as SqliteUnsupportedSchemaError;
        expect(err.code).toBe('UNSUPPORTED_MIN_READER_VERSION');
        expect(err.message).toBe(
          'UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema 9 or later; this build reads up to 8'
        );
      } finally {
        olderReaderConn.close();
      }

      // 3b. Relocation preflight returns refused_newer_schema matching the activation warning toast.
      const relocation = await relocateLegacySqliteStore({
        scopeId,
        globalStorageUri: storageRoot,
        canonicalFilesystemType: 'apfs',
        maxSupportedSchemaVersion: 8,
        verifyPrimacy: async () => true
      });
      expect(relocation.outcome).toBe('refused_newer_schema');
      if (relocation.outcome !== 'refused_newer_schema') throw new Error('expected refused_newer_schema');
      expect(relocation.reason).toBe('UNSUPPORTED_MIN_READER_VERSION');
      const activationToast = `Schegent refused to open or relocate the operational SQLite database (${relocation.reason}). Update Schegent before opening this workspace.`;
      expect(activationToast).toBe(
        'Schegent refused to open or relocate the operational SQLite database (UNSUPPORTED_MIN_READER_VERSION). Update Schegent before opening this workspace.'
      );

      // Zero live DB byte mutation on refusal!
      const liveShaAfterRefusal = sha256Hex(await fs.readFile(liveDbPath));
      expect(liveShaAfterRefusal).toBe(liveShaBeforeRefusal);

      // 3c. Also verify verbatim unreadable floor and UNSUPPORTED_FUTURE_SCHEMA_VERSION diagnostics.
      const unreadableFloorDb = new NodeSqliteConnection({ databasePath: ':memory:' });
      connections.push(unreadableFloorDb);
      SchemaBootstrapService.bootstrapAndMigrate(unreadableFloorDb, () => now);
      unreadableFloorDb.run(
        `UPDATE schema_meta SET meta_value = 'corrupt-floor' WHERE meta_key = 'min_reader_version'`
      );
      expect(() => SchemaBootstrapService.bootstrapAndMigrate(unreadableFloorDb, () => now)).toThrow(
        'UNSUPPORTED_MIN_READER_VERSION: database records an unreadable reader floor'
      );

      const futureSchemaDb = new NodeSqliteConnection({ databasePath: ':memory:' });
      connections.push(futureSchemaDb);
      SchemaBootstrapService.bootstrapAndMigrate(futureSchemaDb, () => now);
      futureSchemaDb.run(`UPDATE schema_meta SET meta_value = '1' WHERE meta_key = 'min_reader_version'`);
      futureSchemaDb.run(`UPDATE schema_meta SET meta_value = '10' WHERE meta_key = 'schema_version'`);
      let futureErr: unknown;
      try {
        SchemaBootstrapService.bootstrapAndMigrate(futureSchemaDb, () => now);
      } catch (err) {
        futureErr = err;
      }
      expect(futureErr).toBeInstanceOf(SqliteUnsupportedSchemaError);
      expect((futureErr as SqliteUnsupportedSchemaError).code).toBe('UNSUPPORTED_FUTURE_SCHEMA_VERSION');
      expect((futureErr as SqliteUnsupportedSchemaError).message).toBe(
        'UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=10 exceeds supported max=9'
      );

      // 4. Execute verified offline schema-8 rollback procedure.
      const manifest = parseAndValidateBackupManifest(await fs.readFile(manifestPath, 'utf8'));
      expect(manifest).not.toBeNull();
      expect(manifest!.schemaVersion).toBe(8);
      const backupBytes = await fs.readFile(backupDatabasePath);
      expect(sha256Hex(backupBytes)).toBe(manifest!.databaseSha256);
      expect(backupBytes.byteLength).toBe(manifest!.databaseBytes);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(fsSync.existsSync(`${backupDatabasePath}${suffix}`)).toBe(false);
      }
      const verified = verifyBackupStandalone({
        backupDatabasePath,
        manifest: manifest!,
        trustedRootDir: storageRoot,
        maxSupportedSchemaVersion: 8
      });
      expect(verified.status).toBe('verified');

      const forensicCopyPath = `${liveDbPath}.failed-v9`;
      await fs.rename(liveDbPath, forensicCopyPath);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        await fs.rm(`${liveDbPath}${suffix}`, { force: true });
      }
      await fs.copyFile(backupDatabasePath, liveDbPath);
      const modeRes = await narrowMode(liveDbPath, 0o600);
      expect(modeRes.outcome === 'narrowed' || modeRes.outcome === 'already-private').toBe(true);
      if (process.platform !== 'win32') {
        expect((await fs.lstat(liveDbPath)).mode & 0o077).toBe(0);
      }

      // 5. Reopen on schema-8 build, verify surviving files, and confirm service resumes cleanly.
      const rolledBackConn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
      try {
        expect(SchemaBootstrapService.bootstrapAndMigrate(rolledBackConn, () => now + 180_000, schema8Migrations).schemaVersion).toBe(8);
        expect(rolledBackConn.runQuickCheck()).toEqual(['ok']);
        expect(rolledBackConn.runForeignKeyCheck()).toEqual([]);
        const runIds = rolledBackConn
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id);
        expect(runIds).toEqual(['run-pre-s9']);

        // Confirm service resumed by writing a fresh post-rollback run cleanly.
        rolledBackConn.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
            current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
          ) VALUES ('run-resumed-s8', ?, 'wf-s8', NULL, 'queued', 1, NULL, ?, NULL, NULL, ?, ?)`,
          scopeId,
          now + 185_000,
          now + 185_000,
          now + 185_000
        );
        expect(rolledBackConn.scalar('SELECT COUNT(*) FROM runs')).toBe(2);
      } finally {
        rolledBackConn.close();
      }

      // Surviving evidence files outside SQLite remain intact and verifiable.
      expect(fsSync.existsSync(forensicCopyPath)).toBe(true);
      expect(await fs.readFile(transcriptPath, 'utf8')).toBe('pre-upgrade-transcript-line\n');
      const chain = verifyAuditChainAt(path.join(workspaceRoot, '.schegent'));
      expect(chain).not.toBeNull();
      expect(chain!.verdict.ok).toBe(true);
    });

    it('rehearses missing external artifact byte outcomes: lifecycle tombstones pass while missing or corrupt live bytes refuse pre-commit with EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT', async () => {
      const rootDir = await makeTempDir('schegent-inc-s1-bytes-');
      const workspaceRoot = path.join(rootDir, 'workspace');
      const storageRoot = path.join(rootDir, 'global-storage');
      await fs.mkdir(path.join(workspaceRoot, '.schegent', 'reports'), { recursive: true, mode: 0o700 });
      await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });

      const scopeId = 'scope-inc-bytes';
      const now = 1_763_960_000_000;
      const store = await SqliteApplicationStore.openAtTrustedLocation({
        trustedRootDir: storageRoot,
        relativeSegments: ['sqlite', scopeId],
        databaseFileName: 'schegent-state.db',
        sourceKind: 'host_global_storage_uri',
        filesystemType: 'apfs'
      });

      const liveRelPath = '.schegent/reports/live-report.txt';
      const liveAbsPath = path.join(workspaceRoot, liveRelPath);
      const liveBytes = Buffer.from('authoritative-live-report-bytes\n', 'utf8');
      await fs.writeFile(liveAbsPath, liveBytes);

      const tombstoneBytes = Buffer.from('already-deleted-bytes\n', 'utf8');
      const insertArtifact = (opts: {
        id: string;
        locId: string;
        relpath: string;
        content: Buffer;
        lifecycle?: 'present' | 'deleted' | 'expired';
        availability?: 'available' | 'evicted';
      }): void => {
        const digest = sha256Hex(opts.content);
        store.writerConnection.run(
          `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
           VALUES (?, ?, ?, 'text/plain', 'report', ?)`,
          opts.id,
          digest,
          opts.content.byteLength,
          now
        );
        store.writerConnection.run(
          `INSERT INTO artifact_locations (location_id, artifact_id, storage_tier, uri_or_relpath, verified_at_ms)
           VALUES (?, ?, 'workspace_file', ?, ?)`,
          opts.locId,
          opts.id,
          opts.relpath,
          now
        );
        if (opts.lifecycle !== undefined) {
          store.writerConnection.run(
            `INSERT INTO artifact_lifecycle (
              artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
              retention_class, store_kind, immutability, digest_algorithm, digest_value,
              generation, extent_bytes, byte_size, availability, producer_identity, display_name,
              created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
            ) VALUES (
              ?, 1, NULL, NULL, 'metadata',
              'generated-reports-handoff-exports', 'report', 'immutable', 'sha256', ?,
              NULL, NULL, ?, ?, 'rehearsal', ?, ?, NULL, NULL, ?
            )`,
            opts.id,
            digest,
            opts.content.byteLength,
            opts.lifecycle,
            `${opts.id}.txt`,
            now,
            now
          );
        }
        if (opts.availability !== undefined) {
          store.writerConnection.run(
            `INSERT INTO artifact_availability (artifact_id, state, last_verified_at_ms, detail_json)
             VALUES (?, ?, ?, '{}')`,
            opts.id,
            opts.availability,
            now
          );
        }
      };

      try {
        // Seed pre-backup run + 3 tombstones (no bytes on disk) + 1 live artifact (present on disk).
        store.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
            current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
          ) VALUES ('run-pre-bkp', ?, 'wf-1', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
          scopeId,
          now,
          now + 500,
          now,
          now + 500
        );
        insertArtifact({
          id: 'art-tombstone-deleted',
          locId: 'loc-del',
          relpath: '.schegent/reports/deleted.txt',
          content: tombstoneBytes,
          lifecycle: 'deleted'
        });
        insertArtifact({
          id: 'art-tombstone-expired',
          locId: 'loc-exp',
          relpath: '.schegent/reports/expired.txt',
          content: tombstoneBytes,
          lifecycle: 'expired'
        });
        insertArtifact({
          id: 'art-tombstone-evicted',
          locId: 'loc-evi',
          relpath: '.schegent/reports/evicted.txt',
          content: tombstoneBytes,
          availability: 'evicted'
        });
        insertArtifact({
          id: 'art-live-present',
          locId: 'loc-live',
          relpath: liveRelPath,
          content: liveBytes,
          lifecycle: 'present'
        });

        const svc = new BackupRestoreService(store.writerConnection, () => now);
        const created = await svc.createOnlineBackup({
          backupId: 'bkp-ext-bytes',
          scopeId,
          trustedRootDir: storageRoot,
          relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
        });

        // Only the live artifact is required on disk; the 3 tombstones are excluded.
        expect(created.manifest.externalDependencies.map((d) => d.referenceId)).toEqual(['art-live-present']);

        const inspector = createWorkspaceExternalDependencyInspector(workspaceRoot);
        const verifiedOk = await verifyBackupStandaloneAsync({
          backupDatabasePath: created.backupDatabasePath,
          manifest: created.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(verifiedOk.status).toBe('verified');

        // Mutate live DB after backup so we can verify pre-commit refusal leaves target untouched.
        store.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
            current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
          ) VALUES ('run-post-bkp', ?, 'wf-2', NULL, 'succeeded', 1, NULL, ?, ?, 'later', ?, ?)`,
          scopeId,
          now + 2000,
          now + 2500,
          now + 2000,
          now + 2500
        );

        // 1. Missing live external bytes refuse both verify and restore pre-commit.
        await fs.unlink(liveAbsPath);
        const verifyMissing = await verifyBackupStandaloneAsync({
          backupDatabasePath: created.backupDatabasePath,
          manifest: created.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(verifyMissing).toMatchObject({
          status: 'rejected',
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
        });

        const restoreMissing = await svc.validateAndRestoreBackupAsync({
          backupDatabasePath: created.backupDatabasePath,
          manifest: created.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(restoreMissing).toMatchObject({
          status: 'rejected',
          outcome: 'refused_pre_commit',
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
        });
        // Target live DB untouched!
        expect(
          store.writerConnection
            .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
            .map((r) => r.run_id)
        ).toEqual(['run-post-bkp', 'run-pre-bkp']);

        // 2. Corrupt live external bytes also refuse pre-commit.
        await fs.writeFile(liveAbsPath, Buffer.from('corrupted-live-bytes\n', 'utf8'));
        const restoreCorrupt = await svc.validateAndRestoreBackupAsync({
          backupDatabasePath: created.backupDatabasePath,
          manifest: created.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(restoreCorrupt).toMatchObject({
          status: 'rejected',
          outcome: 'refused_pre_commit',
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
        });

        // 3. Restoring the live bytes allows online restore to succeed, preserving all tombstones!
        await fs.writeFile(liveAbsPath, liveBytes);
        const restored = await svc.validateAndRestoreBackupAsync({
          backupDatabasePath: created.backupDatabasePath,
          manifest: created.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(restored.status).toBe('restored');
        expect(
          store.writerConnection
            .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
            .map((r) => r.run_id)
        ).toEqual(['run-pre-bkp']);
        expect(
          store.writerConnection
            .all<{ artifact_id: string }>(`SELECT artifact_id FROM artifacts ORDER BY artifact_id ASC`)
            .map((r) => r.artifact_id)
        ).toEqual([
          'art-live-present',
          'art-tombstone-deleted',
          'art-tombstone-evicted',
          'art-tombstone-expired'
        ]);
      } finally {
        store.close();
      }
    });
  });

  describe('Symptom 2: Quarantined Memento writer (GC-04), reload & reset fallback', () => {
    it.each(['land', 'fail'] as const)(
      'rehearses timeout -> quarantine -> GC-04 late-settle auto-lift (%s) and superseded-token safety with zero real sleeps',
      async (lateOutcome) => {
        const scheduler = new ControllableScheduler();
        const memento = new ControllableMemento();
        const { logger, lines } = createCapturingLogger();
        const store = new WorkspaceStateStore(memento, logger, scheduler);
        await store.initialize();
        const qm = new QueueManager(store, logger);

        // Trigger a hung write and advance the controllable deadline synchronously.
        memento.hangKey = 'schegent.queue';
        const firstWrite = qm.enqueue('Task whose write hangs');
        await flushMicrotasks();
        expect(scheduler.activeCount).toBe(1);
        const firedMs = scheduler.fireNext();
        expect(firedMs).toBe(MEMENTO_WRITE_DEADLINE_MS);
        expect(MEMENTO_WRITE_DEADLINE_MS).toBe(5_000);

        await expect(firstWrite).rejects.toSatisfy(
          (err: unknown) => err instanceof StorageWriteQuarantinedError && err.reason === 'storage-write-timeout'
        );
        expect(store.isWriterQuarantined()).toBe(true);
        expect(lines.some((l) => l.includes('workspace state write timed out; quarantining state writer'))).toBe(true);

        // Subsequent writes fail fast with storage-write-quarantined and classify as queue-state-unavailable.
        memento.hangKey = null;
        let quarantinedErr: unknown;
        try {
          await qm.enqueue('Rejected while quarantined');
        } catch (err) {
          quarantinedErr = err;
        }
        expect(quarantinedErr).toBeInstanceOf(StorageWriteQuarantinedError);
        expect((quarantinedErr as StorageWriteQuarantinedError).reason).toBe('storage-write-quarantined');
        expect(scheduler.activeCount).toBe(0);
        expect(classifyEnqueueFailure(quarantinedErr)).toEqual({
          outcome: 'failed-storage',
          reason: QUEUE_STATE_UNAVAILABLE
        });
        expect(ENQUEUE_STORAGE_FAULT_TOAST).toBe(
          'Schegent: the queue could not be read or saved. Check the queue before trying again.'
        );

        // GC-04 Step 1: hung write settles late -> auto-lifts quarantine non-destructively!
        expect(memento.settleHeld(lateOutcome)).toBe(true);
        await flushMicrotasks();
        expect(store.isWriterQuarantined()).toBe(false);
        expect(
          lines.some((l) => l.includes('workspace state write settled after its deadline; state writer resumed'))
        ).toBe(true);

        // Service resumed: subsequent enqueue persists cleanly.
        await qm.enqueue('Task after GC-04 auto-recovery');
        expect(store.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.description)).toContain(
          'Task after GC-04 auto-recovery'
        );

        // Superseded-token safety: late settle from quarantine #1 must NOT lift quarantine #2.
        memento.hangKey = 'schegent.queue';
        const hungOne = qm.enqueue('Hung 1');
        await flushMicrotasks();
        scheduler.fireNext();
        await expect(hungOne).rejects.toMatchObject({ reason: 'storage-write-timeout' });
        expect(store.isWriterQuarantined()).toBe(true);

        // Lift quarantine #1 via reset, then induce quarantine #2.
        memento.hangKey = null;
        await store.reset();
        expect(store.isWriterQuarantined()).toBe(false);

        memento.hangKey = 'schegent.queue';
        const hungTwo = qm.enqueue('Hung 2');
        await flushMicrotasks();
        scheduler.fireNext();
        await expect(hungTwo).rejects.toMatchObject({ reason: 'storage-write-timeout' });
        expect(store.isWriterQuarantined()).toBe(true);
        expect(memento.heldCount).toBe(2);

        // Settle write #1 (stale token) -> quarantine #2 MUST remain active!
        expect(memento.settleHeld('land')).toBe(true);
        await flushMicrotasks();
        expect(store.isWriterQuarantined()).toBe(true);

        // Settle write #2 (active token) -> quarantine #2 lifts cleanly.
        expect(memento.settleHeld('land')).toBe(true);
        await flushMicrotasks();
        expect(store.isWriterQuarantined()).toBe(false);
      }
    );

    it('rehearses Step 2 non-destructive reload and Step 3 last-resort reset preserving audit log and transcripts', async () => {
      const workspaceRoot = await makeTempDir('schegent-inc-s2-');
      const { logger } = createCapturingLogger();
      const auditWriter = new AuditLogWriter({ workspaceRoot }, logger);
      await auditWriter.append({
        runId: 'run-before-quarantine',
        phase: 'plan',
        iteration: 1,
        eventType: 'phase-end',
        payload: { outcome: 'completed' },
        outcome: 'success'
      });
      const transcriptDir = path.join(workspaceRoot, '.schegent', 'transcripts');
      await fs.mkdir(transcriptDir, { recursive: true, mode: 0o700 });
      const transcriptPath = path.join(transcriptDir, 'run-before-quarantine.log');
      await fs.writeFile(transcriptPath, 'raw-transcript-survives-reset\n', 'utf8');

      // Seed durable operational state before the hang.
      const backing = new ControllableMemento();
      const schedulerA = new ControllableScheduler();
      const storeA = new WorkspaceStateStore(backing, logger, schedulerA);
      await storeA.initialize();
      const qmA = new QueueManager(storeA, logger);
      await qmA.enqueue('Pre-existing durable task');

      // Permanently wedge storeA's writer (hung write never settles).
      backing.hangKey = 'schegent.queue';
      const wedgedWrite = qmA.enqueue('Wedged forever');
      await flushMicrotasks();
      schedulerA.fireNext();
      await expect(wedgedWrite).rejects.toMatchObject({ reason: 'storage-write-timeout' });
      expect(storeA.isWriterQuarantined()).toBe(true);

      // Step 2: Reload Window -> fresh WorkspaceStateStore over same backing recovers non-destructively.
      backing.hangKey = null;
      const storeReloaded = new WorkspaceStateStore(backing, logger, new ControllableScheduler());
      await storeReloaded.initialize();
      const qmReloaded = new QueueManager(storeReloaded, logger);
      expect(storeReloaded.isWriterQuarantined()).toBe(false);
      expect(storeReloaded.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.description)).toEqual([
        'Pre-existing durable task'
      ]);
      await qmReloaded.enqueue('Added after non-destructive reload');
      expect(storeReloaded.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.description)).toEqual([
        'Pre-existing durable task',
        'Added after non-destructive reload'
      ]);

      // Step 3: Last-resort reset clears operational state, lifts quarantine, records workspace-state-reset,
      // preserves .schegent/audit.log + raw transcripts, and restores queue mutations.
      const generation = await storeA.reset();
      expect(generation).toBeGreaterThanOrEqual(1);
      expect(storeA.isWriterQuarantined()).toBe(false);
      expect(storeA.getQueue(DEFAULT_QUEUE_ID).requests).toEqual([]);

      await appendResetAuditEvent(auditWriter, logger, {
        outcome: 'completed',
        phaseReached: 'reload',
        generation,
        refusalReason: null,
        canceledRunCount: 0
      });

      // Verify surviving evidence & audit chain integrity.
      expect(await fs.readFile(transcriptPath, 'utf8')).toBe('raw-transcript-survives-reset\n');
      const auditText = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      expect(auditText).toContain('"eventType":"workspace-state-reset"');
      const chain = verifyAuditChainAt(path.join(workspaceRoot, '.schegent'));
      expect(chain).not.toBeNull();
      expect(chain!.verdict.ok).toBe(true);

      // Verify service resumed after reset.
      await qmA.enqueue('Fresh task after reset');
      expect(storeA.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.description)).toEqual([
        'Fresh task after reset'
      ]);
    });
  });

  describe('Symptom 3: Stuck execution lane reconciliation, recovery, surviving files & resumption', () => {
    const PROFILE: VerificationProfile = {
      profileId: 'incident-check',
      revision: 1,
      checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
    };

    function openLaneFixture(options: {
      readonly label: string;
      readonly liveLaneCap?: number;
      readonly wrapGit?: (real: LaneGitRunner) => LaneGitRunner;
    }) {
      const fixture = createFixtureRepo(options.label);
      fixtures.push(fixture);
      fixture.write('src/app.txt', 'v1\n');
      fixture.commit('seed app');

      const storageDir = fixture.sibling('storage');
      const isolatedHome = fixture.sibling('home');
      const dbPath = path.join(storageDir, 'sqlite', 'ws-inc', 'schegent-state.db');
      fsSync.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      const conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
      connections.push(conn);
      const nowMs = Date.UTC(2026, 10, 24, 12, 0, 0);
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => nowMs);

      const gitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        GIT_CEILING_DIRECTORIES: path.dirname(fixture.root),
        GIT_CONFIG_NOSYSTEM: '1'
      };
      const realGit = createExecFileGitRunner({ baseEnv: gitEnv });
      let counter = 0;
      const baseDeps: LaneServiceDeps = {
        connection: conn,
        workspaceRoot: fixture.root,
        storageDir,
        workspaceId: 'ws-inc',
        liveLaneCap: options.liveLaneCap ?? 4,
        git: options.wrapGit ? options.wrapGit(realGit) : realGit,
        clock: () => nowMs,
        random: (size) => {
          counter += 1;
          const buf = Buffer.alloc(size);
          if (size >= 4) buf.writeUInt32BE(counter, size - 4);
          else buf.writeUIntBE(counter & ((1 << (size * 8)) - 1), 0, size);
          return buf;
        },
        authorizeApproval: () => true
      };

      const service = LaneService.open(baseDeps);
      const reopen = (overrides: Partial<LaneServiceDeps> = {}): LaneService =>
        LaneService.open({ ...baseDeps, git: realGit, ...overrides });

      return {
        fixture,
        storageDir,
        conn,
        realGit,
        service,
        reopen,
        lanes: new LaneStore(conn),
        integrations: new IntegrationStore(conn)
      };
    }

    it('rehearses stuck preparing (lane-bound-reached -> provisioning-interrupted) and verifying (integration-busy -> queued) recovery', async () => {
      let releasePark = (): void => undefined;
      let signalParked = (): void => undefined;
      const parked = new Promise<void>((resolve) => {
        signalParked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releasePark = resolve;
      });
      let parkNextAdd = true;

      const h = openLaneFixture({
        label: 'inc-prep-verify',
        liveLaneCap: 1,
        wrapGit: (real) => ({
          run: async (args, opts) => {
            if (parkNextAdd && args.at(0) === 'worktree' && args.at(1) === 'add') {
              parkNextAdd = false;
              signalParked();
              await released;
            }
            return real.run(args, opts);
          }
        })
      });

      // Add an unowned external worktree outside Schegent to verify it is counted & untouched.
      const unownedWorktree = path.join(h.fixture.sibling('unowned'), 'operator-tree');
      h.fixture.git(['worktree', 'add', '--detach', unownedWorktree, 'HEAD']);

      // 1. Stuck `preparing` lane fills liveLaneCap=1 -> new provision refuses `lane-bound-reached`.
      const stalledProvision = apiProvisionLane(h.service, {
        rootExecutionId: 'exec-stuck-prep',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      }).catch(() => undefined);
      await parked;

      const capRefusal = await apiProvisionLane(h.service, {
        rootExecutionId: 'exec-blocked-by-cap',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      expect(capRefusal).toEqual({ ok: false, refusal: { reason: 'lane-bound-reached' } });

      // Reload / successor primary host reconciles -> moves preparing lane to preparation-failed (provisioning-interrupted).
      const host2 = h.reopen({ liveLaneCap: 1 });
      const recPrep = await apiReconcile(host2);
      releasePark();
      await stalledProvision;

      expect(recPrep.ok).toBe(true);
      if (!recPrep.ok) throw new Error('expected reconcile ok');
      expect(recPrep.value.unknownWorktrees).toBe(1);
      expect(recPrep.value.lanes).toHaveLength(1);
      const prepLaneId = recPrep.value.lanes[0]!.laneId;
      expect(recPrep.value.lanes[0]).toEqual({
        laneId: prepLaneId,
        from: 'preparing',
        to: 'preparation-failed',
        observation: null
      });
      expect(h.lanes.getLane('ws-inc', prepLaneId)?.stateReason).toBe('provisioning-interrupted');

      // Release & clean up the preparation-failed lane cleanly.
      expect(apiReleaseLane(host2, { laneId: prepLaneId, disposition: 'eligible' }).ok).toBe(true);
      const cleanedPrep = await apiCleanupLanes(host2, { laneIds: [prepLaneId] });
      expect(cleanedPrep).toEqual({ ok: true, value: { removed: [prepLaneId], kept: [] } });
      expect(h.lanes.getLane('ws-inc', prepLaneId)?.state).toBe('removed');

      // 2. Cap is now free -> provision a fresh lane, freeze, queue, and simulate stuck `verifying`.
      const activeLane = await apiProvisionLane(host2, {
        rootExecutionId: 'exec-verify',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      expect(activeLane.ok).toBe(true);
      if (!activeLane.ok) throw new Error('expected fresh lane');
      const laneRecord = h.lanes.getLane('ws-inc', activeLane.value.laneId)!;
      const laneRoot = (await host2.resolveLaneRoot(laneRecord.rootRef))!;
      fsSync.writeFileSync(path.join(laneRoot, 'src', 'app.txt'), 'v2-from-lane\n');
      expect((await apiFreezeCandidate(host2, { laneId: activeLane.value.laneId })).ok).toBe(true);

      const req1 = await apiRequestIntegration(host2, {
        laneId: activeLane.value.laneId,
        targetBranch: 'main',
        profile: PROFILE
      });
      expect(req1.ok).toBe(true);
      if (!req1.ok) throw new Error('expected req1');
      const req2 = await apiRequestIntegration(host2, {
        laneId: activeLane.value.laneId,
        targetBranch: 'main',
        profile: PROFILE
      });
      expect(req2.ok).toBe(true);
      if (!req2.ok) throw new Error('expected req2');

      // Simulate crash while req1 is `verifying` -> req2 refuses `integration-busy`.
      expect(
        h.integrations.transitionRequest('ws-inc', req1.value.requestId, ['queued'], 'verifying', {
          reason: null,
          now: new Date(Date.UTC(2026, 10, 24, 12, 1, 0)).toISOString(),
          generation: host2.generation
        }).ok
      ).toBe(true);
      const busyVerify = await apiVerifyRequest(host2, { requestId: req2.value.requestId });
      expect(busyVerify).toEqual({ ok: false, refusal: { reason: 'integration-busy' } });

      // Successor host reconciles -> req1 returns to `queued`, unblocking verification!
      const host3 = h.reopen({ liveLaneCap: 1 });
      const recVerify = await apiReconcile(host3);
      expect(recVerify).toEqual({
        ok: true,
        value: {
          lanes: [],
          requests: [{ requestId: req1.value.requestId, from: 'verifying', to: 'queued', reason: null }],
          unknownWorktrees: 1
        }
      });

      const verifiedNow = await apiVerifyRequest(host3, { requestId: req1.value.requestId });
      expect(verifiedNow.ok && verifiedNow.value.state).toBe('awaiting-review');
      expect(fsSync.existsSync(path.join(unownedWorktree, 'src', 'app.txt'))).toBe(true);
    });

    it('rehearses stuck landing (blocked/landed/uncertain), root-missing, containment-refused, cleanup-interrupted, cleanup guards, surviving candidate ref, and next-lane resumption', async () => {
      let crashOnLanding: 'off' | 'before' | 'after' = 'off';
      let afterLandingHook: () => void = () => undefined;

      const h = openLaneFixture({
        label: 'inc-land-cleanup',
        liveLaneCap: 8,
        wrapGit: (real) => ({
          run: async (args, opts) => {
            const isLanding =
              args.includes('--ff-only') ||
              (args.at(0) === 'update-ref' && (args.at(1) ?? '').startsWith('refs/heads/'));
            if (crashOnLanding !== 'off' && isLanding) {
              const mode = crashOnLanding;
              crashOnLanding = 'off';
              if (mode === 'after') {
                await real.run(args, opts);
                afterLandingHook();
              }
              throw new Error('simulated crash mid-landing');
            }
            return real.run(args, opts);
          }
        })
      });

      // Seed audit log in the primary workspace to verify it survives all lane recovery & cleanup.
      const { logger } = createCapturingLogger();
      const auditWriter = new AuditLogWriter({ workspaceRoot: h.fixture.root }, logger);
      await auditWriter.append({
        runId: 'run-lane-incident',
        phase: 'implement',
        iteration: 1,
        eventType: 'phase-end',
        payload: { outcome: 'completed' },
        outcome: 'success'
      });

      // Create an unowned worktree outside Schegent.
      const unownedWorktree = path.join(h.fixture.sibling('unowned'), 'keep-me');
      h.fixture.git(['worktree', 'add', '--detach', unownedWorktree, 'HEAD']);

      let activeHost = h.service;
      const crashWrap = (real: LaneGitRunner): LaneGitRunner => ({
        run: async (args, opts) => {
          const isLanding =
            args.includes('--ff-only') ||
            (args.at(0) === 'update-ref' && (args.at(1) ?? '').startsWith('refs/heads/'));
          if (crashOnLanding !== 'off' && isLanding) {
            const mode = crashOnLanding;
            crashOnLanding = 'off';
            if (mode === 'after') {
              await real.run(args, opts);
              afterLandingHook();
            }
            throw new Error('simulated crash mid-landing');
          }
          return real.run(args, opts);
        }
      });

      const prepareApproved = async (host: LaneService, branch: string, editContent: string) => {
        const laneRes = await apiProvisionLane(host, {
          rootExecutionId: `exec-${branch}`,
          sourceRevision: 'HEAD',
          dependencyRecipe: 'none'
        });
        if (!laneRes.ok) throw new Error(`provision failed: ${laneRes.refusal.reason}`);
        const lane = laneRes.value;
        const rec = h.lanes.getLane('ws-inc', lane.laneId)!;
        const root = (await host.resolveLaneRoot(rec.rootRef))!;
        fsSync.writeFileSync(path.join(root, 'src', 'app.txt'), editContent);
        const frozen = await apiFreezeCandidate(host, { laneId: lane.laneId });
        if (!frozen.ok) throw new Error(`freeze failed: ${frozen.refusal.reason}`);
        const reqRes = await apiRequestIntegration(host, {
          laneId: lane.laneId,
          targetBranch: branch,
          profile: PROFILE
        });
        if (!reqRes.ok) throw new Error(`request failed: ${reqRes.refusal.reason}`);
        const verRes = await apiVerifyRequest(host, { requestId: reqRes.value.requestId });
        if (!verRes.ok) throw new Error(`verify failed: ${verRes.refusal.reason}`);
        const approved = host.approveRequest({
          requestId: verRes.value.requestId,
          candidateCommit: verRes.value.candidateCommit,
          targetCommit: verRes.value.expectedTargetCommit,
          profileRevision: verRes.value.profile.revision,
          profileDigest: verRes.value.profile.digest
        });
        if (!approved.ok) throw new Error(`approve failed: ${approved.refusal.reason}`);
        return { lane, root, request: verRes.value };
      };

      // 1. Interrupted landing -> blocked (landing-not-applied) when target unchanged.
      h.fixture.git(['branch', 'target-blocked']);
      const blockedCase = await prepareApproved(activeHost, 'target-blocked', 'blocked-edit\n');
      crashOnLanding = 'before';
      await expect(apiLandRequest(activeHost, { requestId: blockedCase.request.requestId })).rejects.toThrow(
        'simulated crash mid-landing'
      );
      activeHost = h.reopen({ liveLaneCap: 8, git: crashWrap(h.realGit) });
      const recBlocked = await apiReconcile(activeHost);
      expect(recBlocked).toEqual({
        ok: true,
        value: {
          lanes: [],
          requests: [
            {
              requestId: blockedCase.request.requestId,
              from: 'landing',
              to: 'blocked',
              reason: 'landing-not-applied',
              commits: {
                expected: blockedCase.request.expectedTargetCommit,
                candidate: blockedCase.request.candidateCommit,
                observed: blockedCase.request.expectedTargetCommit
              }
            }
          ],
          unknownWorktrees: 1
        }
      });

      // 2. Interrupted landing -> landed when target already moved to candidate.
      h.fixture.git(['branch', 'target-landed']);
      const landedCase = await prepareApproved(activeHost, 'target-landed', 'landed-edit\n');
      crashOnLanding = 'after';
      afterLandingHook = () => undefined;
      await expect(apiLandRequest(activeHost, { requestId: landedCase.request.requestId })).rejects.toThrow(
        'simulated crash mid-landing'
      );
      activeHost = h.reopen({ liveLaneCap: 8, git: crashWrap(h.realGit) });
      const recLanded = await apiReconcile(activeHost);
      expect(recLanded).toEqual({
        ok: true,
        value: {
          lanes: [],
          requests: [
            {
              requestId: landedCase.request.requestId,
              from: 'landing',
              to: 'landed',
              reason: null
            }
          ],
          unknownWorktrees: 1
        }
      });

      // 3. Interrupted landing -> uncertain with commit triple when target diverged to an unrelated commit.
      h.fixture.git(['branch', 'target-uncertain']);
      const uncertainCase = await prepareApproved(activeHost, 'target-uncertain', 'uncertain-edit\n');
      crashOnLanding = 'before';
      await expect(apiLandRequest(activeHost, { requestId: uncertainCase.request.requestId })).rejects.toThrow(
        'simulated crash mid-landing'
      );
      const orphanCommit = h.fixture
        .git(['commit-tree', `${uncertainCase.request.expectedTargetCommit}^{tree}`, '-m', 'diverged-orphan'])
        .trim();
      h.fixture.git(['update-ref', 'refs/heads/target-uncertain', orphanCommit]);

      // 4. Missing root (`root-missing`) & escaping symlink (`containment-refused`).
      const missingRootLane = await apiProvisionLane(activeHost, {
        rootExecutionId: 'exec-missing-root',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      if (!missingRootLane.ok) throw new Error('missingRootLane provision failed');
      const missingRootPath = (await activeHost.resolveLaneRoot(
        h.lanes.getLane('ws-inc', missingRootLane.value.laneId)!.rootRef
      ))!;
      fsSync.rmSync(missingRootPath, { recursive: true, force: true });

      const symlinkLane = await apiProvisionLane(activeHost, {
        rootExecutionId: 'exec-symlink',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      if (!symlinkLane.ok) throw new Error('symlinkLane provision failed');
      const symlinkRootPath = (await activeHost.resolveLaneRoot(
        h.lanes.getLane('ws-inc', symlinkLane.value.laneId)!.rootRef
      ))!;
      const outsideTarget = path.join(h.fixture.sibling('outside'), 'escaped');
      fsSync.renameSync(symlinkRootPath, outsideTarget);
      fsSync.symlinkSync(outsideTarget, symlinkRootPath);

      // 5. Interrupted pending cleanup with worktree still present -> `cleanup-interrupted` preserving work.
      const interruptedCleanupLane = await apiProvisionLane(activeHost, {
        rootExecutionId: 'exec-cleanup-interrupted',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      if (!interruptedCleanupLane.ok) throw new Error('interruptedCleanupLane failed');
      expect(apiCompleteLane(activeHost, { laneId: interruptedCleanupLane.value.laneId }).ok).toBe(true);
      expect(
        apiReleaseLane(activeHost, { laneId: interruptedCleanupLane.value.laneId, disposition: 'eligible' }).ok
      ).toBe(true);
      const cleanupOpId = 'a'.repeat(32);
      h.lanes.beginOperation({
        operationId: cleanupOpId,
        laneId: interruptedCleanupLane.value.laneId,
        workspaceId: 'ws-inc',
        kind: 'cleanup',
        generation: activeHost.generation,
        now: new Date(Date.UTC(2026, 10, 24, 12, 2, 0)).toISOString()
      });

      // Reopen as primary host (simulating reload) and run installed-editor recovery `reconcile`.
      const host2 = h.reopen({ liveLaneCap: 8 });
      const openedReports: string[] = [];
      const capturedModals: { summary: string; detail: string; confirmLabel: string }[] = [];
      const commandLogger = { info: () => undefined, warn: () => undefined };
      const createApprovingUi = (): LaneRecoveryCommandUi => ({
        pickItem: async () => undefined,
        confirmModal: async (summary, detail, confirmLabel) => {
          capturedModals.push({ summary, detail, confirmLabel });
          return true;
        },
        openMarkdownReport: async (markdown) => {
          openedReports.push(markdown);
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      });

      const recCmd = await runRecoverExecutionLane(
        { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
        { action: 'reconcile' }
      );
      expect(recCmd.status).toBe('completed');
      if (recCmd.status !== 'completed' || recCmd.reconcileReport === undefined) {
        throw new Error('reconcile command failed');
      }
      const rec = { ok: true as const, value: recCmd.reconcileReport };

      expect(rec.value.unknownWorktrees).toBe(1);
      expect(rec.value.requests).toEqual([
        {
          requestId: uncertainCase.request.requestId,
          from: 'landing',
          to: 'uncertain',
          reason: null,
          commits: {
            expected: uncertainCase.request.expectedTargetCommit,
            candidate: uncertainCase.request.candidateCommit,
            observed: orphanCommit
          }
        }
      ]);
      expect(rec.value.lanes).toEqual(
        expect.arrayContaining([
          { laneId: missingRootLane.value.laneId, from: 'active', to: 'active', observation: 'root-missing' },
          { laneId: symlinkLane.value.laneId, from: 'active', to: 'active', observation: 'containment-refused' }
        ])
      );
      // Missing root was preserved without recreating or deleting record.
      expect(fsSync.existsSync(missingRootPath)).toBe(false);
      expect(h.lanes.getLane('ws-inc', missingRootLane.value.laneId)?.state).toBe('active');
      // Pending cleanup with existing worktree ended `cleanup-interrupted` and kept lane in `cleanup-eligible`.
      expect(h.lanes.getOperation(cleanupOpId)).toMatchObject({ status: 'failed', reason: 'cleanup-interrupted' });
      expect(h.lanes.getLane('ws-inc', interruptedCleanupLane.value.laneId)?.state).toBe('cleanup-eligible');
      // Journal on `uncertain` holds expectedCommit, candidateCommit, observedTip.
      expect(h.integrations.listJournal(uncertainCase.request.requestId).at(-1)).toMatchObject({
        kind: 'reconcile',
        expectedCommit: uncertainCase.request.expectedTargetCommit,
        candidateCommit: uncertainCase.request.candidateCommit,
        observedTip: orphanCommit,
        outcome: 'uncertain'
      });

      // Step 1: Inspect lanes via `Schegent: Inspect Execution Lanes` (read-only Markdown report).
      const inspected = await runInspectExecutionLanes({
        isWorkspaceTrusted: () => true,
        readSnapshot: ({ allowLiveGit }) => readLaneSnapshotFromService(host2, { allowLiveGit }),
        ui: createApprovingUi(),
        logger: commandLogger
      });
      expect(inspected.status).toBe('opened');
      expect(openedReports[0]).toContain(uncertainCase.request.requestId);
      expect(openedReports[0]).toContain(orphanCommit.slice(0, 12));
      expect(openedReports[0]).not.toContain(h.fixture.root);
      expect(openedReports[0]).not.toContain(h.storageDir);

      // Step 4: Settle `uncertain` and `blocked` requests via installed-editor `Schegent: Recover Execution Lane`.
      capturedModals.length = 0;
      const ackUncertain = await runRecoverExecutionLane(
        { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
        { action: 'acknowledge-uncertain', requestId: uncertainCase.request.requestId }
      );
      expect(ackUncertain.status).toBe('completed');
      expect(ackUncertain.status === 'completed' && ackUncertain.request?.state).toBe('canceled');
      expect(capturedModals[0]?.detail).toContain(orphanCommit.slice(0, 12));
      expect(h.fixture.git(['rev-parse', 'refs/heads/target-uncertain']).trim()).toBe(orphanCommit);
      expect(h.integrations.listJournal(uncertainCase.request.requestId).at(-1)).toMatchObject({
        kind: 'cancel',
        outcome: 'canceled',
        reason: 'acknowledged-uncertain'
      });

      const canceledBlocked = await runRecoverExecutionLane(
        { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
        { action: 'cancel-request', requestId: blockedCase.request.requestId }
      );
      expect(canceledBlocked.status).toBe('completed');

      // Step 5: Exercise installed-editor retain/pin, cleanup-eligible, and cleanup keep guards.
      expect(
        (
          await runRecoverExecutionLane(
            { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
            { action: 'complete-and-retain', laneId: blockedCase.lane.laneId, pin: true }
          )
        ).status
      ).toBe('completed');
      expect(
        (
          await runRecoverExecutionLane(
            { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
            { action: 'mark-cleanup-eligible', laneId: blockedCase.lane.laneId }
          )
        ).status
      ).toBe('completed');

      expect(
        (
          await runRecoverExecutionLane(
            { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
            { action: 'complete-and-retain', laneId: uncertainCase.lane.laneId }
          )
        ).status
      ).toBe('completed');
      expect(
        (
          await runRecoverExecutionLane(
            { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
            { action: 'mark-cleanup-eligible', laneId: uncertainCase.lane.laneId }
          )
        ).status
      ).toBe('completed');
      fsSync.writeFileSync(path.join(uncertainCase.root, 'dirty-untracked.txt'), 'keep-me\n');

      const lockedLaneRoot = (await host2.resolveLaneRoot(
        h.lanes.getLane('ws-inc', interruptedCleanupLane.value.laneId)!.rootRef
      ))!;
      h.fixture.git(['worktree', 'lock', lockedLaneRoot]);

      // Clean lane teardown through installed-editor commands: complete-and-retain -> mark-cleanup-eligible -> cleanup.
      expect(
        (
          await runRecoverExecutionLane(
            { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
            { action: 'complete-and-retain', laneId: landedCase.lane.laneId }
          )
        ).status
      ).toBe('completed');
      expect(
        (
          await runRecoverExecutionLane(
            { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
            { action: 'mark-cleanup-eligible', laneId: landedCase.lane.laneId }
          )
        ).status
      ).toBe('completed');

      const cleanupCmd = await runRecoverExecutionLane(
        { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
        { action: 'cleanup' }
      );
      expect(cleanupCmd.status).toBe('completed');
      if (cleanupCmd.status !== 'completed' || cleanupCmd.cleanupReport === undefined) {
        throw new Error('cleanup command failed');
      }
      expect(cleanupCmd.cleanupReport.removed).toEqual([landedCase.lane.laneId]);
      expect(cleanupCmd.cleanupReport.kept).toEqual(
        expect.arrayContaining([
          { laneId: blockedCase.lane.laneId, observation: 'lane-pinned' },
          { laneId: uncertainCase.lane.laneId, observation: 'lane-dirty' },
          { laneId: interruptedCleanupLane.value.laneId, observation: 'worktree-locked' }
        ])
      );

      // Step 3 (FR-R8-01 01-06 / 01-07): Freeze failure at run terminal -> stays active -> inspect -> retry-freeze -> complete!
      const coord = createRunLaneCoordinator({
        getLaneService: () => host2,
        isLanesEnabled: () => true,
        primaryWorkspaceRoot: h.fixture.root
      });
      const failedFreezeBinding = await coord.provisionForRun('exec-freeze-fail-rehearsal');
      if (failedFreezeBinding === null) throw new Error('expected lane binding');
      const failedFreezeRoot = await coord.resolveExecutionRoot({
        runId: 'exec-freeze-fail-rehearsal',
        laneId: failedFreezeBinding.laneId
      });
      fsSync.writeFileSync(path.join(failedFreezeRoot, 'src', 'rehearsal.txt'), 'retry-after-freeze-fail\n');
      h.fixture.git(['config', '--unset', 'user.email']);
      await coord.onRunTerminal({
        runId: 'exec-freeze-fail-rehearsal',
        laneId: failedFreezeBinding.laneId,
        status: 'completed'
      });
      expect(h.lanes.getLane('ws-inc', failedFreezeBinding.laneId)).toMatchObject({
        state: 'active',
        stateReason: 'freeze-failed:git-identity-missing'
      });

      h.fixture.git(['config', 'user.email', 'rehearsal@example.invalid']);
      const retriedFreeze = await runRecoverExecutionLane(
        { getLaneService: () => host2, ui: createApprovingUi(), logger: commandLogger },
        { action: 'retry-freeze', laneId: failedFreezeBinding.laneId, completeAfterFreeze: true }
      );
      expect(retriedFreeze.status).toBe('completed');
      if (retriedFreeze.status !== 'completed') throw new Error('expected retry-freeze completed');
      expect(retriedFreeze.lane?.state).toBe('completed');
      expect(retriedFreeze.lane?.stateReason).toBeNull();
      expect(h.fixture.git(['show', `${retriedFreeze.candidate!.commit}:src/rehearsal.txt`])).toBe(
        'retry-after-freeze-fail\n'
      );

      // Verify surviving files after cleanup:
      // - `candidate` ref preserved while `base` ref deleted;
      expect(h.fixture.git(['for-each-ref', '--format=%(refname)', landedCase.lane.candidateRef]).trim()).toBe(
        landedCase.lane.candidateRef
      );
      expect(h.fixture.git(['for-each-ref', '--format=%(refname)', landedCase.lane.baseRef]).trim()).toBe('');
      // - primary checkout & `.git` intact;
      expect(fsSync.readFileSync(path.join(h.fixture.root, 'src', 'app.txt'), 'utf8')).toBe('v1\n');
      expect(fsSync.existsSync(path.join(h.fixture.root, '.git'))).toBe(true);
      // - unowned worktree untouched;
      expect(fsSync.existsSync(path.join(unownedWorktree, 'src', 'app.txt'))).toBe(true);
      // - SQLite receipt and audit log intact;
      expect(h.integrations.getReceipt(landedCase.request.requestId)?.outcome).toBe('landed');
      const chain = verifyAuditChainAt(path.join(h.fixture.root, '.schegent'));
      expect(chain).not.toBeNull();
      expect(chain!.verdict.ok).toBe(true);

      // Verify service resumed: next lane provisions cleanly!
      const nextLane = await apiProvisionLane(host2, {
        rootExecutionId: 'exec-post-recovery',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      expect(nextLane.ok && nextLane.value.state).toBe('active');
    });
  });

  describe('Documentation verbatim diagnostic parity & operator entry-point links (Contract 3)', () => {
    it('matches every Contract 3 diagnostic string verbatim in incident-recovery-guide.md and sqlite-rollback-runbook.md', async () => {
      const incidentGuide = await fs.readFile(
        path.join(REPO_ROOT, 'docs/operations/incident-recovery-guide.md'),
        'utf8'
      );
      const rollbackRunbook = await fs.readFile(
        path.join(REPO_ROOT, 'docs/operations/sqlite-rollback-runbook.md'),
        'utf8'
      );

      const requiredIncidentTokens = [
        // Symptom 1
        'UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema <N> or later; this build reads up to <M>',
        'UNSUPPORTED_MIN_READER_VERSION: database records an unreadable reader floor',
        'UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=<N> exceeds supported max=<M>',
        'Schegent refused to open or relocate the operational SQLite database (<reason>). Update Schegent before opening this workspace.',
        'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
        'in-place downgrade from schema 9 to schema 8 is impossible',
        // Symptom 2
        'workspace state write timed out; quarantining state writer',
        'MEMENTO_WRITE_DEADLINE_MS = 5000',
        'StorageWriteQuarantinedError',
        'storage-write-timeout',
        'storage-write-quarantined',
        'queue-state-unavailable',
        'workspace state write settled after its deadline; state writer resumed',
        'schegent.reset',
        'workspace-state-reset',
        // Symptom 3 (installed-editor lane recovery surface + freeze-failed preservation)
        'Schegent: Inspect Execution Lanes',
        'schegent.inspectExecutionLanes',
        'Schegent: Recover Execution Lane',
        'schegent.recoverExecutionLane',
        'freeze-failed:',
        'lane-bound-reached',
        'integration-busy',
        'lane-busy',
        'provisioning-interrupted',
        'cleanup-interrupted',
        'root-missing',
        'containment-refused',
        'uncertain',
        'expectedTarget',
        'observedTip',
        'lane-pinned',
        'lane-dirty',
        'worktree-locked',
        'completeLane',
        'releaseLane',
        'cleanupLanes'
      ];

      for (const token of requiredIncidentTokens) {
        expect(incidentGuide, `incident-recovery-guide.md missing verbatim diagnostic token: ${token}`).toContain(token);
      }

      // Rollback runbook drift fixed & aligned with schema-bootstrap.ts.
      expect(rollbackRunbook).toContain(
        'UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema <N> or later; this build reads up to <M>'
      );
      expect(rollbackRunbook).toContain(
        'UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=<N> exceeds supported max=<M>'
      );
      expect(rollbackRunbook).toContain('EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT');
      expect(rollbackRunbook).toContain('in-place downgrade is impossible');
      expect(rollbackRunbook).not.toContain("exceeds this build's maxSupportedVersion");
    });

    it('links incident-recovery-guide.md directly from all updated operator docs and entry points', async () => {
      const filesToCheck = [
        'docs/operations/sqlite-rollback-runbook.md',
        'docs/operations/recovery-checkpoints.md',
        'docs/operations/execution-lanes.md',
        'docs/courses/use-schegent.md',
        'docs/how-to/product-workflows.md'
      ];
      for (const relPath of filesToCheck) {
        const content = await fs.readFile(path.join(REPO_ROOT, relPath), 'utf8');
        expect(content, `${relPath} must link directly to incident-recovery-guide.md`).toContain(
          'incident-recovery-guide.md'
        );
      }
      for (const entryPath of ['docs/courses/use-schegent.md', 'docs/how-to/product-workflows.md']) {
        const content = await fs.readFile(path.join(REPO_ROOT, entryPath), 'utf8');
        expect(content, `${entryPath} must link directly to sqlite-rollback-runbook.md`).toContain(
          'sqlite-rollback-runbook.md'
        );
      }
    });
  });
});
