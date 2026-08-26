/**
 * Feature 034 Item 047 — RetryHandler isolation tests.
 *
 * These tests exercise `src/controller/retry-handler.ts` directly with stub
 * deps. They complement the existing controller-driven coverage in
 * `delayed-retry.test.ts` and `workflow-controller-dynamic-backoff.test.ts`,
 * which exercise the handler through the full `driveRun()` pipeline.
 *
 * Coverage matrix:
 *   - handleDelayedRetry (under cap)  — persists `paused`, increments count,
 *     keeps the `pendingRetryAt`/`Cause` invariant, emits `retry-scheduled`
 *     with pre-buffer `resetsAtMs`, arms the watchdog with the computed
 *     backoff.
 *   - handleDelayedRetry (at cap)     — delegates to `scheduleQueuePauseAndFail`.
 *   - scheduleQueuePauseAndFail       — pauses the queue with
 *     `retry-cap-exhausted:<runId>`, emits `queue-paused`, notifies operator,
 *     resets `pendingRetryAt`/`Cause` to null.
 *   - maybeEmitRetryRecovered         — clean+priorCount>0 path resets +
 *     audits; non-clean / count-0 paths are no-ops.
 *   - appendManualRetryAudit          — emits `retry-manual` with operator
 *     payload.
 *   - watchdog === null               — logs WARN, persists state, but does
 *     not call `pauseAndPoll` (preserves the original late-bind semantics).
 *
 * Note: `RateLimitBackoff` is covered by `rate-limit-backoff.test.ts`. The
 * handler's `handleDelayedRetry` consumes `backoffForCause` and we assert the
 * audit payload reflects the pre-buffer epoch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryHandler, type DelayedRetryWatchdog, type RetryHandlerDeps } from '../../../src/controller/retry-handler';
import type { WorkflowRun, PhaseResult } from '../../../src/state/workflow-run';
import {
  DELAYED_RETRY_CAP,
  RATE_LIMIT_BACKOFF_MS,
  TRANSIENT_BACKOFF_MS
} from '../../../src/contracts/retry-bounds';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: '/tmp/feat-1',
    status: 'running',
    currentPhase: 'specify',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

function makePhaseResult(overrides: Partial<PhaseResult> = {}): PhaseResult {
  const now = Date.now();
  return {
    phase: 'specify',
    iteration: 1,
    startedAt: now - 1_000,
    endedAt: now,
    result: 'transient_error',
    terminationReason: 'error',
    exitCode: 1,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null,
    ...overrides
  } as PhaseResult;
}

interface TestDeps {
  retryCap: number;
  /** Feature 093 (T045) — the queue the fake `queueIdForTask` reports. */
  queueId: string;
  watchdog: DelayedRetryWatchdog | null;
  /**
   * Feature 093 (T045) — what the handler armed, and for which queue. The
   * handler no longer touches the watchdog itself; it calls `armDelayedRetry`,
   * and `RetryCoordinator` is what turns that into a `pauseAndPoll`. The
   * stand-in below forwards to `tracker.watchdog` so the existing assertions on
   * cause and duration keep testing the same values at the same seam.
   */
  watchdogCalls: Array<{
    queueId: string;
    cause: string;
    durationOverrideMs?: number;
    skipStatusCheck?: boolean;
  }>;
  storeCalls: Array<{ prev: WorkflowRun; next: WorkflowRun }>;
  setQueuePausedStateCalls: Array<[boolean, string | undefined, string | null | undefined, string | undefined]>;
  pauseTaskCalls: Array<[string, string]>;
  auditAppendCalls: Array<Record<string, unknown>>;
  warnCalls: string[];
  debugCalls: Array<{ msg: string; ctx?: unknown }>;
  statusBarCalls: Array<unknown>;
  notifierWarnCalls: string[];
}

function makeHandler(opts: Partial<TestDeps> = {}): { handler: RetryHandler; tracker: TestDeps; deps: RetryHandlerDeps } {
  const tracker: TestDeps = {
    retryCap: opts.retryCap ?? DELAYED_RETRY_CAP,
    queueId: opts.queueId ?? 'queue-a',
    watchdog: opts.watchdog === undefined ? {
      pauseAndPoll: vi.fn(async () => {}),
      cancelPendingTimer: vi.fn()
    } : opts.watchdog,
    watchdogCalls: [],
    storeCalls: [],
    setQueuePausedStateCalls: [],
    pauseTaskCalls: [],
    auditAppendCalls: [],
    warnCalls: [],
    debugCalls: [],
    statusBarCalls: [],
    notifierWarnCalls: []
  };

  const deps: RetryHandlerDeps = {
    store: {} as RetryHandlerDeps['store'],
    queue: {
      setQueuePausedState: vi.fn(
        async (
          paused: boolean,
          queueId: string | undefined,
          reason: string | null | undefined,
          pauseSource: string | undefined
        ) => {
          tracker.setQueuePausedStateCalls.push([paused, queueId, reason, pauseSource]);
          return { ok: true, queueId: queueId ?? 'default' };
        }
      ),
      pause: vi.fn(async (featureId: string, cause: string) => {
        tracker.pauseTaskCalls.push([featureId, cause]);
      }),
      // Feature 093 (T045) — the handler derives the queue from the Run's task.
      queueIdForTask: vi.fn(() => tracker.queueId)
    } as unknown as RetryHandlerDeps['queue'],
    statusBar: {
      update: vi.fn((arg: unknown) => {
        tracker.statusBarCalls.push(arg);
      })
    } as unknown as RetryHandlerDeps['statusBar'],
    notifier: {
      info: vi.fn(),
      warn: vi.fn((msg: string) => {
        tracker.notifierWarnCalls.push(msg);
      }),
      error: vi.fn()
    } as unknown as RetryHandlerDeps['notifier'],
    logger: {
      debug: vi.fn((msg: string, ctx?: unknown) => {
        tracker.debugCalls.push({ msg, ctx });
      }),
      warn: vi.fn((msg: string) => {
        tracker.warnCalls.push(msg);
      }),
      info: vi.fn(),
      error: vi.fn()
    } as unknown as RetryHandlerDeps['logger'],
    // Feature 093 (T045) — stands in for `RetryCoordinator.armDelayedRetry`,
    // reproducing the one behavior the handler depends on: forward to the
    // watchdog when there is one. The not-wired warning moved with the
    // forwarding and is covered in tests/unit/services/retry-coordinator.test.ts.
    armDelayedRetry: async (queueId: string, cause: string, delayMs: number) => {
      tracker.watchdogCalls.push({
        queueId,
        cause,
        durationOverrideMs: delayMs,
        skipStatusCheck: true
      });
      await tracker.watchdog?.pauseAndPoll(cause, {
        durationOverrideMs: delayMs,
        skipStatusCheck: true
      });
    },
    auditWriter: {
      append: vi.fn(async (entry: Record<string, unknown>) => {
        tracker.auditAppendCalls.push(entry);
      })
    } as unknown as RetryHandlerDeps['auditWriter'],
    getRetryCap: () => tracker.retryCap,
    persistTransition: async (prev: WorkflowRun, next: WorkflowRun) => {
      tracker.storeCalls.push({ prev, next });
      return next;
    }
  };
  return { handler: new RetryHandler(deps), tracker, deps };
}

describe('Feature 034 Item 047 — RetryHandler (extracted from workflow-controller)', () => {
  describe('handleDelayedRetry — under cap', () => {
    let beforeMs: number;

    beforeEach(() => {
      beforeMs = Date.now();
    });

    it('persists paused state, appends phase result, increments delayedRetryCount, arms watchdog (transient_error)', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult();

      const result = await handler.handleDelayedRetry(run, 1, phaseResult, 'transient_error', null, null);

      expect(result.status).toBe('paused');
      expect(result.delayedRetryCount).toBe(1);
      expect(result.pendingRetryCause).toBe('transient_error');
      expect(result.pendingRetryAt).not.toBeNull();
      expect(result.phasesCompleted).toHaveLength(1);
      expect(result.phasesCompleted[0]).toBe(phaseResult);

      // Backoff is fixed for transient errors.
      const offset = result.pendingRetryAt! - beforeMs;
      expect(offset).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS - 50);

      // Watchdog armed with the computed backoff.
      expect(tracker.watchdogCalls).toHaveLength(1);
      expect(tracker.watchdogCalls[0]).toMatchObject({
        cause: 'transient_error',
        durationOverrideMs: TRANSIENT_BACKOFF_MS,
        skipStatusCheck: true
      });
    });

    it('uses the fixed RATE_LIMIT_BACKOFF_MS fallback when resetsAtMs is null', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult({ result: 'rate_limited' });

      const result = await handler.handleDelayedRetry(run, 1, phaseResult, 'rate_limit', null, 'over rate limit');

      expect(result.pendingRetryCause).toBe('rate_limit');
      expect(tracker.watchdogCalls[0].durationOverrideMs).toBe(RATE_LIMIT_BACKOFF_MS);
    });

    it('uses the dynamic delta + buffer when resetsAtMs is parseable', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult({ result: 'rate_limited' });
      // 10 minutes in the future.
      const resetsAtMs = Date.now() + 10 * 60 * 1000;

      await handler.handleDelayedRetry(run, 1, phaseResult, 'rate_limit', resetsAtMs, 'over rate limit');

      const armedFor = tracker.watchdogCalls[0].durationOverrideMs as number;
      // dynamicWait = (resetsAtMs - now) + RETRY_BUFFER_MS ≈ 10min + 60s.
      expect(armedFor).toBeGreaterThan(10 * 60 * 1000);
      expect(armedFor).toBeLessThan(12 * 60 * 1000);
    });

    it('emits retry-scheduled audit with the pre-buffer resetsAtMs (NOT + RETRY_BUFFER_MS) — CLAUDE.md hard rule', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult({ result: 'rate_limited' });
      const resetsAtMs = Date.now() + 5 * 60 * 1000;

      await handler.handleDelayedRetry(run, 1, phaseResult, 'rate_limit', resetsAtMs, 'over rate limit');

      const audit = tracker.auditAppendCalls.find((c) => c.eventType === 'retry-scheduled');
      expect(audit).toBeDefined();
      const payload = audit!.payload as Record<string, unknown>;
      expect(payload.cause).toBe('rate_limit');
      expect(payload.resetsAtMs).toBe(resetsAtMs);
      // scheduledAt should equal Date.now()+backoff at the moment of mutation
      // but importantly should differ from resetsAtMs by RETRY_BUFFER_MS.
      const scheduledAt = payload.scheduledAt as number;
      expect(scheduledAt).toBeGreaterThan(resetsAtMs);
      expect(payload.delayedRetryCount).toBe(1);
    });

    it('logs a single DEBUG line carrying the rate-limit message + parsed epoch + computed backoff (BUG-002 / FR-017)', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult({ result: 'rate_limited' });
      const resetsAtMs = Date.now() + 3 * 60 * 1000;
      const cliMessage = 'rate-limit reached; please retry after 1:10am';

      await handler.handleDelayedRetry(run, 1, phaseResult, 'rate_limit', resetsAtMs, cliMessage);

      const retryDebug = tracker.debugCalls.find((c) =>
        c.msg.includes('delayed-retry: scheduling backoff')
      );
      expect(retryDebug).toBeDefined();
      const ctx = retryDebug!.ctx as Record<string, unknown>;
      expect(ctx.cause).toBe('rate_limit');
      expect(ctx.resetsAtMs).toBe(resetsAtMs);
      expect(ctx.rateLimitMessage).toBe(cliMessage);
      expect(typeof ctx.backoffMs).toBe('number');
      expect(typeof ctx.scheduledAt).toBe('number');
    });

    it('arms the deadline against the queue that owns the Run (Feature 093 FR-024)', async () => {
      const { handler, tracker } = makeHandler({ queueId: 'queue-b' });
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult();

      await handler.handleDelayedRetry(run, 1, phaseResult, 'transient_error', null, null);

      // The arm names a queue. Unaddressed, N Runs collapse onto one deadline
      // and the last one to schedule silently owns the window's only timer.
      expect(tracker.watchdogCalls).toHaveLength(1);
      expect(tracker.watchdogCalls[0].queueId).toBe('queue-b');
    });

    it('persists the retry state even when the arm cannot schedule anything', async () => {
      // The watchdog-not-wired case: the handler's job is the state mutation,
      // and whether a deadline can physically be armed is the coordinator's
      // (see tests/unit/services/retry-coordinator.test.ts, which owns the WARN).
      const { handler, tracker } = makeHandler({ watchdog: null });
      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult();

      const result = await handler.handleDelayedRetry(run, 1, phaseResult, 'transient_error', null, null);

      expect(result.status).toBe('paused');
      expect(result.delayedRetryCount).toBe(1);
      expect(result.pendingRetryAt).not.toBeNull();
      expect(tracker.warnCalls.some((m) => m.includes('watchdog not wired'))).toBe(false);
    });
  });

  describe('handleDelayedRetry — at cap', () => {
    it('delegates to scheduleQueuePauseAndFail when delayedRetryCount === cap - 1', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: DELAYED_RETRY_CAP - 1, currentPhase: 'plan' });
      const phaseResult = makePhaseResult({ phase: 'plan' });

      const result = await handler.handleDelayedRetry(run, 3, phaseResult, 'transient_error', null, null);

      // Cap path: count reaches cap, pending fields are null, queue is paused.
      expect(result.status).toBe('paused');
      expect(result.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
      expect(result.pendingRetryAt).toBeNull();
      expect(result.pendingRetryCause).toBeNull();

      // Queue paused with the correct reason format and pauseSource.
      expect(tracker.setQueuePausedStateCalls).toEqual([
        [true, undefined, `retry-cap-exhausted:${run.id}`, 'retry-cap']
      ]);
      // In-flight task paused with `phase-paused`.
      expect(tracker.pauseTaskCalls).toEqual([[run.featureId, 'phase-paused']]);

      // Audit event emitted.
      const audit = tracker.auditAppendCalls.find((c) => c.eventType === 'queue-paused');
      expect(audit).toBeDefined();
      const payload = audit!.payload as Record<string, unknown>;
      expect(payload.reason).toBe('retry-cap-exhausted');
      expect(payload.cause).toBe('transient_error');
      expect(payload.delayedRetryCount).toBe(DELAYED_RETRY_CAP);

      // Operator notified.
      expect(tracker.notifierWarnCalls).toHaveLength(1);
      expect(tracker.notifierWarnCalls[0]).toContain('delayed-retry cap');
      expect(tracker.notifierWarnCalls[0]).toContain(String(DELAYED_RETRY_CAP));
    });

    it('honors a custom retryCap from getRetryCap', async () => {
      const { handler, tracker } = makeHandler({ retryCap: 2 });
      const run = makeRun({ delayedRetryCount: 1 });
      const phaseResult = makePhaseResult();

      const result = await handler.handleDelayedRetry(run, 1, phaseResult, 'transient_error', null, null);

      expect(result.delayedRetryCount).toBe(2);
      expect(tracker.setQueuePausedStateCalls).toEqual([
        [true, undefined, `retry-cap-exhausted:${run.id}`, 'retry-cap']
      ]);
    });
  });

  describe('scheduleQueuePauseAndFail', () => {
    it('clears the pending pair when the cap is reached (CLAUDE.md pair invariant)', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({
        delayedRetryCount: DELAYED_RETRY_CAP - 1,
        pendingRetryAt: 1_700_000_001_000,
        pendingRetryCause: 'rate_limit'
      });
      const phaseResult = makePhaseResult();

      const result = await handler.scheduleQueuePauseAndFail(run, 2, phaseResult, 'rate_limit');

      expect(result.pendingRetryAt).toBeNull();
      expect(result.pendingRetryCause).toBeNull();
      expect(result.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
      expect(tracker.statusBarCalls).toHaveLength(1);
    });
  });

  describe('maybeEmitRetryRecovered', () => {
    it('is a no-op when outcome !== "clean"', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 3 });

      const result = await handler.maybeEmitRetryRecovered(run, 'transient_error');

      expect(result).toBe(run);
      expect(tracker.storeCalls).toHaveLength(0);
      expect(tracker.auditAppendCalls).toHaveLength(0);
    });

    it('is a no-op when delayedRetryCount === 0', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({ delayedRetryCount: 0 });

      const result = await handler.maybeEmitRetryRecovered(run, 'clean');

      expect(result).toBe(run);
      expect(tracker.storeCalls).toHaveLength(0);
      expect(tracker.auditAppendCalls).toHaveLength(0);
    });

    it('resets counters and emits retry-recovered with priorDelayedRetryCount when clean after retry', async () => {
      const { handler, tracker } = makeHandler();
      const run = makeRun({
        delayedRetryCount: 2,
        pendingRetryAt: 1_700_000_001_000,
        pendingRetryCause: 'transient_error'
      });

      const result = await handler.maybeEmitRetryRecovered(run, 'clean');

      expect(result.delayedRetryCount).toBe(0);
      expect(result.pendingRetryAt).toBeNull();
      expect(result.pendingRetryCause).toBeNull();

      const audit = tracker.auditAppendCalls.find((c) => c.eventType === 'retry-recovered');
      expect(audit).toBeDefined();
      const payload = audit!.payload as Record<string, unknown>;
      expect(payload.priorDelayedRetryCount).toBe(2);
      expect(payload.runId).toBe(run.id);
    });
  });

  describe('appendManualRetryAudit', () => {
    it('emits a retry-manual audit event with outcome=info', async () => {
      const { handler, tracker } = makeHandler();

      await handler.appendManualRetryAudit({
        runId: 'run-9',
        phase: 'tasks',
        iteration: 4,
        payload: { runId: 'run-9', phaseId: 'tasks', prevDelayedRetryCount: 1, queueUnpaused: true }
      });

      expect(tracker.auditAppendCalls).toHaveLength(1);
      const entry = tracker.auditAppendCalls[0];
      expect(entry.eventType).toBe('retry-manual');
      expect(entry.outcome).toBe('info');
      expect(entry.runId).toBe('run-9');
      expect(entry.phase).toBe('tasks');
      const payload = entry.payload as Record<string, unknown>;
      expect(payload.queueUnpaused).toBe(true);
    });
  });

  describe('audit-writer absent', () => {
    it('does not throw when auditWriter is null (no-op for audit emission)', async () => {
      const { tracker, deps } = makeHandler();
      (deps as { auditWriter: unknown }).auditWriter = null;
      const handlerWithoutAudit = new RetryHandler(deps);

      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult();
      const result = await handlerWithoutAudit.handleDelayedRetry(run, 1, phaseResult, 'transient_error', null, null);

      expect(result.delayedRetryCount).toBe(1);
      // No audits were appended (we replaced the writer).
      expect(tracker.auditAppendCalls).toHaveLength(0);
    });

    it('swallows audit-writer.append errors with a WARN', async () => {
      const { tracker, deps } = makeHandler();
      (deps as { auditWriter: unknown }).auditWriter = {
        append: async () => {
          throw new Error('write failed');
        }
      };
      const handlerWithFailingAudit = new RetryHandler(deps);

      const run = makeRun({ delayedRetryCount: 0 });
      const phaseResult = makePhaseResult();
      // Should not throw despite the failing audit writer.
      await expect(
        handlerWithFailingAudit.handleDelayedRetry(run, 1, phaseResult, 'transient_error', null, null)
      ).resolves.toBeDefined();
      expect(tracker.warnCalls.some((m) => m.includes('audit append failed'))).toBe(true);
    });
  });
});
