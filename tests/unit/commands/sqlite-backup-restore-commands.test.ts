/**
 * FR-R7-03 (FR-003, FR-004, FR-005, FR-008, SC-002, SC-003, SC-006) —
 * End-to-end tests for the headless backup/restore API and VS Code operator command
 * flows (`schegent.backupStore`, `schegent.verifyStoreBackup`, `schegent.restoreStoreBackup`):
 * - confirmation modals and cancel paths
 * - ownership-fence refusal (`NOT_WORKSPACE_OWNER`)
 * - in-flight Run refusal (`RUN_IN_FLIGHT`)
 * - every validation rejection code reachable from the command boundary with live store unchanged
 * - sanitized `AuditLogWriter` entries containing zero raw workspace or backup paths
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { AuditPayloadValidationError, projectAuditPayload } from '../../../src/audit/audit-payload';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  runBackupStore,
  runRestoreStoreBackup,
  runVerifyStoreBackup,
  type BackupPickerItem,
  type BackupRestoreCommandUi
} from '../../../src/commands/sqlite-backup-restore';
import {
  createStoreBackupRestoreApi,
  createWorkspaceExternalDependencyInspector
} from '../../../src/headless/backup-restore-api';
import {
  NodeSqliteConnection,
  SqliteApplicationStore,
  computeFileDigestSync,
  MAX_BACKUP_DATABASE_BYTES
} from '../../../src/services/sqlite-store';

function createStubUi(options?: {
  confirmResult?: boolean;
  pickIndex?: number;
}): {
  readonly ui: BackupRestoreCommandUi;
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
  readonly confirms: Array<{ message: string; detail: string; approveLabel: string }>;
  readonly picks: Array<{ items: readonly BackupPickerItem[]; title: string }>;
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const confirms: Array<{ message: string; detail: string; approveLabel: string }> = [];
  const picks: Array<{ items: readonly BackupPickerItem[]; title: string }> = [];

  return {
    infos,
    warns,
    errors,
    confirms,
    picks,
    ui: {
      async pickBackup(items, title) {
        picks.push({ items, title });
        if (options?.pickIndex === -1) return undefined;
        return items[options?.pickIndex ?? 0];
      },
      async confirmModal(message, detail, approveLabel) {
        confirms.push({ message, detail, approveLabel });
        return options?.confirmResult ?? true;
      },
      info(message) {
        infos.push(message);
      },
      warn(message) {
        warns.push(message);
      },
      error(message) {
        errors.push(message);
      }
    }
  };
}

describe('SQLite backup, verify, and restore operator commands (FR-R7-03)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function setupHarness(opts?: { hasPrimacy?: () => Promise<boolean>; hasInFlightRun?: () => boolean }) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-storage-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-cmd-001';
    const now = 1_763_720_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
    const store = new SqliteApplicationStore({
      databasePath: path.join(dbDir, 'schegent-state.db'),
      journalMode: 'wal',
      nowMs: () => now
    });

    const auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger([]));
    let reloadCount = 0;

    const api = createStoreBackupRestoreApi({
      getSqliteStore: () => store,
      trustedRootDir: storageRoot,
      scopeId,
      hasPrimacy: opts?.hasPrimacy ?? (async () => true),
      hasInFlightRun: opts?.hasInFlightRun ?? (() => false),
      reloadAfterRestore: () => {
        reloadCount += 1;
      },
      inspectExternalDependency: createWorkspaceExternalDependencyInspector(workspaceRoot),
      auditWriter,
      nowMs: () => now
    });

    return {
      workspaceRoot,
      storageRoot,
      scopeId,
      now,
      store,
      auditWriter,
      api,
      getReloadCount: () => reloadCount
    };
  }

  it('creates a backup with confirmation, verifies it, restores it with cache reload, and logs zero raw paths in audit.log', async () => {
    const h = await setupHarness();
    try {
      h.store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-before', ?, 'wf-1', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
        h.scopeId,
        h.now,
        h.now,
        h.now,
        h.now
      );

      // Empty backup directory reports cleanly
      const emptyUi = createStubUi();
      const emptyVerify = await runVerifyStoreBackup({ api: h.api, ui: emptyUi.ui });
      expect(emptyVerify.status).toBe('empty');
      expect(emptyUi.infos[0]).toMatch(/no SQLite store backups/i);

      // Cancel backup confirmation -> no files written
      const cancelUi = createStubUi({ confirmResult: false });
      const canceled = await runBackupStore({ api: h.api, ui: cancelUi.ui }, { backupId: 'bkp-cancel' });
      expect(canceled.status).toBe('canceled');
      expect(await h.api.listBackups()).toHaveLength(0);

      // Confirmed backup -> creates DB + manifest, reports path & size in UI only
      const bkpUi = createStubUi({ confirmResult: true });
      const created = await runBackupStore({ api: h.api, ui: bkpUi.ui }, { backupId: 'bkp-cmd-1' });
      expect(created.status).toBe('created');
      expect(bkpUi.confirms).toHaveLength(1);
      expect(bkpUi.infos[0]).toContain('bkp-cmd-1');

      // Verify command lists and verifies cleanly
      const verifyUi = createStubUi();
      const verified = await runVerifyStoreBackup({ api: h.api, ui: verifyUi.ui });
      expect(verified.status).toBe('verified');
      expect(verifyUi.picks).toHaveLength(1);
      expect(verifyUi.infos[0]).toMatch(/verified/i);

      // Mutate live store after backup
      h.store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-post-backup', ?, 'wf-2', NULL, 'succeeded', 2, NULL, ?, ?, 'ok', ?, ?)`,
        h.scopeId,
        h.now + 50,
        h.now + 50,
        h.now + 50,
        h.now + 50
      );

      // Cancel restore confirmation -> live store unchanged
      const cancelRestoreUi = createStubUi({ confirmResult: false });
      const cancelRestore = await runRestoreStoreBackup({ api: h.api, ui: cancelRestoreUi.ui });
      expect(cancelRestore.status).toBe('canceled');
      expect(cancelRestoreUi.confirms[0]?.detail).toMatch(/replace all authoritative store state/i);
      expect(cancelRestoreUi.confirms[0]?.detail).toMatch(/permanently lost/i);
      expect(h.getReloadCount()).toBe(0);

      // Confirmed restore -> replaces live store and reloads caches
      const restoreUi = createStubUi({ confirmResult: true });
      const restored = await runRestoreStoreBackup({ api: h.api, ui: restoreUi.ui });
      expect(restored.status).toBe('restored');
      expect(h.getReloadCount()).toBe(1);
      const survivingRuns = h.store.writerConnection
        .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
        .map((r) => r.run_id);
      expect(survivingRuns).toEqual(['run-before']);

      // Audit log contains sanitized store-backup and store-restore events with ZERO raw paths (SC-006, Hard Rule 22)
      const auditText = await fs.readFile(path.join(h.workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      expect(auditText).not.toContain(h.workspaceRoot);
      expect(auditText).not.toContain(h.storageRoot);
      const entries = auditText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
      expect(entries.map((e) => e.eventType)).toEqual(['store-backup', 'store-restore']);
      expect(entries[0]?.payload.backupId).toBe('bkp-cmd-1');
      expect(entries[0]?.payload.outcome).toBe('succeeded');
      expect(entries[1]?.payload.backupId).toBe('bkp-cmd-1');
      expect(entries[1]?.payload.outcome).toBe('succeeded');
    } finally {
      h.store.close();
    }
  });

  it('refuses verify and restore when the companion manifest omits an indexed workspace file', async () => {
    const h = await setupHarness();
    try {
      const relativePath = 'saved-report.txt';
      const bytes = Buffer.from('saved report');
      await fs.writeFile(path.join(h.workspaceRoot, relativePath), bytes);
      h.store.writerConnection.run(
        `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
         VALUES ('artifact-1', ?, ?, 'text/plain', 'report', ?)`,
        createHash('sha256').update(bytes).digest('hex'), bytes.length, h.now
      );
      h.store.writerConnection.run(
        `INSERT INTO artifact_locations (location_id, artifact_id, storage_tier, uri_or_relpath, verified_at_ms)
         VALUES ('location-1', 'artifact-1', 'workspace_file', ?, ?)`,
        relativePath, h.now
      );

      const deps = { api: h.api, ui: createStubUi().ui };
      const options = { backupId: 'bkp-indexed-file' };
      const created = await runBackupStore(deps, options);
      if (created.status !== 'created') throw new Error(`Backup was ${created.status}`);
      expect(await runVerifyStoreBackup(deps, options)).toMatchObject({
        status: 'verified', verifiedExternalDependencies: 1
      });

      const ioFailureApi = createStoreBackupRestoreApi({
        getSqliteStore: () => h.store,
        trustedRootDir: h.storageRoot,
        scopeId: h.scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        reloadAfterRestore: vi.fn(),
        inspectExternalDependency: () => { throw new Error('dependency read failed'); }
      });
      const rejection = { status: 'rejected', reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT' };
      expect(await runVerifyStoreBackup({ ...deps, api: ioFailureApi }, options)).toMatchObject(rejection);
      expect(await runRestoreStoreBackup({ ...deps, api: ioFailureApi }, options)).toMatchObject(rejection);

      await fs.writeFile(created.manifestPath, JSON.stringify({ ...created.manifest, externalDependencies: [] }));
      h.store.writerConnection.run(`UPDATE artifacts SET media_type = 'application/json'`);
      expect(await runVerifyStoreBackup(deps, options)).toMatchObject(rejection);
      expect(await runRestoreStoreBackup(deps, options)).toMatchObject(rejection);
      expect(h.store.writerConnection.scalar('SELECT media_type FROM artifacts')).toBe('application/json');
      expect(h.getReloadCount()).toBe(0);
    } finally {
      h.store.close();
    }
  });

  it('refuses restore when a Run is in flight (RUN_IN_FLIGHT) or window lacks ownership (NOT_WORKSPACE_OWNER)', async () => {
    let inFlight = true;
    let owner = true;
    const h = await setupHarness({
      hasPrimacy: async () => owner,
      hasInFlightRun: () => inFlight
    });

    try {
      const bkpUi = createStubUi();
      const created = await runBackupStore({ api: h.api, ui: bkpUi.ui }, { backupId: 'bkp-guard' });
      expect(created.status).toBe('created');

      // 1. In-flight Run refuses restore with RUN_IN_FLIGHT
      const inFlightUi = createStubUi();
      const inFlightRes = await runRestoreStoreBackup(
        { api: h.api, ui: inFlightUi.ui },
        { backupId: 'bkp-guard' }
      );
      expect(inFlightRes.status).toBe('refused');
      if (inFlightRes.status === 'refused') {
        expect(inFlightRes.reasonCode).toBe('RUN_IN_FLIGHT');
      }
      expect(inFlightUi.warns[0]).toContain('RUN_IN_FLIGHT');
      expect(h.getReloadCount()).toBe(0);

      // 2. Non-owner window refuses both backup and restore with NOT_WORKSPACE_OWNER
      inFlight = false;
      owner = false;
      const nonOwnerUi = createStubUi();
      const nonOwnerRestore = await runRestoreStoreBackup(
        { api: h.api, ui: nonOwnerUi.ui },
        { backupId: 'bkp-guard' }
      );
      expect(nonOwnerRestore.status).toBe('refused');
      if (nonOwnerRestore.status === 'refused') {
        expect(nonOwnerRestore.reasonCode).toBe('NOT_WORKSPACE_OWNER');
      }
      const nonOwnerBackup = await runBackupStore(
        { api: h.api, ui: nonOwnerUi.ui },
        { backupId: 'bkp-non-owner' }
      );
      expect(nonOwnerBackup.status).toBe('refused');
      if (nonOwnerBackup.status === 'refused') {
        expect(nonOwnerBackup.reasonCode).toBe('NOT_WORKSPACE_OWNER');
      }
    } finally {
      h.store.close();
    }
  });

  it('surfaces every validation rejection code through verify and restore commands while keeping live store unchanged (SC-003)', async () => {
    const h = await setupHarness();
    try {
      h.store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-live-sentinel', ?, 'wf-live', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
        h.scopeId,
        h.now,
        h.now,
        h.now,
        h.now
      );

      const created = await h.api.createBackup({ backupId: 'bkp-base' });
      expect(created.status).toBe('created');
      if (created.status !== 'created') return;

      const backupsDir = path.dirname(created.backupDatabasePath);

      const writeVariant = async (
        id: string,
        dbBytes: Buffer,
        manifestPatch: Record<string, unknown>
      ) => {
        const dbPath = path.join(backupsDir, `${id}.db`);
        const mfPath = path.join(backupsDir, `${id}.db.manifest.json`);
        await fs.writeFile(dbPath, dbBytes, { mode: 0o600 });
        const manifest = {
          ...created.manifest,
          backupId: id,
          databaseSha256: createHash('sha256').update(dbBytes).digest('hex'),
          databaseBytes: dbBytes.byteLength,
          ...manifestPatch
        };
        await fs.writeFile(mfPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      };

      const baseBytes = await fs.readFile(created.backupDatabasePath);

      // 1. DATABASE_DIGEST_MISMATCH (single byte flip against original manifest digest)
      const flipped = Buffer.from(baseBytes);
      const flipIdx = Math.floor(flipped.length / 2);
      flipped[flipIdx] = (flipped[flipIdx] ?? 0) ^ 0x01;
      await writeVariant('bkp-flip', flipped, {
        databaseSha256: created.manifest.databaseSha256,
        databaseBytes: created.manifest.databaseBytes
      });

      // 2. UNSUPPORTED_SCHEMA_VERSION
      await writeVariant('bkp-schema', baseBytes, { schemaVersion: 999 });

      // 3. EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT
      await writeVariant('bkp-ext-missing', baseBytes, {
        externalDependencies: [
          {
            dependencyKind: 'audit_log',
            referenceId: 'audit-missing',
            relativePath: '.schegent/does-not-exist.log',
            byteLength: 42,
            sha256Digest: 'a'.repeat(64)
          }
        ]
      });

      // 4. EXTERNAL_DEPENDENCY_BOUND_EXCEEDED
      await writeVariant('bkp-ext-bound', baseBytes, {
        externalDependencies: [
          {
            dependencyKind: 'artifact_blob',
            referenceId: 'b1',
            relativePath: 'blobs/b1',
            byteLength: 10,
            sha256Digest: '1'.repeat(64)
          },
          {
            dependencyKind: 'artifact_blob',
            referenceId: 'b2',
            relativePath: 'blobs/b2',
            byteLength: 10,
            sha256Digest: '2'.repeat(64)
          }
        ]
      });

      // 5. BACKUP_OPEN_FAILED (missing companion manifest)
      await fs.writeFile(path.join(backupsDir, 'bkp-no-manifest.db'), baseBytes, { mode: 0o600 });

      // 6. FOREIGN_KEY_CHECK_FAILED
      const fkPath = path.join(backupsDir, 'bkp-fk-bad.db');
      await fs.writeFile(fkPath, baseBytes, { mode: 0o600 });
      const fkConn = new NodeSqliteConnection({ databasePath: fkPath, journalMode: 'delete' });
      try {
        fkConn.exec('PRAGMA foreign_keys = OFF');
        fkConn.run(
          `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, updated_at_ms)
           VALUES ('step-bad', 'missing-run-id', 0, 'specify', 'pending', 1, ?)`,
          h.now
        );
      } finally {
        fkConn.close();
      }
      const fkBytes = await fs.readFile(fkPath);
      await writeVariant('bkp-fk-bad', fkBytes, {});

      const invalidSchemaCopies = [
        ['bkp-no-schema-version', `DELETE FROM schema_meta WHERE meta_key = 'schema_version'`],
        ['bkp-no-reader-floor', `DELETE FROM schema_meta WHERE meta_key = 'min_reader_version'`],
        ['bkp-bad-migration-record', `UPDATE schema_migrations SET checksum_sha256 = 'invalid' WHERE version = 1`]
      ] as const;
      for (const [id, update] of invalidSchemaCopies) {
        const copyPath = path.join(backupsDir, `${id}.db`);
        await fs.writeFile(copyPath, baseBytes, { mode: 0o600 });
        const copy = new NodeSqliteConnection({ databasePath: copyPath, journalMode: 'delete' });
        try {
          copy.run(update);
        } finally {
          copy.close();
        }
        await writeVariant(id, await fs.readFile(copyPath), {});
      }

      const cases: ReadonlyArray<{
        readonly backupId: string;
        readonly expectedCode: string;
        readonly options?: {
          readonly maxExternalDependencies?: number;
          readonly simulateQuickCheckFailure?: boolean;
        };
      }> = [
        { backupId: 'bkp-flip', expectedCode: 'DATABASE_DIGEST_MISMATCH' },
        { backupId: 'bkp-schema', expectedCode: 'UNSUPPORTED_SCHEMA_VERSION' },
        { backupId: 'bkp-no-schema-version', expectedCode: 'UNSUPPORTED_SCHEMA_VERSION' },
        { backupId: 'bkp-no-reader-floor', expectedCode: 'UNSUPPORTED_SCHEMA_VERSION' },
        { backupId: 'bkp-bad-migration-record', expectedCode: 'BACKUP_OPEN_FAILED' },
        { backupId: 'bkp-ext-missing', expectedCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT' },
        {
          backupId: 'bkp-ext-bound',
          expectedCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
          options: { maxExternalDependencies: 1 }
        },
        { backupId: 'bkp-no-manifest', expectedCode: 'BACKUP_OPEN_FAILED' },
        {
          backupId: 'bkp-base',
          expectedCode: 'QUICK_CHECK_FAILED',
          options: { simulateQuickCheckFailure: true }
        },
        { backupId: 'bkp-fk-bad', expectedCode: 'FOREIGN_KEY_CHECK_FAILED' }
      ];

      for (const c of cases) {
        const ui = createStubUi({ confirmResult: true });
        const vOut = await runVerifyStoreBackup(
          { api: h.api, ui: ui.ui },
          { backupId: c.backupId, ...c.options }
        );
        expect(vOut.status, `verify ${c.backupId}`).toBe('rejected');
        if (vOut.status === 'rejected') {
          expect(vOut.reasonCode).toBe(c.expectedCode);
        }

        const rOut = await runRestoreStoreBackup(
          { api: h.api, ui: ui.ui },
          { backupId: c.backupId, ...c.options }
        );
        expect(rOut.status, `restore ${c.backupId}`).toBe('rejected');
        if (rOut.status === 'rejected') {
          expect(rOut.reasonCode).toBe(c.expectedCode);
        }
        expect(ui.warns.some((w) => w.includes(c.expectedCode))).toBe(true);
      }

      // Live store untouched after all 7 rejected restores
      const liveRuns = h.store.writerConnection
        .all<{ run_id: string }>(`SELECT run_id FROM runs`)
        .map((r) => r.run_id);
      expect(liveRuns).toEqual(['run-live-sentinel']);
      expect(h.getReloadCount()).toBe(0);

      // Verify audit log recorded zero raw paths across all rejections
      const auditText = await fs.readFile(path.join(h.workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      expect(auditText).not.toContain(h.workspaceRoot);
      expect(auditText).not.toContain(h.storageRoot);

      // 8. Path-traversal backupId is refused cleanly and sanitized in audit log
      const evilBackup = await h.api.createBackup({ backupId: '../escape' });
      expect(evilBackup.status).toBe('failed');
      if (evilBackup.status === 'failed') {
        expect(evilBackup.errorCode).toBe('INVALID_BACKUP_ID');
      }

      // 9. Spoofed manifest backupId mismatching its filename stem is rejected as invalid
      const spoofDb = path.join(backupsDir, 'bkp-real-stem.db');
      const spoofMf = path.join(backupsDir, 'bkp-real-stem.db.manifest.json');
      await fs.writeFile(spoofDb, baseBytes, { mode: 0o600 });
      await fs.writeFile(
        spoofMf,
        JSON.stringify({ ...created.manifest, backupId: 'bkp-spoofed-other' }, null, 2),
        { mode: 0o600 }
      );
      const spoofVerify = await h.api.verifyBackup('bkp-real-stem');
      expect(spoofVerify.status).toBe('rejected');
      if (spoofVerify.status === 'rejected') {
        expect(spoofVerify.reasonCode).toBe('BACKUP_OPEN_FAILED');
      }
    } finally {
      h.store.close();
    }
  });

  it('surfaces committed_refresh_failed when post-commit reloadAfterRestore throws without claiming live store was unmodified (FR-R7-11 Task 03)', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-t03-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-t03-storage-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-cmd-t03';
    const now = 1_763_730_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
    const store = new SqliteApplicationStore({
      databasePath: path.join(dbDir, 'schegent-state.db'),
      journalMode: 'wal',
      nowMs: () => now
    });
    const auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger([]));

    try {
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-before-t03', ?, 'wf-t03', NULL, 'succeeded', 1, NULL, ?, ?, 'ok', ?, ?)`,
        scopeId,
        now,
        now,
        now,
        now
      );

      const api = createStoreBackupRestoreApi({
        getSqliteStore: () => store,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        reloadAfterRestore: async () => {
          throw new Error(`catalog cache refresh crashed at ${workspaceRoot}/secret`);
        },
        inspectExternalDependency: createWorkspaceExternalDependencyInspector(workspaceRoot),
        auditWriter,
        nowMs: () => now
      });

      const created = await api.createBackup({ backupId: 'bkp-refresh-fail' });
      expect(created.status).toBe('created');

      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES ('run-post-backup-t03', ?, 'wf-t03', NULL, 'succeeded', 2, NULL, ?, ?, 'ok', ?, ?)`,
        scopeId,
        now + 10,
        now + 10,
        now + 10,
        now + 10
      );

      const ui = createStubUi({ confirmResult: true });
      const outcome = await runRestoreStoreBackup(
        { api, ui: ui.ui },
        { backupId: 'bkp-refresh-fail' }
      );
      expect(outcome.status).toBe('committed_refresh_failed');
      if (outcome.status === 'committed_refresh_failed') {
        expect(outcome.errorCode).toBe('POST_COMMIT_REFRESH_FAILED');
        expect(outcome.restoredTableCount).toBeGreaterThan(0);
        expect(outcome.restoredRunCount).toBe(1);
        expect(outcome.schemaVersion).toBeGreaterThanOrEqual(1);
      }

      // Live SQLite store WAS committed on disk.
      const survivingRuns = store.writerConnection
        .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
        .map((r) => r.run_id);
      expect(survivingRuns).toEqual(['run-before-t03']);

      // Command UI clearly tells operator backup was committed on disk and instructs reload,
      // and NEVER falsely claims live store was not modified.
      expect(ui.errors).toHaveLength(1);
      expect(ui.errors[0]).toContain("backup 'bkp-refresh-fail' was committed on disk");
      expect(ui.errors[0]).toContain('POST_COMMIT_REFRESH_FAILED');
      expect(ui.errors[0]).toMatch(/reload/i);
      expect(ui.errors[0]).not.toMatch(/not modified/i);

      // Audit log records POST_COMMIT_REFRESH_FAILED with closed 7-field shape and zero raw paths.
      const auditText = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      expect(auditText).not.toContain(workspaceRoot);
      expect(auditText).not.toContain(storageRoot);
      const entries = auditText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
      expect(entries).toHaveLength(2);
      expect(entries[1]?.eventType).toBe('store-restore');
      expect(entries[1]?.payload).toEqual({
        operation: 'restore',
        outcome: 'failed',
        backupId: 'bkp-refresh-fail',
        errorCode: 'POST_COMMIT_REFRESH_FAILED',
        schemaVersion: expect.any(Number),
        databaseBytes: expect.any(Number),
        restoredTableCount: expect.any(Number)
      });
    } finally {
      store.close();
    }
  });

  it('hardens opener rejections, non-owner refusals, audit append failures, dynamic trustedRootDir, and closed 7-field audit projection (FR-R7-11 T004 & Task 06)', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-t06-ws-'));
    const initialStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-t06-init-'));
    const relocatedStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cmd-t06-reloc-'));
    tempDirs.push(workspaceRoot, initialStorageRoot, relocatedStorageRoot);

    const scopeId = 'scope-cmd-t06';
    const now = 1_763_740_000_000;
    const auditLogPath = path.join(workspaceRoot, '.schegent', 'audit.log');
    const warnSpy = vi.fn();

    // 1. Non-owner refusals leave .schegent/audit.log untouched and log path-free warnings.
    const auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger([]));
    const nonOwnerApi = createStoreBackupRestoreApi({
      getSqliteStore: () => null,
      trustedRootDir: initialStorageRoot,
      scopeId,
      hasPrimacy: async () => false,
      hasInFlightRun: () => false,
      reloadAfterRestore: () => undefined,
      auditWriter,
      logger: { warn: warnSpy },
      nowMs: () => now
    });

    const noOwnerBkpUi = createStubUi({ confirmResult: true });
    const noOwnerBkp = await runBackupStore(
      { api: nonOwnerApi, ui: noOwnerBkpUi.ui },
      { backupId: 'bkp-no-owner' }
    );
    expect(noOwnerBkp).toMatchObject({ status: 'refused', reasonCode: 'NOT_WORKSPACE_OWNER' });
    expect(noOwnerBkpUi.warns).toHaveLength(1);
    expect(noOwnerBkpUi.warns[0]).toContain('NOT_WORKSPACE_OWNER');
    expect(noOwnerBkpUi.warns[0]).not.toContain(workspaceRoot);
    expect(noOwnerBkpUi.warns[0]).not.toContain(initialStorageRoot);
    expect(noOwnerBkpUi.warns[0]).not.toContain(relocatedStorageRoot);
    expect(noOwnerBkpUi.infos).toHaveLength(0);
    expect(noOwnerBkpUi.errors).toHaveLength(0);

    const noOwnerRestUi = createStubUi({ confirmResult: true });
    const noOwnerRest = await runRestoreStoreBackup(
      { api: nonOwnerApi, ui: noOwnerRestUi.ui },
      { backupId: 'bkp-no-owner' }
    );
    expect(noOwnerRest).toMatchObject({ status: 'refused', reasonCode: 'NOT_WORKSPACE_OWNER' });
    expect(noOwnerRestUi.warns).toHaveLength(1);
    expect(noOwnerRestUi.warns[0]).toContain('NOT_WORKSPACE_OWNER');
    expect(noOwnerRestUi.warns[0]).not.toContain(workspaceRoot);
    expect(noOwnerRestUi.warns[0]).not.toContain(initialStorageRoot);
    expect(noOwnerRestUi.warns[0]).not.toContain(relocatedStorageRoot);
    expect(noOwnerRestUi.infos).toHaveLength(0);
    expect(noOwnerRestUi.errors).toHaveLength(0);

    await expect(fs.access(auditLogPath)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]).toEqual([
      'store operation refused: not workspace owner',
      {
        operation: 'backup',
        outcome: 'refused',
        backupId: 'bkp-no-owner',
        errorCode: 'NOT_WORKSPACE_OWNER'
      }
    ]);
    expect(warnSpy.mock.calls[1]).toEqual([
      'store operation refused: not workspace owner',
      {
        operation: 'restore',
        outcome: 'refused',
        backupId: 'bkp-no-owner',
        errorCode: 'NOT_WORKSPACE_OWNER'
      }
    ]);

    // 2. ensurePrimaryStore rejection returns typed failed (STORE_OPEN_FAILED) + sanitized audit event
    // and UI error through the command boundary, never throwing an unhandled rejection or claiming success.
    const failingOpenApi = createStoreBackupRestoreApi({
      getSqliteStore: () => null,
      ensurePrimaryStore: async () => {
        throw new Error(`EACCES opening ${relocatedStorageRoot}/secret.db`);
      },
      trustedRootDir: initialStorageRoot,
      scopeId,
      hasPrimacy: async () => true,
      hasInFlightRun: () => false,
      reloadAfterRestore: () => undefined,
      auditWriter,
      logger: { warn: warnSpy },
      nowMs: () => now
    });

    const openFailBkpUi = createStubUi({ confirmResult: true });
    const bkpOpenFail = await runBackupStore(
      { api: failingOpenApi, ui: openFailBkpUi.ui },
      { backupId: 'bkp-open-fail' }
    );
    expect(bkpOpenFail).toMatchObject({ status: 'failed', errorCode: 'STORE_OPEN_FAILED' });
    if (bkpOpenFail.status === 'failed') {
      expect(bkpOpenFail.message).not.toContain(workspaceRoot);
      expect(bkpOpenFail.message).not.toContain(initialStorageRoot);
      expect(bkpOpenFail.message).not.toContain(relocatedStorageRoot);
    }
    expect(openFailBkpUi.errors).toHaveLength(1);
    expect(openFailBkpUi.errors[0]).toContain('STORE_OPEN_FAILED');
    expect(openFailBkpUi.errors[0]).not.toContain(workspaceRoot);
    expect(openFailBkpUi.errors[0]).not.toContain(initialStorageRoot);
    expect(openFailBkpUi.errors[0]).not.toContain(relocatedStorageRoot);
    expect(openFailBkpUi.errors[0]).not.toMatch(/created|succeeded/i);
    expect(openFailBkpUi.infos).toHaveLength(0);
    expect(openFailBkpUi.warns).toHaveLength(0);

    const openFailRestUi = createStubUi({ confirmResult: true });
    const restOpenFail = await runRestoreStoreBackup(
      { api: failingOpenApi, ui: openFailRestUi.ui },
      { backupId: 'bkp-open-fail' }
    );
    expect(restOpenFail).toMatchObject({ status: 'failed', errorCode: 'STORE_OPEN_FAILED' });
    if (restOpenFail.status === 'failed') {
      expect(restOpenFail.message).not.toContain(workspaceRoot);
      expect(restOpenFail.message).not.toContain(initialStorageRoot);
      expect(restOpenFail.message).not.toContain(relocatedStorageRoot);
    }
    expect(openFailRestUi.errors).toHaveLength(1);
    expect(openFailRestUi.errors[0]).toContain('STORE_OPEN_FAILED');
    expect(openFailRestUi.errors[0]).not.toContain(workspaceRoot);
    expect(openFailRestUi.errors[0]).not.toContain(initialStorageRoot);
    expect(openFailRestUi.errors[0]).not.toContain(relocatedStorageRoot);
    expect(openFailRestUi.errors[0]).not.toMatch(/restored|succeeded/i);
    expect(openFailRestUi.infos).toHaveLength(0);
    expect(openFailRestUi.warns).toHaveLength(0);

    const openFailAuditText = await fs.readFile(auditLogPath, 'utf8');
    expect(openFailAuditText).not.toContain(workspaceRoot);
    expect(openFailAuditText).not.toContain(relocatedStorageRoot);
    const openFailEntries = openFailAuditText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
    expect(openFailEntries).toHaveLength(2);
    expect(openFailEntries[0]?.payload).toEqual({
      operation: 'backup',
      outcome: 'failed',
      backupId: 'bkp-open-fail',
      errorCode: 'STORE_OPEN_FAILED'
    });
    expect(openFailEntries[1]?.payload).toEqual({
      operation: 'restore',
      outcome: 'failed',
      backupId: 'bkp-open-fail',
      errorCode: 'STORE_OPEN_FAILED'
    });

    // 3. Dynamic trustedRootDir thunk resolves AFTER ensurePrimaryStore(), and TOCTOU primacy loss
    // before restore commit leaves audit.log untouched while logging path-free warning.
    let activeRoot = initialStorageRoot;
    const storeRef: { current: SqliteApplicationStore | null } = { current: null };
    let primacyCalls = 0;
    let losePrimacyOnSecondCheck = false;
    const dynamicApi = createStoreBackupRestoreApi({
      getSqliteStore: () => storeRef.current,
      ensurePrimaryStore: async () => {
        activeRoot = relocatedStorageRoot;
        const dbDir = path.join(relocatedStorageRoot, 'sqlite', scopeId);
        await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
        storeRef.current = new SqliteApplicationStore({
          databasePath: path.join(dbDir, 'schegent-state.db'),
          journalMode: 'wal',
          nowMs: () => now
        });
        return storeRef.current;
      },
      trustedRootDir: () => activeRoot,
      scopeId,
      hasPrimacy: async () => {
        primacyCalls += 1;
        if (losePrimacyOnSecondCheck && primacyCalls === 2) return false;
        return true;
      },
      hasInFlightRun: () => false,
      reloadAfterRestore: () => undefined,
      auditWriter,
      logger: { warn: warnSpy },
      nowMs: () => now
    });

    try {
      const relocBkpUi = createStubUi({ confirmResult: true });
      const created = await runBackupStore(
        { api: dynamicApi, ui: relocBkpUi.ui },
        { backupId: 'bkp-reloc-1' }
      );
      expect(created.status).toBe('created');
      if (created.status === 'created') {
        expect(created.backupDatabasePath.startsWith(relocatedStorageRoot)).toBe(true);
      }
      expect(relocBkpUi.infos).toHaveLength(1);
      expect(relocBkpUi.errors).toHaveLength(0);
      expect(relocBkpUi.warns).toHaveLength(0);

      const auditLinesBeforeToctou = (await fs.readFile(auditLogPath, 'utf8')).trim().split('\n').length;
      warnSpy.mockClear();
      primacyCalls = 0;
      losePrimacyOnSecondCheck = true;
      const toctouUi = createStubUi({ confirmResult: true });
      const toctouRefused = await runRestoreStoreBackup(
        { api: dynamicApi, ui: toctouUi.ui },
        { backupId: 'bkp-reloc-1' }
      );
      expect(toctouRefused).toMatchObject({ status: 'refused', reasonCode: 'NOT_WORKSPACE_OWNER' });
      expect(toctouUi.warns).toHaveLength(1);
      expect(toctouUi.warns[0]).toContain('NOT_WORKSPACE_OWNER');
      expect(toctouUi.warns[0]).not.toContain(workspaceRoot);
      expect(toctouUi.warns[0]).not.toContain(initialStorageRoot);
      expect(toctouUi.warns[0]).not.toContain(relocatedStorageRoot);
      expect(toctouUi.infos).toHaveLength(0);
      expect(toctouUi.errors).toHaveLength(0);
      const auditLinesAfterToctou = (await fs.readFile(auditLogPath, 'utf8')).trim().split('\n').length;
      expect(auditLinesAfterToctou).toBe(auditLinesBeforeToctou);
      expect(warnSpy).toHaveBeenCalledWith('store operation refused: not workspace owner', {
        operation: 'restore',
        outcome: 'refused',
        backupId: 'bkp-reloc-1',
        errorCode: 'NOT_WORKSPACE_OWNER'
      });

      primacyCalls = 0;
      const backupRefused = await runBackupStore(
        { api: dynamicApi, ui: createStubUi().ui },
        { backupId: 'bkp-lost-ownership' }
      );
      expect(backupRefused).toMatchObject({ status: 'refused', reasonCode: 'NOT_WORKSPACE_OWNER' });
      expect((await dynamicApi.listBackups()).map((entry) => entry.backupId)).toEqual(['bkp-reloc-1']);
      expect((await fs.readFile(auditLogPath, 'utf8')).trim().split('\n')).toHaveLength(auditLinesBeforeToctou);

      // 4. Audit append failure logs a sanitized path-free warning without failing completed backup/restore
      // or reporting UI errors through the command boundary.
      warnSpy.mockClear();
      const throwingAuditApi = createStoreBackupRestoreApi({
        getSqliteStore: () => storeRef.current,
        trustedRootDir: () => activeRoot,
        scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        reloadAfterRestore: () => undefined,
        auditWriter: {
          append: async () => {
            throw new Error(`ENOSPC at ${workspaceRoot}/.schegent/audit.log`);
          }
        },
        logger: { warn: warnSpy },
        nowMs: () => now
      });

      const auditErrBkpUi = createStubUi({ confirmResult: true });
      const bkpWithAuditErr = await runBackupStore(
        { api: throwingAuditApi, ui: auditErrBkpUi.ui },
        { backupId: 'bkp-audit-err' }
      );
      expect(bkpWithAuditErr.status).toBe('created');
      expect(auditErrBkpUi.infos).toHaveLength(1);
      expect(auditErrBkpUi.infos[0]).toContain("backup 'bkp-audit-err' created");
      expect(auditErrBkpUi.infos[0]).not.toContain(workspaceRoot);
      expect(auditErrBkpUi.infos[0]).not.toContain('ENOSPC');
      expect(auditErrBkpUi.errors).toHaveLength(0);
      expect(auditErrBkpUi.warns).toHaveLength(0);

      const auditErrRestUi = createStubUi({ confirmResult: true });
      const restWithAuditErr = await runRestoreStoreBackup(
        { api: throwingAuditApi, ui: auditErrRestUi.ui },
        { backupId: 'bkp-audit-err' }
      );
      expect(restWithAuditErr.status).toBe('restored');
      expect(auditErrRestUi.infos).toHaveLength(1);
      expect(auditErrRestUi.infos[0]).toContain("store restored from 'bkp-audit-err'");
      expect(auditErrRestUi.infos[0]).not.toContain(workspaceRoot);
      expect(auditErrRestUi.infos[0]).not.toContain(initialStorageRoot);
      expect(auditErrRestUi.infos[0]).not.toContain(relocatedStorageRoot);
      expect(auditErrRestUi.infos[0]).not.toContain('ENOSPC');
      expect(auditErrRestUi.errors).toHaveLength(0);
      expect(auditErrRestUi.warns).toHaveLength(0);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(workspaceRoot);
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(relocatedStorageRoot);

      // 5. Closed 7-field audit projector pins exact allowed keys and rejects extra/malformed keys.
      const allowedKeys = new Set([
        'operation',
        'outcome',
        'backupId',
        'errorCode',
        'schemaVersion',
        'databaseBytes',
        'restoredTableCount'
      ]);
      const allAuditEntries = (await fs.readFile(auditLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
      for (const entry of allAuditEntries) {
        for (const key of Object.keys(entry.payload)) {
          expect(allowedKeys.has(key), `unexpected key '${key}' in ${entry.eventType}`).toBe(true);
        }
        expect(entry.payload).not.toHaveProperty('restoredRowCount');
        expect(entry.payload).not.toHaveProperty('verifiedExternalDependencies');
      }

      expect(
        projectAuditPayload('store-backup', {
          operation: 'backup',
          outcome: 'succeeded',
          backupId: 'bkp-closed-1',
          schemaVersion: 9,
          databaseBytes: 4096
        })
      ).toEqual({
        operation: 'backup',
        outcome: 'succeeded',
        backupId: 'bkp-closed-1',
        schemaVersion: 9,
        databaseBytes: 4096
      });
      expect(
        projectAuditPayload('store-restore', {
          operation: 'restore',
          outcome: 'succeeded',
          backupId: 'bkp-closed-1',
          schemaVersion: 9,
          databaseBytes: 4096,
          restoredTableCount: 128
        })
      ).toEqual({
        operation: 'restore',
        outcome: 'succeeded',
        backupId: 'bkp-closed-1',
        schemaVersion: 9,
        databaseBytes: 4096,
        restoredTableCount: 128
      });

      expect(() =>
        projectAuditPayload('store-restore', {
          operation: 'restore',
          outcome: 'succeeded',
          backupId: 'bkp-closed-1',
          restoredRowCount: 42
        })
      ).toThrow(AuditPayloadValidationError);
      expect(() =>
        projectAuditPayload('store-backup', {
          operation: 'backup',
          outcome: 'succeeded',
          backupId: 'bkp-closed-1',
          verifiedExternalDependencies: 1
        })
      ).toThrow(AuditPayloadValidationError);
      expect(() =>
        projectAuditPayload('store-backup', {
          operation: 'backup',
          outcome: 'succeeded',
          backupId: '../escape/path'
        })
      ).toThrow(AuditPayloadValidationError);
      expect(() =>
        projectAuditPayload('store-backup', {
          operation: 'restore',
          outcome: 'succeeded',
          backupId: 'bkp-closed-1'
        })
      ).toThrow(AuditPayloadValidationError);
    } finally {
      storeRef.current?.close();
    }
  });

  it('refuses leaf symlinks atomically via O_NOFOLLOW in computeFileDigestSync and external dependency inspector (FR-R7-11 Sec-M3)', async () => {
    if (process.platform === 'win32') return;
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-symlink-ws-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-symlink-out-'));
    tempDirs.push(workspaceRoot, outsideDir);

    const outsideFile = path.join(outsideDir, 'target.db');
    await fs.writeFile(outsideFile, 'secret-bytes', { mode: 0o600 });
    const symlinkDb = path.join(workspaceRoot, 'linked.db');
    await fs.symlink(outsideFile, symlinkDb);

    const digestRes = computeFileDigestSync(symlinkDb, MAX_BACKUP_DATABASE_BYTES);
    expect(digestRes).toEqual({
      ok: false,
      error: 'Backup database path must not be a symbolic link'
    });

    const inspector = createWorkspaceExternalDependencyInspector(workspaceRoot);
    expect(inspector('linked.db')).toEqual({
      exists: false,
      byteLength: 0,
      sha256Digest: ''
    });
  });
});
