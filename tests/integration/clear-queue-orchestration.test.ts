// FR-R3-150 (T1620a) — `runClearQueue` orchestration, proven against two
// really-executing Runs rather than a mocked controller. Mirrors
// `queue-addressed-controls.test.ts`'s shape (Feature 093 US4): with one Run,
// every question about addressing has the same answer, so every case here
// constructs Queue A AND Queue B and asserts the bystander explicitly.
//
// Two scenarios:
//   1. The runner acks within the bound — Queue A's parked invocation is
//      released so its driver actually stops — and Queue A's reset completes
//      with no warning, while Queue B keeps executing throughout and the
//      window stays primary (no Run- or queue-scoped path releases it, D5).
//   2. The runner does NOT ack within the bound — Queue A's invocation is
//      never released, so `waitForQueueRunnerStop`'s real 2s window elapses —
//      and Queue A's persisted reset still completes in full (FR-015), a
//      bounded warning names Queue A, and Queue B is untouched throughout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  QUEUE_A,
  QUEUE_B,
  drainUntil,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type AdmittedRun,
  type Harness
} from './concurrent-run-harness';
import { runClearQueue, type ClearQueueCtx } from '../../src/commands/clear-queue';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { Notifier } from '../../src/ui/notifications';

let tmpRoot: string;
let h: Harness;
let audit: AuditLogWriter;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-clear-queue-orch-'));
  await initGitRepo(tmpRoot);
  h = await makeHarness(tmpRoot, { concurrencyCap: 5, queues: [QUEUE_B] });
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, h.logger);
  // The orchestrator's own precondition — read, never released (D5,
  // AGENTS.md hard rule) — so every case needs primacy before it starts.
  const claim = await h.lock.tryAcquire();
  expect(claim.acquired).toBe(true);
});

afterEach(async () => {
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  await removeWorkspace(tmpRoot);
});

const notifier = (): Notifier & { warn: ReturnType<typeof vi.fn> } =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Notifier & {
    warn: ReturnType<typeof vi.fn>;
  };

function ctxFor(notify: Notifier): ClearQueueCtx {
  return {
    controller: h.controller,
    queue: h.queue,
    executionLease: h.lease,
    audit,
    lock: h.lock,
    notifier: notify,
    logger: h.logger
  };
}

async function readAuditSuffix(): Promise<readonly Record<string, unknown>[]> {
  const raw = await fs.readFile(audit.logPath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Both queues admitted and both parked in their first phase. */
async function bothExecuting(): Promise<{ a: AdmittedRun; b: AdmittedRun }> {
  const a = await h.admit(QUEUE_A, 'work on queue A');
  const b = await h.admit(QUEUE_B, 'work on queue B');
  await h.atGate(a.runId);
  await h.atGate(b.runId);
  expect(h.store.getRun(QUEUE_A)!.status).toBe('running');
  expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
  return { a, b };
}

/**
 * Release every invocation `runId` parks, for as long as `until` is
 * unsettled. `runClearQueue`'s own `cancelActive(queueId)` call happens deep
 * inside its call to `QueueManager.clearQueue` (after the persisted write),
 * not synchronously at this test's call site — so there is no single moment
 * to call `h.step` at that is guaranteed to land after the abort flag is set
 * and before the driver's next resume. Pumping the gate until `until`
 * settles converges regardless of exactly when that happens: the driver
 * keeps being let through, and the first resume after the flag is set is the
 * one that actually stops it.
 */
async function pumpGateUntilSettled(runId: string, until: Promise<unknown>): Promise<void> {
  let settled = false;
  void until.finally(() => {
    settled = true;
  });
  const isSettled = (): boolean => settled;
  while (!isSettled()) {
    if (h.parkedFor(runId) > 0) h.step(runId);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('FR-R3-150 (T1620a) — runClearQueue orchestration, two live Runs', () => {
  it('acked in time: Queue A resets fully, Queue B keeps executing, window stays primary', async () => {
    const { a, b } = await bothExecuting();
    const bInvocationsBefore = h.invocations.filter((e) => e.runId === b.runId).length;
    const notify = notifier();

    const clearing = runClearQueue(ctxFor(notify), QUEUE_A);
    // The probe's `cancelActive(QUEUE_A)` flags the driver; pumping its gate
    // is what lets it actually observe the cancellation and stop, so
    // `isDriving(QUEUE_A)` flips false well inside the 2s window.
    const [outcome] = await Promise.all([clearing, pumpGateUntilSettled(a.runId, clearing)]);

    expect(outcome).toEqual({ ok: true });
    expect(notify.warn).not.toHaveBeenCalled();

    // Queue A: fully reset — no tasks, no run, idle.
    expect(h.queue.list(QUEUE_A)).toEqual([]);
    expect(h.store.getRun(QUEUE_A)).toBeNull();

    // Queue B: untouched and still able to advance, throughout.
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
    h.step(b.runId);
    await drainUntil(
      () => h.invocations.filter((e) => e.runId === b.runId).length > bInvocationsBefore,
      () => 'queue B to dispatch its next phase after A was cleared'
    );
    expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
    expect(h.queue.findById(b.feature.id)!.status).toBe('in-flight');

    // The workspace-wide lock is a precondition here, never released by this
    // path (D5) — a rival window still finds this one primary afterwards.
    expect(await h.lock.hasPrimacy()).toBe(true);

    // Exactly one queue-cleared event, naming Queue A and no other queue.
    const entries = await readAuditSuffix();
    const cleared = entries.filter((e) => e.eventType === 'queue-cleared');
    expect(cleared).toHaveLength(1);
    expect((cleared[0]!.payload as Record<string, unknown>).queueId).toBe(QUEUE_A);
    expect((cleared[0]!.payload as Record<string, unknown>).runnerState).toBe('acked');
  });

  it(
    'not acked in time: Queue A still resets fully with a bounded warning; Queue B is untouched throughout',
    async () => {
      const { a, b } = await bothExecuting();
      const notify = notifier();

      // Queue A's invocation is deliberately never released here — the driver
      // stays parked and `isDriving(QUEUE_A)` reads true for the whole 2s
      // window, so the probe genuinely times out rather than being told to.
      const outcome = await runClearQueue(ctxFor(notify), QUEUE_A);

      expect(outcome).toEqual({ ok: true });
      // FR-015 — the reset completed in full despite the timeout; the
      // warning names the queue rather than describing a rollback.
      expect(notify.warn).toHaveBeenCalledTimes(1);
      expect(notify.warn.mock.calls[0]![0]).toContain(QUEUE_A);

      expect(h.queue.list(QUEUE_A)).toEqual([]);
      expect(h.store.getRun(QUEUE_A)).toBeNull();

      // Queue B never moved: no invocation, no status change, while A's probe
      // was still polling.
      expect(h.store.getRun(QUEUE_B)!.status).toBe('running');
      expect(h.invocations.filter((e) => e.runId === b.runId)).toHaveLength(1);

      const entries = await readAuditSuffix();
      const cleared = entries.filter((e) => e.eventType === 'queue-cleared');
      expect(cleared).toHaveLength(1);
      expect((cleared[0]!.payload as Record<string, unknown>).queueId).toBe(QUEUE_A);
      expect((cleared[0]!.payload as Record<string, unknown>).runnerState).toBe('timed-out');

      // Cleanup: release A's still-parked invocation so `afterEach`'s
      // `quiesce()` can bring the window to rest without a real timeout.
      h.step(a.runId);
    },
    6_000
  );
});
