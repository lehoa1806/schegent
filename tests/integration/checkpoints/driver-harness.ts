// FR-R3-004 — the shared harness for the three checkpoint fixtures.
//
// The unit suites beside `run-checkpoint-service.ts` open and close the ledger's
// phase windows by hand. That is the right shape for a decision table, and it is
// the wrong shape for the claim these three fixtures make, because it cannot
// catch the one defect that matters most: a bracket that is simply not attached.
// `RunDriver.dispatchObserved` is what feeds the ledger and
// `RunDriver`'s pre-dispatch branch is what asks for a checkpoint, so both live
// here, real, on a real git repository.
//
// Only two things are doubled. The phase runner does not spawn a CLI — it parks
// at a gate the test steps, and on release performs the phase's scripted write —
// and the workspace lock is inert, because primacy is FR-028's subject and not
// this one's.
//
// **Determinism.** Every invocation parks; `step(runId)` releases exactly one of
// that Run's parked invocations. Nothing here sleeps, and no assertion depends on
// one Run being faster than another — a sleep-calibrated concurrency fixture
// passes on an idle laptop and flakes under suite contention, which is the worst
// failure mode for a suite whose whole subject is interleaving.

import { vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PhaseDef } from '../../../src/config/pipeline-config';
import { SanitizedLogger } from '../../../src/lib/logger';
import { buildMutationPlan } from '../../../src/services/mutation-plan';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import { RunDriver, type RunDriverDeps } from '../../../src/services/run-driver';
import { HistoryRecorder } from '../../../src/services/history-recorder';
import { HistoryStore } from '../../../src/state/history-store';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { isTerminalRunStatus, type WorkflowRun } from '../../../src/state/workflow-run';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { removeTempRoot } from '../../temp-root-cleanup';

export const git = promisify(execFile);

/** Registry ids need a real v4 shape — `isValidQueueId` enforces it. */
export const QUEUE_A = DEFAULT_QUEUE_ID;
export const QUEUE_B = '22222222-3333-4444-8555-666666666666';

const NOW = 1_700_000_000_000;

/**
 * Three phases, and the middle one is load-bearing.
 *
 * Without it, a Run's write phase closes and the driver walks straight into the
 * Git-capable phase in the same async turn, so the checkpoint is taken before the
 * sibling has been released to write anything — and the fixture would assert
 * scoping against a tree with only one Run's work in it, which the sole-run path
 * also satisfies. `settle` gives the test a place to stand between "both Runs
 * have written" and "either Run checkpoints".
 */
const WRITE: PhaseDef = {
  id: 'write-work',
  name: 'Write work',
  version: 1,
  instruction: 'Write this Run s file.',
  sideEffects: 'workspace'
};
const SETTLE: PhaseDef = {
  id: 'settle',
  name: 'Settle',
  version: 1,
  instruction: 'Do nothing observable.',
  sideEffects: 'workspace'
};
const LAND: PhaseDef = {
  id: 'land-work',
  name: 'Land work',
  version: 1,
  instruction: 'Commit.',
  sideEffects: 'git'
};

export const GIT_PHASE_ID = LAND.id;

const PIPELINE = {
  id: 'checkpoint-flow',
  name: 'Checkpoint Flow',
  phases: [WRITE, SETTLE, LAND] as readonly PhaseDef[]
};

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

/**
 * A phase result the sequencer reads as a clean advance, carrying the audit
 * record a real invocation would have produced.
 *
 * The `auditEntry` is not decoration: FR-R3-004 attributes a tree change to the
 * Run whose audit record names the path, so a runner double that returned `null`
 * here would be modelling a CLI that reported nothing — and every checkpoint
 * would decline for want of evidence rather than for want of the bracket.
 */
const cleanOutput = (declaredPaths: readonly string[]): PhaseRunOutput =>
  ({
    result: {
      kind: 'clean',
      warnings: [],
      auditEntry: {
        phase: 'phase',
        filesCreated: declaredPaths,
        filesModified: [],
        filesDeleted: []
      }
    },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    warnings: [],
    auditEntryId: null
  }) as unknown as PhaseRunOutput;

interface Parked {
  readonly runId: string;
  readonly phase: string;
  readonly release: () => void;
}

export interface StartedRun {
  readonly runId: string;
  readonly queueId: string;
  readonly completed: Promise<void>;
}

export interface StartOptions {
  /**
   * Whether this Run's write phase puts a file in the tree. `false` gives a Run
   * that is genuinely in flight and observed end to end while holding nothing —
   * the state that separates "a sibling exists" from "a sibling has work here".
   */
  readonly writes?: boolean;
}

export interface CheckpointDriveHarness {
  readonly workspaceRoot: string;
  readonly storageRoot: string;
  readonly store: WorkspaceStateStore;
  readonly ledger: RunMutationLedger;
  readonly checkpoints: RunCheckpointService;
  readonly warnings: string[];
  /** Every invocation the runner saw, in dispatch order. */
  readonly invocations: ReadonlyArray<{ runId: string; phase: string }>;
  /** Admit and drive a Run whose phases are write → settle → land (Git-capable). */
  start(queueId: string, runId: string, options?: StartOptions): StartedRun;
  /** Wait until this Run has an invocation parked at the gate. */
  atGate(runId: string, phase?: string): Promise<void>;
  /** Release exactly one of this Run's parked invocations. */
  step(runId: string): void;
  /** Stop gating and release everything parked — let the Runs finish. */
  openGate(): void;
  /** Write a file nobody's phase wrote, as an operator or a stray process would. */
  write(relative: string, body: string): Promise<void>;
  head(): Promise<string>;
  wholeTreeDiff(): Promise<string>;
  runRoot(runId: string): string;
  artifacts(runId: string): Promise<readonly string[]>;
  patch(runId: string): Promise<string | null>;
  metadata(runId: string): Promise<Record<string, unknown> | null>;
  decline(runId: string): Promise<Record<string, unknown> | null>;
  dispose(): Promise<void>;
}

export async function makeDriveHarness(): Promise<CheckpointDriveHarness> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cp-work-'));
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cp-store-'));
  await git('git', ['init', '-q'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
  await git('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspaceRoot });

  const warnings: string[] = [];
  const logger = new SanitizedLogger([]);
  vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
    warnings.push(message);
  });

  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const history = new HistoryStore(store);

  // The store refuses a Run on a queue the registry does not know, and the whole
  // point of this harness is two Runs on two queues.
  const registry = store.getQueueRegistry();
  await store.setQueueRegistry({
    entries: [
      ...registry.entries,
      {
        id: QUEUE_B,
        name: 'Queue B',
        position: registry.entries.length,
        schedule: null,
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    updatedAt: NOW
  });

  const add = async (): Promise<void> => {
    // `git diff HEAD` reports tracked paths only, and so does a checkpoint patch.
    await git('git', ['add', '-A'], { cwd: workspaceRoot });
  };
  const write = async (relative: string, body: string): Promise<void> => {
    const target = path.join(workspaceRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, 'utf8');
    await add();
  };

  // Production wiring, verbatim from `run-safety-wiring.ts`: the probe counts
  // non-terminal Runs across the whole record, and the ledger bounds itself by
  // the same list so "in flight" means one thing to both.
  const inFlightRuns = (): readonly WorkflowRun[] =>
    Object.values(store.getRunMap()).filter((run) => !isTerminalRunStatus(run.status));
  const ledger = new RunMutationLedger({
    readDiff: async () =>
      (
        await git('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
          cwd: workspaceRoot,
          maxBuffer: 20 * 1024 * 1024
        })
      ).stdout,
    listInFlightRunIds: () => inFlightRuns().map((run) => run.id),
    workspaceRoot
  });
  const checkpoints = new RunCheckpointService(
    storageRoot,
    workspaceRoot,
    logger,
    () => inFlightRuns().length,
    ledger
  );

  const invocations: Array<{ runId: string; phase: string }> = [];
  const parked: Parked[] = [];
  const started: Array<Promise<void>> = [];
  const silent = new Set<string>();
  let gating = true;

  const runnerDouble = {
    run: vi.fn(async (inputs: { phase: string; runId?: string }): Promise<PhaseRunOutput> => {
      const runId = inputs.runId ?? 'unattributed';
      invocations.push({ runId, phase: inputs.phase });
      if (gating) {
        await new Promise<void>((resolve) => {
          parked.push({ runId, phase: inputs.phase, release: resolve });
        });
      }
      // The phase's work, done at release time so the test controls *when* the
      // tree changes, not merely whether it does.
      if (inputs.phase === WRITE.id && !silent.has(runId)) {
        const file = `${runId}.txt`;
        await write(file, `written by ${runId}\n`);
        return cleanOutput([file]);
      }
      return cleanOutput([]);
    }),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn(async () => {})
  };

  const depsFor = (queueId: string): RunDriverDeps =>
    ({
      store,
      runner: runnerDouble,
      logger,
      options: { iterationCap: 5, cwd: workspaceRoot, cliPath: '/test/bin', skipProbing: true },
      monitor: null,
      retryCoordinator: {
        registerAttempt: vi.fn(),
        clear: vi.fn(),
        isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
        handleDelayedRetry: vi.fn(),
        maybeEmitRetryRecovered: vi.fn(async (run: WorkflowRun) => run)
      },
      queue: { finish: vi.fn(), pause: vi.fn(), findById: vi.fn(() => null) },
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      statusBar: { update: vi.fn(), dispose: vi.fn() },
      historyRecorder: new HistoryRecorder({
        historyStore: history,
        logger,
        // FR-R3-010 — this harness drives one queue and asserts nothing about
        // history, so the partition is fixed and the description store is
        // inert. A real store here would put files in the checkpoint fixtures'
        // worktree and change what the diff under test contains.
        queueIdForTask: () => DEFAULT_QUEUE_ID,
        // Feature 103 — no connected Workflow drives this harness either.
        originForTask: () => ({ kind: 'standalone' }),
        descriptions: { write: async () => null, remove: async () => undefined }
      }),
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: vi.fn(),
      emitOptionalPhaseFailureContinued: vi.fn(),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      isContinueGate: { consume: vi.fn().mockReturnValue(false) },
      lock: {
        release: vi.fn(async () => {}),
        tryAcquire: vi.fn(),
        heartbeat: vi.fn(),
        isHeld: vi.fn(),
        ownerOfRecord: vi.fn(),
        id: 'this-window'
      },
      persistTransition: async (_prev: WorkflowRun, next: WorkflowRun) => {
        await store.setRun(queueId, next);
        return next;
      },
      scheduleAutoDrain: vi.fn(),
      onRunTerminal: vi.fn(),
      checkpoints,
      mutationLedger: ledger
    }) as unknown as RunDriverDeps;

  const runRoot = (runId: string): string =>
    path.join(storageRoot, 'checkpoints', runId.replace(/[^a-zA-Z0-9_-]/g, '_'));

  const artifacts = async (runId: string): Promise<readonly string[]> => {
    try {
      return (await fs.readdir(runRoot(runId))).sort();
    } catch {
      return [];
    }
  };
  const readOne = async (
    runId: string,
    match: (name: string) => boolean
  ): Promise<string | null> => {
    const name = (await artifacts(runId)).find(match);
    return name === undefined ? null : fs.readFile(path.join(runRoot(runId), name), 'utf8');
  };

  return {
    workspaceRoot,
    storageRoot,
    store,
    ledger,
    checkpoints,
    warnings,
    invocations,
    start: (queueId, runId, options = {}) => {
      if (options.writes === false) silent.add(runId);
      const plan = buildMutationPlan(PIPELINE, NOW);
      // Real wall-clock, not a frozen epoch: the ledger stamps its own creation
      // from `Date.now()` and treats a Run that predates it as one whose earlier
      // writes it never saw. A fixed `startedAt` in the past would therefore make
      // every Run here read as resumed, and every checkpoint decline for a reason
      // the fixture is not about.
      const startedAt = Date.now();
      const run = {
        id: runId,
        taskId: runId,
        featureId: runId,
        featureDir: `specs/001-${runId}`,
        startedAt,
        updatedAt: startedAt,
        lastTransitionAt: startedAt,
        status: 'running',
        currentPhase: WRITE.id,
        currentIteration: 0,
        pipeline: PIPELINE,
        mutationPlan: plan,
        gitApprovalReceipt: {
          approvedAt: NOW,
          planFingerprint: plan.fingerprint,
          approvedPhaseIds: plan.gitCapablePhaseIds
        },
        phasesCompleted: [],
        lastError: null,
        pendingRetry: false,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null
      } as unknown as WorkflowRun;
      const completed = (async () => {
        await store.setRun(queueId, run);
        await new RunDriver(depsFor(queueId)).drive(store.getRun(queueId)!, `work for ${runId}`);
      })();
      started.push(completed);
      return { runId, queueId, completed };
    },
    atGate: async (runId, phase) => {
      // Bounded by elapsed time, not by a count of event-loop rounds.
      //
      // This was `for (let round = 0; round < 800; round++)` with no sleep in
      // the body — so what it actually measured was how many times this process
      // got scheduled, which is a property of what else the CPU is doing. It is
      // the same defect FR-R3-033 fixed in `drainUntil` in the sibling harness,
      // and it survived here because nothing linked the two. Under an unrelated
      // 10-worker build it failed while the run it was waiting for was fine.
      //
      // Under the 25s bound below, a real deadlock still fails; a starved one
      // does not. The round count is kept in the message because the ratio of
      // rounds to milliseconds is what tells the two apart.
      const deadline = Date.now() + 25_000;
      let rounds = 0;
      while (Date.now() < deadline) {
        if (parked.some((e) => e.runId === runId && (phase === undefined || e.phase === phase))) {
          return;
        }
        rounds++;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 0));
      }
      throw new Error(
        `timed out waiting for ${runId}${phase === undefined ? '' : `:${phase}`} at the gate ` +
          `after 25000ms and ${rounds} round(s) ` +
          `(parked=[${parked.map((p) => `${p.runId}:${p.phase}`).join(', ')}] ` +
          `invocations=[${invocations.map((i) => `${i.runId}:${i.phase}`).join(', ')}])`
      );
    },
    step: (runId) => {
      const index = parked.findIndex((entry) => entry.runId === runId);
      if (index < 0) throw new Error(`no parked invocation for run ${runId}`);
      const [entry] = parked.splice(index, 1);
      entry.release();
    },
    openGate: () => {
      gating = false;
      while (parked.length > 0) parked.pop()!.release();
    },
    write,
    head: async () =>
      (await git('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })).stdout.trim(),
    wholeTreeDiff: async () =>
      (await git('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: workspaceRoot }))
        .stdout,
    runRoot,
    artifacts,
    patch: (runId) => readOne(runId, (name) => name.endsWith('.patch')),
    metadata: async (runId) => {
      const body = await readOne(
        runId,
        (name) => name.endsWith('.json') && !name.endsWith('.declined.json')
      );
      return body === null ? null : JSON.parse(body);
    },
    decline: async (runId) => {
      const body = await readOne(runId, (name) => name.endsWith('.declined.json'));
      return body === null ? null : JSON.parse(body);
    },
    dispose: async () => {
      gating = false;
      while (parked.length > 0) parked.pop()!.release();
      // Quiesce before deleting: a live Run writing into a directory being walked
      // surfaces as an `ENOTEMPTY` that has nothing to do with the assertions.
      await Promise.allSettled(started);
      history.dispose();
      vi.restoreAllMocks();
      await removeTempRoot(workspaceRoot);
      await removeTempRoot(storageRoot);
    }
  };
}
