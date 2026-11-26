/**
 * Principal Review Findings 1 & 2 regression suite:
 *   - Finding 1: Connected-run command receipts roll over cleanly at MAX_COMMAND_RECEIPTS (64 -> 65+),
 *     persist across real SQLite reopen, support idempotent replay, reject tampered retained receipts,
 *     and preserve candidate-retry idempotency across ledger + receipt.
 *   - Finding 2: Startup orphan-root cleanup uses tri-state parent presence ('present' |
 *     'unreadable-refused' | 'absent'), preserving linked control ledger roots, permits, and waiters
 *     for refused/future-schema parents across double SQLite reopen while cleaning genuinely absent
 *     unstarted orphan roots and surfacing metadata-only isolated recovery error diagnostics.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileComposableWorkflowRuns } from '../../src/activation/run-safety-wiring';
import { buildOwnerResolver } from '../../src/activation/sqlite-cutover-helpers';
import { createDesktopOwnershipFenceForStore } from '../../src/activation/workflow-ownership-fence';
import {
  CONTROL_LEDGER_VERSION,
  createEmptyControlLedger,
  type ControlLedger,
  type ExecutionFence
} from '../../src/contracts/control-ledger';
import { SanitizedLogger } from '../../src/lib/logger';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { ControlCommandService } from '../../src/services/workflow-execution/control-command-service';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import {
  createProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import { WorkflowControlService } from '../../src/services/workflow-execution/workflow-control-service';
import { WorkflowRecoveryService } from '../../src/services/workflow-execution/workflow-recovery-service';
import { deepFreezeConnectedRunsDocument } from '../../src/state/connected-run-migrator';
import {
  appendCommandReceipt,
  createConnectedRun,
  MAX_COMMAND_RECEIPTS,
  type CommittedCommandReceipt,
  type ConnectedWorkflowRun,
  type WorkflowInvocationFrame
} from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager, type Scheduler } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { KEYS } from '../../src/state/workspace-state-types';
import { removeTempRoot } from '../temp-root-cleanup';

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

function makeConnectedRun(
  connectedRunId: string,
  queueId = 'default',
  status: WorkflowInvocationFrame['status'] = 'in-flight'
): ConnectedWorkflowRun {
  const rootInvId = `${connectedRunId}:root`;
  const frame: WorkflowInvocationFrame = Object.freeze({
    invocationId: rootInvId,
    rootRunId: connectedRunId,
    parentInvocationId: null,
    parentCallNodeId: null,
    parentAttemptId: null,
    workflowId: 'wf-test',
    depth: 0,
    nodePath: 'wf-test',
    entryNodeId: 'step-1',
    activeNodeId: 'step-1',
    status,
    startedAt: 1_700_000_000_000,
    boundInputs: Object.freeze({}),
    resolvedOutputs: Object.freeze({}),
    attemptsByNodeId: Object.freeze({}),
    decisions: Object.freeze([])
  });
  return createConnectedRun({
    connectedRunId,
    workflowId: 'wf-test',
    queueId,
    startedAt: 1_700_000_000_000,
    graph: {
      workflowId: 'wf-test',
      name: 'Test Workflow',
      version: 1,
      nodes: [{ nodeId: 'step-1', kind: 'phase', phaseId: 'implement' }],
      connections: [],
      startNodeIds: ['step-1']
    } as unknown as Parameters<typeof createConnectedRun>[0]['graph'],
    pipelines: {},
    invocations: { [rootInvId]: frame },
    controlState: {
      version: 1,
      ledgerRunId: connectedRunId
    }
  });
}

async function openSqliteWorkspaceStore(tmpRoot: string, ownerId: string) {
  const dbPath = path.join(tmpRoot, 'state.db');
  const ownershipDir = path.join(tmpRoot, '.schegent', 'ownership');
  const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqlite, 'ws-f1-f2');
  const store = new WorkspaceStateStore(memento);
  store.useOwnershipStorage(
    createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir }),
    ownershipDir
  );
  await store.initialize();
  const lock = new WorkspaceLockManager(store, ownerId, { now: () => Date.now() }, noopScheduler);
  expect((await lock.tryAcquire()).acquired).toBe(true);
  store.bindPrimacyClaimSource(lock);
  const lease = new ExecutionLeaseManager(store, ownerId, { now: () => Date.now() }, noopScheduler);
  store.bindRunClaimSource(lease);
  return {
    sqlite,
    memento,
    store,
    lock,
    lease,
    close: async () => {
      unregisterProductionWorkflowComposition(store);
      await lock.release();
      memento.detachSqlite();
      sqlite.close();
    }
  };
}

describe('Principal Review Findings 1 & 2 — Receipt Rollover & Tri-State Orphan Recovery', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir !== undefined) await removeTempRoot(dir);
    }
  });

  it('Finding 1: accepts the 65th through 130th generic connected-run control receipts across SQLite reopen, replays retained receipts idempotently, and rejects tampered retained receipts', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-f1-receipts-'));
    tempRoots.push(tmpRoot);

    const host1 = await openSqliteWorkspaceStore(tmpRoot, 'owner-1');
    try {
      let run = makeConnectedRun('run-rollover-1');
      const seeded = await host1.store.compareAndSetConnectedRun(run, 0);
      expect(seeded.outcome).toBe('written');
      if (seeded.outcome !== 'written') throw new Error('seed failed');
      run = seeded.run;

      // Drive 129 distinct receipts (crossing 64 -> 65 and 128 -> 129 rollover boundaries).
      for (let i = 1; i <= 129; i += 1) {
        const receipt: CommittedCommandReceipt = Object.freeze({
          commandId: `cmd-${i}`,
          operation: i % 2 === 1 ? 'pause' : 'resume',
          targetInvocationId: 'run-rollover-1:root',
          committedRevision: run.revision + 1,
          committedAt: 1_700_000_000_000 + i * 1000,
          resultingRunStatus: i % 2 === 1 ? 'paused' : 'in-flight',
          resultingInvocationStatus: i % 2 === 1 ? 'paused' : 'in-flight'
        });
        const next = appendCommandReceipt(run, receipt);
        const written = await host1.store.compareAndSetConnectedRun(next, run.revision);
        expect(written.outcome, `receipt ${i} must commit`).toBe('written');
        if (written.outcome !== 'written') throw new Error(`receipt ${i} failed`);
        run = written.run;
      }

      expect(run.commandReceipts).toHaveLength(MAX_COMMAND_RECEIPTS);
      expect(run.commandReceipts?.[0]?.commandId).toBe('cmd-66');
      expect(run.commandReceipts?.[MAX_COMMAND_RECEIPTS - 1]?.commandId).toBe('cmd-129');

      // Negative control 1: tampering a retained receipt's operation/target must still be rejected
      // with explicit `immutability-violation` reason.
      const tamperedReceipts = [...(run.commandReceipts ?? [])];
      tamperedReceipts[10] = Object.freeze({
        ...tamperedReceipts[10]!,
        operation: 'cancel'
      });
      const tamperedRun: ConnectedWorkflowRun = Object.freeze({
        ...run,
        commandReceipts: Object.freeze(tamperedReceipts),
        revision: run.revision + 1
      });
      const tamperResult = await host1.store.compareAndSetConnectedRun(tamperedRun, run.revision);
      expect(tamperResult.outcome).toBe('stale');
      if (tamperResult.outcome === 'stale') {
        expect(tamperResult.reason).toBe('immutability-violation');
      }

      // Negative control 2: shrinking the receipt array must still be rejected.
      const shrunkRun: ConnectedWorkflowRun = Object.freeze({
        ...run,
        commandReceipts: Object.freeze((run.commandReceipts ?? []).slice(1)),
        revision: run.revision + 1
      });
      const shrinkResult = await host1.store.compareAndSetConnectedRun(shrunkRun, run.revision);
      expect(shrinkResult.outcome).toBe('stale');
      if (shrinkResult.outcome === 'stale') {
        expect(shrinkResult.reason).toBe('immutability-violation');
      }

      // Negative control 3: duplicate newly appended commandIds must be rejected.
      const dupReceipt: CommittedCommandReceipt = Object.freeze({
        commandId: 'cmd-dup-new',
        operation: 'pause',
        targetInvocationId: 'run-rollover-1:root',
        committedRevision: run.revision + 1,
        committedAt: 1_700_000_200_000,
        resultingRunStatus: 'paused',
        resultingInvocationStatus: 'paused'
      });
      const dupRun: ConnectedWorkflowRun = Object.freeze({
        ...run,
        commandReceipts: Object.freeze([
          ...(run.commandReceipts ?? []).slice(2),
          dupReceipt,
          dupReceipt
        ]),
        revision: run.revision + 1
      });
      const dupResult = await host1.store.compareAndSetConnectedRun(dupRun, run.revision);
      expect(dupResult.outcome).toBe('stale');
      if (dupResult.outcome === 'stale') {
        expect(dupResult.reason).toBe('immutability-violation');
      }
    } finally {
      await host1.close();
    }

    // Reopen SQLite store, verify all 64 retained receipts survive, execute idempotent replay and command 130 via WorkflowControlService.
    const host2 = await openSqliteWorkspaceStore(tmpRoot, 'owner-2');
    try {
      const reloaded = host2.store.getConnectedRun('run-rollover-1');
      expect(reloaded).not.toBeNull();
      expect(reloaded?.commandReceipts).toHaveLength(MAX_COMMAND_RECEIPTS);
      expect(reloaded?.commandReceipts?.[0]?.commandId).toBe('cmd-66');

      const controlService = new WorkflowControlService({
        connectedRuns: {
          get: (id) => host2.store.getConnectedRun(id),
          compareAndSetConnectedRun: (next, rev) => host2.store.compareAndSetConnectedRun(next, rev)
        },
        dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'q-noop' })
      });

      // Replay retained cmd-129 idempotently.
      const replay = await controlService.executeCommand({
        runId: 'run-rollover-1',
        commandId: 'cmd-129',
        operation: 'pause',
        expectedRevision: reloaded!.revision,
        targetInvocationId: 'run-rollover-1:root',
        now: 1_700_000_210_000
      });
      expect(replay.accepted).toBe(true);
      if (replay.accepted) {
        expect(replay.idempotentReplay).toBe(true);
      }

      // Commit distinct command 130 (pause) through WorkflowControlService -> rolls cmd-66 out, keeps cmd-67..cmd-130.
      const cmd130 = await controlService.executeCommand({
        runId: 'run-rollover-1',
        commandId: 'cmd-130',
        operation: 'pause',
        expectedRevision: reloaded!.revision,
        targetInvocationId: 'run-rollover-1:root',
        now: 1_700_000_211_000
      });
      expect(cmd130.accepted).toBe(true);
      if (cmd130.accepted) {
        expect(cmd130.idempotentReplay).toBe(false);
        expect(cmd130.run.commandReceipts).toHaveLength(MAX_COMMAND_RECEIPTS);
        expect(cmd130.run.commandReceipts?.[0]?.commandId).toBe('cmd-67');
        expect(cmd130.run.commandReceipts?.[MAX_COMMAND_RECEIPTS - 1]?.commandId).toBe('cmd-130');
      }

      // Real ControlCommandService split-store crash-and-replay test:
      // 1) `redirectLegacyRetryPhase` commits to `controlLedger` (incrementing `frameGeneration`
      //    and exiting `paused`);
      // 2) `connectedRuns` CAS fails with `ownership-lost` (`fence-lost` refusal, zero receipt);
      // 3) Replaying the exact same `commandId` converges idempotently against the REAL
      //    `ControlCommandService` without tripping `payloadDigest` drift!
      const ledgerStore = new ControlLedgerStore(host2.store);
      const seededSplitLedger: ControlLedger = {
        ...createEmptyControlLedger(),
        revision: 1,
        roots: {
          'run-rollover-1': {
            version: CONTROL_LEDGER_VERSION,
            ledgerRunId: 'run-rollover-1',
            connectedRunId: 'run-rollover-1',
            rootWorkflowId: 'wf-test',
            queueId: 'default',
            linkState: 'in-flight',
            status: 'in-flight',
            fence: { primacyClaim: 'primacy:run-rollover-1', queueClaim: 'queue:default', rootGeneration: 1 },
            rootBudget: { maxDispatches: 50, spendMode: 'count-only' },
            dispatchedAttempts: 1,
            settledMicrousd: 0,
            reservedMicrousd: 0,
            framesByKey: {
              'run-rollover-1:root': {
                frameKey: 'run-rollover-1:root',
                parentFrameKey: null,
                invocationId: 'run-rollover-1:root',
                workflowId: 'wf-test',
                kind: 'candidate-block',
                status: 'paused',
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
                dispatchedCount: 1,
                frameGeneration: 1,
                monitoringStartedAt: 1_700_000_000_000,
                monitoringExpiresAt: 1_700_086_400_000,
                selectedCandidateId: 'cand-primary',
                candidateSlots: [
                  {
                    candidateId: 'cand-primary',
                    priority: 1,
                    targetType: 'phase',
                    targetDefinitionId: 'step-1',
                    backend: 'claude',
                    maxAttempts: 3,
                    dispatchedAttempts: 1,
                    status: 'eligible'
                  }
                ]
              }
            },
            attemptsById: {},
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          }
        }
      } as unknown as ControlLedger;
      await host2.store.transactControlLedger(async (_raw, write) => {
        await write(seededSplitLedger);
      });

      const realControlCommandService = new ControlCommandService({
        ledgerStore,
        isTrusted: () => true,
        clock: {
          nowWallMs: () => 1_700_000_220_000,
          nowMonotonicMs: () => 220_000,
          hostEpoch: 'epoch-test'
        }
      });

      let simulateCrashOnce = true;
      let latest = host2.store.getConnectedRun('run-rollover-1')!;
      const realSplitService = new WorkflowControlService({
        connectedRuns: {
          get: () => latest,
          compareAndSetConnectedRun: async (next, expectedRev) => {
            if (simulateCrashOnce) {
              simulateCrashOnce = false;
              return { outcome: 'stale', current: latest, reason: 'ownership-lost' };
            }
            const res = await host2.store.compareAndSetConnectedRun(next, expectedRev);
            if (res.outcome === 'written') latest = res.run;
            return res;
          }
        },
        dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'q-noop' }),
        controlCommandService: realControlCommandService
      });

      const firstAttempt = await realSplitService.executeCommand({
        runId: 'run-rollover-1',
        commandId: '11111111-1111-4111-8111-111111111131',
        operation: 'retry-phase',
        expectedRevision: latest.revision,
        targetInvocationId: 'run-rollover-1:root',
        now: 1_700_000_220_000
      });
      expect(firstAttempt.accepted).toBe(false);
      if (!firstAttempt.accepted) {
        expect(firstAttempt.refusalCode).toBe('fence-lost');
      }

      // Replaying the exact same commandId now converges idempotently against the real ledger!
      const replayAttempt = await realSplitService.executeCommand({
        runId: 'run-rollover-1',
        commandId: '11111111-1111-4111-8111-111111111131',
        operation: 'retry-phase',
        expectedRevision: latest.revision,
        targetInvocationId: 'run-rollover-1:root',
        now: 1_700_000_221_000
      });
      expect(replayAttempt.accepted).toBe(true);
      if (replayAttempt.accepted) {
        expect(replayAttempt.run.commandReceipts?.[MAX_COMMAND_RECEIPTS - 1]?.commandId).toBe(
          '11111111-1111-4111-8111-111111111131'
        );
      }
    } finally {
      await host2.close();
    }
  });

  it('Finding 2: double SQLite reopen preserves control ledger root, permits, and waiters for a refused/future parent while cleaning genuinely absent unstarted orphans and surfacing isolated failure diagnostics', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-f2-recovery-'));
    tempRoots.push(tmpRoot);

    const refusedRunId = 'run-future-parent';
    const healthyRunId = 'run-healthy-sibling';
    const absentOrphanId = 'run-absent-orphan';

    const makeLedgerRoot = (id: string, queueId: string) => ({
      version: CONTROL_LEDGER_VERSION,
      ledgerRunId: id,
      connectedRunId: id,
      rootWorkflowId: 'wf-test',
      queueId,
      linkState: 'in-flight' as const,
      status: 'in-flight' as const,
      fence: {
        primacyClaim: `primacy:${id}`,
        queueClaim: `queue:${queueId}`,
        rootGeneration: 1
      } satisfies ExecutionFence,
      rootBudget: { maxDispatches: 50, spendMode: 'count-only' as const },
      dispatchedAttempts: 0,
      settledMicrousd: 0,
      reservedMicrousd: 0,
      framesByKey: {},
      attemptsById: {},
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000
    });

    const initialLedger: ControlLedger = {
      ...createEmptyControlLedger(),
      revision: 1,
      nextWaitSequence: 3,
      roots: {
        [refusedRunId]: makeLedgerRoot(refusedRunId, 'default'),
        [healthyRunId]: makeLedgerRoot(healthyRunId, 'default'),
        [absentOrphanId]: makeLedgerRoot(absentOrphanId, 'default')
      },
      permits: {
        'permit-refused': {
          permitId: 'permit-refused',
          ledgerRunId: refusedRunId,
          rootRunId: refusedRunId,
          connectedRunId: refusedRunId,
          queueId: 'default',
          invocationId: `${refusedRunId}:root`,
          attemptId: 'att-future-1',
          backend: 'claude',
          quotaId: 'claude/default',
          status: 'active',
          state: 'active',
          grantedAt: 1_700_000_000_000,
          expiresAt: 1_700_000_600_000,
          fence: { primacyClaim: `primacy:${refusedRunId}`, queueClaim: 'queue:default', rootGeneration: 1 }
        },
        'permit-orphan': {
          permitId: 'permit-orphan',
          ledgerRunId: absentOrphanId,
          rootRunId: absentOrphanId,
          connectedRunId: absentOrphanId,
          queueId: 'default',
          invocationId: `${absentOrphanId}:root`,
          attemptId: 'att-orphan-1',
          backend: 'claude',
          quotaId: 'claude/default',
          status: 'active',
          state: 'active',
          grantedAt: 1_700_000_000_000,
          expiresAt: 1_700_000_600_000,
          fence: { primacyClaim: `primacy:${absentOrphanId}`, queueClaim: 'queue:default', rootGeneration: 1 }
        }
      },
      waiters: [
        {
          waiterId: 'waiter-refused',
          waitSequence: 1,
          ledgerRunId: refusedRunId,
          rootRunId: refusedRunId,
          connectedRunId: refusedRunId,
          queueId: 'default',
          frameKey: `${refusedRunId}:root`,
          invocationId: `${refusedRunId}:root`,
          nodeId: 'step-1',
          quotaKeys: ['claude/default'],
          status: 'waiting',
          enqueuedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000
        },
        {
          waiterId: 'waiter-orphan',
          waitSequence: 2,
          ledgerRunId: absentOrphanId,
          rootRunId: absentOrphanId,
          connectedRunId: absentOrphanId,
          queueId: 'default',
          frameKey: `${absentOrphanId}:root`,
          invocationId: `${absentOrphanId}:root`,
          nodeId: 'step-1',
          quotaKeys: ['claude/default'],
          status: 'waiting',
          enqueuedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000
        }
      ]
    } as unknown as ControlLedger;

    // Seed SQLite with: one future-version refused parent, one healthy sibling parent, and ledger with all 3 roots.
    const seedHost = await openSqliteWorkspaceStore(tmpRoot, 'owner-seed');
    try {
      const healthyRun = makeConnectedRun(healthyRunId, 'default', 'waiting-for-handoff');
      const seeded = await seedHost.store.compareAndSetConnectedRun(healthyRun, 0);
      expect(seeded.outcome).toBe('written');

      // Inject opaque future-schema parent directly alongside the healthy run in SQLite memento backing.
      const futureOpaqueParent = {
        schemaVersion: 99,
        connectedRunId: refusedRunId,
        workflowId: 'wf-future',
        futurePayload: { opaqueToken: 'keep-me-intact' }
      };
      const existingConnected = seedHost.store.getConnectedRuns();
      await seedHost.memento.update(KEYS.connectedRuns, {
        ...existingConnected,
        [refusedRunId]: futureOpaqueParent
      });
      await seedHost.store.transactControlLedger(async (_raw, write) => {
        await write(initialLedger);
      });
    } finally {
      await seedHost.close();
    }

    // Reopen TWICE and run production startup reconciliation (`reconcileComposableWorkflowRuns`).
    for (const restartIdx of [1, 2]) {
      const host = await openSqliteWorkspaceStore(tmpRoot, `owner-restart-${restartIdx}`);
      try {
        expect(host.store.getConnectedRunPresence(refusedRunId)).toBe('unreadable-refused');
        expect(host.store.getConnectedRunPresence(healthyRunId)).toBe('present');
        expect(host.store.getConnectedRunPresence(absentOrphanId)).toBe('absent');

        const composition = createProductionWorkflowComposition({
          store: host.store,
          workspaceRoot: tmpRoot,
          isWorkspaceTrusted: () => true,
          ...createDesktopOwnershipFenceForStore(host.store),
          requireLiveFenceVerifier: true
        });
        registerProductionWorkflowComposition(host.store, composition);

        // Verify buildOwnerResolver fails closed (`unresolved`) for refused/future connected parents!
        const resolveOwner = buildOwnerResolver(host.store);
        expect(resolveOwner('run', refusedRunId)).toBe('unresolved');
        expect(resolveOwner('run', healthyRunId)).toBe('live');
        expect(resolveOwner('run', absentOrphanId)).toBe('settled');

        const warnLogs: string[] = [];
        const spyLogger = new SanitizedLogger();
        const origWarn = spyLogger.warn.bind(spyLogger);
        spyLogger.warn = (msg: string, ...args: unknown[]) => {
          warnLogs.push(msg);
          origWarn(msg, ...(args as []));
        };

        await reconcileComposableWorkflowRuns({
          workspaceRoot: tmpRoot,
          store: host.store,
          logger: spyLogger,
          productionComposition: composition
        });

        expect(
          warnLogs.some((line) => line.includes('preservedRefusedParents=1'))
        ).toBe(true);

        // 1. Refused future parent's control root, permit, and waiter MUST survive both restarts!
        const rawLedger = host.store.getRawControlLedger() as ControlLedger;
        expect(Object.hasOwn(rawLedger.roots, refusedRunId)).toBe(true);
        expect(Object.hasOwn(rawLedger.permits, 'permit-refused')).toBe(true);
        expect(rawLedger.waiters.some((w) => w.waiterId === 'waiter-refused')).toBe(true);

        // 2. Healthy sibling survives and remains present.
        expect(Object.hasOwn(rawLedger.roots, healthyRunId)).toBe(true);
        expect(host.store.getConnectedRun(healthyRunId)).not.toBeNull();

        // 3. Genuinely absent unstarted orphan root, its permit, and its waiter ARE cleaned up.
        expect(Object.hasOwn(rawLedger.roots, absentOrphanId)).toBe(false);
        expect(Object.hasOwn(rawLedger.permits, 'permit-orphan')).toBe(false);
        expect(rawLedger.waiters.some((w) => w.waiterId === 'waiter-orphan')).toBe(false);
      } finally {
        await host.close();
      }
    }

    // Also verify metadata-only isolated failure diagnostics when one run throws during reconcileAllRuns.
    const isolatedFailures: Array<{ runId: string; reasonCode: string }> = [];
    const goodRun = makeConnectedRun('run-good-sibling', 'default', 'waiting-for-handoff');
    const throwingRun = makeConnectedRun('run-throws-in-reconcile', 'default', 'in-flight');
    const recovery = new WorkflowRecoveryService({
      connectedRuns: {
        get: (id) => {
          if (id === throwingRun.connectedRunId) {
            const err = new TypeError('/secret/path/should/never/leak');
            throw err;
          }
          return id === goodRun.connectedRunId ? goodRun : null;
        },
        list: () => [throwingRun, goodRun],
        getPresence: (id) =>
          id === throwingRun.connectedRunId || id === goodRun.connectedRunId ? 'present' : 'absent',
        compareAndSetConnectedRun: async (next) => ({ outcome: 'written', run: next })
      },
      dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'q-1' }),
      onIsolatedFailure: (failure) => isolatedFailures.push(failure)
    });
    const results = await recovery.reconcileAllRuns(1_700_000_050_000);
    expect(results.some((r) => r.runId === goodRun.connectedRunId)).toBe(true);
    expect(isolatedFailures).toEqual([
      { runId: 'run-throws-in-reconcile', reasonCode: 'TypeError' }
    ]);
    expect(JSON.stringify(isolatedFailures)).not.toContain('/secret/path');
    const summary = recovery.getLastReconcileSummary();
    expect(summary.isolatedFailureCount).toBe(1);
    expect(summary.isolatedFailures).toEqual(isolatedFailures);

    // Over-depth connected-run quarantine preserves an opaque tombstone so presence is
    // `unreadable-refused` instead of `absent`.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let depth = 0; depth < 140; depth += 1) deep = { child: deep };
    const frozen = deepFreezeConnectedRunsDocument({ 'run-over-depth': deep });
    expect(frozen.quarantinedCount).toBe(1);
    expect(
      Object.hasOwn(frozen.value as Record<string, unknown>, 'run-over-depth')
    ).toBe(true);
  });
});
