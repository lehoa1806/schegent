// FR-R3-158 (T015, T016, T017, US1) — the four-source resolution chain that
// puts a settled-phase pair on every Task row.
//
// The chain is in `data-model.md` §3 and its defining property is negative: no
// step inspects the task's status. That is what makes FR-002 ("no status may be
// given its own arithmetic") literally true rather than merely intended, and it
// is why T017 walks all six statuses through the same assertions rather than
// testing the interesting ones.
//
// The case the feature exists for is T016: two failed tasks in one queue, both
// runs disposed of, reporting different counts. A variant that leaves a live run
// in the store would prove nothing — runs are held one per queue, so two failed
// tasks can never both have one, and a projection that only worked while the run
// survived is the defect itself.

import { describe, expect, it } from 'vitest';
import type { PhaseOutcome } from '../../../../src/controller/phase';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import type { TaskPhaseProgressProjection } from '../../../../src/contracts/snapshot-projections';
import type { FeatureRequest, QueueState } from '../../../../src/queue/feature-request';
import type { PhaseResult, WorkflowRun } from '../../../../src/state/workflow-run';
import {
  projectQueue,
  type QueueProjectionContext
} from '../../../../src/ui/sidebar/queue-projector';
import type { QueueItem } from '../../../../src/ui/sidebar/snapshot';

const PHASE_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] as const;
const EVERY_STATUS = [
  'pending',
  'in-flight',
  'paused',
  'completed',
  'failed',
  'canceled'
] as const;

function result(phase: string, outcome: PhaseOutcome): PhaseResult {
  return {
    phase,
    iteration: 1,
    startedAt: 10,
    endedAt: 20,
    result: outcome,
    terminationReason: outcome === 'clean' ? 'deadline' : 'error',
    exitCode: outcome === 'clean' ? 0 : 1,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

function settledThrough(count: number): readonly PhaseResult[] {
  return PHASE_IDS.slice(0, count).map((id) => result(id, 'clean'));
}

function task(overrides: Partial<FeatureRequest> & { id: string }): FeatureRequest {
  return {
    description: `task ${overrides.id}`,
    enqueuedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    startedAt: null,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    status: 'pending',
    position: 0,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    ...overrides
  };
}

function queueOf(...requests: readonly FeatureRequest[]): QueueState {
  return {
    requests: requests.map((request, position) => ({ ...request, position })),
    inFlightId: requests.find((r) => r.status === 'in-flight')?.id ?? null
  } as QueueState;
}

function runFor(featureId: string, completed: readonly PhaseResult[]): WorkflowRun {
  return {
    id: `run-${featureId}`,
    featureId,
    featureDir: 'specs/198',
    status: 'running',
    currentPhase: 'p1',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [...completed],
    lastError: null,
    pipeline: {
      id: 'seven-phase',
      name: 'Seven Phase',
      phases: PHASE_IDS.map((id) => ({ id, name: id, instruction: `${id} prompt.` }))
    },
    plannedTotal: {
      phaseCount: PHASE_IDS.length,
      iterationCap: 10,
      maxPhaseInvocations: PHASE_IDS.length
    },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

/**
 * The projector's context, with only the two fields this feature adds varying.
 * Both are supplied by `snapshot-composer`, which already resolves the queue's
 * run and the catalog — the projector itself does no lookup and no arithmetic.
 */
function ctxWith(
  overrides: Partial<QueueProjectionContext> = {}
): QueueProjectionContext {
  return {
    sanitize: (input: string) => input,
    inFlightPhase: null,
    inFlightId: null,
    ...overrides
  };
}

function rowFor(queue: QueueState, ctx: QueueProjectionContext, id: string): QueueItem {
  const row = projectQueue(queue, ctx).orderedItems.find((item) => item.id === id);
  if (row === undefined) throw new Error(`no projected row for ${id}`);
  return row;
}

/** A catalog resolver that answers with the seven-phase plan for every task. */
const SEVEN_PHASE_CATALOG = (): readonly { readonly id: string }[] =>
  PHASE_IDS.map((id) => ({ id }));

describe('FR-R3-158 (T015) — the source chain, one source at a time', () => {
  it('source 1: the persisted pair wins even while a live run exists (FR-009a)', () => {
    // The precedence rule, and the reason the figure is stable rather than
    // alternating. A row that preferred the run would flip between the recorded
    // number and a re-derived one as the run came and went, and the operator
    // would be reading two different answers to one question.
    const failed = task({
      id: 'recorded',
      status: 'failed',
      phaseProgress: { settled: 5, total: 7 }
    });

    const row = rowFor(
      queueOf(failed),
      ctxWith({
        activeRunTaskId: 'recorded',
        liveRunProgress: { settled: 2, total: 7 }
      }),
      'recorded'
    );

    expect(row.phaseProgress).toEqual({ settled: 5, total: 7 });
  });

  it('source 2: the live run answers for the task that owns it', () => {
    const running = task({ id: 'running', status: 'in-flight' });

    const row = rowFor(
      queueOf(running),
      ctxWith({
        inFlightId: 'running',
        activeRunTaskId: 'running',
        liveRunProgress: { settled: 3, total: 7 }
      }),
      'running'
    );

    expect(row.phaseProgress).toEqual({ settled: 3, total: 7 });
  });

  it('source 2: a sibling task is not handed the live run\'s progress', () => {
    // One run per queue, so exactly one row may read from it. A projector that
    // applied the live pair to every row would give every waiting task the
    // in-flight task's count.
    const running = task({ id: 'running', status: 'in-flight' });
    const waiting = task({ id: 'waiting', status: 'pending' });
    const ctx = ctxWith({
      inFlightId: 'running',
      activeRunTaskId: 'running',
      liveRunProgress: { settled: 3, total: 7 }
    });

    expect(rowFor(queueOf(running, waiting), ctx, 'waiting').phaseProgress).toBeNull();
  });

  it('source 3: a pending task reports zero against its pipeline\'s total (D4)', () => {
    // Preserves today's `0 of N` for a task that has not started. The total
    // comes from the catalog through the shared plan arithmetic, never from a
    // raw `phases.length` — that is the count that does not subtract overrides
    // and produces six of five.
    const waiting = task({ id: 'waiting', status: 'pending', pipelineId: 'seven-phase' });

    const row = rowFor(
      queueOf(waiting),
      ctxWith({ plannedPhasesOf: SEVEN_PHASE_CATALOG }),
      'waiting'
    );

    expect(row.phaseProgress).toEqual({ settled: 0, total: 7 });
  });

  it('source 4: null when nothing resolves (FR-014)', () => {
    // Unknown, and rendered as nothing at all. The three cases that reach here
    // are a task with no record, no run, and no resolvable pipeline.
    const orphan = task({ id: 'orphan', status: 'failed' });

    expect(rowFor(queueOf(orphan), ctxWith(), 'orphan').phaseProgress).toBeNull();
  });

  it('source 4: null when the pipeline cannot be resolved from the catalog', () => {
    const waiting = task({ id: 'waiting', status: 'pending', pipelineId: 'not-in-the-catalog' });

    const row = rowFor(
      queueOf(waiting),
      ctxWith({
        plannedPhasesOf: (id: string) => (id === 'seven-phase' ? SEVEN_PHASE_CATALOG() : null)
      }),
      'waiting'
    );

    expect(row.phaseProgress).toBeNull();
  });

  it('never emits a zero pair as a stand-in for unknown (FR-010)', () => {
    // `{ settled: 0, total: 0 }` renders as a complete run of nothing. Whatever
    // the chain resolves, it is either a real total or no answer.
    const rows = projectQueue(
      queueOf(
        task({ id: 'a', status: 'failed' }),
        task({ id: 'b', status: 'pending' }),
        task({ id: 'c', status: 'canceled' })
      ),
      ctxWith()
    ).orderedItems;

    for (const row of rows) {
      expect(row.phaseProgress, row.id).toBeNull();
    }
  });
});

describe('FR-R3-158 (T016) — two failures, both runs gone', () => {
  it('tells apart a task that settled five from one that settled none', () => {
    // The feature, in one assertion. Both tasks failed, neither has a run, and
    // the numbers still differ — which is only possible because the pair was
    // recorded on the task at its terminal transition.
    const deep = task({
      id: 'failed-late',
      status: 'failed',
      phaseProgress: { settled: 5, total: 7 }
    });
    const shallow = task({
      id: 'failed-early',
      status: 'failed',
      phaseProgress: { settled: 0, total: 7 }
    });

    const rows = projectQueue(queueOf(deep, shallow), ctxWith()).orderedItems;

    expect(rows.map((row) => [row.id, row.phaseProgress])).toEqual([
      ['failed-late', { settled: 5, total: 7 }],
      ['failed-early', { settled: 0, total: 7 }]
    ]);
  });

  it('keeps both figures while a third task runs in the same queue', () => {
    // The disposal that used to erase them: a new task starts, the queue's run
    // is replaced, and the two finished rows must not change.
    const deep = task({
      id: 'failed-late',
      status: 'failed',
      phaseProgress: { settled: 5, total: 7 }
    });
    const shallow = task({
      id: 'failed-early',
      status: 'failed',
      phaseProgress: { settled: 0, total: 7 }
    });
    const running = task({ id: 'running-now', status: 'in-flight' });

    const rows = projectQueue(
      queueOf(deep, shallow, running),
      ctxWith({
        inFlightId: 'running-now',
        activeRunTaskId: 'running-now',
        liveRunProgress: { settled: 1, total: 7 }
      })
    ).orderedItems;

    expect(rows.map((row) => [row.id, row.phaseProgress])).toEqual([
      ['failed-late', { settled: 5, total: 7 }],
      ['failed-early', { settled: 0, total: 7 }],
      ['running-now', { settled: 1, total: 7 }]
    ]);
  });
});

describe('FR-R3-158 (T017) — one rule for all six statuses', () => {
  for (const status of EVERY_STATUS) {
    it(`resolves a recorded pair the same way for ${status} (FR-008, SC-003)`, () => {
      const subject = task({
        id: 'subject',
        status,
        phaseProgress: { settled: 4, total: 7 }
      });

      expect(rowFor(queueOf(subject), ctxWith({ inFlightId: 'subject' }), 'subject').phaseProgress)
        .toEqual({ settled: 4, total: 7 });
    });
  }

  it('gives a completed run its full count with no special case (SC-003)', () => {
    // `completed` is the status most likely to acquire a shortcut — "it
    // finished, so it is all of them". It reaches its full count through the
    // same chain as every other status, which is why a plan whose every phase
    // settled reads 7 of 7 and one that skipped a phase still reads 7 of 7.
    const completed = task({
      id: 'done',
      status: 'completed',
      phaseProgress: { settled: 7, total: 7 }
    });

    expect(rowFor(queueOf(completed), ctxWith(), 'done').phaseProgress).toEqual({
      settled: 7,
      total: 7
    });
  });

  it('holds settled <= total for every status and every source (FR-013)', () => {
    // The invariant as a property. Sources 1 and 2 both come from
    // `settledPhaseProgress`, which guarantees it structurally; source 3 is
    // zero against a real total. There is no fourth way to produce a number.
    const requests = EVERY_STATUS.map((status, index) =>
      task({
        id: `task-${status}`,
        status,
        pipelineId: 'seven-phase',
        ...(index % 2 === 0 ? { phaseProgress: { settled: index, total: 7 } } : {})
      })
    );

    const rows = projectQueue(
      queueOf(...requests),
      ctxWith({
        inFlightId: 'task-in-flight',
        activeRunTaskId: 'task-in-flight',
        liveRunProgress: { settled: 6, total: 7 },
        plannedPhasesOf: SEVEN_PHASE_CATALOG
      })
    ).orderedItems;

    expect(rows).toHaveLength(EVERY_STATUS.length);
    for (const row of rows) {
      const progress: TaskPhaseProgressProjection | null = row.phaseProgress;
      expect(progress, row.id).not.toBeNull();
      expect(progress!.settled, row.id).toBeLessThanOrEqual(progress!.total);
    }
  });

  it('reads the same for a live run whatever the task\'s status says', () => {
    // A task recorded `in-flight` whose run has failed, and a task recorded
    // `failed` whose run is still held, are the same question to the chain. If
    // either answered differently, some step is testing the status.
    const asRunning = rowFor(
      queueOf(task({ id: 'x', status: 'in-flight' })),
      ctxWith({ inFlightId: 'x', activeRunTaskId: 'x', liveRunProgress: { settled: 2, total: 7 } }),
      'x'
    );
    const asFailed = rowFor(
      queueOf(task({ id: 'x', status: 'failed' })),
      ctxWith({ activeRunTaskId: 'x', liveRunProgress: { settled: 2, total: 7 } }),
      'x'
    );

    expect(asRunning.phaseProgress).toEqual(asFailed.phaseProgress);
  });
});

describe('FR-R3-158 — the projected pair is the run\'s, unchanged', () => {
  it('passes through what settledPhaseProgress produced for the live run', () => {
    // The projector adds no arithmetic of its own: what the composer resolves
    // from the run is what reaches the row. Wired through a real Run here so
    // the two ends are checked against each other rather than against a
    // hand-written pair on both sides.
    const run = runFor('live', [...settledThrough(3), result('p4', 'failed')]);
    const running = task({ id: 'live', status: 'in-flight', queueId: DEFAULT_QUEUE_ID });

    const row = rowFor(
      queueOf(running),
      ctxWith({
        inFlightId: 'live',
        activeRunTaskId: run.featureId,
        liveRunProgress: { settled: 3, total: 7 }
      }),
      'live'
    );

    expect(row.phaseProgress).toEqual({ settled: 3, total: 7 });
  });
});

/**
 * FR-R3-158 (T025, T026, US2) — cancellation reaches the count through a
 * different display rule, and must not reach it at all.
 *
 * `phase-projector.ts:117-122` renders the phase a canceled run abandoned as a
 * `skipped` **tile**, because from the phase strip's point of view the phase will
 * not now run. `run-planned-total.ts` also treats `'skipped'` as settled, and for
 * a good reason there: a phase an override disabled genuinely is done with. Put
 * those two facts together through the tiles and a canceled task is credited with
 * the phase it was interrupted in — five of seven for a task that settled four.
 *
 * That is FR-006a's whole subject: the count comes from the run's `phasesCompleted`
 * records, never from what a tile is showing. The two tests below are the
 * regression guard, and they fail the moment anyone re-sources the count from the
 * projector's tiles — which is the natural-looking mistake, since the tiles are
 * right there and already say `skipped`.
 */
describe('FR-R3-158 (T025, T026) — a canceled task keeps credit for what it ran', () => {
  it('reports what settled before cancellation, not the abandoned phase (FR-006a)', () => {
    // Four settled, then cancellation while p5 was in flight. p5 produced no
    // outcome record, so it is not settled — whatever its tile shows.
    const canceled = task({
      id: 'canceled',
      status: 'canceled',
      queueId: DEFAULT_QUEUE_ID,
      completedAt: 1_700_000_100_000,
      phaseProgress: { settled: 4, total: 7 }
    });

    const row = rowFor(queueOf(canceled), ctxWith(), 'canceled');

    expect(row.phaseProgress).toEqual({ settled: 4, total: 7 });
    // Named explicitly: neither the tile-sourced over-count nor the "cancelled
    // means nothing counts" under-count is what this row may say.
    expect(row.phaseProgress).not.toEqual({ settled: 5, total: 7 });
    expect(row.phaseProgress).not.toEqual({ settled: 0, total: 7 });
  });

  it('holds that figure as the queue moves on and the run is disposed', () => {
    // The canceled task's run is gone — nothing in the context answers for it —
    // and a different task now owns the queue's live run. The recorded pair is
    // the only source left, which is exactly the arrangement the feature exists
    // to make work.
    const canceled = task({
      id: 'canceled',
      status: 'canceled',
      queueId: DEFAULT_QUEUE_ID,
      pipelineId: 'seven-phase',
      phaseProgress: { settled: 4, total: 7 }
    });
    const next = task({
      id: 'next',
      status: 'in-flight',
      queueId: DEFAULT_QUEUE_ID,
      pipelineId: 'seven-phase'
    });

    const row = rowFor(
      queueOf(canceled, next),
      ctxWith({
        inFlightId: 'next',
        activeRunTaskId: 'next',
        liveRunProgress: { settled: 1, total: 7 },
        plannedPhasesOf: SEVEN_PHASE_CATALOG
      }),
      'canceled'
    );

    // Not the successor's `{1,7}`, and not the catalog path's `{0,7}` either:
    // the pair recorded at cancellation outranks both (FR-009a).
    expect(row.phaseProgress).toEqual({ settled: 4, total: 7 });
  });
});

/**
 * FR-R3-158 (T029, US3, FR-010, SC-008) — a record from before the feature.
 *
 * Every task already in an operator's queue when this ships carries no recorded
 * pair, and its run is long gone. There is no honest figure for those rows and
 * the feature does not invent one: `null` travels to the surface and the surface
 * shows nothing.
 *
 * The temptation this guards against is the small one — defaulting the absent
 * field to `{ settled: 0, total: 0 }` so the type is simpler downstream. That
 * renders as a completed run of no phases, which is a false statement about
 * every historical task at once.
 */
describe('FR-R3-158 (T029) — a task record that predates the feature', () => {
  it('projects null for a terminal task with no recorded pair and no run', () => {
    const legacy = task({
      id: 'legacy',
      status: 'failed',
      queueId: DEFAULT_QUEUE_ID,
      completedAt: 1_700_000_100_000
    });

    const row = rowFor(queueOf(legacy), ctxWith(), 'legacy');

    expect(row.phaseProgress).toBeNull();
    // Stated as its own assertion because `toBeNull` alone would still pass if
    // the resolution had been changed to produce a zero pair somewhere else and
    // this row happened to miss it.
    expect(row.phaseProgress).not.toEqual({ settled: 0, total: 0 });
  });

  it('projects null even when the queue holds a live run for another task', () => {
    // The legacy row must not borrow the successor's figure to fill its gap.
    const legacy = task({ id: 'legacy', status: 'failed', queueId: DEFAULT_QUEUE_ID });
    const running = task({ id: 'running', status: 'in-flight', queueId: DEFAULT_QUEUE_ID });

    const row = rowFor(
      queueOf(legacy, running),
      ctxWith({
        inFlightId: 'running',
        activeRunTaskId: 'running',
        liveRunProgress: { settled: 6, total: 7 }
      }),
      'legacy'
    );

    expect(row.phaseProgress).toBeNull();
  });
});
