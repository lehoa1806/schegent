// Feature 100 (FR-R3-016) T514d — the gate is per definition, and over the draft
// pointer only.
//
// Two windows on one workspace is the ordinary case, not the exotic one, and the
// gate has to be narrow in exactly one dimension and strict in exactly one other:
//
//   - **Narrow.** A token names one definition's *draft* pointer (FR-012, FR-012b).
//     A save of some other definition, a publication elsewhere, and a deactivation
//     of this same definition's *active* pointer all leave it valid. A whole-catalog
//     or whole-kind gate would make the second window's save fail for a reason that
//     has nothing to do with what it edited — which is the failure mode this design
//     replaced.
//   - **Strict.** Two writes of the *same* draft from the same view produce one
//     success and one structured refusal, never two successes. Including the case
//     where the draft does not exist yet: `NO_DRAFT` is a token like any other, so
//     two windows both creating a first draft race the same way. A `null` gate would
//     let the second silently overwrite the first.
//
// The store re-checks the same gate against the manifest the write itself loaded,
// which is why these are service-level tests and not store-level ones: the
// concurrency suite in `tests/integration/catalog-store-concurrency.test.ts` pins
// the store's half. What is asserted here is that a race the store detects comes
// back through the service as an *actionable* refusal — the fresh record, the token
// to retry with, and the legal actions from the state that actually holds.

import { beforeEach, describe, expect, it } from 'vitest';

import { NO_DRAFT, type ExpectedDraftVersion } from '../../../src/contracts/catalog-lifecycle';
import type { SaveDraftOutcome } from '../../../src/contracts/catalog-lifecycle';
import {
  createLifecycleHarness,
  definitionOf,
  draft,
  entryOf,
  phaseBody,
  publish,
  seedActive,
  snapshotOf,
  tokenOf,
  versionIdsOf,
  type LifecycleHarness
} from '../../fixtures/catalog-lifecycle-harness';

let harness: LifecycleHarness;

beforeEach(() => {
  harness = createLifecycleHarness();
});

function saveDraft(
  id: string,
  body: unknown,
  expectedDraftVersion: ExpectedDraftVersion
): Promise<SaveDraftOutcome> {
  return harness.service.saveDraft({ kind: 'phase', id, body, expectedDraftVersion });
}

/** The outcome names of a set of racing saves, sorted so the winner's identity is not asserted. */
function outcomesOf(results: readonly SaveDraftOutcome[]): readonly string[] {
  return results.map((result) => result.outcome).sort();
}

describe('the gate is per definition (FR-012b)', () => {
  it('lets two disjoint saves from one stale view both succeed', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'phase', 'build', phaseBody('build'));
    // One view of the world, taken before either write. Both windows are looking at
    // the same catalog and editing different definitions.
    const planToken = await tokenOf(harness.store, 'phase', 'plan');
    const buildToken = await tokenOf(harness.store, 'phase', 'build');

    const first = await saveDraft('plan', phaseBody('plan', { name: 'Edited' }), planToken);
    const second = await saveDraft('build', phaseBody('build', { name: 'Edited' }), buildToken);

    expect(first).toEqual({ outcome: 'saved', draftVersionId: 'v2' });
    // Not stale: the first write moved this kind's revision, and the gate is not the
    // revision. A per-kind gate here would refuse an edit to an unrelated definition.
    expect(second).toEqual({ outcome: 'saved', draftVersionId: 'v2' });
  });

  it('does not invalidate an in-flight edit when another definition is published', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await draft(harness, 'phase', 'build', phaseBody('build'));
    const planToken = await tokenOf(harness.store, 'phase', 'plan');

    // Someone else makes a different definition live, twice over.
    await publish(harness, 'phase', 'build');
    await draft(harness, 'phase', 'build', phaseBody('build', { name: 'Again' }));
    await publish(harness, 'phase', 'build');

    expect(await saveDraft('plan', phaseBody('plan', { name: 'Edited' }), planToken)).toEqual({
      outcome: 'saved',
      draftVersionId: 'v2'
    });
  });

  it('does not invalidate an in-flight edit when this definition is deactivated', async () => {
    // The active pointer is excluded from the token on purpose: the edit is against
    // the draft, and the draft did not move.
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const draftVersionId = await draft(harness, 'phase', 'plan', phaseBody('plan', { name: 'Edit' }));

    const deactivated = await harness.service.deactivate({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: draftVersionId
    });
    expect(deactivated.outcome).toBe('deactivated');

    // The window that was editing knows nothing about the deactivation, and its
    // edit is still valid.
    expect(
      await saveDraft('plan', phaseBody('plan', { name: 'Edit again' }), draftVersionId)
    ).toEqual({ outcome: 'saved', draftVersionId: 'v3' });
    expect(entryOf(harness.fs, 'phase', 'plan')?.activeVersionId).toBeNull();
  });
});

describe('two writes of one draft give one success and one refusal (FR-012)', () => {
  it('refuses the second save from the same view, naming the token to retry with', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const shared = await tokenOf(harness.store, 'phase', 'plan');

    const first = await saveDraft('plan', phaseBody('plan', { name: 'First' }), shared);
    const second = await saveDraft('plan', phaseBody('plan', { name: 'Second' }), shared);

    expect(first).toEqual({ outcome: 'saved', draftVersionId: 'v2' });
    expect(second.outcome).toBe('refused');
    if (second.outcome !== 'refused') return;
    expect(second.refusal.reason).toBe('stale-draft');
    expect(second.refusal.current).toEqual({
      kind: 'phase',
      id: 'plan',
      state: 'active-with-draft',
      draftVersionId: 'v2',
      activeVersionId: 'v1',
      expectedDraftVersion: 'v2'
    });
    expect(second.refusal.legalActions).toEqual([
      'save-draft',
      'publish',
      'deactivate',
      'restore',
      'discard-draft'
    ]);
    // The loser wrote nothing: one draft, not two, and the winner's body is what
    // the store holds.
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2']);
    expect((await definitionOf(harness.store, 'phase', 'plan'))?.draftBody).toEqual(
      phaseBody('plan', { name: 'First' })
    );
  });

  it('gives one success and one refusal however the two are interleaved', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const shared = await tokenOf(harness.store, 'phase', 'plan');

    // Issued together rather than in sequence, and the winner is deliberately not
    // asserted — the property is that exactly one lands, not which.
    const results = await Promise.all([
      saveDraft('plan', phaseBody('plan', { name: 'A' }), shared),
      saveDraft('plan', phaseBody('plan', { name: 'B' }), shared)
    ]);

    expect(outcomesOf(results)).toEqual(['refused', 'saved']);
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2']);
  });

  it('refuses a publish issued against a draft that has already moved', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const shared = await tokenOf(harness.store, 'phase', 'plan');
    await saveDraft('plan', phaseBody('plan', { name: 'First' }), shared);

    // A second window trying to publish the draft it believed was there. The draft
    // it would publish is not the draft it saw.
    const outcome = await harness.service.publish({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: shared
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('stale-draft');
    expect(entryOf(harness.fs, 'phase', 'plan')?.activeVersionId).toBe('v1');
  });
});

describe('two first-draft creations race the same way (FR-012a)', () => {
  it('gives one success and one refusal under NO_DRAFT', async () => {
    // Nothing exists yet, so both windows hold the same token — the sentinel. This
    // is the case a `null` gate loses: "no draft" would compare equal to "no draft"
    // after the first write had already made one.
    const first = await saveDraft('plan', phaseBody('plan', { name: 'First' }), NO_DRAFT);
    const second = await saveDraft('plan', phaseBody('plan', { name: 'Second' }), NO_DRAFT);

    expect(first).toEqual({ outcome: 'saved', draftVersionId: 'v1' });
    expect(second.outcome).toBe('refused');
    if (second.outcome !== 'refused') return;
    expect(second.refusal.reason).toBe('stale-draft');
    expect(second.refusal.current.state).toBe('draft');
    expect(second.refusal.current.expectedDraftVersion).toBe('v1');
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1']);
  });

  it('gives one success and one refusal however the two are interleaved', async () => {
    const results = await Promise.all([
      saveDraft('plan', phaseBody('plan', { name: 'A' }), NO_DRAFT),
      saveDraft('plan', phaseBody('plan', { name: 'B' }), NO_DRAFT)
    ]);

    expect(outcomesOf(results)).toEqual(['refused', 'saved']);
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1']);
  });

  it('leaves the loser of a cross-definition interleave as debris, never unaccounted for', async () => {
    // The documented boundary, asserted rather than wished away. Two writes of
    // *different* definitions both pass their own gates — that is the point of a
    // per-definition gate — and then share one manifest file, where 099's recorded
    // assumption is last-writer-wins and a cross-window lock is out of scope. The
    // per-definition gate widened this case rather than closing it, so the property
    // that has to hold is the weaker one: every record on disk is either history or
    // collectable debris.
    const results = await Promise.all([
      saveDraft('plan', phaseBody('plan'), NO_DRAFT),
      saveDraft('build', phaseBody('build'), NO_DRAFT)
    ]);

    expect(outcomesOf(results)).toEqual(['saved', 'saved']);
    const entries = ['plan', 'build'].filter(
      (id) => entryOf(harness.fs, 'phase', id) !== undefined
    );
    expect(entries).toHaveLength(1);
    const snapshot = await snapshotOf(harness.store);
    // The record the manifest lost is reported by name and is not a fault: a
    // collectable record is the operator's to remove, never the store's (099 FR-026).
    expect(snapshot.collectable).toEqual([
      { kind: 'phase', id: entries[0] === 'plan' ? 'build' : 'plan', versionId: 'v1' }
    ]);
    expect(snapshot.faults).toEqual([]);
  });

  it('lets two windows create first drafts of different definitions in sequence', async () => {
    expect(await saveDraft('plan', phaseBody('plan'), NO_DRAFT)).toEqual({
      outcome: 'saved',
      draftVersionId: 'v1'
    });
    expect(await saveDraft('build', phaseBody('build'), NO_DRAFT)).toEqual({
      outcome: 'saved',
      draftVersionId: 'v1'
    });

    expect(entryOf(harness.fs, 'phase', 'plan')?.draftVersionId).toBe('v1');
    expect(entryOf(harness.fs, 'phase', 'build')?.draftVersionId).toBe('v1');
  });
});
