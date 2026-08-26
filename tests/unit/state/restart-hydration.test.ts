// US5 / FR-030: After a host process restart, the persisted state must
// rehydrate run, queue, lock, watchdog, and history coherently with shared
// correlation identifiers (`runId` is the canonical correlationId across
// surfaces). The audit-log read path is also tested via parser parity to
// confirm `correlationId` survives JSON round-trip.
//
// This test stops short of spinning up a full extension host (that lives in
// `tests/integration/*.host.test.ts`). It covers the cross-cutting
// persistence / parser hydration boundary for FR-030's correlation
// identifiers.

import { describe, it, expect, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  WorkspaceStateStore,
  KEYS,
  STATE_SCHEMA_VERSION,
  type Memento
} from '../../../src/state/workspace-state';
import { HistoryStore } from '../../../src/state/history-store';
import { buildHistoryEntry, withDescriptionRef } from '../../../src/state/history-entry';
import { SanitizedLogger } from '../../../src/lib/logger';
import { parseAuditLogLine } from '../../../src/parser/audit-log-parser';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

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
  /** Snapshot of the underlying map — simulates persistence to disk */
  snapshot(): Map<string, unknown> {
    return new Map(this.map);
  }
  /** Restore from snapshot — simulates a fresh process reading from disk */
  restoreFrom(other: Map<string, unknown>): void {
    this.map = new Map(other);
  }
}

const logger = new SanitizedLogger();
let pre: FakeMemento;

beforeEach(() => {
  pre = new FakeMemento();
});

describe('restart hydration coherence (US5 / T039 / FR-030)', () => {
  it('all four state keys (run, queue, lock, history) survive a fresh store init with shared runId', async () => {
    const store = new WorkspaceStateStore(pre);
    await store.initialize();

    const runId = 'run-correlation-1';
    const queue = new HistoryStore(store);

    // Seed pre-restart state — fixture carries Feature-011 invariants
    // (delayedRetryCount: 0, pendingRetryAt: null, pendingRetryCause: null)
    // so setRun's validator accepts the write.
    const startedAtMs = 1_700_000_000_000;
    await store.setRun(DEFAULT_QUEUE_ID, {
      id: runId,
      featureId: 'feat-1',
      featureDir: 'specs/001-feat-1',
      status: 'running',
      currentPhase: 'speckit-specify',
      currentIteration: 1,
      startedAt: startedAtMs,
      lastTransitionAt: startedAtMs,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    } as never,
      unfencedCommit('test-fixture')
    );
    await store.setQueue({
      requests: [
        {
          id: 'q-1',
          description: 'foo',
          addedAt: 1,
          updatedAt: 1,
          status: 'in-flight',
          runId,
          retryCount: 0,
          attempts: [],
          phaseHistory: []
        } as never
      ],
      inFlightId: 'q-1',
      paused: false,
      pausedReason: null,
      updatedAt: 1,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    });
    const acquiredAtMs = Date.now();
    await store.setLock({
      ownerId: 'win-A',
      acquiredAt: acquiredAtMs,
      heartbeatAt: acquiredAtMs
    });
    await queue.append(
      DEFAULT_QUEUE_ID,
      buildHistoryEntry({
        runId,
        featureId: 'feat-1',
        description: 'pre-restart description',
        terminalStatus: 'completed',
        startedAt: 1_700_000_000_000,
        completedAt: 1_700_000_001_000,
        logger
      }).entry
    );

    // Snapshot the disk-equivalent state
    const persisted = pre.snapshot();

    // Simulate process restart: new memento (same persisted bytes), new
    // store / history-store / queue, fresh init.
    const post = new FakeMemento();
    post.restoreFrom(persisted);
    const reborn = new WorkspaceStateStore(post);
    const initResult = await reborn.initialize();
    expect(initResult.migrated).toBe(false);

    // run, queue, lock, history all hydrated with shared runId
    const rehydratedRun = reborn.getRun(DEFAULT_QUEUE_ID);
    const rehydratedQueue = reborn.getQueue(DEFAULT_QUEUE_ID);
    const rehydratedLock = reborn.getLock();
    const rehydratedHistory = new HistoryStore(reborn).list();

    expect(rehydratedRun?.id).toBe(runId);
    expect(rehydratedQueue.requests[0]?.runId).toBe(runId);
    expect(rehydratedHistory[0]?.runId).toBe(runId);
    // FR-030: shared correlation identifier across run / queue / history.
    // The lock does not carry a runId in its persisted shape — its ownerId
    // is the primary-window identifier, separate from the run correlation.
    expect(new Set([
      rehydratedRun?.id,
      rehydratedQueue.requests[0]?.runId,
      rehydratedHistory[0]?.runId
    ]).size).toBe(1);
    // lock survives the round-trip with its ownerId intact
    expect(rehydratedLock?.ownerId).toBe('win-A');
  });

  it('the description reference survives the restart round-trip', async () => {
    // FR-029 asked that a rerun replay the original input byte-identically, and
    // that is unchanged. FR-R3-010 (T405) changed only where the text lives: it
    // is on disk beside the run's other evidence, which is restart-durable by
    // construction, and the memento keeps the reference that reaches it. So
    // what this round trip has to preserve is the reference and the length —
    // the retrieval itself is covered end-to-end in the pointer-resolution
    // integration test.
    const store = new WorkspaceStateStore(pre);
    await store.initialize();
    const fullDescription =
      'Long original description preserved across host restarts so rerun stays faithful.';
    const history = new HistoryStore(store);
    const built = buildHistoryEntry({
      runId: 'run-orig',
      featureId: 'feat-orig',
      description: fullDescription,
      terminalStatus: 'completed',
      startedAt: 0,
      completedAt: 100,
      logger
    });
    await history.append(
      DEFAULT_QUEUE_ID,
      withDescriptionRef(built.entry, '.schegent/history/run-orig.txt')
    );

    const persisted = pre.snapshot();
    const post = new FakeMemento();
    post.restoreFrom(persisted);
    const reborn = new WorkspaceStateStore(post);
    await reborn.initialize();
    const rehydrated = new HistoryStore(reborn).list();
    expect(rehydrated).toHaveLength(1);
    expect(rehydrated[0].descriptionRef).toBe('.schegent/history/run-orig.txt');
    expect(rehydrated[0].descriptionLength).toBe(fullDescription.length);
    expect(rehydrated[0].queueId).toBe(DEFAULT_QUEUE_ID);
  });

  it('audit log JSONL entries hydrate correlationId across the parser boundary', () => {
    // FR-030: the audit tail is the read-path counterpart to the in-memory
    // run/queue/lock/history surfaces. parseAuditLogLine() must preserve
    // correlationId so the live activity feed and grep-based reconstruction
    // share the identifier with the in-memory surfaces.
    const runId = 'run-correlation-2';
    const wireLine = JSON.stringify({
      id: 'audit-1',
      timestamp: '2026-05-10T00:00:00.000Z',
      runId,
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-start',
      payload: { startedAt: '2026-05-10T00:00:00.000Z' },
      outcome: 'info',
      correlationId: runId
    });
    const entry = parseAuditLogLine(wireLine);
    expect(entry).not.toBeNull();
    expect(entry?.runId).toBe(runId);
    expect(entry?.correlationId).toBe(runId);
  });

  it('rejects rehydration when persisted schemaVersion exceeds runtime', async () => {
    const store = new WorkspaceStateStore(pre);
    await store.initialize();
    // simulate an older runtime opening a workspace that was previously
    // touched by a newer Schegent build — must throw, not silently load.
    await pre.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION + 1);
    const reborn = new WorkspaceStateStore(pre);
    await expect(reborn.initialize()).rejects.toThrow(/exceeds runtime/);
  });
});
