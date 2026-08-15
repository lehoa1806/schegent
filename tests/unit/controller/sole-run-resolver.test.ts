// Feature 093 (T035/T036/T038) — the resolver that decides which Run a control
// that did not name one is talking about.
//
// The `resolveControlTarget` half was found wrong in the cumulative 093–095
// review and is the reason this file exists. It resolved with the default
// `() => true` predicate, so it counted every entry in the run record — and
// terminal Runs stay in that record. `setRun(queueId, null)` is called from
// exactly one place, `clearAll`; an ordinary completion writes the terminal
// status back so the finished pipeline still renders. Under the pre-093 single
// slot that was invisible, because there was only ever one entry. Under a map, a
// queue that has *ever* finished a Task keeps its entry forever, so:
//
//   queue A completed last week + queue B running now
//     → two entries → `ambiguous-run-target`
//
// and every palette phase control refused, permanently, in any workspace where a
// second queue had ever run. `activation/ui-wiring.ts` states the intended rule
// in its own comment — refuse "when N are in flight" — which is what
// `isOperableRunStatus` now makes true.
//
// The first repair used `!isTerminalRunStatus` and was wrong, which is why the
// `failed` cases below are asserted as loudly as the excluded ones. `failed` is
// terminal — its lease and session are released — but it is emphatically still
// operable: `skipPhase` advances past the failed phase and retry re-admits it.
// Three suites caught it (`workflow-controller-skip-phase`, `retry-phase-now`,
// and the lint), and the two predicates now sit side by side in `workflow-run.ts`
// with the distinction spelled out.
//
// `resolveSoleRun` itself was correct and is pinned here too, because the fix
// is a predicate passed to it and a regression in either half reads the same
// from the outside.

import { describe, it, expect } from 'vitest';

import { resolveControlTarget, resolveSoleRun } from '../../../src/controller/sole-run-resolver';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
import { buildWorkflowRun } from '../../fixtures/state/queue-fixtures';

const QUEUE_A = 'queue-a';
const QUEUE_B = 'queue-b';

const runWith = (id: string, status: WorkflowRunStatus): WorkflowRun =>
  buildWorkflowRun({ id, featureId: `task-${id}`, status });

/** Finished in both senses: nothing an operator control can do with one. */
const UNCONTROLLABLE: readonly WorkflowRunStatus[] = ['completed', 'canceled'];
/** Still reachable by a control — `failed` included, which is the correction. */
const OPERABLE: readonly WorkflowRunStatus[] = ['running', 'paused', 'failed'];

describe('resolveSoleRun', () => {
  it('refuses when nothing matches rather than returning a Run', () => {
    expect(resolveSoleRun({})).toEqual({ ok: false, reason: 'no-run-in-flight' });
  });

  it('answers the queue alongside the Run, so the caller writes back where it read', () => {
    const run = runWith('r1', 'running');

    expect(resolveSoleRun({ [QUEUE_B]: run })).toEqual({ ok: true, queueId: QUEUE_B, run });
  });

  it('refuses rather than picking when several match', () => {
    const runs = { [QUEUE_A]: runWith('r1', 'running'), [QUEUE_B]: runWith('r2', 'running') };

    expect(resolveSoleRun(runs)).toEqual({ ok: false, reason: 'ambiguous-run-target' });
  });

  it('narrows to the unique match when a predicate disambiguates', () => {
    const paused = runWith('r2', 'paused');
    const runs = { [QUEUE_A]: runWith('r1', 'running'), [QUEUE_B]: paused };

    expect(resolveSoleRun(runs, (r) => r.status === 'paused')).toEqual({
      ok: true,
      queueId: QUEUE_B,
      run: paused
    });
  });
});

describe('resolveControlTarget', () => {
  it('takes an explicit queue at its word without consulting the record', () => {
    // The sidebar always addresses its control. An explicit id must not be
    // second-guessed against a record that may not yet show the Run.
    expect(resolveControlTarget(QUEUE_A, {})).toEqual({ ok: true, queueId: QUEUE_A });
  });

  it('resolves the sole live Run when the palette names no queue', () => {
    const runs = { [QUEUE_B]: runWith('r1', 'running') };

    expect(resolveControlTarget(undefined, runs)).toEqual({ ok: true, queueId: QUEUE_B });
  });

  it('refuses when two Runs are genuinely in flight', () => {
    const runs = { [QUEUE_A]: runWith('r1', 'running'), [QUEUE_B]: runWith('r2', 'running') };

    expect(resolveControlTarget(undefined, runs)).toEqual({
      ok: false,
      reason: 'ambiguous-run-target'
    });
  });

  // The defect, one case per uncontrollable status: a finished Run is history,
  // not a second target. Before the fix each of these resolved
  // `ambiguous-run-target` and the palette control was unusable.
  for (const status of UNCONTROLLABLE) {
    it(`ignores a ${status} Run on another queue and resolves the live one`, () => {
      const runs = { [QUEUE_A]: runWith('old', status), [QUEUE_B]: runWith('live', 'running') };

      expect(resolveControlTarget(undefined, runs)).toEqual({ ok: true, queueId: QUEUE_B });
    });

    it(`reports nothing in flight when only a ${status} Run remains`, () => {
      const runs = { [QUEUE_A]: runWith('old', status) };

      // Previously `{ ok: true, queueId: QUEUE_A }` — the control was handed a
      // finished Run and had to fail deeper in, with a worse message.
      expect(resolveControlTarget(undefined, runs)).toEqual({
        ok: false,
        reason: 'no-run-in-flight'
      });
    });
  }

  it('ignores any number of uncontrollable Runs', () => {
    const runs = {
      'queue-1': runWith('r1', 'completed'),
      'queue-2': runWith('r2', 'canceled'),
      'queue-3': runWith('r3', 'completed'),
      'queue-4': runWith('r4', 'paused')
    };

    expect(resolveControlTarget(undefined, runs)).toEqual({ ok: true, queueId: 'queue-4' });
  });

  // A paused Run keeps its session, its lease and its cap slot, and is exactly
  // what an unaddressed resume means to act on. `failed` is here for a different
  // reason and is the correction to the first repair: it *is* terminal, its
  // lease and session are released, and it is still what skip and retry target.
  for (const status of OPERABLE) {
    it(`treats a ${status} Run as a live control target`, () => {
      const runs = { [QUEUE_A]: runWith('r1', status) };

      expect(resolveControlTarget(undefined, runs)).toEqual({ ok: true, queueId: QUEUE_A });
    });
  }

  it('refuses when a failed Run competes with a live one — both are operable', () => {
    const runs = { [QUEUE_A]: runWith('r1', 'failed'), [QUEUE_B]: runWith('r2', 'running') };

    expect(resolveControlTarget(undefined, runs)).toEqual({
      ok: false,
      reason: 'ambiguous-run-target'
    });
  });

  it('still refuses when two paused Runs compete', () => {
    const runs = { [QUEUE_A]: runWith('r1', 'paused'), [QUEUE_B]: runWith('r2', 'paused') };

    expect(resolveControlTarget(undefined, runs)).toEqual({
      ok: false,
      reason: 'ambiguous-run-target'
    });
  });
});
