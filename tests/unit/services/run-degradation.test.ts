// FR-R3-157 (T032, contract C3.6) — the spreadable patch that carries a Run's
// degraded marks onto the Task record.
//
// WHY THE ABSENT CASE IS THE SUBJECT. The patch is spread into the same object
// literal that writes a task's terminal status, so what it returns for a run that
// degraded nowhere is written onto every task that ever finishes cleanly. Three
// shapes are indistinguishable at the call site and completely different in the
// store:
//
//   {}                          — no key. What a clean task must get.
//   { degradedPhases: [] }      — an empty list on every clean task, forever.
//   { degradedPhases: undefined } — a key whose value is undefined, which a
//                                 spread-based writer produces by accident and
//                                 which `JSON.stringify` then drops on write and
//                                 not on comparison.
//
// `snapshot-projections.ts:365-370` states that an empty list and an absent field
// mean the same thing to a reader, and that is true — but only the third of these
// shapes keeps the ABSENT case testable at all, and only it leaves a pre-feature
// record byte-identical on a re-persist (the no-schema-bump argument, D-I3). So
// these tests assert on the KEY's presence, via `Object.keys`, not on the value.
import { describe, expect, it } from 'vitest';

import { degradationPatch } from '../../../src/services/run-degradation';
import type { DegradedPhaseEntry } from '../../../src/contracts/snapshot-projections';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const ENTRY: DegradedPhaseEntry = { phaseId: 'audit', condition: 'open_questions > 0' };
const SECOND: DegradedPhaseEntry = { phaseId: 'verify', condition: 'coverage < 80' };

/** A Run carrying nothing but the field under test. */
const runWith = (degradedPhases?: readonly DegradedPhaseEntry[]): WorkflowRun =>
  ({ id: 'run-1', ...(degradedPhases === undefined ? {} : { degradedPhases }) }) as WorkflowRun;

describe('degradationPatch (FR-R3-157, C3.6)', () => {
  it('carries a non-empty list through unchanged', () => {
    const patch = degradationPatch(runWith([ENTRY, SECOND]));
    expect(patch).toEqual({ degradedPhases: [ENTRY, SECOND] });
    // Order is the record of what happened, so it is asserted rather than assumed.
    expect(patch.degradedPhases?.map((e) => e.phaseId)).toEqual(['audit', 'verify']);
  });

  it('writes NO KEY for a run that degraded nowhere', () => {
    // Each of these is a different way to be "not degraded", and all three must
    // produce the same patch — an empty object. Asserting `toEqual({})` alone
    // would pass for `{ degradedPhases: undefined }`, which is why the key list
    // is asserted too.
    for (const [label, run] of [
      ['an empty list', runWith([])],
      ['an absent field', runWith(undefined)]
    ] as const) {
      const patch = degradationPatch(run);
      expect(patch, label).toEqual({});
      expect(Object.keys(patch), `${label} must not put the key on the record`).toEqual([]);
    }
  });

  it('writes NO KEY for no run at all', () => {
    // `null` is the ordinary case at the call site, not an error: a task can reach
    // a terminal status with its Run already gone.
    for (const run of [null, undefined] as const) {
      const patch = degradationPatch(run);
      expect(patch).toEqual({});
      expect(Object.keys(patch)).toEqual([]);
    }
  });

  it('is spreadable into a literal without disturbing what is already there', () => {
    // The shape the call site actually uses. A patch that returned an explicit
    // `undefined` would overwrite a sibling key of the same name on spread; this
    // is the assertion that catches that, and it cannot be made about the return
    // value in isolation.
    const clean = { status: 'failed', ...degradationPatch(runWith([])) };
    expect(Object.keys(clean)).toEqual(['status']);

    const degraded = { status: 'failed', ...degradationPatch(runWith([ENTRY])) };
    expect(degraded).toEqual({ status: 'failed', degradedPhases: [ENTRY] });
  });
});
