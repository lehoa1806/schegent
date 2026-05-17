// Feature 027 — Dynamic Quota Reset Countdown
//
// Integration coverage for:
//   SC-001 (US1): the controller schedules pendingRetryAt at
//                 `resetsAtMs + RETRY_BUFFER_MS` when stream-json
//                 carries a parseable `rate_limit_event.resetsAt`.
//   SC-003 (US3): the `retry-scheduled` audit event payload carries
//                 the parsed `resetsAtMs` (pre-buffer) for diagnostics.
//   SC-004 (US2): the operator-visible "You're out of extra usage"
//                 message routes through the rate-limit-family path
//                 (NOT the transient-error 15-minute path).
//
// Threads the real WorkflowController + AuditLogWriter + PhaseRunner +
// stdout parser. Only the Claude CLI is faked so the test runs with no
// I/O outside the temp workspace.

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
import { SanitizedLogger, type LogSink } from '../../src/lib/logger';
import { extractResetTimestamp } from '../../src/parser/rate-limit-reset-extractor';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type {
  DelayedRetryWatchdog,
  WorkflowControllerDeps
} from '../../src/controller/workflow-controller';
import {
  RATE_LIMIT_BACKOFF_MS,
  RETRY_BUFFER_MS
} from '../../src/controller/retry-constants';

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

// Synthesize a stream-json stdout buffer that mimics the live capture in
// `tests/fixtures/rate-limit/out-of-extra-usage-stream-json.txt` with a
// caller-controlled `resetsAt` (seconds since epoch) so tests can hold
// the parsed epoch invariant relative to `Date.now()`.
function rateLimitedStdout(resetsAtSec: number): string {
  return [
    '{"type":"system","subtype":"init","session_id":"int-027","model":"claude-sonnet-4-5","cwd":"/tmp/wsp"}',
    `{"type":"rate_limit_event","rate_limit_info":{"status":"allow","resetsAt":${resetsAtSec}}}`,
    `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAtSec}}}`
  ].join('\n');
}

function makeRateLimitedCliRunner(stdout: string, stderr: string): ClaudeCliRunner {
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => {
    return {
      stdout,
      stderr,
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
  watchdog: ReturnType<typeof makeStubWatchdog>;
  logger: SanitizedLogger;
}

async function makeHarness(
  memento: FakeMemento,
  workspaceRoot: string,
  cli: ClaudeCliRunner,
  logSinks: LogSink[] = []
): Promise<Harness> {
  const logger = new SanitizedLogger(logSinks);
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const phaseRunner = new PhaseRunner(cli, new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const watchdog = makeStubWatchdog();

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
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
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, perPhaseRulesEnabled: false },
    deps
  );

  return { controller, store, queue, audit, workspaceRoot, watchdog, logger };
}

async function readRetryScheduledPayload(workspaceRoot: string): Promise<{
  resetsAtMs: number | null;
  cause: string;
  scheduledAt: number;
}> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  const events = log
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { eventType: string; payload?: Record<string, unknown> });
  const lastRetry = [...events].reverse().find((e) => e.eventType === 'retry-scheduled');
  if (!lastRetry || !lastRetry.payload) {
    throw new Error('no retry-scheduled event in audit log');
  }
  return {
    resetsAtMs: (lastRetry.payload.resetsAtMs as number | null) ?? null,
    cause: lastRetry.payload.cause as string,
    scheduledAt: lastRetry.payload.scheduledAt as number
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-027-int-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 027 — dynamic quota reset countdown end-to-end', () => {
  it('SC-001 (US1): stream-json reset epoch threads through to pendingRetryAt = resetsAtMs + RETRY_BUFFER_MS', async () => {
    const memento = new FakeMemento();
    // 10 minutes in the future, in epoch seconds.
    const resetsAtSec = Math.floor(Date.now() / 1000) + 600;
    const expectedEpochMs = resetsAtSec * 1000;
    const cli = makeRateLimitedCliRunner(
      rateLimitedStdout(resetsAtSec),
      "You're out of extra usage"
    );
    const harness = await makeHarness(memento, tmpRoot, cli);
    const feature = await harness.queue.enqueue('feat-027-sc001');
    await harness.controller.startNew(feature, null);

    const run = harness.store.getRun()!;
    expect(run.status).toBe('paused');
    expect(run.pendingRetryCause).toBe('rate_limit');
    expect(run.pendingRetryAt).not.toBeNull();

    // pendingRetryAt = Date.now() + ((resetsAtMs - Date.now()) + RETRY_BUFFER_MS)
    //                = resetsAtMs + RETRY_BUFFER_MS
    const expectedScheduledAt = expectedEpochMs + RETRY_BUFFER_MS;
    expect(Math.abs(run.pendingRetryAt! - expectedScheduledAt)).toBeLessThan(2_000);
  });

  it('SC-003 (US3): retry-scheduled audit payload carries the parsed pre-buffer resetsAtMs', async () => {
    const memento = new FakeMemento();
    const resetsAtSec = Math.floor(Date.now() / 1000) + 600;
    const expectedEpochMs = resetsAtSec * 1000;
    const cli = makeRateLimitedCliRunner(
      rateLimitedStdout(resetsAtSec),
      "You're out of extra usage"
    );
    const harness = await makeHarness(memento, tmpRoot, cli);
    const feature = await harness.queue.enqueue('feat-027-sc003');
    await harness.controller.startNew(feature, null);

    const payload = await readRetryScheduledPayload(tmpRoot);
    expect(payload.resetsAtMs).toBe(expectedEpochMs);
    expect(payload.cause).toBe('rate_limit');
    // FR-013 — buffer derivable from scheduledAt − resetsAtMs == RETRY_BUFFER_MS.
    expect(payload.scheduledAt - payload.resetsAtMs!).toBe(RETRY_BUFFER_MS);
  });

  it('SC-001 fallback: no parseable reset in EITHER buffer → fixed RATE_LIMIT_BACKOFF_MS fallback (audit resetsAtMs is null)', async () => {
    // Bugfix 2026-05-15 — BUG-002: the prior fixture (stderr=`"You're out
    // of extra usage"` alone) was a partial phrase with no `· resets …`
    // segment — the fallback path was reached only because the canonical
    // stderr-on-plain-mode scan was missing. With the BUG-002 fix in
    // place, a stderr containing the full `· resets <time> (<tz>)`
    // segment would now correctly route to the dynamic-countdown path
    // (verified by the new T-FIX-B test below). To preserve the
    // *fallback*-path coverage that this test was intended to provide,
    // the fixture is now an unambiguous rate-limit signal with no reset
    // info in either buffer.
    const memento = new FakeMemento();
    const cli = makeRateLimitedCliRunner('', 'rate-limit hit (no reset info)');
    const harness = await makeHarness(memento, tmpRoot, cli);
    const feature = await harness.queue.enqueue('feat-027-fallback');
    await harness.controller.startNew(feature, null);

    const run = harness.store.getRun()!;
    expect(run.pendingRetryCause).toBe('rate_limit');
    const offset = run.pendingRetryAt! - Date.now();
    expect(offset).toBeGreaterThanOrEqual(RATE_LIMIT_BACKOFF_MS - 2_000);
    expect(offset).toBeLessThanOrEqual(RATE_LIMIT_BACKOFF_MS + 2_000);

    const payload = await readRetryScheduledPayload(tmpRoot);
    expect(payload.resetsAtMs).toBeNull();
    expect(payload.cause).toBe('rate_limit');
  });

  it('SC-004 (US2): "out of extra usage" routes through rate-limit-family backoff (not transient_error)', async () => {
    const memento = new FakeMemento();
    const resetsAtSec = Math.floor(Date.now() / 1000) + 600;
    const cli = makeRateLimitedCliRunner(
      rateLimitedStdout(resetsAtSec),
      "You're out of extra usage"
    );
    const harness = await makeHarness(memento, tmpRoot, cli);
    const feature = await harness.queue.enqueue('feat-027-sc004');
    await harness.controller.startNew(feature, null);

    const run = harness.store.getRun()!;
    // The cause persisted is `rate_limit` (the family-mapped
    // DelayedRetryCause), NOT `transient_error`.
    expect(run.pendingRetryCause).toBe('rate_limit');

    // The audit payload's original cause is the parser-emitted
    // `out-of-usage` rate_limit_family member (mapped to `rate_limit`
    // for the persisted DelayedRetryCause).
    const payload = await readRetryScheduledPayload(tmpRoot);
    expect(payload.cause).toBe('rate_limit');
  });

  // Bugfix 2026-05-15 — BUG-002 (T-FIX-B + T-FIX-E). The CLI's plain-mode
  // rate-limit message lands on stderr when it exits non-zero (the default
  // operator configuration). The pre-fix extractor scanned stdout only, so
  // the dynamic-countdown path was unreachable for the operator-facing
  // shape. This test wires the canonical fixture and asserts:
  //   1. `pendingRetryAt ≈ resetsAtMs + RETRY_BUFFER_MS` within tolerance.
  //   2. The `retry-scheduled` audit payload carries the parsed `resetsAtMs`.
  //   3. The runtime log sink (FR-017 / SC-009) captures a single DEBUG
  //      line BEFORE the audit event, carrying the rate-limit text,
  //      parsed epoch, computed backoff, and scheduledAt.
  it('BUG-002 (T-FIX-B): canonical plain-mode message on stderr → dynamic backoff fires + debug log surfaces parsed epoch', async () => {
    // Pin the system clock to a deterministic Asia/Saigon evening so the
    // fixture's "1:10am (Asia/Saigon)" always resolves to the NEXT day's
    // 1:10am — i.e., a clearly-future epoch. Without this pin, the test
    // is wall-clock sensitive: when local Saigon time falls between
    // 1:10am and ~1:10pm, the extractor's <12h-past rule keeps the
    // candidate at today's 1:10am (which is in the past), the dynamic
    // backoff hits `RETRY_FLOOR_MS`, and the strict ±2s tolerance fails
    // by hours. The 12:00 UTC pin (19:00 Saigon) sits comfortably inside
    // the >12h-past window so the +24h roll-forward is deterministic
    // across DST transitions too.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));

    try {
      const memento = new FakeMemento();
      const fixturePath = path.join(
        __dirname,
        '..',
        'fixtures',
        'rate-limit',
        'out-of-extra-usage-plain.txt'
      );
      const stderrText = (await fs.readFile(fixturePath, 'utf8')).trim();

      // The fixture contains `· resets 1:10am (Asia/Saigon)`. The extractor
      // resolves this to the next-occurrence epoch relative to `Date.now()`.
      // Compute the same epoch via a direct extractor call so the assertion
      // is invariant against DST / wall-clock drift.
      const expectedResetsAtMs = extractResetTimestamp('', stderrText, Date.now()).resetsAtMs;
      expect(expectedResetsAtMs).not.toBeNull();
      expect(typeof expectedResetsAtMs).toBe('number');

      const captured: string[] = [];
      const captureSink: LogSink = { appendLine: (line) => captured.push(line) };

      const cli = makeRateLimitedCliRunner('', stderrText);
      const harness = await makeHarness(memento, tmpRoot, cli, [captureSink]);
      const feature = await harness.queue.enqueue('feat-027-bug-002');
      await harness.controller.startNew(feature, null);

      const run = harness.store.getRun()!;
      expect(run.pendingRetryCause).toBe('rate_limit');

      // (1) pendingRetryAt = resetsAtMs + RETRY_BUFFER_MS, within tolerance.
      const expectedScheduledAt = (expectedResetsAtMs as number) + RETRY_BUFFER_MS;
      expect(Math.abs(run.pendingRetryAt! - expectedScheduledAt)).toBeLessThan(2_000);

      // (2) retry-scheduled audit payload carries the parsed pre-buffer epoch.
      const payload = await readRetryScheduledPayload(tmpRoot);
      expect(payload.resetsAtMs).toBe(expectedResetsAtMs);
      expect(payload.cause).toBe('rate_limit');
      expect(payload.scheduledAt - payload.resetsAtMs!).toBe(RETRY_BUFFER_MS);

      // (3) FR-017 / SC-009: a single DEBUG line carries the rate-limit text,
      // parsed epoch, backoffMs, and scheduledAt. Must precede the audit
      // event in time order — i.e., must appear in the captured sink BEFORE
      // the audit log was flushed.
      const debugLines = captured.filter((l) => l.includes('DEBUG'));
      const retryDebug = debugLines.find((l) =>
        l.includes('delayed-retry: scheduling backoff')
      );
      expect(retryDebug).toBeDefined();
      // The line carries the structured fields as a JSON tail.
      expect(retryDebug).toContain('"cause":"rate_limit"');
      expect(retryDebug).toContain(`"resetsAtMs":${expectedResetsAtMs}`);
      expect(retryDebug).toContain('"backoffMs":');
      expect(retryDebug).toContain('"scheduledAt":');
      // The rate-limit message text from the fixture is folded into the
      // structured context.
      expect(retryDebug).toContain('out of extra usage');
      // The line must be redacted at emit time via SECRET_PATTERNS; the
      // fixture has no secrets but the redaction pipeline is exercised.
      expect(retryDebug).not.toContain('sk-ant-');
    } finally {
      vi.useRealTimers();
    }
  });
});
