// FR-025 — an `invalid` Pipeline holds a reference that blocks, and now it does.
//
// `authoredPhaseIds()` in `definition-semantics.ts` reads `display['phases']` for a
// Pipeline that failed validation, under a comment stating the reason: "its defects
// are corrected and the reference goes live, and a Phase deleted out from under it in
// the meantime would leave it permanently unfixable". Its `Array.isArray` guard could
// never be true, because `display` admitted scalars only and dropped every list. So
// the branch was dead and an invalid Pipeline blocked nothing.
//
// WHY THE SNAPSHOT IS BUILT HERE rather than through the lifecycle harness: the
// publish gate refuses an invalid body, so a Pipeline can only become invalid *while
// active* out of band — a hand-edited catalog record, or a merge. That is a stored
// body the store hands over as-is, which is exactly what a `StoredDefinition` with an
// `invalid` status and an unvalidatable `body` is. `referencesTo` is called directly,
// the same way the lifecycle service calls it through the port.

import { describe, expect, it } from 'vitest';

import { createDefinitionSemantics } from '../../../src/config/definition-semantics';
import { validatePipelineDefinition } from '../../../src/config/pipeline-definition-validator';
import type { CatalogKind, CatalogSnapshot, StoredDefinition } from '../../../src/contracts/catalog-store';

const NO_DEFAULT_PIPELINE = { defaultPipelineId: () => '' };

function storedDefinition(kind: CatalogKind, id: string, body: unknown): StoredDefinition {
  return {
    kind,
    id,
    // Every row here is live. A draft-only definition has a null `body` and drops
    // out of the referential scan by design (FR-007), which would make this suite
    // pass for the wrong reason.
    status: 'effective',
    activeVersionId: `${kind}-${id}-v1`,
    body,
    draftVersionId: null,
    draftBody: null,
    createdAt: 0,
    updatedAt: 0,
    versions: []
  };
}

function snapshotOf(...definitions: readonly StoredDefinition[]): CatalogSnapshot {
  return {
    storeFormatVersion: 1,
    definitions,
    faults: [],
    collectable: [],
    revisions: { phase: 'r1', pipeline: 'r1', workflow: 'r1' }
  };
}

/** Valid, and it names `plan` at position 0. */
const VALID_PIPELINE = {
  id: 'ship-it',
  name: 'Ship It',
  version: 1,
  phases: ['plan']
};

/**
 * The same reference, in a body that does not validate.
 *
 * An empty `name` fails `invalid-length`, so there is no parsed definition and
 * `display` is the only place the phase list survives.
 */
const INVALID_PIPELINE = { ...VALID_PIPELINE, name: '' };

const PHASE = { id: 'plan', name: 'Plan', version: 1, instruction: 'Plan it.' };

describe('a Phase referenced only by an invalid Pipeline cannot be deleted', () => {
  it('names the invalid Pipeline as a blocker, with the position of the reference', () => {
    const semantics = createDefinitionSemantics(NO_DEFAULT_PIPELINE);
    const snapshot = snapshotOf(
      storedDefinition('phase', 'plan', PHASE),
      storedDefinition('pipeline', 'ship-it', INVALID_PIPELINE)
    );

    // The control: this Pipeline really is invalid, or the test is asserting the
    // ordinary definition path under a misleading name.
    expect(
      validatePipelineDefinition(INVALID_PIPELINE).errors.length,
      'the fixture Pipeline must fail validation'
    ).toBeGreaterThan(0);

    expect(semantics.referencesTo(snapshot, 'phase', 'plan')).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[0]' }
    ]);
  });

  it('reports the same blocker whether the Pipeline validates or not', () => {
    const semantics = createDefinitionSemantics(NO_DEFAULT_PIPELINE);
    const blockersFor = (body: unknown) =>
      semantics.referencesTo(
        snapshotOf(
          storedDefinition('phase', 'plan', PHASE),
          storedDefinition('pipeline', 'ship-it', body)
        ),
        'phase',
        'plan'
      );

    // The point of the rule: a broken Pipeline is one the operator is going to fix,
    // and the reference it holds is no weaker for being unparsed today.
    expect(blockersFor(INVALID_PIPELINE)).toEqual(blockersFor(VALID_PIPELINE));
  });

  it('reads the position out of the authored list, not the order of the rows', () => {
    const semantics = createDefinitionSemantics(NO_DEFAULT_PIPELINE);
    const snapshot = snapshotOf(
      storedDefinition('phase', 'plan', PHASE),
      storedDefinition('pipeline', 'ship-it', {
        ...INVALID_PIPELINE,
        phases: ['build', 'plan']
      })
    );

    // `phaseIds[1]` is what turns "something references it" into an edit, so it has
    // to be the authored index and not a counter.
    expect(semantics.referencesTo(snapshot, 'phase', 'plan')).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[1]' }
    ]);
  });

  it('reads the portable `phaseIds` spelling as well as the legacy `phases`', () => {
    const semantics = createDefinitionSemantics(NO_DEFAULT_PIPELINE);
    const snapshot = snapshotOf(
      storedDefinition('phase', 'plan', PHASE),
      // `phaseIds` is the portable key and the one the validator prefers. This scan
      // read only the legacy `phases`, so a Pipeline authored the recommended way
      // blocked nothing at all.
      storedDefinition('pipeline', 'ship-it', {
        id: 'ship-it',
        name: '',
        version: 1,
        phaseIds: ['plan']
      })
    );

    expect(semantics.referencesTo(snapshot, 'phase', 'plan')).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[0]' }
    ]);
  });

  it('blocks on a reference held only by the losing key of an ambiguous body', () => {
    const semantics = createDefinitionSemantics(NO_DEFAULT_PIPELINE);
    const snapshot = snapshotOf(
      storedDefinition('phase', 'plan', PHASE),
      // Both spellings is `sequence-ambiguous`, and the operator resolves it by
      // deleting one key — either one. A reference found only in the key that loses
      // precedence today is still live the moment they keep that one instead.
      storedDefinition('pipeline', 'ship-it', {
        id: 'ship-it',
        name: 'Ship It',
        version: 1,
        phaseIds: ['build'],
        phases: ['plan']
      })
    );

    expect(semantics.referencesTo(snapshot, 'phase', 'plan')).toEqual([
      { kind: 'pipeline', id: 'ship-it', field: 'phaseIds[0]' }
    ]);
  });

  it('blocks nothing for a Pipeline too malformed to recover a phase list from', () => {
    const semantics = createDefinitionSemantics(NO_DEFAULT_PIPELINE);
    const snapshot = snapshotOf(
      storedDefinition('phase', 'plan', PHASE),
      // A `phases` of objects is not a list of ids. `display` declines to answer
      // rather than answering `[]`, and there is no reference to report either way:
      // the operator has to rewrite this row before it can name anything.
      storedDefinition('pipeline', 'ship-it', {
        ...INVALID_PIPELINE,
        phases: [{ phaseId: 'plan' }]
      })
    );

    expect(semantics.referencesTo(snapshot, 'phase', 'plan')).toEqual([]);
  });
});
