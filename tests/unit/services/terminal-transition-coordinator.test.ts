import { describe, expect, it, vi } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { TerminalTransitionCoordinator } from '../../../src/services/terminal-transition-coordinator';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { TerminalTransitionIntent, WorkflowRun } from '../../../src/state/workflow-run';

function terminalRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1', featureId: 'task-1', featureDir: '', status: 'completed',
    currentPhase: 'done', currentIteration: 1, startedAt: 1, lastTransitionAt: 2,
    phasesCompleted: [], lastError: null, delayedRetryCount: 0,
    pendingRetryAt: null, pendingRetryCause: null, phaseOverrides: [],
    manualPauseAt: null, manualPauseCause: null, phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

/**
 * Feature 093 (T039) — the coordinator resolves the Run it is finishing by that
 * Run's own Task rather than reading the one ambient slot, so the double answers
 * `findRunByTask` the way the real store does: the Run whose `featureId` is
 * asked for, together with the queue it executes on.
 */
function storeRunLookup(...runs: ReadonlyArray<{ run: WorkflowRun; queueId: string }>) {
  return (featureId: string): { queueId: string; run: WorkflowRun } | null =>
    runs.find((entry) => entry.run.featureId === featureId) ?? null;
}

/**
 * Feature 093 (T048) — the journal is a record keyed by run id, so the double
 * models a record and not a slot. `setTerminalTransitionIntent(runId, null)`
 * removes one entry and leaves the rest, which is the whole point of the key.
 */
function journalDouble(initial: Record<string, TerminalTransitionIntent> = {}) {
  const entries: Record<string, TerminalTransitionIntent> = { ...initial };
  return {
    entries,
    getTerminalTransitionIntents: () => entries as never,
    setTerminalTransitionIntent: vi.fn(
      async (runId: string, intent: TerminalTransitionIntent | null) => {
        if (intent === null) delete entries[runId];
        else entries[runId] = intent;
      }
    )
  };
}

describe('TerminalTransitionCoordinator', () => {
  it('persists intent before run and clears only after queue/history', async () => {
    const order: string[] = [];
    const journal = journalDouble();
    const store = {
      getTerminalTransitionIntents: journal.getTerminalTransitionIntents,
      setTerminalTransitionIntent: vi.fn(async (runId: string, intent: unknown) => {
        order.push(intent ? 'intent' : 'clear');
        await journal.setTerminalTransitionIntent(runId, intent as never);
      }),
      findRunByTask: storeRunLookup({ run: terminalRun(), queueId: DEFAULT_QUEUE_ID }),
      setRun: vi.fn(async () => { order.push('run'); }),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => { order.push('queue'); }) };
    const history = { record: vi.fn(async () => { order.push('history'); return { outcome: 'recorded' as const }; }) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );
    await coordinator.complete(terminalRun(), 'description');
    expect(order).toEqual(['intent', 'run', 'queue', 'history', 'clear']);
  });

  it('replays a persisted intent', async () => {
    const run = terminalRun();
    const journal = journalDouble({ [run.id]: { schemaVersion: 1, run, createdAt: 1 } });
    const store = {
      ...journal,
      findRunByTask: storeRunLookup({ run, queueId: DEFAULT_QUEUE_ID }),
      setRun: vi.fn(async () => undefined),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => undefined) };
    const history = { record: vi.fn(async () => ({ outcome: 'recorded' as const })) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );
    await coordinator.replay();
    expect(queue.finish).toHaveBeenCalledWith('task-1', 'completed');
    expect(journal.entries).toEqual({});
  });
});

/**
 * Feature 093 (T048) — two Runs reaching a terminal status at once.
 *
 * Every assertion here fails against the pre-feature single ambient intent: the
 * second `begin()` overwrote the first's entry, and the first `complete()`
 * cleared the record for both, so a crash before the second Run's queue and
 * history projection had nothing left to replay.
 */
describe('TerminalTransitionCoordinator concurrent transitions (Feature 093 T048)', () => {
  const runA = terminalRun({ id: 'run-a', featureId: 'task-a' });
  const runB = terminalRun({ id: 'run-b', featureId: 'task-b', status: 'failed' });

  function coordinatorOver(journal: ReturnType<typeof journalDouble>) {
    const store = {
      ...journal,
      findRunByTask: storeRunLookup(
        { run: runA, queueId: 'queue-a' },
        { run: runB, queueId: 'queue-b' }
      ),
      setRun: vi.fn(async () => undefined),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => undefined) };
    const history = { record: vi.fn(async () => ({ outcome: 'recorded' as const })) };
    return {
      store,
      queue,
      history,
      coordinator: new TerminalTransitionCoordinator(
        store as never, queue as never, history as never, new SanitizedLogger()
      )
    };
  }

  it('journals both transitions instead of the second overwriting the first', async () => {
    const journal = journalDouble();
    const { coordinator } = coordinatorOver(journal);

    await coordinator.begin(runA);
    await coordinator.begin(runB);

    expect(Object.keys(journal.entries).sort()).toEqual(['run-a', 'run-b']);
    expect(journal.entries['run-a'].run.status).toBe('completed');
    expect(journal.entries['run-b'].run.status).toBe('failed');
  });

  it('clearing one completed transition leaves the sibling journalled', async () => {
    const journal = journalDouble();
    const { coordinator } = coordinatorOver(journal);

    await coordinator.begin(runB);
    await coordinator.complete(runA, 'a');

    expect(Object.keys(journal.entries)).toEqual(['run-b']);
  });

  it('replays every pending transition, each writing to its own queue', async () => {
    const journal = journalDouble({
      'run-a': { schemaVersion: 1, run: runA, createdAt: 1 },
      'run-b': { schemaVersion: 1, run: runB, createdAt: 2 }
    });
    const { coordinator, store, queue } = coordinatorOver(journal);

    await coordinator.replay();

    expect(queue.finish).toHaveBeenCalledWith('task-a', 'completed');
    expect(queue.finish).toHaveBeenCalledWith('task-b', 'failed');
    // FR-R3-077 — the commit point now carries a claim; these doubles hold no
    // lease, so it is the recorded unfenced form rather than a fence.
    expect(store.setRun).toHaveBeenCalledWith('queue-a', runA, unfencedCommit('test-fixture'));
    expect(store.setRun).toHaveBeenCalledWith('queue-b', runB, unfencedCommit('test-fixture'));
    expect(journal.entries).toEqual({});
  });

  it('a transition whose projection keeps failing does not strand the next one', async () => {
    const journal = journalDouble({
      'run-a': { schemaVersion: 1, run: runA, createdAt: 1 },
      'run-b': { schemaVersion: 1, run: runB, createdAt: 2 }
    });
    const store = {
      ...journal,
      findRunByTask: storeRunLookup(
        { run: runA, queueId: 'queue-a' },
        { run: runB, queueId: 'queue-b' }
      ),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture')),
      setRun: vi.fn(async (_queueId: string, run: WorkflowRun) => {
        if (run.id === 'run-a') throw new Error('record write failed');
      })
    };
    const queue = { finish: vi.fn(async () => undefined) };
    const history = { record: vi.fn(async () => ({ outcome: 'recorded' as const })) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );

    await coordinator.replay();

    // A's projection threw before its queue/history write, so its entry stays
    // for the next activation; B's completed and cleared regardless.
    expect(Object.keys(journal.entries)).toEqual(['run-a']);
    expect(queue.finish).toHaveBeenCalledWith('task-b', 'failed');
  });
});

/**
 * Feature 093 (T048) — a workspace upgraded mid-transition.
 *
 * The store lifts a legacy single intent under its own run id rather than
 * dropping it, because the value is the record of a terminal transition that has
 * not finished projecting: discarding it on the upgrade read would strand
 * exactly the crash the journal exists for.
 */
describe('TerminalTransitionCoordinator legacy journal (Feature 093 T048)', () => {
  it('replays a legacy single intent lifted by the store', async () => {
    const run = terminalRun();
    // The store's tolerant read is what performs the lift; the coordinator sees
    // a record either way, which is exactly the contract under test.
    const journal = journalDouble({ [run.id]: { schemaVersion: 1, run, createdAt: 7 } });
    const store = {
      ...journal,
      findRunByTask: storeRunLookup({ run, queueId: DEFAULT_QUEUE_ID }),
      setRun: vi.fn(async () => undefined),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => undefined) };
    const history = { record: vi.fn(async () => ({ outcome: 'recorded' as const })) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );

    await coordinator.replay();

    expect(queue.finish).toHaveBeenCalledWith('task-1', 'completed');
    expect(journal.entries).toEqual({});
  });
});
