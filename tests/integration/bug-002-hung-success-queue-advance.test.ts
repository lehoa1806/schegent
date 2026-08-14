// Feature 030 BUG-002 — end-to-end: a task whose CLI completes successfully but
// hangs (so the runner reports `timedOut`) is classified `clean` by PhaseRunner
// (FR-025). In production RunDriver maps a `clean` outcome to a `completed` run
// and the AutoDrainCoordinator promotes the next pending task. This test pins
// the two halves of that path: (1) the hung-but-complete invocation classifies
// `clean`, and (2) on a `completed` finish the unified queue promotes the next
// task (FR-002 / SC-011) instead of stalling on a false `phase timed out`.

import { describe, it, expect, vi } from 'vitest';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../src/lib/logger';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import {
  WorkspaceLockManager,
  systemClock,
  type Scheduler
} from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type {
  RawInvocationOutput,
  InvocationRequest
} from '../../src/runner/invocation-result';
import type { AuditEntry } from '../../src/audit/audit-entry';
import { ZippedStreamBuffer } from "../../src/runner/zipped-stream-buffer";

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

const CLEAN_STDOUT = [
  '[SCHEGENT_STATUS: DONE]',
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-implement',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'network_calls: []',
  'ruleset_switches: []',
  'notes: work finished but the process lingered',
  '=== END AUDIT LOG ==='
].join('\n');

function makeFakeRunner(
  invokeImpl: (req: InvocationRequest) => Promise<RawInvocationOutput>
): ClaudeCliRunner {
  return {
    invoke: vi.fn(invokeImpl),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

// The lock's heartbeat interval is irrelevant to what T074 asserts and would
// outlive the test if it were real.
const noopScheduler: Scheduler = {
  setInterval: () => ({ clear: () => undefined })
};

function makeFakeAuditWriter(): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(
      async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
        id: `audit-${++counter}`,
        timestamp: '2026-06-07T00:00:00Z',
        ...entry
      })
    ),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

describe('Feature 030 BUG-002 — hung-but-successful task does not stall the queue', () => {
  it('classifies a hung (timed-out) but complete invocation as clean and promotes the next task', async () => {
    // 1. The runner reports a timeout (the process hung after emitting a
    //    complete result). PhaseRunner MUST still classify it `clean`.
    const cliRunner = makeFakeRunner(async () => ({
      exitCode: null, // killed by the idle-timeout watchdog
      killed: false,
      timedOut: true,
      durationMs: 64 * 60_000,
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(CLEAN_STDOUT); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(''); b.finalize(); return b; })()
    }));
    const phaseRunner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      makeFakeAuditWriter(),
      new SanitizedLogger()
    );
    const out = await phaseRunner.run({
      phase: 'speckit-implement',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'spec-kit-auto run',
      featureDir: 'specs/030-single-task-queue',
      cliPath: 'claude',
      cwd: '/repo',
      timeoutMs: 5_000,
      runId: 'run-1'
    });
    expect(out.outcome).toBe('clean'); // NOT 'timeout' — the work succeeded

    // 2. Queue: with a `clean` outcome, RunDriver finishes the run `completed`
    //    and auto-drain promotes the next task. Pin the FR-002 invariant the
    //    false timeout previously violated.
    const store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    const queue = new QueueManager(store);
    const t1 = await queue.enqueue('hung-but-complete task');
    const t2 = await queue.enqueue('next task');
    await queue.markInFlight(t1.id, 'run-1');
    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);

    await queue.finish(t1.id, 'completed'); // driven by outcome 'clean'
    expect(queue.findById(t1.id)?.status).toBe('completed');
    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(true);

    // The queue switches to the next task instead of stalling.
    expect(queue.peekNextPending()?.id).toBe(t2.id);
    await queue.markInFlight(t2.id, 'run-2');
    expect(queue.findById(t2.id)?.status).toBe('in-flight');
    expect(queue.findById(t2.id)?.queueId).toBe(DEFAULT_QUEUE_ID);
  });

  it('releases the drive-run lock so the promoted task can actually run', async () => {
    // T074 — the third limb of SC-011, carried forward from T064 clause (c).
    // The two assertions above prove the next task was *promoted*; this one
    // proves it can *run*. They are not the same claim: a regression that
    // finishes the hung run while still holding `drive-run` leaves a queue
    // that looks correct in the snapshot and cannot drain, and every
    // assertion above would still pass. Both defects present as "the queue
    // stopped", which is why this limb has to be asserted separately.
    const store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    const queue = new QueueManager(store);
    const t1 = await queue.enqueue('hung-but-complete task');
    const t2 = await queue.enqueue('next task');
    await queue.markInFlight(t1.id, 'run-1');

    // Model the drive scope exactly as `RunDriver.drive()` does: the whole
    // finish-and-promote sequence runs inside `withLock('drive-run', ...)`,
    // and the body never calls `session.retain()` because a `clean` outcome
    // is a terminal completion, not a pause.
    const driver = new WorkspaceLockManager(store, 'driver', systemClock, noopScheduler);
    await driver.withLock('drive-run', async () => {
      await queue.finish(t1.id, 'completed'); // driven by outcome 'clean'
      expect(queue.peekNextPending()?.id).toBe(t2.id);
      // The lock is genuinely held for the duration — otherwise the release
      // assertion below would pass against an implementation that never
      // acquired it at all.
      expect(driver.isHeld()).toBe(true);
    });

    expect(driver.isHeld()).toBe(false);
    expect(store.getLock()).toBeNull();

    // The decisive check: a *different* owner can take `drive-run` now. A
    // retained or leaked lock is not stale yet (STALENESS_THRESHOLD_MS has
    // not elapsed), so this acquire would be refused rather than salvaged.
    const nextDrain = new WorkspaceLockManager(store, 'next-drain', systemClock, noopScheduler);
    const probe = await nextDrain.tryAcquire();
    expect(probe.acquired).toBe(true);
    expect(probe.ownerId).toBe('next-drain');
    await nextDrain.release();
  });
});
