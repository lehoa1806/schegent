import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
  CutoverRegistrationOrderError,
  EXPECTED_CUTOVER_REGISTRATION_ORDER,
  SqliteCutoverStoreRegistry,
  type DisposableCutoverCoordinator
} from '../../../src/activation/sqlite-cutover-registry';
import {
  assertCutoverRegistrationOrder,
  createSqliteCutoverCoordinator,
  disposeCutoverStore,
  getOperationalMementoForStore,
  getSqliteCutoverCoordinator,
  getWorkspaceLockForStore,
  inspectCutoverRegistrations,
  registerCatalogFsForStore,
  registerOperationalMementoForStore,
  registerWorkspaceLockForStore
} from '../../../src/activation/sqlite-cutover-wiring';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { RecoveryEnvelopePort } from '../../../src/services/recovery-handoff';
import type { SwitchableCatalogFsAdapter } from '../../../src/services/sqlite-store';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import type { Memento, WorkspaceStateStore } from '../../../src/state/workspace-state';
import { removeTempRoot } from '../../temp-root-cleanup';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  await fsp.mkdir(path.join(dir, 'globalStorage', 'schegent.schegent'), {
    recursive: true,
    mode: 0o700
  });
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removeTempRoot(dir);
  }
});

function makeFakeStore(): WorkspaceStateStore {
  return {
    getRunMap: () => ({}),
    getConnectedRuns: () => ({}),
    getQueueMap: () => ({}),
    getQueueRegistry: () => ({ activeQueueId: 'default', queues: [] })
  } as unknown as WorkspaceStateStore;
}

function makeFakeLogger(): SanitizedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  } as unknown as SanitizedLogger;
}

function makeMemoryMemento(): Memento {
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

function makeFakeCatalogFs(): SwitchableCatalogFsAdapter {
  return {
    attachReadOnlySnapshotIfPresent: () => false,
    attachReadOnlySnapshotIfPresentAsync: async () => false,
    isSqliteAttached: () => false,
    attachSqlite: async () => undefined,
    detachSqlite: () => undefined
  } as unknown as SwitchableCatalogFsAdapter;
}

function makeFakeLock(): Pick<WorkspaceLockManager, 'hasPrimacy'> {
  return {
    hasPrimacy: async () => true
  };
}

describe('FR-R7-14 (14-21) — SqliteCutoverStoreRegistry ordering & symmetric disposal', () => {
  it('accepts complete ordered construction and passes inspection + strict validation', () => {
    const registry = new SqliteCutoverStoreRegistry<DisposableCutoverCoordinator>();
    const store = makeFakeStore();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), makeFakeLogger());
    const catalogFs = makeFakeCatalogFs();
    const lock = makeFakeLock();
    const disposables: Array<{ dispose(): void }> = [];
    const coord: DisposableCutoverCoordinator = { close: vi.fn() };

    expect(registry.inspect(store)).toEqual({
      registered: [],
      missing: [...EXPECTED_CUTOVER_REGISTRATION_ORDER],
      orderViolations: [],
      disposed: false
    });

    registry.registerOperationalMemento(store, opMem, { strictOrder: true });
    registry.registerCatalogFs(store, catalogFs, { strictOrder: true });
    registry.registerWorkspaceLock(store, lock, disposables, { strictOrder: true });
    registry.registerCoordinator(store, coord, { strictOrder: true });

    expect(registry.inspect(store)).toEqual({
      registered: ['operationalMemento', 'catalogFs', 'workspaceLock', 'coordinator'],
      missing: [],
      orderViolations: [],
      disposed: false
    });
    expect(() => registry.assertCompleteAndOrdered(store)).not.toThrow();
    expect(registry.getOperationalMemento(store)).toBe(opMem);
    expect(registry.getCatalogFs(store)).toBe(catalogFs);
    expect(registry.getWorkspaceLock(store)).toEqual({ lock, disposables });
    expect(registry.getCoordinator(store)).toBe(coord);
  });

  it('detects missing slots with CUTOVER_REGISTRATION_INCOMPLETE', () => {
    const registry = new SqliteCutoverStoreRegistry<DisposableCutoverCoordinator>();
    const store = makeFakeStore();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), makeFakeLogger());

    // Unregistered store fails with CUTOVER_REGISTRATION_INCOMPLETE.
    try {
      registry.assertCompleteAndOrdered(store);
      expect.unreachable('expected CUTOVER_REGISTRATION_INCOMPLETE');
    } catch (err) {
      expect(err).toBeInstanceOf(CutoverRegistrationOrderError);
      expect((err as CutoverRegistrationOrderError).code).toBe('CUTOVER_REGISTRATION_INCOMPLETE');
    }

    // Partial prefix registration fails with CUTOVER_REGISTRATION_INCOMPLETE naming missing slots.
    registry.registerOperationalMemento(store, opMem);
    expect(registry.inspect(store).missing).toEqual(['catalogFs', 'workspaceLock', 'coordinator']);
    try {
      registry.assertCompleteAndOrdered(store);
      expect.unreachable('expected CUTOVER_REGISTRATION_INCOMPLETE');
    } catch (err) {
      expect(err).toBeInstanceOf(CutoverRegistrationOrderError);
      expect((err as CutoverRegistrationOrderError).code).toBe('CUTOVER_REGISTRATION_INCOMPLETE');
      expect((err as Error).message).toContain('catalogFs');
      expect((err as Error).message).toContain('workspaceLock');
      expect((err as Error).message).toContain('coordinator');
    }
  });

  it('detects out-of-order registrations with CUTOVER_REGISTRATION_OUT_OF_ORDER (strict and deferred)', () => {
    const registry = new SqliteCutoverStoreRegistry<DisposableCutoverCoordinator>();
    const strictStore = makeFakeStore();
    const deferredStore = makeFakeStore();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), makeFakeLogger());
    const catalogFs = makeFakeCatalogFs();
    const lock = makeFakeLock();
    const coord: DisposableCutoverCoordinator = { close: vi.fn() };

    // Strict mode throws immediately when catalogFs arrives before operationalMemento.
    try {
      registry.registerCatalogFs(strictStore, catalogFs, { strictOrder: true });
      expect.unreachable('expected CUTOVER_REGISTRATION_OUT_OF_ORDER');
    } catch (err) {
      expect(err).toBeInstanceOf(CutoverRegistrationOrderError);
      expect((err as CutoverRegistrationOrderError).code).toBe('CUTOVER_REGISTRATION_OUT_OF_ORDER');
    }

    // Non-strict mode records violations for partial-wiring tests and fails loudly on assertCompleteAndOrdered().
    registry.registerCatalogFs(deferredStore, catalogFs);
    registry.registerOperationalMemento(deferredStore, opMem);
    registry.registerWorkspaceLock(deferredStore, lock, []);
    registry.registerCoordinator(deferredStore, coord);

    const snapshot = registry.inspect(deferredStore);
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.orderViolations.length).toBeGreaterThan(0);

    try {
      registry.assertCompleteAndOrdered(deferredStore);
      expect.unreachable('expected CUTOVER_REGISTRATION_OUT_OF_ORDER');
    } catch (err) {
      expect(err).toBeInstanceOf(CutoverRegistrationOrderError);
      expect((err as CutoverRegistrationOrderError).code).toBe('CUTOVER_REGISTRATION_OUT_OF_ORDER');
    }
  });

  it('disposes in strict reverse order (coordinator -> workspaceLock -> catalogFs -> operationalMemento) and refuses post-dispose registrations with CUTOVER_REGISTRATION_DISPOSED', () => {
    const registry = new SqliteCutoverStoreRegistry<DisposableCutoverCoordinator>();
    const store = makeFakeStore();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), makeFakeLogger());
    const catalogFs = makeFakeCatalogFs();
    const lock = makeFakeLock();
    const events: string[] = [];
    const coord: DisposableCutoverCoordinator = {
      close: () => {
        events.push('coordinator.close');
        // During coordinator.close(), workspaceLock/catalogFs/operationalMemento are still registered.
        expect(registry.getWorkspaceLock(store)).toBeDefined();
        expect(registry.getCatalogFs(store)).toBeDefined();
        expect(registry.getOperationalMemento(store)).toBeDefined();
      }
    };

    registry.registerOperationalMemento(store, opMem);
    registry.registerCatalogFs(store, catalogFs);
    registry.registerWorkspaceLock(store, lock, []);
    registry.registerCoordinator(store, coord);

    const disposedOrder = registry.dispose(store);
    expect(events).toEqual(['coordinator.close']);
    expect(disposedOrder).toEqual([
      'coordinator',
      'workspaceLock',
      'catalogFs',
      'operationalMemento'
    ]);

    // All getters return undefined and repeated dispose is an idempotent no-op.
    expect(registry.getCoordinator(store)).toBeUndefined();
    expect(registry.getWorkspaceLock(store)).toBeUndefined();
    expect(registry.getCatalogFs(store)).toBeUndefined();
    expect(registry.getOperationalMemento(store)).toBeUndefined();
    expect(registry.inspect(store).disposed).toBe(true);
    expect(registry.dispose(store)).toEqual([]);

    // Every post-dispose registration and assertion fails closed with CUTOVER_REGISTRATION_DISPOSED.
    const postDisposeOps = [
      () => registry.registerOperationalMemento(store, opMem),
      () => registry.registerCatalogFs(store, catalogFs),
      () => registry.registerWorkspaceLock(store, lock, []),
      () => registry.registerCoordinator(store, coord),
      () => registry.assertCompleteAndOrdered(store),
      () => registry.assertNotDisposed(store, 'coordinator')
    ];
    for (const op of postDisposeOps) {
      try {
        op();
        expect.unreachable('expected CUTOVER_REGISTRATION_DISPOSED');
      } catch (err) {
        expect(err).toBeInstanceOf(CutoverRegistrationOrderError);
        expect((err as CutoverRegistrationOrderError).code).toBe('CUTOVER_REGISTRATION_DISPOSED');
      }
    }
  });

  it('supports Stage-2 coordinator close + reload without permanently disposing the store entry, and integrates with sqlite-cutover-wiring exports + reloadAfterRestore()', async () => {
    const root = await makeTempDir('fr-r7-14-reg-wiring-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

    const logger = makeFakeLogger();
    const store = makeFakeStore();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), logger);
    const catalogFs = makeFakeCatalogFs();
    const lock = makeFakeLock();
    const disposables: Array<{ dispose(): void }> = [];

    registerOperationalMementoForStore(store, opMem, { strictOrder: true });
    registerCatalogFsForStore(store, catalogFs, { strictOrder: true });
    registerWorkspaceLockForStore(store, lock, disposables, { strictOrder: true });

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
      disposables
    });

    expect(getOperationalMementoForStore(store)).toBe(opMem);
    expect(getWorkspaceLockForStore(store)?.lock).toBe(lock);
    expect(getSqliteCutoverCoordinator(store)).toBe(coord);
    expect(inspectCutoverRegistrations(store)).toEqual({
      registered: ['operationalMemento', 'catalogFs', 'workspaceLock', 'coordinator'],
      missing: [],
      orderViolations: [],
      disposed: false
    });
    expect(() => assertCutoverRegistrationOrder(store)).not.toThrow();

    // Before activatePrimary(), durable ACP accessors return null.
    expect(coord.getAcpSessionBindingStore()).toBeNull();
    expect(coord.allocateAcpConnectionGeneration()).toBeNull();

    // After activatePrimary(), durable ACP session binding store, generation allocation, observation recording, and reloadAfterRestore() work end-to-end.
    const services = await coord.activatePrimary();
    expect(services).not.toBeNull();
    const bindingStore = coord.getAcpSessionBindingStore();
    expect(bindingStore).toBe(services!.acpRuntimeStore.sessionBindings);
    bindingStore!.putBinding({
      persistedSessionId: 'acp-sess-claude-test-1',
      backend: 'claude',
      workspaceRoot,
      providerSessionId: 'claude-provider-sess-1',
      updatedAtMs: 1_700_000_000_000
    });
    expect(bindingStore!.getBinding('acp-sess-claude-test-1')?.providerSessionId).toBe(
      'claude-provider-sess-1'
    );

    const gen1 = coord.allocateAcpConnectionGeneration();
    const gen2 = coord.allocateAcpConnectionGeneration();
    expect(gen1).toBe(1);
    expect(gen2).toBe(2);

    coord.recordAcpObservation({
      runId: 'run-obs-1',
      attemptId: 'att-obs-1',
      projection: {
        profileId: 'claude-acp-bridge',
        backendKind: 'claude'
      },
      observation: {
        kind: 'turn-started',
        origin: 'live',
        generation: gen1!,
        hostReceiveSeq: 1,
        acpSessionId: 'acp-claude-session-1',
        turnId: 'turn-1',
        attemptId: 'att-obs-1',
        requestId: 'req-1'
      }
    } as never);
    const ledgerCount = Number(
      services!.sqliteStore.writerConnection.scalar(
        `SELECT COUNT(*) FROM acp_observation_ledger WHERE attempt_id = 'att-obs-1'`
      ) ?? 0
    );
    expect(ledgerCount).toBe(1);

    const reloadHandoffSpy = vi.spyOn(services!.phaseHandoffCoordinator, 'reloadFromStore');
    const resetAcpSpy = vi.spyOn(services!.acpRuntimeStore, 'resetInMemoryState');
    await coord.reloadAfterRestore();
    expect(reloadHandoffSpy).toHaveBeenCalledTimes(1);
    expect(resetAcpSpy).toHaveBeenCalledTimes(1);

    // Explicit disposeCutoverStore performs reverse-order teardown and locks out subsequent registrations.
    const order = disposeCutoverStore(store);
    expect(order).toEqual(['coordinator', 'workspaceLock', 'catalogFs', 'operationalMemento']);
    expect(getSqliteCutoverCoordinator(store)).toBeUndefined();
    expect(getOperationalMementoForStore(store)).toBeUndefined();
    expect(() =>
      createSqliteCutoverCoordinator({
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
      })
    ).toThrow(CutoverRegistrationOrderError);
  });

  it('keeps orderViolations empty for valid untrusted-workspace Stage 2 registration without catalogFs', () => {
    const registry = new SqliteCutoverStoreRegistry<DisposableCutoverCoordinator>();
    const store = makeFakeStore();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), makeFakeLogger());
    const lock = makeFakeLock();
    const coord: DisposableCutoverCoordinator = { close: vi.fn() };

    registry.registerOperationalMemento(store, opMem, { strictOrder: true });
    registry.registerWorkspaceLock(store, lock, [], {
      strictOrder: true,
      allowMissingCatalogFs: true
    });
    registry.registerCoordinator(store, coord, { strictOrder: true });

    const snap = registry.inspect(store);
    expect(snap.orderViolations).toEqual([]);
    expect(() =>
      registry.assertCompleteAndOrdered(store, ['operationalMemento', 'workspaceLock', 'coordinator'])
    ).not.toThrow();
  });
});
