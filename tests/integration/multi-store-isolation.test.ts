/**
 * FR-R7-18 (`N08`, FR-009, SC-008) — Multi-store isolation integration suite.
 *
 * Exercises two independent `WorkspaceStateStore` instances (`storeA` and `storeB`), each backed
 * by its own workspace directory and storage root, side by side through public host routes:
 *   1. `SqliteCutoverStoreRegistry` + `sqlite-cutover-wiring` + `production-workflow-composition`
 *      (`registerProductionWorkflowComposition`, `hasRegisteredProductionWorkflowComposition`,
 *      `unregisterProductionWorkflowComposition`, `resetCutoverStage2`, `disposeCutoverStore`).
 *   2. Independent `QueueManager` instances performing concurrent enqueue, reorder, modify,
 *      pause/resume, multi-queue creation, and removal mutations.
 *   3. Independent `SchegentWorkflowController` / `RunDriver` / `PhaseRunner` / `HistoryStore`
 *      execution stacks driven deterministically through deferred Promise barriers (zero fixed
 *      sleeps or `setTimeout` waits).
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
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
  CutoverRegistrationOrderError,
  disposeCutoverStore,
  getOperationalMementoForStore,
  getSqliteCutoverCoordinator,
  inspectCutoverRegistrations,
  registerCatalogFsForStore,
  registerOperationalMementoForStore,
  registerWorkspaceLockForStore,
  resetCutoverStage2
} from '../../src/activation/sqlite-cutover-wiring';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { createPhaseBreakpointAccessor } from '../../src/controller/breakpoint-accessor';
import { PhaseRunner } from '../../src/controller/phase-runner';
import {
  SchegentWorkflowController,
  type WorkflowControllerDeps
} from '../../src/controller/workflow-controller';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { InvocationRequest, RawInvocationOutput } from '../../src/runner/invocation-result';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { createHistoryRecorder } from '../../src/services/history-recorder';
import type { RecoveryEnvelopePort } from '../../src/services/recovery-handoff';
import {
  createSwitchableCatalogFsAdapter,
  SqliteApplicationStore,
  type SwitchableCatalogFsAdapter
} from '../../src/services/sqlite-store';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import {
  getOrCreateProductionWorkflowComposition,
  hasRegisteredProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { ensureHistoryEntry } from '../../src/state/history-entry';
import { HistoryStore } from '../../src/state/history-store';
import { WorkspaceLockManager, type Clock, type Scheduler } from '../../src/state/lock';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { Notifier } from '../../src/ui/notifications';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import {
  buildFixtureCatalog,
  fixturePhase,
  fixturePipeline
} from '../fixtures/process-catalog-fixture';
import { removeTempRoot } from '../temp-root-cleanup';

const T0 = 1_700_000_000_000;
const tempDirs: string[] = [];
const storesToDispose: WorkspaceStateStore[] = [];

async function makeTempWorkspace(prefix: string): Promise<{
  readonly root: string;
  readonly workspaceRoot: string;
  readonly globalStorage: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.mkdir(globalStorage, { recursive: true, mode: 0o700 });
  return { root, workspaceRoot, globalStorage };
}

function makeMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
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

function makeSilentLogger(): SanitizedLogger {
  return new SanitizedLogger();
}

function makeFixedClock(start = T0): Clock {
  let now = start;
  return {
    now: () => {
      now += 1;
      return now;
    }
  };
}

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function makeBuffer(text: string): ZippedStreamBuffer {
  const buf = new ZippedStreamBuffer();
  if (text.length > 0) buf.append(text);
  buf.finalize();
  return buf;
}

function makeCleanOutput(phase: string): RawInvocationOutput {
  const stdout = [
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'open_questions: 0',
    'critical_issues: 0',
    'notes: ok',
    '=== END AUDIT LOG ===',
    '[SCHEGENT_STATUS: CLEAR]'
  ].join('\n');
  return {
    stdoutBuffer: makeBuffer(stdout),
    stderrBuffer: makeBuffer(''),
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 1
  };
}

function makeFatalOutput(): RawInvocationOutput {
  return {
    stdoutBuffer: makeBuffer(''),
    stderrBuffer: makeBuffer('error: unknown option\n'),
    exitCode: 1,
    killed: false,
    timedOut: false,
    durationMs: 1
  };
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ISO_PHASE_1 = 'iso-phase-1';
const ISO_PHASE_2 = 'iso-phase-2';
const ISO_PIPELINE_ID = 'iso-two-phase';

function makeIsolationCatalog() {
  const phase1 = fixturePhase({
    id: ISO_PHASE_1,
    name: 'Isolation Phase 1',
    sideEffects: 'workspace',
    evidencePolicy: 'best-effort'
  });
  const phase2 = fixturePhase({
    id: ISO_PHASE_2,
    name: 'Isolation Phase 2',
    sideEffects: 'workspace',
    evidencePolicy: 'best-effort'
  });
  const pipe = fixturePipeline({
    id: ISO_PIPELINE_ID,
    name: 'Isolation Two-Phase Pipeline',
    phases: [ISO_PHASE_1, ISO_PHASE_2]
  });
  return buildFixtureCatalog({
    phases: [phase1, phase2],
    pipelines: [pipe],
    defaultPipelineId: ISO_PIPELINE_ID
  });
}

interface GatedExecutionStack {
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly historyStore: HistoryStore;
  readonly controller: SchegentWorkflowController;
  readonly workspaceRoot: string;
  readonly invocations: Array<{ readonly runId: string; readonly phase: string }>;
  /** Resolves deterministically once the Nth invocation (0-indexed) parks at the runner barrier, or fails immediately if `completed` settles early. */
  waitForInvocation(
    index: number,
    completed: Promise<void>
  ): Promise<{ readonly runId: string; readonly phase: string }>;
  /** Releases the Nth parked invocation (0-indexed) with an optional scripted output override. */
  releaseInvocation(index: number, output?: RawInvocationOutput): void;
  /** Releases all pending and future invocations immediately for clean teardown. */
  releaseAll(): void;
}

async function createExecutionStack(
  workspaceRoot: string,
  ownerId: string
): Promise<GatedExecutionStack> {
  const logger = makeSilentLogger();
  const store = new WorkspaceStateStore(makeMemoryMemento(), logger);
  await store.initialize();
  const queue = new QueueManager(store, logger);
  const historyStore = new HistoryStore(store);
  const auditWriter = new AuditLogWriter({ workspaceRoot }, logger);
  const rawTranscript = new RawTranscriptWriter(
    workspaceRoot,
    logger,
    path.join(workspaceRoot, 'spool')
  );

  const invocations: Array<{ readonly runId: string; readonly phase: string }> = [];
  const enteredBarriers = new Map<number, Deferred<{ readonly runId: string; readonly phase: string }>>();
  const releaseGates = new Map<number, Deferred<RawInvocationOutput | undefined>>();
  let openAll = false;

  const ensureEntered = (index: number): Deferred<{ readonly runId: string; readonly phase: string }> => {
    let d = enteredBarriers.get(index);
    if (d === undefined) {
      d = createDeferred<{ readonly runId: string; readonly phase: string }>();
      enteredBarriers.set(index, d);
    }
    return d;
  };

  const ensureRelease = (index: number): Deferred<RawInvocationOutput | undefined> => {
    let d = releaseGates.get(index);
    if (d === undefined) {
      d = createDeferred<RawInvocationOutput | undefined>();
      releaseGates.set(index, d);
    }
    return d;
  };

  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    const index = invocations.length;
    const entry = { runId: req.runId ?? 'unattributed', phase: req.phase };
    invocations.push(entry);
    ensureEntered(index).resolve(entry);
    const scripted = openAll ? undefined : await ensureRelease(index).promise;
    return scripted ?? makeCleanOutput(req.phase);
  });

  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const phaseRunner = new PhaseRunner({
    runner,
    promptBuilder: new PromptBuilder(),
    auditWriter,
    logger,
    rawTranscript,
    phaseBreakpointAccessor: createPhaseBreakpointAccessor(
      (runId) => Object.values(store.getRunMap()).find((run) => run.id === runId) ?? null
    )
  });

  const lockStore = new WorkspaceStateStore(makeMemoryMemento(), logger);
  await lockStore.initialize();
  const clock = makeFixedClock();
  const lock = new WorkspaceLockManager(lockStore, ownerId, clock, noopScheduler);
  const lease = new ExecutionLeaseManager(store, ownerId, clock, noopScheduler);

  const historyRecorder = createHistoryRecorder({
    historyStore,
    logger,
    queue,
    store,
    workspaceRoot
  });

  const deps: WorkflowControllerDeps = {
    catalog: makeIsolationCatalog(),
    historyStore,
    auditWriter,
    terminalTransitions: new TerminalTransitionCoordinator(store, queue, historyRecorder, logger),
    executionLease: lease,
    getRawTranscriptMode: () => 'always'
  };

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1_000, skipProbing: true },
    deps
  );

  return {
    store,
    queue,
    historyStore,
    controller,
    workspaceRoot,
    invocations,
    waitForInvocation: (index, completed) =>
      Promise.race([
        ensureEntered(index).promise,
        completed.then(() => {
          const run = store.getRun(DEFAULT_QUEUE_ID);
          throw new Error(
            `Run completed before reaching invocation ${index}: status=${run?.status ?? 'null'} ` +
              `phase=${run?.currentPhase ?? 'null'} lastError=${JSON.stringify(run?.lastError ?? null)}`
          );
        })
      ]),
    releaseInvocation: (index, output) => ensureRelease(index).resolve(output),
    releaseAll: () => {
      openAll = true;
      for (const gate of releaseGates.values()) {
        gate.resolve(undefined);
      }
    }
  };
}

afterEach(async () => {
  while (storesToDispose.length > 0) {
    const store = storesToDispose.pop()!;
    disposeCutoverStore(store);
    unregisterProductionWorkflowComposition(store);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removeTempRoot(dir);
  }
});

describe('FR-R7-18 (N08, SC-008) — Dual-store isolation across cutover, workflow composition, queues, and run execution', () => {
  it('isolates cutover registrations and ProductionWorkflowComposition cache across two independent stores on Stage 2 reset and disposal', async () => {
    const envA = await makeTempWorkspace('n08-cutover-a-');
    const envB = await makeTempWorkspace('n08-cutover-b-');
    const loggerA = makeSilentLogger();
    const loggerB = makeSilentLogger();

    const opMemA = createSwitchableOperationalMemento(makeMemoryMemento(), loggerA);
    const opMemB = createSwitchableOperationalMemento(makeMemoryMemento(), loggerB);
    const storeA = new WorkspaceStateStore(opMemA, loggerA);
    const storeB = new WorkspaceStateStore(opMemB, loggerB);
    await storeA.initialize();
    await storeB.initialize();
    storesToDispose.push(storeA, storeB);

    const catalogFsA = makeFakeCatalogFs();
    const catalogFsB = makeFakeCatalogFs();
    const lockA = { hasPrimacy: async () => true };
    const lockB = { hasPrimacy: async () => true };
    const disposablesA: Array<{ dispose(): void }> = [];
    const disposablesB: Array<{ dispose(): void }> = [];

    // Register both stores in strict expected order.
    registerOperationalMementoForStore(storeA, opMemA, { strictOrder: true });
    registerOperationalMementoForStore(storeB, opMemB, { strictOrder: true });
    registerCatalogFsForStore(storeA, catalogFsA, { strictOrder: true });
    registerCatalogFsForStore(storeB, catalogFsB, { strictOrder: true });
    registerWorkspaceLockForStore(storeA, lockA, disposablesA, { strictOrder: true });
    registerWorkspaceLockForStore(storeB, lockB, disposablesB, { strictOrder: true });

    const makeCoordinator = (
      store: WorkspaceStateStore,
      workspaceRoot: string,
      globalStorage: string,
      logger: SanitizedLogger,
      disposables: Array<{ dispose(): void }>
    ) =>
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
        disposables
      });

    const coordA = makeCoordinator(storeA, envA.workspaceRoot, envA.globalStorage, loggerA, disposablesA);
    const coordB = makeCoordinator(storeB, envB.workspaceRoot, envB.globalStorage, loggerB, disposablesB);

    expect(coordA).not.toBe(coordB);
    expect(coordA.scopeId).not.toBe(coordB.scopeId);
    expect(coordA.expectedDatabasePath).not.toBe(coordB.expectedDatabasePath);
    expect(getSqliteCutoverCoordinator(storeA)).toBe(coordA);
    expect(getSqliteCutoverCoordinator(storeB)).toBe(coordB);
    expect(() => assertCutoverRegistrationOrder(storeA)).not.toThrow();
    expect(() => assertCutoverRegistrationOrder(storeB)).not.toThrow();

    expect(hasRegisteredProductionWorkflowComposition(storeA)).toBe(false);
    expect(hasRegisteredProductionWorkflowComposition(storeB)).toBe(false);

    // Activate primary SQLite services on both stores side by side.
    const servicesA = await coordA.activatePrimary();
    const servicesB = await coordB.activatePrimary();
    expect(servicesA).not.toBeNull();
    expect(servicesB).not.toBeNull();

    const compA = servicesA!.workflowComposition;
    const compB = servicesB!.workflowComposition;
    expect(compA).not.toBe(compB);
    expect(hasRegisteredProductionWorkflowComposition(storeA)).toBe(true);
    expect(hasRegisteredProductionWorkflowComposition(storeB)).toBe(true);
    expect(getOrCreateProductionWorkflowComposition(storeA)).toBe(compA);
    expect(getOrCreateProductionWorkflowComposition(storeB)).toBe(compB);

    // Record isolated quota wakeups in each store's workflow composition ledger.
    const wakeA = await compA.recordAvailabilityWakeup({
      quotaId: 'quota-store-a',
      backend: 'claude',
      ready: true
    });
    const wakeB = await compB.recordAvailabilityWakeup({
      quotaId: 'quota-store-b',
      backend: 'codex',
      ready: true
    });
    expect(wakeA.observationRecorded).toBe(true);
    expect(wakeB.observationRecorded).toBe(true);
    const ledgerA = compA.ledgerStore.read();
    const ledgerB = compB.ledgerStore.read();
    expect(ledgerA.ok).toBe(true);
    expect(ledgerB.ok).toBe(true);
    if (ledgerA.ok) {
      expect(Object.keys(ledgerA.ledger.quotaObservations)).toEqual(['quota-store-a']);
    }
    if (ledgerB.ok) {
      expect(Object.keys(ledgerB.ledger.quotaObservations)).toEqual(['quota-store-b']);
    }

    // Stage 2 reset on storeA evicts storeA's workflow composition while preserving storeA's Stage 1
    // operationalMemento and leaving storeB completely intact and functional.
    const resetOrderA = resetCutoverStage2(storeA);
    expect(resetOrderA).toEqual(['coordinator', 'workspaceLock', 'catalogFs']);
    expect(hasRegisteredProductionWorkflowComposition(storeA)).toBe(false);
    expect(getSqliteCutoverCoordinator(storeA)).toBeUndefined();
    expect(getOperationalMementoForStore(storeA)).toBe(opMemA);
    expect(inspectCutoverRegistrations(storeA)).toEqual({
      registered: ['operationalMemento'],
      missing: ['catalogFs', 'workspaceLock', 'coordinator'],
      orderViolations: [],
      disposed: false
    });

    // storeB's registration, coordinator, and workflow composition remain intact.
    expect(hasRegisteredProductionWorkflowComposition(storeB)).toBe(true);
    expect(getOrCreateProductionWorkflowComposition(storeB)).toBe(compB);
    expect(getSqliteCutoverCoordinator(storeB)).toBe(coordB);
    expect(() => assertCutoverRegistrationOrder(storeB)).not.toThrow();
    const wakeB2 = await compB.recordAvailabilityWakeup({
      quotaId: 'quota-store-b-after-reset-a',
      backend: 'codex',
      ready: true
    });
    expect(wakeB2.observationRecorded).toBe(true);
    const ledgerBAfterResetA = compB.ledgerStore.read();
    expect(ledgerBAfterResetA.ok).toBe(true);
    if (ledgerBAfterResetA.ok) {
      expect(Object.keys(ledgerBAfterResetA.ledger.quotaObservations)).toEqual([
        'quota-store-b',
        'quota-store-b-after-reset-a'
      ]);
    }

    // Re-wiring Stage 2 on storeA creates a distinct fresh workflow composition without touching storeB.
    registerCatalogFsForStore(storeA, catalogFsA, { strictOrder: true });
    registerWorkspaceLockForStore(storeA, lockA, [], { strictOrder: true });
    const coordA2 = makeCoordinator(storeA, envA.workspaceRoot, envA.globalStorage, loggerA, []);
    const servicesA2 = await coordA2.activatePrimary();
    expect(servicesA2).not.toBeNull();
    expect(servicesA2!.workflowComposition).not.toBe(compA);
    expect(servicesA2!.workflowComposition).not.toBe(compB);
    expect(hasRegisteredProductionWorkflowComposition(storeA)).toBe(true);
    expect(getOrCreateProductionWorkflowComposition(storeB)).toBe(compB);

    // Disposing storeA tears down in reverse order, locks storeA closed, evicts its composition,
    // and leaves storeB unaffected with exact registration order preserved.
    const disposeOrderA = disposeCutoverStore(storeA);
    expect(disposeOrderA).toEqual([
      'coordinator',
      'workspaceLock',
      'catalogFs',
      'operationalMemento'
    ]);
    expect(hasRegisteredProductionWorkflowComposition(storeA)).toBe(false);
    expect(inspectCutoverRegistrations(storeA).disposed).toBe(true);
    expect(() => registerCatalogFsForStore(storeA, catalogFsA)).toThrow(CutoverRegistrationOrderError);

    expect(hasRegisteredProductionWorkflowComposition(storeB)).toBe(true);
    expect(getOrCreateProductionWorkflowComposition(storeB)).toBe(compB);
    expect(getSqliteCutoverCoordinator(storeB)).toBe(coordB);
    expect(inspectCutoverRegistrations(storeB)).toEqual({
      registered: ['operationalMemento', 'catalogFs', 'workspaceLock', 'coordinator'],
      missing: [],
      orderViolations: [],
      disposed: false
    });
    expect(() => assertCutoverRegistrationOrder(storeB)).not.toThrow();

    // Direct unregister helper also cleans up lazily cached compositions (no primary SQLite needed).
    const lazyStore = new WorkspaceStateStore(makeMemoryMemento(), makeSilentLogger());
    await lazyStore.initialize();
    expect(hasRegisteredProductionWorkflowComposition(lazyStore)).toBe(false);
    getOrCreateProductionWorkflowComposition(lazyStore, { workspaceRoot: envA.workspaceRoot });
    expect(hasRegisteredProductionWorkflowComposition(lazyStore)).toBe(true);
    expect(unregisterProductionWorkflowComposition(lazyStore)).toBe(true);
    expect(hasRegisteredProductionWorkflowComposition(lazyStore)).toBe(false);
    expect(unregisterProductionWorkflowComposition(lazyStore)).toBe(false);

    // Disposing storeB cleanly evicts storeB's composition as well.
    const disposeOrderB = disposeCutoverStore(storeB);
    expect(disposeOrderB).toEqual([
      'coordinator',
      'workspaceLock',
      'catalogFs',
      'operationalMemento'
    ]);
    expect(hasRegisteredProductionWorkflowComposition(storeB)).toBe(false);
  });

  it('prevents stale closed coordinators and cache overwrites from detaching or evicting a re-wired Stage 2 coordinator', async () => {
    const env = await makeTempWorkspace('n08-stale-race-');
    const logger = makeSilentLogger();
    const opMem = createSwitchableOperationalMemento(makeMemoryMemento(), logger);
    const store = new WorkspaceStateStore(opMem, logger);
    await store.initialize();
    storesToDispose.push(store);

    // 1. Overwriting a cached composition disposes the replaced instance; identity-guarded unregister ignores stale references.
    const staleDispose = vi.fn();
    const freshDispose = vi.fn();
    const fakeStale = { dispose: staleDispose } as unknown as ReturnType<
      typeof getOrCreateProductionWorkflowComposition
    >;
    const fakeFresh = { dispose: freshDispose } as unknown as ReturnType<
      typeof getOrCreateProductionWorkflowComposition
    >;
    registerProductionWorkflowComposition(store, fakeStale);
    registerProductionWorkflowComposition(store, fakeFresh);
    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(freshDispose).not.toHaveBeenCalled();
    expect(unregisterProductionWorkflowComposition(store, fakeStale)).toBe(false);
    expect(hasRegisteredProductionWorkflowComposition(store)).toBe(true);
    expect(freshDispose).not.toHaveBeenCalled();
    expect(unregisterProductionWorkflowComposition(store, fakeFresh)).toBe(true);
    expect(freshDispose).toHaveBeenCalledTimes(1);

    // 2. An in-flight coord1.activatePrimary() settling AFTER resetCutoverStage2 + coord2.activatePrimary()
    // must NOT detach coord2's SQLite backing, clear coord2's detached writer, or evict coord2's composition.
    const catalogAttachEntered = createDeferred<void>();
    const catalogAttachRelease = createDeferred<void>();
    const blockingCatalogFs: SwitchableCatalogFsAdapter = {
      attachReadOnlySnapshotIfPresent: () => false,
      attachReadOnlySnapshotIfPresentAsync: async () => false,
      isSqliteAttached: () => false,
      attachSqlite: async () => {
        catalogAttachEntered.resolve();
        await catalogAttachRelease.promise;
      },
      detachSqlite: vi.fn()
    } as unknown as SwitchableCatalogFsAdapter;
    const fastCatalogFs = makeFakeCatalogFs();
    const lock = { hasPrimacy: async () => true };

    registerOperationalMementoForStore(store, opMem, { strictOrder: true });
    registerCatalogFsForStore(store, blockingCatalogFs, { strictOrder: true });
    registerWorkspaceLockForStore(store, lock, [], { strictOrder: true });

    const coord1 = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: env.globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot: env.workspaceRoot,
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

    const coord1Activation = coord1.activatePrimary();
    await catalogAttachEntered.promise;

    // Synchronously reset Stage 2 while coord1 is mid-activation, then re-wire and activate coord2.
    resetCutoverStage2(store);
    registerCatalogFsForStore(store, fastCatalogFs, { strictOrder: true });
    registerWorkspaceLockForStore(store, lock, [], { strictOrder: true });
    const coord2 = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: env.globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot: env.workspaceRoot,
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
    const services2 = await coord2.activatePrimary();
    expect(services2).not.toBeNull();
    expect(opMem.isSqliteAttached()).toBe(true);

    // Release coord1's abandoned activation and confirm coord2 remains attached, writable, and registered.
    catalogAttachRelease.resolve();
    expect(await coord1Activation).toBeNull();

    expect(opMem.isSqliteAttached()).toBe(true);
    expect(getSqliteCutoverCoordinator(store)).toBe(coord2);
    expect(hasRegisteredProductionWorkflowComposition(store)).toBe(true);
    expect(getOrCreateProductionWorkflowComposition(store)).toBe(services2!.workflowComposition);
    const queue = new QueueManager(store, logger);
    await expect(queue.enqueue('still-writable-after-stale-close')).resolves.toMatchObject({
      description: 'still-writable-after-stale-close'
    });

    // 3. A superseded-before-close coordinator (replaced in cutoverRegistry while in-flight before
    // close() is called) also sees itself as inactive and cannot detach or overwrite the live successor.
    const env3 = await makeTempWorkspace('n08-superseded-before-close-');
    const opMem3 = createSwitchableOperationalMemento(makeMemoryMemento(), logger);
    const store3 = new WorkspaceStateStore(opMem3, logger);
    await store3.initialize();
    storesToDispose.push(store3);

    const primacyEntered = createDeferred<void>();
    const primacyRelease = createDeferred<boolean>();
    registerOperationalMementoForStore(store3, opMem3, { strictOrder: true });
    registerCatalogFsForStore(store3, makeFakeCatalogFs(), { strictOrder: true });
    registerWorkspaceLockForStore(store3, { hasPrimacy: async () => true }, [], { strictOrder: true });

    const staleCoord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: env3.globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot: env3.workspaceRoot,
      store: store3,
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => {
        primacyEntered.resolve();
        return primacyRelease.promise;
      },
      disposables: []
    });

    const staleActivation = staleCoord.activatePrimary();
    await primacyEntered.promise;

    // Supersede staleCoord in cutoverRegistry BEFORE calling staleCoord.close().
    const liveCoord = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: env3.globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot: env3.workspaceRoot,
      store: store3,
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
    const liveServices = await liveCoord.activatePrimary();
    expect(liveServices).not.toBeNull();

    // Release staleCoord's pending primacy check; staleCoord must abort without touching liveCoord.
    primacyRelease.resolve(true);
    expect(await staleActivation).toBeNull();
    staleCoord.close();

    expect(opMem3.isSqliteAttached()).toBe(true);
    expect(getSqliteCutoverCoordinator(store3)).toBe(liveCoord);
    expect(getOrCreateProductionWorkflowComposition(store3)).toBe(liveServices!.workflowComposition);
    const queue3 = new QueueManager(store3, logger);
    await expect(queue3.enqueue('still-writable-after-supersede')).resolves.toMatchObject({
      description: 'still-writable-after-supersede'
    });

    // 4. Superseding an already-active coordinator with a passive/untrusted replacement closes and
    // detaches the prior SQLite store cleanly instead of leaving operationalMemento attached to a closed DB.
    const passiveReplacement = createSqliteCutoverCoordinator({
      context: {
        storageUri: undefined,
        globalStorageUri: { fsPath: env3.globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot: env3.workspaceRoot,
      store: store3,
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
    expect(opMem3.isSqliteAttached()).toBe(false);
    expect(getSqliteCutoverCoordinator(store3)).toBe(passiveReplacement);
    // Read-only snapshot remains readable without throwing ERR_INVALID_STATE on a closed handle.
    expect(queue3.list().map((item) => item.description)).toContain('still-writable-after-supersede');
    await expect(passiveReplacement.probePassiveSnapshots()).resolves.toBeUndefined();

    // 5. SwitchableCatalogFsAdapter aborts in-flight attachSqlite on identity-guarded detachSqlite(store)
    // without writing legacy rows into SQLite or blocking passive snapshot probes, and identity-guarded
    // detachSqlite(oldStore) never aborts an unrelated store's in-flight attachSqlite(newStore).
    const envCat = await makeTempWorkspace('n08-catalog-attach-abort-');
    const dbPath = path.join(envCat.globalStorage, 'catalog-abort.db');
    const snapDbPath = path.join(envCat.globalStorage, 'catalog-snapshot.db');
    const sqliteStoreCat = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const snapshotSeedStore = new SqliteApplicationStore({ databasePath: snapDbPath, journalMode: 'wal' });
    const sampleManifest = JSON.stringify({ schemaVersion: 1, phases: {}, pipelines: {}, workflows: {} });
    const snapshotManifest = JSON.stringify({ schemaVersion: 1, phases: { p1: '1' }, pipelines: {}, workflows: {} });
    // Seed a real committed snapshot DB with cutover sentinel + catalog-fs row for passive probe test.
    snapshotSeedStore.writerConnection.run(
      `INSERT INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
       VALUES (?, 'sqlite', 'cutover', 1, '0', '0', ?)`,
      'scope-cat-1',
      T0
    );
    snapshotSeedStore.writerConnection.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, 'manifest.json', 1, 1, ?, ?, 0, ?)`,
      'catalog-fs:scope-cat-1',
      snapshotManifest,
      Buffer.byteLength(snapshotManifest, 'utf8'),
      T0
    );
    snapshotSeedStore.close();

    const legacyReadEntered = createDeferred<void>();
    const legacyReadRelease = createDeferred<void>();
    const switchableCat = createSwitchableCatalogFsAdapter({
      readFile: async (at) => {
        if (at.join('/') === 'manifest.json') {
          legacyReadEntered.resolve();
          await legacyReadRelease.promise;
          return { outcome: 'read', contents: sampleManifest };
        }
        return { outcome: 'absent' };
      },
      writeFileAtomic: async () => ({ outcome: 'written' }),
      writeFileIfAbsent: async () => ({ outcome: 'written' }),
      listDirectory: async () => [],
      removeFile: async () => ({ outcome: 'removed' }),
      checkWritability: async () => 'writable'
    });

    try {
      // (a) Fail-fast when shouldCommit is already false: writes zero rows under catalog-fs:* or anywhere.
      await expect(
        switchableCat.attachSqlite(sqliteStoreCat, 'scope-cat-1', undefined, () => false)
      ).rejects.toThrow(/aborted/i);
      const countAfterImmediateAbort = Number(
        sqliteStoreCat.writerConnection.scalar(
          `SELECT COUNT(*) FROM operational_kv_documents WHERE doc_namespace = ?`,
          'catalog-fs:scope-cat-1'
        ) ?? 0
      );
      const totalAfterImmediateAbort = Number(
        sqliteStoreCat.writerConnection.scalar(`SELECT COUNT(*) FROM operational_kv_documents`) ?? 0
      );
      expect(countAfterImmediateAbort).toBe(0);
      expect(totalAfterImmediateAbort).toBe(0);

      // (b) In-flight attach aborted by identity-guarded detachSqlite(sqliteStoreCat) before legacy read resolves
      // must NOT block passive snapshot probe while still parked, and must write zero rows upon resume.
      const inFlightAttach = switchableCat.attachSqlite(sqliteStoreCat, 'scope-cat-1');
      await legacyReadEntered.promise;
      switchableCat.detachSqlite(sqliteStoreCat);
      expect(switchableCat.attachReadOnlySnapshotIfPresent(snapDbPath, 'scope-cat-1')).toBe(true);
      expect(await switchableCat.readFile(['manifest.json'])).toEqual({
        outcome: 'read',
        contents: snapshotManifest
      });

      legacyReadRelease.resolve();
      await expect(inFlightAttach).rejects.toThrow(/aborted/i);
      expect(switchableCat.isSqliteAttached()).toBe(false);
      const countAfterDetachedAbort = Number(
        sqliteStoreCat.writerConnection.scalar(
          `SELECT COUNT(*) FROM operational_kv_documents WHERE doc_namespace = ?`,
          'catalog-fs:scope-cat-1'
        ) ?? 0
      );
      const totalAfterDetachedAbort = Number(
        sqliteStoreCat.writerConnection.scalar(`SELECT COUNT(*) FROM operational_kv_documents`) ?? 0
      );
      expect(countAfterDetachedAbort).toBe(0);
      expect(totalAfterDetachedAbort).toBe(0);

      // (c) Identity-guarded detachSqlite(oldStore) must NOT abort an unrelated in-flight attachSqlite(newStore).
      const dbOldPath = path.join(envCat.globalStorage, 'catalog-old.db');
      const dbNewPath = path.join(envCat.globalStorage, 'catalog-new.db');
      const oldStore = new SqliteApplicationStore({ databasePath: dbOldPath, journalMode: 'wal' });
      const newStore = new SqliteApplicationStore({ databasePath: dbNewPath, journalMode: 'wal' });
      const newReadEntered = createDeferred<void>();
      const newReadRelease = createDeferred<void>();
      let readCount = 0;
      const switchableSwap = createSwitchableCatalogFsAdapter({
        readFile: async (at) => {
          if (at.join('/') === 'manifest.json') {
            readCount += 1;
            if (readCount === 2) {
              newReadEntered.resolve();
              await newReadRelease.promise;
            }
            return { outcome: 'read', contents: sampleManifest };
          }
          return { outcome: 'absent' };
        },
        writeFileAtomic: async () => ({ outcome: 'written' }),
        writeFileIfAbsent: async () => ({ outcome: 'written' }),
        listDirectory: async () => [],
        removeFile: async () => ({ outcome: 'removed' }),
        checkWritability: async () => 'writable'
      });
      try {
        await switchableSwap.attachSqlite(oldStore, 'scope-swap');
        const newAttach = switchableSwap.attachSqlite(newStore, 'scope-swap');
        await newReadEntered.promise;
        switchableSwap.detachSqlite(oldStore);
        newReadRelease.resolve();
        await expect(newAttach).resolves.toBeDefined();
        expect(switchableSwap.isSqliteAttached()).toBe(true);
      } finally {
        oldStore.close();
        newStore.close();
      }
    } finally {
      sqliteStoreCat.close();
    }
  });

  it('isolates concurrent QueueManager mutations and preserves exact task ordering across two independent stores', async () => {
    const logger = makeSilentLogger();
    const storeA = new WorkspaceStateStore(makeMemoryMemento(), logger);
    const storeB = new WorkspaceStateStore(makeMemoryMemento(), logger);
    await Promise.all([storeA.initialize(), storeB.initialize()]);

    const queueA = new QueueManager(storeA, logger);
    const queueB = new QueueManager(storeB, logger);

    // Interleave enqueues across both independent stores concurrently.
    const [a1, b1] = await Promise.all([
      queueA.enqueue('Store A task 1'),
      queueB.enqueue('Store B task 1')
    ]);
    const [a2, b2] = await Promise.all([
      queueA.enqueue('Store A task 2'),
      queueB.enqueue('Store B task 2')
    ]);
    const [a3, b3] = await Promise.all([
      queueA.enqueue('Store A task 3'),
      queueB.enqueue('Store B task 3')
    ]);

    expect(queueA.list().map((t) => t.description)).toEqual([
      'Store A task 1',
      'Store A task 2',
      'Store A task 3'
    ]);
    expect(queueB.list().map((t) => t.description)).toEqual([
      'Store B task 1',
      'Store B task 2',
      'Store B task 3'
    ]);
    expect(queueA.findById(b1.id)).toBeNull();
    expect(queueB.findById(a1.id)).toBeNull();

    // Concurrently reorder on storeA while modifying and pausing storeB.
    const [reorderA, modifyB, pauseB] = await Promise.all([
      queueA.reorderTask(a3.id, 0),
      queueB.modifyTask(b2.id, 'Store B task 2 (edited)'),
      queueB.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'store-b maintenance')
    ]);
    expect(reorderA.ok).toBe(true);
    expect(modifyB.ok).toBe(true);
    expect(pauseB.ok).toBe(true);

    const orderedTasks = (queue: QueueManager, queueId = DEFAULT_QUEUE_ID) =>
      queue.list(queueId).sort((a, b) => a.position - b.position);

    expect(orderedTasks(queueA).map((t) => t.id)).toEqual([a3.id, a1.id, a2.id]);
    expect(queueA.peekNextPending()?.id).toBe(a3.id);
    expect(storeA.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).not.toBe('operator-paused');
    expect(storeA.getQueue(DEFAULT_QUEUE_ID).pauseSource ?? null).toBeNull();

    expect(orderedTasks(queueB).map((t) => ({ id: t.id, desc: t.description }))).toEqual([
      { id: b1.id, desc: 'Store B task 1' },
      { id: b2.id, desc: 'Store B task 2 (edited)' },
      { id: b3.id, desc: 'Store B task 3' }
    ]);
    expect(storeB.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(storeB.getQueue(DEFAULT_QUEUE_ID).pauseSource).toBe('operator');

    // Concurrently create a second queue + remove a task on storeA while resuming + reordering storeB.
    const [createdQueueA, removedA, resumedB, reorderedB] = await Promise.all([
      queueA.createQueue('Store A Secondary'),
      queueA.removeTask(a1.id),
      queueB.setQueuePausedState(false, DEFAULT_QUEUE_ID),
      queueB.reorderTask(b3.id, 0)
    ]);
    expect(createdQueueA.ok).toBe(true);
    expect(removedA.ok).toBe(true);
    expect(resumedB.ok).toBe(true);
    expect(reorderedB.ok).toBe(true);

    // Assert zero cross-store leakage in queue registries, pause flags, and task lists.
    expect(storeA.getQueueRegistry().entries).toHaveLength(2);
    expect(storeB.getQueueRegistry().entries).toHaveLength(1);
    expect(orderedTasks(queueA).map((t) => t.id)).toEqual([a3.id, a2.id]);
    expect(orderedTasks(queueB).map((t) => t.id)).toEqual([b3.id, b1.id, b2.id]);
    expect(queueA.listAll().map((t) => t.id)).toEqual([a3.id, a2.id]);
    expect(queueB.listAll().map((t) => t.id)).toEqual([b3.id, b1.id, b2.id]);
    expect(storeB.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).not.toBe('operator-paused');
    expect(storeB.getQueue(DEFAULT_QUEUE_ID).pauseSource ?? null).toBeNull();
    expect(queueA.findById(b3.id)).toBeNull();
    expect(queueB.findById(a2.id)).toBeNull();
  });

  it('drives independent RunDriver and PhaseRunner stacks on storeA and storeB with strict run, history, and audit isolation', async () => {
    const envA = await makeTempWorkspace('n08-exec-a-');
    const envB = await makeTempWorkspace('n08-exec-b-');
    const stackA = await createExecutionStack(envA.workspaceRoot, 'window-a');
    const stackB = await createExecutionStack(envB.workspaceRoot, 'window-b');

    try {
      // Admit Run A1 on storeA and Run B1 on storeB concurrently.
      const taskA1 = await stackA.queue.enqueue('Feature A1');
      const taskB1 = await stackB.queue.enqueue('Feature B1');

      const [admA1, admB1] = await Promise.all([
        stackA.controller.admitNew(taskA1, null),
        stackB.controller.admitNew(taskB1, null)
      ]);
      const runA1 = stackA.store.getRun(DEFAULT_QUEUE_ID);
      const runB1 = stackB.store.getRun(DEFAULT_QUEUE_ID);
      expect(runA1).not.toBeNull();
      expect(runB1).not.toBeNull();
      expect(runA1!.id).not.toBe(runB1!.id);

      // Both runs deterministically park at phase 1 via explicit deferred barriers.
      const invA0 = await stackA.waitForInvocation(0, admA1.completed);
      const invB0 = await stackB.waitForInvocation(0, admB1.completed);
      expect(invA0).toEqual({ runId: runA1!.id, phase: ISO_PHASE_1 });
      expect(invB0).toEqual({ runId: runB1!.id, phase: ISO_PHASE_1 });

      // Hold Run A1 parked at phase 1 while driving Run B1 to completion across both phases.
      stackB.releaseInvocation(0);
      const invB1 = await stackB.waitForInvocation(1, admB1.completed);
      expect(invB1).toEqual({ runId: runB1!.id, phase: ISO_PHASE_2 });
      stackB.releaseInvocation(1);
      await admB1.completed;

      // While A1 is still running phase 1, storeB holds completed B1 and 1 history record;
      // storeA remains untouched at running phase 1 with 0 history records.
      expect(stackA.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
      expect(stackA.store.getRun(DEFAULT_QUEUE_ID)?.currentPhase).toBe(ISO_PHASE_1);
      expect(stackA.historyStore.list()).toEqual([]);

      expect(stackB.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
      expect(
        stackB.store.getRun(DEFAULT_QUEUE_ID)?.phasesCompleted.map((p) => p.phase)
      ).toEqual([ISO_PHASE_1, ISO_PHASE_2]);
      expect(stackB.historyStore.list().map((h) => h.runId)).toEqual([runB1!.id]);

      // Start and fatally fail a second run (B2) on storeB while A1 stays parked in storeA.
      const taskB2 = await stackB.queue.enqueue('Feature B2 (fatal)');
      const admB2 = await stackB.controller.admitNew(taskB2, null);
      const runB2 = stackB.store.getRun(DEFAULT_QUEUE_ID);
      expect(runB2).not.toBeNull();
      expect(runB2!.id).not.toBe(runB1!.id);
      expect(runB2!.id).not.toBe(runA1!.id);

      const invB2 = await stackB.waitForInvocation(2, admB2.completed);
      expect(invB2).toEqual({ runId: runB2!.id, phase: ISO_PHASE_1 });
      stackB.releaseInvocation(2, makeFatalOutput());
      await admB2.completed;

      expect(stackB.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('failed');
      expect(stackA.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');

      // Now advance Run A1 through phase 1 -> phase 2 -> completed.
      stackA.releaseInvocation(0);
      const invA1 = await stackA.waitForInvocation(1, admA1.completed);
      expect(invA1).toEqual({ runId: runA1!.id, phase: ISO_PHASE_2 });
      stackA.releaseInvocation(1);
      await admA1.completed;

      // Assert exact invocation ordering and strict per-store run/history isolation.
      expect(stackA.invocations).toEqual([
        { runId: runA1!.id, phase: ISO_PHASE_1 },
        { runId: runA1!.id, phase: ISO_PHASE_2 }
      ]);
      expect(stackB.invocations).toEqual([
        { runId: runB1!.id, phase: ISO_PHASE_1 },
        { runId: runB1!.id, phase: ISO_PHASE_2 },
        { runId: runB2!.id, phase: ISO_PHASE_1 }
      ]);

      expect(stackA.store.getRun(DEFAULT_QUEUE_ID)?.id).toBe(runA1!.id);
      expect(stackA.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
      expect(stackB.store.getRun(DEFAULT_QUEUE_ID)?.id).toBe(runB2!.id);
      expect(stackB.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('failed');

      // Verify exact chronological append order in persisted history partitions.
      const persistedHistoryA = (stackA.store.getHistoryMap()[DEFAULT_QUEUE_ID] ?? [])
        .map((raw) => ensureHistoryEntry(raw, DEFAULT_QUEUE_ID))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      const persistedHistoryB = (stackB.store.getHistoryMap()[DEFAULT_QUEUE_ID] ?? [])
        .map((raw) => ensureHistoryEntry(raw, DEFAULT_QUEUE_ID))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      expect(persistedHistoryA.map((e) => ({ runId: e.runId, status: e.terminalStatus }))).toEqual([
        { runId: runA1!.id, status: 'completed' }
      ]);
      expect(persistedHistoryB.map((e) => ({ runId: e.runId, status: e.terminalStatus }))).toEqual([
        { runId: runB1!.id, status: 'completed' },
        { runId: runB2!.id, status: 'failed' }
      ]);
      expect(stackA.historyStore.list().map((e) => e.runId)).toEqual([runA1!.id]);
      expect(new Set(stackB.historyStore.list().map((e) => e.runId))).toEqual(
        new Set([runB1!.id, runB2!.id])
      );

      // Verify workspace audit logs contain zero cross-store run IDs.
      const auditA = await fsp.readFile(path.join(envA.workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      const auditB = await fsp.readFile(path.join(envB.workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      expect(auditA).toContain(runA1!.id);
      expect(auditA).not.toContain(runB1!.id);
      expect(auditA).not.toContain(runB2!.id);
      expect(auditB).toContain(runB1!.id);
      expect(auditB).toContain(runB2!.id);
      expect(auditB).not.toContain(runA1!.id);
    } finally {
      stackA.releaseAll();
      stackB.releaseAll();
    }
  });
});
