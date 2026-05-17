// Feature 032 — Context-Preserving Phase Retries, Restarts, and Resumes.
//
// End-to-end integration coverage for the continuation-hint dispatch
// matrix. Drives the real WorkflowController + PhaseRunner +
// AuditLogWriter stack against a mocked ClaudeCliRunner; captures each
// `invoke()` call's `request.isContinue` value and reads back the
// `phase-start` audit-log entries to assert the boolean field is
// recorded in lock-step with the runner-level signal.
//
// Fixture scripted sequence (a single failing run followed by a manual
// retry-now):
//
//   1. First attempt — `transient_error` → controller arms the
//      delayed-retry watchdog.
//        Expected invoke():    isContinue absent (or false)
//        Expected audit:       isContinue=false
//   2. Retry (operator clicks Retry Now, which calls retryPhaseNow →
//      setImmediate(resumeExisting)) — runner returns `clean`.
//        Expected invoke():    isContinue=true
//        Expected audit:       isContinue=true
//   3. Subsequent phase advancement within the same driveRun — runner
//      returns `clean` for downstream phases.
//        Expected invoke():    isContinue absent (consume-and-reset)
//        Expected audit:       isContinue=false

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type {
  DelayedRetryWatchdog,
  WorkflowControllerDeps
} from '../../src/controller/workflow-controller';

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

interface CapturedInvocation {
  isContinue: boolean | undefined;
  phase: string;
  iteration: number;
}

function makeScriptedCliRunner(): {
  runner: ClaudeCliRunner;
  invocations: CapturedInvocation[];
  setOutcome: (outcomes: Array<() => RawInvocationOutput>) => void;
} {
  const invocations: CapturedInvocation[] = [];
  let scripted: Array<() => RawInvocationOutput> = [];
  let callIdx = 0;
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    invocations.push({
      isContinue: req.isContinue,
      phase: req.phase,
      iteration: req.iteration
    });
    const handler = scripted[callIdx] ?? (() => makeCleanOutput());
    callIdx++;
    return handler();
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return {
    runner,
    invocations,
    setOutcome: (outcomes) => {
      scripted = outcomes;
    }
  };
}

function makeCleanOutput(): RawInvocationOutput {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 1
  };
}

function makeTransientOutput(): RawInvocationOutput {
  return {
    stdout: '',
    stderr: 'unknown transient cli failure',
    exitCode: 1,
    killed: false,
    timedOut: false,
    durationMs: 1
  };
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(() => true),
    ownerOfRecord: vi.fn(),
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

function makeStubWatchdog(): DelayedRetryWatchdog & {
  pauseAndPoll: ReturnType<typeof vi.fn>;
  cancelPendingTimer: ReturnType<typeof vi.fn>;
} {
  return {
    pauseAndPoll: vi.fn(async () => {}),
    cancelPendingTimer: vi.fn()
  } as unknown as DelayedRetryWatchdog & {
    pauseAndPoll: ReturnType<typeof vi.fn>;
    cancelPendingTimer: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
  workspaceRoot: string;
  invocations: CapturedInvocation[];
  setOutcome: (outcomes: Array<() => RawInvocationOutput>) => void;
  watchdog: ReturnType<typeof makeStubWatchdog>;
}

async function makeHarness(memento: FakeMemento, workspaceRoot: string): Promise<Harness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const { runner, invocations, setOutcome } = makeScriptedCliRunner();
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const watchdog = makeStubWatchdog();

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
  const lock = makeLock();

  const deps: WorkflowControllerDeps = {
    auditWriter: audit,
    watchdog
  };

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    {
      cliPath: 'noop',
      cwd: workspaceRoot,
      iterationCap: 5,
      timeoutMs: 1000,
      perPhaseRulesEnabled: false
    },
    deps
  );

  return { controller, store, queue, audit, workspaceRoot, invocations, setOutcome, watchdog };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-continue-e2e-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readPhaseStartIsContinue(workspaceRoot: string): Promise<boolean[]> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  const entries = log
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { eventType: string; payload: { isContinue?: unknown } });
  return entries
    .filter((e) => e.eventType === 'phase-start')
    .map((e) => e.payload.isContinue as boolean);
}

describe('Feature 032 — end-to-end: transient_error → retry-now → clean advancement', () => {
  it('first attempt has no -c hint, retry has -c hint, subsequent dispatches reset to no -c', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);

    // Script the first invocation as transient_error so the controller
    // arms the watchdog and persists pendingRetryCause; the remaining
    // invocations return clean so the run advances through subsequent
    // phases.
    harness.setOutcome([
      () => makeTransientOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput()
    ]);

    const feature = await harness.queue.enqueue('feature continue-flag e2e');
    await harness.controller.startNew(feature, null);

    // Verify the run is in the pending-retry state.
    const persistedRun = harness.store.getRun();
    expect(persistedRun?.pendingRetryCause).toBe('transient_error');

    // Operator clicks Retry Now → schedules a setImmediate(resumeExisting).
    const retryResult = await harness.controller.retryPhaseNow();
    expect(retryResult.ok).toBe(true);

    // Drain the setImmediate-scheduled resume and the downstream async
    // I/O (audit-log writes, state.setRun, phase advancements). The
    // resume chain is:
    //   retryPhaseNow → setImmediate → resumeExisting → driveRun loop
    //                 → runner.invoke (×N) → audit append (async)
    // Each phase iteration awaits multiple I/O ops; drain generously.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // Runner-level signal:
    //   call 0 — first attempt: isContinue absent / false
    //   call 1 — retry dispatch: isContinue === true
    //   call 2+ — phase advancement: isContinue absent / false
    expect(harness.invocations.length).toBeGreaterThanOrEqual(2);
    expect(harness.invocations[0].isContinue ?? false).toBe(false);
    expect(harness.invocations[1].isContinue).toBe(true);
    for (let i = 2; i < harness.invocations.length; i++) {
      expect(harness.invocations[i].isContinue ?? false).toBe(false);
    }

    // Audit-level signal (must mirror runner-level):
    //   start 0 — first attempt:    isContinue=false
    //   start 1 — retry dispatch:   isContinue=true
    //   start 2+ — advancement:     isContinue=false
    const phaseStartIsContinue = await readPhaseStartIsContinue(tmpRoot);
    expect(phaseStartIsContinue.length).toBeGreaterThanOrEqual(2);
    expect(phaseStartIsContinue[0]).toBe(false);
    expect(phaseStartIsContinue[1]).toBe(true);
    for (let i = 2; i < phaseStartIsContinue.length; i++) {
      expect(phaseStartIsContinue[i]).toBe(false);
    }
  });
});
