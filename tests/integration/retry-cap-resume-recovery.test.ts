// Feature 030 BUG-001 T057 (SC-009) — integration test covering the full
// BUG-001 reproduction sequence end-to-end.
//
// Pre-fix sequence (deadlock):
//   1. retry-handler pauses via legacy `setPaused(true, 'retry-cap-exhausted:<runId>')`.
//      Legacy `QueueState.paused = true`; registry stays `'active'`.
//   2. AutoDrainCoordinator.drainIfIdle returns at the `queueState.paused` guard.
//      Newly enqueued tasks accumulate but never dispatch.
//   3. Webview snapshot projects `paused: true` → operator sees Resume Queue.
//   4. Operator clicks Resume → `setQueuePausedState(false, undefined, null)`
//      → registry check sees `'active'` → returns `{ ok: false, reason: 'not-paused' }`.
//   5. `logMutation` emits WARN. Legacy boolean is untouched. Queue stays stuck.
//
// Post-fix (this test):
//   - The retry-handler call site goes through `setQueuePausedState(true, ...,
//     'retry-cap')`. Both surfaces (registry + legacy boolean) update atomically.
//   - The operator Resume succeeds (registry is now `'manually-paused'`).
//   - The operator's Start now promotes the next pending task.
//   - No `WARN queue-manager.resume failed` line is emitted.
//
// The test exercises QueueManager, WorkspaceStateStore, and AutoDrainCoordinator
// directly. The retry-handler call path is simulated by invoking
// `setQueuePausedState` with the same arguments the retry-handler now passes
// (verified by `tests/unit/controller/retry-handler.test.ts`). This isolates
// the BUG-001 surface from the broader controller graph.
//
// THE LAST STEP USED TO BE SIMULATED TOO, AND THAT WAS THE PROBLEM (lifecycle
// round-check of 2026-08-30, T1612). It read:
//
//     const q = store.getQueue(DEFAULT_QUEUE_ID);
//     await store.setQueue({ ...q, queueLifecycle: 'active-empty' });
//     await coordinator.drainIfIdle();
//
// under a comment saying it was "simulating" `CMD_START_QUEUE`. Three things
// were wrong with it, and the third is why this test is named in that
// round-check's write-up:
//
//   1. No product path writes that. Operator Start-now goes through
//      `GuardedRunService.applyStartQueueIntent`, which writes `'running'`.
//   2. `active-empty` on a queue holding a pending task is not a state the
//      product can hold at all — `refreshUnheldLifecycle` derives `'running'`
//      whenever work remains. The test asserted a promotion out of a state that
//      cannot occur.
//   3. **A test that supplies the missing step itself cannot observe that the
//      step is missing.** The round-check's finding A was exactly a resurrection
//      path with no drain trigger, and this file's hand-mutation is the shape
//      that let it stay invisible to integration coverage.
//
// It now drives `runStartQueueCommand` with the `startIntent` the sidebar sends.
// Wiring a `GuardedRunService` to do it does not disturb what this file proves
// about BUG-001: the service is constructed for the final step only, and every
// pause/resume assertion above still runs against `QueueManager` directly.
import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { runStartQueueCommand } from '../../src/commands/start-queue';
import { SanitizedLogger, type LogSink } from '../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { AuditEntry } from '../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { WorkspaceLockManager } from '../../src/state/lock';

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

class CapturingSink implements LogSink {
  public readonly lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
}

const FAKE_RUN_ID = 'run-7fff';

describe('Feature 030 BUG-001 T057 (SC-009) — retry-cap-exhausted → operator-Resume recovery', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  let sink: CapturingSink;
  let logger: SanitizedLogger;
  let promotedTasks: string[];
  let coordinator: AutoDrainCoordinator;
  let auditEvents: AuditEntry[];
  let guardedRunService: GuardedRunService;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    sink = new CapturingSink();
    logger = new SanitizedLogger([sink]);
    queue = new QueueManager(store, logger);
    promotedTasks = [];
    // Stand in for the controller; record which feature gets promoted to
    // assert the auto-drain coordinator unblocks after Resume.
    // Feature 093 (T049a) — the drain awaits admission, not completion; the
    // double records the promotion and hands back an already-resolved drive.
    const fakeController = {
      admitNew: async (req: { id: string }) => {
        promotedTasks.push(req.id);
        return { completed: Promise.resolve() };
      },
      // Feature 093 (T082) — the execution-capacity gate reads the sessions the
      // window owns. Nothing here ever reaches a terminal transition, so every
      // promotion is still live and the count is the promotion count.
      get liveRunCount(): number {
        return promotedTasks.length;
      }
    };
    // Feature 092 (T051) — the drain's exclusion step is the per-queue
    // execution lease, not the workspace lock. Always granted here; this test
    // is about the pause/resume dual-write, not about contention.
    const fakeLease = {
      tryAcquire: async () => ({ acquired: true as const, ownerId: 'w-test' }),
      release: async () => undefined
    };
    coordinator = new AutoDrainCoordinator({
      store,
      queue,
      executionLease: fakeLease as never,
      controller: fakeController as never
    });

    // T1612 — the seam that owns operator Start-now. Only the final step of the
    // first test uses it; nothing above touches it, which is what keeps the
    // BUG-001 assertions unchanged.
    //
    // `lock` and `controller` are cast rather than built: `applyStartQueueIntent`
    // reaches neither on any branch — it writes through `store` and emits through
    // `audit` — and standing up a real lock manager here would add a filesystem
    // dependency to a test about a memento. The audit double is real, though,
    // because the transition this file now drives is an audited one and asserting
    // the event is how it proves it went through the seam rather than around it.
    auditEvents = [];
    guardedRunService = new GuardedRunService({
      isWorkspaceTrusted: () => true,
      lock: null as unknown as WorkspaceLockManager,
      queue,
      controller: null as unknown as SchegentWorkflowController,
      logger,
      audit: {
        append: async (entry: AuditEntry) => {
          auditEvents.push(entry);
        }
      } as unknown as AuditLogWriter,
      store
    });
  });

  it('atomic dual-write keeps both surfaces in agreement after a retry-cap-exhausted pause', async () => {
    // Seed one pending task on the unified queue.
    const pending = await queue.enqueue('next pending task');

    // Simulate the retry-handler call site (post-T054):
    //   await this.deps.queue.setQueuePausedState(
    //     true, undefined, `retry-cap-exhausted:${persisted.id}`, 'retry-cap'
    //   );
    const pauseResult = await queue.setQueuePausedState(
      true,
      undefined,
      `retry-cap-exhausted:${FAKE_RUN_ID}`,
      'retry-cap'
    );
    expect(pauseResult.ok).toBe(true);

    // FR-020/FR-023: both state surfaces must be in agreement.
    const legacyAfterPause = store.getQueue(DEFAULT_QUEUE_ID);
    const registryAfterPause = store.getProjectedQueueRegistry();
    const entryAfterPause = registryAfterPause.entries.find(
      (e) => e.id === DEFAULT_QUEUE_ID
    );
    expect(legacyAfterPause.queueLifecycle === 'operator-paused').toBe(true);
    expect(legacyAfterPause.pausedReason).toBe(`retry-cap-exhausted:${FAKE_RUN_ID}`);
    expect(entryAfterPause?.state).toBe('manually-paused');
    expect(entryAfterPause?.pauseSource).toBe('retry-cap');

    // While paused, a drain pass must short-circuit at the paused guard. The
    // pending task stays pending and is NOT promoted.
    await coordinator.drainIfIdle();
    expect(promotedTasks).toEqual([]);
    expect(queue.findById(pending.id)?.status).toBe('pending');

    // Operator dispatches CMD_RESUME_QUEUE → setQueuePausedState(false, ...)
    // post-fix should succeed because the registry is now manually-paused.
    const resumeResult = await queue.setQueuePausedState(
      false,
      undefined,
      null,
      'operator'
    );
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.queueId).toBe(DEFAULT_QUEUE_ID);

    // Both surfaces must clear in lockstep.
    const legacyAfterResume = store.getQueue(DEFAULT_QUEUE_ID);
    const registryAfterResume = store.getProjectedQueueRegistry();
    const entryAfterResume = registryAfterResume.entries.find(
      (e) => e.id === DEFAULT_QUEUE_ID
    );
    expect(legacyAfterResume.queueLifecycle === 'operator-paused').toBe(false);
    expect(legacyAfterResume.pausedReason).toBeNull();
    expect(entryAfterResume?.state).toBe('active');
    expect(entryAfterResume?.pauseSource).toBeNull();

    // Feature 065 (T010 / FR-003): after Resume, the queue lands in
    // `idle-pending` because there is pending work but no in-flight task.
    // The auto-drain coordinator MUST NOT auto-promote in `idle-pending`
    // (only the scheduler or an explicit operator CMD_START_QUEUE owns
    // that transition). Verify the gate fires.
    await coordinator.drainIfIdle();
    expect(promotedTasks).toEqual([]);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('idle-pending');
    // Now the operator presses Start now. This is the real command, with the
    // `startIntent` the sidebar sends and the production handler deciding both
    // the lifecycle transition and whether to drain after it. Nothing here
    // supplies the step under test.
    await runStartQueueCommand(
      {
        queueId: DEFAULT_QUEUE_ID,
        startIntent: { startMode: 'now', source: 'operator-restart' }
      },
      {
        guardedRunService,
        // The production `drainQueuedWork` is a one-line delegation to
        // `drainIfIdle` (`workflow-controller.ts`), and the coordinator below is
        // the real one — so the drain that runs is the product's, reached
        // through the product's decision about whether to run it.
        controller: { drainQueuedWork: (id?: string) => coordinator.drainIfIdle(id) },
        logger
      }
    );
    expect(promotedTasks).toEqual([pending.id]);

    // The transition went through the audited seam, not around it. This is the
    // assertion the hand-mutation could not make: a bare `setQueue` leaves the
    // queue in the right state and no record that an operator decided it.
    expect(
      auditEvents.map((e) => e.eventType),
      'operator Start-now out of idle-pending must emit `idle-pending-exited`'
    ).toContain('idle-pending-exited');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');
    // The promotion is attributable to the command and not to the coordinator
    // being run again: the `drainIfIdle` twenty lines above, on the same queue
    // in the state the operator left it, promoted nothing. That pair is the
    // control — one drain over `idle-pending` promotes nothing, and the same
    // drain reached through Start-now promotes.

    // No `WARN queue-manager.resume failed` line should appear in the
    // syslog for this scenario — FR-022 downgrades idempotent rejections
    // to DEBUG (with noop: true) and the canonical Resume here is `ok`.
    const failedResumeLines = sink.lines.filter(
      (l) => l.includes('queue-manager.resume failed')
    );
    expect(
      failedResumeLines,
      `Unexpected WARN lines:\n${failedResumeLines.join('\n')}`
    ).toEqual([]);
  });

  it('idempotent operator-Resume on an already-resumed queue is a DEBUG noop, not a WARN', async () => {
    // FR-022 — race-condition double-click on Resume must not pollute
    // the operator log with WARN false-failure alarms.
    const firstResume = await queue.setQueuePausedState(false, undefined, null, 'operator');
    // The first call is a noop because the queue was never paused.
    expect(firstResume.ok).toBe(false);
    expect(firstResume.reason).toBe('not-paused');

    const warnLines = sink.lines.filter((l) => l.includes('queue-manager.resume failed'));
    expect(warnLines).toEqual([]);

    // A DEBUG line tagged `noop: true` is the expected severity for an
    // idempotent rejection.
    const debugLines = sink.lines.filter((l) => l.includes('queue-manager.resume noop'));
    expect(debugLines.length).toBeGreaterThan(0);
    expect(debugLines.some((l) => l.includes('"noop":true'))).toBe(true);
  });

  it('resolved canonical queueId is emitted in the structured payload (FR-023)', async () => {
    // The retry-handler omits `queueId` (it always targets `'default'`).
    // FR-023 mandates that `logMutation` resolves the caller-supplied
    // `null`/`undefined` to the canonical id before emitting structured
    // fields. The INFO line for a successful pause must contain
    // `"queueId":"default"` even though the caller passed `undefined`.
    const pauseResult = await queue.setQueuePausedState(
      true,
      undefined,
      `retry-cap-exhausted:${FAKE_RUN_ID}`,
      'retry-cap'
    );
    expect(pauseResult.ok).toBe(true);

    const pauseInfoLines = sink.lines.filter(
      (l) => l.includes('INFO') && l.includes('queue-manager.pause')
    );
    expect(pauseInfoLines.length).toBeGreaterThan(0);
    expect(pauseInfoLines.some((l) => l.includes(`"queueId":"${DEFAULT_QUEUE_ID}"`))).toBe(
      true
    );
  });
});
