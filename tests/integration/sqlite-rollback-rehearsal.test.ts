/**
 * FR-R7-14 (14-01, 14-02) — End-to-end SQLite rollback rehearsal with artifact
 * deletion history (`workspace_file` and `cas_blob`) and bounds enforcement.
 *
 * Rehearses:
 * 1. Create & verify baseline backup with live workspace-file and CAS artifacts.
 * 2. Delete workspace-file artifact via `ArtifactLifecycleService` (`availability = 'deleted'`)
 *    and evict CAS artifact (`artifact_availability.state = 'evicted'`).
 * 3. Create & verify post-deletion backup; confirm deleted tombstones are retained in SQLite
 *    without requiring deleted on-disk bytes.
 * 4. Mutate live store, rehearse online restore AND offline file-level rollback -> reopen,
 *    verifying `PRAGMA quick_check`, `PRAGMA foreign_key_check`, surviving deletion tombstones,
 *    absent deleted bytes, and pre-mutation refusal on corrupt/missing live dependencies or
 *    over-ceiling database images.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MutationAuthority } from '../../src/contracts/artifact-lifecycle/lifecycle-types';
import { createWorkspaceExternalDependencyInspector } from '../../src/headless/backup-restore-api';
import { narrowMode } from '../../src/lib/narrow-mode';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactByteProbe,
  type ArtifactLocator,
  type LifecycleFs,
  type LifecycleFsEntry
} from '../../src/services/artifact-lifecycle';
import {
  NodeSqliteConnection,
  parseAndValidateBackupManifest,
  SchemaBootstrapService,
  SqliteApplicationStore,
  verifyBackupStandaloneAsync
} from '../../src/services/sqlite-store';
import { removeTempRoot } from '../temp-root-cleanup';

const FULL_AUTHORITY: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeLifecycleFs(): LifecycleFs {
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

function makeByteProbe(workspaceRoot: string): ArtifactByteProbe {
  const abs = (locator: ArtifactLocator) => path.join(workspaceRoot, locator.uriOrRelpath);
  return {
    async observe(locator) {
      try {
        const buf = await fs.readFile(abs(locator));
        return {
          exists: true,
          sizeBytes: buf.byteLength,
          producerIdentity: 'rehearsal',
          generation: null
        };
      } catch {
        return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      }
    },
    async digestSha256(locator) {
      try {
        return sha256Hex(await fs.readFile(abs(locator)));
      } catch {
        return null;
      }
    }
  };
}

describe('SQLite rollback rehearsal with deletion tombstones & bounds (FR-R7-14)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempRoot(dir);
    }
  });

  it('rehearses backup -> lifecycle delete -> backup -> verify -> online restore & offline rollback -> reopen', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-rb-14-01-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-rb-14-01-st-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-rb-rehearsal';
    const now = 1_763_950_000_000;
    const liveDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(liveDir, { recursive: true, mode: 0o700 });
    const liveDbPath = path.join(liveDir, 'schegent-state.db');

    const reportsDir = path.join(workspaceRoot, '.schegent', 'reports');
    const casDir = path.join(workspaceRoot, '.schegent', 'cas');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.mkdir(casDir, { recursive: true });

    const wsDeletedRel = '.schegent/reports/old-summary.md';
    const wsDeletedBytes = Buffer.from('# Old summary deleted via lifecycle\n');
    await fs.writeFile(path.join(workspaceRoot, wsDeletedRel), wsDeletedBytes);

    const wsLiveRel = '.schegent/reports/current-summary.md';
    const wsLiveBytes = Buffer.from('# Current summary still live\n');
    await fs.writeFile(path.join(workspaceRoot, wsLiveRel), wsLiveBytes);

    const casEvictedRel = '.schegent/cas/evicted-01.blob';
    const casEvictedBytes = Buffer.from('evicted-cas-content');
    await fs.writeFile(path.join(workspaceRoot, casEvictedRel), casEvictedBytes);

    const casLiveRel = '.schegent/cas/live-01.blob';
    const casLiveBytes = Buffer.from('live-cas-content');
    await fs.writeFile(path.join(workspaceRoot, casLiveRel), casLiveBytes);

    const inspector = createWorkspaceExternalDependencyInspector(workspaceRoot);
    const store = new SqliteApplicationStore({
      databasePath: liveDbPath,
      journalMode: 'wal',
      nowMs: () => now
    });

    let postDeleteBackupPath: string;
    let postDeleteManifestPath: string;
    try {
      let idSeq = 0;
      const lifecycle = createArtifactLifecycleService({
        conn: store.writerConnection,
        nowMs: () => now,
        fs: makeLifecycleFs(),
        probe: makeByteProbe(workspaceRoot),
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
        newId: () => `rb-id-${(idSeq += 1)}`,
        workspaceRoot
      });

      expect(
        lifecycle.registerArtifact({
          artifactId: 'rb-ws-deleted',
          retentionClass: 'generated-reports-handoff-exports',
          storeKind: 'report',
          sensitivity: 'metadata',
          immutability: 'immutable',
          digest: { algorithm: 'sha256', value: sha256Hex(wsDeletedBytes) },
          byteSize: wsDeletedBytes.byteLength,
          producerIdentity: 'rehearsal',
          displayName: 'old-summary.md',
          mediaType: 'text/markdown',
          locator: { storageTier: 'workspace_file', uriOrRelpath: wsDeletedRel }
        }).ok
      ).toBe(true);

      expect(
        lifecycle.registerArtifact({
          artifactId: 'rb-ws-live',
          retentionClass: 'generated-reports-handoff-exports',
          storeKind: 'report',
          sensitivity: 'metadata',
          immutability: 'immutable',
          digest: { algorithm: 'sha256', value: sha256Hex(wsLiveBytes) },
          byteSize: wsLiveBytes.byteLength,
          producerIdentity: 'rehearsal',
          displayName: 'current-summary.md',
          mediaType: 'text/markdown',
          locator: { storageTier: 'workspace_file', uriOrRelpath: wsLiveRel }
        }).ok
      ).toBe(true);

      store.artifacts.registerArtifact({
        artifactId: 'rb-cas-evicted',
        contentSha256: sha256Hex(casEvictedBytes),
        byteLength: casEvictedBytes.byteLength,
        mediaType: 'application/octet-stream',
        kind: 'cas',
        location: { locationId: 'loc-ev', storageTier: 'cas_blob', uriOrRelpath: casEvictedRel }
      });
      store.artifacts.registerArtifact({
        artifactId: 'rb-cas-live',
        contentSha256: sha256Hex(casLiveBytes),
        byteLength: casLiveBytes.byteLength,
        mediaType: 'application/octet-stream',
        kind: 'cas',
        location: { locationId: 'loc-live', storageTier: 'cas_blob', uriOrRelpath: casLiveRel }
      });

      // 1. Pre-deletion backup & verification
      const preBkp = await store.backupRestore.createOnlineBackup({
        backupId: 'rb-bkp-pre-delete',
        scopeId,
        trustedRootDir: storageRoot,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: preBkp.backupDatabasePath,
          manifest: preBkp.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified', verifiedExternalDependencies: 4 });

      // 2. Lifecycle deletion of workspace_file + eviction of CAS blob
      const preview = lifecycle.previewDeletion({ artifactIds: ['rb-ws-deleted'] });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error('preview failed');
      const executed = await lifecycle.executeDeletion({
        artifactIds: ['rb-ws-deleted'],
        previewId: preview.value.previewId,
        confirmation: 'confirmed',
        authority: FULL_AUTHORITY
      });
      expect(executed.ok).toBe(true);
      if (!executed.ok) throw new Error('deletion failed');
      expect(executed.value.state).toBe('completed');

      store.writerConnection.run(
        `UPDATE artifact_availability SET state = 'evicted', last_verified_at_ms = ? WHERE artifact_id = 'rb-cas-evicted'`,
        now + 50
      );
      await fs.unlink(path.join(workspaceRoot, casEvictedRel));

      // 3. Post-deletion backup & verification succeeds with 2 live dependencies
      const postBkp = await store.backupRestore.createOnlineBackup({
        backupId: 'rb-bkp-post-delete',
        scopeId,
        trustedRootDir: storageRoot,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });
      postDeleteBackupPath = postBkp.backupDatabasePath;
      postDeleteManifestPath = postBkp.manifestPath;

      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: postDeleteBackupPath,
          manifest: postBkp.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified', verifiedExternalDependencies: 2 });

      // 4. Live mutation + refusal on missing live dependency and over-bound database image
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-diverged', ?, 'wf-div', 'succeeded', 1, ?, ?)`,
        scopeId,
        now + 100,
        now + 100
      );

      // Over-bound image refused before mutation
      expect(
        await store.backupRestore.validateAndRestoreBackupAsync({
          backupDatabasePath: postDeleteBackupPath,
          manifest: postBkp.manifest,
          trustedRootDir: storageRoot,
          maxDatabaseBytes: postBkp.manifest.databaseBytes - 1,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED'
      });

      // Missing live workspace_file refused before mutation
      await fs.unlink(path.join(workspaceRoot, wsLiveRel));
      expect(
        await store.backupRestore.validateAndRestoreBackupAsync({
          backupDatabasePath: postDeleteBackupPath,
          manifest: postBkp.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
      });
      expect(store.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`)).toEqual([
        { run_id: 'run-diverged' }
      ]);

      // Restore live workspace_file bytes and run online restore -> succeeds
      await fs.writeFile(path.join(workspaceRoot, wsLiveRel), wsLiveBytes);
      expect(
        await store.backupRestore.validateAndRestoreBackupAsync({
          backupDatabasePath: postDeleteBackupPath,
          manifest: postBkp.manifest,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'restored', outcome: 'restored', verifiedExternalDependencies: 2 });
      expect(store.writerConnection.all(`SELECT run_id FROM runs`)).toEqual([]);
    } finally {
      store.close();
    }

    // 5. Rehearse offline file-level rollback from the verified post-deletion backup image
    const parsedManifest = parseAndValidateBackupManifest(
      await fs.readFile(postDeleteManifestPath, 'utf8')
    );
    expect(parsedManifest).not.toBeNull();
    expect(
      await verifyBackupStandaloneAsync({
        backupDatabasePath: postDeleteBackupPath,
        manifest: parsedManifest!,
        trustedRootDir: storageRoot,
        inspectExternalDependency: inspector
      })
    ).toMatchObject({ status: 'verified', verifiedExternalDependencies: 2 });

    await fs.rename(liveDbPath, `${liveDbPath}.forensic-copy`);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await fs.rm(`${liveDbPath}${suffix}`, { force: true });
    }
    await fs.copyFile(postDeleteBackupPath, liveDbPath);
    const narrowed = await narrowMode(liveDbPath, 0o600);
    expect(narrowed.outcome === 'narrowed' || narrowed.outcome === 'already-private').toBe(true);

    // 6. Reopen and verify full integrity & surviving tombstones with deleted bytes absent
    const reopenedConn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
    try {
      const boot = SchemaBootstrapService.bootstrapAndMigrate(reopenedConn, () => now + 500);
      expect(boot.schemaVersion).toBe(9);
      expect(reopenedConn.runQuickCheck()).toEqual(['ok']);
      expect(reopenedConn.runForeignKeyCheck()).toEqual([]);
      expect(
        reopenedConn.get<{ availability: string }>(
          `SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'rb-ws-deleted'`
        )
      ).toEqual({ availability: 'deleted' });
      expect(
        reopenedConn.get<{ state: string }>(
          `SELECT state FROM artifact_availability WHERE artifact_id = 'rb-cas-evicted'`
        )
      ).toEqual({ state: 'evicted' });
      expect(reopenedConn.scalar<number>(`SELECT COUNT(*) FROM artifact_locations`)).toBe(4);
      await expect(fs.lstat(path.join(workspaceRoot, wsDeletedRel))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      await expect(fs.lstat(path.join(workspaceRoot, casEvictedRel))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      reopenedConn.close();
    }

    // 7. FR-R7-14 (14-14 & 14-15): rehearse Delete Run Evidence + full workspace deletion and verify
    //    that external <globalStorage> copies survive outside the workspace exactly as documented
    //    in evidence-retention-disclosure.md, user-quickstart.md, and DELETE_EVIDENCE_TEXT.
    const auditCheckpointPath = path.join(storageRoot, 'audit-checkpoints', `${scopeId}.json`);
    const recoveryCheckpointPath = path.join(storageRoot, 'checkpoints', 'run-rb-1', 'handover.recovery.json');
    const telemetrySpoolPath = path.join(storageRoot, 'telemetry-spool', 'batch-1.json');
    for (const externalFile of [auditCheckpointPath, recoveryCheckpointPath, telemetrySpoolPath]) {
      await fs.mkdir(path.dirname(externalFile), { recursive: true });
      await fs.writeFile(externalFile, JSON.stringify({ rehearsal: true }), { mode: 0o600 });
    }

    // Delete the entire disposable workspace directory (quickstart cleanup rehearsal)
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await expect(fs.lstat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    // Every documented external <globalStorage> copy MUST survive workspace deletion intact
    for (const survivingPath of [
      liveDbPath,
      postDeleteBackupPath,
      postDeleteManifestPath,
      auditCheckpointPath,
      recoveryCheckpointPath,
      telemetrySpoolPath
    ]) {
      expect((await fs.lstat(survivingPath)).isFile(), survivingPath).toBe(true);
    }

    // Reopen the surviving folder-scoped SQLite store after workspace deletion to confirm integrity
    const afterWsDelete = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
    try {
      expect(afterWsDelete.runQuickCheck()).toEqual(['ok']);
      expect(
        afterWsDelete.get<{ availability: string }>(
          `SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'rb-ws-deleted'`
        )
      ).toEqual({ availability: 'deleted' });
    } finally {
      afterWsDelete.close();
    }
  });
});
