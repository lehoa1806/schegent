import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  BackupRestoreService,
  NodeSqliteConnection,
  SchemaBootstrapService,
  SqliteApplicationStore
} from '../../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import { KEYS, type Memento } from '../../../src/state/workspace-state';

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

describe('FR-R6-F04 (US3 & US4): 7-Stage Interruption-Safe Migration, Quarantine & Online Backup/Restore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers from mid-migration interruption, quarantines corrupt and future-version records, blocks premature retirement, and refuses legacy readers after cutover (SC-008)', () => {
    let clock = 1_700_000_000_000;
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => clock });
    try {
      const snapshot = {
        migrationId: 'mig-001',
        scopeId: 'ws-mig',
        maxSupportedLegacySchemaVersion: 1,
        runRecords: [
          {
            recordKey: 'run-good-1',
            rawJson: JSON.stringify({
              schemaVersion: 1,
              runId: 'run-good-1',
              workspaceId: 'ws-mig',
              workflowId: 'wf-auto',
              status: 'running',
              revision: 3
            })
          },
          {
            recordKey: 'run-corrupt',
            rawJson: '{corrupt-json-payload'
          },
          {
            recordKey: 'run-future-v99',
            rawJson: JSON.stringify({
              schemaVersion: 99,
              runId: 'run-future-v99',
              workspaceId: 'ws-mig',
              workflowId: 'wf-auto'
            })
          }
        ],
        deltaRunRecords: [
          {
            recordKey: 'run-good-2',
            rawJson: JSON.stringify({
              schemaVersion: 1,
              runId: 'run-good-2',
              workspaceId: 'ws-mig',
              workflowId: 'wf-auto',
              status: 'succeeded',
              revision: 2
            })
          }
        ]
      };

      // 1. Simulate interruption at `validate` stage — legacy authority remains intact
      const interrupted = store.migration.runMigrationThroughRetainSource({
        ...snapshot,
        failAtStage: 'validate'
      });
      expect(interrupted.completed).toBe(false);
      expect(interrupted.currentStage).toBe('validate');
      expect(interrupted.authority).toBe('legacy');
      expect(store.cutoverGuard.checkLegacyAccessAllowed('ws-mig').allowed).toBe(true);

      // 2. Resume migration cleanly through `retain-source`
      clock += 1_000;
      const completed = store.migration.runMigrationThroughRetainSource(snapshot);
      expect(completed.completed).toBe(true);
      expect(completed.authority).toBe('sqlite');
      expect(completed.importedRuns).toBe(2);
      expect(completed.quarantinedRecords).toBe(2);

      // Verify old-reader refusal after `publish-authority`
      const legacyCheck = store.cutoverGuard.checkLegacyAccessAllowed('ws-mig');
      expect(legacyCheck.allowed).toBe(false);
      if (!legacyCheck.allowed) {
        expect(legacyCheck.reasonCode).toBe('SQLITE_AUTHORITY_ACTIVE');
      }

      // Verify quarantine rows preserved raw payload and reason codes
      const quarantined = store.migration.listQuarantineEntries('mig-001');
      expect(quarantined.map((q) => q.reasonCode).sort()).toEqual([
        'corrupt_json',
        'unknown_future_version'
      ]);

      // 3. Stage 7 (`retire-source`) is blocked while quarantine entries are unresolved
      const blockedRetire = store.migration.retireLegacySource('mig-001', 'ws-mig');
      expect(blockedRetire.retired).toBe(false);
      if (!blockedRetire.retired) {
        expect(blockedRetire.unresolvedQuarantineCount).toBe(2);
      }

      // Resolve quarantine entries and complete `retire-source`
      for (const q of quarantined) {
        store.migration.resolveQuarantineEntry(q.quarantineId);
      }
      const retired = store.migration.retireLegacySource('mig-001', 'ws-mig');
      expect(retired.retired).toBe(true);
      expect(store.cutoverGuard.getSentinel('ws-mig')?.authority).toBe('retired_legacy');
    } finally {
      store.close();
    }
  });

  it('creates a consistent online backup with BackupDependencyManifest and validates integrity, schema version, and external digests before restore (SC-009)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f04-bkp-'));
    tempDirs.push(rootDir);

    const store = await SqliteApplicationStore.openAtTrustedLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['live'],
      databaseFileName: 'live.db',
      sourceKind: 'host_storage_uri'
    });

    try {
      store.transactions.acquireOrRenewLeaseFence({
        fenceScope: 'window_primacy',
        resourceId: 'ws-bkp',
        ownerId: 'win-1',
        epoch: 1,
        ttlMs: 60_000
      });
      store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-bkp-1',
          idempotencyKey: 'admit-bkp-1',
          requestSha256: 'sha-bkp-1'
        },
        fence: {
          fenceScope: 'window_primacy',
          resourceId: 'ws-bkp',
          ownerId: 'win-1',
          epoch: 1
        },
        expectedRevision: 0,
        run: {
          runId: 'run-bkp-1',
          workspaceId: 'ws-bkp',
          workflowId: 'wf-bkp',
          priority: 1,
          initialStep: {
            stepId: 'step-bkp-1',
            stepIndex: 0,
            phaseId: 'specify',
            attemptId: 'att-bkp-1'
          }
        }
      });

      store.artifacts.registerArtifact({
        artifactId: 'art-ext-1',
        contentSha256: 'sha256-blob-content',
        byteLength: 512,
        mediaType: 'application/json',
        kind: 'report',
        createdByRunId: 'run-bkp-1',
        createdByAttemptId: 'att-bkp-1',
        location: {
          locationId: 'loc-ext-1',
          storageTier: 'cas_blob',
          uriOrRelpath: 'blobs/sha256-blob-content'
        }
      });

      const backup = await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-001',
        scopeId: 'ws-bkp',
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['backups'],
        auditLogDependencies: [
          {
            dependencyKind: 'audit_log',
            referenceId: 'audit-main',
            relativePath: '.schegent/audit.log',
            byteLength: 2048,
            sha256Digest: 'sha256-audit-chain'
          }
        ]
      });

      expect(backup.manifest.externalDependencies.length).toBe(2);

      // 0. Omitting external dependency inspector when manifest declares dependencies fails closed
      const omittedInspectorRestore = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest
      });
      expect(omittedInspectorRestore.status).toBe('rejected');
      if (omittedInspectorRestore.status === 'rejected') {
        expect(omittedInspectorRestore.reasonCode).toBe('EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT');
      }

      // 1. Missing/corrupt external dependency rejects restore without touching live store
      const missingDepRestore = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        inspectExternalDependency: () => ({
          exists: false,
          byteLength: 0,
          sha256Digest: ''
        })
      });
      expect(missingDepRestore.status).toBe('rejected');
      if (missingDepRestore.status === 'rejected') {
        expect(missingDepRestore.reasonCode).toBe('EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT');
      }

      // 2. Simulated quick_check corruption rejects restore
      const corruptDbRestore = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        simulateQuickCheckFailure: true,
        inspectExternalDependency: (relPath) =>
          relPath === 'blobs/sha256-blob-content'
            ? { exists: true, byteLength: 512, sha256Digest: 'sha256-blob-content' }
            : { exists: true, byteLength: 2048, sha256Digest: 'sha256-audit-chain' }
      });
      expect(corruptDbRestore.status).toBe('rejected');
      if (corruptDbRestore.status === 'rejected') {
        expect(corruptDbRestore.reasonCode).toBe('QUICK_CHECK_FAILED');
      }

      // 3. Valid backup and external dependencies restore cleanly
      const validRestore = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        inspectExternalDependency: (relPath) =>
          relPath === 'blobs/sha256-blob-content'
            ? { exists: true, byteLength: 512, sha256Digest: 'sha256-blob-content' }
            : { exists: true, byteLength: 2048, sha256Digest: 'sha256-audit-chain' }
      });
      expect(validRestore.status).toBe('restored');
      if (validRestore.status === 'restored') {
        expect(validRestore.restoredRunCount).toBe(1);
        expect(validRestore.verifiedExternalDependencies).toBe(2);
      }
    } finally {
      store.close();
    }
  });

  it('restores populated schema-9 per-entity operational tables field-for-field and reloads operational cache (FR-R7-02 FR-008, SC-005)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-m9-bkp-rt-'));
    tempDirs.push(rootDir);

    const now = 1_763_650_000_000;
    const sourceStore = await SqliteApplicationStore.openAtTrustedLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['source'],
      databaseFileName: 'source.db',
      sourceKind: 'host_storage_uri'
    });
    const targetStore = await SqliteApplicationStore.openAtTrustedLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['target'],
      databaseFileName: 'target.db',
      sourceKind: 'host_storage_uri'
    });

    try {
      const sourceQueues = {
        default: {
          requests: [
            {
              id: 'default-task-1',
              description: 'In-flight schema-9 task',
              enqueuedAt: now,
              createdAt: now,
              startedAt: now + 50,
              updatedAt: now + 100,
              completedAt: null,
              status: 'in-flight',
              queueId: 'default',
              position: 0,
              runId: 'run-m9-1',
              retryCount: 1,
              lastError: null,
              pausedReason: null,
              pipelineId: 'wf-1'
            },
            {
              id: 'default-task-2',
              description: 'Pending schema-9 task',
              enqueuedAt: now + 10,
              createdAt: now + 10,
              startedAt: null,
              updatedAt: now + 10,
              completedAt: null,
              status: 'pending',
              queueId: 'default',
              position: 1,
              runId: null,
              retryCount: 0,
              lastError: null,
              pausedReason: null,
              pipelineId: 'wf-1'
            }
          ],
          inFlightId: 'default-task-1',
          updatedAt: now + 100,
          queueLifecycle: 'running',
          pauseSource: null,
          pausedReason: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          failurePolicy: 'halt-on-failure'
        },
        'queue-02': {
          requests: [
            {
              id: 'q2-task-1',
              description: 'Completed sibling task',
              enqueuedAt: now,
              createdAt: now,
              startedAt: now + 10,
              updatedAt: now + 80,
              completedAt: now + 80,
              status: 'completed',
              queueId: 'queue-02',
              position: 0,
              runId: 'run-m9-2',
              retryCount: 0,
              lastError: null,
              pausedReason: null,
              pipelineId: 'wf-2',
              phaseProgress: { settled: 3, total: 3 }
            }
          ],
          inFlightId: null,
          updatedAt: now + 80,
          queueLifecycle: 'active-empty',
          pauseSource: null,
          pausedReason: null,
          scheduledStartAt: null,
          scheduledStartSource: null
        }
      };

      const sourceRuns = {
        default: {
          id: 'run-m9-1',
          featureId: 'default-task-1',
          featureDir: 'specs/316-sqlite-per-entity-rows',
          status: 'running',
          currentPhase: 'implement',
          currentIteration: 1,
          startedAt: now + 50,
          lastTransitionAt: now + 100,
          phasesCompleted: [],
          lastError: null,
          pipeline: { id: 'wf-1', name: 'WF 1', phases: [] },
          writtenAtFence: 4
        }
      };

      const sourceHistory = {
        'queue-02': [{ runId: 'run-m9-2', status: 'completed', completedAt: now + 80 }]
      };

      const sourceMemento = createSwitchableOperationalMemento(
        createMemoryMemento({
          [KEYS.schemaVersion]: 15,
          [KEYS.queue]: sourceQueues,
          [KEYS.run]: sourceRuns,
          [KEYS.history]: sourceHistory
        })
      );
      sourceMemento.attachSqlite(sourceStore, 'scope-bkp-m9', () => now + 200);

      // Take consistent online backup of schema-9 store
      const backup = await sourceStore.backupRestore.createOnlineBackup({
        backupId: 'bkp-m9-full',
        scopeId: 'scope-bkp-m9',
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['backups-m9']
      });
      expect(backup.manifest.schemaVersion).toBe(9);

      // Older target reader (`maxSupportedSchemaVersion = 8`) must reject schema-9 backup
      const rejectedOld = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        maxSupportedSchemaVersion: 8
      });
      expect(rejectedOld.status).toBe('rejected');
      if (rejectedOld.status === 'rejected') {
        expect(rejectedOld.reasonCode).toBe('UNSUPPORTED_SCHEMA_VERSION');
      }

      // Attach target memento with divergent data before restore to verify full replacement + cache reload
      const targetMemento = createSwitchableOperationalMemento(
        createMemoryMemento({
          [KEYS.schemaVersion]: 15,
          [KEYS.queue]: {
            stale: {
              requests: [],
              inFlightId: null,
              updatedAt: now,
              queueLifecycle: 'active-empty',
              pauseSource: null,
              pausedReason: null,
              scheduledStartAt: null,
              scheduledStartSource: null
            }
          }
        })
      );
      targetMemento.attachSqlite(targetStore, 'scope-bkp-m9', () => now + 300);

      const restored = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest
      });
      expect(restored.status).toBe('restored');
      if (restored.status === 'restored') {
        expect(restored.schemaVersion).toBe(9);
        expect(restored.restoredOperational?.queueMetaCount).toBe(2);
        expect(restored.restoredOperational?.taskCount).toBe(3);
        expect(restored.restoredOperational?.operationalRunCount).toBe(1);
      }

      // Reload operational cache from restored SQLite tables
      targetMemento.reloadSqliteCache();

      // Entity-for-entity comparison across every restored table and reconstructed operational view
      expect(targetMemento.get(KEYS.queue)).toEqual(sourceMemento.get(KEYS.queue));
      expect(targetMemento.get(KEYS.run)).toEqual(sourceMemento.get(KEYS.run));
      expect(targetMemento.get(KEYS.history)).toEqual(sourceMemento.get(KEYS.history));

      const tableOrderBy: readonly (readonly [string, string])[] = [
        ['runs', 'run_id ASC'],
        ['operational_queue_meta', 'scope_id ASC, queue_id ASC'],
        ['operational_tasks', 'scope_id ASC, queue_id ASC, position ASC, task_id ASC'],
        ['operational_runs', 'scope_id ASC, queue_id ASC'],
        ['operational_kv_documents', 'doc_namespace ASC, doc_key ASC'],
        ['cutover_sentinel', 'scope_id ASC']
      ];
      for (const [table, orderBy] of tableOrderBy) {
        const srcRows = sourceStore.writerConnection.all(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
        const dstRows = targetStore.writerConnection.all(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
        expect(dstRows, `table ${table}`).toEqual(srcRows);
      }

      // Hard Rule 69: created online backup file must be narrowed to owner-only permissions on POSIX
      if (process.platform !== 'win32') {
        const bkpStat = await fs.lstat(backup.backupDatabasePath);
        expect(bkpStat.mode & 0o077).toBe(0);
      }

      // Tampering with operational_tasks.payload_json without bumping revision must fail manifest digest check
      const tamperPath = path.join(rootDir, 'backups-m9', 'tampered.db');
      await fs.copyFile(backup.backupDatabasePath, tamperPath);
      const tamperConn = new NodeSqliteConnection({ databasePath: tamperPath, journalMode: 'wal' });
      try {
        tamperConn.run(
          `UPDATE operational_tasks SET payload_json = replace(payload_json, 'Pending schema-9 task', 'TAMPERED_TASK')`
        );
      } finally {
        tamperConn.close();
      }
      const tamperResult = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: tamperPath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(tamperResult.status).toBe('rejected');
      if (tamperResult.status === 'rejected') {
        expect(tamperResult.reasonCode).toBe('DATABASE_DIGEST_MISMATCH');
      }

      // Symlink backup target on restore must be refused
      const symlinkPath = path.join(rootDir, 'backups-m9', 'link-backup.db');
      await fs.symlink(backup.backupDatabasePath, symlinkPath);
      const symlinkResult = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: symlinkPath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(symlinkResult.status).toBe('rejected');
      if (symlinkResult.status === 'rejected') {
        expect(symlinkResult.reasonCode).toBe('BACKUP_OPEN_FAILED');
      }

      // Symlink traversal via unnormalized `..` under trustedRootDir must be refused
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-outside-bkp-'));
      tempDirs.push(outsideDir);
      await fs.mkdir(path.join(outsideDir, 'sub'));
      await fs.copyFile(backup.backupDatabasePath, path.join(outsideDir, 'escaped.db'));
      await fs.symlink(path.join(outsideDir, 'sub'), path.join(rootDir, 'backups-m9', 'escape-link'));
      const traversalResult = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: `${path.join(rootDir, 'backups-m9', 'escape-link')}/../escaped.db`,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(traversalResult.status).toBe('rejected');
      if (traversalResult.status === 'rejected') {
        expect(traversalResult.reasonCode).toBe('BACKUP_OPEN_FAILED');
      }

      // Symlinked SQLite -wal sidecar next to backup file must be refused
      const sidecarDbPath = path.join(rootDir, 'backups-m9', 'sidecar-test.db');
      await fs.copyFile(backup.backupDatabasePath, sidecarDbPath);
      await fs.symlink(backup.backupDatabasePath, `${sidecarDbPath}-wal`);
      const sidecarResult = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: sidecarDbPath,
        manifest: backup.manifest,
        trustedRootDir: rootDir
      });
      expect(sidecarResult.status).toBe('rejected');
      if (sidecarResult.status === 'rejected') {
        expect(sidecarResult.reasonCode).toBe('BACKUP_OPEN_FAILED');
      }

      // Pre-existing symlinked -journal sidecar at createOnlineBackup destination must be refused
      const prePlantedJournal = path.join(rootDir, 'backups-m9', 'with-sidecar.db-journal');
      await fs.symlink(path.join(rootDir, 'outside-journal.bin'), prePlantedJournal);
      await expect(
        sourceStore.backupRestore.createOnlineBackup({
          backupId: 'with-sidecar',
          scopeId: 'scope-bkp-m9',
          trustedRootDir: rootDir,
          relativeBackupDirSegments: ['backups-m9'],
          backupFileName: 'with-sidecar.db'
        })
      ).rejects.toThrow(/BACKUP_PATH_REFUSED/);

      // Dangling symlink at createOnlineBackup destination must be refused
      const danglingLink = path.join(rootDir, 'backups-m9', 'dangling.db');
      await fs.symlink(path.join(rootDir, 'outside-target.db'), danglingLink);
      await expect(
        sourceStore.backupRestore.createOnlineBackup({
          backupId: 'dangling',
          scopeId: 'scope-bkp-m9',
          trustedRootDir: rootDir,
          relativeBackupDirSegments: ['backups-m9'],
          backupFileName: 'dangling.db'
        })
      ).rejects.toThrow(/BACKUP_PATH_REFUSED/);
    } finally {
      sourceStore.close();
      targetStore.close();
    }
  });

  it('materializes restored schema-8 backup into schema-9 entity tables so subsequent single-entity mutations preserve all sibling queues and tasks', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-s8-to-s9-bkp-'));
    tempDirs.push(rootDir);
    const now = 1_763_660_000_000;

    // 1. Create a schema-8 database with 2 queues and 2 active Runs stored in operational_kv_documents
    const s8Path = path.join(rootDir, 's8-source.db');
    const s8Queues = {
      default: {
        requests: [
          { id: 'def-1', description: 'Default task 1', status: 'pending', enqueuedAt: now, updatedAt: now },
          { id: 'def-2', description: 'Default task 2', status: 'pending', enqueuedAt: now + 1, updatedAt: now + 1 }
        ],
        inFlightId: null,
        updatedAt: now,
        queueLifecycle: 'running'
      },
      'queue-sibling': {
        requests: [
          { id: 'sib-1', description: 'Sibling task 1', status: 'pending', enqueuedAt: now, updatedAt: now }
        ],
        inFlightId: null,
        updatedAt: now,
        queueLifecycle: 'running'
      }
    };
    const s8Runs = {
      default: { id: 'run-def', featureId: 'def-1', status: 'running', currentPhase: 'plan', startedAt: now, lastTransitionAt: now },
      'queue-sibling': { id: 'run-sib', featureId: 'sib-1', status: 'paused', currentPhase: 'tasks', startedAt: now, lastTransitionAt: now }
    };

    const s8Conn = new NodeSqliteConnection({ databasePath: s8Path, journalMode: 'wal' });
    let s8BackupPath: string;
    let s8Manifest: Awaited<ReturnType<SqliteApplicationStore['backupRestore']['createOnlineBackup']>>['manifest'];
    try {
      SchemaBootstrapService.bootstrapAndMigrate(
        s8Conn,
        () => now,
        BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8)
      );
      s8Conn.run(
        `INSERT INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
         VALUES ('scope-s8', 'sqlite', 'retain-source', 1, 'd', 'd', ?)`,
        now
      );
      for (const [k, v] of [
        [KEYS.queue, JSON.stringify(s8Queues)],
        [KEYS.run, JSON.stringify(s8Runs)]
      ] as const) {
        s8Conn.run(
          `INSERT INTO operational_kv_documents (doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms)
           VALUES ('scope-s8', ?, 1, 1, ?, ?, 0, ?)`,
          k,
          v,
          Buffer.byteLength(v, 'utf8'),
          now
        );
      }
      const s8BackupService = new BackupRestoreService(s8Conn, () => now + 10);
      const bkp = await s8BackupService.createOnlineBackup({
        backupId: 'bkp-s8',
        scopeId: 'scope-s8',
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['backups-s8']
      });
      s8BackupPath = bkp.backupDatabasePath;
      s8Manifest = bkp.manifest;
      expect(s8Manifest.schemaVersion).toBe(8);
    } finally {
      s8Conn.close();
    }

    // 2. Restore schema-8 backup onto a live schema-9 store, mutate 1 Task & 1 Run, and reload
    const targetStore = await SqliteApplicationStore.openAtTrustedLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['target-s9'],
      databaseFileName: 'target.db',
      sourceKind: 'host_storage_uri'
    });
    try {
      const targetMemento = createSwitchableOperationalMemento(createMemoryMemento());
      const backing = targetMemento.attachSqlite(targetStore, 'scope-s8', () => now + 50);

      const restored = targetStore.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: s8BackupPath,
        manifest: s8Manifest,
        trustedRootDir: rootDir
      });
      expect(restored.status).toBe('restored');
      if (restored.status === 'restored') {
        expect(restored.restoredOperational?.queueMetaCount).toBe(2);
        expect(restored.restoredOperational?.taskCount).toBe(3);
        expect(restored.restoredOperational?.operationalRunCount).toBe(2);
      }
      targetMemento.reloadSqliteCache();

      // Mutate only 1 task in `default` and only 1 run in `default`
      const currentQueues = backing.get<typeof s8Queues>(KEYS.queue)!;
      backing.update(KEYS.queue, {
        ...currentQueues,
        default: {
          ...currentQueues.default,
          requests: [
            { ...currentQueues.default.requests[0]!, description: 'Default task 1 updated' },
            currentQueues.default.requests[1]!
          ]
        }
      });
      const currentRuns = backing.get<typeof s8Runs>(KEYS.run)!;
      backing.update(KEYS.run, {
        ...currentRuns,
        default: { ...currentRuns.default, currentPhase: 'implement' }
      });

      // Reload from disk and prove every unchanged sibling queue, task, and run survived intact
      backing.reloadCacheFromSqlite();
      const reloadedQueues = backing.get<typeof s8Queues>(KEYS.queue)!;
      const reloadedRuns = backing.get<typeof s8Runs>(KEYS.run)!;
      expect(Object.keys(reloadedQueues).sort()).toEqual(['default', 'queue-sibling']);
      expect(reloadedQueues.default.requests.map((r) => r.description)).toEqual([
        'Default task 1 updated',
        'Default task 2'
      ]);
      expect(reloadedQueues['queue-sibling'].requests.map((r) => r.id)).toEqual(['sib-1']);
      expect(Object.keys(reloadedRuns).sort()).toEqual(['default', 'queue-sibling']);
      expect(reloadedRuns.default.currentPhase).toBe('implement');
      expect(reloadedRuns['queue-sibling'].id).toBe('run-sib');
    } finally {
      targetStore.close();
    }
  });
});
