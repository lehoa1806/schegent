import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
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
  assertCutoverRegistrationOrder,
  createSqliteCutoverCoordinator,
  deriveWorkspaceScopeId,
  disposeCutoverStore,
  EXPECTED_CUTOVER_REGISTRATION_ORDER,
  initializeStoreForActivation,
  registerCatalogFsForStore,
  registerOperationalMementoForStore,
  registerWorkspaceLockForStore
} from '../../src/activation/sqlite-cutover-wiring';
import { extractPrimacyGainedSubscriber } from '../../src/activation/sqlite-cutover-helpers';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { ensureExtendedFeatureRequest } from '../../src/contracts/queue-feature-request-helpers';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { SanitizedLogger } from '../../src/lib/logger';
import type { RecoveryEnvelopePort } from '../../src/services/recovery-handoff';
import type { SwitchableCatalogFsAdapter } from '../../src/services/sqlite-store';
import {
  STALENESS_THRESHOLD_MS,
  WorkspaceLockManager,
  type Clock,
  type Scheduler
} from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import {
  createSwitchableOperationalMemento,
  readCutoverAuthorityTombstone
} from '../../src/state/sqlite-operational-backing';
import {
  KEYS,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';

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

interface SpyMemoryMemento extends Memento {
  readonly operationalWrites: Array<{ readonly key: string; readonly value: unknown }>;
  readonly allWrites: Array<{ readonly key: string; readonly value: unknown }>;
  seedRaw(key: string, value: unknown): void;
}

function createSpyLegacyMemento(initial: Record<string, unknown> = {}): SpyMemoryMemento {
  const map = new Map<string, unknown>(Object.entries(initial));
  const operationalWrites: Array<{ readonly key: string; readonly value: unknown }> = [];
  const allWrites: Array<{ readonly key: string; readonly value: unknown }> = [];
  const nonOperational = new Set<string>([
    KEYS.lock,
    KEYS.executionLeases,
    KEYS.operatorPseudonym,
    KEYS.sqliteCutoverAuthority
  ]);
  return {
    operationalWrites,
    allWrites,
    seedRaw(key: string, value: unknown): void {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      allWrites.push({ key, value });
      if (!nonOperational.has(key)) {
        operationalWrites.push({ key, value });
      }
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function createSpyLogger(): {
  readonly logger: SanitizedLogger;
  readonly warns: Array<readonly [string, unknown?]>;
} {
  const warns: Array<readonly [string, unknown?]> = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn((msg: string, meta?: unknown) => warns.push([msg, meta])),
    error: vi.fn(),
    debug: vi.fn()
  } as unknown as SanitizedLogger;
  return { logger, warns };
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

function makeFakeAuditWriter(): AuditLogWriter {
  return {
    append: vi.fn(async () => undefined),
    subscribe: () => ({ dispose: () => undefined })
  } as unknown as AuditLogWriter;
}

class ManualClock implements Clock {
  public current = 1_750_000_000_000;
  public now(): number {
    return this.current;
  }
  public advance(ms: number): void {
    this.current += ms;
  }
}

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

describe('F-02 & D2 integration — SQLite cutover authority, activation init ordering, DB loss refusal, and inline fence re-acquire', () => {
  it('(a) cut over, mutate SQLite state, drift legacy memento, reactivate -> initializeStoreForActivation sees SQLite state and preserves cutover registration order', async () => {
    const root = await makeTempDir('schegent-f02-init-order-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const context = {
      storageUri: undefined,
      globalStorageUri: { fsPath: globalStorage } as never,
      subscriptions: []
    };

    const legacyMemento = createSpyLegacyMemento();
    const { logger: logger1 } = createSpyLogger();

    // Session 1: pre-cutover initialization, enqueue legacy task, then cut over to SQLite and mutate SQLite.
    const opMem1 = createSwitchableOperationalMemento(legacyMemento, logger1, { requireDurableBatch: true });
    const store1 = new WorkspaceStateStore(opMem1, logger1);
    registerOperationalMementoForStore(store1, opMem1, { strictOrder: true });

    await initializeStoreForActivation({ context, workspaceRoot, store: store1, logger: logger1 });
    await store1.insertPendingRequest(
      ensureExtendedFeatureRequest({
        id: 'task-legacy',
        description: 'Pre-cutover task',
        enqueuedAt: 1_750_000_000_000,
        startedAt: null,
        completedAt: null,
        runId: null,
        status: 'pending',
        position: 0,
        queueId: DEFAULT_QUEUE_ID,
        pauseCause: null,
        updatedAt: 1_750_000_000_000
      }),
      { queueId: DEFAULT_QUEUE_ID }
    );

    const disposables1: Array<{ dispose(): void }> = [];
    registerCatalogFsForStore(store1, makeFakeCatalogFs(), { strictOrder: true });
    registerWorkspaceLockForStore(store1, { hasPrimacy: async () => true }, disposables1, { strictOrder: true });
    const coord1 = createSqliteCutoverCoordinator({
      context,
      workspaceRoot,
      store: store1,
      auditWriter: makeFakeAuditWriter(),
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger: logger1,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: disposables1
    });
    assertCutoverRegistrationOrder(store1, EXPECTED_CUTOVER_REGISTRATION_ORDER);

    const services1 = await coord1.activatePrimary();
    expect(services1).not.toBeNull();
    expect(readCutoverAuthorityTombstone(legacyMemento)?.scopeId).toBe(deriveWorkspaceScopeId(workspaceRoot));

    // Mutate SQLite state post-cutover: add task-sqlite and change globalConcurrencyCap.
    await store1.insertPendingRequest(
      ensureExtendedFeatureRequest({
        id: 'task-sqlite',
        description: 'Post-cutover SQLite task',
        enqueuedAt: 1_750_000_010_000,
        startedAt: null,
        completedAt: null,
        runId: null,
        status: 'pending',
        position: 1,
        queueId: DEFAULT_QUEUE_ID,
        pauseCause: null,
        updatedAt: 1_750_000_010_000
      }),
      { queueId: DEFAULT_QUEUE_ID }
    );
    await store1.setGlobalConcurrencyCap(3);

    disposeCutoverStore(store1);

    // Drift legacy memento with stale pre-cutover values to verify reactivation ignores it completely.
    legacyMemento.seedRaw(KEYS.queueGlobalConcurrencyCap, 1);
    legacyMemento.seedRaw(KEYS.schemaVersionNumeric, 10);
    legacyMemento.operationalWrites.length = 0;

    // Session 2: Reactivate fresh store. `initializeStoreForActivation` runs BEFORE coordinator creation!
    const { logger: logger2 } = createSpyLogger();
    const opMem2 = createSwitchableOperationalMemento(legacyMemento, logger2, { requireDurableBatch: true });
    const store2 = new WorkspaceStateStore(opMem2, logger2);
    registerOperationalMementoForStore(store2, opMem2, { strictOrder: true });

    const init2 = await initializeStoreForActivation({
      context,
      workspaceRoot,
      store: store2,
      logger: logger2
    });

    // Activation saw SQLite state (NOT drifted legacy v10 / cap=1)!
    expect(opMem2.isReadOnlySnapshotAttached()).toBe(true);
    expect(store2.getGlobalConcurrencyCap()).toBe(3);
    expect(store2.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).toEqual([
      'task-legacy',
      'task-sqlite'
    ]);
    expect(init2.migrationEvents.migrated).toBe(false);
    expect(legacyMemento.operationalWrites).toEqual([]);

    // Stage-2 registrations remain strictly ordered after pre-initialize probe.
    const disposables2: Array<{ dispose(): void }> = [];
    registerCatalogFsForStore(store2, makeFakeCatalogFs(), { strictOrder: true });
    registerWorkspaceLockForStore(store2, { hasPrimacy: async () => true }, disposables2, { strictOrder: true });
    const coord2 = createSqliteCutoverCoordinator({
      context,
      workspaceRoot,
      store: store2,
      auditWriter: makeFakeAuditWriter(),
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger: logger2,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: disposables2
    });
    assertCutoverRegistrationOrder(store2, EXPECTED_CUTOVER_REGISTRATION_ORDER);
    expect(await coord2.activatePrimary()).not.toBeNull();
    expect(opMem2.isSqliteAttached()).toBe(true);
    expect(legacyMemento.operationalWrites).toEqual([]);

    disposeCutoverStore(store2);
  });

  it.each(['deleted', 'corrupt'] as const)(
    '(b) DB %s after cutover -> operational writes refused with durable-store-unavailable, warning logged, zero legacy operational writes',
    async (failureMode) => {
      const root = await makeTempDir(`schegent-f02-db-${failureMode}-`);
      const workspaceRoot = path.join(root, 'workspace');
      await fsp.mkdir(workspaceRoot, { recursive: true });
      const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
      const context = {
        storageUri: undefined,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      };

      const legacyMemento = createSpyLegacyMemento();
      const { logger: logger1 } = createSpyLogger();

      // Session 1: cut over cleanly so tombstone is persisted in legacyMemento.
      const opMem1 = createSwitchableOperationalMemento(legacyMemento, logger1, { requireDurableBatch: true });
      const store1 = new WorkspaceStateStore(opMem1, logger1);
      registerOperationalMementoForStore(store1, opMem1, { strictOrder: true });
      await initializeStoreForActivation({ context, workspaceRoot, store: store1, logger: logger1 });
      await store1.setGlobalConcurrencyCap(2);
      registerCatalogFsForStore(store1, makeFakeCatalogFs(), { strictOrder: true });
      registerWorkspaceLockForStore(store1, { hasPrimacy: async () => true }, [], { strictOrder: true });
      const coord1 = createSqliteCutoverCoordinator({
        context,
        workspaceRoot,
        store: store1,
        auditWriter: makeFakeAuditWriter(),
        envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
        pinnedRunIds: () => new Set(),
        logger: logger1,
        isWorkspaceTrusted: () => true,
        hasPrimacy: async () => true,
        disposables: []
      });
      const dbPath = coord1.expectedDatabasePath;
      expect(await coord1.activatePrimary()).not.toBeNull();
      await store1.setGlobalConcurrencyCap(4);
      disposeCutoverStore(store1);

      // Destroy or corrupt the SQLite database on disk after cutover.
      await fsp.rm(`${dbPath}-wal`, { force: true });
      await fsp.rm(`${dbPath}-shm`, { force: true });
      if (failureMode === 'deleted') {
        await fsp.rm(dbPath, { force: true });
      } else {
        await fsp.writeFile(dbPath, Buffer.from('CORRUPT_NON_SQLITE_BYTES_0123456789', 'utf8'), { mode: 0o600 });
      }
      legacyMemento.operationalWrites.length = 0;

      // Session 2: reactivate with surviving legacyMemento (tombstone + stale pre-cutover keys).
      const { logger: logger2, warns } = createSpyLogger();
      const notices: string[] = [];
      const opMem2 = createSwitchableOperationalMemento(legacyMemento, logger2, { requireDurableBatch: true });
      const store2 = new WorkspaceStateStore(opMem2, logger2);
      registerOperationalMementoForStore(store2, opMem2, { strictOrder: true });

      // initializeStoreForActivation fails closed with durable-store-unavailable instead of reviving legacy memento.
      await expect(
        initializeStoreForActivation({ context, workspaceRoot, store: store2, logger: logger2 })
      ).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'durable-store-unavailable'
      });

      // Stale pre-cutover state is NOT served.
      expect(opMem2.get(KEYS.queueGlobalConcurrencyCap)).toBeUndefined();
      expect(opMem2.getCutoverAuthorityStatus().mode).toBe('sqlite-unavailable-post-cutover');

      // Single-key and batch operational writes are refused with durable-store-unavailable.
      await expect(store2.setGlobalConcurrencyCap(3)).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'durable-store-unavailable'
      });
      await expect(
        opMem2.updateBatch([{ key: KEYS.queueGlobalConcurrencyCap, value: 3 }])
      ).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'durable-store-unavailable'
      });

      // activatePrimary() refuses to create a fresh DB or re-import stale legacy memento.
      registerCatalogFsForStore(store2, makeFakeCatalogFs(), { strictOrder: true });
      registerWorkspaceLockForStore(store2, { hasPrimacy: async () => true }, [], { strictOrder: true });
      const coord2 = createSqliteCutoverCoordinator({
        context,
        workspaceRoot,
        store: store2,
        auditWriter: makeFakeAuditWriter(),
        envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
        pinnedRunIds: () => new Set(),
        logger: logger2,
        isWorkspaceTrusted: () => true,
        hasPrimacy: async () => true,
        notifyOperator: (msg) => {
          notices.push(msg);
        },
        disposables: []
      });
      expect(await coord2.activatePrimary()).toBeNull();
      expect(opMem2.isSqliteAttached()).toBe(false);
      if (failureMode === 'deleted') {
        await expect(fsp.lstat(dbPath)).rejects.toThrow();
      }

      // Operator-visible warning logged and surfaced, and ZERO operational writes landed in legacyMemento.
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(legacyMemento.operationalWrites).toEqual([]);
      expect(legacyMemento.get(KEYS.queueGlobalConcurrencyCap)).toBe(2);

      disposeCutoverStore(store2);
    }
  );

  it('(c) inline fence re-acquire after rejected heartbeat re-activates SQLite primary authority', async () => {
    const root = await makeTempDir('schegent-inline-reacquire-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const context = {
      storageUri: undefined,
      globalStorageUri: { fsPath: globalStorage } as never,
      subscriptions: []
    };

    const clock = new ManualClock();
    const sharedLegacy = createSpyLegacyMemento();
    const { logger } = createSpyLogger();
    const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');

    const opMemA = createSwitchableOperationalMemento(sharedLegacy, logger, { requireDurableBatch: true });
    const storeA = new WorkspaceStateStore(opMemA, logger);
    storeA.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }, logger), ownershipDir);
    const lockA = new WorkspaceLockManager(storeA, 'window-A', clock, noopScheduler);
    const storeB = new WorkspaceStateStore(sharedLegacy, logger);
    storeB.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }, logger), ownershipDir);
    const lockB = new WorkspaceLockManager(storeB, 'window-B', clock, noopScheduler);

    registerOperationalMementoForStore(storeA, opMemA, { strictOrder: true });
    await initializeStoreForActivation({ context, workspaceRoot, store: storeA, logger });
    const disposables: Array<{ dispose(): void }> = [];
    registerCatalogFsForStore(storeA, makeFakeCatalogFs(), { strictOrder: true });
    registerWorkspaceLockForStore(storeA, lockA, disposables, { strictOrder: true });

    const subscribePrimacyGained = extractPrimacyGainedSubscriber(lockA);
    expect(subscribePrimacyGained).toBeDefined();

    const coord = createSqliteCutoverCoordinator({
      context,
      workspaceRoot,
      store: storeA,
      auditWriter: makeFakeAuditWriter(),
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: () => lockA.hasPrimacy(),
      subscribePrimacyLost: (listener) => lockA.onFenceLost(listener),
      ...(subscribePrimacyGained !== undefined ? { subscribePrimacyGained } : {}),
      disposables
    });

    // Window A acquires primacy and opens SQLite primary.
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    expect(await coord.activatePrimary()).not.toBeNull();
    expect(opMemA.isSqliteAttached()).toBe(true);

    // Window A stalls; rival Window B reclaims and then releases primacy.
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    expect((await lockB.tryAcquire()).acquired).toBe(true);
    await lockB.release();

    // Window A's next tick gets a rejected heartbeat -> fires onFenceLost (demoting SQLite)
    // -> inline tryAcquire() succeeds -> fires onPrimacyGained -> re-activates SQLite primary!
    await lockA.tick();
    expect(await lockA.hasPrimacy()).toBe(true);

    // Wait briefly for the async activatePrimary() kicked off by subscribePrimacyGained to settle.
    for (let i = 0; i < 100 && coord.getServices() === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(opMemA.isSqliteAttached()).toBe(true);
    expect(coord.getServices()).not.toBeNull();

    // Operational writes work again cleanly against re-attached SQLite!
    await storeA.setGlobalConcurrencyCap(3);
    expect(storeA.getGlobalConcurrencyCap()).toBe(3);

    disposeCutoverStore(storeA);
  });

  it('(d) defers load-time SQLite repairs while passive read-only, then completes them on writable SQLite after activatePrimary()', async () => {
    const root = await makeTempDir('schegent-f02-deferred-repair-');
    const workspaceRoot = path.join(root, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const context = {
      storageUri: undefined,
      globalStorageUri: { fsPath: globalStorage } as never,
      subscriptions: []
    };

    const legacyMemento = createSpyLegacyMemento();
    const { logger: logger1 } = createSpyLogger();

    // Session 1: cut over and persist an orphaned running WorkflowRun whose task row is absent in SQLite.
    const opMem1 = createSwitchableOperationalMemento(legacyMemento, logger1, { requireDurableBatch: true });
    const store1 = new WorkspaceStateStore(opMem1, logger1);
    registerOperationalMementoForStore(store1, opMem1, { strictOrder: true });
    await initializeStoreForActivation({ context, workspaceRoot, store: store1, logger: logger1 });
    registerCatalogFsForStore(store1, makeFakeCatalogFs(), { strictOrder: true });
    registerWorkspaceLockForStore(store1, { hasPrimacy: async () => true }, [], { strictOrder: true });
    const coord1 = createSqliteCutoverCoordinator({
      context,
      workspaceRoot,
      store: store1,
      auditWriter: makeFakeAuditWriter(),
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger: logger1,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: []
    });
    expect(await coord1.activatePrimary()).not.toBeNull();
    await opMem1.update(KEYS.run, {
      [DEFAULT_QUEUE_ID]: {
        id: 'run-orphan-1',
        featureId: 'missing-task-id',
        featureDir: 'specs/001-orphan',
        status: 'running',
        currentPhase: 'implement',
        currentIteration: 1,
        startedAt: 1_750_000_000_000,
        lastTransitionAt: 1_750_000_000_000,
        phasesCompleted: [],
        lastError: null,
        manualPauseAt: null,
        manualPauseCause: null,
        pendingRetry: false,
        delayedRetryCount: 0,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null,
        pipeline: { id: 'p-1', name: 'P', phases: [{ id: 'implement', name: 'Implement' }] }
      }
    });
    disposeCutoverStore(store1);
    legacyMemento.operationalWrites.length = 0;

    // Session 2: initializeStoreForActivation probes SQLite read-only, defers mutating orphan repair cleanly.
    const { logger: logger2 } = createSpyLogger();
    const opMem2 = createSwitchableOperationalMemento(legacyMemento, logger2, { requireDurableBatch: true });
    const store2 = new WorkspaceStateStore(opMem2, logger2);
    registerOperationalMementoForStore(store2, opMem2, { strictOrder: true });

    const init2 = await initializeStoreForActivation({
      context,
      workspaceRoot,
      store: store2,
      logger: logger2
    });
    expect(opMem2.isReadOnlySnapshotAttached()).toBe(true);
    expect(init2.migrationEvents.orphanedRunEvents).toEqual([]);
    expect(legacyMemento.operationalWrites).toEqual([]);

    // Once primary SQLite attaches, re-running store.initialize() reconciles the orphaned run durably in SQLite.
    registerCatalogFsForStore(store2, makeFakeCatalogFs(), { strictOrder: true });
    registerWorkspaceLockForStore(store2, { hasPrimacy: async () => true }, [], { strictOrder: true });
    const coord2 = createSqliteCutoverCoordinator({
      context,
      workspaceRoot,
      store: store2,
      auditWriter: makeFakeAuditWriter(),
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger: logger2,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables: []
    });
    expect(await coord2.activatePrimary()).not.toBeNull();
    const postAttachInit = await store2.initialize();
    expect(postAttachInit.orphanedRunEvents).toHaveLength(1);
    expect(store2.getRun(DEFAULT_QUEUE_ID)?.status).toBe('canceled');
    expect(legacyMemento.operationalWrites).toEqual([]);

    disposeCutoverStore(store2);
  });
});
