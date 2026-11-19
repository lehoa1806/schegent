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
  deriveWorkspaceScopeId
} from '../../../src/activation/sqlite-cutover-wiring';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { RecoveryEnvelopePort } from '../../../src/services/recovery-handoff';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { removeTempRoot } from '../../temp-root-cleanup';

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
  return {
    getRunMap: () => ({}),
    getConnectedRuns: () => ({}),
    getQueueMap: () => ({}),
    getQueueRegistry: () => ({ activeQueueId: 'default', queues: [] })
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

    coord.close();
  });
});
