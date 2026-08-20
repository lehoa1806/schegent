// Feature 100 (FR-R3-016) T514c — restore is a *draft write*, not a rollback.
//
// The distinction is the whole subject. A rollback would move the active pointer
// backwards and an operator would discover the change by watching a run behave
// differently; a restore copies an old body into a new draft and changes nothing
// that runs until the ordinary publication gate lets it (FR-029, FR-030).
//
// Five claims:
//
//   - **Only the body travels.** `createdAt`, `publishedAt`, and `note` belong to
//     the version the body came from. Copied forward, they would attribute this
//     write's time to the original write and the original operator's words to
//     whoever pressed restore.
//   - **The active pointer does not move**, and the effective catalog keeps
//     serving what it was serving.
//   - **Every intermediate version is still readable.** Restoring to v1 from v3 is
//     not a truncation of history: v2 and v3 are still there and still readable,
//     which is what makes the restore itself undoable.
//   - **A pending draft is replaced under the token** (FR-029a, FR-029b). Replaced,
//     not merged and not coexisted-with — and the replaced draft's record stays on
//     disk, so the operator has not lost the edit, only the pointer to it.
//   - **An absent or corrupt source creates no draft** (FR-031). The source is read
//     *before* anything is written, so this is a property of the ordering rather
//     than of a cleanup path — there is no cleanup path here, on any operation.

import { beforeEach, describe, expect, it } from 'vitest';

import { storedRows } from '../../../src/catalog';
import { versionSegments } from '../../../src/catalog/catalog-paths';
import { NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import {
  createLifecycleHarness,
  definitionOf,
  draft,
  entryOf,
  phaseBody,
  publish,
  snapshotOf,
  tokenOf,
  versionIdsOf,
  type LifecycleHarness
} from '../../fixtures/catalog-lifecycle-harness';

const V1 = phaseBody('plan', { instruction: 'One.' });
const V2 = phaseBody('plan', { instruction: 'Two.' });
const V3 = phaseBody('plan', { instruction: 'Three.' });

let harness: LifecycleHarness;

beforeEach(() => {
  harness = createLifecycleHarness();
});

/** Three published versions of one Phase, oldest first. */
async function threeVersions(): Promise<void> {
  for (const body of [V1, V2, V3]) {
    await draft(harness, 'phase', 'plan', body);
    await publish(harness, 'phase', 'plan');
    harness.clock.advance(1_000);
  }
}

async function restore(fromVersionId: string) {
  return harness.service.restore({
    kind: 'phase',
    id: 'plan',
    fromVersionId,
    expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
  });
}

describe('a restore copies a body into a new draft (FR-029, FR-030)', () => {
  it('writes the old body as the next version and leaves the active pointer alone', async () => {
    await threeVersions();

    const outcome = await restore('v1');

    expect(outcome).toEqual({
      outcome: 'restored',
      draftVersionId: 'v4',
      fromVersionId: 'v1',
      replacedDraftVersionId: null
    });
    const definition = await definitionOf(harness.store, 'phase', 'plan');
    expect(definition?.draftBody).toEqual(V1);
    // What runs is still v3. A restore that moved this pointer would change
    // behaviour with no publication and no confirmation.
    expect(definition?.activeVersionId).toBe('v3');
    expect(definition?.body).toEqual(V3);
    expect(storedRows(await snapshotOf(harness.store), 'phase')).toEqual([V3]);
  });

  it('carries none of the source version\'s metadata forward', async () => {
    await threeVersions();
    harness.clock.advance(5_000);
    const now = harness.clock.nowMs();

    expect((await restore('v1')).outcome).toBe('restored');

    const versions = entryOf(harness.fs, 'phase', 'plan')?.versions ?? [];
    const source = versions.find((version) => version.versionId === 'v1');
    const restored = versions.find((version) => version.versionId === 'v4');
    expect(restored?.createdAt).toBe(now);
    expect(restored?.createdAt).not.toBe(source?.createdAt);
    // Never published, so never stamped — and the operator's note on the original
    // write is not this write's note.
    expect(restored?.publishedAt).toBeNull();
    expect(restored?.note).toBeNull();
    // The bodies are identical, so the hashes must be. That is the one field that
    // *should* match: it is a property of the body, not of the write.
    expect(restored?.contentHash).toBe(source?.contentHash);
  });

  it('leaves every intermediate version readable', async () => {
    await threeVersions();

    expect((await restore('v1')).outcome).toBe('restored');

    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2', 'v3', 'v4']);
    for (const [versionId, body] of [
      ['v1', V1],
      ['v2', V2],
      ['v3', V3],
      ['v4', V1]
    ] as const) {
      const read = await harness.store.readVersion('phase', 'plan', versionId);
      expect(read.outcome, `${versionId} should still be readable`).toBe('read');
      if (read.outcome !== 'read') continue;
      expect(read.record.body).toEqual(body);
    }
  });

  it('becomes live only through an ordinary publication', async () => {
    await threeVersions();
    expect((await restore('v1')).outcome).toBe('restored');

    expect(await publish(harness, 'phase', 'plan')).toBe('v4');

    expect(storedRows(await snapshotOf(harness.store), 'phase')).toEqual([V1]);
    expect(entryOf(harness.fs, 'phase', 'plan')?.draftVersionId).toBeNull();
  });
});

describe('a pending draft is replaced under the token (FR-029a, FR-029b)', () => {
  it('names the draft it replaced and keeps that draft\'s record on disk', async () => {
    await threeVersions();
    const pending = await draft(harness, 'phase', 'plan', phaseBody('plan', { name: 'Pending' }));

    const outcome = await restore('v1');

    expect(outcome).toEqual({
      outcome: 'restored',
      draftVersionId: 'v5',
      fromVersionId: 'v1',
      replacedDraftVersionId: pending
    });
    // Named history rather than something destroyed: nothing is deleted here, so
    // the replaced draft is still a version the operator can restore from.
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    expect(harness.fs.callsOf('remove')).toEqual([]);
    const replaced = await harness.store.readVersion('phase', 'plan', pending);
    expect(replaced.outcome).toBe('read');
  });

  it('refuses against a stale token rather than discarding the edit it cannot see', async () => {
    await threeVersions();
    const pending = await draft(harness, 'phase', 'plan', phaseBody('plan', { name: 'Pending' }));
    harness.fs.calls.length = 0;

    const outcome = await harness.service.restore({
      kind: 'phase',
      id: 'plan',
      fromVersionId: 'v1',
      // The view this caller last saw: before the draft existed.
      expectedDraftVersion: NO_DRAFT
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('stale-draft');
    // Actionable: the token the next attempt must carry, freshly read.
    expect(outcome.refusal.current.expectedDraftVersion).toBe(pending);
    expect(harness.fs.writeCalls).toEqual([]);
  });
});

describe('an unreadable source creates no draft (FR-031)', () => {
  it('refuses a version the manifest does not name', async () => {
    await threeVersions();
    harness.fs.calls.length = 0;

    const outcome = await restore('v9');

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('version-unreadable');
    expect(harness.fs.writeCalls).toEqual([]);
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2', 'v3']);
    expect(entryOf(harness.fs, 'phase', 'plan')?.draftVersionId).toBeNull();
  });

  it('refuses a version whose record is gone, without repairing the manifest', async () => {
    await threeVersions();
    harness.fs.unlink(versionSegments('phase', 'plan', 'v1'));
    harness.fs.calls.length = 0;

    const outcome = await restore('v1');

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('version-unreadable');
    expect(harness.fs.writeCalls).toEqual([]);
    // The manifest still names v1. A store that quietly rewrote the entry to hide
    // the dangling record would erase the fault the integrity scan reports (FR-031).
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2', 'v3']);
  });

  it('refuses a version whose record no longer hashes to what the manifest recorded', async () => {
    await threeVersions();
    // Same path, different body: the record is present and corrupt, which is a
    // different failure from absent and must not be restorable either.
    harness.fs.seed(
      versionSegments('phase', 'plan', 'v1'),
      JSON.stringify({ versionId: 'v1', kind: 'phase', id: 'plan', body: phaseBody('plan', { instruction: 'Tampered.' }) })
    );
    harness.fs.calls.length = 0;

    const outcome = await restore('v1');

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('version-unreadable');
    expect(harness.fs.writeCalls).toEqual([]);
    expect(entryOf(harness.fs, 'phase', 'plan')?.draftVersionId).toBeNull();
  });

  it('refuses a definition with no entry at all', async () => {
    const outcome = await harness.service.restore({
      kind: 'phase',
      id: 'never-existed',
      fromVersionId: 'v1',
      expectedDraftVersion: NO_DRAFT
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('no-definition');
    expect(outcome.refusal.legalActions).toEqual(['save-draft']);
  });

  it('restores a definition that is out of service, the source being history and not the pointer', async () => {
    await threeVersions();
    const deactivated = await harness.service.deactivate({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
    });
    expect(deactivated.outcome).toBe('deactivated');

    const outcome = await restore('v1');

    expect(outcome.outcome).toBe('restored');
    if (outcome.outcome !== 'restored') return;
    // The deactivation had put v3 on the draft pointer; the restore replaced that
    // pointer and, as ever, kept the record.
    expect(outcome.replacedDraftVersionId).toBe('v3');
    expect((await definitionOf(harness.store, 'phase', 'plan'))?.draftBody).toEqual(V1);
    expect(entryOf(harness.fs, 'phase', 'plan')?.activeVersionId).toBeNull();
  });
});
