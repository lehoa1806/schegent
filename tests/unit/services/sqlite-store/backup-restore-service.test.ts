/**
 * FR-R7-14 (14-01, 14-02, 14-03) — Unit coverage for:
 * - Lifecycle-aware external dependency classification & fail-closed collection
 * - Symmetric creation/verification/restore bounds (`limit - 1`, `limit`, `limit + 1`)
 *   for external dependency count, cumulative bytes, manifest bytes, and database bytes
 * - Complete rollback cleanup of `.db`, `.tmp`, `.manifest.json`, and SQLite sidecars on creation failure
 * - Async chunked SHA-256 verification and pre-commit fencing in `validateAndRestoreBackupAsync`
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKUP_EXTERNAL_DEPENDENCIES,
  MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES
} from '../../../../src/contracts/sqlite-store/schema-types';
import { createWorkspaceExternalDependencyInspector } from '../../../../src/headless/backup-restore-api';
import {
  BackupRestoreService,
  classifyExternalArtifactDependencies,
  collectExternalDependenciesFromConn,
  computeFileDigestAsync,
  computeFileDigestSync,
  listBackupsInRoot,
  MAX_BACKUP_DATABASE_BYTES,
  MAX_BACKUP_MANIFEST_BYTES,
  NodeSqliteConnection,
  resolveBackupBounds,
  SqliteApplicationStore,
  verifyBackupStandalone,
  verifyBackupStandaloneAsync
} from '../../../../src/services/sqlite-store';
import { removeTempRoot } from '../../../temp-root-cleanup';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('FR-R7-14 BackupRestoreService unit suite (14-01, 14-02, 14-03)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempRoot(dir);
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function insertArtifactRow(
    conn: NodeSqliteConnection,
    params: {
      readonly artifactId: string;
      readonly locationId: string;
      readonly storageTier: 'workspace_file' | 'cas_blob' | 'inline_db';
      readonly relpath: string;
      readonly content: Buffer;
      readonly now: number;
      readonly lifecycleAvailability?:
        | 'present'
        | 'pending'
        | 'missing'
        | 'expired'
        | 'deleted'
        | 'corrupt'
        | 'unverified'
        | undefined;
      readonly availabilityState?: 'available' | 'quarantined' | 'evicted' | 'missing' | undefined;
    }
  ): void {
    const digest = sha256Hex(params.content);
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
       VALUES (?, ?, ?, 'application/octet-stream', 'report', ?)`,
      params.artifactId,
      digest,
      params.content.byteLength,
      params.now
    );
    conn.run(
      `INSERT INTO artifact_locations (location_id, artifact_id, storage_tier, uri_or_relpath, verified_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      params.locationId,
      params.artifactId,
      params.storageTier,
      params.relpath,
      params.now
    );
    if (params.lifecycleAvailability !== undefined) {
      conn.run(
        `INSERT INTO artifact_lifecycle (
          artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
          retention_class, store_kind, immutability, digest_algorithm, digest_value,
          generation, extent_bytes, byte_size, availability, producer_identity, display_name,
          created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
        ) VALUES (
          ?, 1, NULL, NULL, 'metadata',
          'generated-reports-handoff-exports', 'report', 'immutable', 'sha256', ?,
          NULL, NULL, ?, ?, 'unit-test', ?,
          ?, NULL, NULL, ?
        )`,
        params.artifactId,
        digest,
        params.content.byteLength,
        params.lifecycleAvailability,
        `${params.artifactId}.bin`,
        params.now,
        params.now
      );
    }
    if (params.availabilityState !== undefined) {
      conn.run(
        `INSERT INTO artifact_availability (artifact_id, state, last_verified_at_ms, detail_json)
         VALUES (?, ?, ?, '{}')`,
        params.artifactId,
        params.availabilityState,
        params.now
      );
    }
  }

  it('14-01: classifies only lifecycle deleted/expired and fallback evicted as tombstoned while keeping all live/untracked/corrupt states required in deterministic order', () => {
    const now = 1_763_900_000_000;
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => now });
    try {
      const conn = store.writerConnection;
      const body = Buffer.from('artifact-payload');

      // Tombstoned rows (MUST be excluded from required-on-disk verification)
      insertArtifactRow(conn, {
        artifactId: 'art-01-deleted-ws',
        locationId: 'loc-1',
        storageTier: 'workspace_file',
        relpath: '.schegent/reports/deleted.bin',
        content: body,
        now,
        lifecycleAvailability: 'deleted',
        availabilityState: 'available'
      });
      insertArtifactRow(conn, {
        artifactId: 'art-02-expired-cas',
        locationId: 'loc-2',
        storageTier: 'cas_blob',
        relpath: '.schegent/cas/expired.bin',
        content: body,
        now,
        lifecycleAvailability: 'expired'
      });
      insertArtifactRow(conn, {
        artifactId: 'art-03-evicted-cas-no-lifecycle',
        locationId: 'loc-3',
        storageTier: 'cas_blob',
        relpath: '.schegent/cas/evicted.bin',
        content: body,
        now,
        availabilityState: 'evicted'
      });

      // Live / fail-closed rows (MUST stay required-live)
      insertArtifactRow(conn, {
        artifactId: 'art-04-present-overrides-evicted',
        locationId: 'loc-4',
        storageTier: 'workspace_file',
        relpath: '.schegent/reports/present.bin',
        content: body,
        now,
        lifecycleAvailability: 'present',
        availabilityState: 'evicted'
      });
      for (const [idx, state] of (['pending', 'unverified', 'missing', 'corrupt'] as const).entries()) {
        insertArtifactRow(conn, {
          artifactId: `art-05-lc-${idx}-${state}`,
          locationId: `loc-lc-${idx}`,
          storageTier: 'workspace_file',
          relpath: `.schegent/reports/${state}.bin`,
          content: body,
          now,
          lifecycleAvailability: state
        });
      }
      insertArtifactRow(conn, {
        artifactId: 'art-06-no-lifecycle-no-avail',
        locationId: 'loc-6b',
        storageTier: 'workspace_file',
        relpath: 'untracked-b.bin',
        content: body,
        now
      });
      // Second location for same artifact to verify deterministic ORDER BY artifact_id ASC, location_id ASC
      conn.run(
        `INSERT INTO artifact_locations (location_id, artifact_id, storage_tier, uri_or_relpath, verified_at_ms)
         VALUES ('loc-6a', 'art-06-no-lifecycle-no-avail', 'cas_blob', 'untracked-a.bin', ?)`,
        now
      );
      insertArtifactRow(conn, {
        artifactId: 'art-07-avail-missing',
        locationId: 'loc-7',
        storageTier: 'cas_blob',
        relpath: '.schegent/cas/missing.bin',
        content: body,
        now,
        availabilityState: 'missing'
      });
      insertArtifactRow(conn, {
        artifactId: 'art-08-inline-ignored',
        locationId: 'loc-8',
        storageTier: 'inline_db',
        relpath: 'inline://ignored',
        content: body,
        now
      });

      const classified = classifyExternalArtifactDependencies(conn);
      const byId = new Map(classified.map((row) => [`${row.artifactId}:${row.locationId}`, row.disposition]));
      expect(byId.get('art-01-deleted-ws:loc-1')).toBe('tombstoned-deleted');
      expect(byId.get('art-02-expired-cas:loc-2')).toBe('tombstoned-deleted');
      expect(byId.get('art-03-evicted-cas-no-lifecycle:loc-3')).toBe('tombstoned-deleted');
      expect(byId.get('art-04-present-overrides-evicted:loc-4')).toBe('required-live');
      expect(byId.get('art-05-lc-0-pending:loc-lc-0')).toBe('required-live');
      expect(byId.get('art-05-lc-1-unverified:loc-lc-1')).toBe('required-live');
      expect(byId.get('art-05-lc-2-missing:loc-lc-2')).toBe('required-live');
      expect(byId.get('art-05-lc-3-corrupt:loc-lc-3')).toBe('required-live');
      expect(byId.get('art-06-no-lifecycle-no-avail:loc-6a')).toBe('required-live');
      expect(byId.get('art-06-no-lifecycle-no-avail:loc-6b')).toBe('required-live');
      expect(byId.get('art-07-avail-missing:loc-7')).toBe('required-live');

      const collected = collectExternalDependenciesFromConn(conn);
      expect(collected.map((d) => `${d.referenceId}:${d.relativePath}`)).toEqual([
        'art-04-present-overrides-evicted:.schegent/reports/present.bin',
        'art-05-lc-0-pending:.schegent/reports/pending.bin',
        'art-05-lc-1-unverified:.schegent/reports/unverified.bin',
        'art-05-lc-2-missing:.schegent/reports/missing.bin',
        'art-05-lc-3-corrupt:.schegent/reports/corrupt.bin',
        'art-06-no-lifecycle-no-avail:untracked-a.bin',
        'art-06-no-lifecycle-no-avail:untracked-b.bin',
        'art-07-avail-missing:.schegent/cas/missing.bin'
      ]);
    } finally {
      store.close();
    }
  });

  it('14-01: falls back fail-closed when artifact_lifecycle and artifact_availability tables do not exist', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:', journalMode: 'memory' });
    try {
      conn.exec(`
        CREATE TABLE artifacts (
          artifact_id TEXT PRIMARY KEY,
          content_sha256 TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          media_type TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE artifact_locations (
          location_id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          storage_tier TEXT NOT NULL,
          uri_or_relpath TEXT NOT NULL,
          verified_at_ms INTEGER NOT NULL
        ) STRICT;
      `);
      conn.run(
        `INSERT INTO artifacts VALUES ('a1', ?, 12, 'text/plain', 'report', 1000)`,
        sha256Hex('hello world!')
      );
      conn.run(
        `INSERT INTO artifact_locations VALUES ('loc-b', 'a1', 'workspace_file', 'b.txt', 1000)`
      );
      conn.run(
        `INSERT INTO artifact_locations VALUES ('loc-a', 'a1', 'cas_blob', 'a.txt', 1000)`
      );

      const deps = collectExternalDependenciesFromConn(conn);
      expect(deps.map((d) => d.relativePath)).toEqual(['a.txt', 'b.txt']);
    } finally {
      conn.close();
    }
  });

  it('14-02: enforces exact limit-1, limit, and limit+1 parity between createOnlineBackup and verify/restore across dependency count, cumulative bytes, manifest bytes, and DB bytes with zero leftover partial backups', async () => {
    const rootDir = await makeTempDir('schegent-14-02-unit-');
    const workspaceRoot = await makeTempDir('schegent-14-02-ws-');
    const scopeId = 'scope-bounds';
    const now = 1_763_910_000_000;
    const backupSegments = ['sqlite', scopeId, 'backups'] as const;
    const backupsDir = path.join(rootDir, ...backupSegments);

    const store = new SqliteApplicationStore({
      databasePath: path.join(rootDir, 'live.db'),
      journalMode: 'wal',
      nowMs: () => now
    });
    const inspector = createWorkspaceExternalDependencyInspector(workspaceRoot);

    try {
      // Seed 3 live external files of 100 bytes each (total = 300 bytes)
      for (let i = 1; i <= 3; i += 1) {
        const rel = `blobs/file-${i}.bin`;
        const bytes = Buffer.alloc(100, 0x30 + i);
        await fs.mkdir(path.join(workspaceRoot, 'blobs'), { recursive: true });
        await fs.writeFile(path.join(workspaceRoot, rel), bytes);
        insertArtifactRow(store.writerConnection, {
          artifactId: `art-${i}`,
          locationId: `loc-${i}`,
          storageTier: 'workspace_file',
          relpath: rel,
          content: bytes,
          now,
          lifecycleAvailability: 'present'
        });
      }

      // Tightened-only resolution never raises published ceilings
      const clamped = resolveBackupBounds({
        maxExternalDependencies: MAX_BACKUP_EXTERNAL_DEPENDENCIES + 50,
        maxExternalDependencyBytes: MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES + 50,
        maxManifestBytes: MAX_BACKUP_MANIFEST_BYTES + 50,
        maxDatabaseBytes: MAX_BACKUP_DATABASE_BYTES + 50
      });
      expect(clamped).toEqual({
        maxExternalDependencies: MAX_BACKUP_EXTERNAL_DEPENDENCIES,
        maxExternalDependencyBytes: MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES,
        maxManifestBytes: MAX_BACKUP_MANIFEST_BYTES,
        maxDatabaseBytes: MAX_BACKUP_DATABASE_BYTES
      });

      // 1. Count boundary: actual = 3. Test limit = 2 (actual = limit + 1 -> refuse), limit = 3 (at limit -> pass), limit = 4 (actual = limit - 1 -> pass)
      await expect(
        store.backupRestore.createOnlineBackup({
          backupId: 'bkp-count-over',
          scopeId,
          trustedRootDir: rootDir,
          relativeBackupDirSegments: backupSegments,
          maxExternalDependencies: 2
        })
      ).rejects.toThrow(/EXTERNAL_DEPENDENCY_BOUND_EXCEEDED/);
      expect(await listBackupsInRoot(rootDir, backupSegments)).toEqual([]);

      const countAtLimit = await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-count-exact',
        scopeId,
        trustedRootDir: rootDir,
        relativeBackupDirSegments: backupSegments,
        maxExternalDependencies: 3
      });
      expect(
        verifyBackupStandalone({
          backupDatabasePath: countAtLimit.backupDatabasePath,
          manifest: countAtLimit.manifest,
          trustedRootDir: rootDir,
          maxExternalDependencies: 3,
          inspectExternalDependency: inspector
        }).status
      ).toBe('verified');
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: countAtLimit.backupDatabasePath,
          manifest: countAtLimit.manifest,
          trustedRootDir: rootDir,
          maxExternalDependencies: 4,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified', verifiedExternalDependencies: 3 });
      expect(
        verifyBackupStandalone({
          backupDatabasePath: countAtLimit.backupDatabasePath,
          manifest: countAtLimit.manifest,
          trustedRootDir: rootDir,
          maxExternalDependencies: 2,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'rejected', reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED' });

      // 2. Cumulative bytes boundary: actual = 300 B. Test 299 (over), 300 (at limit), 301 (below limit)
      await expect(
        store.backupRestore.createOnlineBackup({
          backupId: 'bkp-bytes-over',
          scopeId,
          trustedRootDir: rootDir,
          relativeBackupDirSegments: backupSegments,
          maxExternalDependencyBytes: 299
        })
      ).rejects.toThrow(/EXTERNAL_DEPENDENCY_BOUND_EXCEEDED/);
      expect((await fs.readdir(backupsDir)).filter((f) => f.includes('bkp-bytes-over'))).toEqual([]);

      const bytesAtLimit = await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-bytes-exact',
        scopeId,
        trustedRootDir: rootDir,
        relativeBackupDirSegments: backupSegments,
        maxExternalDependencyBytes: 300
      });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: bytesAtLimit.backupDatabasePath,
          manifest: bytesAtLimit.manifest,
          trustedRootDir: rootDir,
          maxExternalDependencyBytes: 300,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified' });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: bytesAtLimit.backupDatabasePath,
          manifest: bytesAtLimit.manifest,
          trustedRootDir: rootDir,
          maxExternalDependencyBytes: 301,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified' });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: bytesAtLimit.backupDatabasePath,
          manifest: bytesAtLimit.manifest,
          trustedRootDir: rootDir,
          maxExternalDependencyBytes: 299,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'rejected', reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED' });

      // 3. Manifest byte boundary (post-snapshot check + full rollback cleanup of .db/.manifest.json/.tmp)
      const exactManifestBytes = (await fs.stat(bytesAtLimit.manifestPath)).size;
      await expect(
        store.backupRestore.createOnlineBackup({
          backupId: 'bkp-mf-over-xxx', // same 15-char backupId length as 'bkp-bytes-exact'
          scopeId,
          trustedRootDir: rootDir,
          relativeBackupDirSegments: backupSegments,
          maxManifestBytes: exactManifestBytes - 1
        })
      ).rejects.toThrow(/BACKUP_MANIFEST_BOUND_EXCEEDED/);
      expect((await fs.readdir(backupsDir)).filter((f) => f.includes('bkp-mf-over-xxx'))).toEqual([]);

      const mfExact = await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-mf-ok-exact',
        scopeId,
        trustedRootDir: rootDir,
        relativeBackupDirSegments: backupSegments,
        maxManifestBytes: exactManifestBytes
      });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: mfExact.backupDatabasePath,
          manifest: mfExact.manifest,
          trustedRootDir: rootDir,
          maxManifestBytes: exactManifestBytes,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified' });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: mfExact.backupDatabasePath,
          manifest: mfExact.manifest,
          trustedRootDir: rootDir,
          maxManifestBytes: exactManifestBytes - 1,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'rejected', reasonCode: 'BACKUP_MANIFEST_BOUND_EXCEEDED' });

      // 4. Database image byte boundary (post-VACUUM check + full rollback cleanup)
      const exactDbBytes = mfExact.manifest.databaseBytes;
      await expect(
        store.backupRestore.createOnlineBackup({
          backupId: 'bkp-db-over',
          scopeId,
          trustedRootDir: rootDir,
          relativeBackupDirSegments: backupSegments,
          maxDatabaseBytes: exactDbBytes - 1
        })
      ).rejects.toThrow(/RESTORE_IMAGE_BOUND_EXCEEDED/);
      expect((await fs.readdir(backupsDir)).filter((f) => f.includes('bkp-db-over'))).toEqual([]);

      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: mfExact.backupDatabasePath,
          manifest: mfExact.manifest,
          trustedRootDir: rootDir,
          maxDatabaseBytes: exactDbBytes,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'verified' });
      expect(
        await verifyBackupStandaloneAsync({
          backupDatabasePath: mfExact.backupDatabasePath,
          manifest: mfExact.manifest,
          trustedRootDir: rootDir,
          maxDatabaseBytes: exactDbBytes - 1,
          inspectExternalDependency: inspector
        })
      ).toMatchObject({ status: 'rejected', reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED' });
    } finally {
      store.close();
    }
  });

  it('14-02: cleans up .db, sidecars, .tmp, and .manifest.json when creation fails mid-flight after VACUUM INTO', async () => {
    const rootDir = await makeTempDir('schegent-14-02-cleanup-');
    const scopeId = 'scope-cleanup';
    const backupSegments = ['sqlite', scopeId, 'backups'] as const;
    const backupsDir = path.join(rootDir, ...backupSegments);
    const store = new SqliteApplicationStore({
      databasePath: path.join(rootDir, 'live.db'),
      journalMode: 'wal'
    });
    try {
      const conn = store.writerConnection;
      const origRun = conn.run.bind(conn);
      // Plant a stray SQLite -wal sidecar synchronously right after VACUUM INTO so post-snapshot check fails
      const spy = vi.spyOn(conn, 'run').mockImplementation((sql, ...params) => {
        const res = origRun(sql, ...params);
        if (sql === 'VACUUM INTO ?' && typeof params[0] === 'string') {
          writeFileSync(`${params[0]}-wal`, Buffer.from('stray-sidecar'));
        }
        return res;
      });
      try {
        await expect(
          store.backupRestore.createOnlineBackup({
            backupId: 'bkp-fail-sidecar',
            scopeId,
            trustedRootDir: rootDir,
            relativeBackupDirSegments: backupSegments
          })
        ).rejects.toThrow(/BACKUP_PATH_REFUSED/);
      } finally {
        spy.mockRestore();
      }
      expect(await fs.readdir(backupsDir)).toEqual([]);

      await expect(
        store.backupRestore.createOnlineBackup({
          backupId: 'bkp-fail-post-vacuum',
          scopeId,
          trustedRootDir: rootDir,
          relativeBackupDirSegments: backupSegments,
          maxDatabaseBytes: 1024 // always smaller than a schema-9 SQLite image
        })
      ).rejects.toThrow(/RESTORE_IMAGE_BOUND_EXCEEDED/);

      const remaining = await fs.readdir(backupsDir);
      expect(remaining).toEqual([]);
      expect(await listBackupsInRoot(rootDir, backupSegments)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('14-03: computeFileDigestAsync matches sync digest across multi-MiB images and enforces O_NOFOLLOW and size ceiling', async () => {
    const rootDir = await makeTempDir('schegent-14-03-digest-');
    const subDir = path.join(rootDir, 'backups');
    await fs.mkdir(subDir, { recursive: true, mode: 0o700 });

    // 2.5 MiB payload crosses multiple 256 KiB chunks and 1 MiB event-loop yield boundaries
    const payload = Buffer.alloc(2.5 * 1024 * 1024, 0x5c);
    const filePath = path.join(subDir, 'sample.db');
    await fs.writeFile(filePath, payload, { mode: 0o600 });

    const syncRes = computeFileDigestSync(filePath, 4 * 1024 * 1024);
    const asyncRes = await computeFileDigestAsync(filePath, 4 * 1024 * 1024, rootDir);
    expect(syncRes.ok).toBe(true);
    expect(asyncRes.ok).toBe(true);
    if (syncRes.ok && asyncRes.ok) {
      expect(asyncRes.byteLength).toBe(syncRes.byteLength);
      expect(asyncRes.sha256).toBe(syncRes.sha256);
    }

    const overBound = await computeFileDigestAsync(filePath, payload.byteLength - 1, rootDir);
    expect(overBound).toMatchObject({ ok: false, reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED' });

    if (process.platform !== 'win32') {
      const linkPath = path.join(subDir, 'linked.db');
      await fs.symlink(filePath, linkPath);
      const symlinkRes = await computeFileDigestAsync(linkPath, 4 * 1024 * 1024, rootDir);
      expect(symlinkRes).toEqual({
        ok: false,
        error: 'Backup database path must not be a symbolic link'
      });
    }
  });

  it('14-03: validateAndRestoreBackupAsync rolls back cleanly on pre-commit ownership loss or busy fence leaving target untouched', async () => {
    const rootDir = await makeTempDir('schegent-14-03-fence-');
    const scopeId = 'scope-fence-unit';
    const now = 1_763_920_000_000;
    const store = new SqliteApplicationStore({
      databasePath: path.join(rootDir, 'live.db'),
      journalMode: 'wal',
      nowMs: () => now
    });

    try {
      const svc = new BackupRestoreService(store.writerConnection, () => now);
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-original', ?, 'wf-1', 'succeeded', 1, ?, ?)`,
        scopeId,
        now,
        now
      );

      const backup = await svc.createOnlineBackup({
        backupId: 'bkp-fence-unit',
        scopeId,
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });

      // Mutate live DB after backup
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-live-sentinel', ?, 'wf-2', 'succeeded', 2, ?, ?)`,
        scopeId,
        now + 10,
        now + 10
      );

      // 1. Pre-commit ownership fence fails right before COMMIT -> ROLLBACK
      const lostCommit = await svc.validateAndRestoreBackupAsync({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        trustedRootDir: rootDir,
        fences: {
          hasPrimacy: async () => true,
          hasInFlightRun: () => false,
          beforeCommitFence: async () => false
        }
      });
      expect(lostCommit).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_OWNERSHIP_LOST'
      });

      const liveAfterLost = store.writerConnection
        .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
        .map((r) => r.run_id);
      expect(liveAfterLost).toEqual(['run-live-sentinel', 'run-original']);

      // 2. In-flight run starts right before COMMIT -> ROLLBACK with RESTORE_BUSY
      let busy = false;
      const busyCommit = await svc.validateAndRestoreBackupAsync({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        trustedRootDir: rootDir,
        fences: {
          hasPrimacy: async () => true,
          hasInFlightRun: () => busy,
          beforeCommitFence: async () => {
            busy = true;
            return true;
          }
        }
      });
      // `beforeCommitFence` runs after `hasInFlightRun` at pre-commit; verify flipping busy during `hasPrimacy` triggers RESTORE_BUSY:
      expect(busyCommit.status).toBe('restored');

      // Re-insert sentinel and flip `busy` during pre-commit `hasPrimacy` check
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-live-sentinel-2', ?, 'wf-2', 'succeeded', 3, ?, ?)`,
        scopeId,
        now + 20,
        now + 20
      );
      let primacyCount = 0;
      let busy2 = false;
      const busyPreCommit = await svc.validateAndRestoreBackupAsync({
        backupDatabasePath: backup.backupDatabasePath,
        manifest: backup.manifest,
        trustedRootDir: rootDir,
        fences: {
          hasPrimacy: async () => {
            primacyCount += 1;
            if (primacyCount === 2) busy2 = true; // flip right before COMMIT
            return true;
          },
          hasInFlightRun: () => busy2
        }
      });
      expect(busyPreCommit).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_BUSY'
      });
      const liveAfterBusy = store.writerConnection
        .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
        .map((r) => r.run_id);
      expect(liveAfterBusy).toEqual(['run-live-sentinel-2', 'run-original']);
    } finally {
      store.close();
    }
  });
});
