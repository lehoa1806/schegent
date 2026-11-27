// FR-R7-10 — Integration tests for primary activation wiring in `sqlite-cutover-wiring.ts`:
// ownership-fence gating, non-mutating untrusted/non-primary read-only probe, conflict logging
// without row content, single operator notice, GC-09 refusal, and fallback protected paths.
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, def: unknown) => def,
      inspect: () => undefined
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined })
  },
  window: {
    showWarningMessage: vi.fn()
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}));

import {
  createSqliteCutoverCoordinator,
  deriveWorkspaceScopeId,
  registerCatalogFsForStore,
  registerOperationalMementoForStore
} from '../../../src/activation/sqlite-cutover-wiring';
import {
  buildNodeLifecycleFs,
  disposeSqliteRuntimeResources,
  reportRelocationOutcome
} from '../../../src/activation/sqlite-cutover-helpers';
import {
  createSwitchableCatalogFsAdapter,
  SqliteApplicationStore,
  type SwitchableCatalogFsAdapter
} from '../../../src/services/sqlite-store';
import type { CatalogFsPort } from '../../../src/catalog/ports';
import type { TelemetryHostService } from '../../../src/services/telemetry-host/telemetry-host-service';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { RecoveryEnvelopePort } from '../../../src/services/recovery-handoff';
import {
  createSwitchableOperationalMemento,
  PostCutoverMementoWriteForbiddenError
} from '../../../src/state/sqlite-operational-backing';
import {
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removeTempRoot(dir);
  }
});

function createSpyLogger(): {
  readonly logger: SanitizedLogger;
  readonly entries: Array<{ readonly level: string; readonly msg: string; readonly meta: unknown }>;
} {
  const entries: Array<{ readonly level: string; readonly msg: string; readonly meta: unknown }> = [];
  const logger = {
    info: (msg: string, meta?: unknown) => entries.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta?: unknown) => entries.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: unknown) => entries.push({ level: 'error', msg, meta }),
    debug: (msg: string, meta?: unknown) => entries.push({ level: 'debug', msg, meta })
  } as unknown as SanitizedLogger;
  return { logger, entries };
}

function createMinimalStore(): WorkspaceStateStore {
  let controlLedger: unknown;
  return {
    getRunMap: () => ({}),
    getConnectedRuns: () => ({}),
    getQueueMap: () => ({}),
    getQueueRegistry: () => ({ activeQueueId: 'default', queues: [] }),
    getRawControlLedger: () => controlLedger,
    transactControlLedger: async <T>(
      op: (raw: unknown, write: (next: unknown) => Promise<void>) => Promise<T>
    ): Promise<T> =>
      op(controlLedger, async (next) => {
        controlLedger = next;
      })
  } as unknown as WorkspaceStateStore;
}

async function seedLegacyDb(
  storageRoot: string,
  scopeId: string,
  runId: string,
  updatedAtMs: number,
  options?: { readonly minReaderVersion?: number }
): Promise<string> {
  const dir = path.join(storageRoot, 'sqlite', scopeId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dir, 'schegent-state.db');
  const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => updatedAtMs });
  store.writerConnection.run(
    `INSERT OR REPLACE INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
     VALUES (?, 'sqlite', 'publish-authority', 1, 'legacy-sha', 'sqlite-sha', ?)`,
    scopeId,
    updatedAtMs
  );
  store.writerConnection.run(
    `INSERT OR REPLACE INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
     VALUES (?, 'default', ?, 1, 'feat-1', 'completed', 'done', ?, ?, NULL, ?)`,
    scopeId,
    runId,
    updatedAtMs,
    updatedAtMs,
    JSON.stringify({ id: runId, sensitivePrompt: 'DO_NOT_LEAK_ROW_CONTENT_XYZ' })
  );
  if (options?.minReaderVersion !== undefined) {
    store.writerConnection.run(
      `INSERT OR REPLACE INTO schema_meta (meta_key, meta_value, updated_at_ms) VALUES ('min_reader_version', ?, ?)`,
      String(options.minReaderVersion),
      updatedAtMs
    );
  }
  store.close();
  return dbPath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('FR-R7-10 — createSqliteCutoverCoordinator relocation wiring', () => {
  it('does not relocate when untrusted or without ownership fence, then relocates when trusted primary activates', async () => {
    const root = await makeTempDir('fr-r7-10-coord-');
    const workspaceRoot = path.join(root, 'repo-a');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);
    const legacyDb = await seedLegacyDb(legacyStorage, scopeId, 'run-primary-1', 1_700_000_001_000);

    const { logger } = createSpyLogger();
    const notices: string[] = [];
    const disposables: Array<{ dispose(): void }> = [];
    let trusted = false;
    let primary = false;

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyStorage } as never,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store: createMinimalStore(),
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => trusted,
      hasPrimacy: async () => primary,
      disposables,
      notifyOperator: (m) => {
        notices.push(m);
      }
    });

    // Untrusted/non-primary activation does NOT relocate.
    expect(await coord.activatePrimary()).toBeNull();
    expect(await exists(legacyDb)).toBe(true);
    expect(await exists(coord.expectedDatabasePath)).toBe(false);

    // Trusted but still non-primary does NOT relocate.
    trusted = true;
    expect(await coord.activatePrimary()).toBeNull();
    expect(await exists(legacyDb)).toBe(true);
    expect(await exists(coord.expectedDatabasePath)).toBe(false);

    // Trusted + primary relocates into globalStorageUri and opens the canonical store.
    primary = true;
    const services = await coord.activatePrimary();
    expect(services).not.toBeNull();
    expect(await exists(coord.expectedDatabasePath)).toBe(true);
    expect(await exists(legacyDb)).toBe(false);
    expect(notices).toHaveLength(0);

    const rows = services!.sqliteStore.writerConnection.all<{ run_id: string }>('SELECT run_id FROM operational_runs');
    expect(rows.map((r) => r.run_id)).toEqual(['run-primary-1']);

    coord.close();
  });

  it('logs preserved conflict path with zero row content, surfaces one notice, and protects both active and preserved paths', async () => {
    const root = await makeTempDir('fr-r7-10-coord-conflict-');
    const workspaceRoot = path.join(root, 'repo-b');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyDirect = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyCodeWs = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    const olderDb = await seedLegacyDb(legacyDirect, scopeId, 'run-older', 1_700_000_001_000);
    await seedLegacyDb(legacyCodeWs, scopeId, 'run-newer', 1_700_000_009_000);

    const { logger, entries } = createSpyLogger();
    const notices: string[] = [];
    const disposables: Array<{ dispose(): void }> = [];

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyDirect } as never,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store: createMinimalStore(),
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables,
      notifyOperator: (m) => {
        notices.push(m);
      }
    });

    const services = await coord.activatePrimary();
    expect(services).not.toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(olderDb);
    expect(notices[0]).not.toContain('DO_NOT_LEAK_ROW_CONTENT_XYZ');

    const serializedLogs = JSON.stringify(entries);
    expect(serializedLogs).toContain(olderDb);
    expect(serializedLogs).not.toContain('DO_NOT_LEAK_ROW_CONTENT_XYZ');

    const protectedPaths = coord.getDatabaseProtectedPaths();
    expect(protectedPaths).toContain(coord.expectedDatabasePath);
    expect(protectedPaths).toContain(olderDb);
    expect(protectedPaths).toContain(`${olderDb}-wal`);

    coord.close();
  });

  it('refuses activation without moving file on newer min_reader_version and emits one notice', async () => {
    const root = await makeTempDir('fr-r7-10-coord-gc09-');
    const workspaceRoot = path.join(root, 'repo-c');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    const futureDb = await seedLegacyDb(legacyStorage, scopeId, 'run-future', 1_700_000_001_000, {
      minReaderVersion: 99
    });

    const { logger } = createSpyLogger();
    const notices: string[] = [];

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyStorage } as never,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store: createMinimalStore(),
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: [],
      notifyOperator: (m) => {
        notices.push(m);
      }
    });

    const services = await coord.activatePrimary();
    expect(services).toBeNull();
    expect(await exists(futureDb)).toBe(true);
    expect(await exists(coord.expectedDatabasePath)).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('UNSUPPORTED_MIN_READER_VERSION');

    coord.close();
  });

  it('falls back to operating on the legacy store in place when canonical root is on a WAL-refused network FS', async () => {
    const root = await makeTempDir('fr-r7-10-coord-nfs-');
    const workspaceRoot = path.join(root, 'repo-d');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    const legacyDb = await seedLegacyDb(legacyStorage, scopeId, 'run-nfs-fallback', 1_700_000_001_000);
    const { logger } = createSpyLogger();
    const notices: string[] = [];

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyStorage } as never,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store: createMinimalStore(),
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: [],
      canonicalFilesystemType: 'nfs',
      notifyOperator: (m) => {
        notices.push(m);
      }
    });

    const services = await coord.activatePrimary();
    expect(services).not.toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('network_share_wal_unsupported');

    const protectedPaths = coord.getDatabaseProtectedPaths();
    expect(protectedPaths).toContain(legacyDb);
    expect(protectedPaths).toContain(`${legacyDb}-wal`);
    expect(await exists(coord.expectedDatabasePath)).toBe(false);

    const checkDb = new DatabaseSync(legacyDb, { readOnly: true });
    const rows = checkDb.prepare('SELECT run_id FROM operational_runs').all() as Array<{ run_id: string }>;
    checkDb.close();
    expect(rows.map((r) => r.run_id)).toEqual(['run-nfs-fallback']);
    expect(coord.storageRoot).toBe(legacyStorage);

    coord.close();
  });

  it('FR-R7-11 Task 01: arms durable batch refusal when primary SQLite store cannot open so legacy Memento receives zero writes', async () => {
    const root = await makeTempDir('fr-r7-11-coord-durable-');
    const workspaceRoot = path.join(root, 'repo-durable');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

    const { logger } = createSpyLogger();
    const notices: string[] = [];
    const legacyMemento = createMemoryMemento();
    const updateSpy = vi.spyOn(legacyMemento, 'update');
    const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: [],
      detectFilesystemType: async () => ({ classification: 'network', filesystemType: 'nfs' }),
      notifyOperator: (m) => {
        notices.push(m);
      }
    });

    const services = await coord.activatePrimary();
    expect(services).toBeNull();
    expect(notices.length).toBeGreaterThanOrEqual(1);
    updateSpy.mockClear();

    await expect(
      operationalMemento.updateBatch([
        { key: 'schegent.run', value: { default: { id: 'r1' } } },
        { key: 'schegent.queue', value: { default: { items: [] } } }
      ])
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof QueueMutationRejected && err.reason === 'durable-store-unavailable'
    );
    expect(updateSpy).not.toHaveBeenCalled();

    coord.close();
  });

  it('FR-R7-11 Task 18: passive probe refuses in-root symlinks and creates zero -wal/-shm sidecars on WAL databases', async () => {
    const root = await makeTempDir('fr-r7-11-coord-passive-');
    const workspaceRoot = path.join(root, 'repo-passive');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    const canonicalDb = await seedLegacyDb(globalStorage, scopeId, 'run-passive-1', 1_700_000_002_000);
    // Ensure clean WAL-mode DB with no -wal/-shm files prior to passive probe.
    await fsp.rm(`${canonicalDb}-wal`, { force: true });
    await fsp.rm(`${canonicalDb}-shm`, { force: true });
    const bytesBefore = await fsp.readFile(canonicalDb);

    const { logger } = createSpyLogger();
    const operationalMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => false,
      hasPrimacy: async () => false,
      disposables: []
    });
    await coord.probePassiveSnapshots();

    expect(operationalMemento.isPostCutoverAuthorityActive()).toBe(true);
    expect(await exists(`${canonicalDb}-wal`)).toBe(false);
    expect(await exists(`${canonicalDb}-shm`)).toBe(false);
    expect((await fsp.readFile(canonicalDb)).equals(bytesBefore)).toBe(true);
    coord.close();

    // In-root symlink test: symlink sqlite/<scope> -> realDir inside globalStorage MUST be refused.
    const symlinkRoot = await makeTempDir('fr-r7-11-coord-symlink-');
    const symGlobal = path.join(symlinkRoot, 'globalStorage', 'schegent.schegent');
    const realTargetDir = path.join(symGlobal, 'redirected-scope');
    await fsp.mkdir(realTargetDir, { recursive: true, mode: 0o700 });
    await fsp.copyFile(canonicalDb, path.join(realTargetDir, 'schegent-state.db'));
    await fsp.mkdir(path.join(symGlobal, 'sqlite'), { recursive: true, mode: 0o700 });
    await fsp.symlink(realTargetDir, path.join(symGlobal, 'sqlite', scopeId));

    const symMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
    const symStore = new WorkspaceStateStore(symMemento, logger);
    registerOperationalMementoForStore(symStore, symMemento);

    const symCoord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: symGlobal } as never,
        subscriptions: []
      },
      workspaceRoot,
      store: symStore,
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => false,
      hasPrimacy: async () => false,
      disposables: []
    });
    await symCoord.probePassiveSnapshots();
    expect(symMemento.isPostCutoverAuthorityActive()).toBe(false);
    symCoord.close();
  });

  it('FR-R7-11 Task 20: artifact lifecycle unlink refuses canonical, fallback, sidecar, and preserved unselected database paths', async () => {
    const root = await makeTempDir('fr-r7-11-coord-lifecycle-');
    const workspaceRoot = path.join(root, 'repo-life');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    const canonicalDb = await seedLegacyDb(globalStorage, scopeId, 'run-c', 1_700_000_005_000);
    const preservedDb = await seedLegacyDb(legacyStorage, scopeId, 'run-l', 1_700_000_001_000);
    await fsp.writeFile(`${canonicalDb}-wal`, 'wal-bytes', { mode: 0o600 });

    const lifecycleFs = buildNodeLifecycleFs(
      [workspaceRoot, globalStorage, legacyStorage],
      () => [canonicalDb, `${canonicalDb}-wal`, `${canonicalDb}-shm`, preservedDb]
    );

    await expect(lifecycleFs.unlink(canonicalDb)).rejects.toThrow(/protected SQLite store path/);
    await expect(lifecycleFs.unlink(`${canonicalDb}-wal`)).rejects.toThrow(/protected SQLite store path/);
    await expect(lifecycleFs.unlink(preservedDb)).rejects.toThrow(/protected SQLite store path/);
    expect(await exists(canonicalDb)).toBe(true);
    expect(await exists(preservedDb)).toBe(true);

    // Sec-H1: case-variant path on case-insensitive platforms (darwin / win32) must still be refused.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const upperCanonicalDb = path.join(path.dirname(canonicalDb), 'SCHEGENT-STATE.DB');
      await expect(lifecycleFs.unlink(upperCanonicalDb)).rejects.toThrow(/protected SQLite store path/);
      expect(await exists(canonicalDb)).toBe(true);
    }
  });

  it('B-P1-1: probePassiveSnapshots resolves cleanly without throwing on 0-byte or corrupt SQLite files', async () => {
    for (const [label, payload] of [
      ['zero-byte', Buffer.alloc(0)],
      ['corrupt', Buffer.from('CORRUPT_SQLITE_HEADER_BYTES_1234567890', 'utf8')]
    ] as const) {
      const root = await makeTempDir(`fr-r7-11-bp1-1-${label}-`);
      const workspaceRoot = path.join(root, `repo-${label}`);
      await fsp.mkdir(workspaceRoot, { recursive: true });
      const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
      const scopeId = deriveWorkspaceScopeId(workspaceRoot);
      const dbDir = path.join(globalStorage, 'sqlite', scopeId);
      await fsp.mkdir(dbDir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(dbDir, 'schegent-state.db'), payload, { mode: 0o600 });

      const { logger } = createSpyLogger();
      const operationalMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
      const store = new WorkspaceStateStore(operationalMemento, logger);
      registerOperationalMementoForStore(store, operationalMemento);

      const coord = createSqliteCutoverCoordinator({
        context: {
          storageUri: undefined,
          globalStorageUri: { fsPath: globalStorage } as never,
          subscriptions: []
        },
        workspaceRoot,
        store,
        auditWriter: {
          write: async () => undefined,
          subscribe: () => ({ dispose: () => undefined })
        } as unknown as AuditLogWriter,
        envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
        pinnedRunIds: () => new Set(),
        logger,
        isWorkspaceTrusted: () => false,
        hasPrimacy: async () => false,
        disposables: []
      });

      await expect(coord.probePassiveSnapshots()).resolves.toBeUndefined();
      expect(operationalMemento.isPostCutoverAuthorityActive()).toBe(false);
      coord.close();
    }
  });

  it('A-P1-1 part 2: disarms detachedWriter when openPrimarySqliteServices fails mid-initialization', async () => {
    const root = await makeTempDir('fr-r7-11-ap1-1-midinit-');
    const workspaceRoot = path.join(root, 'repo-midinit');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

    const { logger } = createSpyLogger();
    const legacyMemento = createMemoryMemento();
    const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);

    const failingCatalogFs = {
      attachSqlite: vi.fn(async () => {
        throw new Error('simulated-catalog-init-failure');
      }),
      attachReadOnlySnapshotIfPresent: () => false,
      attachReadOnlySnapshotIfPresentAsync: async () => false,
      detachSqlite: vi.fn(),
      isSqliteAttached: () => false
    } as unknown as SwitchableCatalogFsAdapter;
    registerCatalogFsForStore(store, failingCatalogFs);

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: []
    });

    const services = await coord.activatePrimary();
    expect(services).toBeNull();
    expect(failingCatalogFs.attachSqlite).toHaveBeenCalledTimes(1);
    expect(failingCatalogFs.detachSqlite).toHaveBeenCalledTimes(1);

    // detachedWriter MUST be disarmed — trusted write must NOT silently open SQLite after init failure!
    await expect(
      operationalMemento.update('schegent.run', { default: { id: 'should-not-write' } })
    ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);
    await expect(
      operationalMemento.updateBatch([{ key: 'schegent.run', value: { default: { id: 'should-not-write' } } }])
    ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);

    coord.close();
  });

  it('reports conflicts, fallback and diagnostic details in one operator notice per outcome', () => {
    const { logger } = createSpyLogger();

    // (1) conflict_resolved with empty newlyDiscoveredConflictPaths + diagnostics -> NO empty-path toast, YES diagnostics toast.
    const notices1: string[] = [];
    reportRelocationOutcome(
      {
        outcome: 'conflict_resolved',
        activeStorageRoot: '/global',
        activeDatabasePath: '/global/sqlite/s/schegent-state.db',
        activeSourceKind: 'host_global_storage_uri',
        winnerSourcePath: '/legacy/sqlite/s/schegent-state.db',
        preservedUnselectedPaths: ['/legacy-old/sqlite/s/schegent-state.db'],
        newlyDiscoveredConflictPaths: [],
        selectionRule: 'last_write_then_run_count_then_canonical_then_path',
        noticeRequired: true,
        retirementPending: true,
        diagnostics: ['legacy-retirement-pending']
      },
      logger,
      (m) => notices1.push(m)
    );
    expect(notices1).toHaveLength(1);
    expect(notices1[0]).toContain('legacy-retirement-pending');
    expect(notices1[0]).not.toContain('other data is available');

    // (2) The conflict notice includes diagnostic details.
    const notices2: string[] = [];
    reportRelocationOutcome(
      {
        outcome: 'conflict_resolved',
        activeStorageRoot: '/global',
        activeDatabasePath: '/global/sqlite/s/schegent-state.db',
        activeSourceKind: 'host_global_storage_uri',
        winnerSourcePath: '/legacy/sqlite/s/schegent-state.db',
        preservedUnselectedPaths: ['/legacy-old/sqlite/s/schegent-state.db'],
        newlyDiscoveredConflictPaths: ['/legacy-old/sqlite/s/schegent-state.db'],
        selectionRule: 'last_write_then_run_count_then_canonical_then_path',
        noticeRequired: true,
        corruptCandidateCount: 1,
        diagnostics: ['candidate-corrupt:legacy']
      },
      logger,
      (m) => notices2.push(m)
    );
    expect(notices2).toHaveLength(1);
    expect(notices2[0]).toContain('/legacy-old/sqlite/s/schegent-state.db');
    expect(notices2[0]).toContain('candidate-corrupt:legacy');

    // (3) The fallback notice includes diagnostic details.
    const notices3: string[] = [];
    reportRelocationOutcome(
      {
        outcome: 'fallback_legacy_preserved',
        activeStorageRoot: '/legacy',
        activeDatabasePath: '/legacy/sqlite/s/schegent-state.db',
        activeSourceKind: 'host_storage_uri',
        reason: 'network_share_wal_unsupported',
        diagnostic: 'network share refused',
        preservedUnselectedPaths: [],
        noticeRequired: true,
        corruptCandidateCount: 1,
        diagnostics: ['candidate-corrupt:legacy']
      },
      logger,
      (m) => notices3.push(m)
    );
    expect(notices3).toHaveLength(1);
    expect(notices3[0]).toContain('network_share_wal_unsupported');
    expect(notices3[0]).toContain('candidate-corrupt:legacy');
  });

  it('Iter 2 P2: passive probe upgrades to canonical WAL DB over stale non-WAL legacy DB and protects both', async () => {
    const root = await makeTempDir('fr-r7-11-passive-wal-canonical-');
    const workspaceRoot = path.join(root, 'repo-passive-wal');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '3333cccc', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);

    // Seed stale legacy store (checkpointed, no -wal sidecar).
    const legacyDb = await seedLegacyDb(legacyStorage, scopeId, 'run-legacy-stale', 1_700_000_001_000);
    expect(await exists(`${legacyDb}-wal`)).toBe(false);

    // Seed canonical store with live uncommitted-checkpoint WAL sidecar holding newer run-canonical-live.
    const canonicalDir = path.join(globalStorage, 'sqlite', scopeId);
    await fsp.mkdir(canonicalDir, { recursive: true, mode: 0o700 });
    const canonicalDb = path.join(canonicalDir, 'schegent-state.db');
    const liveStore = new SqliteApplicationStore({ databasePath: canonicalDb, journalMode: 'wal' });
    try {
      const conn = liveStore.writerConnection;
      conn.exec('PRAGMA wal_autocheckpoint = 0;');
      conn.run(
        `INSERT OR REPLACE INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
         VALUES (?, 'sqlite', 'publish-authority', 1, 'legacy-sha', 'sqlite-sha', ?)`,
        scopeId,
        1_700_000_099_000
      );
      conn.run(
        `INSERT OR REPLACE INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
         VALUES (?, 'default', 'run-canonical-live', 1, 'feat-live', 'running', 'implement', ?, ?, NULL, ?)`,
        scopeId,
        1_700_000_099_000,
        1_700_000_099_000,
        JSON.stringify({ id: 'run-canonical-live', status: 'running' })
      );
      expect(await exists(`${canonicalDb}-wal`)).toBe(true);

      const { logger } = createSpyLogger();
      const operationalMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
      const store = new WorkspaceStateStore(operationalMemento, logger);
      registerOperationalMementoForStore(store, operationalMemento);

      const coord = createSqliteCutoverCoordinator({
        context: {
          storageUri: { fsPath: legacyStorage } as never,
          globalStorageUri: { fsPath: globalStorage } as never,
          subscriptions: []
        },
        workspaceRoot,
        store,
        auditWriter: {
          write: async () => undefined,
          subscribe: () => ({ dispose: () => undefined })
        } as unknown as AuditLogWriter,
        envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
        pinnedRunIds: () => new Set(),
        logger,
        isWorkspaceTrusted: () => false,
        hasPrimacy: async () => false,
        disposables: []
      });

      await coord.probePassiveSnapshots();

      const runMap = operationalMemento.get<Record<string, { id: string } | undefined>>('schegent.run');
      expect(runMap?.default?.id).toBe('run-canonical-live');
      expect(coord.storageRoot).toBe(globalStorage);
      const protectedPaths = coord.getDatabaseProtectedPaths();
      expect(protectedPaths).toContain(canonicalDb);
      expect(protectedPaths).toContain(`${canonicalDb}-wal`);
      expect(protectedPaths).toContain(legacyDb);
      coord.close();
    } finally {
      liveStore.close();
    }
  });

  it('Iter 6 C1: unreadable canonical DB (chmod 0o000) degrades safely during sync passive catalog probe without crashing coordinator construction', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = await makeTempDir('fr-r7-11-iter6-unreadable-');
    const workspaceRoot = path.join(root, 'repo-unreadable');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const scopeId = deriveWorkspaceScopeId(workspaceRoot);
    const dbPath = await seedLegacyDb(globalStorage, scopeId, 'run-unreadable', 1_700_000_050_000);

    await fsp.chmod(dbPath, 0o000);
    try {
      const { logger } = createSpyLogger();
      const operationalMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
      const store = new WorkspaceStateStore(operationalMemento, logger);
      registerOperationalMementoForStore(store, operationalMemento);

      const dummyLegacyFs = {
        readFile: async () => ({ outcome: 'absent' }),
        writeFileAtomic: async () => ({ outcome: 'ok' }),
        writeFileIfAbsent: async () => ({ outcome: 'written' }),
        removeFile: async () => ({ outcome: 'absent' }),
        checkWritability: async () => 'writable'
      } as unknown as CatalogFsPort;
      const catalogFs = createSwitchableCatalogFsAdapter(dummyLegacyFs);
      registerCatalogFsForStore(store, catalogFs);

      const coord = createSqliteCutoverCoordinator({
        context: {
          storageUri: undefined,
          globalStorageUri: { fsPath: globalStorage } as never,
          subscriptions: []
        },
        workspaceRoot,
        store,
        auditWriter: {
          write: async () => undefined,
          subscribe: () => ({ dispose: () => undefined })
        } as unknown as AuditLogWriter,
        envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
        pinnedRunIds: () => new Set(),
        logger,
        isWorkspaceTrusted: () => false,
        hasPrimacy: async () => false,
        disposables: []
      });

      await expect(coord.probePassiveSnapshots()).resolves.toBeUndefined();
      expect(operationalMemento.isPostCutoverAuthorityActive()).toBe(false);
      coord.close();
    } finally {
      await fsp.chmod(dbPath, 0o600);
    }
  });

  it('Iter 6 C2: disposeSqliteRuntimeResources isolates throwing getStatus()/disposers and rejecting shutdown() while still closing sqliteStore', async () => {
    const closeThrowingStatus = vi.fn();
    const shutdownDisabled = vi.fn(async () => {
      throw new Error('shutdown-rejected');
    });
    expect(() =>
      disposeSqliteRuntimeResources({
        disposeTelemetryConfig: () => {
          throw new Error('config-dispose-failed');
        },
        telemetryHost: {
          getStatus: () => {
            throw new Error('ERR_INVALID_STATE: database is not open');
          },
          shutdown: shutdownDisabled
        } as unknown as TelemetryHostService,
        sqliteStore: { close: closeThrowingStatus } as unknown as SqliteApplicationStore
      })
    ).not.toThrow();
    expect(closeThrowingStatus).toHaveBeenCalledTimes(1);

    const closeAsyncReject = vi.fn();
    const shutdownEnabled = vi.fn(async () => {
      throw new Error('async-shutdown-rejected');
    });
    expect(() =>
      disposeSqliteRuntimeResources({
        telemetryHost: {
          getStatus: () => ({ evaluation: { kind: 'enabled' } }),
          shutdown: shutdownEnabled
        } as unknown as TelemetryHostService,
        sqliteStore: { close: closeAsyncReject } as unknown as SqliteApplicationStore
      })
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closeAsyncReject).toHaveBeenCalledTimes(1);
  });

  it('FR-R7-18 N12: detached SQLite writer refuses trusted non-primary windows and fails closed on primacy error, while permitting trusted primary windows', async () => {
    const root = await makeTempDir('fr-r7-18-n12-detached-primacy-');
    const workspaceRoot = path.join(root, 'repo-detached-primacy');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

    const { logger } = createSpyLogger();
    const legacyMemento = createMemoryMemento();
    const operationalMemento = createSwitchableOperationalMemento(legacyMemento, logger);
    const store = new WorkspaceStateStore(operationalMemento, logger);
    registerOperationalMementoForStore(store, operationalMemento);

    let trusted = true;
    let primary = true;
    let primacyThrows = false;

    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store,
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => trusted,
      hasPrimacy: async () => {
        if (primacyThrows) throw new Error('ownership-probe-failed');
        return primary;
      },
      disposables: []
    });

    const services = await coord.activatePrimary();
    expect(services).not.toBeNull();

    // Detach the live SQLite backing so subsequent operational writes must go through the detached writer gate.
    operationalMemento.detachSqlite();

    // 1. Trusted but non-primary window MUST refuse both single-key and batched detached writes.
    primary = false;
    await expect(
      operationalMemento.update('schegent.run', { default: { id: 'run-non-primary', status: 'running', currentPhase: 'plan' } })
    ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);
    await expect(
      operationalMemento.updateBatch([
        { key: 'schegent.run', value: { default: { id: 'run-non-primary-batch', status: 'running', currentPhase: 'plan' } } }
      ])
    ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);

    // 2. Rejecting primacy probe MUST fail closed.
    primacyThrows = true;
    await expect(
      operationalMemento.update('schegent.run', { default: { id: 'run-primacy-err', status: 'running', currentPhase: 'plan' } })
    ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);
    primacyThrows = false;

    // 3. Untrusted primary window MUST refuse detached writes.
    trusted = false;
    primary = true;
    await expect(
      operationalMemento.update('schegent.run', { default: { id: 'run-untrusted', status: 'running', currentPhase: 'plan' } })
    ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);

    // 4. Trusted AND primary window permits detached writes and commits them durably to SQLite.
    trusted = true;
    primary = true;
    await operationalMemento.update('schegent.run', {
      default: { id: 'run-detached-allowed', status: 'completed', currentPhase: 'done' }
    });
    await operationalMemento.updateBatch([
      {
        key: 'schegent.run',
        value: { default: { id: 'run-detached-batch-allowed', status: 'completed', currentPhase: 'done' } }
      }
    ]);

    const checkDb = new DatabaseSync(coord.expectedDatabasePath, { readOnly: true });
    try {
      const rows = checkDb.prepare('SELECT run_id FROM operational_runs').all() as Array<{ run_id: string }>;
      expect(rows.map((r) => r.run_id)).toEqual(['run-detached-batch-allowed']);
    } finally {
      checkDb.close();
    }

    coord.close();
  });
});
