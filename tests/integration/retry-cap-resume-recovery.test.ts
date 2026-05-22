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
//   - The AutoDrainCoordinator promotes the next pending task on the next pump tick.
//   - No `WARN queue-manager.resume failed` line is emitted.
//
// The test exercises QueueManager, WorkspaceStateStore, and AutoDrainCoordinator
// directly. The retry-handler call path is simulated by invoking
// `setQueuePausedState` with the same arguments the retry-handler now passes
// (verified by `tests/unit/controller/retry-handler.test.ts`). This isolates
// the BUG-001 surface from the broader controller graph.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { SanitizedLogger, type LogSink } from '../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

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

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    sink = new CapturingSink();
    logger = new SanitizedLogger([sink]);
    queue = new QueueManager(store, logger);
    promotedTasks = [];
    // Stand in for the controller; record which feature gets promoted to
    // assert the auto-drain coordinator unblocks after Resume.
    const fakeController = {
      startNew: async (req: { id: string }) => {
        promotedTasks.push(req.id);
      }
    };
    const fakeLock = {
      tryAcquire: async () => ({ acquired: true as const, ownerId: 'w-test' })
    };
    coordinator = new AutoDrainCoordinator({
      store,
      queue,
      lock: fakeLock as never,
      controller: fakeController as never
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
    const legacyAfterPause = store.getQueue();
    const registryAfterPause = store.getQueueRegistry();
    const entryAfterPause = registryAfterPause.entries.find(
      (e) => e.id === DEFAULT_QUEUE_ID
    );
    expect(legacyAfterPause.paused).toBe(true);
    expect(legacyAfterPause.pausedReason).toBe(`retry-cap-exhausted:${FAKE_RUN_ID}`);
    expect(entryAfterPause?.state).toBe('manually-paused');
    expect(entryAfterPause?.pauseSource).toBe('retry-cap');

    // While paused, the auto-drain pump must short-circuit at the paused
    // guard. The pending task stays pending and is NOT promoted.
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
    const legacyAfterResume = store.getQueue();
    const registryAfterResume = store.getQueueRegistry();
    const entryAfterResume = registryAfterResume.entries.find(
      (e) => e.id === DEFAULT_QUEUE_ID
    );
    expect(legacyAfterResume.paused).toBe(false);
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
    expect(store.getQueue().queueLifecycle).toBe('idle-pending');
    // Now the operator presses Start now (CMD_START_QUEUE without
    // startIntent) — the legacy drain path is the one in this test
    // (no GuardedRunService wired). Simulating via direct lifecycle
    // mutation followed by drainIfIdle.
    const q = store.getQueue();
    await store.setQueue({ ...q, queueLifecycle: 'active-empty' });
    await coordinator.drainIfIdle();
    expect(promotedTasks).toEqual([pending.id]);

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
