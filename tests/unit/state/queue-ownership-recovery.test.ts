import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DELETED_HISTORY_PARTITIONS,
  MEMENTO_WRITE_DEADLINE_MS,
  StorageWriteQuarantinedError,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import { classifyEnqueueFailure } from '../../../src/services/enqueue-failure';
import { forwardMigrationAuditEvents } from '../../../src/state/migration-audit-forwarder';
import { createStage2Producers } from '../../../src/activation/stage2-producers';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { WorkflowRun } from '../../../src/state/workflow-run';

class FakeMemento implements Memento {
  readonly data = new Map<string, unknown>();
  hangKey: string | null = null;
  failOnKeyOnce: string | null = null;
  /** Review gap GC-04 — a hung write held here can be settled late, landed or failed. */
  private readonly held: Array<(outcome: 'land' | 'fail') => void> = [];

  settleHeld(outcome: 'land' | 'fail'): void {
    this.held.shift()?.(outcome);
  }

  get<T>(key: string): T | undefined {
    if (!this.data.has(key)) return undefined;
    return structuredClone(this.data.get(key)) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.hangKey === key) {
      // Never settles on its own; `settleHeld` is the only way out.
      return new Promise<void>((resolve, reject) => {
        this.held.push((outcome) => {
          if (outcome === 'fail') {
            reject(new Error(`late failure on ${key}`));
            return;
          }
          this.data.set(key, structuredClone(value));
          resolve();
        });
      });
    }
    if (this.failOnKeyOnce === key) {
      this.failOnKeyOnce = null;
      throw new Error(`simulated crash on ${key}`);
    }
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, structuredClone(value));
    }
  }
}

function makeTerminalRun(id: string, status: 'completed' | 'failed' | 'canceled' = 'completed'): WorkflowRun {
  return {
    id,
    featureId: `feat-${id}`,
    featureDir: '',
    status,
    currentPhase: 'done',
    currentIteration: 1,
    startedAt: 1_000,
    lastTransitionAt: 2_000,
    phasesCompleted: [],
    lastError: null,
    rawTranscriptMode: 'errors-only',
    pipeline: {
      id: 'pipe-1',
      name: 'Pipeline 1',
      phases: [{ id: 'done', name: 'Done', version: 1, instruction: 'noop' }]
    },
    defaultRunnerKind: 'claude',
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

describe('FR-R5-F09 — Queue ownership, serialized registry/cross-queue mutations, and recovery lifecycle', () => {
  describe('1. Queue registry serialization and fence/primacy verification', () => {
    it('serializes concurrent createQueue, renameQueue, and fireDueSchedules without clobbering entries', async () => {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const qm = new QueueManager(store, new SanitizedLogger());

      const [c1, c2] = await Promise.all([
        qm.createQueue('Alpha'),
        qm.createQueue('Beta')
      ]);
      expect(c1.ok).toBe(true);
      expect(c2.ok).toBe(true);
      if (!c1.ok || !c2.ok || !c1.queueId || !c2.queueId) {
        throw new Error('expected both queues to be created');
      }

      await store.updateQueueRegistry((reg) => ({
        registry: {
          ...reg,
          entries: reg.entries.map((entry) =>
            entry.id === c1.queueId
              ? {
                  ...entry,
                  schedule: {
                    kind: 'relative',
                    expression: 'in 1m',
                    targetAt: new Date(1_000).toISOString(),
                    setAt: new Date(500).toISOString(),
                    recurrence: 'one-shot'
                  }
                }
              : entry
          )
        },
        result: undefined
      }));

      const [renamed, fired] = await Promise.all([
        qm.renameQueue(c2.queueId, 'Beta Renamed'),
        qm.fireDueSchedules(2_000)
      ]);
      expect(renamed.ok).toBe(true);
      expect(fired).toEqual([c1.queueId]);

      const entries = store.getQueueRegistry().entries;
      expect(entries.find((e) => e.id === c2.queueId)?.name).toBe('Beta Renamed');
      expect(entries.find((e) => e.id === c1.queueId)?.schedule).toBeNull();
    });

    it('rejects updateQueueRegistry, createQueue, renameQueue, and fireDueSchedules when primacy is lost', async () => {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      let isPrimary = true;
      store.bindPrimacyClaimSource({
        canCommitConnectedRun: async () => isPrimary
      });
      const qm = new QueueManager(store, new SanitizedLogger());
      const created = await qm.createQueue('Alpha');
      expect(created.ok).toBe(true);
      if (!created.ok || !created.queueId) throw new Error('expected Alpha queue');

      isPrimary = false;

      await expect(
        store.updateQueueRegistry((reg) => ({
          registry: { ...reg, updatedAt: reg.updatedAt + 1 },
          result: undefined
        }))
      ).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'ownership-lost'
      });

      const createRejected = await qm.createQueue('Blocked');
      expect(createRejected).toMatchObject({ ok: false, reason: 'ownership-lost' });

      const renameRejected = await qm.renameQueue(created.queueId, 'Blocked Rename');
      expect(renameRejected).toMatchObject({ ok: false, reason: 'ownership-lost' });

      await expect(qm.fireDueSchedules(9_999_999)).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'ownership-lost'
      });
    });
  });

  describe('2. Cross-queue movePendingRequest serialization and dual-queue ownership checks', () => {
    it('re-reads fresh queue state inside serialize(KEYS.queue) and enforces ownership on both queues', async () => {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const qm = new QueueManager(store, new SanitizedLogger());
      const target = await qm.createQueue('Target');
      expect(target.ok).toBe(true);
      if (!target.ok || !target.queueId) throw new Error('expected Target queue');

      const reqA = await qm.enqueue('Task A');
      const reqB = await qm.enqueue('Task B');

      const [moveA, moveB] = await Promise.all([
        store.movePendingRequest(reqA.id, { targetQueueId: target.queueId, position: 0 }),
        store.movePendingRequest(reqB.id, { targetQueueId: target.queueId, position: null })
      ]);
      expect(moveA.id).toBe(reqA.id);
      expect(moveB.id).toBe(reqB.id);
      expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(0);
      expect(store.getQueue(target.queueId).requests.map((r) => r.id).sort()).toEqual(
        [reqA.id, reqB.id].sort()
      );

      // Revoke ownership of the target queue and verify movePendingRequest refuses.
      store.bindRunClaimSource({
        claimFor: () => null,
        tenureOf: (qId) =>
          qId === target.queueId
            ? {
                state: 'lost',
                claim: { resource: `queue:${qId}`, ownerId: 'win-1', fence: 1 },
                reason: 'superseded',
                lostAt: 1_000
              }
            : { state: 'never-held' }
      });
      const reqC = await qm.enqueue('Task C');
      await expect(
        store.movePendingRequest(reqC.id, { targetQueueId: target.queueId, position: 0 })
      ).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'ownership-lost'
      });
    });
  });

  describe('3. Queue deletion atomicity, reload reconciliation, and history partition bounding', () => {
    it('verifies primacy and queue ownership in deleteQueueIfNoLiveRun', async () => {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const qm = new QueueManager(store, new SanitizedLogger());
      const created = await qm.createQueue('Disposable');
      expect(created.ok).toBe(true);
      if (!created.ok || !created.queueId) throw new Error('expected Disposable queue');

      store.bindRunClaimSource({
        claimFor: () => null,
        tenureOf: (qId) =>
          qId === created.queueId
            ? {
                state: 'lost',
                claim: { resource: `queue:${qId}`, ownerId: 'win-1', fence: 1 },
                reason: 'superseded',
                lostAt: 1_000
              }
            : { state: 'never-held' }
      });

      await expect(
        store.deleteQueueIfNoLiveRun(
          created.queueId,
          () => ({
            outcome: 'deletable',
            queueId: created.queueId!,
            pendingTaskCount: 0,
            boundConnectedRunIds: []
          }),
          Date.now()
        )
      ).rejects.toMatchObject({
        name: 'QueueMutationRejected',
        reason: 'ownership-lost'
      });
    });

    it('reconciles orphaned KEYS.queue and terminal KEYS.run on reload after queue deletion or mid-delete crash', async () => {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const qm = new QueueManager(store, new SanitizedLogger());
      const created = await qm.createQueue('ToDelete');
      expect(created.ok).toBe(true);
      if (!created.ok || !created.queueId) throw new Error('expected ToDelete queue');
      const targetId = created.queueId;

      await store.setRun(targetId, makeTerminalRun('run-terminal'), unfencedCommit('test-fixture'));

      // Simulate a crash after KEYS.queueRegistry updated but before KEYS.queue updated.
      memento.failOnKeyOnce = 'schegent.queue';
      const crashDeleteResult = await qm.deleteQueue(targetId);
      expect(crashDeleteResult.ok).toBe(false);

      // Registry on disk already removed targetId, while KEYS.queue and KEYS.run still have targetId.
      const reloaded = new WorkspaceStateStore(memento);
      await reloaded.initialize();

      expect(reloaded.getQueueRegistry().entries.some((e) => e.id === targetId)).toBe(false);
      expect(reloaded.getRun(targetId)).toBeNull();
      const persistedQueues = memento.get<Record<string, unknown>>('schegent.queue') ?? {};
      expect(persistedQueues[targetId]).toBeUndefined();
    });

    it('bounds deleted-queue history partitions at MAX_DELETED_HISTORY_PARTITIONS', async () => {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      // Persist an explicit registry so reload sees hadPersistedRegistry === true.
      await store.updateQueueRegistry((reg) => ({
        registry: { ...reg, updatedAt: reg.updatedAt + 1 },
        result: undefined
      }));

      // Seed 25 deleted queue partitions in KEYS.history and reload.
      const historyMap: Record<string, Array<{
        runId: string;
        featureId: string;
        status: 'completed';
        startedAt: number;
        completedAt: number;
        durationMs: number;
        phasesCompletedCount: number;
        totalPhases: number;
      }>> = {};
      for (let i = 1; i <= 25; i += 1) {
        historyMap[`deleted-q-${i}`] = [
          {
            runId: `run-${i}`,
            featureId: `feat-${i}`,
            status: 'completed',
            startedAt: i * 100,
            completedAt: i * 100 + 50,
            durationMs: 50,
            phasesCompletedCount: 1,
            totalPhases: 1
          }
        ];
      }
      await memento.update('schegent.history', historyMap);

      const reloaded = new WorkspaceStateStore(memento);
      await reloaded.initialize();

      const survivingPartitions = Object.keys(
        memento.get<Record<string, unknown>>('schegent.history') ?? {}
      ).filter((id) => id !== DEFAULT_QUEUE_ID);

      expect(survivingPartitions).toHaveLength(MAX_DELETED_HISTORY_PARTITIONS);
      // Oldest 5 (deleted-q-1 .. deleted-q-5) were evicted; newest 20 remain.
      expect(survivingPartitions).not.toContain('deleted-q-1');
      expect(survivingPartitions).not.toContain('deleted-q-5');
      expect(survivingPartitions).toContain('deleted-q-6');
      expect(survivingPartitions).toContain('deleted-q-25');
    });
  });

  describe('4. Stage-2 primacy re-election re-runs recovery hooks and cancels pending watchdog timers', () => {
    it('resets installedRecovery and calls watchdog.cancelPendingTimer on onFenceLost', async () => {
      let fenceLostListener: (() => void) | undefined;
      const reArm = vi.fn().mockResolvedValue(undefined);
      const reattachOnActivation = vi.fn().mockResolvedValue(undefined);
      const resumeExistingFromActivation = vi.fn().mockResolvedValue(undefined);
      const scheduleAutoDrain = vi.fn();
      const cancelPendingTimer = vi.fn();

      const producers = createStage2Producers({
        isWorkspaceTrusted: () => true,
        logger: new SanitizedLogger(),
        store: {
          getRunMap: () => ({})
        } as never,
        auditWriter: {
          runArchiveMaintenance: vi.fn().mockResolvedValue(undefined),
          append: vi.fn().mockResolvedValue(undefined)
        } as never,
        lock: {
          id: 'win-1',
          tryAcquire: vi.fn().mockResolvedValue({ acquired: true, ownerId: 'win-1' }),
          onFenceLost: (cb: () => void) => {
            fenceLostListener = cb;
            return { dispose: () => {} };
          }
        } as never,
        controller: {
          resumeExistingFromActivation,
          admitResume: vi.fn(),
          scheduleAutoDrain
        } as never,
        watchdog: {
          reattachOnActivation,
          cancelPendingTimer
        },
        scheduledStartCoordinator: {
          reArm
        },
        replayEvidenceBacklog: vi.fn().mockResolvedValue(undefined),
        runSafety: {
          replayTerminalTransitions: vi.fn().mockResolvedValue(undefined),
          sweepCheckpointRetention: vi.fn().mockResolvedValue(undefined),
          reconcileComposableWorkflowRuns: vi.fn().mockResolvedValue(undefined)
        },
        backendCapabilities: {
          scan: vi.fn().mockResolvedValue(undefined)
        },
        startMountProbe: vi.fn(),
        refreshCatalog: vi.fn().mockResolvedValue(undefined),
        operatorAttribution: {
          ensureStored: vi.fn().mockResolvedValue(undefined)
        }
      });

      // Tenure 1: recovery hooks run once; a second installRecovery in the same tenure is a no-op.
      await producers.run();
      await producers.installRecovery({ acquired: true, ownerId: 'win-1' });
      expect(reArm).toHaveBeenCalledTimes(1);
      expect(reattachOnActivation).toHaveBeenCalledTimes(1);
      expect(resumeExistingFromActivation).toHaveBeenCalledTimes(1);
      expect(scheduleAutoDrain).toHaveBeenCalledTimes(1);

      // Lose primacy fence: watchdog timer is canceled and recovery latch resets.
      expect(fenceLostListener).toBeDefined();
      fenceLostListener!();
      expect(cancelPendingTimer).toHaveBeenCalledTimes(1);

      // Tenure 2: recovery hooks run again on re-election.
      await producers.installRecovery({ acquired: true, ownerId: 'win-1' });
      expect(reArm).toHaveBeenCalledTimes(2);
      expect(reattachOnActivation).toHaveBeenCalledTimes(2);
      expect(resumeExistingFromActivation).toHaveBeenCalledTimes(2);
      expect(scheduleAutoDrain).toHaveBeenCalledTimes(2);
    });
  });

  describe('5. Migration audit forwarding for v10 and v13', () => {
    it('forwards v10MigrationEvents and v13MigrationEvents through forwardMigrationAuditEvents', async () => {
      const append = vi.fn().mockResolvedValue(undefined);
      await forwardMigrationAuditEvents(
        {
          v6MigrationEvents: [],
          v7MigrationEvents: [],
          v10MigrationEvents: [
            {
              type: 'state-migrated-v9-to-v10',
              fromVersion: 9,
              toVersion: 10,
              occurredAt: 1_000,
              queueIds: ['default'],
              pendingTaskCount: 2,
              inFlightTaskCount: 0
            }
          ],
          v11MigrationEvents: [],
          v12MigrationEvents: [],
          v13MigrationEvents: [
            {
              type: 'state-migrated-v12-to-v13',
              fromVersion: 12,
              toVersion: 13,
              occurredAt: 2_000,
              queueIds: ['default'],
              pausedQueueCount: 1,
              divergentQueueCount: 1
            },
            {
              type: 'queue-pause-divergence-resolved',
              occurredAt: 2_000,
              queueId: 'default',
              registryPaused: true,
              lifecyclePaused: false,
              mirrorPaused: false,
              resolvedPaused: true,
              resolvedPauseSource: 'operator',
              reason: 'any-representation-paused-wins'
            }
          ],
          runRepairEvents: []
        },
        { append },
        new SanitizedLogger()
      );

      expect(append).toHaveBeenCalledTimes(3);
      expect(append.mock.calls.map((c) => c[0].eventType)).toEqual([
        'state-migrated-v9-to-v10',
        'state-migrated-v12-to-v13',
        'queue-pause-divergence-resolved'
      ]);
    });
  });

  describe('6. Bounded Memento write deadline and writer quarantine', () => {
    it('rejects hung memento.update at MEMENTO_WRITE_DEADLINE_MS, suppresses notify, and quarantines subsequent writes', async () => {
      vi.useFakeTimers();
      try {
        const memento = new FakeMemento();
        const store = new WorkspaceStateStore(memento);
        await store.initialize();

        const qm = new QueueManager(store, new SanitizedLogger());
        const listener = vi.fn();
        store.subscribe(listener);

        memento.hangKey = 'schegent.queue';
        const enqueuePromise = qm.enqueue('Will hang on persistence');
        const rejectionAssertion = expect(enqueuePromise).rejects.toMatchObject({
          name: 'StorageWriteQuarantinedError',
          reason: 'storage-write-timeout'
        });

        await vi.advanceTimersByTimeAsync(MEMENTO_WRITE_DEADLINE_MS + 10);
        await rejectionAssertion;

        expect(store.isWriterQuarantined()).toBe(true);
        expect(listener).not.toHaveBeenCalled();
        expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(0);

        // Subsequent writes fail fast with storage-write-quarantined without waiting for deadline.
        memento.hangKey = null;
        await expect(qm.enqueue('Second write')).rejects.toMatchObject({
          name: 'StorageWriteQuarantinedError',
          reason: 'storage-write-quarantined'
        });

        // classifyEnqueueFailure maps StorageWriteQuarantinedError to failed-storage.
        const classified = classifyEnqueueFailure(
          new StorageWriteQuarantinedError('storage-write-quarantined', 'schegent.queue')
        );
        expect(classified.outcome).toBe('failed-storage');
      } finally {
        vi.useRealTimers();
      }
    });

    // Review gap GC-04 (2026-11-12) — the quarantine used to hold until a destructive reset, even
    // after the write that caused it had long since finished. It now ends when that write settles.
    async function quarantineOneWrite(): Promise<{ memento: FakeMemento; store: WorkspaceStateStore; qm: QueueManager }> {
      const memento = new FakeMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const qm = new QueueManager(store, new SanitizedLogger());
      memento.hangKey = 'schegent.queue';
      const hung = expect(qm.enqueue('Will hang on persistence')).rejects.toMatchObject({
        reason: 'storage-write-timeout'
      });
      await vi.advanceTimersByTimeAsync(MEMENTO_WRITE_DEADLINE_MS + 10);
      await hung;
      memento.hangKey = null;
      return { memento, store, qm };
    }

    it.each(['land', 'fail'] as const)(
      'lifts the quarantine once the timed-out write settles late (%s)',
      async (outcome) => {
        vi.useFakeTimers();
        try {
          const { memento, store, qm } = await quarantineOneWrite();
          expect(store.isWriterQuarantined()).toBe(true);

          memento.settleHeld(outcome);
          await vi.advanceTimersByTimeAsync(0);

          expect(store.isWriterQuarantined()).toBe(false);
          await qm.enqueue('Writes again');
          expect(store.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.description)).toContain('Writes again');
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it('a late settle from an earlier quarantine does not lift a newer one', async () => {
      vi.useFakeTimers();
      try {
        const { memento, store, qm } = await quarantineOneWrite();
        await store.reset();
        memento.hangKey = 'schegent.queue';
        const second = expect(qm.enqueue('Hangs too')).rejects.toMatchObject({
          reason: 'storage-write-timeout'
        });
        await vi.advanceTimersByTimeAsync(MEMENTO_WRITE_DEADLINE_MS + 10);
        await second;

        memento.settleHeld('land');
        await vi.advanceTimersByTimeAsync(0);

        expect(store.isWriterQuarantined()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
