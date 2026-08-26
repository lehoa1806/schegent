// Feature 065 / BUG-006 (T071 step 6) — Integration coverage for the
// rate-limit retry-cap → scheduled-restore handoff.
//
// Sub-cases (per tasks.md T071 step 6):
//   (a) Success — plain-text reset format on stderr (BUG-006 plain fixture)
//       → queue lifecycle transitions to `idle-pending`,
//       `scheduledStartSource === 'system-rate-limit-recovery'`,
//       coordinator armed, both new audit events emitted.
//   (b) Success — stream-json `rate_limit_event` record on stdout
//       (BUG-006 stream-json fixture) → same as (a).
//   (c) Parse failure — neither stdout nor stderr carries a parseable
//       signal → legacy operator-paused lifecycle preserved,
//       `system-pause-restore-unavailable` with `fallbackReason ===
//       'unparseable-reset'`.
//   (d) Past timestamp — parsed epoch is in the past →
//       `fallbackReason === 'past-reset'`, legacy lifecycle preserved.
//   (e) Beyond horizon — parsed epoch is beyond the 7-day cap →
//       `fallbackReason === 'over-horizon-reset'`, legacy lifecycle preserved.
//   (f) Non-rate-limit pause cause (`transient_error`) — legacy path
//       unchanged; neither new audit event emitted; lifecycle is the
//       legacy `setQueuePausedState(true, …)` operator-paused branch.
//   (g) Coordinator fire — after a successful arm, advancing the fake
//       clock past the buffered restore target fires the coordinator;
//       lifecycle returns to `running` via the FR-012 path; the
//       previously-paused row is the same featureId selected (FR-027).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetryHandler, type RetryHandlerDeps } from '../../src/controller/retry-handler';
import { RETRY_BUFFER_MS } from '../../src/contracts/retry-bounds';
import { SCHEDULED_START_MAX_HORIZON_MS } from '../../src/services/guarded-run-service';
import type { WorkflowRun, PhaseResult } from '../../src/state/workflow-run';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-placeholder',
    featureDir: '/tmp/feat-placeholder',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: h.clock.now(),
    lastTransitionAt: h.clock.now(),
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

function makePhaseResult(stdout = '', stderr = ''): PhaseResult {
  return {
    phase: 'speckit-plan',
    iteration: 1,
    startedAt: h.clock.now() - 1_000,
    endedAt: h.clock.now(),
    result: 'rate_limited',
    terminationReason: 'error',
    exitCode: 1,
    stdoutSummary: stdout,
    stderrSummary: stderr,
    auditEntryId: null
  } as PhaseResult;
}

interface HandlerTracker {
  notifierWarnCalls: string[];
  statusBarCalls: unknown[];
  retryCap: number;
}

function makeRetryHandler(
  opts: { retryCap?: number } = {}
): { handler: RetryHandler; tracker: HandlerTracker } {
  const tracker: HandlerTracker = {
    notifierWarnCalls: [],
    statusBarCalls: [],
    retryCap: opts.retryCap ?? 3
  };
  const deps: RetryHandlerDeps = {
    store: h.store,
    queue: h.queue,
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
    logger: h.logger as unknown as RetryHandlerDeps['logger'],
    // Feature 093 (T045) — the handler arms the deadline through the
    // coordinator, naming the queue, instead of reaching for the window's one
    // watchdog. This suite asserts retry-cap and restore behavior, not timer
    // wiring, so the arm is a no-op here as the watchdog stub was.
    armDelayedRetry: async () => {},
    auditWriter: {
      append: (entry: never) => h.audit.append(entry)
    } as unknown as RetryHandlerDeps['auditWriter'],
    getRetryCap: () => tracker.retryCap,
    persistTransition: async (_prev: WorkflowRun, next: WorkflowRun) => next,
    getGuardedRunService: () => h.service,
    clock: () => h.clock.now()
  };
  return { handler: new RetryHandler(deps), tracker };
}

async function enqueueInFlight(): Promise<string> {
  const enq = await h.queue.enqueue('rate-limit-retry-cap', { pipelineId: 'default' });
  await h.queue.markInFlight(enq.id, 'run-1');
  return enq.id;
}

describe('Feature 065 BUG-006 (T071 step 6) — retry-cap → scheduled-restore handoff (FR-028)', () => {
  it('(a) success — plain-text reset on stderr arms the scheduled restore', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    // Choose a "now" such that "1:10am Asia/Saigon" rolls forward 24h
    // (per parser's `now - candidate > 12h` clause) and ends up in the
    // future within the 7-day horizon. now = 2026-05-22 16:00 UTC →
    // Saigon clock is 23:00 same day; compose 01:10 same UTC day in
    // Saigon = 2026-05-21 18:10 UTC (~22h in past) → rolls forward to
    // 2026-05-22 18:10 UTC ≈ now + 2h10m.
    const nowMs = Date.UTC(2026, 4, 22, 16, 0, 0);
    h.clock.set(nowMs);

    const stderr = "You're out of extra usage · resets 1:10am (Asia/Saigon)";
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult('', stderr);

    const baselineRestore = h.audit.byType('system-pause-scheduled-restore').length;
    const baselineEntered = h.audit.byType('idle-pending-entered').length;
    const baselineUnavailable = h.audit.byType('system-pause-restore-unavailable').length;

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

    const q = h.store.getQueue('default');
    expect(q.queueLifecycle).toBe('idle-pending');
    expect(q.scheduledStartSource).toBe('system-rate-limit-recovery');
    expect(typeof q.scheduledStartAt).toBe('number');
    expect(q.scheduledStartAt!).toBeGreaterThan(nowMs);
    // inFlightId preserved across the system pause.
    expect(q.inFlightId).toBe(featureId);
    // Task transitioned to 'paused' with phase-paused cause.
    const task = q.requests.find((r) => r.id === featureId)!;
    expect(task.status).toBe('paused');
    expect(task.pauseCause).toBe('phase-paused');

    expect(h.audit.byType('system-pause-scheduled-restore').length).toBe(
      baselineRestore + 1
    );
    expect(h.audit.byType('idle-pending-entered').length).toBe(baselineEntered + 1);
    expect(h.audit.byType('system-pause-restore-unavailable').length).toBe(
      baselineUnavailable
    );

    // FR-023a — consistent core payload.
    const restoreEvent = h.audit.byType('system-pause-scheduled-restore').slice(-1)[0];
    expect(restoreEvent.payload).toMatchObject({
      queueId: 'default',
      transitionReason: 'retry-cap-exhausted',
      pauseCauseCategory: 'rate-limit',
      scheduledStartSource: 'system-rate-limit-recovery'
    });
  });

  it('(b) success — stream-json `rate_limit_event` on stdout arms the scheduled restore', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    const nowMs = 1_750_000_000_000;
    h.clock.set(nowMs);

    // resetsAt (seconds) = 1 hour ahead.
    const resetsAtSec = Math.floor((nowMs + 60 * 60 * 1000) / 1000);
    const stdout =
      `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAtSec}}}`;
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult(stdout, '');

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

    const q = h.store.getQueue('default');
    expect(q.queueLifecycle).toBe('idle-pending');
    expect(q.scheduledStartSource).toBe('system-rate-limit-recovery');
    // Buffered restore target = resetsAtMs + RETRY_BUFFER_MS.
    expect(q.scheduledStartAt).toBe(resetsAtSec * 1000 + RETRY_BUFFER_MS);
    expect(q.inFlightId).toBe(featureId);
    expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(1);
  });

  it('(c) fallback — unparseable reset emits system-pause-restore-unavailable + legacy lifecycle', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult('no signal here', 'still no signal');

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

    const q = h.store.getQueue('default');
    // Legacy operator-paused lifecycle preserved.
    expect(q.queueLifecycle).toBe('operator-paused');
    expect(q.scheduledStartAt).toBeNull();
    expect(q.scheduledStartSource).toBeNull();

    expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(0);
    const unavail = h.audit.byType('system-pause-restore-unavailable');
    expect(unavail).toHaveLength(1);
    expect(unavail[0].payload).toMatchObject({
      pauseCauseCategory: 'rate-limit',
      fallbackReason: 'unparseable-reset',
      transitionReason: 'retry-cap-exhausted'
    });
  });

  it('(d) fallback — past-reset emits system-pause-restore-unavailable with past-reset', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    const nowMs = 1_750_000_000_000;
    h.clock.set(nowMs);

    // Past resetsAt (10 minutes ago in seconds).
    const pastResetsAtSec = Math.floor((nowMs - 10 * 60 * 1000) / 1000);
    const stdout =
      `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${pastResetsAtSec}}}`;
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult(stdout, '');

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

    const q = h.store.getQueue('default');
    expect(q.queueLifecycle).toBe('operator-paused');
    expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(0);
    const unavail = h.audit.byType('system-pause-restore-unavailable');
    expect(unavail).toHaveLength(1);
    expect(unavail[0].payload).toMatchObject({ fallbackReason: 'past-reset' });
  });

  it('(e) fallback — beyond-horizon emits system-pause-restore-unavailable with over-horizon-reset', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    const nowMs = 1_750_000_000_000;
    h.clock.set(nowMs);

    // 30 days ahead — well past the 7-day horizon.
    const overHorizonSec = Math.floor((nowMs + 30 * 24 * 60 * 60 * 1000) / 1000);
    const stdout =
      `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${overHorizonSec}}}`;
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult(stdout, '');

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

    const q = h.store.getQueue('default');
    expect(q.queueLifecycle).toBe('operator-paused');
    expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(0);
    const unavail = h.audit.byType('system-pause-restore-unavailable');
    expect(unavail).toHaveLength(1);
    expect(unavail[0].payload).toMatchObject({ fallbackReason: 'over-horizon-reset' });
    // Verify the buffered value really is over horizon.
    expect(overHorizonSec * 1000 + RETRY_BUFFER_MS).toBeGreaterThan(
      nowMs + SCHEDULED_START_MAX_HORIZON_MS
    );
  });

  it('(f) non-rate-limit cause (transient_error) preserves legacy behavior — no new audit events', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult(
      "You're out of extra usage · resets 1:10am (Asia/Saigon)",
      ''
    );

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'transient_error');

    const q = h.store.getQueue('default');
    expect(q.queueLifecycle).toBe('operator-paused');
    expect(q.scheduledStartAt).toBeNull();
    expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(0);
    expect(h.audit.byType('system-pause-restore-unavailable')).toHaveLength(0);
  });

  // Bugfix 2026-05-23 — BUG-008: FR-028 amendment. A successful CLI
  // completion (`exitCode === 0`) is NEVER a rate-limit failure
  // regardless of payload content. The precondition guard at the FR-028
  // ingress (`scheduleQueuePauseAndFail`) MUST short-circuit BEFORE any
  // `transitionToScheduledRestore` call. The 4-layer defense in depth
  // (detector, extractor, parser, retry-handler) makes the synthetic
  // `cause === 'rate_limit'` + `exitCode === 0` co-occurrence
  // unreachable in normal flow; the test constructs it explicitly to
  // assert the ingress guard.
  describe('BUG-008 — successful invocation (exitCode === 0) MUST NOT activate FR-028', () => {
    it('(h) success exit 0 with stderr `allowed_warning` courtesy phrase — no FR-028 activation', async () => {
      const featureId = await enqueueInFlight();
      const { handler } = makeRetryHandler();
      const nowMs = 1_750_000_000_000;
      h.clock.set(nowMs);

      const run = makeRun({ featureId, delayedRetryCount: 2 });
      const phaseResult: PhaseResult = {
        ...makePhaseResult('', 'rate limit warning approaching cap'),
        exitCode: 0
      };

      await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

      const q = h.store.getQueue('default');
      // Lifecycle MUST NOT enter idle-pending; the legacy operator-paused
      // path is taken because the ingress precondition fails.
      expect(q.queueLifecycle).toBe('operator-paused');
      expect(q.scheduledStartAt).toBeNull();
      expect(q.scheduledStartSource).toBeNull();
      // Neither additive audit event MAY fire.
      expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(0);
      expect(h.audit.byType('system-pause-restore-unavailable')).toHaveLength(0);
    });

    it('(i) success exit 0 with stdout `allowed_warning` rate_limit_event — no FR-028 activation', async () => {
      const featureId = await enqueueInFlight();
      const { handler } = makeRetryHandler();
      const nowMs = 1_750_000_000_000;
      h.clock.set(nowMs);

      const resetsAtSec = Math.floor((nowMs + 60 * 60 * 1000) / 1000);
      const stdout =
        `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":${resetsAtSec}}}`;
      const run = makeRun({ featureId, delayedRetryCount: 2 });
      const phaseResult: PhaseResult = {
        ...makePhaseResult(stdout, ''),
        exitCode: 0
      };

      await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

      const q = h.store.getQueue('default');
      expect(q.queueLifecycle).toBe('operator-paused');
      expect(q.scheduledStartAt).toBeNull();
      expect(q.scheduledStartSource).toBeNull();
      expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(0);
      expect(h.audit.byType('system-pause-restore-unavailable')).toHaveLength(0);
    });

    it('(j) genuine failure (exit !== 0) with mixed allowed_warning lines + trailing rejected — FR-028 activates on trailing rejected', async () => {
      const featureId = await enqueueInFlight();
      const { handler } = makeRetryHandler();
      const nowMs = 1_750_000_000_000;
      h.clock.set(nowMs);

      const earlierWarnSec = Math.floor((nowMs + 30 * 60 * 1000) / 1000);
      const trailingRejectedSec = Math.floor((nowMs + 60 * 60 * 1000) / 1000);
      // Multiple lines: earlier `allowed_warning` payloads are skipped;
      // the reverse-iteration scan settles on the trailing `rejected`
      // payload and uses its `resetsAt`.
      const stdout = [
        `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":${earlierWarnSec}}}`,
        `{"type":"assistant","message":{}}`,
        `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${trailingRejectedSec}}}`
      ].join('\n');
      const run = makeRun({ featureId, delayedRetryCount: 2 });
      const phaseResult: PhaseResult = {
        ...makePhaseResult(stdout, ''),
        exitCode: 1
      };

      await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

      const q = h.store.getQueue('default');
      expect(q.queueLifecycle).toBe('idle-pending');
      expect(q.scheduledStartSource).toBe('system-rate-limit-recovery');
      // The trailing `rejected` `resetsAt` MUST be the chosen epoch.
      expect(q.scheduledStartAt).toBe(trailingRejectedSec * 1000 + RETRY_BUFFER_MS);
      expect(h.audit.byType('system-pause-scheduled-restore')).toHaveLength(1);
    });
  });

  it('(g) coordinator fire — advancing past restore target transitions lifecycle back to running', async () => {
    const featureId = await enqueueInFlight();
    const { handler } = makeRetryHandler();
    const nowMs = 1_750_000_000_000;
    h.clock.set(nowMs);

    const resetsAtSec = Math.floor((nowMs + 60 * 60 * 1000) / 1000);
    const stdout =
      `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAtSec}}}`;
    const run = makeRun({ featureId, delayedRetryCount: 2 });
    const phaseResult = makePhaseResult(stdout, '');

    await handler.scheduleQueuePauseAndFail(run, 1, phaseResult, 'rate_limit');

    const armed = h.store.getQueue('default');
    expect(armed.queueLifecycle).toBe('idle-pending');
    const target = armed.scheduledStartAt!;
    expect(typeof target).toBe('number');

    // Advance the fake clock past the buffered restore target. The
    // harness's `fakeTimer.fireDue(now)` fires the coordinator's
    // internal timer, which triggers the `onFire` callback wired in
    // `makeHarness` (idle-pending → running, scheduledStartAt cleared).
    h.clock.set(target + 1);
    h.fakeTimer.fireDue(h.clock.now());
    await new Promise((r) => setImmediate(r));

    const fired = h.store.getQueue('default');
    expect(fired.queueLifecycle).toBe('running');
    expect(fired.scheduledStartAt).toBeNull();
    expect(fired.scheduledStartSource).toBeNull();
    expect(h.audit.byType('scheduled-start-fired')).toHaveLength(1);
    // Same featureId still bound — selection (FR-027) survives the cycle.
    expect(fired.inFlightId).toBe(featureId);
  });
});
