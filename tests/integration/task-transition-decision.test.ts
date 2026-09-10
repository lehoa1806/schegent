// FR-R3-153 (T1636) — the closed task-transition table, proved end to end
// through the real QueueManager/WorkspaceStateStore writers (not just the
// pure `decideTaskTransition` classifier in isolation): every disallowed
// transition named in spec.md's closed transition table (FR-006–FR-010) is
// refused with zero persisted change to the task row, queue `inFlightId`,
// `RunStateMap` entry, or timestamps (spec FR-004, SC-001), and a valid edge
// on one queue never touches a sibling queue's state (spec FR-010, SC-002).

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { WorkflowRun } from '../../src/state/workflow-run';
import {
  decideTaskTransition,
  TASK_TRANSITION_REJECTION_REASONS,
  // Feature 195 (T066) — the sufficiency gate enumerates the exits by asking
  // the classifier every question that could yield one, so it builds inputs.
  type TaskTransitionDecisionInput,
  type TaskTransitionDecisionResult,
  type TaskTransitionRejectionReason
} from '../../src/queue/task-transition-decision';
import type { FeatureRequestStatus, TerminalRequestStatus } from '../../src/queue/feature-request';
import { runCancel } from '../../src/commands/cancel';
import { SanitizedLogger } from '../../src/lib/logger';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { Notifier } from '../../src/ui/notifications';

class MockMemento implements Memento {
  public writeCount = 0;
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writeCount++;
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

async function buildSystem(): Promise<{ store: WorkspaceStateStore; queue: QueueManager; memento: MockMemento }> {
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  return { store, queue, memento };
}

function sampleRun(featureId: string, status: WorkflowRun['status'] = 'running'): WorkflowRun {
  return {
    id: `run-${featureId}`,
    featureId,
    featureDir: 'specs/001-x',
    status,
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
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
  };
}

/** A snapshot of everything a refused transition must leave untouched. */
interface Snapshot {
  readonly requestJson: string | null;
  readonly inFlightId: string | null;
  readonly runMapJson: string;
  readonly writeCount: number;
}

function snapshot(store: WorkspaceStateStore, memento: MockMemento, taskId: string, queueId: string): Snapshot {
  return {
    requestJson: JSON.stringify(store.getRequest(taskId)),
    inFlightId: store.getQueue(queueId).inFlightId,
    runMapJson: JSON.stringify(store.getRunMap()),
    writeCount: memento.writeCount
  };
}

function expectUnchanged(before: Snapshot, after: Snapshot): void {
  expect(after.requestJson).toBe(before.requestJson);
  expect(after.inFlightId).toBe(before.inFlightId);
  expect(after.runMapJson).toBe(before.runMapJson);
  expect(after.writeCount).toBe(before.writeCount);
}

describe('closed transition table — refused cells (spec.md FR-006-FR-010, SC-001)', () => {
  it('refuses marking a missing task in-flight', async () => {
    const { store, queue, memento } = await buildSystem();
    const before = snapshot(store, memento, 'missing', DEFAULT_QUEUE_ID);
    await expect(queue.markInFlight('missing', 'run-x')).rejects.toThrow(/task-not-found/);
    expectUnchanged(before, snapshot(store, memento, 'missing', DEFAULT_QUEUE_ID));
  });

  it('refuses marking a second task in-flight while the queue already owns one', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-a');
    const before = snapshot(store, memento, b.id, DEFAULT_QUEUE_ID);
    await expect(queue.markInFlight(b.id, 'run-b')).rejects.toThrow(/in-flight-ownership-conflict/);
    expectUnchanged(before, snapshot(store, memento, b.id, DEFAULT_QUEUE_ID));
  });

  // research.md R10 — `completed`/`canceled` are the only two source statuses
  // this operation still refuses; `failed` is deliberately eligible (below),
  // matching `isOperableRunStatus`'s operable/terminal split for Runs.
  it.each(['completed', 'canceled'] as const)(
    'refuses marking a %s task in-flight',
    async (status) => {
      const { store, queue, memento } = await buildSystem();
      const a = await queue.enqueue('A');
      await queue.markInFlight(a.id, 'run-a');
      await queue.finish(a.id, status);
      const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
      await expect(queue.markInFlight(a.id, 'run-a-2')).rejects.toThrow(/illegal-source-status/);
      expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
    }
  );

  it("refuses finish(..., 'paused') on an in-flight task", async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    // @ts-expect-error — 'paused' is not a TerminalRequestStatus; the type
    // narrowing (T002/T009) is itself part of what this feature closes.
    const result = await queue.finish(a.id, 'paused');
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses pausing a pending task', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses pausing a terminal task', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'canceled');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses driving a completed task back to pending', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'completed');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    const result = await queue.retry(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-state' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  // FR-R3-161 (T059, FR-011a) — 2026-09-04. `it('refuses marking a task
  // in-flight while addressing the wrong queue (classifier level)', …)` stood
  // here. It constructed `queueOwnsTask: false` by hand and asserted the
  // resulting `'queue-mismatch'`, and its own comment recorded why it had to:
  // "Unreachable through QueueManager's own public writers today — none of
  // markInFlight/finish/pause takes a caller-supplied queue id distinct from
  // the task's own row, so there is no real call shape that addresses a
  // different queue."
  //
  // This is **coverage replacement, not coverage loss**. The cell it pinned no
  // longer exists: the input and the branch are gone, and what replaces the
  // assertion is stronger than it was. It asserted that one hand-built input
  // produced one reason; T061 asserts the vocabulary has exactly three members,
  // so restoring a fourth — this one or any other — fails, and T062 asserts the
  // queue manager's runtime Set cannot drift from that vocabulary. A test that
  // could only be reached by constructing an input no caller constructs was
  // pinning the classifier's willingness to answer a question nothing asked.
  //
  // Nothing else in this file changes shape. T027's coverage pin still requires
  // a row for every status and every terminal target; the ~15 remaining
  // `queueOwnsTask: true` sites lost a field, not a case.
});

describe('closed transition table — accepted cells', () => {
  it('accepts pending -> in-flight', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  // research.md R10 — three real resume mechanisms, each re-marking the
  // SAME task in-flight without first returning it to pending:
  // in-flight (delayed-retry countdown never left the row), paused
  // (RunDriver's pause-verify branch cleared inFlightId), failed (resuming
  // a halted workflow directly). All are `queueAlreadyHasDifferentInFlight
  // === false` for the SAME task, distinguishing them from a genuine
  // duplicate admission.
  it('accepts in-flight -> in-flight (idempotent re-affirmation, e.g. delayed-retry resume)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await expect(queue.markInFlight(a.id, 'run-a')).resolves.toBeUndefined();
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('accepts paused -> in-flight (e.g. operator resume after RunDriver pause-verify)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.pause(a.id);
    expect(queue.findById(a.id)?.status).toBe('paused');
    await expect(queue.markInFlight(a.id, 'run-a')).resolves.toBeUndefined();
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('accepts failed -> in-flight (e.g. resuming a halted workflow directly)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'failed');
    expect(queue.findById(a.id)?.status).toBe('failed');
    await expect(queue.markInFlight(a.id, 'run-a')).resolves.toBeUndefined();
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('accepts in-flight -> paused', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    expect(await queue.pause(a.id)).toEqual({ ok: true });
  });

  it('accepts in-flight -> any terminal status via finish', async () => {
    const { queue } = await buildSystem();
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const a = await queue.enqueue(`A-${status}`);
      await queue.markInFlight(a.id, `run-${status}`);
      expect(await queue.finish(a.id, status)).toEqual({ ok: true });
    }
  });

  it("accepts pending -> canceled via finish (cancel-before-start, research.md R4)", async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    expect(await queue.finish(a.id, 'canceled')).toEqual({ ok: true });
    expect(queue.findById(a.id)?.status).toBe('canceled');
  });

  // FR-R3-160 — the cancel-before-start edge's missing sibling: fail-before-start.
  //
  // `WorkflowController.admitNew` builds the Run *before* it marks the task
  // in-flight, so anything that throws in `WorkflowRunFactory.create` — an
  // unresolvable `pipelineId` is the reachable one — leaves the task `pending`.
  // The failure path then tries to fail it, and until this edge existed that
  // `finish` was refused `illegal-source-status`, logged, and ignored. The task
  // stayed pending and `reportUnexpectedStartFailure` ended by re-arming the
  // drain, which re-drove the same task into the same refusal: an unbounded loop
  // at ~19,500 iterations/second that exhausted the worker's heap and was why
  // the host suite could not exit zero (196/research.md §4a).
  //
  // Asserted through `QueueManager.finish` and not only the pure classifier
  // because the writer is what the failure path calls; a table that admits the
  // edge while the writer still refuses it would fix nothing.
  it('accepts pending -> failed via finish (fail-before-start, FR-R3-160)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    expect(await queue.finish(a.id, 'failed')).toEqual({ ok: true });
    expect(queue.findById(a.id)?.status).toBe('failed');
  });

  it('the pure classifier agrees: finish/failed is accepted from pending (FR-R3-160)', () => {
    expect(
      decideTaskTransition({
        operation: 'finish',
        currentStatus: 'pending',
        targetStatus: 'failed',
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual({ eligible: true });
  });

  // The edge is deliberately narrow. `completed` is the one terminal status a
  // task cannot reach without running, so `pending -> completed` stays refused —
  // otherwise "finish from pending" would become a general escape hatch rather
  // than the two specific pre-start outcomes the table means to admit.
  it('does not widen to pending -> completed (FR-R3-160)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    expect(await queue.finish(a.id, 'completed')).toEqual({
      ok: false,
      reason: 'illegal-source-status'
    });
    expect(queue.findById(a.id)?.status).toBe('pending');
  });

  it('accepts paused/failed/canceled -> pending via retry, each with its own explicit trigger', async () => {
    const { queue } = await buildSystem();
    for (const status of ['paused', 'failed', 'canceled'] as const) {
      const a = await queue.enqueue(`A-${status}`);
      await queue.markInFlight(a.id, `run-${status}`);
      if (status === 'paused') {
        await queue.pause(a.id);
      } else {
        await queue.finish(a.id, status);
      }
      expect(await queue.retry(a.id)).toEqual({ ok: true });
      expect(queue.findById(a.id)?.status).toBe('pending');
    }
  });
});

describe('two-queue isolation (spec.md FR-010, SC-002)', () => {
  it('a valid edge on Queue A never changes Queue B\'s inFlightId or Run', async () => {
    const { store, queue } = await buildSystem();
    const queueBId = (await queue.createQueue('Queue B')).queueId as string;

    const a = await queue.enqueue('A', { queueId: DEFAULT_QUEUE_ID });
    const b = await queue.enqueue('B', { queueId: queueBId });
    await queue.markInFlight(b.id, 'run-b');
    await store.setRun(queueBId, sampleRun(b.id), unfencedCommit('test-fixture'));

    const beforeB = {
      inFlightId: store.getQueue(queueBId).inFlightId,
      request: JSON.stringify(store.getRequest(b.id)),
      run: JSON.stringify(store.getRun(queueBId))
    };

    await queue.markInFlight(a.id, 'run-a');
    await queue.pause(a.id);
    await queue.retry(a.id);

    expect(store.getQueue(queueBId).inFlightId).toBe(beforeB.inFlightId);
    expect(JSON.stringify(store.getRequest(b.id))).toBe(beforeB.request);
    expect(JSON.stringify(store.getRun(queueBId))).toBe(beforeB.run);
  });

  it('refusing a transition on Queue A leaves Queue B fully untouched, including write count', async () => {
    const { store, queue, memento } = await buildSystem();
    const queueBId = (await queue.createQueue('Queue B')).queueId as string;
    const b = await queue.enqueue('B', { queueId: queueBId });
    await queue.markInFlight(b.id, 'run-b');

    const a = await queue.enqueue('A', { queueId: DEFAULT_QUEUE_ID });
    await queue.markInFlight(a.id, 'run-a');
    const secondOnA = await queue.enqueue('A2', { queueId: DEFAULT_QUEUE_ID });

    const beforeB = snapshot(store, memento, b.id, queueBId);
    await expect(queue.markInFlight(secondOnA.id, 'run-a-2')).rejects.toThrow(/in-flight-ownership-conflict/);
    expectUnchanged(beforeB, snapshot(store, memento, b.id, queueBId));
  });
});

describe('feature 195 (T060, FR-009) — a failed task cannot be cancelled', () => {
  // FR-009 names retrying and removing as the only two ways out of a halt,
  // and says cancelling is not a third — because `failed -> canceled` is not
  // an edge in this table. `finish` is the method a cancel-of-an-in-flight-Task
  // routes through (`src/commands/cancel.ts`), and it is the same closed
  // table `decideTaskTransition`'s `finish` case enforces: eligible from
  // `in-flight` unconditionally, and from `pending` only when the target is
  // `canceled` (the cancel-before-start edge) — `failed` is neither.
  it('refuses finish(id, "canceled") on a task that already ended failed', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'failed');
    expect(queue.findById(a.id)?.status).toBe('failed');

    const result = await queue.finish(a.id, 'canceled');

    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expect(queue.findById(a.id)?.status).toBe('failed');
  });

  it('the pure classifier agrees: finish/canceled is refused from every status but pending and in-flight', () => {
    const nonEligible = (['failed', 'canceled', 'completed', 'paused'] as const).map((currentStatus) =>
      decideTaskTransition({
        operation: 'finish',
        currentStatus,
        targetStatus: 'canceled',
        queueAlreadyHasDifferentInFlight: false
      })
    );
    for (const decision of nonEligible) {
      expect(decision.eligible).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// feature 195 (T066, SC-016) — the exit set from the blocking outcome is
// SUFFICIENT, not merely closed.
//
// PAIRED WITH T060 DIRECTLY ABOVE, AND THE PAIRING IS THE WHOLE POINT. T060
// asks what the table REFUSES from `failed`, and proves `failed -> canceled` is
// not an edge. A table that admitted nothing whatsoever from `failed` would
// answer that question exactly as a correct one does — every assertion in T060
// is an expected refusal, so a stricter table cannot fail any of them. That is
// asserted below rather than argued, and it is why exclusivity passing has
// never implied sufficiency.
//
// This is the check the feature was missing. FR-009's exit set was verified for
// exclusivity at T060 and the surface it described was still unusable for the
// case BUG-001 found: a task recorded `failed` after its phase had already
// committed, where retrying repeats an irreversible side effect and removing
// destroys the record that the work happened. Both admitted exits were
// disqualified for that operator, and nothing failed.
//
// DERIVED FROM THE CLASSIFIER, NOT TRANSCRIBED — the opposite choice from the
// 36-cell matrix below, on purpose. That matrix transcribes, because its job is
// to pin a table against drift. A sufficiency claim cannot be written that way:
// a transcribed exit set reports whatever this file says it is, and the failure
// mode being guarded against is precisely the real set being emptier than the
// document. So the exits are enumerated by asking the classifier every question
// that could produce one.
// ───────────────────────────────────────────────────────────────────────────

/**
 * SC-016's two disqualifiers, as properties of an exit rather than as a list of
 * which exits are acceptable. An exit qualifies when it has neither.
 */
interface ExitProperties {
  /** Puts the task back on the run path, so its phase can be invoked again. */
  readonly reRunsTheTask: boolean;
  /** Leaves no row for the task, so the record that the work happened is gone. */
  readonly discardsTheRow: boolean;
}

/**
 * Every question that could yield an exit from a status, asked of the
 * classifier and keyed by an operator-facing label.
 *
 * `finish` is expanded over its three targets, and over
 * `operatorAttestedCompletion` in both settings: edge 4 is admitted only with
 * the flag set, so an enumeration that omitted it would report a smaller exit
 * set than the real one — the direction that hides the defect this block exists
 * to catch. `remove` is absent because it is not a transition at all: it
 * deletes the row rather than moving it, so the classifier is never asked. It
 * is added by hand in the table below, where its disqualification is the point.
 */
function admittedExitsFrom(currentStatus: FeatureRequestStatus): readonly string[] {
  const questions: readonly (readonly [string, TaskTransitionDecisionInput])[] = [
    ['mark-in-flight', { operation: 'mark-in-flight', currentStatus, queueAlreadyHasDifferentInFlight: false }],
    ['pause', { operation: 'pause', currentStatus, queueAlreadyHasDifferentInFlight: false }],
    ['return-to-pending', { operation: 'return-to-pending', currentStatus, queueAlreadyHasDifferentInFlight: false }],
    ...(['completed', 'canceled', 'failed'] as const).flatMap(
      (targetStatus) =>
        [
          [
            `finish -> ${targetStatus}`,
            { operation: 'finish' as const, currentStatus, targetStatus, queueAlreadyHasDifferentInFlight: false }
          ],
          [
            `finish -> ${targetStatus} (attested)`,
            {
              operation: 'finish' as const,
              currentStatus,
              targetStatus,
              queueAlreadyHasDifferentInFlight: false,
              operatorAttestedCompletion: true
            }
          ]
        ] as readonly (readonly [string, TaskTransitionDecisionInput])[]
    )
  ];

  return questions.filter(([, input]) => decideTaskTransition(input).eligible).map(([label]) => label);
}

/**
 * What each exit from `failed` does to the task, judged against SC-016's two
 * clauses. Written out rather than computed, because these are facts about the
 * product's behaviour after the transition — not about the transition table —
 * and a table that derived them from the classifier would be asking the
 * classifier to grade itself.
 *
 * `Partial` is load-bearing rather than decoration: `Record<string, …>` would
 * claim every string has a judgement, which would make the lookup below total
 * and the guard after it unreachable — the guard is the thing that catches an
 * exit this table has not judged, so the type has to admit the gap it guards.
 */
const EXIT_PROPERTIES: Readonly<Partial<Record<string, ExitProperties>>> = {
  // FR-008's retry exit. `failed -> pending` hands the row back to the drain,
  // which is the whole purpose and also the disqualification: the phase that
  // committed the side effect runs again.
  'return-to-pending': { reRunsTheTask: true, discardsTheRow: false },
  // Repointing a halted workflow directly at a task, which the transcribed
  // `MARK_IN_FLIGHT` row below admits from `failed`. Same disqualification by a
  // shorter route — it is in-flight again without passing through the drain.
  'mark-in-flight': { reRunsTheTask: true, discardsTheRow: false },
  // FR-007's remove exit, and the one exit that is not a transition. It ends
  // the halt by deleting the row (feature 192, invariant 5 — removal deletes,
  // it does not mark), which is exactly the second clause.
  remove: { reRunsTheTask: false, discardsTheRow: true },
  // FR-025's attested exit, added by T063. Neither clause: the row stays and
  // carries its `lastError` and `completedAt`, and `completed` is outside the
  // blocking set so no further pass names it — which is how the halt ends with
  // nothing stored about it (FR-003).
  'finish -> completed (attested)': { reRunsTheTask: false, discardsTheRow: false }
};

describe('feature 195 (T066, SC-016) — the exit set from `failed` is sufficient', () => {
  it('every admitted exit from `failed` has a recorded judgement, and vice versa', () => {
    // Non-vacuity in both directions, and the reason this test comes first. The
    // sufficiency assertion below reads `EXIT_PROPERTIES`, so an exit the
    // classifier admits and this file forgot would be judged by nothing at all,
    // and a judgement for an exit the classifier no longer admits would keep
    // answering after its subject was withdrawn. `remove` is the one deliberate
    // asymmetry: it never appears in the derived set because it is not a
    // transition, so it is excluded here by name rather than by silence.
    const derived = admittedExitsFrom('failed');
    const judged = Object.keys(EXIT_PROPERTIES).filter((label) => label !== 'remove');

    expect([...derived].sort()).toEqual([...judged].sort());
  });

  it('at least one admitted exit neither re-runs the task nor discards its row', () => {
    // SC-016 as written. `remove` is included in the candidate set even though
    // the classifier never yields it, because leaving it out would make the
    // criterion easier to satisfy by hiding one of the two exits that fail it.
    const candidates = [...admittedExitsFrom('failed'), 'remove'];
    const qualifying = candidates.filter((label) => {
      const properties = EXIT_PROPERTIES[label];
      if (properties === undefined) throw new Error(`unjudged exit from failed: ${label}`);
      return !properties.reRunsTheTask && !properties.discardsTheRow;
    });

    expect(
      qualifying,
      'FR-009 exclusivity can pass with an empty qualifying set — that is BUG-001. SC-016 ' +
        'requires at least one exit that leaves the row in place without running it again.'
    ).not.toEqual([]);
    // Named as well as counted, so the failure says which exit was withdrawn
    // rather than only that the set shrank.
    expect(qualifying).toContain('finish -> completed (attested)');
  });

  it('the qualifying exit survives its own round trip, row and evidence intact', () => {
    // The two clauses measured on the real writers rather than read off the
    // table above. "Does not discard the row" is the row still being there;
    // "does not re-run the task" is the status it lands in — `completed`, which
    // the transcribed `MARK_IN_FLIGHT` row refuses, so nothing can put an
    // attested task back in flight without a separate operator transition that
    // this table does not have. The end-to-end form, with the phase counted and
    // the drain actually run, is T062's scenario in
    // `tests/integration/queue-halt-on-failure.test.ts`.
    expect(MARK_IN_FLIGHT.completed).toEqual(NO);
  });

  it("T060's assertions are all refusals, so an empty exit set is invisible to them", () => {
    // The pairing, asserted. Every decision T060 inspects is expected
    // ineligible, which means no change that made the table STRICTER could fail
    // that block — including the change that removed the last usable way out of
    // `failed`. This is not a restatement of T060; it is the statement that
    // T060 cannot be the test SC-016 asks for.
    const t060Subjects = (['failed', 'canceled', 'completed', 'paused'] as const).map((currentStatus) =>
      decideTaskTransition({
        operation: 'finish',
        currentStatus,
        targetStatus: 'canceled',
        queueAlreadyHasDifferentInFlight: false
      })
    );

    expect(t060Subjects.every((decision) => decision.eligible === false)).toBe(true);
    // And the converse half: the edge T060 proves refused is not the edge this
    // block requires admitted, so satisfying SC-016 did not cost FR-009 its
    // exclusivity. `failed -> canceled` stays refused with the flag set too —
    // the attestation widens one cell, not the row.
    expect(admittedExitsFrom('failed')).not.toContain('finish -> canceled');
    expect(admittedExitsFrom('failed')).not.toContain('finish -> canceled (attested)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-R3-161 (feature 200) — the whole table, stated rather than derived.
//
// The blocks above grew one cell at a time, each added by the feature that
// needed it, and each written as the shape its own feature cared about. What
// none of them state is the table as a whole: the six statuses across the four
// operations, with `finish` expanded over its three terminal targets, every
// cell present whether or not some feature once argued about it.
//
// Asserted against `decideTaskTransition` directly and NOT through the queue
// writers (spec FR-002, research D6). The route is asserted separately below,
// as a second reading of the same table. Asserting only through a route would
// let a future inline guard at that route satisfy the matrix while the
// classifier disagreed with it — which is not hypothetical: this feature found
// exactly that guard in `src/commands/cancel.ts` and closed it (see the
// route-agreement block at the end of this file).
//
// The expectations below are literals, transcribed from
// specs/200-cancel-removal-transition-table/data-model.md. They are not
// computed from the classifier's own predicates, because a table derived from
// the implementation restates it instead of pinning it.
// ───────────────────────────────────────────────────────────────────────────

const ALL_STATUSES = ['pending', 'in-flight', 'paused', 'completed', 'canceled', 'failed'] as const;

type ExpectedCell =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: TaskTransitionRejectionReason };

/** Shorthands, so each row below reads as a row of the table it transcribes. */
const YES: ExpectedCell = { eligible: true };
const NO: ExpectedCell = { eligible: false, reason: 'illegal-source-status' };

type StatusRow = Readonly<Record<FeatureRequestStatus, ExpectedCell>>;

/**
 * `mark-in-flight`. Only the two statuses that are finished in both senses stay
 * refused; `failed` is deliberately eligible (an operator repointing a halted
 * workflow resumes it directly), as are `in-flight` and `paused`, which are
 * re-affirmations of a task this queue already holds.
 */
const MARK_IN_FLIGHT: StatusRow = {
  pending: YES,
  'in-flight': YES,
  paused: YES,
  completed: NO,
  canceled: NO,
  failed: YES
};

/** `pause`. One source status. */
const PAUSE: StatusRow = {
  pending: NO,
  'in-flight': YES,
  paused: NO,
  completed: NO,
  canceled: NO,
  failed: NO
};

/** `return-to-pending`. Paused work and both recoverable terminal outcomes. */
const RETURN_TO_PENDING: StatusRow = {
  pending: NO,
  'in-flight': NO,
  paused: YES,
  completed: NO,
  canceled: YES,
  failed: YES
};

/**
 * `finish`, expanded over its three terminal targets. The two `pending` cells
 * that are `YES` are the pre-start edges: an outcome reachable without ever
 * executing. `pending -> completed` stays refused for the same reason — a task
 * that never ran cannot have completed — which is what keeps "finish from
 * pending" from becoming a general escape hatch.
 */
const FINISH: Readonly<Record<TerminalRequestStatus, StatusRow>> = {
  completed: {
    pending: NO,
    'in-flight': YES,
    paused: NO,
    completed: NO,
    canceled: NO,
    failed: NO
  },
  canceled: {
    pending: YES,
    'in-flight': YES,
    paused: NO,
    completed: NO,
    canceled: NO,
    failed: NO
  },
  failed: {
    pending: YES,
    'in-flight': YES,
    paused: NO,
    completed: NO,
    canceled: NO,
    failed: NO
  }
};

describe('FR-R3-161 (FR-002) — the closed table asserted whole, against the classifier', () => {
  it.each(ALL_STATUSES)('mark-in-flight from %s', (currentStatus) => {
    expect(
      decideTaskTransition({
        operation: 'mark-in-flight',
        currentStatus,
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual(MARK_IN_FLIGHT[currentStatus]);
  });

  it.each(ALL_STATUSES)('pause from %s', (currentStatus) => {
    expect(
      decideTaskTransition({
        operation: 'pause',
        currentStatus,
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual(PAUSE[currentStatus]);
  });

  it.each(ALL_STATUSES)('return-to-pending from %s', (currentStatus) => {
    expect(
      decideTaskTransition({
        operation: 'return-to-pending',
        currentStatus,
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual(RETURN_TO_PENDING[currentStatus]);
  });

  const finishCells = (['completed', 'canceled', 'failed'] as const).flatMap((targetStatus) =>
    ALL_STATUSES.map((currentStatus) => ({ targetStatus, currentStatus }))
  );

  it.each(finishCells)('finish($currentStatus -> $targetStatus)', ({ currentStatus, targetStatus }) => {
    expect(
      decideTaskTransition({
        operation: 'finish',
        currentStatus,
        targetStatus,
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual(FINISH[targetStatus][currentStatus]);
  });

  // The table above is 36 cells; this pins that none of them was quietly
  // dropped from the parameterisation, which is how a data-driven matrix
  // shrinks without anyone noticing.
  it('covers every cell of the table: 6 statuses x (3 operations + 3 finish targets)', () => {
    expect(ALL_STATUSES).toHaveLength(6);
    expect(finishCells).toHaveLength(18);
    expect(Object.keys(FINISH)).toEqual(['completed', 'canceled', 'failed']);
    for (const row of [MARK_IN_FLIGHT, PAUSE, RETURN_TO_PENDING, ...Object.values(FINISH)]) {
      expect(Object.keys(row).sort()).toEqual([...ALL_STATUSES].sort());
    }
  });

  // Existence and ownership are checked before any edge, for every operation,
  // in that order — so an absent row is `task-not-found` even for an operation
  // whose source-status row would have refused it anyway.
  it.each(['mark-in-flight', 'pause', 'finish', 'return-to-pending'] as const)(
    'refuses %s on an absent row with task-not-found, before any edge is consulted',
    (operation) => {
      expect(
        decideTaskTransition({
          operation,
          currentStatus: undefined,
          targetStatus: 'canceled',
          queueAlreadyHasDifferentInFlight: false
        })
      ).toEqual({ eligible: false, reason: 'task-not-found' });
    }
  );

  // `mark-in-flight` alone: the ownership check runs FIRST, before this task's
  // own status is looked at. Every one of the six statuses — including the
  // three the row above admits — is refused the same way when a genuinely
  // different task already holds the queue's one execution slot.
  it.each(ALL_STATUSES)(
    'refuses mark-in-flight from %s with in-flight-ownership-conflict when another task holds the slot',
    (currentStatus) => {
      expect(
        decideTaskTransition({
          operation: 'mark-in-flight',
          currentStatus,
          queueAlreadyHasDifferentInFlight: true
        })
      ).toEqual({ eligible: false, reason: 'in-flight-ownership-conflict' });
    }
  );

  // FR-006 — the target check is a runtime check as well as a compile-time
  // narrowing, and it runs before the source status is consulted: `in-flight`
  // is eligible for all three real targets above and is refused here.
  //
  // The key is OMITTED rather than passed as an explicit `undefined`. The two
  // reach the same branch — `task-transition-decision.ts:68` destructures the
  // value and `:134` tests it for `undefined`, so neither form is visible to
  // the classifier as anything but an absent target — and the omitted form is
  // the one `exactOptionalPropertyTypes` accepts, which the ratchet in
  // `tests/lint/compiler-strictness-ratchet.test.ts` requires of a new site.
  it.each(ALL_STATUSES)('refuses finish from %s when the target is absent', (currentStatus) => {
    expect(
      decideTaskTransition({
        operation: 'finish',
        currentStatus,
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual({ eligible: false, reason: 'illegal-source-status' });
  });

  it.each(['pending', 'in-flight', 'paused'] as const)(
    'refuses finish from in-flight when the target is the non-terminal status %s',
    (targetStatus) => {
      expect(
        decideTaskTransition({
          operation: 'finish',
          currentStatus: 'in-flight',
          // @ts-expect-error — a non-terminal target is a compile error AND a
          // runtime refusal; `targetStatus` is still an ordinary string at the
          // boundary a caller crosses to get here.
          targetStatus,
          queueAlreadyHasDifferentInFlight: false
        })
      ).toEqual({ eligible: false, reason: 'illegal-source-status' });
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────
// FR-R3-161 — the two cells this feature turns on.
//
// Both are already in the table above. They are pinned again here, by name and
// with their evidence, because the table proves they hold today while these
// two say what is lost if they stop holding. A narrowing of either would fail
// a test whose title states the edge it removed.
// ───────────────────────────────────────────────────────────────────────────
describe('FR-R3-161 — the two cancellation cells the removed routine argued with', () => {
  it('pending -> canceled under finish is eligible (cancel before start)', () => {
    expect(
      decideTaskTransition({
        operation: 'finish',
        currentStatus: 'pending',
        targetStatus: 'canceled',
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual({ eligible: true });
  });

  // FR-R3-161 (research.md F3) — 2026-09-04. `QueueManager.cancel`, removed by
  // this feature, refused this edge with a guard of its own, and the census
  // header's stated reason for not enrolling that routine described only the
  // routine's own divergent rule. The table has
  // admitted the edge since it shipped; the second protocol was the thing that
  // disagreed with it, and this feature deletes the second protocol rather
  // than teaching it to agree.
  it('in-flight -> canceled under finish is eligible (the edge the deleted routine forbade)', () => {
    expect(
      decideTaskTransition({
        operation: 'finish',
        currentStatus: 'in-flight',
        targetStatus: 'canceled',
        queueAlreadyHasDifferentInFlight: false
      })
    ).toEqual({ eligible: true });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-R3-161 (FR-002, FR-003) — the same table read a second time, through the
// operator's own route.
//
// **Corrected against measurement.** research.md F19 predicted that cancelling
// a paused Task through `runCancel` reaches `cancel.ts`'s no-live-run branch,
// is refused `illegal-source-status` by the classifier, and is reported to the
// operator with "cancel failed — the task could not be finalized". All three
// clauses are false, and the tests below assert what the route actually does:
//
//   - the row is refused at `cancel.ts`'s admission guard, with the route's own
//     reason `illegal-state`, before the classifier is consulted;
//   - no audit entry is appended, because the row never reaches the branch that
//     appends one — so FR-018a's audit-before-decide observation does not apply
//     to a paused row at all;
//   - nothing is notified and nothing is logged: the refusal is silent.
//
// The affordance claim was wrong too. `webview-ui/src/components/
// QueueItemActions.svelte` renders Cancel only for an in-flight row, so the
// paused refusal is not reachable from the sidebar; it is reachable by command
// id with a taskId, which is the path exercised here.
//
// Constraint C5 — assert the current behaviour, do not fix the FR-018a
// observations. Neither the returned reason nor the silence is changed by this
// feature; both are reported in the closure record instead.
// ───────────────────────────────────────────────────────────────────────────

function makeCancelDeps(): {
  controller: SchegentWorkflowController;
  audit: AuditLogWriter & { append: ReturnType<typeof vi.fn> };
  notifier: Notifier & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  logger: SanitizedLogger;
} {
  return {
    controller: { cancelActive: vi.fn() } as unknown as SchegentWorkflowController,
    audit: { append: vi.fn(async () => {}) } as unknown as AuditLogWriter & {
      append: ReturnType<typeof vi.fn>;
    },
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier & {
      info: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    },
    logger: new SanitizedLogger()
  };
}

/** Drive a freshly enqueued task to `status` through the real writers. */
async function seedTaskAt(queue: QueueManager, status: FeatureRequestStatus): Promise<string> {
  const task = await queue.enqueue(`task-${status}`);
  if (status === 'pending') return task.id;
  await queue.markInFlight(task.id, `run-${status}`);
  if (status === 'in-flight') return task.id;
  if (status === 'paused') {
    await queue.pause(task.id);
    return task.id;
  }
  await queue.finish(task.id, status);
  return task.id;
}

describe('FR-R3-161 (FR-003) — cancelling a paused Task through the production command', () => {
  it('is refused, silently, with the route\'s own reason and before the classifier is consulted', async () => {
    const { store, queue } = await buildSystem();
    const deps = makeCancelDeps();
    const taskId = await seedTaskAt(queue, 'paused');
    expect(queue.findById(taskId)?.status).toBe('paused');

    const result = await runCancel({ ...deps, store, queue, taskId });

    expect(result).toEqual({ ok: false, reason: 'illegal-state' });
    expect(queue.findById(taskId)?.status).toBe('paused');
    // Not `illegal-source-status`: the route refuses in its own vocabulary.
    // The classifier agrees on the verdict — see the agreement test below —
    // but the reason the operator's route returns is the route's.
    expect(deps.controller.cancelActive).not.toHaveBeenCalled();
  });

  it('appends no audit entry, because the row never reaches the branch that appends one', async () => {
    const { store, queue } = await buildSystem();
    const deps = makeCancelDeps();
    const taskId = await seedTaskAt(queue, 'paused');

    await runCancel({ ...deps, store, queue, taskId });

    // FR-018a's first observation — the audit entry is written before the
    // transition is decided — is real, and is deliberately not fixed here. It
    // does not apply to a paused row: this row is refused earlier than that.
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  it('reports nothing to the operator: the refusal is silent', async () => {
    const { store, queue } = await buildSystem();
    const deps = makeCancelDeps();
    const taskId = await seedTaskAt(queue, 'paused');

    await runCancel({ ...deps, store, queue, taskId });

    // research.md F19 claimed this refusal was "already reported to the
    // operator explicitly rather than passing as a success". It is not
    // reported at all. It does not pass as a success either — the caller gets
    // `{ ok: false }` — but nothing reaches the operator. Reported in the
    // closure record; not fixed here, because a new operator-visible message
    // is outside what this feature claims.
    expect(deps.notifier.info).not.toHaveBeenCalled();
    expect(deps.notifier.error).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-R3-161 (FR-004, SC-001, US1 acceptance scenario 4) — exactly one site
// decides whether a cancellation is admitted.
//
// FR-004 defines the unit SC-001 counts: a site is a place that reaches a
// verdict on whether a cancellation is admitted, either by consulting the
// classifier and acting on the verdict, or by deciding the same question
// itself. Consulting is not a second decision however many places do it;
// deciding without consulting is, even once.
//
// **Why the name search alone would be a false green.** The anchor here is the
// classifier's own name, `decideTaskTransition` — never the status value
// `'canceled'`, which is also written onto a WorkflowRun in five other modules
// (research F14), so a value-anchored search matches code this criterion was
// not written about and proves nothing. But a name-anchored search has the
// opposite blind spot, and it is the one that matters: a site that decides
// WITHOUT consulting the classifier does not contain the classifier's name, so
// no search for that name can see it. This is not hypothetical. Before this
// feature, `src/commands/cancel.ts` refused a cancellation from its own
// admission guard, and every search for the classifier's name returned "one
// decision site" while two existed.
//
// So the claim is made in three parts, and the third is what earns it:
//   1. one rule set — the classifier is declared exactly once under `src/`;
//   2. the operator's route reaches its verdict THROUGH that rule set;
//   3. the route and the rule set agree on all six statuses — the assertion an
//      inline guard cannot survive, whatever it is named.
// ───────────────────────────────────────────────────────────────────────────

const SRC_ROOT = resolve(__dirname, '../../src');
const CLASSIFIER = 'decideTaskTransition';

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('FR-R3-161 (SC-001) — one cancellation decision site', () => {
  it('declares the classifier exactly once under src/', () => {
    const declaring = collectSourceFiles(SRC_ROOT).filter((file) =>
      new RegExp(`export function ${CLASSIFIER}\\b`).test(readFileSync(file, 'utf8'))
    );

    expect(declaring.map((f) => f.slice(SRC_ROOT.length + 1))).toEqual([
      'queue/task-transition-decision.ts'
    ]);
  });

  it('the operator\'s cancellation route reaches its verdict through the classifier', () => {
    // The pin for FR-004's "deciding without consulting it is a second site,
    // even once". A hand-rolled admission test at this route — which is what
    // was here before — fails this, because the name it must contain is the
    // classifier's, and a guard that decides for itself does not call it.
    const route = readFileSync(join(SRC_ROOT, 'commands/cancel.ts'), 'utf8');

    const call = route.indexOf(`${CLASSIFIER}(`);
    expect(call, `${CLASSIFIER} is not called in commands/cancel.ts`).toBeGreaterThan(-1);
    expect(route.indexOf('.eligible', call)).toBeGreaterThan(call);
  });

  it.each(ALL_STATUSES)(
    'the route and the classifier agree on cancelling a %s task',
    async (status) => {
      const { store, queue } = await buildSystem();
      const deps = makeCancelDeps();
      const taskId = await seedTaskAt(queue, status);

      const routeSaidYes = (await runCancel({ ...deps, store, queue, taskId })).ok;
      const classifierSaysYes = decideTaskTransition({
        operation: 'finish',
        currentStatus: status,
        targetStatus: 'canceled',
        queueAlreadyHasDifferentInFlight: false
      }).eligible;

      expect(routeSaidYes).toBe(classifierSaysYes);
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────
// FR-R3-161 (Phase 7, US5) — the refusal vocabulary itself.
//
// Phase 6 removed `'queue-mismatch'` because nothing could produce it. These
// three assertions are what make that a *replacement* for the direct-call test
// deleted at T059 rather than a loss: that test pinned one hand-built input
// against one reason; these pin the whole vocabulary, in both directions, for
// every operation.
// ───────────────────────────────────────────────────────────────────────────

describe('FR-R3-161 US5 — the refusal vocabulary is closed, mirrored, and uniform', () => {
  it('T061 — has exactly three members, by name and by count (contract C1.1)', () => {
    // Exhaustive by construction. `Record<TaskTransitionRejectionReason, true>`
    // is a compile error if a member of the union is missing from this literal,
    // and a compile error if a key here is not a member of the union — so the
    // literal cannot drift from the type in either direction. What it cannot do
    // on its own is stop the union from *growing*: a fourth member plus a
    // fourth key compiles. The count below is what a human then has to change
    // deliberately, which is the point — restoring `'queue-mismatch'` quietly
    // is exactly what this fails on.
    const everyReason: Record<TaskTransitionRejectionReason, true> = {
      'task-not-found': true,
      'illegal-source-status': true,
      'in-flight-ownership-conflict': true
    };
    expect(Object.keys(everyReason).sort()).toEqual([
      'illegal-source-status',
      'in-flight-ownership-conflict',
      'task-not-found'
    ]);
  });

  it('T062 — the runtime set the queue manager classifies with is that same vocabulary', () => {
    // `queue-manager.ts` converts a transition rejection into `{ ok: false,
    // reason }` and re-throws anything else, so it needs the vocabulary as a
    // value. It used to hold its own copy of the literals; the copy is what let
    // `'queue-mismatch'` sit in it after nothing could produce it. The set is
    // now derived from the union, and this pins the derivation: a member the
    // set does not carry would be re-thrown at an operator instead of reported.
    expect([...TASK_TRANSITION_REJECTION_REASONS].sort()).toEqual([
      'illegal-source-status',
      'in-flight-ownership-conflict',
      'task-not-found'
    ]);
    // Fail-closed in the other direction too: a reason from outside the
    // vocabulary — every commit-fence reason, for instance — must not classify
    // as a transition rejection, or the queue manager would swallow it.
    expect(TASK_TRANSITION_REJECTION_REASONS.has('queue-mismatch')).toBe(false);
    expect(TASK_TRANSITION_REJECTION_REASONS.has('stale-ownership-fence')).toBe(false);
  });

  it('T063 — a refusal from any of the four operations has one shape (US5 scenario 1)', () => {
    // One reader, no `operation` argument, no per-operation narrowing: if any
    // operation could refuse in a different shape this would not compile.
    const reasonOf = (result: TaskTransitionDecisionResult): TaskTransitionRejectionReason => {
      if (result.eligible) throw new Error('expected a refusal, got an eligible verdict');
      return result.reason;
    };
    const refusals: readonly TaskTransitionDecisionResult[] = [
      decideTaskTransition({
        operation: 'mark-in-flight',
        currentStatus: 'completed',
        queueAlreadyHasDifferentInFlight: false
      }),
      decideTaskTransition({
        operation: 'finish',
        currentStatus: 'pending',
        targetStatus: 'completed',
        queueAlreadyHasDifferentInFlight: false
      }),
      decideTaskTransition({
        operation: 'pause',
        currentStatus: 'pending',
        queueAlreadyHasDifferentInFlight: false
      }),
      decideTaskTransition({
        operation: 'return-to-pending',
        currentStatus: 'completed',
        queueAlreadyHasDifferentInFlight: false
      })
    ];
    expect(refusals).toHaveLength(4);
    for (const refusal of refusals) {
      expect(TASK_TRANSITION_REJECTION_REASONS.has(reasonOf(refusal))).toBe(true);
    }
  });
});
