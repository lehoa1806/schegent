import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 011 — US1 P1 MVP: delayed-retry resilience.
//
// Integration coverage for:
//   SC-001 (5 consecutive transient failures pause the queue with
//           `retry-cap-exhausted:<runId>`).
//   SC-002 (no false-success advance — a transient_error never advances
//           the phase; the workflow stays on the failing phase).
//   SC-003 (Retry Phase Now starts within 1s — verified by setImmediate
//           dispatch + waiting <1s).
//   SC-012 (timer survives restart — pendingRetryAt persisted; a fresh
//           controller re-arms the retry deadline with the correct delay).
//
// Drives the real WorkflowController + AuditLogWriter + QueueManager
// stack; only the Claude CLI runner is faked. Timer-based assertions
// use vitest fake timers so the test runs in <500ms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type { WorkflowControllerDeps } from '../../src/controller/workflow-controller';
import { RecordingDeadlineTimer } from '../recording-deadline-timer';
import {
  DELAYED_RETRY_CAP,
  TRANSIENT_BACKOFF_MS
} from '../../src/contracts/retry-bounds';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { removeTempRoot } from '../temp-root-cleanup';

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

function makeTransientCliRunner(): ClaudeCliRunner {
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => {
    return {
      stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(''); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
      // No fatal signature, no rate-limit cause, no termination token.
      // Non-zero exit code triggers `transient_error` classification.
      exitCode: 1,
      killed: false,
      timedOut: false,
      durationMs: 1
    };
  });
  return {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
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

interface Harness {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
  workspaceRoot: string;
  /** The retry coordinator's own timer (FR-R4-F02): a delayed retry arms it, a cancel clears it. */
  deadlineTimer: RecordingDeadlineTimer;
  runner: ClaudeCliRunner;
  notifier: Notifier;
}

async function makeHarness(memento: FakeMemento, workspaceRoot: string): Promise<Harness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const runner = makeTransientCliRunner();
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const deadlineTimer = new RecordingDeadlineTimer();

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  const lock = makeLock();

  const deps: WorkflowControllerDeps = {
    catalog: buildSpeckitCatalog(),
    auditWriter: audit,
    deadlineTimer
  };

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000 },
    deps
  );
  // The admission service is wired by the activation module in production; here the one thing it
  // does that these cases observe is the hand-off, so an elapsed deadline goes to the controller's
  // capacity-aware unattended admission, which rechecks and announces inside the lease.
  controller.setBackoffElapsedHandler((wakeup) => controller.admitUnattended(wakeup.queueId, wakeup));

  return { controller, store, queue, audit, workspaceRoot, deadlineTimer, runner, notifier };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-delayed-retry-int-'));
});

afterEach(async () => {
  // `maxRetries` is load-bearing, not defensive boilerplate.
  //
  // SC-003 asserts that `retryPhaseNow` STARTS a resume within 1s. It does not
  // wait for that resume to finish, because that is not what the criterion is
  // about — so when the test body returns, a real run is still executing and
  // still writing into `tmpRoot`. Node's recursive `rm` lists a directory,
  // unlinks what it found, then `rmdir`s; a file created between the listing and
  // the rmdir makes that final step fail with ENOTEMPTY. `force: true` does not
  // help — it suppresses "already gone", not "something arrived".
  //
  // Observed as a genuine intermittent: `npm run ci` failed here with
  // `ENOTEMPTY: directory not empty` while the test itself passed, which is the
  // signature of a teardown race rather than a defect in what was tested.
  //
  // Retrying is the right response to a directory that is legitimately still in
  // use, rather than quiescing the controller here — the run continuing past the
  // assertion IS the behaviour under test, and stopping it in `afterEach` would
  // be tidying away the thing SC-003 exists to observe.
  await removeTempRoot(tmpRoot);
});

describe('Feature 011 — delayed retry end-to-end', () => {
  it('SC-001: 5 consecutive transient failures pause the queue with retry-cap-exhausted:<runId>', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);
    const feature = await harness.queue.enqueue('feature A');

    // 1st failure — drives the initial run.
    await harness.controller.startNew(feature, null);

    // Subsequent four resumes — each picks up the persisted run and
    // triggers another transient failure.
    for (let i = 0; i < 4; i++) {
      const ok = await harness.controller.resumeExisting(DEFAULT_QUEUE_ID);
      expect(ok).toBe(true);
    }

    const run = harness.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
    expect(run.pendingRetryAt).toBeNull();
    expect(run.pendingRetryCause).toBeNull();
    expect(run.status).toBe('paused');

    const queueState = harness.store.getQueue(DEFAULT_QUEUE_ID);
    expect(queueState.queueLifecycle).toBe('operator-paused');
    expect(queueState.pausedReason).toBe(`retry-cap-exhausted:${run.id}`);
  });

  it('SC-002: no false-success advance — currentPhase does not progress through transient failures', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);
    const feature = await harness.queue.enqueue('feature B');

    await harness.controller.startNew(feature, null);

    // First phase is `specify` for an unknown featureDir; after a
    // transient failure we must still be on `specify`.
    const run1 = harness.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run1.currentPhase).toBe('speckit-specify');
    expect(run1.phasesCompleted.length).toBe(1);
    // The single phaseResult is the failing attempt — not a clean
    // advance.
    expect(run1.phasesCompleted[0].phase).toBe('speckit-specify');
    expect(run1.phasesCompleted[0].result).toBe('transient_error');

    // Another resume still does not advance.
    await harness.controller.resumeExisting(DEFAULT_QUEUE_ID);
    const run2 = harness.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run2.currentPhase).toBe('speckit-specify');
  });

  it('SC-003: retryPhaseNow starts a resume within 1s (setImmediate dispatch)', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);
    const feature = await harness.queue.enqueue('feature C');
    await harness.controller.startNew(feature, null);

    const pendingRun = harness.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(pendingRun.pendingRetryAt).not.toBeNull();
    expect(harness.deadlineTimer.sets).toHaveLength(1);
    expect(harness.deadlineTimer.armed()).toHaveLength(1);

    const before = Date.now();
    const result = await harness.controller.retryPhaseNow();
    expect(result.ok).toBe(true);

    // setImmediate-driven resumeExisting fires on the next tick. Allow
    // a generous slack for CI runners; the contract is "within 1s".
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(1000);

    // The deadline the failure armed was cleared by the manual retry (the resumed Run may arm a new one).
    expect(harness.deadlineTimer.sets[0].settled).toBe(true);
    // The retry-manual audit event must have been emitted.
    const log = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    const events = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { eventType: string });
    expect(events.some((e) => e.eventType === 'retry-manual')).toBe(true);
  });

  it('SC-012: timer survives restart — pendingRetryAt persisted; second controller re-arms the retry deadline', async () => {
    const memento = new FakeMemento();
    const harness1 = await makeHarness(memento, tmpRoot);
    const feature = await harness1.queue.enqueue('feature D');
    await harness1.controller.startNew(feature, null);

    const persistedRun = harness1.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(persistedRun.pendingRetryAt).not.toBeNull();
    const persistedAt = persistedRun.pendingRetryAt!;
    // The retry should be ~15 minutes out.
    const offset = persistedAt - Date.now();
    expect(offset).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS - 1_000);
    expect(offset).toBeLessThanOrEqual(TRANSIENT_BACKOFF_MS + 1_000);

    // Simulate a VS Code restart — fresh controller, fresh timer,
    // same persisted memento.
    const harness2 = await makeHarness(memento, tmpRoot);
    await harness2.controller.resumeExistingFromActivation();

    expect(harness2.deadlineTimer.sets).toHaveLength(1);
    expect(harness2.controller.hasPendingDelayedRetry(DEFAULT_QUEUE_ID)).toBe(true);
    // The armed delay is the remaining time; should be close to the
    // original 15-minute window.
    const override = harness2.deadlineTimer.sets[0].delayMs;
    expect(override).toBeGreaterThan(0);
    expect(override).toBeLessThanOrEqual(TRANSIENT_BACKOFF_MS);
  });

  // FR-R3-192 (T1863) — path 2. A Run whose persisted retry deadline has already passed is resumed at
  // activation, with nobody at the keyboard, and the operator is told. The restart is the SC-012
  // harness: a first controller leaves the deadline persisted, a second one activates over the same
  // memento, and only the CLI runner is faked.
  describe('FR-R3-192 — path 2, a deadline already due at activation', () => {
    async function restartWithDeadline(deadlineOffsetMs: number | null) {
      const memento = new FakeMemento();
      const harness1 = await makeHarness(memento, tmpRoot);
      const feature = await harness1.queue.enqueue('feature R3-192');
      await harness1.controller.startNew(feature, null);
      const persisted = harness1.store.getRun(DEFAULT_QUEUE_ID)!;
      expect(persisted.pendingRetryAt).not.toBeNull();

      const harness2 = await makeHarness(memento, tmpRoot);
      if (deadlineOffsetMs !== null) {
        const stored = harness2.store.getRun(DEFAULT_QUEUE_ID)!;
        await harness2.store.setRun(
          DEFAULT_QUEUE_ID,
          { ...stored, pendingRetryAt: Date.now() + deadlineOffsetMs },
          harness2.store.runCommitClaim(DEFAULT_QUEUE_ID)
        );
      }
      return { harness2, runId: persisted.id };
    }

    const noOtherWork = (): Promise<void> => new Promise((done) => setImmediate(done));

    it('P2 (1): a deadline already passed raises exactly one warning naming the Run', async () => {
      const { harness2, runId } = await restartWithDeadline(-1_000);
      const warn = harness2.notifier.warn as unknown as ReturnType<typeof vi.fn>;

      await harness2.controller.resumeExistingFromActivation();
      // The resume really happened: the fake CLI was started for the resumed Run.
      await vi.waitFor(() => expect(harness2.runner.invoke).toHaveBeenCalled());
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      // The resumed Run fails transiently again and arms a fresh deadline.
      await vi.waitFor(() => expect(harness2.deadlineTimer.sets.length).toBeGreaterThan(0));

      const message = warn.mock.lastCall?.[0] as string;
      expect(message).toContain(`queue "${DEFAULT_QUEUE_ID}"`);
      expect(message).toContain(`run ${runId.slice(0, 8)} `);
      expect(message).toContain('Schegent: Show Active Run');
      expect(message).toContain('Schegent: Cancel In-Flight Workflow');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('P2 (2): a deadline not yet passed raises nothing and re-arms the retry deadline instead', async () => {
      const { harness2 } = await restartWithDeadline(null);
      const warn = harness2.notifier.warn as unknown as ReturnType<typeof vi.fn>;

      await harness2.controller.resumeExistingFromActivation();
      await noOtherWork();

      expect(harness2.deadlineTimer.sets).toHaveLength(1);
      expect(harness2.runner.invoke).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    // FR-R4-F02 (US6-7, FR-021; pins) — the delayed retry used to ride the credit watchdog's timer with
    // a one-shot `skipStatusCheck` flag, so "resumes without a status check" depended on a flag
    // crossing a boundary intact. The watchdog is no longer in this path at all: the elapsed
    // deadline resumes the Run once, and nothing here can invoke `/status`.
    it('P2 (3): an elapsed deadline resumes the Run exactly once and never invokes the status command', async () => {
      const { harness2 } = await restartWithDeadline(-1_000);
      const invoke = harness2.runner.invoke as unknown as ReturnType<typeof vi.fn>;

      await harness2.controller.resumeExistingFromActivation();
      await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
      await vi.waitFor(() => expect(harness2.deadlineTimer.sets.length).toBeGreaterThan(0));
      await noOtherWork();

      expect(invoke).toHaveBeenCalledTimes(1);
      const requests = invoke.mock.calls.map(([request]) => request as { prompt?: string; phase?: string });
      expect(requests.some((request) => request.prompt === '/status')).toBe(false);
      expect(requests.some((request) => request.phase === '(credit-watchdog)')).toBe(false);
    });

    it('I1: the warning comes before the resumed Run starts its CLI (SC-004)', async () => {
      const { harness2 } = await restartWithDeadline(-1_000);
      const warn = harness2.notifier.warn as unknown as ReturnType<typeof vi.fn>;
      const invoke = harness2.runner.invoke as unknown as ReturnType<typeof vi.fn>;

      await harness2.controller.resumeExistingFromActivation();
      await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(harness2.deadlineTimer.sets.length).toBeGreaterThan(0));

      expect(Math.min(...warn.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...invoke.mock.invocationCallOrder)
      );
    });
  });
});
