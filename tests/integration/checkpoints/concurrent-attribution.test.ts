// FR-R3-004 (T318) — two Runs execute Git-capable phases at the same time, and
// each gets a patch holding only its own work.
//
// This is the scenario feature 093 shipped as a decline, and REL-02 recorded as
// the residual risk of running more than one Run in a shared worktree. What made
// it undecidable was that a checkpoint is a diff of the whole tree and nothing
// knew who wrote what. What makes it decidable now is the driver's own bracket:
// `dispatchObserved` opens a ledger window before every phase dispatch and closes
// it in a `finally` carrying that phase's audit record, so the paths the phase
// declared become that Run's claim on the tree.
//
// The bracket is why this fixture is an integration test rather than a third unit
// suite, and it is why the two Runs here are genuinely interleaved. The unit
// suites open and close windows by hand, strictly one at a time — so they would
// keep passing against a driver that had stopped calling the ledger at all, and
// they would keep passing against an attribution rule that only works when the
// windows do not overlap. Under real concurrency they overlap almost entirely,
// which is why the declaration and not the window is what attributes. A driver
// that fed the ledger nothing would not fail loudly either: it declines quietly,
// which reads as the pre-FR-R3-004 behaviour rather than as a regression.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeDriveHarness,
  GIT_PHASE_ID,
  QUEUE_A,
  QUEUE_B,
  type CheckpointDriveHarness
} from './driver-harness';

let h: CheckpointDriveHarness;

beforeEach(async () => {
  h = await makeDriveHarness();
});

afterEach(async () => {
  await h.dispose();
});

/**
 * Both Runs write, then both settle, then each takes its checkpoint on the way
 * into the Git-capable phase — interleaved, never serialized. The order matters:
 * a fixture that let one Run finish first would checkpoint a tree that held only
 * that Run's work, which the sole-run path satisfies too.
 */
async function bothRunsAtTheirGitPhase(): Promise<void> {
  h.start(QUEUE_A, 'run-a');
  h.start(QUEUE_B, 'run-b');

  await h.atGate('run-a', 'write-work');
  await h.atGate('run-b', 'write-work');
  h.step('run-a');
  await h.atGate('run-a', 'settle');
  h.step('run-b');
  await h.atGate('run-b', 'settle');

  // Both files are now in the tree and both write windows are closed, so the
  // next checkpoint sees a genuinely shared worktree.
  h.step('run-a');
  await h.atGate('run-a', GIT_PHASE_ID);
  h.step('run-b');
  await h.atGate('run-b', GIT_PHASE_ID);
}

describe('concurrent Git-capable phases produce disjoint patches (T318, FR-R3-004)', () => {
  it('gives each Run a patch with its own work and none of its sibling s', async () => {
    await bothRunsAtTheirGitPhase();

    const patchA = await h.patch('run-a');
    const patchB = await h.patch('run-b');
    expect(patchA, 'run-a took no snapshot at all').not.toBeNull();
    expect(patchB, 'run-b took no snapshot at all').not.toBeNull();

    expect(patchA).toContain('written by run-a');
    expect(patchA).not.toContain('written by run-b');
    expect(patchB).toContain('written by run-b');
    expect(patchB).not.toContain('written by run-a');
    // The sibling's *file* is absent too, not merely its content: a header with
    // an empty body is still a claim on someone else's path.
    expect(patchA).not.toContain('b/run-b.txt');
    expect(patchB).not.toContain('b/run-a.txt');
  });

  it('records both as scoped, taken with two Runs in flight, against a real base', async () => {
    await bothRunsAtTheirGitPhase();
    const base = await h.head();

    for (const runId of ['run-a', 'run-b']) {
      const metadata = await h.metadata(runId);
      expect(metadata).toMatchObject({ runId, phaseId: GIT_PHASE_ID, baseCommit: base });
      expect(metadata!.attribution).toMatchObject({
        mode: 'scoped',
        inFlightRuns: 2,
        paths: [`${runId}.txt`]
      });
    }
  });

  it('declines nothing and warns about nothing', async () => {
    await bothRunsAtTheirGitPhase();

    expect(await h.decline('run-a')).toBeNull();
    expect(await h.decline('run-b')).toBeNull();
    expect(h.warnings.filter((line) => line.includes('checkpoint'))).toEqual([]);
  });

  it('neither Run s Git-capable phase waited on the other', async () => {
    // SC-013 is a shipped guarantee and this feature must not buy attribution
    // with serialization. The evidence is the dispatch order: both Runs were
    // parked inside their Git-capable phase at the same moment, so neither
    // checkpoint blocked the other's advance.
    await bothRunsAtTheirGitPhase();

    const gitPhases = h.invocations.filter((entry) => entry.phase === GIT_PHASE_ID);
    expect(gitPhases.map((entry) => entry.runId).sort()).toEqual(['run-a', 'run-b']);

    const finished = Object.values(h.store.getRunMap()).map((run) => run.status);
    expect(finished).toEqual(['running', 'running']);
  });

  it('scopes to the sibling s work in flight, not to the sibling s existence', async () => {
    // The complement of the first case, and the one that catches an
    // over-eager scoping rule: with a sibling admitted but holding nothing in
    // the tree, the whole-tree diff *is* this Run's diff, so it is written whole
    // rather than reassembled from sections.
    h.start(QUEUE_A, 'run-a');
    h.start(QUEUE_B, 'run-b', { writes: false });
    await h.atGate('run-a', 'write-work');
    await h.atGate('run-b', 'write-work');

    // run-b opens and closes a phase window without writing anything, so its
    // evidence is complete and its share of the tree is empty.
    h.step('run-b');
    await h.atGate('run-b', 'settle');
    h.step('run-a');
    await h.atGate('run-a', 'settle');
    h.step('run-a');
    await h.atGate('run-a', GIT_PHASE_ID);

    const metadata = await h.metadata('run-a');
    expect(metadata!.attribution).toMatchObject({
      mode: 'no-sibling-work-present',
      inFlightRuns: 2
    });
    expect(await h.patch('run-a')).toBe(await h.wholeTreeDiff());
  });
});
