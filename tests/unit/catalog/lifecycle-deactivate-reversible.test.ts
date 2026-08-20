// Feature 100 (FR-R3-016) T514b1 — deactivation is reversible, and that is a
// property of the *entry it leaves behind*.
//
// Taking a definition out of service could have been modelled three ways, and two
// of them are one-way doors:
//
//   - Clear both pointers. The entry then has neither, which is not a state a
//     definition can be in (FR-005) — so either the entry is removed, taking the
//     retained history with it, or the manifest holds a row no derivation can read.
//   - Write a new version record holding the old body. History then grows every
//     time a definition is parked, and `createdAt`/`publishedAt` stop meaning what
//     they say.
//
// What FR-024a actually does is move the version that was live onto the *draft*
// pointer and clear the active one. Nothing is written but the manifest, nothing is
// deleted, and the definition lands in the one state from which publishing is a
// legal action — which is what makes the round trip of FR-027 an ordinary
// publication rather than a special path (US4 AS2).
//
// So the assertions here are: the entry survives; it is in `'draft'` carrying the
// version that was live; the version list did not grow and no record was written or
// removed; and republishing makes it live again *at that same version*, keeping the
// `publishedAt` the version has always had.

import { beforeEach, describe, expect, it } from 'vitest';

import { storedRows } from '../../../src/catalog';
import { deriveDefinitionState } from '../../../src/contracts/catalog-lifecycle';
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

async function deactivate(kind: 'phase' | 'pipeline' | 'workflow', id: string) {
  return harness.service.deactivate({
    kind,
    id,
    expectedDraftVersion: await tokenOf(harness.store, kind, id)
  });
}

describe('deactivating an Active definition with no draft', () => {
  it('leaves the entry in Draft, carrying the version that was live (FR-024a)', async () => {
    const body = phaseBody('plan');
    const activeVersionId = await seedActive(harness, 'phase', 'plan', body);

    const outcome = await deactivate('phase', 'plan');

    expect(outcome).toEqual({
      outcome: 'deactivated',
      state: 'draft',
      draftVersionId: activeVersionId,
      advisories: []
    });
    const entry = entryOf(harness.fs, 'phase', 'plan');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.draftVersionId).toBe(activeVersionId);
    expect(entry.activeVersionId).toBeNull();
    // Derived rather than asserted as a literal: the state a surface will show is
    // the one the shared projection reads out of this entry.
    expect(deriveDefinitionState(entry)).toBe('draft');
    // The draft the operator now holds is the body that was running.
    expect((await definitionOf(harness.store, 'phase', 'plan'))?.draftBody).toEqual(body);
  });

  it('writes no new version record and removes nothing', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    harness.fs.calls.length = 0;

    expect((await deactivate('phase', 'plan')).outcome).toBe('deactivated');

    // One manifest write and nothing else. A record write here would grow history
    // every time a definition is parked; a remove would take the history away.
    expect(harness.fs.writeCalls.map((call) => call.key)).toEqual(['manifest.json']);
    expect(harness.fs.callsOf('remove')).toEqual([]);
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1']);
  });

  it('drops out of the effective catalog while it is out of service (FR-007)', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'phase', 'build', phaseBody('build'));

    expect((await deactivate('phase', 'plan')).outcome).toBe('deactivated');

    // `storedRows` is what the three resolvers read, so this is the claim that the
    // definition has stopped being triggerable — not merely that a pointer moved.
    const rows = storedRows(await snapshotOf(harness.store), 'phase');
    expect(rows).toEqual([phaseBody('build')]);
  });
});

describe('and publishing it again makes it live at the same version (FR-027)', () => {
  it('completes the round trip through the ordinary publication path', async () => {
    const activeVersionId = await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const publishedAt = entryOf(harness.fs, 'phase', 'plan')?.versions[0]?.publishedAt ?? null;
    expect(publishedAt).not.toBeNull();

    expect((await deactivate('phase', 'plan')).outcome).toBe('deactivated');
    // Time passes while the definition sits out of service, so a re-stamped
    // `publishedAt` would be visibly different rather than coincidentally equal.
    harness.clock.advance(60_000);
    const republished = await publish(harness, 'phase', 'plan');

    expect(republished).toBe(activeVersionId);
    const entry = entryOf(harness.fs, 'phase', 'plan');
    expect(entry?.activeVersionId).toBe(activeVersionId);
    expect(entry?.draftVersionId).toBeNull();
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual([activeVersionId]);
    // The same immutable version it always was: `publishedAt` is stamped once, by
    // the publication that first promoted it (FR-020).
    expect(entry?.versions[0]?.publishedAt).toBe(publishedAt);
    expect(storedRows(await snapshotOf(harness.store), 'phase')).toEqual([phaseBody('plan')]);
  });

  it('reports no pruning, there being nothing new to prune', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    expect((await deactivate('phase', 'plan')).outcome).toBe('deactivated');

    const outcome = await harness.service.publish({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
    });

    expect(outcome.outcome).toBe('published');
    if (outcome.outcome !== 'published') return;
    expect(outcome.pruned).toEqual([]);
  });

  it('refuses a second deactivation rather than clearing the entry (FR-005)', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    expect((await deactivate('phase', 'plan')).outcome).toBe('deactivated');

    const again = await deactivate('phase', 'plan');

    expect(again.outcome).toBe('refused');
    if (again.outcome !== 'refused') return;
    // The guard that keeps a double-deactivate from producing the entry with
    // neither pointer set — which is what would break the round trip.
    expect(again.refusal.reason).toBe('not-active');
    expect(again.refusal.current.state).toBe('draft');
    expect(entryOf(harness.fs, 'phase', 'plan')?.draftVersionId).toBe('v1');
  });
});

describe('deactivating a definition that already has a draft', () => {
  it('leaves the pending edit where it is and retains the version that was live', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const draftVersionId = await draft(
      harness,
      'phase',
      'plan',
      phaseBody('plan', { instruction: 'Plan it differently.' })
    );

    const outcome = await deactivate('phase', 'plan');

    expect(outcome).toEqual({
      outcome: 'deactivated',
      state: 'draft',
      // The draft pointer is not overwritten with the version that was live: that
      // would silently discard the operator's unfinished edit.
      draftVersionId,
      advisories: []
    });
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2']);
    expect(entryOf(harness.fs, 'phase', 'plan')?.activeVersionId).toBeNull();
  });

  it('publishes the pending edit on the way back, not the version that was live', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    const edited = phaseBody('plan', { instruction: 'Plan it differently.' });
    const draftVersionId = await draft(harness, 'phase', 'plan', edited);
    expect((await deactivate('phase', 'plan')).outcome).toBe('deactivated');

    expect(await publish(harness, 'phase', 'plan')).toBe(draftVersionId);

    expect(storedRows(await snapshotOf(harness.store), 'phase')).toEqual([edited]);
    // v1 is still readable — deactivation and republication both delete nothing.
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2']);
  });
});
