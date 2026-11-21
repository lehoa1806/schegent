// FR-R7-11 (Tasks 03, 04, 06, 16) — End-to-end activation wiring tests for
// `registerSqliteBackupCommands`: immediate catalog visibility after restore,
// post-commit refresh failure reporting, authoritative connected-Workflow guard
// without relational `runs` projection rows, and dynamic legacy backup root
// placement when canonical globalStorage is WAL-ineligible.

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registeredCommands = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const warningMock = vi.hoisted(() => vi.fn());
const quickPickMock = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (_k: string, def: unknown) => def,
      inspect: () => undefined
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined })
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      registeredCommands.set(id, handler);
      return { dispose: () => registeredCommands.delete(id) };
    }
  },
  window: {
    showWarningMessage: (...args: unknown[]) => warningMock(...args),
    showQuickPick: (...args: unknown[]) => quickPickMock(...args)
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}));

import { registerSqliteBackupCommands } from '../../../src/activation/sqlite-backup-commands-wiring';
import {
  createSqliteCutoverCoordinator,
  deriveWorkspaceScopeId,
  registerOperationalMementoForStore
} from '../../../src/activation/sqlite-cutover-wiring';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { SanitizedLogger } from '../../../src/lib/logger';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';
import type { RecoveryEnvelopePort } from '../../../src/services/recovery-handoff';
import type { ConnectedWorkflowRun, WorkflowInvocationFrame } from '../../../src/state/connected-workflow-run';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { Notifier } from '../../../src/ui/notifications';
import { removeTempRoot } from '../../temp-root-cleanup';

function createMemoryMemento(): Memento {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    }
  };
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  await fsp.mkdir(path.join(dir, 'globalStorage', 'schegent.schegent'), { recursive: true, mode: 0o700 });
  return dir;
}

afterEach(async () => {
  registeredCommands.clear();
  warningMock.mockReset();
  quickPickMock.mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removeTempRoot(dir);
  }
});

function createSpyLogger() {
  const entries: Array<{ readonly level: string; readonly msg: string; readonly meta: unknown }> = [];
  const logger = {
    info: (msg: string, meta?: unknown) => entries.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta?: unknown) => entries.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: unknown) => entries.push({ level: 'error', msg, meta }),
    debug: (msg: string, meta?: unknown) => entries.push({ level: 'debug', msg, meta })
  } as unknown as SanitizedLogger;
  return { logger, entries };
}

function createSpyNotifier() {
  const calls: Array<{ readonly level: 'info' | 'warn' | 'error'; readonly message: string }> = [];
  const notifier = {
    info: (message: string) => calls.push({ level: 'info', message }),
    warn: (message: string) => calls.push({ level: 'warn', message }),
    error: (message: string) => calls.push({ level: 'error', message })
  } as unknown as Notifier;
  return { notifier, calls };
}

function makeConnectedRunWithStatus(
  id: string,
  status: WorkflowInvocationFrame['status']
): ConnectedWorkflowRun {
  const invId = `inv-${id}`;
  return {
    connectedRunId: id,
    workflowId: 'wf-chain',
    revision: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    rootInvocationId: invId,
    invocations: {
      [invId]: {
        invocationId: invId,
        workflowId: 'wf-chain',
        workflowVersionId: 'v1',
        parentInvocationId: null,
        parentNodeId: null,
        parentAttemptId: null,
        status,
        resolvedInputs: {},
        nodeStates: {},
        attemptsByNodeId: {},
        pendingHandoff: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000
      }
    },
    pendingHandoff: null,
    nodeAttempts: {},
    decisions: []
  } as unknown as ConnectedWorkflowRun;
}

function upsertKv(
  db: SqliteApplicationStore['writerConnection'],
  scopeId: string,
  key: string,
  revision: number,
  updatedAtMs: number,
  value: unknown
): void {
  const payload = JSON.stringify(value);
  db.run(
    `INSERT OR REPLACE INTO operational_kv_documents (doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms)
     VALUES (?, ?, ?, 9, ?, ?, 0, ?)`,
    scopeId,
    key,
    revision,
    payload,
    Buffer.byteLength(payload, 'utf8'),
    updatedAtMs
  );
}

describe('FR-R7-11 sqlite-backup-commands-wiring regression suite', () => {
  it('Task 03: invokes refreshCatalog on restore for immediate catalog visibility and reports committed_refresh_failed accurately when refresh throws', async () => {
    const root = await makeTempDir('fr-r7-11-bkp-t03-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

    const { logger } = createSpyLogger();
    const { notifier, calls: notifierCalls } = createSpyNotifier();
    const auditEvents: Array<Record<string, unknown>> = [];
    const auditWriter = {
      append: async (entry: Record<string, unknown>) => {
        auditEvents.push(entry);
      },
      write: async () => undefined,
      subscribe: () => ({ dispose: () => undefined })
    } as unknown as AuditLogWriter;

    const legacyMemento = createMemoryMemento();
    const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);
    await store.initialize();

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: []
    });

    const services = await coord.activatePrimary();
    expect(services).not.toBeNull();
    const db = services!.sqliteStore.writerConnection;
    const scopeId = coord.scopeId;

    // Seed initial catalog definition v1 in SQLite.
    upsertKv(db, scopeId, 'catalog:phase:p1', 1, 1700000000000, { id: 'p1', label: 'Backed Up v1' });

    let liveCatalogLabel = 'Backed Up v1';
    let shouldFailCatalogRefresh = false;
    let projectorKicks = 0;
    const refreshCatalog = vi.fn(async () => {
      if (shouldFailCatalogRefresh) {
        throw new Error('catalog-refresh-boom');
      }
      const row = db.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = 'catalog:phase:p1'`,
        scopeId
      );
      liveCatalogLabel = row ? (JSON.parse(row.payload_json) as { label: string }).label : 'missing';
    });

    // Always confirm modal prompts with the approve label (3rd arg to showWarningMessage).
    warningMock.mockImplementation((_msg: unknown, _opts: unknown, approveLabel: unknown) =>
      Promise.resolve(approveLabel)
    );

    const disposables = registerSqliteBackupCommands(
      {
        isWorkspaceTrusted: () => true,
        isOwner: async () => true,
        notifier,
        logger
      } as never,
      {
        workspaceRoot,
        globalStorageRoot: globalStorage,
        store,
        controller: { liveRunCount: 0 } as unknown as SchegentWorkflowController,
        lock: { hasPrimacy: async () => true },
        auditWriter,
        notifier,
        projector: { kick: () => { projectorKicks += 1; } },
        refreshCatalog,
        logger
      }
    );

    // 1. Create backup containing v1.
    await registeredCommands.get('schegent.backupStore')!();
    const backupsDir = path.join(globalStorage, 'sqlite', scopeId, 'backups');
    const backupFile = (await fsp.readdir(backupsDir)).find((f) => f.endsWith('.db'))!;
    const backupId = backupFile.replace(/\.db$/, '');

    // 2. Mutate live DB to v2 and add an extra row.
    upsertKv(db, scopeId, 'catalog:phase:p1', 2, 1700000005000, { id: 'p1', label: 'Mutated v2' });
    await refreshCatalog();
    expect(liveCatalogLabel).toBe('Mutated v2');

    // 3. Normal restore must invoke refreshCatalog and immediately expose v1.
    refreshCatalog.mockClear();
    await registeredCommands.get('schegent.restoreStoreBackup')!(backupId);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(liveCatalogLabel).toBe('Backed Up v1');
    expect(projectorKicks).toBeGreaterThan(0);

    // 4. Mutate again to v3, inject refreshCatalog failure, and restore:
    // SQLite MUST commit v1 while command UI explicitly reports disk commit + reload guidance.
    upsertKv(db, scopeId, 'catalog:phase:p1', 3, 1700000010000, { id: 'p1', label: 'Mutated v3' });
    shouldFailCatalogRefresh = true;
    notifierCalls.length = 0;

    await registeredCommands.get('schegent.restoreStoreBackup')!(backupId);

    // Verify DB on disk committed v1.
    const postRow = db.get<{ payload_json: string }>(
      `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = 'catalog:phase:p1'`,
      scopeId
    );
    expect((JSON.parse(postRow!.payload_json) as { label: string }).label).toBe('Backed Up v1');

    // Verify operator UI distinguishes post-commit refresh failure and NEVER says untouched.
    const errorMsg = notifierCalls.find((c) => c.level === 'error')?.message ?? '';
    expect(errorMsg).toContain('committed on disk');
    expect(errorMsg).toContain('POST_COMMIT_REFRESH_FAILED');
    expect(errorMsg.toLowerCase()).toContain('reload');
    expect(errorMsg).not.toContain('Live store was not modified');

    for (const d of disposables) d.dispose();
    coord.close();
  });

  it.each(['waiting-for-handoff', 'paused', 'in-flight'] as const)(
    'Task 04: blocks registered restore command when connected Workflow invocation frame is %s even without relational runs rows',
    async (frameStatus) => {
      const root = await makeTempDir(`fr-r7-11-bkp-t04-${frameStatus}-`);
      const workspaceRoot = path.join(root, 'workspace');
      await fsp.mkdir(workspaceRoot, { recursive: true });
      const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

      const { logger } = createSpyLogger();
      const { notifier, calls: notifierCalls } = createSpyNotifier();
      const auditWriter = {
        append: async () => undefined,
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter;

      const legacyMemento = createMemoryMemento();
      const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
      const store = new WorkspaceStateStore(operationalMemento, logger);
      registerOperationalMementoForStore(store, operationalMemento);
      await store.initialize();

      const coord = createSqliteCutoverCoordinator({
        context: {
          storageUri: undefined,
          globalStorageUri: { fsPath: globalStorage } as never,
          subscriptions: []
        },
        workspaceRoot,
        store,
        auditWriter,
        envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
        pinnedRunIds: () => new Set(),
        logger,
        isWorkspaceTrusted: () => true,
        hasPrimacy: async () => true,
        disposables: []
      });

      const services = await coord.activatePrimary();
      const db = services!.sqliteStore.writerConnection;
      const scopeId = coord.scopeId;

      upsertKv(db, scopeId, 'sentinel:marker', 1, 1700000000000, { value: 'before-backup' });

      warningMock.mockImplementation((_msg: unknown, _opts: unknown, approveLabel: unknown) =>
        Promise.resolve(approveLabel)
      );

      let connectedRunsMap: Readonly<Record<string, ConnectedWorkflowRun>> = {};
      const spyConnected = vi.spyOn(store, 'getConnectedRuns').mockImplementation(() => connectedRunsMap);

      const liveDisposables = registerSqliteBackupCommands(
        {
          isWorkspaceTrusted: () => true,
          isOwner: async () => true,
          notifier,
          logger
        } as never,
        {
          workspaceRoot,
          globalStorageRoot: globalStorage,
          store,
          controller: { liveRunCount: 0 } as unknown as SchegentWorkflowController,
          lock: { hasPrimacy: async () => true },
          auditWriter,
          notifier,
          projector: { kick: () => undefined },
          refreshCatalog: async () => undefined,
          logger
        }
      );

      // Backup clean state.
      await registeredCommands.get('schegent.backupStore')!();
      const backupsDir = path.join(globalStorage, 'sqlite', scopeId, 'backups');
      const backupId = (await fsp.readdir(backupsDir)).find((f) => f.endsWith('.db'))!.replace(/\.db$/, '');

      // Mutate live DB row and clear relational `runs` rows so ONLY the connected-Workflow guard can block.
      upsertKv(db, scopeId, 'sentinel:marker', 2, 1700000005000, { value: 'live-unreplaced' });
      db.run(`DELETE FROM runs`);
      connectedRunsMap = { 'crun-1': makeConnectedRunWithStatus('crun-1', frameStatus) };
      notifierCalls.length = 0;

      await registeredCommands.get('schegent.restoreStoreBackup')!(backupId);

      // Must refuse with RUN_IN_FLIGHT and leave live row untouched.
      const warnMsg = notifierCalls.find((c) => c.level === 'warn')?.message ?? '';
      expect(warnMsg).toContain('RUN_IN_FLIGHT');
      const liveRow = db.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = 'sentinel:marker'`,
        scopeId
      );
      expect((JSON.parse(liveRow!.payload_json) as { value: string }).value).toBe('live-unreplaced');

      spyConnected.mockRestore();
      for (const d of liveDisposables) d.dispose();
      coord.close();
    }
  );

  it('Task 16: routes backup, verify, and restore to the active legacy root when canonical globalStorage is WAL-ineligible with zero writes to refused globalStorage', async () => {
    const root = await makeTempDir('fr-r7-11-bkp-t16-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const refusedGlobalStorage = path.join(root, 'nfsGlobalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', 'aaaa1111', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    // Seed a working local legacy DB.
    const legacyDir = path.join(legacyStorage, 'sqlite', scopeId);
    await fsp.mkdir(legacyDir, { recursive: true, mode: 0o700 });
    const legacyDbPath = path.join(legacyDir, 'schegent-state.db');
    const seeded = new SqliteApplicationStore({ databasePath: legacyDbPath, journalMode: 'wal' });
    seeded.writerConnection.run(
      `INSERT OR REPLACE INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
       VALUES (?, 'sqlite', 'publish-authority', 1, 'l', 's', 1700000001000)`,
      scopeId
    );
    upsertKv(seeded.writerConnection, scopeId, 'marker', 1, 1700000001000, { phase: 'legacy-v1' });
    seeded.close();

    const { logger } = createSpyLogger();
    const { notifier, calls: notifierCalls } = createSpyNotifier();
    const notices: string[] = [];
    const auditWriter = {
      append: async () => undefined,
      write: async () => undefined,
      subscribe: () => ({ dispose: () => undefined })
    } as unknown as AuditLogWriter;

    const legacyMemento = createMemoryMemento();
    const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);
    await store.initialize();

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyStorage } as never,
        globalStorageUri: { fsPath: refusedGlobalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: [],
      // Real detector hook classifying refusedGlobalStorage as NFS and legacyStorage as local APFS.
      detectFilesystemType: async (targetPath: string) =>
        targetPath.startsWith(refusedGlobalStorage)
          ? { classification: 'network', filesystemType: 'nfs' }
          : { classification: 'local', filesystemType: 'apfs' },
      notifyOperator: (m) => {
        notices.push(m);
      }
    });

    warningMock.mockImplementation((_msg: unknown, _opts: unknown, approveLabel: unknown) =>
      Promise.resolve(approveLabel)
    );

    const disposables = registerSqliteBackupCommands(
      {
        isWorkspaceTrusted: () => true,
        isOwner: async () => true,
        notifier,
        logger
      } as never,
      {
        workspaceRoot,
        globalStorageRoot: refusedGlobalStorage,
        store,
        controller: { liveRunCount: 0 } as unknown as SchegentWorkflowController,
        lock: { hasPrimacy: async () => true },
        auditWriter,
        notifier,
        projector: { kick: () => undefined },
        refreshCatalog: async () => undefined,
        logger
      }
    );

    // Trigger backup BEFORE manual activatePrimary — backup command triggers ensurePrimaryStore()
    // which falls back to legacyStorage, and MUST write backup under legacyStorage (zero writes to refusedGlobalStorage).
    await registeredCommands.get('schegent.backupStore')!();

    expect(coord.storageRoot).toBe(legacyStorage);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]).toContain('network_share_wal_unsupported');

    // Zero files or directories created at refusedGlobalStorage.
    await expect(fsp.lstat(refusedGlobalStorage)).rejects.toMatchObject({ code: 'ENOENT' });

    // Backup exists under legacyStorage and verifies cleanly.
    const legacyBackupsDir = path.join(legacyStorage, 'sqlite', scopeId, 'backups');
    const files = await fsp.readdir(legacyBackupsDir);
    const backupDb = files.find((f) => f.endsWith('.db'));
    expect(backupDb).toBeDefined();
    const backupId = backupDb!.replace(/\.db$/, '');

    notifierCalls.length = 0;
    await registeredCommands.get('schegent.verifyStoreBackup')!(backupId);
    expect(notifierCalls.some((c) => c.level === 'info' && c.message.includes('verified'))).toBe(true);

    for (const d of disposables) d.dispose();
    coord.close();
  });

  it('A-P2-2: schegent.verifyStoreBackup (no backupId) finds and verifies backups under legacy root on passive legacy-fallback workspace without calling activatePrimary or backupStore first', async () => {
    const root = await makeTempDir('fr-r7-11-bkp-ap2-2-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const refusedGlobalStorage = path.join(root, 'nfsGlobalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', 'bbbb2222', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    // Seed a legacy DB and create a valid backup directly under legacyStorage (no canonical DB present).
    const legacyDir = path.join(legacyStorage, 'sqlite', scopeId);
    await fsp.mkdir(legacyDir, { recursive: true, mode: 0o700 });
    const legacyDbPath = path.join(legacyDir, 'schegent-state.db');
    const seeded = new SqliteApplicationStore({ databasePath: legacyDbPath, journalMode: 'wal' });
    seeded.writerConnection.run(
      `INSERT OR REPLACE INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
       VALUES (?, 'sqlite', 'publish-authority', 1, 'l', 's', 1700000001000)`,
      scopeId
    );
    upsertKv(seeded.writerConnection, scopeId, 'marker', 1, 1700000001000, { phase: 'legacy-backup-v1' });
    const backupId = 'legacy-passive-bkp-001';
    await seeded.backupRestore.createOnlineBackup({
      backupId,
      scopeId,
      trustedRootDir: legacyStorage,
      relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
    });
    seeded.close();

    const { logger } = createSpyLogger();
    const { notifier, calls: notifierCalls } = createSpyNotifier();
    const auditWriter = {
      append: async () => undefined,
      write: async () => undefined,
      subscribe: () => ({ dispose: () => undefined })
    } as unknown as AuditLogWriter;

    const legacyMemento = createMemoryMemento();
    const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);

    // Construct coordinator passively (do NOT call activatePrimary or backupStore!).
    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyStorage } as never,
        globalStorageUri: { fsPath: refusedGlobalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: [],
      detectFilesystemType: async (targetPath: string) =>
        targetPath.startsWith(refusedGlobalStorage)
          ? { classification: 'network', filesystemType: 'nfs' }
          : { classification: 'local', filesystemType: 'apfs' }
    });
    await coord.probePassiveSnapshots();

    expect(coord.getServices()).toBeNull();
    expect(coord.storageRoot).toBe(legacyStorage);

    const disposables = registerSqliteBackupCommands(
      {
        isWorkspaceTrusted: () => true,
        isOwner: async () => true,
        notifier,
        logger
      } as never,
      {
        workspaceRoot,
        globalStorageRoot: refusedGlobalStorage,
        store,
        controller: { liveRunCount: 0 } as unknown as SchegentWorkflowController,
        lock: { hasPrimacy: async () => true },
        auditWriter,
        notifier,
        projector: { kick: () => undefined },
        refreshCatalog: async () => undefined,
        logger
      }
    );

    quickPickMock.mockImplementation(async (items: readonly { backupId: string }[]) => items[0]);

    // Invoke verifyStoreBackup with NO backupId -> calls listBackups() on coordinator.storageRoot!
    await registeredCommands.get('schegent.verifyStoreBackup')!();

    expect(quickPickMock).toHaveBeenCalledTimes(1);
    const pickedCandidates = quickPickMock.mock.calls[0]![0] as readonly { backupId: string }[];
    expect(pickedCandidates.map((c) => c.backupId)).toContain(backupId);
    expect(notifierCalls.some((c) => c.level === 'info' && c.message.includes('verified'))).toBe(true);
    // Still zero writes to refusedGlobalStorage.
    await expect(fsp.lstat(refusedGlobalStorage)).rejects.toMatchObject({ code: 'ENOENT' });

    for (const d of disposables) d.dispose();
    coord.close();
  });
});
