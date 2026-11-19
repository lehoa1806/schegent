/**
 * FR-R7-03 (FR-007, SC-004) — Recorded rehearsal of `repo/docs/operations/sqlite-rollback-runbook.md`
 * against a fixture schema-8 -> schema-9 upgrade.
 *
 * Exercises every step of the cross-version downgrade runbook:
 * 1. Populate a schema-8 store (Runs, Tasks, queue, history in operational_kv_documents + runs).
 * 2. Take a verified pre-upgrade backup (`createOnlineBackup` + `verifyBackupStandalone`).
 * 3. Upgrade the live store to schema 9 (`SchemaBootstrapService.bootstrapAndMigrate`, raising
 *    `min_reader_version = 9`) and record post-upgrade mutations.
 * 4. Confirm a schema-8 reader (`maxSupportedVersion = 8`) refuses the upgraded database
 *    fail-closed with `UNSUPPORTED_MIN_READER_VERSION` without modifying it.
 * 5. Execute the runbook offline rollback procedure: close handles, verify backup manifest
 *    SHA-256 & byte length on disk, remove stale `-wal`/`-shm`/`-journal` sidecars, copy the
 *    verified schema-8 backup to the live path with `0600` permissions.
 * 6. Confirm the schema-8 reader opens the rolled-back database cleanly with exact pre-upgrade
 *    entity parity and expected absence of post-backup state.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupRestoreService,
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  parseAndValidateBackupManifest,
  SchemaBootstrapService,
  verifyBackupStandalone
} from '../../src/services/sqlite-store';
import { narrowMode } from '../../src/lib/narrow-mode';

describe('SQLite migration rollback runbook rehearsal (FR-R7-03 SC-004)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rehearses schema 8 -> schema 9 upgrade, min_reader_version refusal, and runbook rollback to schema 8', async () => {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-rollback-rehearsal-'));
    tempDirs.push(storageRoot);
    const scopeId = 'scope-rehearsal-01';
    const now = 1_763_730_000_000;

    const liveDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(liveDir, { recursive: true, mode: 0o700 });
    const liveDbPath = path.join(liveDir, 'schegent-state.db');

    const schema8Migrations = BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8);

    const preUpgradeQueueDoc = {
      version: 10,
      queues: {
        default: {
          id: 'default',
          name: 'Default',
          paused: false,
          queueLifecycle: 'idle',
          inFlightId: null,
          requests: [
            {
              id: 'task-pre-upgrade-1',
              featureDescription: 'Pre-upgrade task preserved across rollback',
              status: 'pending',
              enqueuedAt: '2026-11-19T08:00:00.000Z'
            }
          ]
        }
      }
    };
    const preUpgradeRunDoc = {
      default: {
        id: 'run-pre-upgrade-1',
        queueId: 'default',
        featureId: '315-pre-upgrade',
        status: 'completed',
        currentPhase: 'verify',
        startedAt: '2026-11-19T08:00:00.000Z',
        lastTransitionAt: '2026-11-19T08:10:00.000Z'
      }
    };

    // Step 1: Populate a schema-8 store and take a verified pre-upgrade backup
    const s8Conn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
    let backupDatabasePath: string;
    let manifestPath: string;
    try {
      const boot8 = SchemaBootstrapService.bootstrapAndMigrate(
        s8Conn,
        () => now,
        schema8Migrations
      );
      expect(boot8.schemaVersion).toBe(8);
      const s8MinReader = s8Conn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
      );
      expect(Number(s8MinReader?.meta_value)).toBe(1);

      s8Conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-pre-upgrade-1', ?, 'wf-s8', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
        scopeId,
        now,
        now + 1000,
        now,
        now + 1000
      );
      s8Conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, 'schegent.queue', 1, 10, ?, ?, 0, ?)`,
        `operational:${scopeId}`,
        JSON.stringify(preUpgradeQueueDoc),
        Buffer.byteLength(JSON.stringify(preUpgradeQueueDoc), 'utf8'),
        now
      );
      s8Conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, 'schegent.run', 1, 1, ?, ?, 1, ?)`,
        `operational:${scopeId}`,
        JSON.stringify(preUpgradeRunDoc),
        Buffer.byteLength(JSON.stringify(preUpgradeRunDoc), 'utf8'),
        now
      );

      const s8BackupSvc = new BackupRestoreService(s8Conn, () => now);
      const bkp = await s8BackupSvc.createOnlineBackup({
        backupId: 'bkp-pre-s9-upgrade',
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

    // Step 2: Upgrade live store to schema 9 (min_reader_version = 9) and write post-upgrade state
    const s9Conn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
    try {
      const boot9 = SchemaBootstrapService.bootstrapAndMigrate(s9Conn, () => now + 60_000);
      expect(boot9.schemaVersion).toBe(9);
      const s9MinReader = s9Conn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
      );
      expect(Number(s9MinReader?.meta_value)).toBe(9);

      s9Conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-post-upgrade-s9', ?, 'wf-s9', NULL, 'succeeded', 2, NULL, ?, ?, 'post-upgrade', ?, ?)`,
        scopeId,
        now + 60_000,
        now + 61_000,
        now + 60_000,
        now + 61_000
      );
    } finally {
      s9Conn.close();
    }

    // Step 3: Verify older schema-8 build refuses the upgraded schema-9 file fail-closed
    const olderReaderConn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
    try {
      expect(() =>
        SchemaBootstrapService.bootstrapAndMigrate(
          olderReaderConn,
          () => now + 120_000,
          schema8Migrations
        )
      ).toThrow(/UNSUPPORTED_MIN_READER_VERSION/);
    } finally {
      olderReaderConn.close();
    }

    // Step 4: Execute runbook offline rollback procedure
    // 4a. Read and verify companion manifest & backup image with maxSupportedSchemaVersion = 8
    const rawManifest = await fs.readFile(manifestPath, 'utf8');
    const parsedManifest = parseAndValidateBackupManifest(rawManifest);
    expect(parsedManifest).not.toBeNull();
    expect(parsedManifest!.schemaVersion).toBe(8);

    const diskBackupBytes = await fs.readFile(backupDatabasePath);
    expect(createHash('sha256').update(diskBackupBytes).digest('hex')).toBe(
      parsedManifest!.databaseSha256
    );
    expect(diskBackupBytes.byteLength).toBe(parsedManifest!.databaseBytes);

    const verified = verifyBackupStandalone({
      backupDatabasePath,
      manifest: parsedManifest!,
      trustedRootDir: storageRoot,
      maxSupportedSchemaVersion: 8
    });
    expect(verified.status).toBe('verified');

    // 4b. Preserve forensic copy of failed/upgraded schema-9 DB & remove stale sidecars
    await fs.rename(liveDbPath, `${liveDbPath}.failed-v9`);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await fs.rm(`${liveDbPath}${suffix}`, { force: true });
    }

    // 4c. Copy verified schema-8 backup into place and enforce 0600 permissions
    await fs.copyFile(backupDatabasePath, liveDbPath);
    const narrowed = await narrowMode(liveDbPath, 0o600);
    expect(narrowed.outcome === 'narrowed' || narrowed.outcome === 'already-private').toBe(true);
    if (process.platform !== 'win32') {
      const st = await fs.lstat(liveDbPath);
      expect(st.mode & 0o077).toBe(0);
    }

    // Step 5: Reopen with schema-8 build and verify clean open + exact pre-upgrade entity parity
    const rolledBackConn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
    try {
      const reopened = SchemaBootstrapService.bootstrapAndMigrate(
        rolledBackConn,
        () => now + 180_000,
        schema8Migrations
      );
      expect(reopened.schemaVersion).toBe(8);
      const reopenedMinReader = rolledBackConn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
      );
      expect(Number(reopenedMinReader?.meta_value)).toBe(1);
      expect(rolledBackConn.runQuickCheck()).toEqual(['ok']);
      expect(rolledBackConn.runForeignKeyCheck()).toEqual([]);

      // Exact pre-upgrade runs present; post-upgrade schema-9 run is absent (expected post-backup loss)
      const runs = rolledBackConn
        .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
        .map((r) => r.run_id);
      expect(runs).toEqual(['run-pre-upgrade-1']);

      const queueRow = rolledBackConn.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_key = 'schegent.queue'`
      );
      expect(JSON.parse(queueRow!.payload_json)).toEqual(preUpgradeQueueDoc);

      const runRow = rolledBackConn.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_key = 'schegent.run'`
      );
      expect(JSON.parse(runRow!.payload_json)).toEqual(preUpgradeRunDoc);
    } finally {
      rolledBackConn.close();
    }
  });
});
