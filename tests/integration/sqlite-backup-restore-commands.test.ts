/**
 * FR-R7-14 (14-01, 14-02) — Integration suite for SQLite backup/verify/restore
 * operator commands (`runBackupStore`, `runVerifyStoreBackup`, `runRestoreStoreBackup`):
 * - 14-01: Backup -> verify -> real `ArtifactLifecycleService` deletion (`workspace_file`)
 *   and CAS expiry/eviction (`cas_blob`) -> backup -> verify -> restore -> reopen,
 *   proving deletion tombstones survive restore, deleted bytes stay absent, and a missing
 *   or corrupt *live* dependency still refuses verify/restore before target mutation.
 * - 14-02: Creation-time & verification-time bounds parity (`limit - 1`, `limit`, `limit + 1`)
 *   through the command boundary with full rollback cleanup and zero selectable unusable backups.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import {
  runBackupStore,
  runRestoreStoreBackup,
  runVerifyStoreBackup,
  type BackupPickerItem,
  type BackupRestoreCommandUi
} from '../../src/commands/sqlite-backup-restore';
import type { MutationAuthority } from '../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  createStoreBackupRestoreApi,
  createWorkspaceExternalDependencyInspector
} from '../../src/headless/backup-restore-api';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactByteProbe,
  type ArtifactLocator,
  type LifecycleFs,
  type LifecycleFsEntry
} from '../../src/services/artifact-lifecycle';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { removeTempRoot } from '../temp-root-cleanup';

const FULL_AUTHORITY: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createStubUi(): {
  readonly ui: BackupRestoreCommandUi;
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    ui: {
      async pickBackup(items: readonly BackupPickerItem[]) {
        return items[0];
      },
      async confirmModal() {
        return true;
      },
      info(message: string) {
        infos.push(message);
      },
      warn(message: string) {
        warns.push(message);
      },
      error(message: string) {
        errors.push(message);
      }
    }
  };
}

function createDiskLifecycleFs(): LifecycleFs {
  return {
    async lstat(absolutePath: string): Promise<LifecycleFsEntry | null> {
      try {
        const st = await fs.lstat(absolutePath);
        const kind = st.isSymbolicLink()
          ? 'symlink'
          : st.isDirectory()
            ? 'directory'
            : st.isFile()
              ? 'file'
              : 'other';
        return { kind, sizeBytes: st.size, mtimeMs: st.mtimeMs };
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
        throw err;
      }
    },
    async readdir(absolutePath: string): Promise<readonly string[]> {
      return (await fs.readdir(absolutePath)).sort();
    },
    realpath(absolutePath: string): Promise<string> {
      return fs.realpath(absolutePath);
    },
    async unlink(absolutePath: string): Promise<void> {
      await fs.unlink(absolutePath);
    }
  };
}

function createDiskByteProbe(workspaceRoot: string): ArtifactByteProbe {
  const absOf = (locator: ArtifactLocator) => path.join(workspaceRoot, locator.uriOrRelpath);
  return {
    async observe(locator) {
      try {
        const bytes = await fs.readFile(absOf(locator));
        return {
          exists: true,
          sizeBytes: bytes.byteLength,
          producerIdentity: 'integration-test',
          generation: null
        };
      } catch {
        return {
          exists: false,
          sizeBytes: 0,
          producerIdentity: null,
          generation: null
        };
      }
    },
    async digestSha256(locator) {
      try {
        return sha256Hex(await fs.readFile(absOf(locator)));
      } catch {
        return null;
      }
    }
  };
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe('SQLite backup/verify/restore commands integration (FR-R7-14 14-01 & 14-02)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempRoot(dir);
    }
  });

  it('14-01: preserves workspace-file and CAS deletion tombstones across backup -> verify -> lifecycle delete -> backup -> verify -> restore -> reopen while refusing missing or corrupt live dependencies', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-14-01-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-14-01-store-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-14-01';
    const now = 1_763_930_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dbDir, 'schegent-state.db');

    let store = new SqliteApplicationStore({
      databasePath: dbPath,
      journalMode: 'wal',
      nowMs: () => now
    });
    const auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger([]));
    let reloadCount = 0;

    const api = createStoreBackupRestoreApi({
      getSqliteStore: () => store,
      trustedRootDir: storageRoot,
      scopeId,
      hasPrimacy: async () => true,
      hasInFlightRun: () => false,
      reloadAfterRestore: () => {
        reloadCount += 1;
      },
      inspectExternalDependency: createWorkspaceExternalDependencyInspector(workspaceRoot),
      auditWriter,
      nowMs: () => now
    });

    try {
      const reportsDir = path.join(workspaceRoot, '.schegent', 'reports');
      const casDir = path.join(workspaceRoot, '.schegent', 'cas');
      await fs.mkdir(reportsDir, { recursive: true });
      await fs.mkdir(casDir, { recursive: true });

      const wsDeleteRel = '.schegent/reports/deletable-report.json';
      const wsDeleteBytes = Buffer.from('{"report":"deletable-via-lifecycle"}');
      await fs.writeFile(path.join(workspaceRoot, wsDeleteRel), wsDeleteBytes);

      const wsLiveRel = '.schegent/reports/live-report.json';
      const wsLiveBytes = Buffer.from('{"report":"live-must-stay-intact"}');
      await fs.writeFile(path.join(workspaceRoot, wsLiveRel), wsLiveBytes);

      const casExpiredRel = '.schegent/cas/expired-blob.bin';
      const casExpiredBytes = Buffer.from('cas-blob-to-expire-via-lifecycle');
      await fs.writeFile(path.join(workspaceRoot, casExpiredRel), casExpiredBytes);

      const casEvictedRel = '.schegent/cas/evicted-blob.bin';
      const casEvictedBytes = Buffer.from('cas-blob-to-evict-via-availability');
      await fs.writeFile(path.join(workspaceRoot, casEvictedRel), casEvictedBytes);

      const casLiveRel = '.schegent/cas/live-blob.bin';
      const casLiveBytes = Buffer.from('cas-blob-live-required');
      await fs.writeFile(path.join(workspaceRoot, casLiveRel), casLiveBytes);

      let idSeq = 0;
      const lifecycle = createArtifactLifecycleService({
        conn: store.writerConnection,
        nowMs: () => now,
        fs: createDiskLifecycleFs(),
        probe: createDiskByteProbe(workspaceRoot),
        audit: { recordLifecycleMutation: () => undefined },
        scanRoots: [
          {
            rootId: 'reports',
            root: reportsDir,
            retentionClass: 'generated-reports-handoff-exports',
            storeKind: 'report'
          }
        ],
        accessPolicy: DENY_ALL_ACCESS_POLICY,
        resolveOwner: () => 'settled',
        newId: () => `lc-id-${(idSeq += 1)}`,
        workspaceRoot
      });

      // Register both workspace_file artifacts and lifecycle-managed CAS artifact via ArtifactLifecycleService
      const regDelete = lifecycle.registerArtifact({
        artifactId: 'art-ws-delete',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'report',
        sensitivity: 'metadata',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: sha256Hex(wsDeleteBytes) },
        byteSize: wsDeleteBytes.byteLength,
        producerIdentity: 'integration-test',
        displayName: 'deletable-report.json',
        mediaType: 'application/json',
        locator: { storageTier: 'workspace_file', uriOrRelpath: wsDeleteRel }
      });
      expect(regDelete.ok).toBe(true);

      const regLive = lifecycle.registerArtifact({
        artifactId: 'art-ws-live',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'report',
        sensitivity: 'metadata',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: sha256Hex(wsLiveBytes) },
        byteSize: wsLiveBytes.byteLength,
        producerIdentity: 'integration-test',
        displayName: 'live-report.json',
        mediaType: 'application/json',
        locator: { storageTier: 'workspace_file', uriOrRelpath: wsLiveRel }
      });
      expect(regLive.ok).toBe(true);

      const regCasExpired = lifecycle.registerArtifact({
        artifactId: 'art-cas-expired',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'report',
        sensitivity: 'metadata',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: sha256Hex(casExpiredBytes) },
        byteSize: casExpiredBytes.byteLength,
        producerIdentity: 'integration-test',
        displayName: 'expired-blob.bin',
        mediaType: 'application/octet-stream',
        locator: { storageTier: 'cas_blob', uriOrRelpath: casExpiredRel }
      });
      expect(regCasExpired.ok).toBe(true);

      // Register availability-only CAS artifacts via ArtifactStoreAdapter (no artifact_lifecycle row)
      store.artifacts.registerArtifact({
        artifactId: 'art-cas-evicted',
        contentSha256: sha256Hex(casEvictedBytes),
        byteLength: casEvictedBytes.byteLength,
        mediaType: 'application/octet-stream',
        kind: 'cas-artifact',
        location: {
          locationId: 'loc-cas-evicted',
          storageTier: 'cas_blob',
          uriOrRelpath: casEvictedRel
        },
        availabilityState: 'available'
      });
      store.artifacts.registerArtifact({
        artifactId: 'art-cas-live',
        contentSha256: sha256Hex(casLiveBytes),
        byteLength: casLiveBytes.byteLength,
        mediaType: 'application/octet-stream',
        kind: 'cas-artifact',
        location: {
          locationId: 'loc-cas-live',
          storageTier: 'cas_blob',
          uriOrRelpath: casLiveRel
        },
        availabilityState: 'available'
      });

      const ui = createStubUi();

      // Step 1: Backup and verify BEFORE deletion -> all 5 live artifacts verified
      const bkpBefore = await runBackupStore({ api, ui: ui.ui }, { backupId: 'bkp-before-del' });
      expect(bkpBefore.status).toBe('created');
      const verifyBefore = await runVerifyStoreBackup(
        { api, ui: ui.ui },
        { backupId: 'bkp-before-del' }
      );
      expect(verifyBefore).toMatchObject({
        status: 'verified',
        verifiedExternalDependencies: 5
      });

      // Step 2: Delete workspace_file via real ArtifactLifecycleService (removes bytes + sets lifecycle deleted)
      const preview = lifecycle.previewDeletion({ artifactIds: ['art-ws-delete'] });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error('preview failed');
      const deletion = await lifecycle.executeDeletion({
        artifactIds: ['art-ws-delete'],
        previewId: preview.value.previewId,
        confirmation: 'confirmed',
        authority: FULL_AUTHORITY
      });
      expect(deletion.ok).toBe(true);
      if (!deletion.ok) throw new Error('deletion failed');
      expect(deletion.value.state).toBe('completed');
      expect(await fileExists(path.join(workspaceRoot, wsDeleteRel))).toBe(false);

      // Expire lifecycle-managed CAS blob and evict availability-managed CAS blob, removing bytes on disk
      store.writerConnection.run(
        `UPDATE artifact_lifecycle SET availability = 'expired', lifecycle_revision = lifecycle_revision + 1, updated_at_ms = ?
         WHERE artifact_id = 'art-cas-expired'`,
        now + 10
      );
      await fs.unlink(path.join(workspaceRoot, casExpiredRel));

      store.writerConnection.run(
        `UPDATE artifact_availability SET state = 'evicted', last_verified_at_ms = ?
         WHERE artifact_id = 'art-cas-evicted'`,
        now + 10
      );
      await fs.unlink(path.join(workspaceRoot, casEvictedRel));

      // Step 3: Create Backup #2 and Verify #2 AFTER deletion -> succeeds with only the 2 live artifacts!
      const bkpAfter = await runBackupStore({ api, ui: ui.ui }, { backupId: 'bkp-after-del' });
      expect(bkpAfter.status).toBe('created');
      if (bkpAfter.status !== 'created') throw new Error('backup after deletion failed');
      expect(bkpAfter.manifest.externalDependencies.map((d) => d.referenceId)).toEqual([
        'art-cas-live',
        'art-ws-live'
      ]);

      const verifyAfter = await runVerifyStoreBackup(
        { api, ui: ui.ui },
        { backupId: 'bkp-after-del' }
      );
      expect(verifyAfter).toMatchObject({
        status: 'verified',
        verifiedExternalDependencies: 2
      });

      // Step 4: Mutate live DB post-backup, then restore Backup #2 via operator command
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-post-del-mutation', ?, 'wf-mut', 'succeeded', 1, ?, ?)`,
        scopeId,
        now + 100,
        now + 100
      );

      const restored = await runRestoreStoreBackup(
        { api, ui: ui.ui },
        { backupId: 'bkp-after-del' }
      );
      expect(restored).toMatchObject({
        status: 'restored',
        outcome: 'restored',
        verifiedExternalDependencies: 2
      });
      expect(reloadCount).toBe(1);

      // Step 5: Close and reopen from disk — verify tombstones survived, deleted bytes stayed absent, post-backup mutation gone
      store.close();
      store = new SqliteApplicationStore({
        databasePath: dbPath,
        journalMode: 'wal',
        nowMs: () => now + 200
      });

      expect(store.writerConnection.all(`SELECT run_id FROM runs`)).toEqual([]);
      expect(
        store.writerConnection.get<{ availability: string }>(
          `SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-ws-delete'`
        )
      ).toEqual({ availability: 'deleted' });
      expect(
        store.writerConnection.get<{ availability: string }>(
          `SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-cas-expired'`
        )
      ).toEqual({ availability: 'expired' });
      expect(
        store.writerConnection.get<{ state: string }>(
          `SELECT state FROM artifact_availability WHERE artifact_id = 'art-cas-evicted'`
        )
      ).toEqual({ state: 'evicted' });
      // Tombstone artifact_locations rows survive intact alongside deletion_operations history
      expect(
        store.writerConnection.scalar<number>(`SELECT COUNT(*) FROM artifact_locations`)
      ).toBe(5);
      expect(
        store.writerConnection.scalar<number>(`SELECT COUNT(*) FROM deletion_operations`)
      ).toBe(1);
      expect(await fileExists(path.join(workspaceRoot, wsDeleteRel))).toBe(false);
      expect(await fileExists(path.join(workspaceRoot, casExpiredRel))).toBe(false);
      expect(await fileExists(path.join(workspaceRoot, casEvictedRel))).toBe(false);

      // Step 6: Corrupting or removing a *live* dependency (workspace_file OR cas_blob) MUST still refuse verify/restore before mutating target!
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-live-untouched', ?, 'wf-live', 'succeeded', 1, ?, ?)`,
        scopeId,
        now + 300,
        now + 300
      );

      // 6a. Corrupt live CAS blob
      await fs.writeFile(path.join(workspaceRoot, casLiveRel), Buffer.from('corrupted-live-cas-bytes'));
      expect(
        await runVerifyStoreBackup({ api, ui: ui.ui }, { backupId: 'bkp-after-del' })
      ).toMatchObject({ status: 'rejected', reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT' });
      expect(
        await runRestoreStoreBackup({ api, ui: ui.ui }, { backupId: 'bkp-after-del' })
      ).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
      });
      // Restore valid CAS blob and remove live workspace_file
      await fs.writeFile(path.join(workspaceRoot, casLiveRel), casLiveBytes);
      await fs.unlink(path.join(workspaceRoot, wsLiveRel));
      expect(
        await runRestoreStoreBackup({ api, ui: ui.ui }, { backupId: 'bkp-after-del' })
      ).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
      });

      // Live target DB remained completely untouched across both refusals
      expect(
        store.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs`)
          .map((r) => r.run_id)
      ).toEqual(['run-live-untouched']);
      expect(reloadCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it('14-02: enforces creation/verification bounds parity (limit-1, limit, limit+1) through commands with zero leftover partial backups and sanitized audit entries', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-14-02-cmd-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-14-02-cmd-st-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-14-02-cmd';
    const now = 1_763_940_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
    const store = new SqliteApplicationStore({
      databasePath: path.join(dbDir, 'schegent-state.db'),
      journalMode: 'wal',
      nowMs: () => now
    });
    const auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger([]));
    const api = createStoreBackupRestoreApi({
      getSqliteStore: () => store,
      trustedRootDir: storageRoot,
      scopeId,
      hasPrimacy: async () => true,
      hasInFlightRun: () => false,
      reloadAfterRestore: () => undefined,
      inspectExternalDependency: createWorkspaceExternalDependencyInspector(workspaceRoot),
      auditWriter,
      nowMs: () => now
    });

    try {
      await fs.mkdir(path.join(workspaceRoot, 'ext'), { recursive: true });
      for (let i = 1; i <= 4; i += 1) {
        const rel = `ext/dep-${i}.bin`;
        const data = Buffer.alloc(250, 0x60 + i); // 4 x 250 = 1,000 bytes
        await fs.writeFile(path.join(workspaceRoot, rel), data);
        store.artifacts.registerArtifact({
          artifactId: `dep-${i}`,
          contentSha256: sha256Hex(data),
          byteLength: data.byteLength,
          mediaType: 'application/octet-stream',
          kind: 'blob',
          location: { locationId: `loc-${i}`, storageTier: 'cas_blob', uriOrRelpath: rel }
        });
      }

      const ui = createStubUi();

      // Count limit+1 violation (4 deps > maxExternalDependencies: 3) -> refused cleanly, zero files created
      const overCount = await runBackupStore(
        { api, ui: ui.ui },
        { backupId: 'bkp-cmd-over-count', maxExternalDependencies: 3 }
      );
      expect(overCount).toMatchObject({
        status: 'failed',
        errorCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED'
      });
      expect(await api.listBackups()).toEqual([]);

      // Cumulative bytes limit+1 violation (1,000 B > maxExternalDependencyBytes: 999) -> refused cleanly, zero files created
      const overBytes = await runBackupStore(
        { api, ui: ui.ui },
        { backupId: 'bkp-cmd-over-bytes', maxExternalDependencyBytes: 999 }
      );
      expect(overBytes).toMatchObject({
        status: 'failed',
        errorCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED'
      });
      expect(await api.listBackups()).toEqual([]);

      // Exact at-limit creation (4 deps, 1,000 B) -> succeeds and verifies identically at limit and limit+1
      const atLimit = await runBackupStore(
        { api, ui: ui.ui },
        {
          backupId: 'bkp-cmd-at-limit',
          maxExternalDependencies: 4,
          maxExternalDependencyBytes: 1000
        }
      );
      expect(atLimit.status).toBe('created');
      if (atLimit.status !== 'created') throw new Error('expected created');

      expect(
        await runVerifyStoreBackup(
          { api, ui: ui.ui },
          { backupId: 'bkp-cmd-at-limit', maxExternalDependencies: 4, maxExternalDependencyBytes: 1000 }
        )
      ).toMatchObject({ status: 'verified', verifiedExternalDependencies: 4 });
      expect(
        await runVerifyStoreBackup(
          { api, ui: ui.ui },
          { backupId: 'bkp-cmd-at-limit', maxExternalDependencies: 5, maxExternalDependencyBytes: 1001 }
        )
      ).toMatchObject({ status: 'verified', verifiedExternalDependencies: 4 });
      expect(
        await runVerifyStoreBackup(
          { api, ui: ui.ui },
          { backupId: 'bkp-cmd-at-limit', maxExternalDependencies: 3 }
        )
      ).toMatchObject({ status: 'rejected', reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED' });

      // Over-limit database image creation leaves zero selectable partial backups
      const overDbCreate = await runBackupStore(
        { api, ui: ui.ui },
        { backupId: 'bkp-cmd-over-db', maxDatabaseBytes: atLimit.manifest.databaseBytes - 1 }
      );
      expect(overDbCreate).toMatchObject({
        status: 'failed',
        errorCode: 'RESTORE_IMAGE_BOUND_EXCEEDED'
      });
      expect((await api.listBackups()).map((e) => e.backupId)).toEqual(['bkp-cmd-at-limit']);

      // Over-limit image on restore refuses before mutating live store
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-live-stay', ?, 'wf-stay', 'succeeded', 1, ?, ?)`,
        scopeId,
        now + 50,
        now + 50
      );
      const overDbRestore = await runRestoreStoreBackup(
        { api, ui: ui.ui },
        { backupId: 'bkp-cmd-at-limit', maxDatabaseBytes: atLimit.manifest.databaseBytes - 1 }
      );
      expect(overDbRestore).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED'
      });
      expect(
        store.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`).map((r) => r.run_id)
      ).toEqual(['run-live-stay']);

      // Audit log contains zero raw paths across all creations, refusals, and failures
      const auditText = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      expect(auditText).not.toContain(workspaceRoot);
      expect(auditText).not.toContain(storageRoot);
    } finally {
      store.close();
    }
  });
});
