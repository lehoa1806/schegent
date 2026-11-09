import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';

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
});
