// FR-R3-157 (T042, FR-011b, contract C4.10) — how a Task row learns it is
// degraded, and the one case where reading the live run would be wrong.
//
// TWO SOURCES, IN ORDER: the value captured onto the task record when its run
// ended, then — only for a task still in flight — the live run's list, so an
// operator watching a long run sees the mark appear at the moment the phase is
// let through rather than minutes later when the task finishes.
//
// The case that makes this more than a fallback chain is the second test. A
// terminal task with no capture is NOT degraded, even when the queue still
// happens to be holding its run. Reading the run there would make the answer
// depend on queue timing: the same finished task would read degraded while its
// run survived and clean the instant the next task started, which is the defect
// feature 198 was raised to end, restated for this field (research.md D5).
//
// C4.10 also says "no status branch", which sits next to its own requirement
// that a terminal task not consult the run — literally, the two cannot both be
// absolute. The reading taken here, and the reason it is not a dodge: the
// prohibition is FR-002's, against giving any status its own ARITHMETIC, and no
// status gets any here — the value is a verbatim list from one of two records in
// both branches, never recomputed and never derived differently. What separates
// the branches is the projector's existing `isInFlight` predicate, the queue's
// single routing decision already computed once per row for `currentPhase` and
// `pauseCause`. This feature introduces no new branch; it reuses the one the
// queue already made.

import { describe, expect, it } from 'vitest';
import type { DegradedPhaseEntry } from '../../../../src/contracts/snapshot-projections';
import type { FeatureRequest, QueueState } from '../../../../src/queue/feature-request';
import {
  projectQueue,
  type QueueProjectionContext
} from '../../../../src/ui/sidebar/queue-projector';
import type { QueueItem } from '../../../../src/ui/sidebar/snapshot';

const AUDIT: DegradedPhaseEntry = { phaseId: 'audit', condition: 'open_questions > 0' };
const VERIFY: DegradedPhaseEntry = { phaseId: 'verify', condition: 'coverage < 80' };

/** Every status a row can be projected in, so no case is reached by accident. */
const TERMINAL = ['completed', 'failed', 'canceled'] as const;

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

function ctxWith(overrides: Partial<QueueProjectionContext> = {}): QueueProjectionContext {
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

describe('FR-R3-157 (T042) — the projector resolves a task row from two sources', () => {
  it('source 1: reports the value captured when the run ended (FR-011a)', () => {
    for (const status of TERMINAL) {
      const finished = task({ id: 'captured', status, degradedPhases: [AUDIT, VERIFY] });
      const row = rowFor(queueOf(finished), ctxWith(), 'captured');

      // The order is the order the phases degraded in, carried through unchanged.
      expect(row.degradedPhases, `status ${status}`).toEqual([AUDIT, VERIFY]);
    }
  });

  it('source 1 wins over a live run that says something else', () => {
    // Precedence, and the reason the row is stable rather than alternating. The
    // captured value is what this attempt actually did; a run still in the store
    // is at best the same thing and at worst a later attempt's.
    const finished = task({ id: 'captured', status: 'failed', degradedPhases: [AUDIT] });
    const row = rowFor(
      queueOf(finished),
      ctxWith({ activeRunTaskId: 'captured', liveRunDegradedPhases: [VERIFY] }),
      'captured'
    );

    expect(row.degradedPhases).toEqual([AUDIT]);
  });

  it('a terminal task with no capture is not degraded, even with its run still held (C4.10)', () => {
    // THE TEST THIS TASK EXISTS FOR. Runs are disposed when the next task starts,
    // so whether a finished task's run is still in the store is a fact about queue
    // timing, not about the task. A row that consulted it would answer differently
    // before and after an unrelated task began.
    for (const status of TERMINAL) {
      const finished = task({ id: 'no-capture', status });
      const row = rowFor(
        queueOf(finished),
        ctxWith({ activeRunTaskId: 'no-capture', liveRunDegradedPhases: [AUDIT] }),
        'no-capture'
      );

      expect(row, `status ${status}`).not.toHaveProperty('degradedPhases');
    }
  });

  it('source 2: an in-flight task reports what its run has accumulated so far (FR-011b)', () => {
    // The live half. Without it a long run that degraded in its second phase would
    // show nothing until it finished, which is the whole window in which an
    // operator could still intervene.
    const running = task({ id: 'live', status: 'in-flight' });
    const row = rowFor(
      queueOf(running),
      ctxWith({
        inFlightId: 'live',
        activeRunTaskId: 'live',
        liveRunDegradedPhases: [AUDIT]
      }),
      'live'
    );

    expect(row.degradedPhases).toEqual([AUDIT]);
  });

  it('does not lend the live run to a task that does not own it', () => {
    // Two rows, one run. A resolution keyed only on "is there a run" would mark
    // every in-flight row in the queue with whatever the held run had done.
    const running = task({ id: 'owner', status: 'in-flight' });
    const other = task({ id: 'bystander', status: 'pending' });
    const ctx = ctxWith({
      inFlightId: 'owner',
      activeRunTaskId: 'owner',
      liveRunDegradedPhases: [AUDIT]
    });
    const queue = queueOf(running, other);

    expect(rowFor(queue, ctx, 'owner').degradedPhases).toEqual([AUDIT]);
    expect(rowFor(queue, ctx, 'bystander')).not.toHaveProperty('degradedPhases');
  });

  it('writes no key for a clean task, on any status (C3.6)', () => {
    // Absence means not degraded, so the clean case must produce no key at all —
    // not an empty list. A projector that wrote `[]` would put the key on every
    // row the product has, from which point the absent case cannot be tested.
    for (const status of ['pending', 'in-flight', 'paused', ...TERMINAL] as const) {
      const clean = task({ id: 'clean', status });
      const row = rowFor(
        queueOf(clean),
        ctxWith({ inFlightId: status === 'in-flight' ? 'clean' : null }),
        'clean'
      );

      expect(row, `status ${status}`).not.toHaveProperty('degradedPhases');
    }
  });

  it('projects nothing when the host supplies no run wiring at all', () => {
    // A caller with no degradation context resolves nothing rather than
    // fabricating a clean answer it cannot vouch for — same posture the
    // settled-phase chain takes for its own missing readings.
    const running = task({ id: 'live', status: 'in-flight' });
    const row = rowFor(queueOf(running), ctxWith({ inFlightId: 'live' }), 'live');

    expect(row).not.toHaveProperty('degradedPhases');
  });
});
