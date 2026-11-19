import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { pauseQueuesAtLifecycleBoundary } from '../../src/activation/queue-lifecycle-boundary';
import {
  reconcileComposableWorkflowRuns,
  recordConnectedWorkflowTransition
} from '../../src/activation/run-safety-wiring';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { runResumePhase } from '../../src/commands/phase-control-commands';
import { resumePausedQueueExecution } from '../../src/commands/resume-queue-execution';
import type { PipelineCatalog } from '../../src/config/pipeline-config';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { launchComposableWorkflowRun } from '../../src/headless/workflow-run-api';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput } from '../../src/runner/invocation-result';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { ScheduledStartCoordinator } from '../../src/services/scheduled-start-coordinator';
import {
  createProductionWorkflowComposition,
  type ProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import {
  attemptsForNode,
  pauseInvocationControlMarkers,
  recordNodeAttempt,
  resolveRootInvocationId,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type WorkflowPauseCause
} from '../../src/state/connected-workflow-run';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { Notifier } from '../../src/ui/notifications';
import type { SchegentStatusBar } from '../../src/ui/status-bar';

class SharedMemento implements Memento {
  private readonly raw = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    const val = this.raw.get(key);
    return val === undefined ? undefined : (structuredClone(val) as T);
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.raw.delete(key);
    else this.raw.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

const PHASE_1: PhaseDefinition = {
  phaseId: 'phase-one',
  name: 'Phase One',
  version: 1,
  runner: 'claude',
  instruction: 'Execute phase one'
};

const PHASE_2: PhaseDefinition = {
  phaseId: 'phase-two',
  name: 'Phase Two',
  version: 1,
  runner: 'claude',
  instruction: 'Execute phase two'
};

const TWO_PHASE_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-two-phase-restart',
  name: 'Two-Phase Restart Workflow',
  version: 1,
  startNodeIds: ['node-1'],
  nodes: [
    { nodeId: 'node-1', kind: 'phase', phaseId: 'phase-one', label: 'Phase One' },
    { nodeId: 'node-2', kind: 'phase', phaseId: 'phase-two', label: 'Phase Two' }
  ],
  connections: [
    { from: { nodeId: 'node-1' }, to: { kind: 'node', nodeId: 'node-2' }, handoff: 'auto', priority: 0 },
    { from: { nodeId: 'node-2' }, to: { kind: 'return', nodeId: '' }, handoff: 'auto', priority: 0 }
  ]
};

function makeCleanStdout(phaseId: string): string {
  return [
    `Completed ${phaseId}.`,
    '```',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phaseId}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: []',
    'ruleset_switches: []',
    'notes: ok',
    '=== END AUDIT LOG ===',
    '```',
    '[SCHEGENT_STATUS: CLEAR]'
  ].join('\n');
}

function makeInvocationResult(phaseId: string, killed = false): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  if (!killed) stdoutBuffer.append(makeCleanStdout(phaseId));
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.finalize();
  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode: killed ? 143 : 0,
    killed,
    timedOut: false,
    durationMs: 1
  };
}

function buildCatalog(): PipelineCatalog {
  return {
    phases: [
      { id: 'phase-one', name: 'Phase One', runner: 'claude', instruction: 'Execute phase one' },
      { id: 'phase-two', name: 'Phase Two', runner: 'claude', instruction: 'Execute phase two' }
    ],
    pipelines: [],
    workflows: [TWO_PHASE_WORKFLOW],
    models: { claude: [], codex: [], agy: [] },
    defaultPipelineId: 'phase-one',
    phasesById: new Map([
      ['phase-one', { id: 'phase-one', name: 'Phase One', runner: 'claude', instruction: 'Execute phase one' }],
      ['phase-two', { id: 'phase-two', name: 'Phase Two', runner: 'claude', instruction: 'Execute phase two' }]
    ]),
    pipelinesById: new Map(),
    workflowsById: new Map([[TWO_PHASE_WORKFLOW.workflowId, TWO_PHASE_WORKFLOW]])
  };
}

function makeLock(): WorkspaceLockManager {
  return {
    id: 'win-primary',
    tryAcquire: vi.fn(async () => ({ acquired: true, owner: null })),
    hasPrimacy: vi.fn(async () => true),
    isForeignLockHeld: vi.fn(() => false),
    isHeld: vi.fn(async () => true),
    heartbeat: vi.fn(),
    ownerOfRecord: vi.fn(),
    release: vi.fn(async () => undefined)
  } as unknown as WorkspaceLockManager;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for expected workflow state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface SessionRig {
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly guardedRunService: GuardedRunService;
  readonly controller: SchegentWorkflowController;
  readonly composition: ProductionWorkflowComposition;
  readonly scheduledStartCoordinator: ScheduledStartCoordinator;
  readonly logger: SanitizedLogger;
  readonly notifier: Notifier;
  readonly lock: WorkspaceLockManager;
  readonly invokedPhases: string[];
  readonly warnMessages: string[];
  readonly launchTwoPhase: (connectedRunId: string) => Promise<void>;
  readonly reconcile: () => Promise<void>;
  readonly drainAllToCompletion: () => Promise<void>;
}

async function openRealSession(
  memento: SharedMemento,
  workspaceRoot: string,
  options: {
    readonly onPhaseInvoke?: (phaseId: string, invocationNum: number) => Promise<RawInvocationOutput>;
  } = {}
): Promise<SessionRig> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const logger = new SanitizedLogger();
  const warnMessages: string[] = [];
  const origWarn = logger.warn.bind(logger);
  logger.warn = (msg: string) => {
    warnMessages.push(msg);
    origWarn(msg);
  };

  const queue = new QueueManager(store, logger);
  const lock = makeLock();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const invokedPhases: string[] = [];
  let invocationCounter = 0;

  const runner = {
    invoke: vi.fn(async (req: { phase: string }) => {
      invocationCounter += 1;
      invokedPhases.push(req.phase);
      if (options.onPhaseInvoke !== undefined) {
        return options.onPhaseInvoke(req.phase, invocationCounter);
      }
      return makeInvocationResult(req.phase);
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  const composition = createProductionWorkflowComposition({ store, workspaceRoot });

  const lateRefs: {
    guardedRun?: GuardedRunService;
    controller?: SchegentWorkflowController;
  } = {};

  const scheduledStartCoordinator = new ScheduledStartCoordinator({
    store,
    auditWriter: audit,
    logger,
    onFire: async (queueId: string) => {
      await lateRefs.controller?.drainQueuedWork(queueId);
    }
  });

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 2_000, skipProbing: true },
    {
      catalog: buildCatalog(),
      onRunTerminal: async (run) => {
        await recordConnectedWorkflowTransition(
          {
            workspaceRoot,
            store,
            logger,
            getGuardedRun: () => lateRefs.guardedRun,
            getDefaultRunnerKind: () => 'claude',
            productionComposition: composition
          },
          run
        );
      }
    }
  );
  lateRefs.controller = controller;

  const guardedRunService = new GuardedRunService({
    isWorkspaceTrusted: () => true,
    lock,
    queue,
    controller,
    logger,
    audit,
    store,
    scheduledStartCoordinator
  });
  lateRefs.guardedRun = guardedRunService;

  const launchTwoPhase = async (connectedRunId: string): Promise<void> => {
    const launched = await launchComposableWorkflowRun(
      {
        connectedRuns: store,
        isChildSettled: () => false,
        guardedRun: guardedRunService,
        productionComposition: composition,
        logger
      },
      {
        connectedRunId,
        queueId: DEFAULT_QUEUE_ID,
        request: {
          pipelineId: TWO_PHASE_WORKFLOW.workflowId,
          workflowId: TWO_PHASE_WORKFLOW.workflowId,
          entryNodeId: 'node-1',
          inputs: [],
          supplemental: [],
          outputs: []
        },
        workflowSource: {
          rootWorkflow: TWO_PHASE_WORKFLOW,
          workflows: [TWO_PHASE_WORKFLOW],
          phases: [PHASE_1, PHASE_2]
        },
        workspaceRoot,
        startedAt: Date.now()
      }
    );
    expect(launched.outcome).toBe('started');
  };

  const reconcile = async (): Promise<void> => {
    await reconcileComposableWorkflowRuns({
      workspaceRoot,
      store,
      logger,
      getGuardedRun: () => guardedRunService,
      getDefaultRunnerKind: () => 'claude',
      productionComposition: composition
    });
  };

  const drainAllToCompletion = async (): Promise<void> => {
    const applied = await guardedRunService.applyStartQueueIntent(
      { startMode: 'now', source: 'operator-restart' },
      { queueId: DEFAULT_QUEUE_ID }
    );
    expect(applied.outcome).toBe('applied');
    await controller.drainQueuedWork(DEFAULT_QUEUE_ID);
    await controller.drainedRunsSettled();
  };

  return {
    store,
    queue,
    guardedRunService,
    controller,
    composition,
    scheduledStartCoordinator,
    logger,
    notifier,
    lock,
    invokedPhases,
    warnMessages,
    launchTwoPhase,
    reconcile,
    drainAllToCompletion
  };
}

function pauseRunWithCause(
  run: ConnectedWorkflowRun,
  cause: WorkflowPauseCause,
  now = 20_000
): ConnectedWorkflowRun {
  const rootId = resolveRootInvocationId(run);
  const frame = run.invocations![rootId]!;
  const attempt = frame.attemptsByNodeId['node-1']![0]!;
  const pausedAttempt = Object.freeze({
    ...attempt,
    status: 'paused' as const,
    completedAt: now
  });
  const pausedFrame = {
    ...recordNodeAttempt(frame, pausedAttempt),
    status: 'paused' as const,
    controlMarkers: pauseInvocationControlMarkers(frame.controlMarkers, now, cause)
  };
  return upsertInvocationFrame(run, pausedFrame);
}

describe('BUG-001 (FR-008, FR-010, FR-011, SC-005, SC-006) — multi-phase Workflow restart recovery & leaf resume', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-wf-restart-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('(a) single 2-phase Workflow queued (pending) survives restart and executes both Phase 1 and Phase 2 to completion (SC-005)', async () => {
    const memento = new SharedMemento();
    const s1 = await openRealSession(memento, tmpRoot);
    await s1.launchTwoPhase('wf-single-pending');

    // Verify Phase 1 is pending in the queue before restart
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests[0]?.status).toBe('pending');
    expect(s1.invokedPhases).toEqual([]);

    // Simulated host restart: fresh session runs startup recovery BEFORE queue drains
    const s2 = await openRealSession(memento, tmpRoot);
    await s2.reconcile();

    const afterReconcile = s2.store.getConnectedRun('wf-single-pending')!;
    const rootAfterReconcile = afterReconcile.invocations![resolveRootInvocationId(afterReconcile)]!;
    expect(rootAfterReconcile.status).toBe('in-flight');
    expect(rootAfterReconcile.controlMarkers?.manualPauseCause ?? null).toBeNull();
    expect(attemptsForNode(rootAfterReconcile, 'node-1').at(0)?.status).toBe('in-flight');

    // Control ledger root must also stay in-flight / pending-dispatch (not paused-uncertain-effect)
    const ledgerRoot = s2.composition.ledgerStore.getRoot(afterReconcile.controlState!.ledgerRunId);
    expect(ledgerRoot?.status).toBe('in-flight');

    // Operator starts queue -> both Phase 1 and Phase 2 execute
    await s2.drainAllToCompletion();
    await waitUntil(() => {
      const latest = s2.store.getConnectedRun('wf-single-pending');
      return latest?.invocations?.[resolveRootInvocationId(latest)]?.status === 'completed';
    });

    expect(s2.invokedPhases).toEqual(['phase-one', 'phase-two']);
    const completedRun = s2.store.getConnectedRun('wf-single-pending')!;
    const rootCompleted = completedRun.invocations![resolveRootInvocationId(completedRun)]!;
    expect(rootCompleted.status).toBe('completed');
    expect(attemptsForNode(rootCompleted, 'node-1').at(0)?.status).toBe('completed');
    expect(attemptsForNode(rootCompleted, 'node-2').at(0)?.status).toBe('completed');
  });

  it('(b) batch of 2 multi-phase Workflows queued (pending) survives restart and executes every phase of both Workflows (SC-005)', async () => {
    const memento = new SharedMemento();
    const s1 = await openRealSession(memento, tmpRoot);
    await s1.launchTwoPhase('wf-batch-1');
    await s1.launchTwoPhase('wf-batch-2');
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(2);

    const s2 = await openRealSession(memento, tmpRoot);
    await s2.reconcile();

    for (const runId of ['wf-batch-1', 'wf-batch-2']) {
      const wf = s2.store.getConnectedRun(runId)!;
      expect(wf.invocations![resolveRootInvocationId(wf)]!.status).toBe('in-flight');
    }

    await s2.drainAllToCompletion();
    await waitUntil(() =>
      ['wf-batch-1', 'wf-batch-2'].every((runId) => {
        const wf = s2.store.getConnectedRun(runId);
        return wf?.invocations?.[resolveRootInvocationId(wf)]?.status === 'completed';
      })
    );

    expect(s2.invokedPhases.filter((p) => p === 'phase-one')).toHaveLength(2);
    expect(s2.invokedPhases.filter((p) => p === 'phase-two')).toHaveLength(2);
    expect(s2.invokedPhases).toHaveLength(4);
  });

  it('(c1) already-started Phase 1 paused on close (queue-paused-mid-run) pauses as recovery-uncertain-effect on restart, then Queue Resume reactivates and runs Phase 2 (FR-010, SC-005)', async () => {
    const memento = new SharedMemento();
    const phase1Started = createDeferred();
    const releasePhase1 = createDeferred();

    const s1 = await openRealSession(memento, tmpRoot, {
      onPhaseInvoke: async (phaseId) => {
        phase1Started.resolve();
        await releasePhase1.promise;
        return makeInvocationResult(phaseId, true);
      }
    });
    await s1.launchTwoPhase('wf-close-queue-resume');

    // Start Phase 1 so a real WorkflowRun is running, then simulate extension close pause boundary
    const startRes = await s1.guardedRunService.applyStartQueueIntent(
      { startMode: 'now', source: 'operator-restart' },
      { queueId: DEFAULT_QUEUE_ID }
    );
    expect(startRes.outcome).toBe('applied');
    const drainPromise = s1.controller.drainQueuedWork(DEFAULT_QUEUE_ID);
    await phase1Started.promise;

    // Close teardown aborts the running child first, then pauses queues at lifecycle boundary.
    releasePhase1.resolve();
    await drainPromise;
    await s1.controller.drainedRunsSettled();

    await pauseQueuesAtLifecycleBoundary({
      store: s1.store,
      queue: s1.queue,
      lock: s1.lock,
      scheduledStartCoordinator: s1.scheduledStartCoordinator,
      logger: s1.logger,
      now: () => 50_000
    });

    expect(s1.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('paused');
    expect(s1.store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBe('queue-paused-mid-run');

    // Fresh session on restart: startup recovery MUST pause already-started leaf as recovery-uncertain-effect (262 FR-006)
    const s2 = await openRealSession(memento, tmpRoot);
    await s2.reconcile();

    const pausedWf = s2.store.getConnectedRun('wf-close-queue-resume')!;
    const pausedRoot = pausedWf.invocations![resolveRootInvocationId(pausedWf)]!;
    expect(pausedRoot.status).toBe('paused');
    expect(pausedRoot.controlMarkers?.manualPauseCause).toBe('recovery-uncertain-effect');
    expect(s2.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);

    // Operator clicks Resume Queue -> unpauses queue and runs resumePausedQueueExecution
    const unpauseRes = await s2.queue.setQueuePausedState(false, DEFAULT_QUEUE_ID, null, 'operator');
    expect(unpauseRes.ok).toBe(true);
    const resumeOutcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, {
      store: s2.store,
      guardedRunService: s2.guardedRunService,
      controller: s2.controller,
      logger: s2.logger
    });
    expect(resumeOutcome).toEqual({ action: 'resumed-run' });

    await waitUntil(() => {
      const wf = s2.store.getConnectedRun('wf-close-queue-resume');
      return wf?.invocations?.[resolveRootInvocationId(wf)]?.status === 'completed';
    });
    await s2.controller.drainedRunsSettled();

    // No duplicate Phase 1 queue item; both Phase 1 (resumed) and Phase 2 executed cleanly
    expect(s2.invokedPhases).toEqual(['phase-one', 'phase-two']);
    expect(s2.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(2);
    const doneWf = s2.store.getConnectedRun('wf-close-queue-resume')!;
    expect(doneWf.invocations![resolveRootInvocationId(doneWf)]!.attemptsByNodeId['node-1']).toHaveLength(1);
    expect(doneWf.invocations![resolveRootInvocationId(doneWf)]!.attemptsByNodeId['node-2']).toHaveLength(1);
  });

  it('(c2) already-started Phase 1 paused on close -> restart -> Phase Resume (runResumePhase) reactivates and runs Phase 2 (FR-010, SC-005)', async () => {
    const memento = new SharedMemento();
    const phase1Started = createDeferred();
    const releasePhase1 = createDeferred();

    const s1 = await openRealSession(memento, tmpRoot, {
      onPhaseInvoke: async (phaseId) => {
        phase1Started.resolve();
        await releasePhase1.promise;
        return makeInvocationResult(phaseId, true);
      }
    });
    await s1.launchTwoPhase('wf-close-phase-resume');

    await s1.guardedRunService.applyStartQueueIntent(
      { startMode: 'now', source: 'operator-restart' },
      { queueId: DEFAULT_QUEUE_ID }
    );
    const drainPromise = s1.controller.drainQueuedWork(DEFAULT_QUEUE_ID);
    await phase1Started.promise;

    releasePhase1.resolve();
    await drainPromise;
    await s1.controller.drainedRunsSettled();

    await pauseQueuesAtLifecycleBoundary({
      store: s1.store,
      queue: s1.queue,
      lock: s1.lock,
      scheduledStartCoordinator: s1.scheduledStartCoordinator,
      logger: s1.logger,
      now: () => 50_000
    });

    const s2 = await openRealSession(memento, tmpRoot);
    await s2.reconcile();
    expect(
      s2.store.getConnectedRun('wf-close-phase-resume')!.invocations!['wf-close-phase-resume:root']!
        .controlMarkers?.manualPauseCause
    ).toBe('recovery-uncertain-effect');

    // Operator triggers Phase Resume (CMD_RESUME_PHASE / schegent.resumePhase) while queue is still
    // operator-paused from close -> ConnectedWorkflowRun immediately reactivates, Phase 1 completes,
    // and Phase 2 is enqueued (never skipped) ready to drain once the operator unpauses the queue.
    const outcome = await runResumePhase(undefined, DEFAULT_QUEUE_ID, {
      controller: s2.controller,
      notifier: s2.notifier,
      logger: s2.logger,
      store: s2.store
    });
    expect(outcome.outcome).toBe('accepted');

    await waitUntil(() => {
      const wf = s2.store.getConnectedRun('wf-close-phase-resume');
      const root = wf?.invocations?.[resolveRootInvocationId(wf)];
      return root?.status === 'in-flight' && attemptsForNode(root, 'node-2').length === 1;
    });
    await s2.controller.drainedRunsSettled();

    // Unpausing the queue now drains the already-dispatched Phase 2 to workflow-completed.
    const unpauseAfterPhaseResume = await s2.queue.setQueuePausedState(
      false,
      DEFAULT_QUEUE_ID,
      null,
      'operator'
    );
    expect(unpauseAfterPhaseResume.ok).toBe(true);
    await resumePausedQueueExecution(DEFAULT_QUEUE_ID, {
      store: s2.store,
      guardedRunService: s2.guardedRunService,
      controller: s2.controller,
      logger: s2.logger
    });

    await waitUntil(() => {
      const wf = s2.store.getConnectedRun('wf-close-phase-resume');
      return wf?.invocations?.[resolveRootInvocationId(wf)]?.status === 'completed';
    });
    await s2.controller.drainedRunsSettled();

    expect(s2.invokedPhases).toEqual(['phase-one', 'phase-two']);
    expect(s2.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(2);
  });

  it('(c3) cascade-paused Phase 1 -> restart -> Phase Resume (runResumePhase) reactivates and drives Phase 2 directly to completion (FR-010, SC-005)', async () => {
    const memento = new SharedMemento();
    const phase1Started = createDeferred();
    const releasePhase1 = createDeferred();

    const s1 = await openRealSession(memento, tmpRoot, {
      onPhaseInvoke: async (phaseId) => {
        phase1Started.resolve();
        await releasePhase1.promise;
        return makeInvocationResult(phaseId, true);
      }
    });
    await s1.launchTwoPhase('wf-cascade-phase-resume');

    await s1.guardedRunService.applyStartQueueIntent(
      { startMode: 'now', source: 'operator-restart' },
      { queueId: DEFAULT_QUEUE_ID }
    );
    const drainPromise = s1.controller.drainQueuedWork(DEFAULT_QUEUE_ID);
    await phase1Started.promise;

    // Operator pauses the active phase (cascade-pausing the queue), then host restarts.
    const pauseRes = await s1.controller.pauseActivePhase(DEFAULT_QUEUE_ID);
    expect(pauseRes.ok).toBe(true);
    releasePhase1.resolve();
    await drainPromise;
    await s1.controller.drainedRunsSettled();

    const s2 = await openRealSession(memento, tmpRoot);
    await s2.reconcile();
    expect(
      s2.store.getConnectedRun('wf-cascade-phase-resume')!.invocations![
        'wf-cascade-phase-resume:root'
      ]!.controlMarkers?.manualPauseCause
    ).toBe('recovery-uncertain-effect');

    const outcome = await runResumePhase(undefined, DEFAULT_QUEUE_ID, {
      controller: s2.controller,
      notifier: s2.notifier,
      logger: s2.logger,
      store: s2.store
    });
    expect(outcome.outcome).toBe('accepted');

    await waitUntil(() => {
      const wf = s2.store.getConnectedRun('wf-cascade-phase-resume');
      return wf?.invocations?.[resolveRootInvocationId(wf)]?.status === 'completed';
    });
    await s2.controller.drainedRunsSettled();

    expect(s2.invokedPhases).toEqual(['phase-one', 'phase-two']);
    expect(s2.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(2);
  });

  it('(d1) pre-existing poisoned recovery-uncertain-effect ConnectedWorkflowRun self-heals when Phase 1 completes and advances to Phase 2 (FR-011, SC-006)', async () => {
    const memento = new SharedMemento();
    const s1 = await openRealSession(memento, tmpRoot);
    await s1.launchTwoPhase('wf-poisoned-self-heal');

    // Simulate a pre-existing poisoned ConnectedWorkflowRun persisted on disk prior to this fix
    const initial = s1.store.getConnectedRun('wf-poisoned-self-heal')!;
    const poisoned = pauseRunWithCause(initial, 'recovery-uncertain-effect', 21_000);
    const written = await s1.store.compareAndSetConnectedRun(poisoned, initial.revision);
    expect(written.outcome).toBe('written');

    // Drain Phase 1 -> onRunTerminal calls recordConnectedWorkflowTransition -> self-heals & runs Phase 2
    await s1.drainAllToCompletion();
    await waitUntil(() => {
      const wf = s1.store.getConnectedRun('wf-poisoned-self-heal');
      return wf?.invocations?.[resolveRootInvocationId(wf)]?.status === 'completed';
    });

    expect(s1.invokedPhases).toEqual(['phase-one', 'phase-two']);
  });

  it.each<WorkflowPauseCause>(['operator-pause', 'spend-bound-exceeded', 'credit-exhausted'])(
    '(d2) explicit %s pause is NEVER bypassed on terminal leaf completion and emits a structured warning (FR-011, SC-006)',
    async (explicitCause) => {
      const memento = new SharedMemento();
      const s1 = await openRealSession(memento, tmpRoot);
      const runId = `wf-explicit-${explicitCause}`;
      await s1.launchTwoPhase(runId);

      const initial = s1.store.getConnectedRun(runId)!;
      const paused = pauseRunWithCause(initial, explicitCause, 22_000);
      const written = await s1.store.compareAndSetConnectedRun(paused, initial.revision);
      expect(written.outcome).toBe('written');

      // Drain Phase 1 -> recordConnectedWorkflowTransition must hold the explicit pause and warn
      await s1.drainAllToCompletion();

      expect(s1.invokedPhases).toEqual(['phase-one']);
      const after = s1.store.getConnectedRun(runId)!;
      const rootAfter = after.invocations![resolveRootInvocationId(after)]!;
      expect(rootAfter.status).toBe('paused');
      expect(rootAfter.controlMarkers?.manualPauseCause).toBe(explicitCause);
      expect(rootAfter.attemptsByNodeId['node-2']).toBeUndefined();
      expect(s1.warnMessages.some((m) => m.includes(runId) && m.includes(explicitCause))).toBe(true);
    }
  );

  it('(e) missing/deleted task row with no durable completion evidence is canceled as orphaned-canceled on startup recovery (FR-008)', async () => {
    const memento = new SharedMemento();
    const s1 = await openRealSession(memento, tmpRoot);
    await s1.launchTwoPhase('wf-deleted-task');

    // Remove the queued FeatureRequest row from storage to simulate a deleted/missing task
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);
    await s1.store.updateQueue(
      (q) => ({ queue: { ...q, requests: [] }, result: undefined }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );
    expect(s1.store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(0);

    const s2 = await openRealSession(memento, tmpRoot);
    await s2.reconcile();

    const orphaned = s2.store.getConnectedRun('wf-deleted-task')!;
    expect(orphaned.recoveryDisposition?.status).toBe('orphaned-canceled');
    expect(orphaned.invocations![resolveRootInvocationId(orphaned)]!.status).toBe('canceled');
  });
});
