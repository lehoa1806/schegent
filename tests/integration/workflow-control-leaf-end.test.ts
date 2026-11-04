// A Workflow's Pause and Cancel reach the process underneath them.
//
// Feature 262 requires both to stop the leaf ("interrupt the active leaf runner", "terminate the
// active leaf runner") and to touch one queue only. Those requirements live in the seams between
// the sidebar's control command, the control service, the controller and the driver's terminal
// funnel, so every one of those is real here: the command goes through `continueConnectedRun` with
// the hooks production builds, the leaf is a real `WorkflowRun` driven through the real driver, and
// the lease is a real `ExecutionLeaseManager`. Only the Claude CLI is fake.
//
// The clock is never advanced. Past the staleness threshold a rival can reclaim a queue no matter
// what this path released, and these tests would pass against a leak.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordConnectedWorkflowTransition } from '../../src/activation/run-safety-wiring';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { ContinueWorkflowResult } from '../../src/contracts/sidebar-ipc/workflow-run';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { QueueFailurePolicy } from '../../src/contracts/queue-failure-policy';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { createWorkflowFailureRetirement } from '../../src/controller/task-deletion';
import { createWorkflowLeafEnd } from '../../src/controller/workflow-leaf-end';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { createQueue } from '../../src/queue/queue-registry';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { InvocationRequest, RawInvocationOutput } from '../../src/runner/invocation-result';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { createHistoryRecorder } from '../../src/services/history-recorder';
import { validateRunRequest } from '../../src/services/run-request/run-request-validator';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { continueConnectedRun } from '../../src/services/workflow-execution/continuation-service';
import { launchComposableWorkflow } from '../../src/services/workflow-execution/workflow-launcher';
import {
  createWorkflowLeafControlHooks,
  createWorkflowQueueWake
} from '../../src/services/workflow-execution/workflow-leaf-control';
import {
  attemptsForNode,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { HistoryStore } from '../../src/state/history-store';
import { WorkspaceLockManager, type Clock, type Scheduler } from '../../src/state/lock';
import { unfencedCommit } from '../../src/state/ownership-claim';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { Notifier } from '../../src/ui/notifications';
import { isNodeStartable, projectConnectedRun } from '../../src/ui/sidebar/connected-run-projector';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';

const QUEUE_A = '11111111-2222-4333-8444-555555555555';
const QUEUE_B = '22222222-3333-4444-8555-666666666666';
const T0 = 1_700_000_000_000;

const FIRST_PHASE: PhaseDefinition = {
  phaseId: 'first-phase',
  name: 'First',
  version: 1,
  instruction: 'Do the first thing'
};

const SECOND_PHASE: PhaseDefinition = {
  phaseId: 'second-phase',
  name: 'Second',
  version: 1,
  instruction: 'Do the second thing'
};

const WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-two',
  name: 'Two',
  version: 1,
  startNodeIds: ['first'],
  nodes: [
    { nodeId: 'first', kind: 'phase', phaseId: 'first-phase' },
    { nodeId: 'second', kind: 'phase', phaseId: 'second-phase' }
  ],
  connections: [
    { from: { nodeId: 'first' }, to: { kind: 'node', nodeId: 'second' }, handoff: 'auto', priority: 0 },
    { from: { nodeId: 'second' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ]
};

/** `first` goes on to `second` either way, and a failure takes the recovery connection to get there. */
const WORKFLOW_WITH_RECOVERY: WorkflowDefinition = {
  ...WORKFLOW,
  workflowId: 'wf-recovery',
  connections: [
    {
      from: { nodeId: 'first' },
      to: { kind: 'node', nodeId: 'second' },
      handoff: 'auto',
      priority: 0,
      condition: {
        left: { source: 'node-status', nodeId: 'first' },
        operator: 'in',
        right: ['failed']
      }
    },
    { from: { nodeId: 'first' }, to: { kind: 'node', nodeId: 'second' }, handoff: 'auto', priority: 1 },
    { from: { nodeId: 'second' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ]
};

class FakeMemento implements Memento {
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

class FrozenClock implements Clock {
  now(): number {
    return T0;
  }
}

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

const cleanStdout = (phase: string): string =>
  [
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

const buffer = (text: string): ZippedStreamBuffer => {
  const output = new ZippedStreamBuffer();
  if (text.length > 0) output.append(text);
  output.finalize();
  return output;
};

/** Runs once, inside the matching CLI invocation, in the order the invocations happen. */
type CliStep = (request: InvocationRequest) => Promise<void>;

type ControlOperation = 'pause' | 'resume' | 'cancel' | 'retry-phase' | 'retry-invocation';

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function makeGate(): Gate {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function makeWorkspace(
  tmpRoot: string,
  options: { readonly failurePolicy?: QueueFailurePolicy } = {}
) {
  const logger = new SanitizedLogger();
  const warn = vi.spyOn(logger, 'warn');
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const auditAppend = vi.spyOn(audit, 'append');
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new FrozenClock();
  const lock = new WorkspaceLockManager(store, 'window-a', clock, noopScheduler);
  const leaseManager = new ExecutionLeaseManager(store, 'window-a', clock, noopScheduler);
  const released: string[] = [];
  const executionLease = {
    tryAcquire: (queueId: string) => leaseManager.tryAcquire(queueId),
    release: async (queueId: string) => {
      released.push(queueId);
      await leaseManager.release(queueId);
    },
    claimFor: (queueId: string) => leaseManager.claimFor(queueId),
    tenureOf: (queueId: string) => leaseManager.tenureOf(queueId),
    isForeignLeaseHeld: (queueId: string) => leaseManager.isForeignLeaseHeld(queueId)
  };
  const cliSteps: CliStep[] = [];
  const invoked: string[] = [];
  const signaled: boolean[] = [];
  const seams: {
    /** Times the next CLI call out, which fails its Phase outright rather than arming a retry. */
    timeOutNextCall: boolean;
    /** Runs once, between a leaf's end and the Workflow hearing about it. */
    beforeTerminal: (() => Promise<void>) | null;
  } = { timeOutNextCall: false, beforeTerminal: null };

  const invoke = vi.fn(async (request: InvocationRequest): Promise<RawInvocationOutput> => {
    invoked.push(request.phase);
    const step = cliSteps.shift();
    if (step !== undefined) {
      await step(request);
      signaled.push(request.cancellationSignal?.aborted === true);
    }
    // What the real runner reports for a child the signal reached.
    const killed = request.cancellationSignal?.aborted === true;
    const timedOut = seams.timeOutNextCall;
    seams.timeOutNextCall = false;
    return {
      stdoutBuffer: buffer(killed || timedOut ? '' : cleanStdout(request.phase)),
      stderrBuffer: buffer(''),
      exitCode: killed ? null : 0,
      killed,
      timedOut,
      durationMs: 1
    };
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

  const historyStore = new HistoryStore(store);
  const terminalTransitions = new TerminalTransitionCoordinator(
    store,
    queue,
    createHistoryRecorder({ historyStore, logger, queue, store, workspaceRoot: tmpRoot }),
    logger
  );
  const readPriorRunOutputs = (runId: string) => historyStore.outputsFor(runId);
  const guardedRun = new GuardedRunService({
    isWorkspaceTrusted: () => true,
    lock,
    queue,
    controller: { getCatalog: () => buildSpeckitCatalog() } as unknown as SchegentWorkflowController,
    logger,
    audit,
    store,
    clock: () => clock.now(),
    catalogProvider: () => buildSpeckitCatalog()
  });
  const wiring = {
    workspaceRoot: tmpRoot,
    store,
    logger,
    historyStore,
    getGuardedRun: () => guardedRun
  };

  const controller = new SchegentWorkflowController(
    new PhaseRunner(runner, new PromptBuilder(), audit, logger),
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    {
      catalog: buildSpeckitCatalog(),
      getQueueFailurePolicyDefault: () => options.failurePolicy ?? 'halt-on-failure',
      onRunTerminal: async (run: WorkflowRun) => {
        const beforeTerminal = seams.beforeTerminal;
        seams.beforeTerminal = null;
        if (beforeTerminal !== null) await beforeTerminal();
        await recordConnectedWorkflowTransition(wiring, run);
      },
      terminalTransitions,
      executionLease
    }
  );
  const hooks = createWorkflowLeafControlHooks({
    controller,
    logger,
    store,
    executionLease,
    endLeaf: createWorkflowLeafEnd({
      logger,
      queue,
      store,
      controller,
      executionLease,
      terminalTransitions,
      audit
    })
  });
  const wakeWorkflowQueue = createWorkflowQueueWake({ controller, logger });
  const retireWorkflowFailures = createWorkflowFailureRetirement({ queue, audit, logger });

  let registry = store.getQueueRegistry();
  registry = createQueue(registry, { id: QUEUE_A, name: 'Queue A', now: T0 });
  registry = createQueue(registry, { id: QUEUE_B, name: 'Queue B', now: T0 });
  await store.setQueueRegistry(registry);
  await store.setGlobalConcurrencyCap(3);

  const launch = async (
    runId: string,
    queueId: string,
    rootWorkflow: WorkflowDefinition = WORKFLOW
  ): Promise<void> => {
    const validated = await validateRunRequest(
      {
        pipelineId: rootWorkflow.workflowId,
        workflowId: rootWorkflow.workflowId,
        entryNodeId: 'first',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      {
        workflow: {
          rootWorkflow,
          workflows: [rootWorkflow],
          phases: [FIRST_PHASE, SECOND_PHASE]
        },
        workspaceRoot: tmpRoot,
        now: T0,
        localInputs: {
          checkFile: () => Promise.resolve({ ok: true }),
          checkFolder: () => Promise.resolve({ ok: true })
        },
        outputProbe: { exists: () => Promise.resolve(false) },
        priorOutputs: historyStore
      }
    );
    if (!validated.ok) throw new Error(`expected a valid launch: ${JSON.stringify(validated.errors)}`);
    const launched = await launchComposableWorkflow(
      {
        guardedRun,
        logger,
        connectedRuns: store,
        isChildSettled: () => true,
        readPriorRunOutputs
      },
      {
        connectedRunId: runId,
        envelope: validated.plan,
        workspaceRoot: tmpRoot,
        startedAt: T0,
        queueId
      }
    );
    if (launched.outcome !== 'started') throw new Error(`launch refused: ${launched.outcome}`);
  };

  const connectedRun = (runId: string): ConnectedWorkflowRun => {
    const run = store.getConnectedRun(runId);
    if (run === null) throw new Error(`expected connected run ${runId}`);
    return run;
  };

  const control = (
    runId: string,
    operation: ControlOperation,
    nodeId = 'first'
  ): Promise<ContinueWorkflowResult> =>
    continueConnectedRun(
      {
        guardedRun,
        logger,
        readPriorRunOutputs,
        connectedRuns: {
          get: (id: string) => store.getConnectedRun(id),
          compareAndSetConnectedRun: (next: ConnectedWorkflowRun, expected: number) =>
            store.compareAndSetConnectedRun(next, expected),
          readChildState: () => null
        },
        projectRun: projectConnectedRun,
        isNodeStartable,
        workflowControlHooks: hooks,
        wakeWorkflowQueue,
        retireWorkflowFailures
      },
      {
        payload: {
          connectedRunId: runId,
          expectedRevision: connectedRun(runId).revision,
          nodeId,
          invocationId: `${runId}:root`,
          operation,
          request: { pipelineId: 'first-phase', inputs: [], supplemental: [], outputs: [] }
        },
        workspaceRoot: tmpRoot,
        startedAt: T0
      }
    );

  const rootFrame = (runId: string) => {
    const frame = Object.values(connectedRun(runId).invocations ?? {}).find(
      (candidate) => candidate.invocationId === `${runId}:root`
    );
    if (frame === undefined) throw new Error('expected a root frame');
    return frame;
  };

  const attemptAt = (runId: string, nodeId: string, index: number) => {
    const attempt = attemptsForNode(rootFrame(runId), nodeId).at(index);
    if (attempt === undefined) throw new Error(`expected attempt ${index} of ${nodeId}`);
    return attempt;
  };

  const leafTask = (runId: string, nodeId = 'first', index = 0): string => {
    const taskId = attemptAt(runId, nodeId, index).queueItemId;
    if (taskId === undefined) throw new Error('expected a queue row on the attempt');
    return taskId;
  };

  const markStarted = async (queueId: string): Promise<void> => {
    const applied = await guardedRun.applyStartQueueIntent(
      { startMode: 'now', source: 'operator-restart' },
      { queueId }
    );
    if (applied.outcome !== 'applied') throw new Error(`start refused: ${applied.outcome}`);
  };

  /** The Start press: the lifecycle moves first, and the command then offers the queue its work. */
  const pressStart = async (queueId: string): Promise<void> => {
    await markStarted(queueId);
    await controller.drainQueuedWork(queueId);
  };

  /** A leaf with no driver: the row in flight and the lease held, waiting out a backoff. */
  const seedBackoffLeaf = async (runId: string, queueId: string): Promise<string> => {
    const taskId = leafTask(runId);
    const acquired = await leaseManager.tryAcquire(queueId);
    if (!acquired.acquired) throw new Error('expected to acquire the queue');
    await queue.markInFlight(taskId, `leaf-of-${taskId}`);
    const leaf: WorkflowRun = {
      id: `leaf-of-${taskId}`,
      featureId: taskId,
      featureDir: 'specs/000',
      status: 'paused',
      currentPhase: 'first-phase',
      currentIteration: 1,
      startedAt: T0,
      lastTransitionAt: T0,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 1,
      pendingRetryAt: T0 + 60_000,
      pendingRetryCause: 'rate_limit',
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    };
    await store.setRun(queueId, leaf, unfencedCommit('test-fixture'));
    return taskId;
  };

  const rivalWindow = async (): Promise<ExecutionLeaseManager> => {
    const rivalStore = new WorkspaceStateStore(memento);
    await rivalStore.initialize();
    return new ExecutionLeaseManager(rivalStore, 'window-b', new FrozenClock(), noopScheduler);
  };

  /** A silent failure of any seam on this path says so here. */
  const leafWarnings = (): readonly string[] =>
    warn.mock.calls
      .map((call) => String(call.at(0)))
      .filter((text) => /workflow-leaf|routing record|recovery failed/.test(text));

  const auditPayloads = (eventType: string): readonly unknown[] =>
    auditAppend.mock.calls
      .map((call) => call.at(0))
      .filter((entry) => entry?.eventType === eventType)
      .map((entry) => entry?.payload);

  return {
    store,
    queue,
    historyStore,
    auditPayloads,
    guardedRun,
    controller,
    leaseManager,
    released,
    cliSteps,
    invoked,
    signaled,
    seams,
    launch,
    connectedRun,
    control,
    rootFrame,
    attemptAt,
    leafTask,
    pressStart,
    markStarted,
    seedBackoffLeaf,
    rivalWindow,
    leafWarnings
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'schegent-workflow-control-leaf-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('one Start press', () => {
  // Spec 261 FR-007: an `auto` connection advances on its own. The queue has run out of rows by the
  // time the next node is dispatched, because the driver finishes a leaf's row first.
  it('runs every node in order and gives the queue back', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);

    await w.pressStart(QUEUE_A);
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase', 'second-phase']);
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('completed');
    expect(w.attemptAt('crun-a', 'second', 0).status).toBe('completed');
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('active-empty');
    expect(w.leaseManager.isHeld(QUEUE_A)).toBe(false);
    expect(w.leafWarnings()).toEqual([]);
  });

  it('still does not start a first launch by itself', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);

    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual([]);
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('idle-pending');
    expect(w.queue.findById(w.leafTask('crun-a'))?.status).toBe('pending');
  });

  it('holds a Resume on a queue waiting for its Start, and the Start runs it', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    w.cliSteps.push(async () => {
      await w.control('crun-a', 'pause');
    });
    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();
    await w.guardedRun.scheduleOrEnqueue({
      description: 'an operator Task, held for its Start',
      scheduledAt: T0,
      via: 'webview',
      queueId: QUEUE_A
    });
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('idle-pending');

    await expect(w.control('crun-a', 'resume')).resolves.toMatchObject({ outcome: 'started' });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase']);
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('idle-pending');
    expect(w.queue.findById(w.leafTask('crun-a', 'first', 1))?.status).toBe('pending');

    await w.pressStart(QUEUE_A);
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(w.invoked.filter((phase) => phase === 'second-phase')).toEqual(['second-phase']);
    expect(w.leafWarnings()).toEqual([]);
  });
});

// A queue pause never ends a Workflow. New work is refused while it lasts, but the next node of a
// Workflow already on the queue is not new work: it waits behind the pause with everything else.
describe('a queue pause', () => {
  const pauseQueue = async (w: Awaited<ReturnType<typeof makeWorkspace>>): Promise<void> => {
    await w.queue.setQueuePausedState(true, QUEUE_A, 'operator-paused', 'operator');
  };

  /** The pause holds the next node back, and the Workflow is alive and waiting to go on. */
  const expectNextNodeBehindThePause = (w: Awaited<ReturnType<typeof makeWorkspace>>): void => {
    expect(w.rootFrame('crun-a').status).toBe('in-flight');
    expect(w.invoked).toEqual(['first-phase']);
    expect(w.attemptAt('crun-a', 'second', 0).status).toBe('in-flight');
    expect(w.queue.findById(w.leafTask('crun-a', 'second'))?.status).toBe('pending');
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('operator-paused');
  };

  /** A queue Resume with rows waiting lands on the Start hold, as it does for any Task (FR-019). */
  const expectTheStartToFinishIt = async (
    w: Awaited<ReturnType<typeof makeWorkspace>>
  ): Promise<void> => {
    await w.queue.setQueuePausedState(false, QUEUE_A, null, 'operator');
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('idle-pending');

    await w.pressStart(QUEUE_A);
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase', 'second-phase']);
    expect(w.leafWarnings()).toEqual([]);
  };

  it('holds the leaf at its boundary, and only its own Resume carries the Workflow on', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = w.leafTask('crun-a');
    w.cliSteps.push(() => pauseQueue(w));

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.queue.findById(taskId)?.status).toBe('paused');
    expect(w.store.getRun(QUEUE_A)?.status).toBe('paused');
    expect(w.store.getRun(QUEUE_A)?.manualPauseCause).toBe('queue-paused-mid-run');
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('in-flight');
    expect(w.rootFrame('crun-a').status).toBe('in-flight');
    expect(w.invoked).toEqual(['first-phase']);
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('operator-paused');
    expect(w.leaseManager.isHeld(QUEUE_A)).toBe(true);

    // The queue's Resume frees the queue and leaves a leaf the driver has already paused where it is.
    await w.queue.setQueuePausedState(false, QUEUE_A, null, 'operator');
    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();
    expect(w.store.getRun(QUEUE_A)?.status).toBe('paused');
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('active-empty');

    await expect(w.controller.resumeExisting(QUEUE_A)).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase', 'second-phase']);
    expect(w.leaseManager.isHeld(QUEUE_A)).toBe(false);
    expect(w.leafWarnings()).toEqual([]);
  });

  it("does not fail the Workflow when the leaf's own Resume finishes it inside the pause", async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    w.cliSteps.push(() => pauseQueue(w));
    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    await expect(w.controller.resumeExisting(QUEUE_A)).resolves.toBe(true);
    await w.controller.drainedRunsSettled();

    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('completed');
    expectNextNodeBehindThePause(w);
    await expectTheStartToFinishIt(w);
  });

  // Under `continue`, because this is about the pause: on the default policy the failed row holds
  // the queue on its own, which the failure policy tests below pin.
  it('does not lose the recovery connection when a leaf fails inside the pause', async () => {
    const w = await makeWorkspace(tmpRoot, { failurePolicy: 'continue' });
    await w.launch('crun-a', QUEUE_A, WORKFLOW_WITH_RECOVERY);
    w.seams.timeOutNextCall = true;
    w.cliSteps.push(() => pauseQueue(w));

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('failed');
    expectNextNodeBehindThePause(w);
    await expectTheStartToFinishIt(w);
  });

  it('does not fail the Workflow when it lands between a leaf finishing and being recorded', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    w.seams.beforeTerminal = () => pauseQueue(w);

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('completed');
    expectNextNodeBehindThePause(w);
    await expectTheStartToFinishIt(w);
  });

  it('still refuses new work while it lasts', async () => {
    const w = await makeWorkspace(tmpRoot);
    await pauseQueue(w);

    await expect(
      w.guardedRun.scheduleOrEnqueue({
        description: 'an operator Task',
        scheduledAt: T0,
        via: 'webview',
        queueId: QUEUE_A
      })
    ).resolves.toMatchObject({ outcome: 'rejected-paused' });
  });

  it("accepts a Workflow's Resume, whose new attempt waits behind the pause", async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    w.cliSteps.push(async () => {
      await w.control('crun-a', 'pause');
    });
    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();
    await pauseQueue(w);

    await expect(w.control('crun-a', 'resume')).resolves.toMatchObject({ outcome: 'started' });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase']);
    expect(w.queue.findById(w.leafTask('crun-a', 'first', 1))?.status).toBe('pending');
    expect(w.store.getQueue(QUEUE_A).queueLifecycle).toBe('operator-paused');

    await w.queue.setQueuePausedState(false, QUEUE_A, null, 'operator');
    await w.pressStart(QUEUE_A);
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase', 'first-phase', 'second-phase']);
    expect(w.leafWarnings()).toEqual([]);
  });
});

// `halt-on-failure` is the product default (feature 195): a `failed` row refuses every later start
// on its queue until the operator deals with it. A Workflow's Retry is the operator dealing with it.
// A recovery connection is not: it is automatic, and the halt exists to stop unattended work.
describe('a failed leaf and the queue failure policy', () => {
  const failTheFirstLeaf = async (
    w: Awaited<ReturnType<typeof makeWorkspace>>,
    rootWorkflow: WorkflowDefinition = WORKFLOW
  ): Promise<string> => {
    await w.launch('crun-a', QUEUE_A, rootWorkflow);
    w.seams.timeOutNextCall = true;
    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();
    const attempt = w.attemptAt('crun-a', 'first', 0);
    expect(attempt.status).toBe('failed');
    if (attempt.queueItemId === undefined) throw new Error('the failed attempt has no queue row');
    return attempt.queueItemId;
  };

  const expectTheWorkflowToFinish = async (
    w: Awaited<ReturnType<typeof makeWorkspace>>
  ): Promise<void> => {
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();
    expect(w.leafWarnings()).toEqual([]);
  };

  it.each([
    ['halt-on-failure', 'retry-phase'],
    ['halt-on-failure', 'retry-invocation'],
    ['continue', 'retry-phase'],
    ['continue', 'retry-invocation']
  ] as const)(
    'under %s, %s runs on its own and retires the failed row it answers',
    async (failurePolicy, operation) => {
      const w = await makeWorkspace(tmpRoot, { failurePolicy });
      const failedRow = await failTheFirstLeaf(w);
      expect(w.rootFrame('crun-a').status).toBe('failed');

      await expect(w.control('crun-a', operation)).resolves.toMatchObject({ outcome: 'started' });
      await expectTheWorkflowToFinish(w);

      expect(w.invoked).toEqual(['first-phase', 'first-phase', 'second-phase']);
      expect(w.attemptAt('crun-a', 'first', 0).status).toBe('failed');
      expect(w.attemptAt('crun-a', 'first', 1).status).toBe('completed');
      expect(w.queue.findById(failedRow)).toBeNull();
      expect(w.auditPayloads('task-removed')).toEqual([
        expect.objectContaining({
          taskId: failedRow,
          queueId: QUEUE_A,
          priorStatus: 'failed',
          cause: 'workflow-retry'
        })
      ]);
      // The row leaves the queue; the truth of the failure stays on the attempt and in history.
      const recorded = w.historyStore.list().find((entry) => entry.featureId === failedRow);
      expect(recorded?.terminalStatus).toBe('failed');
    }
  );

  it("still halts on a failure that is not the Workflow's own", async () => {
    const w = await makeWorkspace(tmpRoot);
    const failedRow = await failTheFirstLeaf(w);
    const other = await w.queue.enqueue('an unrelated Task', { queueId: QUEUE_A });
    await w.queue.markInFlight(other.id, 'run-of-the-unrelated-task');
    await w.queue.finish(other.id, 'failed');

    await expect(w.control('crun-a', 'retry-phase')).resolves.toMatchObject({ outcome: 'started' });
    await w.controller.drainedRunsSettled();

    expect(w.queue.findById(failedRow)).toBeNull();
    expect(w.queue.findById(other.id)?.status).toBe('failed');
    expect(w.attemptAt('crun-a', 'first', 1).status).toBe('in-flight');
    expect(w.queue.findById(w.leafTask('crun-a', 'first', 1))?.status).toBe('pending');
    expect(w.invoked).toEqual(['first-phase']);
  });

  // Feature 195's rule as it stands. Whether a Workflow's own recovery connection should count as
  // dealing with the failed row is the operator's product decision, and changing it would amend
  // that feature's contract.
  it('keeps a recovery connection behind the halt, until the failed row is answered', async () => {
    const w = await makeWorkspace(tmpRoot);
    const failedRow = await failTheFirstLeaf(w, WORKFLOW_WITH_RECOVERY);

    expect(w.rootFrame('crun-a').status).toBe('in-flight');
    expect(w.attemptAt('crun-a', 'second', 0).status).toBe('in-flight');
    expect(w.queue.findById(w.leafTask('crun-a', 'second', 0))?.status).toBe('pending');
    expect(w.invoked).toEqual(['first-phase']);

    await expect(w.queue.attestCompleted(failedRow)).resolves.toMatchObject({ ok: true });
    await w.controller.drainQueuedWork(QUEUE_A);
    await expectTheWorkflowToFinish(w);

    expect(w.invoked).toEqual(['first-phase', 'second-phase']);
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('failed');
  });

  it('runs a recovery connection on its own under `continue`', async () => {
    const w = await makeWorkspace(tmpRoot, { failurePolicy: 'continue' });
    await failTheFirstLeaf(w, WORKFLOW_WITH_RECOVERY);
    await expectTheWorkflowToFinish(w);

    expect(w.invoked).toEqual(['first-phase', 'second-phase']);
  });

  it("refuses the queue's own Retry of a row whose attempt has ended, since nothing would read it", async () => {
    const w = await makeWorkspace(tmpRoot);
    const failedRow = await failTheFirstLeaf(w);

    await expect(w.queue.retry(failedRow)).resolves.toEqual({
      ok: false,
      reason: 'workflow-attempt-ended'
    });
    await w.controller.drainQueuedWork(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.queue.findById(failedRow)?.status).toBe('failed');
    expect(w.invoked).toEqual(['first-phase']);
  });
});

describe('Cancel', () => {
  it('signals the child, ends the leaf and the Workflow, and gives the queue back once', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = w.leafTask('crun-a');
    const answers: ContinueWorkflowResult[] = [];
    w.cliSteps.push(async () => {
      answers.push(await w.control('crun-a', 'cancel'));
    });

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(answers.map((answer) => answer.outcome)).toEqual(['started']);
    expect(w.signaled).toEqual([true]);
    expect(w.store.getRun(QUEUE_A)?.status).toBe('canceled');
    expect(w.queue.findById(taskId)?.status).toBe('canceled');
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('canceled');
    expect(w.rootFrame('crun-a').status).toBe('canceled');
    expect(attemptsForNode(w.rootFrame('crun-a'), 'second')).toEqual([]);
    expect(w.released).toEqual([QUEUE_A]);
    expect(w.leaseManager.isHeld(QUEUE_A)).toBe(false);
    const rival = await w.rivalWindow();
    await expect(rival.tryAcquire(QUEUE_A)).resolves.toMatchObject({ acquired: true });
    expect(w.leafWarnings()).toEqual([]);
  });

  it('survives the leaf ending while the command is still being applied', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const answers: Promise<ContinueWorkflowResult>[] = [];
    w.cliSteps.push(() => {
      // Not awaited: the CLI returns while the command is in the serial tail.
      answers.push(w.control('crun-a', 'cancel'));
      return Promise.resolve();
    });

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();
    await Promise.all(answers);
    await w.controller.drainedRunsSettled();

    expect(w.rootFrame('crun-a').status).toBe('canceled');
    expect(w.released).toEqual([QUEUE_A]);
    expect(w.leaseManager.isHeld(QUEUE_A)).toBe(false);
    expect(w.leafWarnings()).toEqual([]);
  });

  it('cancels a leaf still waiting in the queue, so a later drain cannot start it', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = w.leafTask('crun-a');

    await expect(w.control('crun-a', 'cancel')).resolves.toMatchObject({ outcome: 'started' });
    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(w.queue.findById(taskId)?.status).toBe('canceled');
    expect(w.invoked).toEqual([]);
    expect(w.released).toEqual([]);
    expect(w.rootFrame('crun-a').status).toBe('canceled');
    expect(w.leafWarnings()).toEqual([]);
  });

  it('settles a leaf waiting out a backoff, and the queue moves on to its next Task', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = await w.seedBackoffLeaf('crun-a', QUEUE_A);
    await w.markStarted(QUEUE_A);
    const next = await w.queue.enqueue('the next Task', { queueId: QUEUE_A });
    const releasedWhenNextStarted: string[][] = [];
    w.cliSteps.push(() => {
      releasedWhenNextStarted.push([...w.released]);
      return Promise.resolve();
    });

    await expect(w.control('crun-a', 'cancel')).resolves.toMatchObject({ outcome: 'started' });
    await vi.waitFor(() => {
      expect(w.queue.findById(next.id)?.status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(releasedWhenNextStarted).toEqual([[QUEUE_A]]);
    expect(w.queue.findById(taskId)?.status).toBe('canceled');
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('canceled');
    expect(w.rootFrame('crun-a').status).toBe('canceled');
    expect(w.leafWarnings()).toEqual([]);
  });

  it("does not touch an unrelated Task the queue is driving ahead of the leaf's row", async () => {
    const w = await makeWorkspace(tmpRoot);
    const ahead = await w.queue.enqueue('ahead of the Workflow', { queueId: QUEUE_A });
    await w.launch('crun-a', QUEUE_A);
    const taskId = w.leafTask('crun-a');
    const answers: ContinueWorkflowResult[] = [];
    w.cliSteps.push(async () => {
      answers.push(await w.control('crun-a', 'cancel'));
    });

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(answers.map((answer) => answer.outcome)).toEqual(['started']);
    expect(w.signaled).toEqual([false]);
    expect(w.queue.findById(ahead.id)?.status).toBe('completed');
    expect(w.queue.findById(taskId)?.status).toBe('canceled');
    expect(w.leafWarnings()).toEqual([]);
  });
});

describe('Pause', () => {
  it('stops the child, and Resume starts a new attempt that carries the Workflow to its end', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = w.leafTask('crun-a');
    const answers: ContinueWorkflowResult[] = [];
    w.cliSteps.push(async () => {
      answers.push(await w.control('crun-a', 'pause'));
    });

    await w.pressStart(QUEUE_A);
    await w.controller.drainedRunsSettled();

    expect(answers.map((answer) => answer.outcome)).toEqual(['started']);
    expect(w.signaled).toEqual([true]);
    expect(w.store.getRun(QUEUE_A)?.status).toBe('canceled');
    expect(w.queue.findById(taskId)?.status).toBe('canceled');
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('paused');
    expect(w.rootFrame('crun-a').status).toBe('paused');
    expect(w.invoked).toEqual(['first-phase']);

    await expect(w.control('crun-a', 'resume')).resolves.toMatchObject({ outcome: 'started' });
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-a').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();

    expect(w.invoked).toEqual(['first-phase', 'first-phase', 'second-phase']);
    expect(w.attemptAt('crun-a', 'first', 1).status).toBe('completed');
    expect(w.attemptAt('crun-a', 'second', 0).status).toBe('completed');
    expect(w.leaseManager.isHeld(QUEUE_A)).toBe(false);
    expect(w.leafWarnings()).toEqual([]);
  });

  it('settles a leaf with no driver, and offers the queue nothing while the Workflow is paused', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = await w.seedBackoffLeaf('crun-a', QUEUE_A);
    await w.markStarted(QUEUE_A);
    const next = await w.queue.enqueue('the next Task', { queueId: QUEUE_A });

    await expect(w.control('crun-a', 'pause')).resolves.toMatchObject({ outcome: 'started' });
    await w.controller.drainedRunsSettled();

    expect(w.queue.findById(taskId)?.status).toBe('canceled');
    expect(w.store.getRun(QUEUE_A)?.status).toBe('canceled');
    expect(w.attemptAt('crun-a', 'first', 0).status).toBe('paused');
    expect(w.released).toEqual([QUEUE_A]);
    expect(w.queue.findById(next.id)?.status).toBe('pending');
    expect(w.invoked).toEqual([]);
    expect(w.leafWarnings()).toEqual([]);
  });
});

describe('one queue only', () => {
  it('leaves a sibling queue running the same Workflow with the same node ids alone', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    await w.launch('crun-b', QUEUE_B);
    const taskA = w.leafTask('crun-a');
    const taskB = w.leafTask('crun-b');
    const siblingInCli = makeGate();
    const letSiblingFinish = makeGate();
    const answers: ContinueWorkflowResult[] = [];
    let siblingRevision = -1;

    w.cliSteps.push(async () => {
      await w.pressStart(QUEUE_B);
      await siblingInCli.opened;
      siblingRevision = w.connectedRun('crun-b').revision;
      answers.push(await w.control('crun-a', 'cancel'));
    });
    w.cliSteps.push(async () => {
      siblingInCli.open();
      await letSiblingFinish.opened;
    });

    await w.pressStart(QUEUE_A);
    await vi.waitFor(() => {
      expect(w.store.getRun(QUEUE_A)?.status).toBe('canceled');
      expect(w.released).toEqual([QUEUE_A]);
    });

    expect(answers.map((answer) => answer.outcome)).toEqual(['started']);
    expect(w.queue.findById(taskA)?.status).toBe('canceled');
    expect(w.queue.findById(taskB)?.status).toBe('in-flight');
    expect(w.store.getRun(QUEUE_B)?.featureId).toBe(taskB);
    expect(w.leaseManager.isHeld(QUEUE_B)).toBe(true);
    expect(w.connectedRun('crun-b').revision).toBe(siblingRevision);
    expect(w.attemptAt('crun-b', 'first', 0).status).toBe('in-flight');
    expect(w.rootFrame('crun-b').status).toBe('in-flight');

    letSiblingFinish.open();
    await vi.waitFor(() => {
      expect(w.rootFrame('crun-b').status).toBe('completed');
    });
    await w.controller.drainedRunsSettled();
    expect(w.signaled).toEqual([true, false]);
    expect(w.leafWarnings()).toEqual([]);
  });
});

describe('a queue lost to a rival', () => {
  it('refuses the command and writes nothing', async () => {
    const w = await makeWorkspace(tmpRoot);
    await w.launch('crun-a', QUEUE_A);
    const taskId = w.leafTask('crun-a');
    const before = w.connectedRun('crun-a').revision;
    await expect(w.leaseManager.tryAcquire(QUEUE_A)).resolves.toMatchObject({ acquired: true });
    w.leaseManager.markLost(QUEUE_A, 'superseded');

    await expect(w.control('crun-a', 'cancel')).resolves.toMatchObject({
      outcome: 'rejected-state'
    });

    expect(w.queue.findById(taskId)?.status).toBe('pending');
    expect(w.connectedRun('crun-a').revision).toBe(before);
    expect(w.rootFrame('crun-a').status).not.toBe('canceled');
    expect(w.leafWarnings()).toEqual([]);
  });
});
