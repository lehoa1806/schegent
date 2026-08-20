// Feature 100 (FR-R3-016) T514b — what stops a definition leaving service, and what
// only warns about it.
//
// The three claims, and why each is the one worth pinning:
//
//   - **Every blocker, not the first** (FR-025). Two active Pipelines binding one
//     Phase is two things the operator has to fix, and a refusal naming one of them
//     is a refusal they will hit twice. The positions are named too, because
//     `phaseIds[1]` is what turns "something references it" into an edit.
//   - **A Draft's reference is an advisory, never a blocker** (FR-025a). A Draft
//     cannot be triggered, so it cannot break a run; and the publish gate catches
//     its missing reference at the moment that matters. The distinction is
//     load-bearing in both directions — an advisory that blocked would make a
//     definition unremovable because of an edit nobody finished, and a blocker
//     reported as an advisory would let a live reference dangle.
//   - **A configured default is reported and never edited** (FR-059, FR-060). Not
//     refused either: a stale setting must not pin a definition in service forever.
//
// Plus FR-025b, which is the shape of the answer rather than a third case: blockers
// are **direct** per kind. A Workflow above the Pipeline that binds a Phase is not
// named when the Phase is deactivated, because the Pipeline is the thing the
// operator can act on and fixing it revalidates the Workflow at its next
// publication.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createLifecycleHarness,
  draft,
  entryOf,
  phaseBody,
  pipelineBody,
  revisionOf,
  seedActive,
  tokenOf,
  workflowBody,
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

describe('an active reference blocks, and every one of them is named (FR-025)', () => {
  it('names more than one referencing Pipeline, each with the position of the reference', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'phase', 'build', phaseBody('build'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    await seedActive(harness, 'pipeline', 'hotfix', pipelineBody('hotfix', ['build', 'plan']));

    const outcome = await deactivate('phase', 'plan');

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('referenced');
    expect(outcome.refusal.blockers).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[0]' },
      { kind: 'pipeline', id: 'hotfix', field: 'phaseIds[1]' }
    ]);
  });

  it('moves no pointer and writes nothing when it refuses', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    const before = entryOf(harness.fs, 'phase', 'plan');
    const revisionBefore = await revisionOf(harness.store, 'phase');
    harness.fs.calls.length = 0;

    expect((await deactivate('phase', 'plan')).outcome).toBe('refused');

    expect(harness.fs.writeCalls).toEqual([]);
    expect(harness.fs.callsOf('remove')).toEqual([]);
    expect(entryOf(harness.fs, 'phase', 'plan')).toEqual(before);
    expect(await revisionOf(harness.store, 'phase')).toBe(revisionBefore);
  });

  it('names the Pipeline that binds the Phase and not the Workflow above it (FR-025b)', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    await seedActive(harness, 'workflow', 'release', workflowBody('release', 'ship-it'));

    const phaseOutcome = await deactivate('phase', 'plan');
    expect(phaseOutcome.outcome).toBe('refused');
    if (phaseOutcome.outcome !== 'refused') return;
    // Direct references only. The Workflow is real and it does depend on this
    // Phase transitively; naming it would name something the operator cannot edit
    // to unblock this deactivation.
    expect(phaseOutcome.refusal.blockers).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[0]' }
    ]);

    // One level up, the Workflow *is* the direct reference to the Pipeline.
    const pipelineOutcome = await deactivate('pipeline', 'ship-it');
    expect(pipelineOutcome.outcome).toBe('refused');
    if (pipelineOutcome.outcome !== 'refused') return;
    expect(pipelineOutcome.refusal.blockers).toEqual([
      { kind: 'workflow', id: 'release', field: 'nodes[0].pipelineId' }
    ]);
  });

  it('lets a Workflow leave service, nothing being able to reference one', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    await seedActive(harness, 'workflow', 'release', workflowBody('release', 'ship-it'));

    const outcome = await deactivate('workflow', 'release');

    expect(outcome.outcome).toBe('deactivated');
    if (outcome.outcome !== 'deactivated') return;
    expect(outcome.advisories).toEqual([]);
  });
});

describe('a reference held only by a Draft advises, and does not block (FR-025a)', () => {
  it('deactivates the Phase and reports the drafted Pipeline that names it', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    // Drafted and never published: it cannot be triggered, so it cannot be broken
    // by this deactivation in any way that matters today.
    await draft(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));

    const outcome = await deactivate('phase', 'plan');

    expect(outcome.outcome).toBe('deactivated');
    if (outcome.outcome !== 'deactivated') return;
    expect(outcome.advisories).toEqual([
      { advisory: 'draft-reference', kind: 'pipeline', id: 'ship-it' }
    ]);
    expect(entryOf(harness.fs, 'phase', 'plan')?.activeVersionId).toBeNull();
  });

  it('reports the drafted reference of a Pipeline whose live body no longer names it', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'phase', 'build', phaseBody('build'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['build']));
    // The pending edit adds the Phase back. The live version does not name it, so
    // this is an advisory and not a blocker — the same definition, two bodies.
    await draft(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['build', 'plan']));

    const outcome = await deactivate('phase', 'plan');

    expect(outcome.outcome).toBe('deactivated');
    if (outcome.outcome !== 'deactivated') return;
    expect(outcome.advisories).toEqual([
      { advisory: 'draft-reference', kind: 'pipeline', id: 'ship-it' }
    ]);
  });

  it('blocks rather than advising when the same definition references it both ways', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    await draft(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan'], { version: 2 }));

    const outcome = await deactivate('phase', 'plan');

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    // One thing to look at, reported once. Both a blocker and an advisory for the
    // same id would send the operator to the same file twice.
    expect(outcome.refusal.blockers).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[0]' }
    ]);
    expect(outcome.refusal.advisories ?? []).toEqual([]);
  });
});

describe('a configured default is reported and never edited (FR-059, FR-060)', () => {
  it('deactivates the Pipeline the setting names, and says so', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    // Set *after* the service was built, which is the ordering the port's getter
    // exists for (T509c): captured as a value, a default set after the window
    // opened would produce no advisory at all.
    harness.setDefaultPipelineId('ship-it');

    const outcome = await deactivate('pipeline', 'ship-it');

    expect(outcome.outcome).toBe('deactivated');
    if (outcome.outcome !== 'deactivated') return;
    expect(outcome.advisories).toEqual([
      { advisory: 'configured-default', kind: null, id: 'ship-it' }
    ]);
  });

  it('leaves the setting exactly as it found it', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    harness.setDefaultPipelineId('ship-it');

    expect((await deactivate('pipeline', 'ship-it')).outcome).toBe('deactivated');

    // Still named, so the operator's configuration was reported rather than
    // rewritten — a silent edit to a setting in a different store is the surprising
    // side effect FR-059 forbids. Asked through the port a second time so the claim
    // is about the value the host would read next, not about a local variable.
    const snapshot = await harness.store.read();
    if (snapshot.outcome !== 'read') throw new Error('store unreadable');
    expect(harness.semantics.advisoriesFor(snapshot.snapshot, 'pipeline', 'ship-it')).toEqual([
      { advisory: 'configured-default', kind: null, id: 'ship-it' }
    ]);
  });

  it('says nothing about a default naming some other Pipeline', async () => {
    await seedActive(harness, 'phase', 'plan', phaseBody('plan'));
    await seedActive(harness, 'pipeline', 'ship-it', pipelineBody('ship-it', ['plan']));
    await seedActive(harness, 'pipeline', 'hotfix', pipelineBody('hotfix', ['plan']));
    harness.setDefaultPipelineId('hotfix');

    const outcome = await deactivate('pipeline', 'ship-it');

    expect(outcome.outcome).toBe('deactivated');
    if (outcome.outcome !== 'deactivated') return;
    expect(outcome.advisories).toEqual([]);
  });
});
