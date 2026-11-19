import { describe, expect, it, vi } from 'vitest';

import { pauseQueuesAtLifecycleBoundary } from '../../src/activation/queue-lifecycle-boundary';
import { createStage2Producers } from '../../src/activation/stage2-producers';
import { closeStage2Resources } from '../../src/activation/stage2-teardown';
import { reconcileComposableWorkflowRuns } from '../../src/activation/run-safety-wiring';
import { runResumeQueue } from '../../src/commands/queue-ops';
import { resumePausedQueueExecution } from '../../src/commands/resume-queue-execution';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { launchComposableWorkflowRun } from '../../src/headless/workflow-run-api';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { ScheduledStartCoordinator } from '../../src/services/scheduled-start-coordinator';
import { UnattendedAdmission } from '../../src/services/unattended-admission';
import { unfencedCommit } from '../../src/state/ownership-claim';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import { CMD_RESUME_QUEUE, type CommandAckMessage } from '../../src/ui/sidebar/messages';

class SharedMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const FIXED_NOW = 1_770_000_000_000;

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-int-1',
    featureId: 'feat-1',
    featureDir: 'specs/233-auto-drain-teardown-close',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: FIXED_NOW - 10_000,
    lastTransitionAt: FIXED_NOW - 5_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

async function openSession(memento: SharedMemento, options: { now?: number } = {}) {
  const now = options.now ?? FIXED_NOW;
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const logger = new SanitizedLogger();
  const queue = new QueueManager(store, logger);
  const lock = {
    id: 'win-primary',
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'win-primary' })),
    hasPrimacy: vi.fn(async () => true),
    isForeignLockHeld: vi.fn(() => false),
    release: vi.fn(async () => undefined)
  };
  const admittedNew: string[] = [];
  const admittedResume: Array<{ queueId: string; customPrompt?: string }> = [];
  const firedSchedules: string[] = [];

  const auditWriter = {
    append: vi.fn(async () => undefined as never),
    runArchiveMaintenance: vi.fn(async () => 'ran' as const)
  };

  const controllerStub = {
    isDriving: vi.fn(() => false),
    liveRunCount: 0,
    holdsSession: vi.fn(() => false),
    admitNew: vi.fn(async (req: { id: string }) => {
      admittedNew.push(req.id);
      return { completed: Promise.resolve() };
    }),
    admitResume: vi.fn(async (queueId: string, opts?: { customPrompt?: string }) => {
      admittedResume.push({
        queueId,
        ...(opts?.customPrompt !== undefined ? { customPrompt: opts.customPrompt } : {})
      });
      return { resumed: true, completed: Promise.resolve() };
    }),
    resumeExistingFromActivation: vi.fn(async () => {
      // Simulate RetryCoordinator scanning persisted pendingRetryAt deadlines.
      for (const [qId, run] of Object.entries(store.getRunMap())) {
        if (run.status === 'paused' && run.pendingRetryAt !== null && run.pendingRetryAt <= now) {
          await unattendedAdmission.admit({
            cause: 'backoff-elapsed',
            queueId: qId,
            deadline: run.pendingRetryAt
          });
        }
      }
    }),
    scheduleAutoDrain: vi.fn(() => {
      void drainCoordinator.drainAll();
    }),
    drainQueuedWork: vi.fn(async (queueId: string) => {
      await drainCoordinator.drainIfIdle(queueId);
    }),
    admitUnattended: vi.fn(async (queueId: string) => {
      admittedResume.push({ queueId });
      return 'admitted' as const;
    })
  };

  const drainCoordinator = new AutoDrainCoordinator({
    store,
    queue,
    controller: controllerStub as never,
    executionLease: {
      tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'win-primary' })),
      release: vi.fn(async () => undefined),
      hasLease: vi.fn(async () => true),
      claimFor: () => null
    },
    failurePolicyDefault: { resolve: () => 'halt-on-failure' },
    logger
  });

  const scheduledStartCoordinator = new ScheduledStartCoordinator({
    store,
    auditWriter,
    logger,
    onFire: async (queueId) => {
      firedSchedules.push(queueId);
      await controllerStub.drainQueuedWork(queueId);
    },
    now: () => now
  });
  queue.setScheduledStartCancelHook({
    cancel: (queueId, reason) => scheduledStartCoordinator.cancel(queueId, reason)
  });

  const guardedRunService = new GuardedRunService({
    store,
    queue,
    controller: { getCatalog: () => ({ pipelinesById: new Map(), phasesById: new Map(), workflowsById: new Map() } as never) },
    lock: lock as never,
    audit: auditWriter as never,
    logger,
    scheduledStartCoordinator,
    isWorkspaceTrusted: () => true,
    clock: () => now
  });

  const unattendedAdmission = new UnattendedAdmission({
    lock,
    store,
    admit: (queueId) => controllerStub.admitUnattended(queueId),
    clock: () => now,
    pollIntervalMs: () => 30 * 60 * 1000,
    pollNow: vi.fn(),
    logger
  });

  const watchdog = {
    reattachOnActivation: vi.fn(async () => {
      // Simulate CreditWatchdog checking persisted creditPause records on activation.
      const hasCreditPaused = Object.values(store.getRunMap()).some(
        (run) => run.status === 'paused' && run.creditPause !== null
      );
      if (hasCreditPaused) {
        await unattendedAdmission.creditsRestored(now);
      }
    })
  };

  const pauseBoundary = () =>
    pauseQueuesAtLifecycleBoundary({
      store,
      queue,
      lock,
      scheduledStartCoordinator,
      logger,
      now: () => now
    });

  const producers = createStage2Producers({
    isWorkspaceTrusted: () => true,
    logger,
    store,
    auditWriter: auditWriter as never,
    lock: lock as never,
    controller: controllerStub as never,
    watchdog,
    scheduledStartCoordinator,
    replayEvidenceBacklog: vi.fn(async () => undefined),
    runSafety: {
      replayTerminalTransitions: vi.fn(async (_ownerId, beforeComposableRecovery) => {
        await beforeComposableRecovery?.();
        await reconcileComposableWorkflowRuns({
          workspaceRoot: '/tmp/schegent-bug001-test',
          store,
          logger,
          getGuardedRun: () => ({
            scheduleOrEnqueue: vi.fn(async () => {
              admittedNew.push('composable-dispatch');
              return { outcome: 'enqueued' as const, queueItemId: 'wf-req' };
            })
          }) as never
        });
      }),
      sweepCheckpointRetention: vi.fn(async () => undefined)
    },
    backendCapabilities: { scan: vi.fn(async () => undefined) },
    startMountProbe: vi.fn(),
    refreshCatalog: vi.fn(async () => undefined),
    operatorAttribution: { ensureStored: vi.fn(async () => 'op-1') },
    pauseQueuesOnStartup: pauseBoundary
  });

  const router = new MessageRouter({
    executeCommand: vi.fn(async () => undefined as never),
    queueOps: queue,
    isPrimary: () => lock.hasPrimacy(),
    isTrusted: () => true,
    logger,
    audit: auditWriter as never,
    onQueueResumed: async (queueId, prompt) => {
      await resumePausedQueueExecution(
        queueId ?? store.getDefaultQueueId(),
        { store, guardedRunService, controller: controllerStub as never, logger },
        prompt
      );
    }
  });

  return {
    store,
    queue,
    lock,
    logger,
    drainCoordinator,
    scheduledStartCoordinator,
    guardedRunService,
    unattendedAdmission,
    controllerStub,
    producers,
    router,
    pauseBoundary,
    admittedNew,
    admittedResume,
    firedSchedules
  };
}

describe('BUG-001 (SC-007, SC-008, SC-009) — pause on close, zero auto-run on reopen, one-click Resume', () => {
  it('1. clean close pauses active/scheduled queues and reopening executes zero tasks, schedules, or Runs', async () => {
    const memento = new SharedMemento();
    const s1 = await openSession(memento);

    // Queue 1 (default): running with an in-flight Run and a pending task behind it.
    const t1 = await s1.queue.enqueue('in-flight task');
    const t2 = await s1.queue.enqueue('pending behind task');
    await s1.queue.admitRun(t1.id, makeRun({ id: 'run-q1', featureId: t1.id, status: 'running' }));

    // Queue 2: idle-pending with an armed scheduled start.
    const created = await s1.queue.createQueue('Scheduled');
    const q2 = created.queueId!;
    await s1.queue.enqueue('scheduled task', { queueId: q2 });
    await s1.guardedRunService.applyStartQueueIntent(
      { startMode: 'scheduled', scheduledStartAt: FIXED_NOW + 60_000, source: 'operator-restart' },
      { queueId: q2 }
    );

    // Clean Stage 2 teardown (closeAutoDrain -> closeStage2Resources with teardown + pauseQueues).
    s1.drainCoordinator.close();
    const order: string[] = [];
    await closeStage2Resources({
      sync: [],
      disposables: [
        {
          dispose: () => {
            order.push('disposables');
            s1.scheduledStartCoordinator.dispose();
          }
        }
      ],
      transport: {
        flushAndDispose: async () => {
          order.push('transport');
        }
      },
      teardown: async () => {
        order.push('teardown');
      },
      pauseQueues: async () => {
        order.push('pauseQueues');
        await s1.pauseBoundary();
      }
    });
    expect(order).toEqual(['teardown', 'pauseQueues', 'disposables', 'transport']);

    // Verify persisted state after clean close.
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBe('extension-closed');
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBeNull();
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === t1.id)?.status).toBe('paused');
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === t2.id)?.status).toBe('pending');
    expect(s1.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('paused');
    expect(s1.store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBe('queue-paused-mid-run');

    expect(s1.store.getQueue(q2).queueLifecycle).toBe('operator-paused');
    expect(s1.store.getQueue(q2).scheduledStartAt).toBeNull();

    // Reopen session after the scheduled time has elapsed.
    const s2 = await openSession(memento, { now: FIXED_NOW + 120_000 });
    await s2.producers.run();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(s2.admittedNew).toEqual([]);
    expect(s2.admittedResume).toEqual([]);
    expect(s2.firedSchedules).toEqual([]);
    expect(s2.controllerStub.scheduleAutoDrain).not.toHaveBeenCalled();
  });

  it('2. simulated crash (skipping dispose) leaves 0 auto-runs across all 6 paths on reopen', async () => {
    const memento = new SharedMemento();
    const s1 = await openSession(memento);

    // Default queue: crashed mid-run (status: 'running', in-flight task, pending task behind).
    const t1 = await s1.queue.enqueue('crashed run task');
    await s1.queue.enqueue('pending behind crash');
    await s1.queue.admitRun(t1.id, makeRun({ id: 'run-crashed', featureId: t1.id, status: 'running' }));

    // Queue 2: crashed with elapsed scheduledStartAt.
    const q2 = (await s1.queue.createQueue('ElapsedSchedule')).queueId!;
    await s1.queue.enqueue('scheduled task', { queueId: q2 });
    await s1.store.updateQueue(
      (q) => ({
        queue: {
          ...q,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: FIXED_NOW - 5_000,
          scheduledStartSource: 'operator-restart'
        },
        result: undefined
      }),
      q2,
      unfencedCommit('test-fixture')
    );

    // Queue 3: crashed with elapsed delayed retry.
    const q3 = (await s1.queue.createQueue('ElapsedRetry')).queueId!;
    const t3 = await s1.queue.enqueue('retry task', { queueId: q3 });
    await s1.store.setRun(
      q3,
      makeRun({
        id: 'run-retry-crash',
        featureId: t3.id,
        status: 'paused',
        pendingRetryAt: FIXED_NOW - 1_000,
        pendingRetryCause: 'rate_limit'
      }),
      unfencedCommit('test-fixture')
    );
    await s1.queue.markInFlight(t3.id, 'run-retry-crash');

    // Queue 4: crashed with open credit-watchdog window.
    const q4 = (await s1.queue.createQueue('CreditPaused')).queueId!;
    const t4 = await s1.queue.enqueue('credit task', { queueId: q4 });
    await s1.store.setRun(
      q4,
      makeRun({
        id: 'run-credit-crash',
        featureId: t4.id,
        status: 'paused',
        creditPause: { pausedAt: FIXED_NOW - 10_000, windowStartedAt: FIXED_NOW - 9_000, stoppedAt: null }
      }),
      unfencedCommit('test-fixture')
    );
    await s1.queue.markInFlight(t4.id, 'run-credit-crash');

    // Queue 5: crashed composable workflow whose node n1 completed and whose auto-handoff to n2
    // would dispatch on restart if the queue were not paused.
    const q5 = (await s1.queue.createQueue('ComposableCrash')).queueId!;
    const phase1: PhaseDefinition = {
      phaseId: 'phase-a',
      version: 1,
      name: 'Phase A',
      instruction: 'Run step A',
      runner: 'claude'
    };
    const phase2: PhaseDefinition = {
      phaseId: 'phase-b',
      version: 1,
      name: 'Phase B',
      instruction: 'Run step B',
      runner: 'claude'
    };
    const wfDef: WorkflowDefinition = {
      workflowId: 'wf-crash-handoff',
      version: 1,
      name: 'Crash Handoff Workflow',
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-b' }
      ],
      connections: [
        { from: { nodeId: 'n1' }, to: { nodeId: 'n2' }, handoff: 'auto', priority: 0 },
        { from: { nodeId: 'n2' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
      ]
    };
    const wfTask1 = await s1.queue.enqueue('wf node 1 task', { queueId: q5 });
    await s1.store.setRun(
      q5,
      makeRun({ id: 'run-wf-n1', featureId: wfTask1.id, status: 'completed' }),
      unfencedCommit('test-fixture')
    );
    await s1.queue.markInFlight(wfTask1.id, 'run-wf-n1');
    await s1.queue.finish(wfTask1.id, 'completed');
    // Keep q5 active with a pending sibling so startup pause pauses q5 too.
    await s1.queue.enqueue('wf trailing task', { queueId: q5 });
    const wfLaunch = await launchComposableWorkflowRun(
      {
        connectedRuns: {
          compareAndSetConnectedRun: (next, rev) => s1.store.compareAndSetConnectedRun(next, rev)
        },
        isChildSettled: () => true,
        guardedRun: {
          scheduleOrEnqueue: async () => ({
            outcome: 'enqueued' as const,
            queueItemId: wfTask1.id
          })
        } as never,
        logger: s1.logger
      },
      {
        connectedRunId: 'cwf-crash-1',
        queueId: q5,
        request: {
          pipelineId: 'wf-crash-handoff',
          workflowId: 'wf-crash-handoff',
          entryNodeId: 'n1',
          inputs: [],
          supplemental: [],
          outputs: []
        },
        workflowSource: { rootWorkflow: wfDef, workflows: [wfDef], phases: [phase1, phase2] },
        workspaceRoot: '/tmp/schegent-bug001-test',
        startedAt: FIXED_NOW - 5_000
      }
    );
    expect(wfLaunch.outcome).toBe('started');

    // Crash: NO dispose() called! Open fresh session directly against persisted memento.
    const s2 = await openSession(memento, { now: FIXED_NOW + 30_000 });
    await s2.producers.run();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // All five queues are now paused and ZERO work started unattended.
    for (const qId of [DEFAULT_QUEUE_ID, q2, q3, q4, q5]) {
      expect(s2.store.getQueue(qId).queueLifecycle).toBe('operator-paused');
      expect(s2.store.getQueue(qId).scheduledStartAt).toBeNull();
    }
    expect(s2.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('paused');
    expect(s2.store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBe('queue-paused-mid-run');
    expect(s2.store.getRun(q3)?.pendingRetryAt).toBeNull();
    expect(s2.store.getRun(q4)?.creditPause).toBeNull();

    expect(s2.admittedNew).toEqual([]);
    expect(s2.admittedResume).toEqual([]);
    expect(s2.firedSchedules).toEqual([]);
    expect(s2.controllerStub.scheduleAutoDrain).not.toHaveBeenCalled();

    // Even if an unattended wakeup arrives later while still paused, it is refused.
    const lateWakeup = await s2.unattendedAdmission.admit({
      cause: 'credits-restored',
      queueId: q4,
      evidenceAt: FIXED_NOW + 30_000
    });
    expect(lateWakeup).toBe('ineligible');
    expect(s2.admittedResume).toEqual([]);
  });

  it('3. one-click manual Resume via CMD_RESUME_QUEUE resumes paused Run and via schegent.resumeQueue drains pending queue', async () => {
    const memento = new SharedMemento();
    const s1 = await openSession(memento);

    // Default queue: pending-only task paused on close.
    const pendingTask = await s1.queue.enqueue('pending task for palette resume');
    // Second queue: paused mid-run with a pending task behind it.
    const q2 = (await s1.queue.createQueue('MidRun')).queueId!;
    const activeTask = await s1.queue.enqueue('paused run task', { queueId: q2 });
    await s1.queue.enqueue('behind active task', { queueId: q2 });
    await s1.queue.admitRun(activeTask.id, makeRun({ id: 'run-q2', featureId: activeTask.id, status: 'running' }));

    await s1.pauseBoundary();

    // Reopen session.
    const s2 = await openSession(memento);
    await s2.producers.run();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(s2.admittedNew).toEqual([]);
    expect(s2.admittedResume).toEqual([]);

    // One-click sidebar CMD_RESUME_QUEUE on q2 -> unpauses, exits idle-pending, calls admitResume.
    const acks: CommandAckMessage[] = [];
    await s2.router.dispatch(
      { type: CMD_RESUME_QUEUE, payload: { queueId: q2 }, correlationId: 'r-q2' },
      (ack) => {
        acks.push(ack);
        return Promise.resolve(true);
      }
    );
    expect(acks[0]?.status).toBe('accepted');
    expect(s2.store.getQueue(q2).queueLifecycle).toBe('running');
    expect(s2.admittedResume).toEqual([{ queueId: q2, customPrompt: undefined }]);

    // One-click palette schegent.resumeQueue on default queue -> unpauses, exits idle-pending, drains pending head.
    await runResumeQueue({
      queue: s2.queue,
      lock: s2.lock as never,
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      logger: s2.logger,
      onQueueResumed: async (queueId) => {
        await resumePausedQueueExecution(queueId, {
          store: s2.store,
          guardedRunService: s2.guardedRunService,
          controller: s2.controllerStub as never,
          logger: s2.logger
        });
      }
    });
    expect(s2.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');
    expect(s2.admittedNew).toEqual([pendingTask.id]);
  });
});
