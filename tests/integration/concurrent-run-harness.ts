// Feature 093 — the shared two-or-more-Runs-in-one-window harness.
//
// Extracted when T069 needed a second file (`concurrency-cap.test.ts`) built on
// the same construction: `concurrent-run-execution.test.ts` asserts that Runs
// can execute at once, this one that the cap bounds how many. Both need the same
// thing — a real controller, a real store, a real lease, and a CLI that parks
// every invocation until the test steps it — and a second copy would be a second
// place for "what a live Run looks like" to drift.
//
// **Determinism (research R10).** The host is single-threaded, so two Runs'
// interleavings are enumerable and reproducible — but only if the test chooses
// them. Every CLI invocation parks at a gate; `step(runId)` releases exactly one
// of that Run's parked invocations. There is no `setTimeout`-based sleep here,
// and nothing depends on one Run being faster than another: a sleep-calibrated
// concurrency test passes on an idle laptop and flakes under full-suite CPU
// contention, which is the worst failure mode for a suite whose whole subject is
// interleaving. `drainUntil` is a bounded microtask pump, not a sleep — it
// advances the loop until a stated condition holds and fails by *naming what it
// waited for* rather than hanging.

import { vi, type Mock } from 'vitest';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
// Feature 098 (T080) — the controller no longer carries a compiled-in catalog,
// so a test that drives Phases supplies one. See the fixture header for why the
// ids here are the real Spec Kit ones.
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { createPhaseBreakpointAccessor } from '../../src/controller/breakpoint-accessor';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { RunCheckpointService } from '../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../src/services/run-mutation-ledger';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager, type Clock, type Scheduler } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { isTerminalRunStatus, type WorkflowRun } from '../../src/state/workflow-run';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { FeatureRequest } from '../../src/queue/feature-request';
import type {
  DelayedRetryWatchdog,
  WorkflowControllerDeps
} from '../../src/controller/workflow-controller';
import { removeTempRoot } from '../temp-root-cleanup';

/** Registry ids need a real v4 shape — `isValidQueueId` enforces it. */
export const QUEUE_A = DEFAULT_QUEUE_ID;
export const QUEUE_B = '22222222-3333-4444-8555-666666666666';
export const QUEUE_C = '33333333-4444-4555-8666-777777777777';
export const QUEUE_D = '44444444-5555-4666-8777-888888888888';

/** Frozen: nothing may pass because a lease aged out mid-test. */
export const T0 = 1_700_000_000_000;

export class FakeMemento implements Memento {
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

export class FixedClock implements Clock {
  constructor(private at: number = T0) {}
  now(): number {
    return this.at;
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

export const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

export const buffer = (text: string): ZippedStreamBuffer => {
  const b = new ZippedStreamBuffer();
  if (text.length > 0) b.append(text);
  b.finalize();
  return b;
};

/** A phase result the sequencer reads as a clean advance. */
export const cleanStdout = (phase: string): string =>
  [
    '[SCHEGENT_STATUS: CLEAR]',
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
    '=== END AUDIT LOG ==='
  ].join('\n');

export const cleanOutput = (phase: string): RawInvocationOutput => ({
  stdoutBuffer: buffer(cleanStdout(phase)),
  stderrBuffer: buffer(''),
  exitCode: 0,
  killed: false,
  timedOut: false,
  durationMs: 1,
  cliSessionId: 'owned-claude-session'
});

/**
 * A signature on the code-resident fatal floor, so a Run ends on its first
 * invocation without waiting out a retry cap — a *failure* at a point the test
 * controls.
 */
export const FATAL_TEXT = 'error: unknown option';

export const fatalOutput = (): RawInvocationOutput => ({
  stdoutBuffer: buffer(''),
  stderrBuffer: buffer(`${FATAL_TEXT}\n`),
  exitCode: 1,
  killed: false,
  timedOut: false,
  durationMs: 1
});

/**
 * The stream-json shape the reset extractor parses, with a caller-chosen reset
 * epoch. Copied in form from `rate-limit-dynamic-backoff.test.ts` so both files
 * exercise the same parse path.
 */
export const rateLimitedOutput = (resetsAtSec: number): RawInvocationOutput => ({
  stdoutBuffer: buffer(
    [
      '{"type":"system","subtype":"init","session_id":"int-093","model":"claude-sonnet-4-5","cwd":"/tmp/wsp"}',
      `{"type":"rate_limit_event","rate_limit_info":{"status":"allow","resetsAt":${resetsAtSec}}}`,
      `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAtSec}}}`
    ].join('\n')
  ),
  stderrBuffer: buffer(''),
  exitCode: 1,
  killed: false,
  timedOut: false,
  durationMs: 1
});

/**
 * Advance the event loop until `settled()` holds.
 *
 * A bounded pump, not a sleep: it makes no claim about elapsed time and no
 * assertion depends on how many rounds it took. The bound exists so a dispatch
 * that never happens fails here — naming what it waited for — instead of
 * hanging the suite. `what` may be a closure so the message can report the state
 * as it stood when the wait gave up rather than when it started.
 */
/**
 * How long a drain may take before it is treated as a hang.
 *
 * This used to be a budget of 800 ROUNDS of `setImmediate` + `setTimeout(0)`,
 * and that is the wrong unit. A round is not a fixed amount of progress: under
 * contention each one yields less, so the same cascade needs more rounds on a
 * busy machine than on an idle one. The bound therefore measured machine load as
 * much as it measured whether the cascade settled.
 *
 * It cost four observed failures of
 * `tests/integration/concurrency-cap.test.ts > holds the slot while paused`
 * between 2026-08-22 and 2026-08-23, every one of them under full-chain load and
 * two of them immediately after a real-VS-Code integration run left the machine
 * busy. The same test passed 3-for-3 and 5-for-5 in isolation and across three
 * consecutive full `test:host` runs, which is the signature of a bound that is
 * about the environment rather than the code.
 *
 * Elapsed time is the unit that means the same thing on both machines. Ten
 * seconds is far above any real drain here — they settle in tens of rounds — and
 * far below a suite timeout, so a genuine hang still fails as a hang, with the
 * round count reported alongside so a future reader can see how much progress
 * was actually made.
 */
// Kept deliberately BELOW the 30s `testTimeout` in vitest.config.ts. When a
// drain genuinely stalls, the useful failure is this harness naming the run and
// queue it was waiting on — not vitest reporting a bare "Test timed out". If
// this ever exceeds the test timeout, that diagnostic is lost.
//
// Raised from 10s when the test timeout moved: under an unrelated 10-worker
// build on this 10-core machine, a drain that takes well under a second idle
// needed more than 10s, and reported "gave up after 10000ms and 7644 round(s)"
// — 7644 event-loop rounds is not a stalled run, it is a starved one.
const DRAIN_TIMEOUT_MS = 25_000;

export async function drainUntil(
  settled: () => boolean,
  what: string | (() => string),
  timeoutMs = DRAIN_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let rounds = 0;
  while (Date.now() < deadline) {
    if (settled()) return;
    rounds += 1;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!settled()) {
    throw new Error(
      `drainUntil gave up after ${timeoutMs}ms and ${rounds} round(s) waiting for: ` +
        `${typeof what === 'function' ? what() : what}`
    );
  }
}

function makeStubWatchdog(): DelayedRetryWatchdog & {
  pauseAndPoll: Mock;
  cancelPendingTimer: Mock;
} {
  return {
    pauseAndPoll: vi.fn(async () => {}),
    cancelPendingTimer: vi.fn()
  } as unknown as DelayedRetryWatchdog & { pauseAndPoll: Mock; cancelPendingTimer: Mock };
}

/** One parked CLI invocation, waiting for the test to let it proceed. */
interface Parked {
  readonly runId: string;
  readonly phase: string;
  readonly release: () => void;
}

/** A Run this harness admitted, with the promise of its execution. */
export interface AdmittedRun {
  readonly feature: FeatureRequest;
  readonly runId: string;
  readonly completed: Promise<void>;
}

export interface HarnessOptions {
  /**
   * The global concurrency cap. `concurrent-run-execution.test.ts` sets it high
   * enough to be irrelevant so a failure there means "two Runs cannot execute",
   * never "the cap refused the second one"; `concurrency-cap.test.ts` sets it to
   * the number under test.
   */
  readonly concurrencyCap?: number;
  /** Registry entries to create beyond the default queue. */
  readonly queues?: readonly string[];
}

export interface Harness {
  readonly controller: SchegentWorkflowController;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly lease: ExecutionLeaseManager;
  readonly lock: WorkspaceLockManager;
  readonly lockStore: WorkspaceStateStore;
  readonly lockClock: FixedClock;
  readonly checkpoints: RunCheckpointService;
  /** FR-R3-004 — the attribution record the controller brackets each phase with. */
  readonly mutationLedger: RunMutationLedger;
  readonly logger: SanitizedLogger;
  /** Every invocation the CLI saw, in dispatch order, with its Run. */
  readonly invocations: Array<{ runId: string; phase: string }>;
  /** Replace the scripted outcome; default is a clean advance. */
  readonly script: (fn: (req: InvocationRequest) => RawInvocationOutput) => void;
  /** Wait until this Run has an invocation parked at the gate. */
  readonly atGate: (runId: string) => Promise<void>;
  /** Release exactly one of this Run's parked invocations. */
  readonly step: (runId: string) => void;
  /** How many of this Run's invocations are parked right now. */
  readonly parkedFor: (runId: string) => number;
  /** Stop gating and release everything parked — let the Runs finish. */
  readonly openGate: () => void;
  readonly runKeys: () => string[];
  /** Enqueue on a queue and admit its Run, returning once the record exists. */
  readonly admit: (queueId: string, description: string) => Promise<AdmittedRun>;
  /** Release this Run's gates until it reaches a terminal status. */
  readonly runToTerminal: (queueId: string, runId: string) => Promise<WorkflowRun>;
  /**
   * Open the gate and wait for every admitted Run to stop executing, so the
   * workspace can be deleted without racing a live Run's writes.
   */
  readonly quiesce: () => Promise<void>;
}

export async function makeHarness(
  workspaceRoot: string,
  options: HarnessOptions = {}
): Promise<Harness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  // Third argument: this test's own spool root. Production leaves it at
  // `os.tmpdir()`, and the writer scavenges abandoned spools by reading that
  // directory once per instance. Pointed at the shared OS temp dir, the first
  // CLI invocation would wait on a `readdir` of however many entries the
  // developer's machine happens to hold — enough, on some, to exceed any bound
  // below. A per-test root keeps the scavenger's real behavior exercised and its
  // cost proportional to what this test created.
  const rawTranscript = new RawTranscriptWriter(
    workspaceRoot,
    logger,
    path.join(workspaceRoot, 'spool')
  );
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();

  await store.setGlobalConcurrencyCap(options.concurrencyCap ?? 5);

  const registry = store.getQueueRegistry();
  await store.setQueueRegistry({
    entries: [
      ...registry.entries,
      ...(options.queues ?? [QUEUE_B]).map((id, index) => ({
        id,
        name: `Queue ${id.slice(0, 4)}`,
        position: registry.entries.length + index,
        state: 'active' as const,
        pauseSource: null,
        schedule: null,
        createdAt: T0,
        updatedAt: T0
      }))
    ],
    updatedAt: T0
  });

  const invocations: Array<{ runId: string; phase: string }> = [];
  const parked: Parked[] = [];
  const admitted: Array<Promise<void>> = [];
  let gating = true;
  let handler: (req: InvocationRequest) => RawInvocationOutput = (req) => cleanOutput(req.phase);

  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    const runId = req.runId ?? 'unattributed';
    invocations.push({ runId, phase: req.phase });
    if (gating) {
      await new Promise<void>((resolve) => {
        parked.push({ runId, phase: req.phase, release: resolve });
      });
    }
    return handler(req);
  });

  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  // The breakpoint accessor resolves by **run id** across the whole record, not
  // by a fixed queue: with N Runs, a queue-pinned accessor would answer every
  // Run with the default queue's breakpoints.
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

  // The lock's own store, shared with any rival window a test constructs — a
  // rival is a second process reading the same persisted lock record.
  const lockStore = new WorkspaceStateStore(new FakeMemento());
  await lockStore.initialize();
  const lockClock = new FixedClock();
  const lock = new WorkspaceLockManager(lockStore, 'window-a', lockClock, noopScheduler);
  const lease = new ExecutionLeaseManager(store, 'window-a', lockClock, noopScheduler);

  // Production wiring, verbatim from `run-safety-wiring.ts`: the probe counts
  // non-terminal Runs across the whole record, and the ledger bounds itself by
  // the same list so "in flight" means one thing to both.
  const inFlightRuns = () =>
    Object.values(store.getRunMap()).filter((run) => !isTerminalRunStatus(run.status));
  const mutationLedger = new RunMutationLedger({
    readDiff: async () =>
      (
        await promisify(execFile)('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
          cwd: workspaceRoot,
          maxBuffer: 20 * 1024 * 1024
        })
      ).stdout,
    listInFlightRunIds: () => inFlightRuns().map((run) => run.id),
    workspaceRoot
  });
  const checkpoints = new RunCheckpointService(
    path.join(workspaceRoot, '.checkpoint-storage'),
    workspaceRoot,
    logger,
    () => inFlightRuns().length,
    mutationLedger
  );

  const deps: WorkflowControllerDeps = {
    catalog: buildSpeckitCatalog(),
    auditWriter: audit,
    watchdog: makeStubWatchdog(),
    terminalTransitions: new TerminalTransitionCoordinator(
      store,
      queue,
      { record: vi.fn(async () => ({ outcome: 'recorded' as const })) },
      logger
    ),
    executionLease: lease,
    checkpoints,
    mutationLedger,
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
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    deps
  );

  const parkedFor = (runId: string): number =>
    parked.filter((entry) => entry.runId === runId).length;

  const step = (runId: string): void => {
    const index = parked.findIndex((entry) => entry.runId === runId);
    if (index < 0) throw new Error(`no parked invocation for run ${runId}`);
    const [entry] = parked.splice(index, 1);
    entry.release();
  };

  const openGate = (): void => {
    gating = false;
    while (parked.length > 0) parked.pop()!.release();
  };

  return {
    controller,
    store,
    queue,
    lease,
    lock,
    lockStore,
    lockClock,
    checkpoints,
    mutationLedger,
    logger,
    invocations,
    script: (fn) => {
      handler = fn;
    },
    atGate: (runId) =>
      drainUntil(
        () => parked.some((entry) => entry.runId === runId),
        () =>
          `run ${runId} to park at the CLI gate ` +
          `(parked=[${parked.map((p) => `${p.runId}:${p.phase}`).join(', ')}] ` +
          `invocations=[${invocations.map((i) => `${i.runId}:${i.phase}`).join(', ')}])`
      ),
    step,
    parkedFor,
    openGate,
    runKeys: () => Object.keys(store.getRunMap()).sort(),
    admit: async (queueId, description) => {
      const feature = await queue.enqueue(description, { queueId });
      const admission = await controller.admitNew(feature, null);
      const run = store.getRun(queueId);
      if (run === null) throw new Error(`admitNew left queue ${queueId} with no Run record`);
      admitted.push(admission.completed);
      return { feature, runId: run.id, completed: admission.completed };
    },
    runToTerminal: async (queueId, runId) => {
      await drainUntil(() => {
        const run = store.getRun(queueId);
        if (run !== null && isTerminalRunStatus(run.status)) return true;
        if (parkedFor(runId) > 0) step(runId);
        return false;
      }, `run ${runId} on queue ${queueId} to reach a terminal status`);
      return store.getRun(queueId)!;
    },
    quiesce: async () => {
      openGate();
      await Promise.allSettled(admitted);
    }
  };
}

/**
 * A real git repository at the workspace root, because `RunCheckpointService` is
 * wired in for real. Without one, the first Run to reach a Git-capable phase is
 * the sole Run in flight, so the service takes the non-declining path,
 * `git diff --binary HEAD` fails, and the Run dies on `checkpoint-unavailable` —
 * leaving exactly one Run executing and every concurrency assertion failing for
 * a reason that has nothing to do with concurrency. The empty commit gives
 * `HEAD` something to resolve to.
 */
export async function initGitRepo(root: string): Promise<void> {
  const git = promisify(execFile);
  await git('git', ['init', '-q'], { cwd: root });
  await git('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await git('git', ['config', 'user.name', 'Test'], { cwd: root });
  await git('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
}

/**
 * Delete a quiesced workspace. Most of these tests end with Runs still
 * mid-flight by design, and deleting under a live Run races its audit append,
 * its raw transcript, and its session write — which surfaces as an `ENOTEMPTY`
 * from a directory the Run refilled between the walk and the rmdir. Retrying the
 * delete only widens the window it has to lose in, so callers quiesce first.
 */
export async function removeWorkspace(root: string): Promise<void> {
  await removeTempRoot(root);
}
