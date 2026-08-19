// FR-R3-004 (T316) — every residual case where attribution cannot be
// established still declines.
//
// FR-R3-004 removes the *condition* that forced feature 093's decline; it does
// not weaken the decline itself, and the hard rule it serves is unchanged:
// never take or offer a recovery checkpoint that cannot be attributed to a
// single Run. So each case below asserts the same three things — no `.patch`
// exists, a `.declined.json` names why, and the Git-capable phase is not
// blocked.
//
// The reasons are deliberately four rather than one. An operator who finds a
// marker has to know whether to commit something, stash something, or wait, and
// "concurrent runs share one worktree" answered none of those.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeCheckpointHarness,
  onlyDecline,
  onlyPatch,
  type CheckpointHarness
} from '../../fixtures/services/checkpoint-harness';

let h: CheckpointHarness;

beforeEach(async () => {
  h = await makeCheckpointHarness();
});

afterEach(async () => {
  await h.dispose();
});

/** Every decline shares these three properties; only the reason differs. */
async function expectDeclined(runId: string, reason: string): Promise<Record<string, unknown>> {
  expect(await onlyPatch(h, runId)).toBeNull();
  const marker = await onlyDecline(h, runId);
  expect(marker).toMatchObject({ runId, reason, restorable: false });
  expect(h.warnings.join('\n')).toContain(reason);
  return marker!;
}

describe('RunCheckpointService — residual unattributable cases (T316, FR-R3-004)', () => {
  it('declines when two Runs both declared writing one file', async () => {
    const a = h.run('run-a');
    const b = h.run('run-b');
    await h.phase(a, () => h.write('shared.txt', 'from run-a\n'));
    await h.phase(b, () => h.write('shared.txt', 'from run-a\nfrom run-b\n'));

    await h.service().checkpoint(a, 'speckit-implement');

    const marker = await expectDeclined('run-a', 'path-mutated-by-multiple-runs');
    // The marker names the file, because the marker is the only place an
    // operator learns what to deal with. The warning line stays counts-only.
    expect(marker.detail).toMatchObject({ paths: ['shared.txt'] });
    expect(h.warnings.join('\n')).not.toContain('shared.txt');
  });

  it('declines when the tree holds a change no Run accounts for', async () => {
    // Stands in for a subprocess that outlived its phase, and for an operator
    // editing a file by hand mid-session. The two are indistinguishable, and the
    // first would make a scoped patch silently incomplete.
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));
    await h.write('stray.txt', 'nobody claims this\n');

    await h.service().checkpoint(a, 'speckit-implement');

    const marker = await expectDeclined('run-a', 'unattributed-worktree-change');
    expect(marker.detail).toMatchObject({ paths: ['stray.txt'] });
  });

  it('declines for a Run this host never observed from its first phase', async () => {
    // A Run reloaded mid-pipeline after a window restart. The ledger is per-host
    // and in-memory, so its own emptiness must not read as a clean history.
    const resumed = h.resumedRun('run-resumed');
    await h.idlePhase(h.run('run-b'));
    await h.phase(resumed, () => h.write('a.txt', 'written after a reload\n'));

    await h.service().checkpoint(resumed, 'speckit-implement');

    const marker = await expectDeclined('run-resumed', 'attribution-evidence-incomplete');
    expect(marker.detail).toMatchObject({ ownEvidence: 'run-not-observed-from-start' });
  });

  it('declines while a live sibling has been observed at all', async () => {
    // A sibling the ledger cannot account for may have written anywhere,
    // including into the baseline, so it invalidates the whole partition rather
    // than one Run's share of it.
    const a = h.run('run-a');
    h.run('run-unseen');
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));

    await h.service().checkpoint(a, 'speckit-implement');

    const marker = await expectDeclined('run-a', 'attribution-evidence-incomplete');
    expect(marker.detail).toMatchObject({
      ownEvidence: 'complete',
      unaccountedSiblings: ['run-unseen']
    });
  });

  it('declines when a diff cannot be read during a phase', async () => {
    // Observation failing is not the phase's problem to raise — but it does mean
    // this Run's record has a hole, and a hole is indistinguishable from a
    // sibling's write.
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));
    await h.breakObservation(async () => {
      await h.idlePhase(a);
    });

    await h.service().checkpoint(a, 'speckit-implement');

    const marker = await expectDeclined('run-a', 'attribution-evidence-incomplete');
    expect(marker.detail).toMatchObject({ ownEvidence: 'observation-failed' });
  });

  it('declines when a phase wrote a file and its audit record did not say so', async () => {
    // The failure mode the declaration mechanism has to answer for, and the
    // reason the whole-tree diff is still read at every window edge. An audit
    // record is produced by the CLI, so it can under-report; scoping to a short
    // declaration would then write a patch that silently omits a real change.
    // The section is present and unclaimed, so the answer is a decline.
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'), []);

    await h.service().checkpoint(a, 'speckit-implement');

    const marker = await expectDeclined('run-a', 'unattributed-worktree-change');
    expect(marker.detail).toMatchObject({ paths: ['a.txt'] });
  });

  it('declines when a phase produced no audit record at all', async () => {
    // A malformed invocation, a crash, or a cancellation: the phase ran and what
    // it wrote is unknown. Deliberately not the same as a phase that declared an
    // empty list — that one reported, and the report is checkable against the
    // tree. This one left a hole, and a hole is indistinguishable from a
    // sibling's write.
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, async () => {}, null);

    await h.service().checkpoint(a, 'speckit-implement');

    const marker = await expectDeclined('run-a', 'attribution-evidence-incomplete');
    expect(marker.detail).toMatchObject({ ownEvidence: 'observation-failed' });
  });

  it('declines when nothing this Run wrote is still in the tree', async () => {
    const a = h.run('run-a');
    const b = h.run('run-b');
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));
    await h.phase(b, () => h.write('b.txt', 'written by run-b\n'));
    // A commit lands the tree, so nothing either Run wrote is uncommitted any
    // more; then only the sibling dirties it again.
    await h.commitAll('a Git-capable phase landed the tree');
    await h.phase(b, () => h.write('b.txt', 'written by run-b, twice\n'));

    await h.service().checkpoint(a, 'speckit-implement');

    await expectDeclined('run-a', 'no-attributable-changes-observed');
  });

  it('does not block the Git-capable phase it declined to snapshot', async () => {
    // A declined snapshot is not a failed one. `checkpoint()` throws
    // `checkpoint-unavailable` when it cannot capture, and the driver blocks the
    // phase on that; declining must return normally, or the refusal would
    // serialize Git-capable phases across queues — the serialization SC-013
    // forbids, reintroduced to protect a safety net this path has just
    // established cannot be taken.
    const a = h.run('run-a');
    h.run('run-unseen');
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));

    await expect(h.service().checkpoint(a, 'speckit-implement')).resolves.toBeUndefined();
  });
});
