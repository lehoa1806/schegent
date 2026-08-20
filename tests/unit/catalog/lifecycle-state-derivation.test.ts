// Feature 100 (FR-R3-016) T514 — state is the pair of pointers and nothing else.
//
// Four claims, and the last two are the ones that matter:
//
//   - **The four pointer combinations** map to the three states (FR-006), and the
//     two entry points — `definitionStateOf` over the pair and
//     `deriveDefinitionState` over an entry — are one derivation rather than two.
//     The service builds a refusal's `current` record from the pointers the store
//     reported and a surface derives from the entry it holds; those two must agree
//     about what is live or the operator is told two different things.
//   - **There is no fourth state.** An entry with neither pointer set is not a
//     state a definition can be in — it is the absence of a definition (FR-005) —
//     so the union has exactly three inhabitants and the *store* never produces a
//     `null`/`null` entry. Both halves are asserted: the type-level one so a fourth
//     literal added to the union stops this file compiling, and the behavioural one
//     by driving the definition to the edge of that entry and watching the entry
//     disappear instead.
//   - **The two pointers never name the same version.** Publishing moves both in
//     one expression, so no state on disk or in memory has one version in both
//     places. The check is run after *every* operation over a long sequence rather
//     than at one chosen point, because the way this invariant breaks is a single
//     operation that sets one pointer without clearing the other.
//
// The real service on in-memory ports throughout, so the states asserted here are
// states the shipping code actually reaches.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  definitionStateOf,
  deriveDefinitionState,
  legalActionsFor,
  NO_DRAFT,
  type DefinitionState
} from '../../../src/contracts/catalog-lifecycle';
import type { CatalogManifestEntry } from '../../../src/contracts/catalog-store';
import {
  createLifecycleHarness,
  draft,
  entryOf,
  manifestOf,
  phaseBody,
  publish,
  seedActive,
  tokenOf,
  type LifecycleHarness
} from '../../fixtures/catalog-lifecycle-harness';

/** An entry carrying the pair under test and nothing else that matters here. */
function entryWith(
  draftVersionId: string | null,
  activeVersionId: string | null
): CatalogManifestEntry {
  return {
    kind: 'phase',
    id: 'plan',
    draftVersionId,
    activeVersionId,
    createdAt: 1,
    updatedAt: 1,
    versions: []
  };
}

/**
 * Every manifest entry's pointer pair, as the fake disk holds it.
 *
 * Read from the durable manifest rather than from a snapshot projection: the
 * invariant is about what is written, and a projection could normalise a violation
 * away on the way out.
 */
function pointerPairs(
  harness: LifecycleHarness
): readonly { readonly id: string; readonly draft: string | null; readonly active: string | null }[] {
  return manifestOf(harness.fs).entries.map((entry) => ({
    id: `${entry.kind}/${entry.id}`,
    draft: entry.draftVersionId,
    active: entry.activeVersionId
  }));
}

describe('the pointer pair projects to a state (FR-006)', () => {
  it('reads a definition with no active version as a Draft', () => {
    expect(definitionStateOf('v1', null)).toBe('draft');
  });

  it('reads a definition with an active version and no draft as Active', () => {
    expect(definitionStateOf(null, 'v1')).toBe('active');
  });

  it('reads a definition with both pointers set as Active with a draft', () => {
    expect(definitionStateOf('v2', 'v1')).toBe('active-with-draft');
  });

  it('reads the entry that cannot exist as a Draft rather than widening the union', () => {
    // FR-005: an entry with neither pointer has no manifest entry at all, so this
    // input is a manifest the shape check already refuses. It is answered rather
    // than thrown so no surface has a `null` state to forget to handle — and the
    // behavioural half below shows the store never produces the input.
    expect(definitionStateOf(null, null)).toBe('draft');
  });

  it('derives the same state from an entry as from the pair it carries', () => {
    // One derivation, two call shapes. A second `if` chain in either entry point is
    // how a refusal's `current` record comes to disagree with the surface that
    // triggered it.
    for (const [draftVersionId, activeVersionId] of [
      ['v1', null],
      [null, 'v1'],
      ['v2', 'v1'],
      [null, null]
    ] as const) {
      expect(deriveDefinitionState(entryWith(draftVersionId, activeVersionId))).toBe(
        definitionStateOf(draftVersionId, activeVersionId)
      );
    }
  });
});

describe('there is no fourth state', () => {
  it('has exactly three inhabitants, checked by the type system', () => {
    // Total by construction: a fourth literal added to `DefinitionState` makes this
    // record incomplete and stops the file compiling, which is the point. The
    // runtime half only confirms nothing was added to the object either.
    const covered: Record<DefinitionState, true> = {
      draft: true,
      active: true,
      'active-with-draft': true
    };
    expect(Object.keys(covered).sort()).toEqual(['active', 'active-with-draft', 'draft']);
  });

  it('answers "what now?" for the three states and for the absent definition', () => {
    // `null` here is the absence of an entry, not a fourth state: the only thing
    // that can happen to a definition the manifest does not hold is a first draft.
    expect(legalActionsFor(null)).toEqual(['save-draft']);
    for (const state of ['draft', 'active', 'active-with-draft'] as const) {
      expect(legalActionsFor(state).length).toBeGreaterThan(1);
    }
  });

  it('removes the entry rather than leaving one with neither pointer set (FR-005, FR-034)', async () => {
    const harness = createLifecycleHarness();
    await draft(harness, 'phase', 'plan', phaseBody('plan'));
    expect(entryOf(harness.fs, 'phase', 'plan')?.draftVersionId).toBe('v1');

    const discarded = await harness.service.discardDraft({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
    });

    expect(discarded).toEqual({ outcome: 'discarded', entryRemoved: true });
    expect(entryOf(harness.fs, 'phase', 'plan')).toBeUndefined();
  });
});

describe('the two pointers never name the same version', () => {
  let harness: LifecycleHarness;

  beforeEach(() => {
    harness = createLifecycleHarness();
  });

  /** Assert the invariant over every entry, then hand back the states reached. */
  function statesNow(): readonly DefinitionState[] {
    const pairs = pointerPairs(harness);
    for (const pair of pairs) {
      if (pair.draft === null || pair.active === null) continue;
      expect(pair.draft, `${pair.id} has one version in both pointers`).not.toBe(pair.active);
    }
    return pairs.map((pair) => definitionStateOf(pair.draft, pair.active));
  }

  it('holds after every operation across a definition\'s whole life', async () => {
    const reached = new Set<DefinitionState>();
    const record = (): void => {
      for (const state of statesNow()) reached.add(state);
    };

    // Draft, then live.
    await draft(harness, 'phase', 'plan', phaseBody('plan'));
    record();
    await publish(harness, 'phase', 'plan');
    record();

    // Live with an edit pending — the one state where both pointers are set.
    await draft(harness, 'phase', 'plan', phaseBody('plan', { instruction: 'Plan it twice.' }));
    record();
    await publish(harness, 'phase', 'plan');
    record();

    // Out of service, then back: deactivation moves the version that was live onto
    // the draft pointer and clears the active one (FR-024a), which is exactly the
    // operation that would break the invariant if it set one without clearing.
    const deactivated = await harness.service.deactivate({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
    });
    expect(deactivated.outcome).toBe('deactivated');
    record();
    await publish(harness, 'phase', 'plan');
    record();

    // A restore writes a new draft beside the live version.
    const restored = await harness.service.restore({
      kind: 'phase',
      id: 'plan',
      fromVersionId: 'v1',
      expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
    });
    expect(restored.outcome).toBe('restored');
    record();
    await publish(harness, 'phase', 'plan');
    record();

    // All three states were actually visited, so the invariant was checked against
    // a walk that reached them rather than against a walk that stayed in one.
    expect([...reached].sort()).toEqual(['active', 'active-with-draft', 'draft']);
  });

  it('holds while a second definition moves through its own states', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await draft(harness, 'phase', 'build', phaseBody('build'));
    await draft(harness, 'phase', 'plan', phaseBody('plan', { name: 'Plan again' }));
    statesNow();

    await publish(harness, 'phase', 'build');
    await publish(harness, 'phase', 'plan');
    expect(statesNow()).toEqual(['active', 'active']);
  });

  it('keeps the published version out of the draft pointer it was promoted from', async () => {
    const draftVersionId = await draft(harness, 'phase', 'plan', phaseBody('plan'));
    const activeVersionId = await publish(harness, 'phase', 'plan');

    // The same version, moved rather than copied: the draft pointer is cleared in
    // the same manifest write that set the active one.
    expect(activeVersionId).toBe(draftVersionId);
    const entry = entryOf(harness.fs, 'phase', 'plan');
    expect(entry?.activeVersionId).toBe(draftVersionId);
    expect(entry?.draftVersionId).toBeNull();
    expect(await tokenOf(harness.store, 'phase', 'plan')).toBe(NO_DRAFT);
  });
});
