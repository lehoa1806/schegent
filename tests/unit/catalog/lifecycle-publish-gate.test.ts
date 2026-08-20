// Feature 100 (FR-R3-016) T514a — validate, then move. Never one without the other.
//
// Four claims, each with a wrong implementation it exists to catch:
//
//   - **Every defect, not the first** (FR-019, SC-003). A gate that returns on the
//     first bad reference sends an operator round the loop once per defect, so the
//     refusal here is asserted to name *both* broken bindings with their positions.
//   - **A refused publication moves nothing** (FR-016). Not "moves it back" — a
//     validation failure must happen before the write, so the assertion is that the
//     filesystem port saw no write at all, not that the pointers were restored.
//   - **The union carve-out admits a self-contained set** (FR-017). A Pipeline
//     binding a Phase that arrives with it validates against what the publication
//     is about to make live. Both halves are pinned: the same Pipeline published
//     *alone* against a Phase that is only drafted is refused, and published *with*
//     it is not. Without the negative half the positive one would also pass against
//     a gate that validated nothing.
//   - **No draft is a refusal, not a no-op** (FR-023). "Nothing to publish" and
//     "published" are indistinguishable to a caller that treats the first as
//     success, and the state a surface then shows is a definition it believes it
//     just made live.
//
// The gate is the real `DefinitionSemantics` adapter over the real three resolvers,
// so a defect reported here is a defect the Builder reports too (FR-017).

import { beforeEach, describe, expect, it } from 'vitest';

import { publishPackage } from '../../../src/catalog';
import { NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import {
  createLifecycleHarness,
  draft,
  entryOf,
  phaseBody,
  pipelineBody,
  revisionOf,
  seedActive,
  tokenOf,
  versionIdsOf,
  type LifecycleHarness
} from '../../fixtures/catalog-lifecycle-harness';

let harness: LifecycleHarness;

beforeEach(() => {
  harness = createLifecycleHarness();
});

describe('a candidate that does not validate is refused with every defect (FR-019)', () => {
  it('names more than one defect, each with the position it sits at', async () => {
    // One Pipeline, two broken bindings. A first-defect-wins gate passes every
    // single-defect test ever written, which is why this one has two.
    await draft(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['ghost-one', 'ghost-two']));

    const outcome = await harness.service.publish({
      kind: 'pipeline',
      id: 'ship-it',
      expectedDraftVersion: await tokenOf(harness.store, 'pipeline', 'ship-it')
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('validation-failed');
    expect(outcome.refusal.defects).toEqual([
      {
        kind: 'pipeline',
        id: 'ship-it',
        field: 'phaseIds[0]',
        code: 'unknown-phase',
        message: expect.stringContaining('ghost-one')
      },
      {
        kind: 'pipeline',
        id: 'ship-it',
        field: 'phaseIds[1]',
        code: 'unknown-phase',
        message: expect.stringContaining('ghost-two')
      }
    ]);
  });

  it('reports the state the operator is actually in, and what they can do from it', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    const activeVersionId = entryOf(harness.fs, 'pipeline', 'ship-it')?.activeVersionId ?? null;
    const draftVersionId = await draft(
      harness,
      'pipeline',
      'ship-it',
      pipelineBody('ship-it', ['ghost'])
    );

    const outcome = await harness.service.publish({
      kind: 'pipeline',
      id: 'ship-it',
      expectedDraftVersion: draftVersionId
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    // Freshly read, and carrying the token the next attempt has to use — a refusal
    // an operator can act on without re-reading and guessing.
    expect(outcome.refusal.current).toEqual({
      kind: 'pipeline',
      id: 'ship-it',
      state: 'active-with-draft',
      draftVersionId,
      activeVersionId,
      expectedDraftVersion: draftVersionId
    });
    expect(outcome.refusal.legalActions).toEqual([
      'save-draft',
      'publish',
      'deactivate',
      'restore',
      'discard-draft'
    ]);
  });
});

describe('a refused publication moves nothing (FR-016)', () => {
  it('leaves both pointers, the version list, and the revision exactly as they were', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    const draftVersionId = await draft(
      harness,
      'pipeline',
      'ship-it',
      pipelineBody('ship-it', ['plan', 'ghost'])
    );
    const before = entryOf(harness.fs, 'pipeline', 'ship-it');
    const revisionBefore = await revisionOf(harness.store, 'pipeline');
    harness.fs.calls.length = 0;

    const outcome = await harness.service.publish({
      kind: 'pipeline',
      id: 'ship-it',
      expectedDraftVersion: draftVersionId
    });

    expect(outcome.outcome).toBe('refused');
    // Not "moved back" — never moved. A gate that writes and then compensates would
    // pass a pointer assertion and fail this one.
    expect(harness.fs.writeCalls).toEqual([]);
    expect(harness.fs.callsOf('remove')).toEqual([]);
    expect(entryOf(harness.fs, 'pipeline', 'ship-it')).toEqual(before);
    expect(await revisionOf(harness.store, 'pipeline')).toBe(revisionBefore);
  });

  it('leaves the effective catalog serving the version that was already live', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await draft(harness, 'phase', 'plan', 'not a phase at all');

    const outcome = await harness.service.publish({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: await tokenOf(harness.store, 'phase', 'plan')
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.defects?.[0]?.code).toBe('unresolvable-body');
    // The broken draft stays a draft and its record stays on disk (nothing is ever
    // deleted here); what runs is untouched.
    expect(versionIdsOf(harness.fs, 'phase', 'plan')).toEqual(['v1', 'v2']);
    expect(entryOf(harness.fs, 'phase', 'plan')?.activeVersionId).toBe('v1');
  });
});

describe('the union carve-out admits a self-contained set (FR-017)', () => {
  it('refuses a Pipeline whose only Phase is still a Draft', async () => {
    // The negative half. A Draft is not part of the effective catalog (FR-007), so
    // on its own this Pipeline binds a Phase nothing can resolve.
    await draft(harness, 'phase', 'plan', phaseBody('plan'));
    await draft(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));

    const outcome = await harness.service.publish({
      kind: 'pipeline',
      id: 'ship-it',
      expectedDraftVersion: await tokenOf(harness.store, 'pipeline', 'ship-it')
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.defects?.map((defect) => defect.code)).toEqual(['unknown-phase']);
  });

  it('admits the same Pipeline when the Phase it binds arrives with it', async () => {
    // The same gate — `defectsOf` — over the whole document as one candidate set.
    // The Phase replaces nothing here; it is appended to the active rows for the
    // length of one call and persisted nowhere (FR-018).
    const outcome = await publishPackage(
      { store: harness.store, semantics: harness.semantics },
      {
        layers: [
          {
            kind: 'phase',
            definitions: [{ id: 'plan', body: phaseBody('plan') }],
            expectedRevision: await revisionOf(harness.store, 'phase')
          },
          {
            kind: 'pipeline',
            definitions: [{ id: 'ship-it', body: pipelineBody('ship-it', ['plan']) }],
            expectedRevision: await revisionOf(harness.store, 'pipeline')
          }
        ]
      }
    );

    expect(outcome).toEqual({
      outcome: 'published',
      published: [
        { kind: 'phase', ids: ['plan'] },
        { kind: 'pipeline', ids: ['ship-it'] }
      ],
      pruned: []
    });
    expect(entryOf(harness.fs, 'pipeline', 'ship-it')?.activeVersionId).toBe('v1');
  });

  it('still refuses a set that is not self-contained', async () => {
    // The carve-out is a union with the *candidates*, not a suspension of the rule:
    // a Phase the document does not carry is still unknown.
    const outcome = await publishPackage(
      { store: harness.store, semantics: harness.semantics },
      {
        layers: [
          {
            kind: 'phase',
            definitions: [{ id: 'plan', body: phaseBody('plan') }],
            expectedRevision: await revisionOf(harness.store, 'phase')
          },
          {
            kind: 'pipeline',
            definitions: [{ id: 'ship-it', body: pipelineBody('ship-it', ['plan', 'ghost']) }],
            expectedRevision: await revisionOf(harness.store, 'pipeline')
          }
        ]
      }
    );

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('validation-failed');
    expect(outcome.refusal.defects.map((defect) => defect.field)).toEqual(['phaseIds[1]']);
    // Nothing was written, so the Phase that *was* valid is not live either.
    expect(harness.fs.writeCalls).toEqual([]);
  });
});

describe('no draft is refused, not treated as a no-op (FR-023)', () => {
  it('refuses to publish an Active definition with nothing pending', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    harness.fs.calls.length = 0;

    const outcome = await harness.service.publish({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: NO_DRAFT
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('no-draft');
    expect(outcome.refusal.current.state).toBe('active');
    expect(outcome.refusal.legalActions).toEqual(['save-draft', 'deactivate', 'restore']);
    expect(harness.fs.writeCalls).toEqual([]);
  });

  it('says no-draft rather than stale-draft when the token is also wrong', async () => {
    // Order matters for the message the operator reads: there is no draft to be
    // stale, and "stale draft" would send them looking for an edit that does not
    // exist.
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));

    const outcome = await harness.service.publish({
      kind: 'phase',
      id: 'plan',
      expectedDraftVersion: 'v7'
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('no-draft');
  });

  it('refuses a definition the manifest does not hold at all', async () => {
    const outcome = await harness.service.publish({
      kind: 'phase',
      id: 'never-existed',
      expectedDraftVersion: NO_DRAFT
    });

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('no-definition');
    expect(outcome.refusal.current.state).toBeNull();
    expect(outcome.refusal.legalActions).toEqual(['save-draft']);
  });
});
