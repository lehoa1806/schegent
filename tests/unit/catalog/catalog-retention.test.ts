// Feature 099 (FR-R3-015) T496, T496j — the retention bound and its exemptions
// (FR-034-FR-038).
//
// The clause most easily got wrong is FR-035a, and it is worth stating as a defect
// rather than as a rule: retention walks oldest-first and **advances past** an
// exempt version to the next eligible one. An implementation that STOPS at the first
// exemption passes every test where nothing is exempt — which is every test anyone
// writes by default — and lets one run-referenced old version hold an unbounded
// history open forever. So the exempt cases below assert what WAS pruned, never
// merely that the exempt version survived: "nothing was pruned" and "the next
// eligible one was pruned" are the two implementations, and only the second is
// correct.
//
// The exemptions are asserted twice: on `planRetention` directly, where a small
// bound makes the algebra readable, and through the real store at its shipped bound
// of 50, where the wiring between the plan and the prune is what is under test.
//
// Feature 100 (T514) — two things moved. The draft exemption is no longer reported as
// `active`: FR-021 makes a pending draft a real exemption with its own name, so the
// reported reason is now `draft`, and a test that accepted either label would not
// notice the pointer being confused with the active one. And retention now runs on
// the SAVE path as well as the publish path, which is what the store-level cases
// below exercise — 51 draft saves prune, with no publication anywhere in them.

import { describe, expect, it } from 'vitest';

import { planRetention, withVersionsRemoved } from '../../../src/catalog';
import { draftTokenOf, type ExpectedDraftVersion } from '../../../src/contracts/catalog-lifecycle';
import type { CatalogKind, CatalogManifestEntry } from '../../../src/contracts/catalog-store';
import { CATALOG_RETENTION_BOUND } from '../../../src/contracts/catalog-store';
import {
  createTestStore,
  provenanceKey,
  provenanceReferencing,
  type TestStore
} from '../../fixtures/catalog-memory-fs';

/** A manifest entry holding `v1..vN`, active at the newest unless told otherwise. */
function entryOf(
  count: number,
  options: { readonly active?: string | null; readonly draft?: string | null } = {}
): CatalogManifestEntry {
  const versions = Array.from({ length: count }, (_unused, index) => ({
    versionId: `v${index + 1}`,
    contentHash: `sha256:${index + 1}`,
    createdAt: 1_000 + index,
    publishedAt: 1_000 + index,
    note: null
  }));
  return {
    kind: 'phase',
    id: 'implement',
    draftVersionId: options.draft ?? null,
    activeVersionId: options.active === undefined ? `v${count}` : options.active,
    createdAt: 1_000,
    updatedAt: 1_000 + count,
    versions
  };
}

/** Nothing is run-referenced — the implementation this feature actually ships. */
const referencesNothing = async () => false;

/** Exactly these version ids are run-referenced. */
function references(...versionIds: readonly string[]) {
  const set = new Set(versionIds);
  return async (versionId: string) => set.has(versionId);
}

/** The draft token the store currently holds for one definition (FR-012). */
async function tokenOf(
  test: TestStore,
  kind: CatalogKind,
  id: string
): Promise<ExpectedDraftVersion> {
  const result = await test.store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  const found = result.snapshot.definitions.find(
    (definition) => definition.kind === kind && definition.id === id
  );
  return draftTokenOf(found?.draftVersionId ?? null);
}

/** One draft save of `implement`, at whatever draft the store currently holds. */
async function saveDraft(test: TestStore, body: unknown) {
  return test.store.applyLifecycleWrite({
    op: 'save-draft',
    kind: 'phase',
    id: 'implement',
    body,
    expectedDraftVersion: await tokenOf(test, 'phase', 'implement')
  });
}

describe('planRetention: the bound', () => {
  it('removes nothing below the bound', async () => {
    const plan = await planRetention(entryOf(4), referencesNothing, 5);
    expect(plan.remove).toEqual([]);
    expect(plan.retained).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(plan.exempt).toEqual([]);
  });

  it('removes nothing exactly at the bound', async () => {
    // The off-by-one that matters: the bound is how many are RETAINED, so a history
    // of exactly 50 is untouched and the 51st save is the first to prune.
    const plan = await planRetention(entryOf(5), referencesNothing, 5);
    expect(plan.remove).toEqual([]);
    expect(plan.retained).toHaveLength(5);
  });

  it('removes exactly the surplus, oldest first', async () => {
    const plan = await planRetention(entryOf(8), referencesNothing, 5);
    expect(plan.remove).toEqual(['v1', 'v2', 'v3']);
    expect(plan.retained).toEqual(['v4', 'v5', 'v6', 'v7', 'v8']);
  });

  it('defaults to the shipped bound of 50', async () => {
    expect(CATALOG_RETENTION_BOUND).toBe(50);
    expect((await planRetention(entryOf(50), referencesNothing)).remove).toEqual([]);
    expect((await planRetention(entryOf(51), referencesNothing)).remove).toEqual(['v1']);
  });
});

describe('planRetention: exemptions advance past rather than stop', () => {
  it('prunes the next eligible version when the oldest is active', async () => {
    // T496j. `remove: []` here is the stop-at-first-exemption defect; `remove: ['v2']`
    // is the correct advance-past behaviour. The two are indistinguishable unless the
    // assertion names what was pruned.
    const plan = await planRetention(entryOf(6, { active: 'v1' }), referencesNothing, 5);

    expect(plan.remove).toEqual(['v2']);
    expect(plan.exempt).toEqual([{ versionId: 'v1', why: 'active' }]);
    expect(plan.retained).toEqual(['v1', 'v3', 'v4', 'v5', 'v6']);
  });

  it('prunes the next eligible version when the oldest is run-referenced', async () => {
    const plan = await planRetention(entryOf(6), references('v1'), 5);

    expect(plan.remove).toEqual(['v2']);
    expect(plan.exempt).toEqual([{ versionId: 'v1', why: 'run-referenced' }]);
  });

  it('keeps advancing across a run of exemptions until the surplus is met', async () => {
    // Three to remove, and the three oldest are all exempt: the walk must reach v4,
    // v5, and v6 rather than giving up at v1.
    const plan = await planRetention(entryOf(10, { active: 'v1' }), references('v2', 'v3'), 7);

    expect(plan.remove).toEqual(['v4', 'v5', 'v6']);
    expect(plan.exempt).toEqual([
      { versionId: 'v1', why: 'active' },
      { versionId: 'v2', why: 'run-referenced' },
      { versionId: 'v3', why: 'run-referenced' }
    ]);
    expect(plan.retained).toEqual(['v1', 'v2', 'v3', 'v7', 'v8', 'v9', 'v10']);
  });

  it('exempts the pending draft under its own name, not the active one', async () => {
    // FR-021. A draft is work in progress that nothing else holds a copy of, so
    // pruning it discards an edit the operator never published and cannot get back.
    // The REASON is asserted, not just the survival: feature 099 exempted this
    // version already but reported it as `active`, which was invisible while the
    // pointer was inert and is a lie now that an operator can be shown why a version
    // is still here.
    const plan = await planRetention(
      entryOf(6, { active: 'v6', draft: 'v1' }),
      referencesNothing,
      5
    );
    expect(plan.remove).toEqual(['v2']);
    expect(plan.exempt).toEqual([{ versionId: 'v1', why: 'draft' }]);
  });

  it('exempts both pointers when a definition has an active version and a draft', async () => {
    // The state FR-013 calls `active-with-draft`, at a bound that forces a choice:
    // seven versions, bound five, so two must go and the two pointers are not
    // candidates. An implementation that checked only one pointer would prune the
    // other and report success.
    const plan = await planRetention(
      entryOf(7, { active: 'v1', draft: 'v2' }),
      referencesNothing,
      5
    );
    expect(plan.remove).toEqual(['v3', 'v4']);
    expect(plan.exempt).toEqual([
      { versionId: 'v1', why: 'active' },
      { versionId: 'v2', why: 'draft' }
    ]);
  });

  it('removes nothing when every candidate is exempt, and says why', async () => {
    // The all-exempt case. History stays over the bound rather than a retained run's
    // provenance being broken to get under it: the bound yields to the exemptions,
    // not the other way round.
    const plan = await planRetention(
      entryOf(8, { active: 'v8' }),
      references('v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'),
      5
    );

    expect(plan.remove).toEqual([]);
    expect(plan.retained).toHaveLength(8);
    // The walk runs to the end of the history rather than stopping once it is clear
    // nothing can be removed, so every version is accounted for by name and reason —
    // which is what an operator asking "why is this still 8 versions?" needs.
    expect(plan.exempt).toEqual([
      { versionId: 'v1', why: 'run-referenced' },
      { versionId: 'v2', why: 'run-referenced' },
      { versionId: 'v3', why: 'run-referenced' },
      { versionId: 'v4', why: 'run-referenced' },
      { versionId: 'v5', why: 'run-referenced' },
      { versionId: 'v6', why: 'run-referenced' },
      { versionId: 'v7', why: 'run-referenced' },
      { versionId: 'v8', why: 'active' }
    ]);
  });

  it('asks about provenance only for versions otherwise about to be pruned', async () => {
    // A port call per version would make every save pay for a question about
    // versions nothing was going to touch. With a surplus of one, exactly one
    // question is asked — and a second only if the first answered `true`.
    const asked: string[] = [];
    await planRetention(
      entryOf(51),
      async (versionId) => {
        asked.push(versionId);
        return false;
      },
      50
    );
    expect(asked).toEqual(['v1']);
  });
});

describe('withVersionsRemoved', () => {
  it('drops exactly the named versions and renumbers nothing', async () => {
    // FR-005. A definition pruned down to v41-v90 keeps those ids; renumbering would
    // reuse ids that already named different content, and every run provenance
    // pointing at an old version would silently start pointing at a new one.
    const after = withVersionsRemoved(entryOf(6), ['v1', 'v2']);
    expect(after.versions.map((version) => version.versionId)).toEqual(['v3', 'v4', 'v5', 'v6']);
    expect(after.versions[0]?.contentHash).toBe('sha256:3');
  });

  it('returns the entry unchanged when nothing was removed', async () => {
    const entry = entryOf(3);
    expect(withVersionsRemoved(entry, [])).toBe(entry);
  });

  it('leaves createdAt and the active version alone', async () => {
    const entry = entryOf(6);
    const after = withVersionsRemoved(entry, ['v1']);
    expect(after.createdAt).toBe(entry.createdAt);
    expect(after.activeVersionId).toBe('v6');
  });
});

describe('catalog store: retention at the shipped bound', () => {
  it('skips a run-referenced version and prunes the next one instead', async () => {
    // The same claim as the pure case, end to end: through the store's provenance
    // port, at bound 50, with the file on disk as the evidence.
    const test = createTestStore({
      provenance: provenanceReferencing([provenanceKey('phase', 'implement', 'v1')])
    });

    for (let n = 1; n <= 51; n += 1) {
      const outcome = await saveDraft(test, { n });
      expect(outcome).toMatchObject({ outcome: 'written' });
      if (n === 51) expect(outcome).toMatchObject({ pruned: ['v2'] });
    }

    // v1 is referenced by a retained run and is still on disk; v2 is not and is gone.
    expect(test.fs.files.has('phases/implement/v1.json')).toBe(true);
    expect(test.fs.files.has('phases/implement/v2.json')).toBe(false);
    expect(test.fs.files.has('phases/implement/v3.json')).toBe(true);
  });

  it('reports what left the history, so the operator is told rather than surprised', async () => {
    const test = createTestStore();
    let lastPruned: readonly string[] = [];
    for (let n = 1; n <= 53; n += 1) {
      const outcome = await saveDraft(test, { n });
      if (outcome.outcome === 'written') lastPruned = outcome.pruned;
    }
    // FR-035, and the clause feature 100 widened: pruned and reported, oldest first,
    // one per write once over the bound — on a draft save as much as on a publish. An
    // unbounded run of draft saves is the easiest way to grow a history, so a bound
    // that only applied at publication would not be a bound at all.
    expect(lastPruned).toEqual(['v3']);
  });

  it('keeps the definition resolving after a prune', async () => {
    const test = createTestStore();
    for (let n = 1; n <= 52; n += 1) {
      await saveDraft(test, { n });
    }
    // Published at the end, because "resolving" means an ACTIVE version: 52 draft
    // saves leave a definition no resolver sees (FR-007), which would make the
    // assertion below pass for the wrong reason.
    await test.store.applyLifecycleWrite({
      op: 'publish',
      kind: 'phase',
      id: 'implement',
      expectedDraftVersion: await tokenOf(test, 'phase', 'implement')
    });

    const result = await test.store.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    // A prune removes surplus history, not the definition. No fault, and nothing
    // collectable either — the manifest stopped naming those versions before their
    // files went, so there is no window in which they read as orphans.
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.collectable).toEqual([]);
    expect(result.snapshot.definitions[0]).toMatchObject({
      status: 'effective',
      activeVersionId: 'v52',
      body: { n: 52 }
    });
  });
});
