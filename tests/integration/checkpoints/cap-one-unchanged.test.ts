// FR-R3-004 (T319) — at a concurrency cap of one, checkpoint behaviour is
// unchanged.
//
// The requirement says "byte-for-byte", and the literal reading is the one that
// matters: with a single Run in flight the service writes the whole-tree diff and
// does not consult the ledger at all. That is a property of the *ordering* inside
// `decide()` — the `inFlight <= 1` bypass comes first — and it is easy to lose by
// accident, because a scoping rule that is correct under concurrency looks
// correct at cap 1 too. It just quietly stops including work that has no live
// Run's name on it, and at cap 1 that work is the operator's own.
//
// So the fixture deliberately dirties the tree with a change no phase declared,
// and asserts the patch carries it. Under concurrency that same change forces a
// decline; here it must not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDriveHarness, GIT_PHASE_ID, QUEUE_A, type CheckpointDriveHarness } from './driver-harness';

let h: CheckpointDriveHarness;

beforeEach(async () => {
  h = await makeDriveHarness();
});

afterEach(async () => {
  await h.dispose();
});

/** One Run, driven to the gate of its Git-capable phase — so past the checkpoint. */
async function soleRunAtItsGitPhase(): Promise<void> {
  h.start(QUEUE_A, 'run-a');
  await h.atGate('run-a', 'write-work');
  h.step('run-a');
  await h.atGate('run-a', 'settle');
  h.step('run-a');
  await h.atGate('run-a', GIT_PHASE_ID);
}

describe('cap 1 checkpoint behaviour is unchanged (T319, FR-R3-004)', () => {
  it('writes the whole-tree diff, including work no Run declared', async () => {
    await h.write('operator-note.txt', 'edited by hand, before any Run started\n');
    await soleRunAtItsGitPhase();

    const patch = await h.patch('run-a');
    expect(patch).not.toBeNull();
    expect(patch).toBe(await h.wholeTreeDiff());
    expect(patch).toContain('written by run-a');
    expect(patch).toContain('edited by hand');
    expect(await h.decline('run-a')).toBeNull();
    expect(h.warnings.filter((line) => line.includes('checkpoint'))).toEqual([]);
  });

  it('records it as sole-run and claims no partition', async () => {
    await soleRunAtItsGitPhase();

    const metadata = await h.metadata('run-a');
    expect(metadata!.attribution).toMatchObject({
      mode: 'sole-run',
      inFlightRuns: 1,
      // Empty rather than "every path in the tree": the sole-run patch is not a
      // partition of anything, and listing paths beside it would suggest a
      // scoping decision was made when none was.
      paths: []
    });
  });

  it('does not consult the ledger', async () => {
    // The mechanical statement of "unchanged". A ledger read at cap 1 would be
    // harmless today and load-bearing the moment someone gives it an opinion,
    // and the failure would not be visible in a patch — it would be a checkpoint
    // that started declining for a reason that cannot apply when a Run is alone
    // in the tree.
    const evidence = vi.spyOn(h.ledger, 'evidenceFor');
    const siblings = vi.spyOn(h.ledger, 'unaccountedSiblings');

    await soleRunAtItsGitPhase();

    expect(await h.patch('run-a')).not.toBeNull();
    expect(evidence).not.toHaveBeenCalled();
    expect(siblings).not.toHaveBeenCalled();
  });
});
