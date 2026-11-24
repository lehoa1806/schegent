// FR-R7-18 (`N01`, FR-001, SC-001, Contract 1) — sidebar cancellation latency
// and invariant verification behind slow serialized start and teardown mutations.
//
// Proves:
//   1. `CMD_CANCEL` dispatches and acknowledges in `< 250 ms` while real
//      serialized start (`CMD_START_QUEUE` with pending `provisionRunLane` and
//      pending `requestGitApproval`) and teardown (`CMD_CLEAR_QUEUE` with
//      pending runner-stop wait, `CMD_REMOVE_QUEUE_ITEM` with pending
//      `sessionCleanup`) mutations are held pending for `>= 500 ms`.
//   2. `CMD_CONTINUE_WORKFLOW` bypasses the global mutation serialization chain
//      ONLY for validated cancellation payloads (`operation === 'cancel'` or
//      `controlCommand.action.kind === 'cancel'`), while non-cancel workflow
//      mutations (and mixed payloads carrying a non-cancel `controlCommand`)
//      remain strictly serialized behind the held mutation.
//   3. Workspace trust and window primacy still refuse `CMD_CANCEL` and
//      workflow-cancel `CMD_CONTINUE_WORKFLOW` before any handler runs.
//   4. Duplicate `correlationId` still joins in-flight and replays the frozen
//      first ACK without re-invoking the handler.
//   5. Concurrent `CMD_CANCEL` racing a same-task cancel, deletion, queue clear,
//      or completion produces at most one terminal transition and zero stray
//      `task-canceled` audit entries on lost races.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { runCancel } from '../../src/commands/cancel';
import { runClearQueue } from '../../src/commands/clear-queue';
import { runStartQueueCommand, type StartQueueCommandArg } from '../../src/commands/start-queue';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { ControlCommandAcknowledgement } from '../../src/contracts/sidebar-ipc';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
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
import { QueueStartFailureRegistry } from '../../src/services/queue-start-failure-registry';
import type { SessionCleanupOutcome } from '../../src/services/session-cleanup/session-cleanup-service';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { dispatchComposableNode } from '../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import type { ControlCommandService } from '../../src/services/workflow-execution/control-command-service';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager } from '../../src/state/lock';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore } from '../../src/state/workspace-state';
import type { Notifier } from '../../src/ui/notifications';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../src/ui/sidebar/commands/constants';
import type { RouterDeps } from '../../src/ui/sidebar/commands/router-types';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import {
  CMD_CANCEL,
  CMD_CLEAR_QUEUE,
  CMD_CONTINUE_WORKFLOW,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_START_QUEUE,
  type CommandAckMessage,
  type ContinueWorkflowCommand,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import { buildCatalog, type PipelineCatalog } from '../../src/config/pipeline-config';
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';
import {
  FakeMemento,
  FixedClock,
  QUEUE_A,
  QUEUE_B,
  T0,
  cleanOutput,
  noopScheduler,
  removeWorkspace
} from './concurrent-run-harness';

const HOLD_DURATION_MS = 520;
const MIN_HELD_MS = 500;
const MAX_CANCEL_LATENCY_MS = 250;
const PRINT_REPORT = process.env.SCHEGENT_PRINT_N01_REPORT === '1';

const EMPTY_RUN_REQUEST = {
  pipelineId: 'wf-auto',
  inputs: [],
  supplemental: [],
  outputs: []
} as const;

const PHASE_SPEC: PhaseDefinition = {
  phaseId: 'phase-spec',
  name: 'Spec Phase',
  version: 1,
  instruction: 'Run specify'
};

const AUTO_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-auto',
  name: 'Auto Workflow',
  version: 1,
  startNodeIds: ['node-spec'],
  nodes: [{ nodeId: 'node-spec', kind: 'phase', phaseId: 'phase-spec' }],
  connections: []
};

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface LatencyMeasurement {
  readonly scenario: string;
  readonly dispatchLatencyMs: number;
  readonly ackLatencyMs: number;
  readonly heldMutationElapsedMs: number;
  readonly completedWhileHeld: boolean;
}

function reportMeasurement(measurement: LatencyMeasurement): void {
  if (!PRINT_REPORT) return;
  process.stdout.write(
    `[N01-MEASUREMENT] ${JSON.stringify({
      scenario: measurement.scenario,
      dispatchLatencyMs: Number(measurement.dispatchLatencyMs.toFixed(3)),
      ackLatencyMs: Number(measurement.ackLatencyMs.toFixed(3)),
      heldMutationElapsedMs: Number(measurement.heldMutationElapsedMs.toFixed(3)),
      completedWhileHeld: measurement.completedWhileHeld
    })}\n`
  );
}

interface TestSystemOptions {
  readonly trusted?: boolean;
  readonly primary?: boolean;
  readonly withGitSideEffect?: boolean;
  readonly provisionRunLane?: WorkflowControllerDeps['provisionRunLane'];
  readonly requestGitApproval?: WorkflowControllerDeps['requestGitApproval'];
  readonly sessionCleanup?: WorkflowControllerDeps['sessionCleanup'];
  readonly onCancelInvoked?: () => void;
  readonly onControlCommandInvoked?: (kind: string) => void;
  readonly onConnectedRunGet?: () => void;
  readonly omitControlCommandService?: boolean;
}

function buildGitCapableCatalog(): PipelineCatalog {
  const base = buildSpeckitCatalog();
  const basePipeline = base.pipelines[0]!;
  return buildCatalog(
    base.phases.map((phase, index) =>
      index === 0 ? { ...phase, sideEffects: 'git' as const } : phase
    ),
    [basePipeline],
    base.models,
    base.defaultPipelineId
  );
}

interface TestSystem {
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly controller: SchegentWorkflowController;
  readonly audit: AuditLogWriter;
  readonly logger: SanitizedLogger;
  readonly notifier: Notifier;
  readonly lock: WorkspaceLockManager;
  readonly lease: ExecutionLeaseManager;
  readonly router: MessageRouter;
  readonly connectedRunId: string;
  readonly rootInvocationId: string;
  readonly executeCommandSpy: ReturnType<typeof vi.fn>;
  readonly controlExecuteSpy: ReturnType<typeof vi.fn>;
  readonly getConnectedRun: () => ConnectedWorkflowRun;
  readonly readAuditEntries: () => Promise<Array<Record<string, unknown>>>;
  readonly setTrusted: (value: boolean) => void;
  readonly setPrimary: (value: boolean) => void;
  readonly releaseParkedCli: () => void;
  readonly quiesce: () => Promise<void>;
}

async function createSystem(
  workspaceRoot: string,
  options: TestSystemOptions = {}
): Promise<TestSystem> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const rawTranscript = new RawTranscriptWriter(
    workspaceRoot,
    logger,
    path.join(workspaceRoot, 'spool')
  );
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  await store.setGlobalConcurrencyCap(4);

  const registry = store.getQueueRegistry();
  await store.setQueueRegistry({
    entries: [
      ...registry.entries,
      {
        id: QUEUE_B,
        name: 'Queue B',
        position: registry.entries.length,
        schedule: null,
        createdAt: T0,
        updatedAt: T0
      }
    ],
    updatedAt: T0
  });

  const parkedResolvers: Array<() => void> = [];
  let releaseAllCli = false;
  const runner = {
    invoke: vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
      if (!releaseAllCli) {
        await new Promise<void>((resolve) => {
          parkedResolvers.push(resolve);
        });
      }
      return cleanOutput(req.phase);
    }),
    cancelActive: vi.fn(() => {
      while (parkedResolvers.length > 0) {
        const release = parkedResolvers.pop();
        if (release) release();
      }
      return true;
    }),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const phaseRunner = new PhaseRunner(
    runner,
    new PromptBuilder(),
    audit,
    logger,
    rawTranscript,
    null,
    null,
    null,
    null,
    createPhaseBreakpointAccessor(
      (runId) => Object.values(store.getRunMap()).find((run) => run.id === runId) ?? null
    )
  );

  const queue = new QueueManager(store);
  const clock = new FixedClock();
  const lockStore = new WorkspaceStateStore(new FakeMemento());
  await lockStore.initialize();
  const lock = new WorkspaceLockManager(lockStore, 'window-a', clock, noopScheduler);
  await lock.tryAcquire();
  const lease = new ExecutionLeaseManager(store, 'window-a', clock, noopScheduler);
  const notifier: Notifier = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
  const startFailures = new QueueStartFailureRegistry(() => T0);

  const controllerDeps: WorkflowControllerDeps = {
    catalog: options.withGitSideEffect ? buildGitCapableCatalog() : buildSpeckitCatalog(),
    auditWriter: audit,
    executionLease: lease,
    startFailures,
    terminalTransitions: new TerminalTransitionCoordinator(
      store,
      queue,
      { record: vi.fn(async () => ({ outcome: 'recorded' as const })) },
      logger
    ),
    getRawTranscriptMode: () => 'off',
    ...(options.provisionRunLane ? { provisionRunLane: options.provisionRunLane } : {}),
    ...(options.requestGitApproval ? { requestGitApproval: options.requestGitApproval } : {}),
    ...(options.sessionCleanup ? { sessionCleanup: options.sessionCleanup } : {})
  };

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    controllerDeps
  );

  // Real composable workflow run for `CMD_CONTINUE_WORKFLOW` cancel and non-cancel tests.
  const connectedRunId = 'crun-n01-1';
  const created = createComposableWorkflowRunSnapshot({
    connectedRunId,
    workflow: AUTO_WORKFLOW,
    effectivePhases: [PHASE_SPEC],
    startedAt: T0,
    queueId: QUEUE_B
  });
  if (created.outcome !== 'created') {
    throw new Error(`Expected composable workflow snapshot creation, got ${created.outcome}`);
  }
  let currentConnectedRun: ConnectedWorkflowRun = created.run;
  const connectedRuns = {
    get: (id: string) => {
      options.onConnectedRunGet?.();
      return id === connectedRunId ? currentConnectedRun : null;
    },
    compareAndSetConnectedRun: (next: ConnectedWorkflowRun, expectedRevision: number) => {
      if (currentConnectedRun.revision !== expectedRevision) {
        return Promise.resolve({ outcome: 'stale' as const, current: currentConnectedRun });
      }
      currentConnectedRun = { ...next, revision: expectedRevision + 1 };
      return Promise.resolve({ outcome: 'written' as const, run: currentConnectedRun });
    },
    readChildState: () => null
  };
  await dispatchComposableNode(
    {
      connectedRuns,
      dispatchPhase: () => Promise.resolve({ outcome: 'dispatched', queueItemId: 'leaf-row-1' })
    },
    {
      run: created.run,
      invocationId: created.rootInvocationId,
      nodeId: 'node-spec',
      startedAt: T0 + 1
    }
  );

  const controlExecuteSpy = vi.fn(
    async (envelope: { commandId: string; action: { kind: string } }): Promise<ControlCommandAcknowledgement> => {
      options.onControlCommandInvoked?.(envelope.action.kind);
      return {
        version: 1,
        commandId: envelope.commandId,
        outcome: 'accepted',
        generation: 1
      };
    }
  );

  let trusted = options.trusted ?? true;
  let primary = options.primary ?? true;

  const executeCommandSpy = vi.fn(async (commandId: string, arg?: unknown): Promise<unknown> => {
    if (commandId === 'schegent.cancel') {
      options.onCancelInvoked?.();
      const taskId = (arg as { taskId?: string } | undefined)?.taskId;
      return runCancel({
        controller,
        store,
        queue,
        audit,
        notifier,
        logger,
        ...(taskId !== undefined ? { taskId } : {})
      });
    }
    if (commandId === 'schegent.startQueue') {
      return runStartQueueCommand(arg as StartQueueCommandArg | undefined, {
        guardedRunService: {
          applyStartQueueIntent: vi.fn(async () => ({
            outcome: 'applied' as const,
            lifecycleAfter: 'running' as const
          }))
        },
        controller,
        logger,
        startFailures
      });
    }
    if (commandId === 'schegent.clearQueue') {
      return runClearQueue(
        {
          controller,
          queue,
          executionLease: lease,
          audit,
          lock,
          notifier,
          logger
        },
        String(arg)
      );
    }
    throw new Error(`Unexpected executeCommand call: ${commandId}`);
  });

  const routerDeps: RouterDeps & { controlCommandService?: ControlCommandService } = {
    executeCommand: executeCommandSpy as unknown as RouterDeps['executeCommand'],
    isTrusted: () => trusted,
    isPrimary: () => primary,
    notifyWarning: vi.fn(),
    logger,
    audit,
    phaseOps: {
      skipPhase: vi.fn(async () => ({ ok: true })),
      disablePhase: vi.fn(async () => ({ ok: true })),
      enablePhase: vi.fn(async () => ({ ok: true })),
      deleteTask: (taskId: string) => controller.deleteTask(taskId)
    },
    connectedRuns,
    ...(options.omitControlCommandService
      ? {}
      : {
          controlCommandService: {
            executeControlCommand: controlExecuteSpy
          } as unknown as ControlCommandService
        })
  };

  const router = new MessageRouter(routerDeps);

  const readAuditEntries = async (): Promise<Array<Record<string, unknown>>> => {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  };

  const releaseParkedCli = (): void => {
    releaseAllCli = true;
    while (parkedResolvers.length > 0) {
      const release = parkedResolvers.pop();
      if (release) release();
    }
  };

  return {
    workspaceRoot,
    store,
    queue,
    controller,
    audit,
    logger,
    notifier,
    lock,
    lease,
    router,
    connectedRunId,
    rootInvocationId: created.rootInvocationId,
    executeCommandSpy,
    controlExecuteSpy,
    getConnectedRun: () => currentConnectedRun,
    readAuditEntries,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    setPrimary: (value: boolean) => {
      primary = value;
    },
    releaseParkedCli,
    quiesce: async () => {
      controller.closeAutoDrain();
      releaseParkedCli();
      await controller.drainedRunsSettled();
    }
  };
}

async function seedRunningTask(
  system: TestSystem,
  queueId: string,
  runId: string,
  description: string
): Promise<string> {
  const feature = await system.queue.enqueue(description, { queueId });
  await system.queue.markInFlight(feature.id, runId);
  await system.store.setRun(
    queueId,
    {
      id: runId,
      featureId: feature.id,
      featureDir: 'specs/332-recovery-verification-gaps',
      status: 'running',
      currentPhase: 'speckit-plan',
      currentIteration: 0,
      startedAt: T0,
      lastTransitionAt: T0,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    },
    unfencedCommit('test-fixture')
  );
  return feature.id;
}

function makeWorkflowContinueCommand(
  correlationId: string,
  connectedRunId: string,
  expectedRevision: number,
  overrides: Partial<ContinueWorkflowCommand['payload']> = {}
): ContinueWorkflowCommand {
  return {
    type: CMD_CONTINUE_WORKFLOW,
    correlationId,
    payload: {
      connectedRunId,
      expectedRevision,
      nodeId: 'node-spec',
      request: {
        pipelineId: EMPTY_RUN_REQUEST.pipelineId,
        inputs: [],
        supplemental: [],
        outputs: []
      },
      ...overrides
    }
  };
}

describe('FR-R7-18 N01 — sidebar cancellation behind slow serialized mutations', () => {
  let tmpRoot: string;
  let activeSystem: TestSystem | null = null;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-n01-cancel-'));
    activeSystem = null;
  });

  afterEach(async () => {
    if (activeSystem) {
      await activeSystem.quiesce();
    }
    await removeWorkspace(tmpRoot);
  });

  it('unblocks CMD_CANCEL (< 250 ms) while real CMD_START_QUEUE holds provisionRunLane pending >= 500 ms', async () => {
    const laneEntered = createDeferred<void>();
    const laneGate = createDeferred<{ readonly laneId: string; readonly laneRootRef: string } | null>();
    let cancelHandlerEnteredAt = 0;

    const system = await createSystem(tmpRoot, {
      provisionRunLane: async () => {
        laneEntered.resolve();
        return laneGate.promise;
      },
      requestGitApproval: async () => true,
      onCancelInvoked: () => {
        cancelHandlerEnteredAt = performance.now();
      }
    });
    activeSystem = system;

    await system.queue.enqueue('slow-start task on queue A', { queueId: QUEUE_A });
    const targetTaskId = await seedRunningTask(system, QUEUE_B, 'run-b-1', 'active task on queue B');

    let slowSettled = false;
    const slowAcks: CommandAckMessage[] = [];
    const slowStartedAt = performance.now();
    const slowDispatch = system.router
      .dispatch(
        { type: CMD_START_QUEUE, correlationId: 'slow-start-lane-1', payload: { queueId: QUEUE_A } },
        async (msg) => {
          slowAcks.push(msg);
          return true;
        }
      )
      .finally(() => {
        slowSettled = true;
      });

    await laneEntered.promise;
    const releaseTimer = setTimeout(() => {
      laneGate.resolve({ laneId: 'lane-a-1', laneRootRef: 'lanes/ws/lane-a-1' });
    }, HOLD_DURATION_MS);

    try {
      const cancelAcks: CommandAckMessage[] = [];
      let cancelAckAt = 0;
      const cancelStartedAt = performance.now();
      await system.router.dispatch(
        { type: CMD_CANCEL, correlationId: 'cancel-behind-lane-1', payload: { taskId: targetTaskId } },
        async (msg) => {
          cancelAckAt = performance.now();
          cancelAcks.push(msg);
          return true;
        }
      );

      const dispatchLatencyMs = cancelHandlerEnteredAt - cancelStartedAt;
      const ackLatencyMs = cancelAckAt - cancelStartedAt;
      const completedWhileHeld = !slowSettled;

      expect(completedWhileHeld).toBe(true);
      expect(cancelAcks).toHaveLength(1);
      expect(cancelAcks[0]?.status).toBe('accepted');
      expect(dispatchLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(ackLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(system.queue.findById(targetTaskId)?.status).toBe('canceled');
      expect(system.store.getRun(QUEUE_B)?.status).toBe('canceled');

      await slowDispatch;
      const heldMutationElapsedMs = performance.now() - slowStartedAt;
      expect(heldMutationElapsedMs).toBeGreaterThanOrEqual(MIN_HELD_MS);
      expect(slowAcks).toHaveLength(1);
      expect(slowAcks[0]?.status).toBe('accepted');

      const auditEntries = await system.readAuditEntries();
      const cancelAudits = auditEntries.filter(
        (entry) =>
          entry.eventType === 'task-canceled' &&
          (entry.payload as { taskId?: string }).taskId === targetTaskId
      );
      expect(cancelAudits).toHaveLength(1);

      reportMeasurement({
        scenario: 'CMD_CANCEL behind CMD_START_QUEUE (provisionRunLane)',
        dispatchLatencyMs,
        ackLatencyMs,
        heldMutationElapsedMs,
        completedWhileHeld
      });
    } finally {
      clearTimeout(releaseTimer);
      laneGate.resolve(null);
    }
  });

  it('unblocks CMD_CANCEL (< 250 ms) while real CMD_START_QUEUE holds requestGitApproval pending >= 500 ms', async () => {
    const approvalEntered = createDeferred<void>();
    const approvalGate = createDeferred<boolean>();
    let cancelHandlerEnteredAt = 0;

    const system = await createSystem(tmpRoot, {
      withGitSideEffect: true,
      requestGitApproval: async () => {
        approvalEntered.resolve();
        return approvalGate.promise;
      },
      onCancelInvoked: () => {
        cancelHandlerEnteredAt = performance.now();
      }
    });
    activeSystem = system;

    await system.queue.enqueue('git-approval task on queue A', { queueId: QUEUE_A });
    const targetTaskId = await seedRunningTask(system, QUEUE_B, 'run-b-2', 'active task on queue B');

    let slowSettled = false;
    const slowAcks: CommandAckMessage[] = [];
    const slowStartedAt = performance.now();
    const slowDispatch = system.router
      .dispatch(
        { type: CMD_START_QUEUE, correlationId: 'slow-start-git-1', payload: { queueId: QUEUE_A } },
        async (msg) => {
          slowAcks.push(msg);
          return true;
        }
      )
      .finally(() => {
        slowSettled = true;
      });

    await approvalEntered.promise;
    const releaseTimer = setTimeout(() => {
      approvalGate.resolve(true);
    }, HOLD_DURATION_MS);

    try {
      const cancelAcks: CommandAckMessage[] = [];
      let cancelAckAt = 0;
      const cancelStartedAt = performance.now();
      await system.router.dispatch(
        { type: CMD_CANCEL, correlationId: 'cancel-behind-git-1', payload: { taskId: targetTaskId } },
        async (msg) => {
          cancelAckAt = performance.now();
          cancelAcks.push(msg);
          return true;
        }
      );

      const dispatchLatencyMs = cancelHandlerEnteredAt - cancelStartedAt;
      const ackLatencyMs = cancelAckAt - cancelStartedAt;
      const completedWhileHeld = !slowSettled;

      expect(completedWhileHeld).toBe(true);
      expect(cancelAcks).toHaveLength(1);
      expect(cancelAcks[0]?.status).toBe('accepted');
      expect(dispatchLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(ackLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(system.queue.findById(targetTaskId)?.status).toBe('canceled');

      await slowDispatch;
      const heldMutationElapsedMs = performance.now() - slowStartedAt;
      expect(heldMutationElapsedMs).toBeGreaterThanOrEqual(MIN_HELD_MS);
      expect(slowAcks).toHaveLength(1);
      expect(slowAcks[0]?.status).toBe('accepted');

      reportMeasurement({
        scenario: 'CMD_CANCEL behind CMD_START_QUEUE (requestGitApproval)',
        dispatchLatencyMs,
        ackLatencyMs,
        heldMutationElapsedMs,
        completedWhileHeld
      });
    } finally {
      clearTimeout(releaseTimer);
      approvalGate.resolve(true);
    }
  });

  it('unblocks CMD_CANCEL (< 250 ms) while real CMD_CLEAR_QUEUE waits on runner stop >= 500 ms', async () => {
    let cancelHandlerEnteredAt = 0;
    const system = await createSystem(tmpRoot, {
      onCancelInvoked: () => {
        cancelHandlerEnteredAt = performance.now();
      }
    });
    activeSystem = system;

    await seedRunningTask(system, QUEUE_A, 'run-a-clear', 'clearing task on queue A');
    const targetTaskId = await seedRunningTask(system, QUEUE_B, 'run-b-clear', 'active task on queue B');

    const clearStopWaitEntered = createDeferred<void>();
    let queueADriving = true;
    const origIsDriving = system.controller.isDriving.bind(system.controller);
    vi.spyOn(system.controller, 'isDriving').mockImplementation((queueId: string) => {
      if (queueId === QUEUE_A) {
        clearStopWaitEntered.resolve();
        return queueADriving;
      }
      return origIsDriving(queueId);
    });

    let slowSettled = false;
    const slowAcks: CommandAckMessage[] = [];
    const slowStartedAt = performance.now();
    const slowDispatch = system.router
      .dispatch(
        { type: CMD_CLEAR_QUEUE, correlationId: 'slow-clear-1', payload: { queueId: QUEUE_A } },
        async (msg) => {
          slowAcks.push(msg);
          return true;
        }
      )
      .finally(() => {
        slowSettled = true;
      });

    await clearStopWaitEntered.promise;
    const releaseTimer = setTimeout(() => {
      queueADriving = false;
    }, HOLD_DURATION_MS);

    try {
      const cancelAcks: CommandAckMessage[] = [];
      let cancelAckAt = 0;
      const cancelStartedAt = performance.now();
      await system.router.dispatch(
        { type: CMD_CANCEL, correlationId: 'cancel-behind-clear-1', payload: { taskId: targetTaskId } },
        async (msg) => {
          cancelAckAt = performance.now();
          cancelAcks.push(msg);
          return true;
        }
      );

      const dispatchLatencyMs = cancelHandlerEnteredAt - cancelStartedAt;
      const ackLatencyMs = cancelAckAt - cancelStartedAt;
      const completedWhileHeld = !slowSettled;

      expect(completedWhileHeld).toBe(true);
      expect(cancelAcks).toHaveLength(1);
      expect(cancelAcks[0]?.status).toBe('accepted');
      expect(dispatchLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(ackLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(system.queue.findById(targetTaskId)?.status).toBe('canceled');

      await slowDispatch;
      const heldMutationElapsedMs = performance.now() - slowStartedAt;
      expect(heldMutationElapsedMs).toBeGreaterThanOrEqual(MIN_HELD_MS);
      expect(slowAcks).toHaveLength(1);
      expect(slowAcks[0]?.status).toBe('accepted');
      expect(system.store.getQueue(QUEUE_A).requests).toHaveLength(0);

      reportMeasurement({
        scenario: 'CMD_CANCEL behind CMD_CLEAR_QUEUE (runner-stop wait)',
        dispatchLatencyMs,
        ackLatencyMs,
        heldMutationElapsedMs,
        completedWhileHeld
      });
    } finally {
      clearTimeout(releaseTimer);
      queueADriving = false;
    }
  });

  it('unblocks CMD_CANCEL (< 250 ms) while real CMD_REMOVE_QUEUE_ITEM holds sessionCleanup pending >= 500 ms', async () => {
    const cleanupEntered = createDeferred<void>();
    const cleanupGate = createDeferred<SessionCleanupOutcome>();
    let cancelHandlerEnteredAt = 0;

    const system = await createSystem(tmpRoot, {
      sessionCleanup: async () => {
        cleanupEntered.resolve();
        return cleanupGate.promise;
      },
      onCancelInvoked: () => {
        cancelHandlerEnteredAt = performance.now();
      }
    });
    activeSystem = system;

    const removedTaskId = await seedRunningTask(system, QUEUE_A, 'run-a-remove', 'task being deleted');
    const targetTaskId = await seedRunningTask(system, QUEUE_B, 'run-b-remove', 'active task on queue B');

    let slowSettled = false;
    const slowAcks: CommandAckMessage[] = [];
    const slowStartedAt = performance.now();
    const slowDispatch = system.router
      .dispatch(
        {
          type: CMD_REMOVE_QUEUE_ITEM,
          correlationId: 'slow-remove-1',
          payload: { id: removedTaskId, confirmed: true }
        },
        async (msg) => {
          slowAcks.push(msg);
          return true;
        }
      )
      .finally(() => {
        slowSettled = true;
      });

    await cleanupEntered.promise;
    const releaseTimer = setTimeout(() => {
      cleanupGate.resolve({ cleaned: true });
    }, HOLD_DURATION_MS);

    try {
      const cancelAcks: CommandAckMessage[] = [];
      let cancelAckAt = 0;
      const cancelStartedAt = performance.now();
      await system.router.dispatch(
        { type: CMD_CANCEL, correlationId: 'cancel-behind-remove-1', payload: { taskId: targetTaskId } },
        async (msg) => {
          cancelAckAt = performance.now();
          cancelAcks.push(msg);
          return true;
        }
      );

      const dispatchLatencyMs = cancelHandlerEnteredAt - cancelStartedAt;
      const ackLatencyMs = cancelAckAt - cancelStartedAt;
      const completedWhileHeld = !slowSettled;

      expect(completedWhileHeld).toBe(true);
      expect(cancelAcks).toHaveLength(1);
      expect(cancelAcks[0]?.status).toBe('accepted');
      expect(dispatchLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(ackLatencyMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(system.queue.findById(targetTaskId)?.status).toBe('canceled');

      await slowDispatch;
      const heldMutationElapsedMs = performance.now() - slowStartedAt;
      expect(heldMutationElapsedMs).toBeGreaterThanOrEqual(MIN_HELD_MS);
      expect(slowAcks).toHaveLength(1);
      expect(slowAcks[0]?.status).toBe('accepted');
      expect(system.queue.findById(removedTaskId)).toBeNull();

      reportMeasurement({
        scenario: 'CMD_CANCEL behind CMD_REMOVE_QUEUE_ITEM (sessionCleanup)',
        dispatchLatencyMs,
        ackLatencyMs,
        heldMutationElapsedMs,
        completedWhileHeld
      });
    } finally {
      clearTimeout(releaseTimer);
      cleanupGate.resolve({ cleaned: true });
    }
  });

  it('unblocks workflow-cancel CMD_CONTINUE_WORKFLOW (operation and controlCommand forms) while keeping non-cancel payloads serialized', async () => {
    const laneEntered = createDeferred<void>();
    const laneGate = createDeferred<{ readonly laneId: string; readonly laneRootRef: string } | null>();
    let opCancelEnteredAt = 0;
    let ctrlCancelEnteredAt = 0;
    const controlDispatches: Array<{ kind: string; at: number }> = [];

    const system = await createSystem(tmpRoot, {
      provisionRunLane: async () => {
        laneEntered.resolve();
        return laneGate.promise;
      },
      requestGitApproval: async () => true,
      onConnectedRunGet: () => {
        if (opCancelEnteredAt === 0) {
          opCancelEnteredAt = performance.now();
        }
      },
      onControlCommandInvoked: (kind: string) => {
        const now = performance.now();
        controlDispatches.push({ kind, at: now });
        if (kind === 'cancel' && ctrlCancelEnteredAt === 0) {
          ctrlCancelEnteredAt = now;
        }
      }
    });
    activeSystem = system;

    await system.queue.enqueue('slow-start for workflow cancel test', { queueId: QUEUE_A });

    let slowSettled = false;
    let slowFinishedAt = 0;
    const slowStartedAt = performance.now();
    const slowDispatch = system.router
      .dispatch(
        { type: CMD_START_QUEUE, correlationId: 'slow-start-wf-1', payload: { queueId: QUEUE_A } },
        async () => true
      )
      .finally(() => {
        slowSettled = true;
        slowFinishedAt = performance.now();
      });

    await laneEntered.promise;
    const releaseTimer = setTimeout(() => {
      laneGate.resolve({ laneId: 'lane-wf-1', laneRootRef: 'lanes/ws/lane-wf-1' });
    }, HOLD_DURATION_MS);

    try {
      // Queue non-cancel workflow control mutations FIRST so we prove they wait
      // on the serialized chain even while subsequent cancel payloads bypass it.
      const nonCancelAcks: CommandAckMessage[] = [];
      const nonCancelPausePromise = system.router.dispatch(
        makeWorkflowContinueCommand(
          'wf-non-cancel-pause-1',
          system.connectedRunId,
          system.getConnectedRun().revision,
          {
            controlCommand: {
              version: 1,
              commandId: '11111111-1111-4111-8111-111111111111',
              rootRunId: system.connectedRunId,
              queueId: QUEUE_B,
              invocationId: system.rootInvocationId,
              expectedGeneration: 0,
              action: { kind: 'pause' }
            }
          }
        ),
        async (msg) => {
          nonCancelAcks.push(msg);
          return true;
        }
      );

      // Crafted mixed payload: `operation: 'cancel'` paired with a non-cancel
      // `controlCommand` MUST stay serialized because `controlCommand` runs first.
      const mixedNonCancelAcks: CommandAckMessage[] = [];
      const mixedNonCancelPromise = system.router.dispatch(
        makeWorkflowContinueCommand(
          'wf-mixed-non-cancel-1',
          system.connectedRunId,
          system.getConnectedRun().revision,
          {
            operation: 'cancel',
            controlCommand: {
              version: 1,
              commandId: '22222222-2222-4222-8222-222222222222',
              rootRunId: system.connectedRunId,
              queueId: QUEUE_B,
              invocationId: system.rootInvocationId,
              expectedGeneration: 0,
              action: { kind: 'resume' }
            }
          }
        ),
        async (msg) => {
          mixedNonCancelAcks.push(msg);
          return true;
        }
      );

      // (a) `controlCommand.action.kind === 'cancel'` bypasses serialization.
      const ctrlCancelAcks: CommandAckMessage[] = [];
      let ctrlCancelAckAt = 0;
      const ctrlCancelStart = performance.now();
      await system.router.dispatch(
        makeWorkflowContinueCommand(
          'wf-ctrl-cancel-1',
          system.connectedRunId,
          system.getConnectedRun().revision,
          {
            controlCommand: {
              version: 1,
              commandId: '33333333-3333-4333-8333-333333333333',
              rootRunId: system.connectedRunId,
              queueId: QUEUE_B,
              invocationId: system.rootInvocationId,
              expectedGeneration: 0,
              action: { kind: 'cancel' }
            }
          }
        ),
        async (msg) => {
          ctrlCancelAckAt = performance.now();
          ctrlCancelAcks.push(msg);
          return true;
        }
      );

      const ctrlDispatchMs = ctrlCancelEnteredAt - ctrlCancelStart;
      const ctrlAckMs = ctrlCancelAckAt - ctrlCancelStart;
      expect(slowSettled).toBe(false);
      expect(ctrlCancelAcks).toHaveLength(1);
      expect(ctrlCancelAcks[0]?.status).toBe('accepted');
      expect(ctrlDispatchMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(ctrlAckMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);

      // (b) `operation === 'cancel'` bypasses serialization.
      const opCancelAcks: CommandAckMessage[] = [];
      let opCancelAckAt = 0;
      const opCancelStart = performance.now();
      await system.router.dispatch(
        makeWorkflowContinueCommand(
          'wf-op-cancel-1',
          system.connectedRunId,
          system.getConnectedRun().revision,
          {
            operation: 'cancel',
            invocationId: system.rootInvocationId
          }
        ),
        async (msg) => {
          opCancelAckAt = performance.now();
          opCancelAcks.push(msg);
          return true;
        }
      );

      const opDispatchMs = opCancelEnteredAt - opCancelStart;
      const opAckMs = opCancelAckAt - opCancelStart;
      expect(slowSettled).toBe(false);
      expect(opCancelAcks).toHaveLength(1);
      expect(opCancelAcks[0]?.status).toBe('accepted');
      expect(opDispatchMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);
      expect(opAckMs).toBeLessThan(MAX_CANCEL_LATENCY_MS);

      // Neither non-cancel `CMD_CONTINUE_WORKFLOW` ran while the slow start was held.
      expect(nonCancelAcks).toHaveLength(0);
      expect(mixedNonCancelAcks).toHaveLength(0);
      expect(controlDispatches.map((entry) => entry.kind)).toEqual(['cancel']);

      await Promise.all([slowDispatch, nonCancelPausePromise, mixedNonCancelPromise]);
      const heldMutationElapsedMs = slowFinishedAt - slowStartedAt;
      expect(heldMutationElapsedMs).toBeGreaterThanOrEqual(MIN_HELD_MS);

      expect(nonCancelAcks).toHaveLength(1);
      expect(nonCancelAcks[0]?.status).toBe('accepted');
      expect(mixedNonCancelAcks).toHaveLength(1);
      expect(mixedNonCancelAcks[0]?.status).toBe('accepted');

      // Ordering proof: cancel dispatched first, pause and resume ran only after slow start settled.
      expect(controlDispatches.map((entry) => entry.kind)).toEqual(['cancel', 'pause', 'resume']);
      expect(controlDispatches[1]!.at).toBeGreaterThanOrEqual(slowFinishedAt - 1);
      expect(controlDispatches[2]!.at).toBeGreaterThanOrEqual(slowFinishedAt - 1);

      reportMeasurement({
        scenario: 'CMD_CONTINUE_WORKFLOW (controlCommand cancel) behind CMD_START_QUEUE',
        dispatchLatencyMs: ctrlDispatchMs,
        ackLatencyMs: ctrlAckMs,
        heldMutationElapsedMs,
        completedWhileHeld: true
      });
      reportMeasurement({
        scenario: 'CMD_CONTINUE_WORKFLOW (operation cancel) behind CMD_START_QUEUE',
        dispatchLatencyMs: opDispatchMs,
        ackLatencyMs: opAckMs,
        heldMutationElapsedMs,
        completedWhileHeld: true
      });
    } finally {
      clearTimeout(releaseTimer);
      laneGate.resolve(null);
    }
  });

  it('refuses CMD_CANCEL and workflow-cancel CMD_CONTINUE_WORKFLOW in untrusted and non-primary windows', async () => {
    const system = await createSystem(tmpRoot);
    activeSystem = system;

    const targetTaskId = await seedRunningTask(system, QUEUE_B, 'run-b-gate', 'gated task');

    const commands = (prefix: string): SidebarCommand[] => [
      { type: CMD_CANCEL, correlationId: `${prefix}-cancel`, payload: { taskId: targetTaskId } },
      makeWorkflowContinueCommand(
        `${prefix}-wf-op-cancel`,
        system.connectedRunId,
        system.getConnectedRun().revision,
        { operation: 'cancel', invocationId: system.rootInvocationId }
      ),
      makeWorkflowContinueCommand(
        `${prefix}-wf-ctrl-cancel`,
        system.connectedRunId,
        system.getConnectedRun().revision,
        {
          controlCommand: {
            version: 1,
            commandId: '44444444-4444-4444-8444-444444444444',
            rootRunId: system.connectedRunId,
            queueId: QUEUE_B,
            invocationId: system.rootInvocationId,
            expectedGeneration: 0,
            action: { kind: 'cancel' }
          }
        }
      )
    ];

    // 1. Untrusted workspace (even when primary).
    system.setTrusted(false);
    system.setPrimary(true);
    for (const cmd of commands('untrusted')) {
      const acks: CommandAckMessage[] = [];
      await system.router.dispatch(cmd, async (msg) => {
        acks.push(msg);
        return true;
      });
      expect(acks).toHaveLength(1);
      expect(acks[0]?.status).toBe('rejected');
      expect(acks[0]?.reason).toBe(UNTRUSTED_REJECT);
    }

    // 2. Trusted secondary window (non-primary).
    system.setTrusted(true);
    system.setPrimary(false);
    for (const cmd of commands('secondary')) {
      const acks: CommandAckMessage[] = [];
      await system.router.dispatch(cmd, async (msg) => {
        acks.push(msg);
        return true;
      });
      expect(acks).toHaveLength(1);
      expect(acks[0]?.status).toBe('rejected');
      expect(acks[0]?.reason).toBe(SECONDARY_REJECT);
    }

    // 3. Untrusted secondary checks trust BEFORE primacy.
    system.setTrusted(false);
    system.setPrimary(false);
    const bothAcks: CommandAckMessage[] = [];
    await system.router.dispatch(
      { type: CMD_CANCEL, correlationId: 'both-untrusted-secondary', payload: { taskId: targetTaskId } },
      async (msg) => {
        bothAcks.push(msg);
        return true;
      }
    );
    expect(bothAcks[0]?.status).toBe('rejected');
    expect(bothAcks[0]?.reason).toBe(UNTRUSTED_REJECT);

    expect(system.executeCommandSpy).not.toHaveBeenCalled();
    expect(system.controlExecuteSpy).not.toHaveBeenCalled();
    expect(system.queue.findById(targetTaskId)?.status).toBe('in-flight');
    expect(await system.readAuditEntries()).toHaveLength(0);
  });

  it('deduplicates duplicate correlationId (in-flight join and replay cache) for concurrent CMD_CANCEL and workflow-cancel', async () => {
    const system = await createSystem(tmpRoot);
    activeSystem = system;

    const targetTaskId = await seedRunningTask(system, QUEUE_B, 'run-b-dedupe', 'dedupe task');

    // Hold `queue.finish` briefly on a controllable gate so a second dispatch
    // with the same `correlationId` genuinely joins the in-flight promise.
    const finishEntered = createDeferred<void>();
    const finishGate = createDeferred<void>();
    const origFinish = system.queue.finish.bind(system.queue);
    vi.spyOn(system.queue, 'finish').mockImplementationOnce(async (featureId, status, lastError) => {
      finishEntered.resolve();
      await finishGate.promise;
      return origFinish(featureId, status, lastError);
    });

    const firstAcks: CommandAckMessage[] = [];
    const joinedAcks: CommandAckMessage[] = [];
    const replayedAcks: CommandAckMessage[] = [];

    const firstDispatch = system.router.dispatch(
      { type: CMD_CANCEL, correlationId: 'dup-cancel-1', payload: { taskId: targetTaskId } },
      async (msg) => {
        firstAcks.push(msg);
        return true;
      }
    );

    await finishEntered.promise;

    const joinedDispatch = system.router.dispatch(
      { type: CMD_CANCEL, correlationId: 'dup-cancel-1', payload: { taskId: targetTaskId } },
      async (msg) => {
        joinedAcks.push(msg);
        return true;
      }
    );

    finishGate.resolve();
    await Promise.all([firstDispatch, joinedDispatch]);

    // Post-completion replay with the same correlationId.
    await system.router.dispatch(
      { type: CMD_CANCEL, correlationId: 'dup-cancel-1', payload: { taskId: targetTaskId } },
      async (msg) => {
        replayedAcks.push(msg);
        return true;
      }
    );

    expect(system.executeCommandSpy).toHaveBeenCalledTimes(1);
    expect(firstAcks).toHaveLength(1);
    expect(joinedAcks).toHaveLength(1);
    expect(replayedAcks).toHaveLength(1);
    expect(firstAcks[0]?.status).toBe('accepted');
    expect(joinedAcks[0]).toEqual(firstAcks[0]);
    expect(replayedAcks[0]).toEqual(firstAcks[0]);

    // Same replay guarantee for workflow-cancel `CMD_CONTINUE_WORKFLOW`.
    const wfCmd = makeWorkflowContinueCommand(
      'dup-wf-cancel-1',
      system.connectedRunId,
      system.getConnectedRun().revision,
      {
        controlCommand: {
          version: 1,
          commandId: '55555555-5555-4555-8555-555555555555',
          rootRunId: system.connectedRunId,
          queueId: QUEUE_B,
          invocationId: system.rootInvocationId,
          expectedGeneration: 0,
          action: { kind: 'cancel' }
        }
      }
    );
    const wfFirst: CommandAckMessage[] = [];
    const wfSecond: CommandAckMessage[] = [];
    await system.router.dispatch(wfCmd, async (msg) => {
      wfFirst.push(msg);
      return true;
    });
    await system.router.dispatch(wfCmd, async (msg) => {
      wfSecond.push(msg);
      return true;
    });
    expect(system.controlExecuteSpy).toHaveBeenCalledTimes(1);
    expect(wfFirst[0]?.status).toBe('accepted');
    expect(wfSecond[0]).toEqual(wfFirst[0]);
  });

  it('produces at most one terminal transition and zero stray task-canceled audit entries when concurrent CMD_CANCEL races same-task cancel, completion, or deletion', async () => {
    const system = await createSystem(tmpRoot);
    activeSystem = system;

    // Case A: Two concurrent `CMD_CANCEL` commands (distinct correlationIds) for the SAME task.
    const taskRaceCancel = await seedRunningTask(system, QUEUE_A, 'run-race-a', 'concurrent cancel race');
    const ackRace1: CommandAckMessage[] = [];
    const ackRace2: CommandAckMessage[] = [];
    await Promise.all([
      system.router.dispatch(
        { type: CMD_CANCEL, correlationId: 'race-cancel-1', payload: { taskId: taskRaceCancel } },
        async (msg) => {
          ackRace1.push(msg);
          return true;
        }
      ),
      system.router.dispatch(
        { type: CMD_CANCEL, correlationId: 'race-cancel-2', payload: { taskId: taskRaceCancel } },
        async (msg) => {
          ackRace2.push(msg);
          return true;
        }
      )
    ]);

    const raceStatuses = [ackRace1[0]?.status, ackRace2[0]?.status].sort();
    expect(raceStatuses).toEqual(['accepted', 'rejected']);
    expect(system.queue.findById(taskRaceCancel)?.status).toBe('canceled');
    expect(system.store.getRun(QUEUE_A)?.status).toBe('canceled');

    const auditsAfterCaseA = await system.readAuditEntries();
    expect(
      auditsAfterCaseA.filter(
        (entry) =>
          entry.eventType === 'task-canceled' &&
          (entry.payload as { taskId?: string }).taskId === taskRaceCancel
      )
    ).toHaveLength(1);

    // Case B: `CMD_CANCEL` suspended mid-flight while same-task completion wins first.
    const taskRaceComplete = await seedRunningTask(
      system,
      QUEUE_B,
      'run-race-complete',
      'cancel vs completion race'
    );
    const updateEntered = createDeferred<void>();
    const updateGate = createDeferred<void>();
    const origUpdateRun = system.store.updateRun.bind(system.store);
    vi.spyOn(system.store, 'updateRun').mockImplementationOnce(async (queueId, request, claim) => {
      updateEntered.resolve();
      await updateGate.promise;
      return origUpdateRun(queueId, request, claim);
    });

    const lostCancelAcks: CommandAckMessage[] = [];
    const cancelPromise = system.router.dispatch(
      { type: CMD_CANCEL, correlationId: 'race-vs-complete-1', payload: { taskId: taskRaceComplete } },
      async (msg) => {
        lostCancelAcks.push(msg);
        return true;
      }
    );

    await updateEntered.promise;
    // Complete the Run and Task before the suspended cancel resumes.
    await origUpdateRun(
      QUEUE_B,
      {
        runId: 'run-race-complete',
        allowedStatuses: ['running'],
        label: 'driver-transition',
        actor: 'driver',
        patch: (current) => ({ ...current, status: 'completed', lastTransitionAt: T0 + 10 })
      },
      unfencedCommit('test-fixture')
    );
    const completedResult = await system.queue.finish(taskRaceComplete, 'completed');
    expect(completedResult.ok).toBe(true);

    updateGate.resolve();
    await cancelPromise;

    expect(lostCancelAcks).toHaveLength(1);
    expect(lostCancelAcks[0]?.status).toBe('rejected');
    expect(system.queue.findById(taskRaceComplete)?.status).toBe('completed');
    expect(system.store.getRun(QUEUE_B)?.status).toBe('completed');

    const auditsAfterCaseB = await system.readAuditEntries();
    expect(
      auditsAfterCaseB.filter(
        (entry) =>
          entry.eventType === 'task-canceled' &&
          (entry.payload as { taskId?: string }).taskId === taskRaceComplete
      )
    ).toHaveLength(0);

    // Case C: `CMD_CANCEL` racing same-task deletion (`CMD_REMOVE_QUEUE_ITEM`).
    const taskRaceDelete = await system.queue.enqueue('cancel vs delete race', { queueId: QUEUE_A });
    const finishDeleteEntered = createDeferred<void>();
    const finishDeleteGate = createDeferred<void>();
    const origFinish = system.queue.finish.bind(system.queue);
    vi.spyOn(system.queue, 'finish').mockImplementationOnce(async (featureId, status, lastError) => {
      finishDeleteEntered.resolve();
      await finishDeleteGate.promise;
      return origFinish(featureId, status, lastError);
    });

    const cancelVsDeleteAcks: CommandAckMessage[] = [];
    const removeAcks: CommandAckMessage[] = [];
    const cancelDeletePromise = system.router.dispatch(
      { type: CMD_CANCEL, correlationId: 'race-vs-delete-cancel', payload: { taskId: taskRaceDelete.id } },
      async (msg) => {
        cancelVsDeleteAcks.push(msg);
        return true;
      }
    );

    await finishDeleteEntered.promise;
    await system.router.dispatch(
      {
        type: CMD_REMOVE_QUEUE_ITEM,
        correlationId: 'race-vs-delete-remove',
        payload: { id: taskRaceDelete.id, confirmed: true }
      },
      async (msg) => {
        removeAcks.push(msg);
        return true;
      }
    );

    finishDeleteGate.resolve();
    await cancelDeletePromise;

    expect(removeAcks[0]?.status).toBe('accepted');
    expect(cancelVsDeleteAcks[0]?.status).toBe('rejected');
    expect(system.queue.findById(taskRaceDelete.id)).toBeNull();

    const auditsAfterCaseC = await system.readAuditEntries();
    expect(
      auditsAfterCaseC.filter(
        (entry) =>
          entry.eventType === 'task-canceled' &&
          (entry.payload as { taskId?: string }).taskId === taskRaceDelete.id
      )
    ).toHaveLength(0);
  });

  it('keeps unserviced controlCommand cancel payloads serialized and fails closed without falling through to operation', async () => {
    const laneEntered = createDeferred<void>();
    const laneGate = createDeferred<{ readonly laneId: string; readonly laneRootRef: string } | null>();
    let connectedRunGets = 0;

    const system = await createSystem(tmpRoot, {
      omitControlCommandService: true,
      provisionRunLane: async () => {
        laneEntered.resolve();
        return laneGate.promise;
      },
      onConnectedRunGet: () => {
        connectedRunGets += 1;
      }
    });
    activeSystem = system;
    await system.queue.enqueue('hold start queue for unwired controlCommand test', {
      queueId: QUEUE_A
    });

    const startAcks: CommandAckMessage[] = [];
    const startPromise = system.router.dispatch(
      { type: CMD_START_QUEUE, correlationId: 'unwired-start', payload: { queueId: QUEUE_A } },
      async (msg) => {
        startAcks.push(msg);
        return true;
      }
    );
    await laneEntered.promise;

    let settled = false;
    const craftedAcks: CommandAckMessage[] = [];
    const craftedPromise = system.router
      .dispatch(
        {
          type: CMD_CONTINUE_WORKFLOW,
          correlationId: 'crafted-unwired-cancel-plus-resume',
          payload: {
            connectedRunId: system.connectedRunId,
            expectedRevision: 1,
            operation: 'resume',
            controlCommand: {
              version: 1,
              commandId: 'ctrl-unwired-1',
              correlationId: 'crafted-unwired-cancel-plus-resume',
              targetKind: 'candidate',
              targetId: 'cand-1',
              issuedBy: 'operator',
              issuedAtMs: T0,
              action: { kind: 'cancel' }
            }
          } as unknown as ContinueWorkflowCommand['payload']
        },
        async (msg) => {
          craftedAcks.push(msg);
          return true;
        }
      )
      .then(() => {
        settled = true;
      });

    // Yield microtasks & event-loop turns: crafted payload MUST wait behind slow mutation.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(connectedRunGets).toBe(0);

    laneGate.resolve(null);
    await Promise.all([startPromise, craftedPromise]);

    expect(startAcks[0]?.status).toBe('accepted');
    expect(craftedAcks).toHaveLength(1);
    expect(craftedAcks[0]?.status).toBe('rejected');
    expect(craftedAcks[0]?.result).toMatchObject({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    // Must NEVER fall through to connectedRuns / `operation: 'resume'`.
    expect(connectedRunGets).toBe(0);
  });
});
