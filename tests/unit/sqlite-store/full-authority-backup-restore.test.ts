/**
 * FR-R7-03 (FR-001, FR-002, FR-005, FR-008, FR-009, FR-010, SC-001, SC-002, SC-003) —
 * Full-authority round-trip backup/restore test comparing every entity across core,
 * operational, usage accounting, artifact lifecycle, recovery handoffs (with immutable
 * triggers), execution lanes, reporting (with self-referencing FK), catalog, telemetry,
 * and outbox tables plus cache reload; plus fail-closed tests for single-byte flip and
 * all seven typed rejection codes.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listBackupsInRoot,
  NodeSqliteConnection,
  SqliteApplicationStore,
  verifyBackupStandalone
} from '../../../src/services/sqlite-store';
import { SqliteOperationalBacking } from '../../../src/state/sqlite-operational-backing';
import { KEYS } from '../../../src/state/workspace-state';

function createMemoryMemento(): ConstructorParameters<typeof SqliteOperationalBacking>[2] {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    }
  };
}

describe('Full-authority SQLite backup & restore (FR-R7-03 SC-001, SC-002, SC-003)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a populated store entity-for-entity across all authoritative domains, preserves triggers, and reloads caches (SC-001)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-fr-r7-03-rt-'));
    tempDirs.push(rootDir);
    const now = 1_763_700_000_000;
    const scopeId = 'scope-full-auth';

    const sourceStore = new SqliteApplicationStore({
      databasePath: path.join(rootDir, 'source.db'),
      journalMode: 'wal',
      nowMs: () => now
    });
    const targetStore = new SqliteApplicationStore({
      databasePath: path.join(rootDir, 'target.db'),
      journalMode: 'wal',
      nowMs: () => now
    });

    try {
      const srcConn = sourceStore.writerConnection;
      const srcBacking = new SqliteOperationalBacking(
        sourceStore,
        scopeId,
        createMemoryMemento(),
        () => now
      );
      srcBacking.updateBatch([
        {
          key: KEYS.queue,
          value: {
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
                    id: 'task-auth-1',
                    featureDescription: 'Authoritative task one',
                    status: 'pending',
                    enqueuedAt: '2026-11-19T09:00:00.000Z',
                    customField: 'preserved-remainder'
                  }
                ]
              }
            }
          }
        },
        {
          key: KEYS.run,
          value: {
            default: {
              id: 'run-auth-1',
              queueId: 'default',
              featureId: '317-backup',
              status: 'completed',
              currentPhase: 'verify',
              startedAt: '2026-11-19T09:00:00.000Z',
              lastTransitionAt: '2026-11-19T09:05:00.000Z',
              metadataTag: 'exact-payload'
            }
          }
        },
        {
          key: KEYS.history,
          value: [
            {
              runId: 'run-auth-1',
              featureId: '317-backup',
              status: 'completed',
              completedAt: '2026-11-19T09:05:00.000Z'
            }
          ]
        }
      ]);

      // Relational Runs / Steps / Attempts
      srcConn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-rel-1', ?, 'wf-1', NULL, 'succeeded', 3, 'step-1', ?, ?, 'done', ?, ?)`,
        scopeId,
        now,
        now + 1000,
        now,
        now + 1000
      );
      srcConn.run(
        `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, updated_at_ms)
         VALUES ('step-1', 'run-rel-1', 0, 'specify', 'succeeded', 1, ?)`,
        now
      );
      srcConn.run(
        `INSERT INTO attempts (attempt_id, run_id, step_id, attempt_number, status, exit_code, started_at_ms, completed_at_ms)
         VALUES ('att-1', 'run-rel-1', 'step-1', 1, 'succeeded', 0, ?, ?)`,
        now,
        now + 500
      );

      // F05 Artifacts & Lifecycle (ON DELETE RESTRICT)
      srcConn.run(
        `INSERT INTO artifacts (
          artifact_id, content_sha256, byte_length, media_type, kind,
          created_by_run_id, created_by_attempt_id, created_at_ms
        ) VALUES ('art-1', '${'a'.repeat(64)}', 128, 'application/json', 'report', 'run-rel-1', 'att-1', ?)`,
        now
      );
      srcConn.run(
        `INSERT INTO artifact_lifecycle (
          artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
          retention_class, store_kind, immutability, digest_algorithm, digest_value,
          generation, extent_bytes, byte_size, availability, producer_identity, display_name,
          created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
        ) VALUES (
          'art-1', 1, 'run-rel-1', 'att-1', 'metadata',
          'generated-reports-handoff-exports', 'report', 'immutable', 'sha256', '${'a'.repeat(64)}',
          NULL, NULL, 128, 'present', 'test-producer', 'report-1.json',
          ?, NULL, NULL, ?
        )`,
        now,
        now
      );

      // F06 Usage Accounting rows
      srcConn.run(
        `INSERT INTO accounting_observations (
          observation_id, ingest_seq, dedup_key, content_digest, producer_namespace, source_kind,
          source_identity, observation_revision, workspace_id, root_id, attempt_id, invocation_ordinal,
          counter_scope, adapter_version, normalization_version, backend, model_requested, model_reported,
          provider_session_ref, workflow_revision, phase_id, event_utc, observed_utc, ingested_utc,
          ingested_monotonic_ms, clock_anomaly, disposition, uncertainty_reason
        ) VALUES (
          'obs-1', 1, 'dedup-1', '${'1'.repeat(64)}', 'phase-runner', 'phase-end',
          'phase-end:1', 1, ?, 'run-rel-1', 'att-1', 1,
          'invocation-delta', 'v1', 1, 'claude', 'claude-sonnet', 'claude-sonnet',
          '${'2'.repeat(32)}', 'wf-rev-1', 'specify', '2026-11-19T09:00:00.000Z',
          '2026-11-19T09:00:00.000Z', '2026-11-19T09:00:00.000Z', ?, 0, 'accepted', NULL
        )`,
        scopeId,
        now
      );
      srcConn.run(
        `INSERT INTO accounting_observation_measures (
          observation_id, measure, quantity, unit, reported_scale, completeness,
          provenance, cache_relation, pricing_version, unknown_reason
        ) VALUES ('obs-1', 'input_tokens', 4200, 'count', NULL, 'known', 'provider-reported', NULL, NULL, NULL)`
      );

      // F08 Recovery Handoffs with issued revision (triggers BEFORE DELETE immutability trigger!)
      const handoffId = 'a'.repeat(64);
      srcConn.run(
        `INSERT INTO recovery_handoffs (
          handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
          state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
          legacy_provenance, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'run-rel-1', 'inv-1', 'att-1', 'ready', 0, NULL, 1, 'pending-handoff', NULL, NULL, ?, ?)`,
        handoffId,
        scopeId,
        now,
        now
      );
      srcConn.run(
        `INSERT INTO recovery_handoff_revisions (
          handoff_id, revision_no, status, cutoff_key, execution_revision, usage_revision,
          fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
          issued_at_ms, superseded_at_ms
        ) VALUES (?, 1, 'issued', '${'b'.repeat(64)}', 'exec-rev-1', 1, ?, 1, '{"v":1}', '${'b'.repeat(64)}', 'safe', 'complete', ?, NULL)`,
        handoffId,
        now,
        now
      );

      // F10 Execution Lanes
      srcConn.run(
        `INSERT INTO execution_lanes (
          lane_id, workspace_id, repository_id, root_execution_id, source_commit, base_ref,
          candidate_ref, root_ref, dependency_recipe, state, state_reason, pinned,
          owner_generation, created_at, updated_at
        ) VALUES (
          '${'c'.repeat(32)}', ?, '${'d'.repeat(64)}', 'run-rel-1', '${'e'.repeat(40)}',
          'refs/heads/develop', 'refs/heads/schegent/lane-1', 'lanes/lane-1', 'none', 'active',
          NULL, 1, 1, '2026-11-19T09:00:00.000Z', '2026-11-19T09:00:00.000Z'
        )`,
        scopeId
      );

      // F11 Reporting with self-referencing FK (`rerun_of`)
      const rep1 = '1'.repeat(32);
      const rep2 = '2'.repeat(32);
      srcConn.run(
        `INSERT INTO report_saved (
          report_id, workspace_id, rerun_of, view, query_json, manifest_json, manifest_sha256,
          calculation_version, accounting_revision, source_cutoff_ms, population_digest, created_at_ms
        ) VALUES (?, ?, NULL, 'usage', '{"k":1}', '{}', '${'3'.repeat(64)}', 1, 1, ?, '${'4'.repeat(64)}', ?)`,
        rep1,
        scopeId,
        now,
        now
      );
      srcConn.run(
        `INSERT INTO report_saved (
          report_id, workspace_id, rerun_of, view, query_json, manifest_json, manifest_sha256,
          calculation_version, accounting_revision, source_cutoff_ms, population_digest, created_at_ms
        ) VALUES (?, ?, ?, 'usage', '{"k":2}', '{}', '${'5'.repeat(64)}', 1, 1, ?, '${'6'.repeat(64)}', ?)`,
        rep2,
        scopeId,
        rep1,
        now,
        now
      );

      // F04-C Catalog Definitions & Heads
      srcConn.run(
        `INSERT INTO definitions (definition_id, scope, layer, slug, display_name, created_at_ms)
         VALUES ('def-1', 'workspace', 'phase', 'custom-check', 'Custom Check', ?)`,
        now
      );
      srcConn.run(
        `INSERT INTO definition_versions (
          definition_version_id, definition_id, version_number, status, canonical_yaml, digest_sha256, schema_version, created_at_ms
        ) VALUES ('defv-1', 'def-1', 1, 'published', 'id: custom-check\n', '${'d'.repeat(64)}', 1, ?)`,
        now
      );
      srcConn.run(
        `INSERT INTO catalog_heads (definition_id, published_version_id, draft_version_id, revision, updated_at_ms)
         VALUES ('def-1', 'defv-1', NULL, 2, ?)`,
        now
      );

      // State Change Outbox (AUTOINCREMENT / sqlite_sequence)
      srcConn.run(
        `INSERT INTO state_change_outbox (
          commit_unit, scope_kind, scope_id, revision, payload_json, created_at_ms, delivered_at_ms
        ) VALUES ('Admission', 'workspace', ?, 5, '{"event":"admitted"}', ?, NULL)`,
        scopeId,
        now
      );

      // 1. Create online backup with companion manifest
      const backup = await sourceStore.backupRestore.createOnlineBackup({
        backupId: 'bkp-full-001',
        scopeId,
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });

      // Verify file-byte SHA-256 & exact file size match disk bytes (FR-002)
      const diskBytes = await fs.readFile(backup.backupDatabasePath);
      const expectedSha = createHash('sha256').update(diskBytes).digest('hex');
      expect(backup.manifest.databaseSha256).toBe(expectedSha);
      expect(backup.manifest.databaseBytes).toBe(diskBytes.byteLength);

      // Verify companion manifest exists & owner-only POSIX modes (FR-005, FR-010)
      const manifestStat = await fs.lstat(backup.manifestPath);
      expect(manifestStat.isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect(manifestStat.mode & 0o077).toBe(0);
        const dbStat = await fs.lstat(backup.backupDatabasePath);
        expect(dbStat.mode & 0o077).toBe(0);
        const dirStat = await fs.lstat(path.dirname(backup.backupDatabasePath));
        expect(dirStat.mode & 0o077).toBe(0);
      }

      // Verify listBackupsInRoot and standalone verifyBackup
      const listed = await listBackupsInRoot(rootDir, ['sqlite', scopeId, 'backups']);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.backupId).toBe('bkp-full-001');
      expect(listed[0]?.manifestStatus).toBe('valid');

      const verified = verifyBackupStandalone({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(verified.status).toBe('verified');

      // 2. Populate targetStore with conflicting rows (including an issued recovery_handoff_revisions row!)
      const tgtConn = targetStore.writerConnection;
      const tgtBacking = new SqliteOperationalBacking(
        targetStore,
        scopeId,
        createMemoryMemento(),
        () => now
      );
      tgtBacking.update(KEYS.queue, {
        version: 10,
        queues: {
          stale: {
            id: 'stale',
            name: 'Stale Queue',
            paused: true,
            queueLifecycle: 'paused',
            inFlightId: null,
            requests: []
          }
        }
      });
      const staleHandoffId = 'f'.repeat(64);
      tgtConn.run(
        `INSERT INTO recovery_handoffs (
          handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
          state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
          legacy_provenance, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'run-stale', 'inv-stale', 'att-stale', 'ready', 0, NULL, 1, 'pending-handoff', NULL, NULL, ?, ?)`,
        staleHandoffId,
        scopeId,
        now,
        now
      );
      tgtConn.run(
        `INSERT INTO recovery_handoff_revisions (
          handoff_id, revision_no, status, cutoff_key, execution_revision, usage_revision,
          fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
          issued_at_ms, superseded_at_ms
        ) VALUES (?, 1, 'issued', '${'e'.repeat(64)}', 'exec-stale', 1, ?, 1, '{"stale":true}', '${'e'.repeat(64)}', 'safe', 'complete', ?, NULL)`,
        staleHandoffId,
        now,
        now
      );
      tgtConn.run(
        `INSERT INTO accounting_observations (
          observation_id, ingest_seq, dedup_key, content_digest, producer_namespace, source_kind,
          source_identity, observation_revision, workspace_id, root_id, attempt_id, invocation_ordinal,
          counter_scope, adapter_version, normalization_version, backend, model_requested, model_reported,
          provider_session_ref, workflow_revision, phase_id, event_utc, observed_utc, ingested_utc,
          ingested_monotonic_ms, clock_anomaly, disposition, uncertainty_reason
        ) VALUES (
          'obs-stale', 99, 'dedup-stale', '${'9'.repeat(64)}', 'phase-runner', 'phase-end',
          'phase-end:99', 1, ?, 'run-stale', 'att-stale', 1,
          'invocation-delta', 'v1', 1, 'openai', 'gpt', 'gpt',
          '${'8'.repeat(32)}', 'wf-stale', 'specify', '2026-11-19T09:00:00.000Z',
          '2026-11-19T09:00:00.000Z', '2026-11-19T09:00:00.000Z', ?, 0, 'accepted', NULL
        )`,
        scopeId,
        now
      );

      // 3. Restore backup onto targetStore & reload operational cache
      const restored = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(restored.status).toBe('restored');
      if (restored.status === 'restored') {
        expect(restored.restoredTableCount).toBe(128);
        expect(restored.restoredRunCount).toBe(2);
      }

      tgtBacking.reloadCacheFromSqlite();

      // 4. Compare EVERY populated table entity-for-entity between sourceStore and targetStore
      const tablesToCompare = [
        'runs',
        'steps',
        'attempts',
        'operational_queue_meta',
        'operational_tasks',
        'operational_runs',
        'operational_kv_documents',
        'artifacts',
        'artifact_lifecycle',
        'accounting_observations',
        'accounting_observation_measures',
        'recovery_handoffs',
        'recovery_handoff_revisions',
        'execution_lanes',
        'report_saved',
        'definitions',
        'definition_versions',
        'catalog_heads',
        'state_change_outbox',
        'cutover_sentinel'
      ] as const;

      for (const table of tablesToCompare) {
        const srcRows = srcConn.all(`SELECT * FROM "${table}"`);
        const tgtRows = tgtConn.all(`SELECT * FROM "${table}"`);
        expect(tgtRows, `table ${table} must match entity-for-entity after restore`).toEqual(srcRows);
      }

      // Verify operational cache reflects restored entities immediately after reload
      expect(tgtBacking.get(KEYS.queue)).toEqual(srcBacking.get(KEYS.queue));
      expect(tgtBacking.get(KEYS.run)).toEqual(srcBacking.get(KEYS.run));
      expect(tgtBacking.get(KEYS.history)).toEqual(srcBacking.get(KEYS.history));

      // Verify immutability trigger on recovery_handoff_revisions was recreated and still enforces immutability
      expect(() =>
        tgtConn.run(`DELETE FROM recovery_handoff_revisions WHERE handoff_id = ?`, handoffId)
      ).toThrow(/issued|immutable|abort/i);
    } finally {
      sourceStore.close();
      targetStore.close();
    }
  });

  it('refuses single-byte flip with DATABASE_DIGEST_MISMATCH and exercises every rejection code without altering live store (SC-002, SC-003)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-fr-r7-03-rej-'));
    tempDirs.push(rootDir);
    const now = 1_763_710_000_000;
    const scopeId = 'scope-rej';

    const store = new SqliteApplicationStore({
      databasePath: path.join(rootDir, 'live.db'),
      journalMode: 'wal',
      nowMs: () => now
    });

    try {
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-live-keep', ?, 'wf-live', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
        scopeId,
        now,
        now,
        now,
        now
      );

      const backup = await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-valid',
        scopeId,
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });

      // Add a post-backup row to live store so we can prove every rejected restore leaves live store untouched
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-live-after-backup', ?, 'wf-live', NULL, 'succeeded', 2, NULL, ?, ?, 'ok', ?, ?)`,
        scopeId,
        now + 100,
        now + 100,
        now + 100,
        now + 100
      );

      const assertLiveUnchanged = () => {
        const ids = store.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id);
        expect(ids).toEqual(['run-live-after-backup', 'run-live-keep']);
      };

      // 1. Single-byte flip -> DATABASE_DIGEST_MISMATCH (SC-002)
      const flippedPath = path.join(rootDir, 'sqlite', scopeId, 'backups', 'flipped.db');
      const rawBytes = await fs.readFile(backup.backupDatabasePath);
      const flipped = Buffer.from(rawBytes);
      const flipIdx = Math.floor(flipped.length / 2);
      flipped[flipIdx] = (flipped[flipIdx] ?? 0) ^ 0x01;
      await fs.writeFile(flippedPath, flipped);

      const flipVerify = store.backupRestore.verifyBackup({
        backupDatabasePath: flippedPath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(flipVerify.status).toBe('rejected');
      if (flipVerify.status === 'rejected') {
        expect(flipVerify.reasonCode).toBe('DATABASE_DIGEST_MISMATCH');
      }

      const flipRestore = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: flippedPath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(flipRestore.status).toBe('rejected');
      if (flipRestore.status === 'rejected') {
        expect(flipRestore.reasonCode).toBe('DATABASE_DIGEST_MISMATCH');
      }
      assertLiveUnchanged();

      // 2. UNSUPPORTED_SCHEMA_VERSION
      const unsupportedSchema = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: { ...backup.manifest, schemaVersion: 99 },
        trustedRootDir: rootDir
      });
      expect(unsupportedSchema.status).toBe('rejected');
      if (unsupportedSchema.status === 'rejected') {
        expect(unsupportedSchema.reasonCode).toBe('UNSUPPORTED_SCHEMA_VERSION');
      }
      assertLiveUnchanged();

      // 3. EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT
      const missingDep = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: {
          ...backup.manifest,
          externalDependencies: [
            {
              dependencyKind: 'audit_log',
              referenceId: 'audit-1',
              relativePath: '.schegent/audit.log',
              byteLength: 100,
              sha256Digest: 'f'.repeat(64)
            }
          ]
        },
        trustedRootDir: rootDir,
        inspectExternalDependency: () => ({ exists: false, byteLength: 0, sha256Digest: '' })
      });
      expect(missingDep.status).toBe('rejected');
      if (missingDep.status === 'rejected') {
        expect(missingDep.reasonCode).toBe('EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT');
      }
      assertLiveUnchanged();

      // 4. EXTERNAL_DEPENDENCY_BOUND_EXCEEDED (FR-009)
      const overBoundCount = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: {
          ...backup.manifest,
          externalDependencies: [
            {
              dependencyKind: 'artifact_blob',
              referenceId: 'a1',
              relativePath: 'blobs/a1',
              byteLength: 10,
              sha256Digest: '1'.repeat(64)
            },
            {
              dependencyKind: 'artifact_blob',
              referenceId: 'a2',
              relativePath: 'blobs/a2',
              byteLength: 10,
              sha256Digest: '2'.repeat(64)
            }
          ]
        },
        trustedRootDir: rootDir,
        maxExternalDependencies: 1
      });
      expect(overBoundCount.status).toBe('rejected');
      if (overBoundCount.status === 'rejected') {
        expect(overBoundCount.reasonCode).toBe('EXTERNAL_DEPENDENCY_BOUND_EXCEEDED');
      }
      assertLiveUnchanged();

      // 5. BACKUP_OPEN_FAILED (regular -wal sidecar planted beside valid backup file)
      const regularSidecarPath = path.join(rootDir, 'sqlite', scopeId, 'backups', 'with-reg-wal.db');
      await fs.copyFile(backup.backupDatabasePath, regularSidecarPath);
      await fs.writeFile(`${regularSidecarPath}-wal`, Buffer.from('planted-wal'));
      const sidecarRes = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: regularSidecarPath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(sidecarRes.status).toBe('rejected');
      if (sidecarRes.status === 'rejected') {
        expect(sidecarRes.reasonCode).toBe('BACKUP_OPEN_FAILED');
      }
      assertLiveUnchanged();

      // 6. QUICK_CHECK_FAILED
      const quickCheckFail = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        trustedRootDir: rootDir,
        simulateQuickCheckFailure: true
      });
      expect(quickCheckFail.status).toBe('rejected');
      if (quickCheckFail.status === 'rejected') {
        expect(quickCheckFail.reasonCode).toBe('QUICK_CHECK_FAILED');
      }
      assertLiveUnchanged();

      // 7. FOREIGN_KEY_CHECK_FAILED (real FK violation in backup DB with matching file-byte digest)
      const fkBadPath = path.join(rootDir, 'sqlite', scopeId, 'backups', 'fk-bad.db');
      await fs.copyFile(backup.backupDatabasePath, fkBadPath);
      const fkConn = new NodeSqliteConnection({ databasePath: fkBadPath, journalMode: 'delete' });
      try {
        fkConn.exec('PRAGMA foreign_keys = OFF');
        fkConn.run(
          `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, updated_at_ms)
           VALUES ('step-orphan', 'non-existent-run', 0, 'specify', 'pending', 1, ?)`,
          now
        );
      } finally {
        fkConn.close();
      }
      const fkBadBytes = await fs.readFile(fkBadPath);
      const fkBadSha = createHash('sha256').update(fkBadBytes).digest('hex');
      const fkFail = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: fkBadPath,
        manifest: {
          ...backup.manifest,
          databaseSha256: fkBadSha,
          databaseBytes: fkBadBytes.byteLength
        },
        trustedRootDir: rootDir
      });
      expect(fkFail.status).toBe('rejected');
      if (fkFail.status === 'rejected') {
        expect(fkFail.reasonCode).toBe('FOREIGN_KEY_CHECK_FAILED');
      }
      assertLiveUnchanged();
    } finally {
      store.close();
    }
  });
});
