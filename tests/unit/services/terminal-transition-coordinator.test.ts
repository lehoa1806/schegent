import { describe, expect, it, vi } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { TerminalTransitionCoordinator } from '../../../src/services/terminal-transition-coordinator';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { TerminalTransitionIntent, WorkflowRun } from '../../../src/state/workflow-run';
import { decideTaskTransition } from '../../../src/queue/task-transition-decision';
import type { FeatureRequestStatus, TerminalRequestStatus } from '../../../src/queue/feature-request';

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

// FR-R3-196 (T1873) — the in-flight row `complete` now reads, for the Run `storeRunLookup` names.
function storeRequestLookup(...runs: ReadonlyArray<{ run: WorkflowRun; queueId: string }>) {
  return (
    taskId: string
  ): { id: string; status: 'in-flight'; runId: string; updatedAt: number } | null => {
    const entry = runs.find((candidate) => candidate.run.featureId === taskId);
    return entry === undefined
      ? null
      : { id: taskId, status: 'in-flight', runId: entry.run.id, updatedAt: 0 };
  };
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
      getRequest: storeRequestLookup({ run: terminalRun(), queueId: DEFAULT_QUEUE_ID }),
      getHistory: () => [],
      setRun: vi.fn(async () => { order.push('run'); }),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => { order.push('queue'); return { ok: true }; }) };
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
      getRequest: storeRequestLookup({ run, queueId: DEFAULT_QUEUE_ID }),
      getHistory: () => [],
      setRun: vi.fn(async () => undefined),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => ({ ok: true })) };
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
      getRequest: storeRequestLookup(
        { run: runA, queueId: 'queue-a' },
        { run: runB, queueId: 'queue-b' }
      ),
      getHistory: () => [],
      setRun: vi.fn(async () => undefined),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => ({ ok: true })) };
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
      getRequest: storeRequestLookup(
        { run: runA, queueId: 'queue-a' },
        { run: runB, queueId: 'queue-b' }
      ),
      getHistory: () => [],
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture')),
      setRun: vi.fn(async (_queueId: string, run: WorkflowRun) => {
        if (run.id === 'run-a') throw new Error('record write failed');
      })
    };
    const queue = { finish: vi.fn(async () => ({ ok: true })) };
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
      getRequest: storeRequestLookup({ run, queueId: DEFAULT_QUEUE_ID }),
      getHistory: () => [],
      setRun: vi.fn(async () => undefined),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    const queue = { finish: vi.fn(async () => ({ ok: true })) };
    const history = { record: vi.fn(async () => ({ outcome: 'recorded' as const })) };
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, new SanitizedLogger()
    );

    await coordinator.replay();

    expect(queue.finish).toHaveBeenCalledWith('task-1', 'completed');
    expect(journal.entries).toEqual({});
  });
});

describe('TerminalTransitionCoordinator FR-R3-196 (T1873)', () => {
  const RUN_ID = 'run-0001-tail';
  const RUN_ID_PREFIX = 'run-0001';
  const DESCRIPTION = 'description';
  const INTENT_CREATED_AT = 100;
  const ROW_UNTOUCHED_AT = 50;
  const ROW_UPDATED_AFTER_AT = 150;
  const FINISH_STAMP = 200;
  const LATER_PHASE_ADVANCE = 1000;
  const FAILED_RECORD = { outcome: 'failed', code: 'probe-code' } as const;
  const CLEARED_LINE = `terminal-transition: intent for run ${RUN_ID_PREFIX} cleared: task row gone`;
  const droppedLine = (reason: string): string =>
    `terminal-transition: intent for run ${RUN_ID_PREFIX} dropped: ${reason}`;
  const HISTORY_FAILED_WARNING =
    'terminal-transition: replay remains pending: history record failed (probe-code)';

  type EndedStatus = 'completed' | 'failed' | 'canceled';
  type RecordResult =
    | { readonly outcome: 'recorded' }
    | { readonly outcome: 'failed'; readonly code: string };
  interface HistoryKey {
    runId: string;
    terminalStatus: string;
  }
  interface RequestRow {
    id: string;
    status: FeatureRequestStatus;
    runId: string | null;
    updatedAt: number;
  }

  function requestRow(overrides: Partial<RequestRow> = {}): RequestRow {
    return {
      id: 'task-1',
      status: 'in-flight',
      runId: RUN_ID,
      updatedAt: ROW_UNTOUCHED_AT,
      ...overrides
    };
  }

  function endedRun(status: EndedStatus): WorkflowRun {
    return terminalRun({ id: RUN_ID, status });
  }

  function liveRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return terminalRun({ id: RUN_ID, status: 'running', ...overrides });
  }

  function intentsOf(run: WorkflowRun): Record<string, TerminalTransitionIntent> {
    return {
      [run.id]: { schemaVersion: 1, run, createdAt: INTENT_CREATED_AT, description: DESCRIPTION }
    };
  }

  function worldOver(options: {
    readonly intents?: Record<string, TerminalTransitionIntent>;
    readonly row: RequestRow | null;
    readonly historyEntries?: HistoryKey[];
    readonly activeRun: WorkflowRun | null;
    readonly recordResult?: RecordResult;
  }) {
    const { row, activeRun } = options;
    const historyEntries = options.historyEntries ?? [];
    const lines: string[] = [];
    const calls: string[] = [];
    const journal = journalDouble(options.intents);
    const store = {
      ...journal,
      getRequest: () => row,
      getHistory: () => historyEntries,
      findRunByTask:
        activeRun === null
          ? () => null
          : storeRunLookup({ run: activeRun, queueId: DEFAULT_QUEUE_ID }),
      setRun: vi.fn(async () => {
        calls.push('run');
      }),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    };
    // Answers as the real `finish` does: a missing row, or a transition the closed table refuses,
    // is `{ ok: false }`. A double that always said ok would hide the defect under test.
    const queue = {
      finish: vi.fn(async (_taskId: string, targetStatus: TerminalRequestStatus) => {
        calls.push('queue');
        if (row === null) return { ok: false, reason: 'task-not-found' };
        const decision = decideTaskTransition({
          operation: 'finish',
          currentStatus: row.status,
          targetStatus,
          queueAlreadyHasDifferentInFlight: false
        });
        if (!decision.eligible) return { ok: false, reason: decision.reason };
        row.status = targetStatus;
        row.updatedAt = FINISH_STAMP;
        return { ok: true };
      })
    };
    const history = {
      record: vi.fn(async (run: WorkflowRun, _description: string, terminalStatus: string) => {
        calls.push('history');
        const result: RecordResult = options.recordResult ?? { outcome: 'recorded' };
        if (result.outcome === 'recorded') historyEntries.push({ runId: run.id, terminalStatus });
        return result;
      })
    };
    const logger = new SanitizedLogger([
      {
        appendLine: (line: string) => {
          lines.push(line);
        }
      }
    ]);
    const coordinator = new TerminalTransitionCoordinator(
      store as never, queue as never, history as never, logger
    );
    return { store, queue, history, coordinator, journal, lines, calls, historyEntries };
  }

  type World = ReturnType<typeof worldOver>;
  type DrivenWorld = World & { run: WorkflowRun; drive: () => Promise<void> };

  function messagesAt(lines: readonly string[], level: 'INFO' | 'WARN'): string[] {
    const marker = ` ${level} terminal-transition: `;
    return lines
      .filter((line) => line.includes(marker))
      .map((line) => line.slice(line.indexOf(marker) + level.length + 2));
  }

  function expectNothingWritten(world: World): void {
    expect(world.store.setRun).not.toHaveBeenCalled();
    expect(world.queue.finish).not.toHaveBeenCalled();
    expect(world.history.record).not.toHaveBeenCalled();
  }

  function expectCleared(world: World): void {
    expect(Object.keys(world.journal.entries)).toEqual([]);
  }

  function landedWorld(status: EndedStatus, recordResult?: RecordResult): DrivenWorld {
    const run = endedRun(status);
    const world = worldOver({
      row: requestRow({ status }),
      activeRun: run,
      ...(recordResult === undefined ? {} : { recordResult })
    });
    return { ...world, run, drive: () => world.coordinator.complete(run, DESCRIPTION) };
  }

  function rowGoneWorld(historyEntries: HistoryKey[], recordResult?: RecordResult): DrivenWorld {
    const run = endedRun('completed');
    const world = worldOver({
      intents: intentsOf(run),
      row: null,
      historyEntries,
      activeRun: liveRun(),
      ...(recordResult === undefined ? {} : { recordResult })
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function resumedWorld(advancedPhase: boolean): DrivenWorld {
    const run = endedRun('failed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ updatedAt: ROW_UPDATED_AFTER_AT }),
      activeRun: liveRun({
        lastTransitionAt: advancedPhase
          ? run.lastTransitionAt + LATER_PHASE_ADVANCE
          : run.lastTransitionAt
      })
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function otherStatusWorld(): DrivenWorld {
    const run = endedRun('failed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ status: 'completed', updatedAt: ROW_UPDATED_AFTER_AT }),
      activeRun: liveRun()
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function returnedToPendingWorld(): DrivenWorld {
    const run = endedRun('failed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ status: 'pending', runId: null, updatedAt: ROW_UPDATED_AFTER_AT }),
      activeRun: liveRun()
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function otherRunWorld(): DrivenWorld {
    const run = endedRun('failed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ runId: 'run-other', updatedAt: ROW_UNTOUCHED_AT }),
      activeRun: terminalRun({ id: 'run-other', status: 'running' })
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function pausedWorld(): DrivenWorld {
    const run = endedRun('failed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ status: 'paused', updatedAt: ROW_UNTOUCHED_AT }),
      activeRun: liveRun()
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function interruptedWorld(
    activeRunIs: 'running' | 'terminal',
    recordResult?: RecordResult
  ): DrivenWorld {
    const run = endedRun('completed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ updatedAt: ROW_UNTOUCHED_AT }),
      activeRun: activeRunIs === 'running' ? liveRun() : run,
      ...(recordResult === undefined ? {} : { recordResult })
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  function finishedAfterIntentWorld(): DrivenWorld {
    const run = endedRun('completed');
    const world = worldOver({
      intents: intentsOf(run),
      row: requestRow({ status: 'completed', updatedAt: ROW_UPDATED_AFTER_AT }),
      activeRun: run
    });
    return { ...world, run, drive: () => world.coordinator.replay() };
  }

  it.each(['completed', 'failed', 'canceled'] as const)(
    'U1 %s: a row already finished by settle clears the intent and writes nothing but history',
    async (status) => {
      const world = landedWorld(status);
      await world.drive();
      expect(world.store.setRun).not.toHaveBeenCalled();
      expect(world.queue.finish).not.toHaveBeenCalled();
      expect(world.history.record).toHaveBeenCalledTimes(1);
      expectCleared(world);
    }
  );

  it('U2 row gone, history already held under its old queue: nothing is written, the intent clears', async () => {
    const world = rowGoneWorld([{ runId: RUN_ID, terminalStatus: 'completed' }]);
    await world.drive();
    expectNothingWritten(world);
    expectCleared(world);
  });

  it('U3 row gone, no history anywhere: one entry is recorded and the Run is never written', async () => {
    const world = rowGoneWorld([]);
    await world.drive();
    expect(world.history.record).toHaveBeenCalledTimes(1);
    expect(world.store.setRun).not.toHaveBeenCalled();
    expect(world.queue.finish).not.toHaveBeenCalled();
    expectCleared(world);
  });

  it.each([
    { label: '(a) resumed, before its first phase advance', make: () => resumedWorld(false) },
    { label: '(b) resumed, after a phase advance', make: () => resumedWorld(true) },
    { label: '(c) row attested completed since', make: otherStatusWorld },
    { label: '(d) row returned to pending', make: returnedToPendingWorld }
  ])('U4 $label: a stale intent writes nothing and is dropped', async ({ make }) => {
    const world = make();
    await world.drive();
    expectNothingWritten(world);
    expectCleared(world);
  });

  it('U5 row in flight for another Run: nothing is written, whatever the clock says', async () => {
    const world = otherRunWorld();
    await world.drive();
    expectNothingWritten(world);
    expectCleared(world);
  });

  it('U6 a finish the closed table refuses is dropped before anything is written', async () => {
    const world = pausedWorld();
    await world.drive();
    expectNothingWritten(world);
    expectCleared(world);
  });

  it('U7 an interrupted transition still writes the Run, the row and history, then clears', async () => {
    const world = interruptedWorld('running');
    await world.drive();
    expect(world.calls).toEqual(['run', 'queue', 'history']);
    expect(world.store.setRun).toHaveBeenCalledWith(
      DEFAULT_QUEUE_ID, world.run, unfencedCommit('test-fixture')
    );
    expectCleared(world);
  });

  it('U8 a crash after the Run was written still finishes the row and records history', async () => {
    const world = interruptedWorld('terminal');
    await world.drive();
    expect(world.queue.finish).toHaveBeenCalledTimes(1);
    expect(world.queue.finish).toHaveBeenCalledWith('task-1', 'completed');
    expect(world.history.record).toHaveBeenCalledTimes(1);
    expectCleared(world);
  });

  it('U9 a crash after the row was finished and before history records history only', async () => {
    const world = finishedAfterIntentWorld();
    await world.drive();
    expect(world.history.record).toHaveBeenCalledTimes(1);
    expect(world.store.setRun).not.toHaveBeenCalled();
    expect(world.queue.finish).not.toHaveBeenCalled();
    expectCleared(world);
  });

  it('U10 a description upgrade keeps the intent createdAt', async () => {
    const run = endedRun('failed');
    const world = worldOver({
      intents: { [run.id]: { schemaVersion: 1, run, createdAt: INTENT_CREATED_AT } },
      row: null,
      activeRun: null
    });
    await world.coordinator.begin(run, DESCRIPTION);
    expect(world.journal.entries).toEqual({
      [RUN_ID]: { schemaVersion: 1, run, createdAt: INTENT_CREATED_AT, description: DESCRIPTION }
    });
  });

  it('U11 completing twice records history once and writes nothing the second time', async () => {
    const world = landedWorld('completed');
    await world.drive();
    await world.drive();
    expect(world.history.record).toHaveBeenCalledTimes(1);
    expect(world.queue.finish).not.toHaveBeenCalled();
    expect(world.store.setRun).not.toHaveBeenCalled();
    expect(world.historyEntries).toHaveLength(1);
    expectCleared(world);
  });

  it.each([
    { title: 'U1 landed row', make: () => landedWorld('completed'), info: [] as string[] },
    {
      title: 'U2 row gone, history held',
      make: () => rowGoneWorld([{ runId: RUN_ID, terminalStatus: 'completed' }]),
      info: [CLEARED_LINE]
    },
    { title: 'U3 row gone, no history', make: () => rowGoneWorld([]), info: [CLEARED_LINE] },
    { title: 'U4 (a) resumed', make: () => resumedWorld(false), info: [droppedLine('resumed')] },
    { title: 'U4 (c) other status', make: otherStatusWorld, info: [droppedLine('other-status')] },
    { title: 'U5 other Run', make: otherRunWorld, info: [droppedLine('other-run')] },
    { title: 'U6 refused by the table', make: pausedWorld, info: [droppedLine('refused')] }
  ])('U12 $title logs no warning and only the named info line', async ({ make, info }) => {
    const world = make();
    await world.drive();
    expect(messagesAt(world.lines, 'WARN')).toEqual([]);
    expect(messagesAt(world.lines, 'INFO')).toEqual(info);
    expect(world.lines.filter((line) => line.includes(RUN_ID))).toEqual([]);
  });

  it.each([
    { title: 'landed', make: () => landedWorld('completed', FAILED_RECORD) },
    { title: 'row gone', make: () => rowGoneWorld([], FAILED_RECORD) },
    { title: 'interrupted', make: () => interruptedWorld('running', FAILED_RECORD) }
  ])('U13 $title: a failed history record keeps the intent and warns once', async ({ make }) => {
    const world = make();
    await world.drive();
    expect(Object.keys(world.journal.entries)).toEqual([RUN_ID]);
    expect(messagesAt(world.lines, 'WARN')).toEqual([HISTORY_FAILED_WARNING]);
  });
});
