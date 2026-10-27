// FR-R4-F01 (spec 239, US1, T009, FR-006, contract C4, decision TA2) — a refused
// terminal outcome is never replayed over the winner.
//
// The terminal journal is persisted BEFORE the terminal Run record, so a Run that
// lost its queue mid-flight has already journalled the outcome the commit then
// refuses. Two things used to follow: the intent stayed journalled, and
// `RunDriver` re-journalled and re-committed it from a `finally`. A later
// `replay()` therefore wrote the loser's outcome over the winner's Run.
//
// The coordinator now owns the answer in one place (`abandonRefused`): it removes
// the intent THIS window wrote, only that one, and says so once. `replay()` also
// defers an intent whose queue a live rival holds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalTransitionCoordinator } from '../../../src/services/terminal-transition-coordinator';
import { STALENESS_THRESHOLD_MS } from '../../../src/state/lock';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { QueueMutationRejected } from '../../../src/state/workspace-state';
import type { TerminalTransitionIntent, WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 5_000_000;
const QUEUE_ID = 'queue-q';
const OWNER = 'window-a';
const RIVAL = 'window-b';
/** The owner id is a secret-shaped value in the field; no notice may carry it. */
const SECRET_FRAGMENTS = [OWNER, RIVAL, '/ws/', '.schegent'];

function terminalRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-0123456789',
    featureId: 'task-1',
    featureDir: '',
    status: 'completed',
    currentPhase: 'done',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
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

interface Harness {
  readonly coordinator: TerminalTransitionCoordinator;
  readonly entries: Partial<Record<string, TerminalTransitionIntent>>;
  readonly setRun: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
  readonly record: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
  readonly verify: ReturnType<typeof vi.fn>;
}

function harness(
  run: WorkflowRun,
  options: {
    readonly setRunFailure?: unknown;
    readonly initial?: Record<string, TerminalTransitionIntent>;
    readonly record?: unknown;
    readonly verify?: unknown;
  } = {}
): Harness {
  const entries: Partial<Record<string, TerminalTransitionIntent>> = { ...(options.initial ?? {}) };
  const setRun = vi.fn(async () => {
    if (options.setRunFailure !== undefined) throw options.setRunFailure;
  });
  const read = vi.fn(async () => options.record ?? null);
  const verify = vi.fn(async () => options.verify ?? { outcome: 'rejected', reason: 'stale-fence' });
  const store = {
    getTerminalTransitionIntents: () => entries,
    setTerminalTransitionIntent: vi.fn(
      async (runId: string, intent: TerminalTransitionIntent | null) => {
        if (intent === null) delete entries[runId];
        else entries[runId] = intent;
      }
    ),
    removeTerminalIntentIfOwn: vi.fn(async (runId: string, createdAt: number) => {
      if (entries[runId]?.createdAt !== createdAt) return false;
      delete entries[runId];
      return true;
    }),
    findRunByTask: () => ({ queueId: QUEUE_ID, run }),
    findRunById: () => ({ queueId: QUEUE_ID, run }),
    getRequest: () => ({ id: run.featureId, status: 'in-flight', runId: run.id, updatedAt: 0 }),
    getHistory: () => [],
    setRun,
    runCommitClaim: vi.fn(() => unfencedCommit('test-fixture')),
    ownership: { read, verify }
  };
  const finish = vi.fn(async () => ({ ok: true }));
  const record = vi.fn(async () => ({ outcome: 'recorded' as const }));
  const warn = vi.fn();
  const info = vi.fn();
  const logger = { warn, info, error: vi.fn(), debug: vi.fn() };
  const coordinator = new TerminalTransitionCoordinator(
    store as never,
    { finish } as never,
    { record } as never,
    logger as never
  );
  return { coordinator, entries, setRun, finish, record, warn, info, read, verify };
}

const refusal = (reason: 'ownership-lost' | 'fence-superseded' | 'fence-unverifiable') =>
  new QueueMutationRejected(reason, `Run mutation refused: ${reason}`);

/** Every logged context that carries the lost-ownership outcome. */
function lostNotices(h: Harness): Array<Record<string, unknown>> {
  return [...h.warn.mock.calls, ...h.info.mock.calls]
    .map(([, context]) => context as Record<string, unknown> | undefined)
    .filter((context): context is Record<string, unknown> => context?.outcome === 'held-in-memory');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('begin() returns the createdAt it journalled or kept (TA2)', () => {
  it('returns null for a nonterminal Run and journals nothing', async () => {
    const run = terminalRun({ status: 'running' });
    const h = harness(run);

    expect(await h.coordinator.begin(run)).toBeNull();
    expect(h.entries).toEqual({});
  });

  it('returns the createdAt of the intent it wrote', async () => {
    const run = terminalRun();
    const h = harness(run);

    expect(await h.coordinator.begin(run)).toBe(NOW);
    expect(h.entries[run.id]?.createdAt).toBe(NOW);
  });

  it('returns the first createdAt when it only upgrades the description', async () => {
    const run = terminalRun();
    const h = harness(run);
    const first = await h.coordinator.begin(run);
    vi.setSystemTime(NOW + 10_000);

    const second = await h.coordinator.begin(run, 'the operator text');

    expect(second).toBe(first);
    expect(h.entries[run.id]?.createdAt).toBe(first);
    expect(h.entries[run.id]?.description).toBe('the operator text');
  });
});

describe('a refused terminal commit abandons only this window\'s intent (C4 G13)', () => {
  it.each(['ownership-lost', 'fence-superseded'] as const)(
    'removes the intent journalled by this window when the coordinator commit is refused %s',
    async (reason) => {
      const run = terminalRun();
      const h = harness(run, { setRunFailure: refusal(reason) });

      await h.coordinator.complete(run, 'description');

      expect(h.setRun).toHaveBeenCalledTimes(1);
      expect(h.entries).toEqual({});
      expect(h.finish).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    }
  );

  it('keeps the intent for a fence-unverifiable refusal: replay remains pending', async () => {
    const run = terminalRun();
    const h = harness(run, { setRunFailure: refusal('fence-unverifiable') });

    await h.coordinator.complete(run, 'description');

    expect(h.entries[run.id]).toBeDefined();
    expect(lostNotices(h)).toEqual([]);
  });

  it('keeps the intent for a refusal that is not about ownership', async () => {
    const run = terminalRun();
    const h = harness(run, { setRunFailure: new Error('disk full') });

    await h.coordinator.complete(run, 'description');

    expect(h.entries[run.id]).toBeDefined();
  });

  it('removes the intent the controller commit point journalled, through abandonRefused', async () => {
    const run = terminalRun();
    const h = harness(run);
    const createdAt = await h.coordinator.begin(run);

    await h.coordinator.abandonRefused(run, createdAt!, 'ownership-lost', QUEUE_ID);

    expect(h.entries).toEqual({});
  });

  it('leaves an intent with another createdAt in place: that one is the winner\'s', async () => {
    const run = terminalRun();
    const h = harness(run);
    const mine = await h.coordinator.begin(run);
    h.entries[run.id] = { schemaVersion: 1, run, createdAt: NOW + 777 };

    await h.coordinator.abandonRefused(run, mine!, 'fence-superseded', QUEUE_ID);

    expect(h.entries[run.id]?.createdAt).toBe(NOW + 777);
  });

  it('never removes an intent it did not write, even when begin() kept it', async () => {
    const run = terminalRun();
    const theirs: TerminalTransitionIntent = { schemaVersion: 1, run, createdAt: NOW - 9_999 };
    const h = harness(run, {
      initial: { [run.id]: theirs },
      setRunFailure: refusal('ownership-lost')
    });

    await h.coordinator.complete(run, 'description');

    expect(h.entries[run.id]?.createdAt).toBe(NOW - 9_999);
  });
});

describe('the lost-ownership notice (data-model §7, FR-006, FR-033)', () => {
  it('is logged once per Run id, with metadata only', async () => {
    const run = terminalRun();
    const h = harness(run, { setRunFailure: refusal('ownership-lost') });
    const first = await h.coordinator.begin(run);

    await h.coordinator.abandonRefused(run, first!, 'ownership-lost', QUEUE_ID);
    // The driver's `finally` re-journals and re-commits, and is refused again.
    await h.coordinator.complete(run, 'description');

    const notices = lostNotices(h);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      queueId: QUEUE_ID,
      runId: 'run-0123',
      reason: 'ownership-lost',
      outcome: 'held-in-memory'
    });
    const serialized = JSON.stringify([...h.warn.mock.calls, ...h.info.mock.calls]);
    for (const fragment of SECRET_FRAGMENTS) expect(serialized).not.toContain(fragment);
  });

  it('is logged separately for two different Runs', async () => {
    const runA = terminalRun({ id: 'run-aaaaaaaa1' });
    const runB = terminalRun({ id: 'run-bbbbbbbb2' });
    const h = harness(runA);
    const a = await h.coordinator.begin(runA);
    const b = await h.coordinator.begin(runB);

    await h.coordinator.abandonRefused(runA, a!, 'ownership-lost', QUEUE_ID);
    await h.coordinator.abandonRefused(runB, b!, 'fence-superseded', QUEUE_ID);

    expect(lostNotices(h).map((notice) => notice.runId)).toEqual(['run-aaaa', 'run-bbbb']);
  });
});

describe('replay(selfOwnerId) defers an intent whose queue a live rival holds (C4 G14)', () => {
  const heartbeatInside = NOW - 1_000;
  const heartbeatStale = NOW - STALENESS_THRESHOLD_MS - 1;
  const recordHeldBy = (ownerId: string, heartbeatAt: number) => ({
    version: 1,
    resource: `queue:${QUEUE_ID}`,
    fence: 3,
    holder: { ownerId, acquiredAt: heartbeatAt, heartbeatAt }
  });
  const pending = (run: WorkflowRun): Record<string, TerminalTransitionIntent> => ({
    [run.id]: { schemaVersion: 1, run, createdAt: NOW - 50_000, description: 'd' }
  });

  it('defers while another holder\'s heartbeat is inside the staleness threshold', async () => {
    const run = terminalRun();
    const h = harness(run, { initial: pending(run), record: recordHeldBy(RIVAL, heartbeatInside) });

    await h.coordinator.replay(OWNER);

    expect(h.setRun).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.entries[run.id]).toBeDefined();
  });

  it('defers when the ownership record cannot be read', async () => {
    const run = terminalRun();
    const h = harness(run, { initial: pending(run), verify: { outcome: 'unavailable' } });

    await h.coordinator.replay(OWNER);

    expect(h.setRun).not.toHaveBeenCalled();
    expect(h.entries[run.id]).toBeDefined();
  });

  it('logs each deferred intent once per replay() call, naming the Run by 8 characters', async () => {
    const run = terminalRun();
    const h = harness(run, { initial: pending(run), record: recordHeldBy(RIVAL, heartbeatInside) });

    await h.coordinator.replay(OWNER);
    const afterFirst = [...h.warn.mock.calls, ...h.info.mock.calls].filter(([message]) =>
      String(message).includes('deferred')
    );
    await h.coordinator.replay(OWNER);
    const afterSecond = [...h.warn.mock.calls, ...h.info.mock.calls].filter(([message]) =>
      String(message).includes('deferred')
    );

    expect(afterFirst).toHaveLength(1);
    expect(afterSecond).toHaveLength(2);
    expect(String(afterFirst[0]?.[0])).toContain('run-0123');
    expect(String(afterFirst[0]?.[0])).not.toContain(run.id);
    for (const fragment of SECRET_FRAGMENTS) {
      expect(JSON.stringify(afterFirst)).not.toContain(fragment);
    }
  });

  it.each([
    ['this window holds the queue', recordHeldBy(OWNER, heartbeatInside)],
    ['the rival\'s heartbeat is stale', recordHeldBy(RIVAL, heartbeatStale)],
    ['nobody holds the queue', null]
  ])('replays when %s', async (_name, record) => {
    const run = terminalRun();
    const h = harness(run, { initial: pending(run), record });

    await h.coordinator.replay(OWNER);

    expect(h.setRun).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledWith(run.featureId, 'completed');
    expect(h.entries).toEqual({});
  });

  it('behaves as today without an owner id, whatever the record says (TA4)', async () => {
    const run = terminalRun();
    const h = harness(run, { initial: pending(run), record: recordHeldBy(RIVAL, heartbeatInside) });

    await h.coordinator.replay();

    expect(h.setRun).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.entries).toEqual({});
  });
});
