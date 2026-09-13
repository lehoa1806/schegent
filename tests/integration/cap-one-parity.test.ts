// Feature 093 (T029, T034) — with a cap of 1, nothing changed (SC-010, US2
// scenario 2).
//
// Phase 2 of this feature rewrote every `getRun`/`setRun` call site in the host
// to name a queue. Sixty sites, mechanical individually, and each one an
// opportunity to address the wrong record: a control that resolves the default
// queue when its Run lives elsewhere, a write-back that lands under a queue the
// read did not come from, a terminal transition that clears a key nobody set.
// None of those fail loudly. They fail as a Run that stops responding to the
// button the operator pressed.
//
// This file is the regression that pins the whole lifecycle against that. It
// drives the real controller + phase runner + audit writer + queue manager stack
// against a scripted CLI, on **one** queue, with `globalConcurrencyCap = 1` —
// the configuration every existing single-queue operator is already in — and
// walks a Run through start, stream, pause, resume, retry, cancel, and complete.
//
// Two properties make these parity assertions rather than merely lifecycle ones,
// and both are asserted at every stage:
//
//   1. The run record stays a **one-entry record keyed by the queue the work was
//      enqueued on**. `runKeys()` below is that check. A site that writes back
//      under a derived queue id rather than the one it read from produces a
//      second key, and the pre-feature single-slot record could not have had
//      one.
//   2. Every control is invoked **without naming a queue** — the shape the
//      webview and the palette still post today. Under `resolveControlTarget`
//      that has to resolve to the sole Run; a refusal (`no-run-in-flight`,
//      `ambiguous-run-target`) is a behavior change an operator would see as a
//      dead button, so each control's `ok` is asserted, not just its effect.
//
// The cap is set to 1 explicitly rather than left at the default of 3. Parity is
// a claim about the cap-1 configuration specifically, and a test that inherited
// whatever the default happened to be would stop making that claim the day the
// default moves.
//
// Deliberately NOT here: anything about two Runs at once. Drain step 4b still
// refuses the second start until T081, and the concurrent-execution behavior has
// its own tests. This file exists to prove the single-queue operator's world is
// untouched, which is the half of the feature that can only regress.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { drainUntil as sharedDrainUntil } from './concurrent-run-harness';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
// Feature 098 (T080) — the controller no longer carries a compiled-in catalog,
// so a test that drives Phases supplies one. See the fixture header for why the
// ids here are the real Spec Kit ones.
import { buildSpeckitCatalog } from '../fixtures/speckit-catalog-fixture';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { createPhaseBreakpointAccessor } from '../../src/controller/breakpoint-accessor';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type {
  DelayedRetryWatchdog,
  WorkflowControllerDeps
} from '../../src/controller/workflow-controller';
import { removeTempRoot } from '../temp-root-cleanup';
// Feature 093 BUG-001 (T103a) — the real backend wiring, for the block at the
// foot of this file. See that block's header for why the production dispatch is
// called rather than reconstructed.
import type * as vscode from 'vscode';
import {
  wireBackendExecution,
  type BackendExecutionWiring,
  type BackendExecutionWiringDeps
} from '../../src/activation/backend-execution-wiring';
import {
  CLI_TRANSPORT_DIRECTORY,
  CLI_TRANSPORT_FILE_NAME
} from '../../src/monitor/cli-transport-sink';
import { MONITOR_STALL_THRESHOLD_MS } from '../../src/contracts/monitor-events';
import { EvidenceHealthMonitor } from '../../src/services/evidence-health/evidence-health-monitor';
import { disposeWorkspaceFolderPicker } from '../../src/state/workspace-folder-picker';
import { workspace as vscodeWorkspace } from '../__stubs__/vscode';

/**
 * The single-queue operator's queue is the default one — feature 030 collapsed
 * the registry to it and 092 kept it as the queue every unaddressed enqueue
 * lands on. Using a synthetic queue id here would test per-queue addressing,
 * which is what the *other* files in this feature are for; parity is a claim
 * about the configuration that already exists in the field.
 */
const SOLE_QUEUE = DEFAULT_QUEUE_ID;

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

/** A phase result the sequencer reads as a clean advance. */
const cleanStdout = (phase: string): string =>
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

const buffer = (text: string): ZippedStreamBuffer => {
  const b = new ZippedStreamBuffer();
  if (text.length > 0) b.append(text);
  b.finalize();
  return b;
};

const cleanOutput = (phase: string): RawInvocationOutput => ({
  stdoutBuffer: buffer(cleanStdout(phase)),
  stderrBuffer: buffer(''),
  exitCode: 0,
  killed: false,
  timedOut: false,
  durationMs: 1,
  cliSessionId: 'owned-claude-session'
});

/**
 * Non-zero exit, no fatal signature, no rate-limit cause — the classifier reads
 * this as `transient_error`, which is what arms `pendingRetryAt` and makes the
 * retry control reachable.
 *
 * It still discloses a session id, because a CLI that failed partway through
 * has one: that is what makes the manual retry a genuine continuation
 * (`resolveSessionDispatch` suppresses `isContinue` when the Run owns no
 * session), and the continuation is the half of the retry path the 032
 * lock-step governs.
 */
const transientOutput = (): RawInvocationOutput => ({
  stdoutBuffer: buffer(''),
  stderrBuffer: buffer(''),
  exitCode: 1,
  killed: false,
  timedOut: false,
  durationMs: 1,
  cliSessionId: 'owned-claude-session'
});

interface CapturedInvocation {
  readonly phase: string;
  readonly iteration: number;
  readonly isContinue: boolean | undefined;
}

/**
 * Advance the event loop until `settled()` holds.
 *
 * Copied in spirit from `pause-resume-continue.test.ts`, and for its stated
 * reason: a fixed round count passes on an idle machine and fails under
 * full-suite CPU contention. The bound stays so a dispatch that genuinely never
 * happens fails here, naming what it waited for, instead of hanging.
 */
// FR-R3-046 — delegated rather than repeated. This was a third copy of the same
// loop, bounded in rounds rather than elapsed time; see the shared helper for why
// that unit was wrong and what it cost.
async function drainUntil(settled: () => boolean, what: string): Promise<void> {
  return sharedDrainUntil(settled, what);
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(() => true),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
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

interface Harness {
  readonly controller: SchegentWorkflowController;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly invocations: CapturedInvocation[];
  /**
   * Replace the scripted outcome handler; default is a clean advance.
   *
   * Feature 093 BUG-001 (T103a) — the handler may return a promise, which
   * `invoke` already awaits. A handler that resolves when the test says so is
   * how the block at the foot of this file gets a Run whose phase child is
   * genuinely in flight: the monitor assertions there are about a live phase,
   * and a Run that has already completed cannot make that claim.
   */
  readonly script: (
    fn: (req: InvocationRequest, callIndex: number) => RawInvocationOutput | Promise<RawInvocationOutput>
  ) => void;
  readonly watchdog: ReturnType<typeof makeStubWatchdog>;
  /** Keys of the run record — the one-entry invariant every stage asserts. */
  readonly runKeys: () => string[];
}

async function makeHarness(workspaceRoot: string): Promise<Harness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();

  // The parity configuration: one Run allowed at a time, stated rather than
  // inherited from the schema default.
  await store.setGlobalConcurrencyCap(1);

  const invocations: CapturedInvocation[] = [];
  let handler: (
    req: InvocationRequest,
    callIndex: number
  ) => RawInvocationOutput | Promise<RawInvocationOutput> = (req) => cleanOutput(req.phase);

  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    const callIndex = invocations.length;
    invocations.push({ phase: req.phase, iteration: req.iteration, isContinue: req.isContinue });
    return handler(req, callIndex);
  });

  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  // Feature 028 — the breakpoint accessor the production wiring in
  // `src/extension.ts` installs, so the breakpoint stage below exercises the
  // real short-circuit rather than a stubbed one.
  const phaseRunner = new PhaseRunner(
    runner,
    new PromptBuilder(),
    audit,
    logger,
    null,
    null,
    null,
    null,
    null,
    createPhaseBreakpointAccessor(() => store.getRun(SOLE_QUEUE))
  );

  const queue = new QueueManager(store);
  const watchdog = makeStubWatchdog();

  // The real coordinator, not a stub: it is one of the converted sites (pattern
  // C-2, `findRunByTask`), and it is the only thing that advances the Task for a
  // Run that ends by cancel or by an unexpected failure. Leaving it unwired
  // would make the cancel stage below assert a Task status nothing was ever
  // going to write. History is stubbed because this file makes no claim about
  // the history store.
  const deps: WorkflowControllerDeps = {
    catalog: buildSpeckitCatalog(),
    auditWriter: audit,
    watchdog,
    terminalTransitions: new TerminalTransitionCoordinator(
      store,
      queue,
      { record: vi.fn(async () => ({ outcome: 'recorded' as const })) },
      logger
    )
  };

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    makeLock(),
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    deps
  );

  return {
    controller,
    store,
    queue,
    invocations,
    script: (fn) => {
      handler = fn;
    },
    watchdog,
    runKeys: () => Object.keys(store.getRunMap())
  };
}

let tmpRoot: string;
let harness: Harness;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cap-one-parity-'));
  harness = await makeHarness(tmpRoot);
});

afterEach(async () => {
  // An in-flight audit write can race the rm and produce ENOTEMPTY; retry.
  await removeTempRoot(tmpRoot);
});

describe('Feature 093 (T029, SC-010) — cap 1: the record stays a single slot', () => {
  it('the cap is a stated 1, and an idle workspace holds no Run at all', () => {
    expect(harness.store.getGlobalConcurrencyCap()).toBe(1);
    // Not `{}` by accident of the migrator: FR-005 forbids fabricating a Run,
    // so an untouched workspace enumerates none.
    expect(harness.runKeys()).toEqual([]);
    expect(harness.store.getRun(SOLE_QUEUE)).toBeNull();
  });

  it('starts, streams every phase, and completes under one key', async () => {
    const feature = await harness.queue.enqueue('cap-one lifecycle');
    await harness.controller.startNew(feature, null);
    await drainUntil(
      () => harness.store.getRun(SOLE_QUEUE)?.status === 'completed',
      'the run to reach completed'
    );

    // The record never grew a second entry, and the entry it has is the queue
    // the work was enqueued on rather than one derived downstream.
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);

    const run = harness.store.getRun(SOLE_QUEUE);
    expect(run?.status).toBe('completed');
    expect(run?.featureId).toBe(feature.id);

    // Streaming: more than one phase was dispatched, each in the run's own
    // pipeline, in the order the pipeline declares. A site that re-read the
    // wrong record mid-drive would advance from a stale phase and break the
    // ordering rather than the count.
    const phaseOrder = (run?.pipeline?.phases ?? []).map((p) => p.id);
    expect(phaseOrder.length).toBeGreaterThan(1);
    expect(harness.invocations.length).toBeGreaterThan(1);
    const dispatched = harness.invocations.map((inv) => phaseOrder.indexOf(inv.phase));
    expect(dispatched.every((index) => index >= 0)).toBe(true);
    expect([...dispatched].sort((a, b) => a - b)).toEqual(dispatched);

    // First dispatch is a fresh one — the 032 lock-step, unchanged by the
    // reshape.
    expect(harness.invocations[0].isContinue ?? false).toBe(false);

    // The Task advanced with its Run.
    expect(harness.queue.findById(feature.id)?.status).toBe('completed');
  });
});

describe('Feature 093 (T034, US2 scenario 2) — every control resolves the sole Run unaddressed', () => {
  it('pause then resume, neither naming a queue', async () => {
    let paused = false;
    harness.script((req) => {
      if (!paused) {
        paused = true;
        // Fire after this invocation resolves but before the loop iterates,
        // so the drive loop observes the pause and settles into it.
        setImmediate(() => {
          void (async () => {
            const result = await harness.controller.pauseActivePhase();
            expect(result.ok).toBe(true);
          })();
        });
      }
      return cleanOutput(req.phase);
    });

    const feature = await harness.queue.enqueue('cap-one pause-resume');
    await harness.controller.startNew(feature, null);
    await drainUntil(
      () => harness.store.getRun(SOLE_QUEUE)?.status === 'paused',
      'the run to settle as paused'
    );

    const pausedRun = harness.store.getRun(SOLE_QUEUE);
    expect(pausedRun?.status).toBe('paused');
    expect(pausedRun?.manualPauseAt).not.toBeNull();
    expect(pausedRun?.manualPauseCause).toBe('operator-paused');
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);

    const dispatchesBeforeResume = harness.invocations.length;
    const resume = await harness.controller.resumeActivePhase();
    expect(resume.ok).toBe(true);
    await drainUntil(
      () => harness.invocations.length > dispatchesBeforeResume,
      'the post-resume dispatch'
    );

    // The 032 lock-step: a resumed dispatch continues the CLI session.
    expect(harness.invocations[dispatchesBeforeResume].isContinue).toBe(true);
    expect(harness.store.getRun(SOLE_QUEUE)?.manualPauseAt).toBeNull();
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);
  });

  it('retry now, not naming a queue', async () => {
    harness.script(() => transientOutput());

    const feature = await harness.queue.enqueue('cap-one retry');
    await harness.controller.startNew(feature, null);

    const pending = harness.store.getRun(SOLE_QUEUE);
    expect(pending?.pendingRetryAt).not.toBeNull();
    expect(pending?.pendingRetryCause).not.toBeNull();
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);

    const dispatchesBeforeRetry = harness.invocations.length;
    const retry = await harness.controller.retryPhaseNow();
    expect(retry.ok).toBe(true);
    expect(harness.watchdog.cancelPendingTimer).toHaveBeenCalledTimes(1);

    // The override is a continuation, and it re-dispatches on the next tick.
    await drainUntil(
      () => harness.invocations.length > dispatchesBeforeRetry,
      'the post-retry dispatch'
    );
    expect(harness.invocations[dispatchesBeforeRetry].isContinue).toBe(true);
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);
  });

  it('breakpoint set and fired, the set not naming a queue', async () => {
    const feature = await harness.queue.enqueue('cap-one breakpoint');

    let armed = false;
    harness.script((req) => {
      if (!armed) {
        armed = true;
        setImmediate(() => {
          void (async () => {
            const run = harness.store.getRun(SOLE_QUEUE);
            if (run === null) return;
            const next = (run.pipeline?.phases ?? [])
              .map((p) => p.id)
              .find((id) => id !== run.currentPhase);
            if (next === undefined) return;
            // No queue argument — `resolveControlTarget` must find the sole Run.
            const result = await harness.controller.setPhaseBreakpoint(run.id, next);
            expect(result.ok).toBe(true);
          })();
        });
      }
      return cleanOutput(req.phase);
    });

    await harness.controller.startNew(feature, null);
    await drainUntil(
      () => harness.store.getRun(SOLE_QUEUE)?.manualPauseCause === 'breakpoint-paused',
      'the breakpoint to fire and settle the run'
    );

    const stopped = harness.store.getRun(SOLE_QUEUE);
    expect(stopped?.status).toBe('paused');
    expect(stopped?.resumeTargetPhaseId).not.toBeNull();
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);

    // Resuming past it re-dispatches the marked phase — the breakpoint stopped
    // the Run rather than ending it.
    const dispatchesBeforeResume = harness.invocations.length;
    const resume = await harness.controller.resumeActivePhase();
    expect(resume.ok).toBe(true);
    await drainUntil(
      () => harness.invocations.length > dispatchesBeforeResume,
      'the post-breakpoint-resume dispatch'
    );
    expect(harness.invocations[dispatchesBeforeResume].phase).toBe(stopped?.resumeTargetPhaseId);
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);
  });

  it('cancel, leaving one terminal Run under one key', async () => {
    harness.script((req, callIndex) => {
      // Cancel from inside the first invocation: the driver checks the abort
      // signal at the top of the next phase iteration, which is where an
      // operator's cancel lands too.
      if (callIndex === 0) harness.controller.cancelActive();
      return cleanOutput(req.phase);
    });

    const feature = await harness.queue.enqueue('cap-one cancel');
    await harness.controller.startNew(feature, null);
    await drainUntil(
      () => harness.store.getRun(SOLE_QUEUE)?.status === 'canceled',
      'the run to reach canceled'
    );

    expect(harness.store.getRun(SOLE_QUEUE)?.status).toBe('canceled');
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);
    expect(harness.queue.findById(feature.id)?.status).toBe('canceled');
  });

  it('refuses a control when there is no Run, in the vocabulary it used before', async () => {
    // SC-008's single-queue face, and the reason the `ok` assertions above are
    // not vacuous: an unaddressed control on an empty record refuses, and the
    // refusal reason is the pre-feature one rather than a leaked addressing
    // term.
    const pause = await harness.controller.pauseActivePhase();
    expect(pause).toEqual({ ok: false, reason: 'no-run-in-flight' });

    const retry = await harness.controller.retryPhaseNow();
    expect(retry).toEqual({ ok: false, reason: 'no-active-run' });

    expect(harness.runKeys()).toEqual([]);
  });
});

/**
 * Feature 093 BUG-001 (T103a, SC-010) — cap 1, which is the configuration the
 * failure actually happened in.
 *
 * T103's regression proves SC-019 against the concurrency harness. This one
 * exists because SC-010 is a claim about the *single-queue* world specifically,
 * and the clause added to it after BUG-001 — that a Run's monitoring survives a
 * helper subprocess — is verified here and nowhere else. The operator whose
 * `speckit-review` ran 21,600,129 ms unwatched had one queue and a cap of 1; a
 * parity criterion exercised only at cap 3 would not have covered them.
 *
 * What is different here beyond the number. The Run is a **real** cap-1 Run: it
 * is enqueued on the sole queue, admitted through the controller, and its phase
 * invocation is held open by the scripted CLI for the length of the assertions.
 * So "non-terminal while the phase child is alive" is checked at both layers
 * that disagreed in the field — the monitor's state, and the Run record the
 * sidebar reads — at a moment when the child genuinely has not exited. The
 * one-entry invariant this file exists for is re-asserted at that moment too:
 * the fix adds invocation-level state to the monitor, and a Run record that grew
 * a second key while it was being tracked would be this file's own failure.
 *
 * The third case is the one with no sibling anywhere else. Stall coverage is not
 * a value to read; it is a timer that either fires or does not, so the clock is
 * faked for the length of that test and only for it. `performance`, `setTimeout`
 * and `clearTimeout` are the three the detector uses, and they are named rather
 * than taking the default set because the async setup above them — `drainUntil`,
 * the audit writes, the temp-root cleanup — runs on real ones.
 */
describe('Feature 093 BUG-001 (T103a, SC-010) — at cap 1, a compaction before the phase does not blind the Run', () => {
  const COMPACTION_LINE = 'compacting the session transcript';
  const FIRST_PHASE_LINE = 'reviewing the plan';
  const PHASE_LINES = [FIRST_PHASE_LINE, 'reading the contracts', 'writing the verdict'];
  // Opaque keys to the monitor, shaped like `nextInvocationId()`'s output. The
  // counter behind that function is process-wide, so pinning the numbers a
  // previous test happened to leave would make this file order-dependent.
  const COMPACTION_INVOCATION = 'claude-cli#cap-one-compaction';
  const PHASE_INVOCATION = 'claude-cli#cap-one-phase';

  const disposables: vscode.Disposable[] = [];
  const hostSubscriptions: { dispose(): unknown }[] = [];
  let wiring: BackendExecutionWiring;
  let root: string;
  /** Set while a phase invocation is parked; called to let the Run finish. */
  let releasePhase: (() => void) | null = null;
  let driving: Promise<void> | null = null;

  beforeEach(async () => {
    // `realpath` because the sink proves containment against a resolved path and
    // macOS hands `mkdtemp` a `/var` symlink. The picker caches the first answer
    // it is given, so it is cleared on both sides of the test.
    root = await fs.realpath(tmpRoot);
    disposeWorkspaceFolderPicker();
    vscodeWorkspace.workspaceFolders = [{ uri: { fsPath: root, scheme: 'file' } }];

    const logger = new SanitizedLogger();
    const deps: BackendExecutionWiringDeps = {
      workspaceRoot: root,
      cliPath: 'noop',
      logger,
      // The harness's own store, so the cap this block reads is the stated 1
      // that `makeHarness` set rather than a second workspace's default.
      store: harness.store,
      auditWriter: new AuditLogWriter({ workspaceRoot: root }, logger),
      disposables,
      hostSubscriptions,
      evidenceHealth: new EvidenceHealthMonitor(),
      processEnvironmentPolicy: { mode: 'minimal', inheritProcessEnv: false }
    };
    wiring = wireBackendExecution(deps);
  });

  afterEach(async () => {
    // Let the parked invocation resolve before anything is torn down: the drive
    // loop is still holding it, and a temp root removed underneath a live audit
    // write is the ENOTEMPTY this file's cleanup already retries for.
    releasePhase?.();
    releasePhase = null;
    if (driving !== null) await driving;
    driving = null;

    await wiring.transport.flushAndDispose();
    wiring.monitor.dispose();
    for (const entry of [...disposables, ...hostSubscriptions]) entry.dispose();
    disposables.length = 0;
    hostSubscriptions.length = 0;
    vscodeWorkspace.workspaceFolders = undefined;
    disposeWorkspaceFolderPicker();
  });

  /**
   * `pid: null`, a real value on this arm rather than a stand-in: the hook only
   * starts a telemetry series when a pid arrives, and a pid this test invented
   * would put the sampler on a `ps` poll against someone else's process.
   */
  const started = (runId: string, invocationId: string, helperInvocation: boolean): void => {
    wiring.monitorHook({ kind: 'started', runId, invocationId, helperInvocation, pid: null });
  };
  const stdout = (runId: string, invocationId: string, line: string): void => {
    wiring.monitorHook({ kind: 'stdout-chunk', runId, invocationId, chunk: `${line}\n` });
  };
  const exited = (runId: string, invocationId: string): void => {
    wiring.monitorHook({
      kind: 'exited',
      runId,
      invocationId,
      exitCode: 0,
      signal: null,
      killed: false,
      timedOut: false
    });
  };

  /**
   * Admit the sole queue's Run and park its first phase invocation.
   *
   * `admitNew` rather than `startNew`: `startNew` resolves when the Run
   * *finishes*, and this Run is deliberately not going to finish until the
   * assertions are done.
   */
  async function admitSoleRunHeldAtItsPhase(): Promise<{ runId: string; phase: string }> {
    const held = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    harness.script(async (req) => {
      await held;
      return cleanOutput(req.phase);
    });

    const feature = await harness.queue.enqueue('cap-one compaction before phase');
    driving = (await harness.controller.admitNew(feature, null)).completed;
    await drainUntil(() => harness.invocations.length > 0, 'the phase invocation to dispatch');

    const run = harness.store.getRun(SOLE_QUEUE);
    // `.at(0)` rather than `[0]`: it is `CapturedInvocation | undefined` under
    // both of the compiler settings this repo checks with, so the guard below is
    // necessary to each of them. Indexing is `| undefined` only under
    // `noUncheckedIndexedAccess`, which the strictness ratchet applies and the
    // lint does not — a guard written against one of those is a new finding for
    // the other, and both gates run.
    const dispatched = harness.invocations.at(0);
    // Thrown rather than `expect`ed: these two narrow the types the rest of the
    // block reads, and an `expect` that fails still falls through to a line that
    // cannot run. Neither can happen after the drain above resolved.
    if (run === null) throw new Error('the sole queue holds no Run after admission');
    if (dispatched === undefined) throw new Error('no phase invocation was dispatched');

    expect(run.status).toBe('running');
    expect(harness.store.getGlobalConcurrencyCap()).toBe(1);
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);
    return { runId: run.id, phase: dispatched.phase };
  }

  /**
   * The field sequence, synchronous and deliberately so: the compaction spawns
   * under the Run's id, writes, exits — and only then does the phase child
   * arrive. Every one of these reaches the monitor through the production
   * dispatch the window installs on its runners, which is the point of taking
   * `wiring.monitorHook` rather than rebuilding the forwarding here. The fix is
   * three arguments of that function, and a fixture holding its own copy of it
   * asserts only that its copy forwards them.
   */
  function compactionThenLivePhase(runId: string, phase: string): void {
    wiring.monitor.onStart(runId, phase, null);

    started(runId, COMPACTION_INVOCATION, true);
    stdout(runId, COMPACTION_INVOCATION, COMPACTION_LINE);
    exited(runId, COMPACTION_INVOCATION);

    started(runId, PHASE_INVOCATION, false);
  }

  async function readTransportLines(): Promise<
    Array<{ runId: string; phase: string; stream: string; line: string }>
  > {
    const raw = await fs.readFile(
      path.join(root, CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME),
      'utf8'
    );
    return raw
      .split('\n')
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => {
        // `<stamp>\t<runId>\t<phase>\t<stream>\t<line>`, and the line is joined
        // back because only the four leading fields are tab-delimited.
        const [, runId = '', phase = '', stream = '', ...rest] = entry.split('\t');
        return { runId, phase, stream, line: rest.join('\t') };
      });
  }

  it("keeps the sole queue's phase output, counted against the phase invocation", async () => {
    const { runId, phase } = await admitSoleRunHeldAtItsPhase();
    compactionThenLivePhase(runId, phase);

    // Bracketing is what makes this a count OF THE PHASE INVOCATION.
    // `stdoutLines` is a Run-level total and this Run's total already carries the
    // compaction's line, so the delta is the only honest reading.
    const before = wiring.monitor.getCurrentState(runId)?.stdoutLines ?? -1;
    for (const line of PHASE_LINES) stdout(runId, PHASE_INVOCATION, line);
    const after = wiring.monitor.getCurrentState(runId)?.stdoutLines ?? -1;

    await wiring.transport.flushAndDispose();
    const captured = await readTransportLines();
    const capturedForPhase = captured.filter(
      (record) => record.runId === runId && PHASE_LINES.includes(record.line)
    );
    const reportedForPhase = after - before;

    // Both halves. The equality alone is satisfied by the defect — a declined
    // chunk is neither written nor counted, so it reads 0 === 0.
    expect(reportedForPhase).toBeGreaterThan(0);
    expect(capturedForPhase.map((record) => record.line)).toEqual(PHASE_LINES);
    expect(capturedForPhase).toHaveLength(reportedForPhase);
    expect(captured.filter((record) => record.line === COMPACTION_LINE)).toHaveLength(1);
    expect(wiring.monitor.getCurrentState(runId)?.declinedChunks).toBe(0);
  });

  it('leaves the Run non-terminal at both layers while the phase child is alive', async () => {
    const { runId, phase } = await admitSoleRunHeldAtItsPhase();
    compactionThenLivePhase(runId, phase);
    for (const line of PHASE_LINES) stdout(runId, PHASE_INVOCATION, line);

    // The layer that lied in the field: the monitor read `completed` while the
    // child it was supposed to be watching had six hours left to run.
    const state = wiring.monitor.getCurrentState(runId);
    expect(state?.status).toBe('running');
    expect(state?.exitCode).toBeNull();
    expect(state?.stdoutLines).toBe(PHASE_LINES.length + 1);

    // And the layer that did not: the scripted invocation is still parked, so
    // the Run record is still running, still the only key, still at cap 1. This
    // is the parity half — the monitor grew invocation-level state and the
    // single-queue record did not change shape underneath it.
    expect(harness.store.getRun(SOLE_QUEUE)?.status).toBe('running');
    expect(harness.runKeys()).toEqual([SOLE_QUEUE]);
    expect(harness.store.getGlobalConcurrencyCap()).toBe(1);
  });

  it('keeps the stall detector armed across the helper exit, at cap 1', async () => {
    const { runId, phase } = await admitSoleRunHeldAtItsPhase();

    // Faked from here so every timer the detector creates is a fake one. The
    // detector is built in `onStart` and armed from the first spawn, both of
    // which are below this line; arming it on the real clock first and swapping
    // afterwards would leave a live 90-second handle behind.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      compactionThenLivePhase(runId, phase);
      stdout(runId, PHASE_INVOCATION, FIRST_PHASE_LINE);

      // Under the defect the helper's exit disposed this detector, so the phase
      // child could go silent for six hours and nothing would say so.
      vi.advanceTimersByTime(MONITOR_STALL_THRESHOLD_MS);

      const state = wiring.monitor.getCurrentState(runId);
      expect(state?.status).toBe('stalled');
      expect(state?.detectedIssues).toContain('stall');
    } finally {
      vi.useRealTimers();
    }
  });
});
