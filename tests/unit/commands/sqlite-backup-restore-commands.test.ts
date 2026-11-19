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
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
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
  SqliteApplicationStore
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
        await fs.writeFile(dbPath, dbBytes);
        const manifest = {
          ...created.manifest,
          backupId: id,
          databaseSha256: createHash('sha256').update(dbBytes).digest('hex'),
          databaseBytes: dbBytes.byteLength,
          ...manifestPatch
        };
        await fs.writeFile(mfPath, JSON.stringify(manifest, null, 2));
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
      await fs.writeFile(path.join(backupsDir, 'bkp-no-manifest.db'), baseBytes);

      // 6. FOREIGN_KEY_CHECK_FAILED
      const fkPath = path.join(backupsDir, 'bkp-fk-bad.db');
      await fs.writeFile(fkPath, baseBytes);
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
      await fs.writeFile(spoofDb, baseBytes);
      await fs.writeFile(
        spoofMf,
        JSON.stringify({ ...created.manifest, backupId: 'bkp-spoofed-other' }, null, 2)
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
});
