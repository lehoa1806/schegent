// Feature 100 (FR-R3-016) T512 — import presence sees a Draft; the effective
// catalog does not.
//
// Two rules that pull in opposite directions on the same definition, which is why
// they are pinned together in one file rather than apart in two:
//
//   FR-007 — the effective catalog is the set of ACTIVE versions. A definition
//   holding only an unpublished draft has no active version, so nothing that
//   decides what runs may see it. `storedRows` must omit its body.
//
//   FR-043/FR-044 — import presence is resolved against stored definitions at
//   EVERY state, Draft included, and an import must never overwrite an operator's
//   unpublished draft. `storedIds` must return its id.
//
// The failure this rules out is specific and silent. Before feature 100 every
// stored definition had an active body, so "the rows" and "the definitions" were
// the same list and one selector answered both questions. FR-006 splits them. A
// presence scan left reading rows alone would report a draft-only definition as
// absent and plan `import` over the top of work the operator has not finished —
// the exact case the presence rule was written for, arriving through the one door
// the rule's original wording did not name.
//
// This is a lint in the sense the other files here are: it pins a property of the
// production wiring, not of a scenario. The catalog and preflight tests exercise
// the behaviour; this file exists so that removing the id oracle fails loudly
// rather than turning skips into overwrites.

import { describe, expect, it } from 'vitest';
import { storedIds, storedRows } from '../../src/catalog';
import {
  findPhaseIdPresence,
  findPipelineIdPresence,
  findWorkflowIdPresence
} from '../../src/services/process-yaml/import-planner';
import type {
  CatalogKind,
  CatalogSnapshot,
  StoredDefinition
} from '../../src/contracts/catalog-store';
import type { PhaseSourceRecord } from '../../src/contracts/process-definitions';
import type { PipelineSourceRecord } from '../../src/contracts/pipeline-definitions';
import type { WorkflowSourceRecord } from '../../src/contracts/workflow-definitions';

const ACTIVE_ID = 'ship-it';
const DRAFT_ONLY_ID = 'half-written';
const INVALID_ID = 'being-repaired';

function definition(overrides: Partial<StoredDefinition> & { readonly id: string }): StoredDefinition {
  return {
    kind: 'phase',
    status: 'effective',
    activeVersionId: 'v1',
    body: { phaseId: overrides.id },
    draftVersionId: null,
    draftBody: null,
    createdAt: 1,
    updatedAt: 1,
    versions: [],
    ...overrides
  };
}

/**
 * One kind's three interesting states in one snapshot.
 *
 * `DRAFT_ONLY_ID` is the case under test: a definition the operator created,
 * saved as a draft, and has not published. Per FR-006 it has a `draftVersionId`
 * and a `draftBody`, and — this is the whole point — `activeVersionId: null` and
 * `body: null`, because there is no active version behind it yet.
 */
function snapshotOf(kind: CatalogKind): CatalogSnapshot {
  return {
    storeFormatVersion: 1,
    definitions: [
      definition({ kind, id: ACTIVE_ID }),
      definition({
        kind,
        id: DRAFT_ONLY_ID,
        activeVersionId: null,
        body: null,
        draftVersionId: 'v1',
        draftBody: { note: 'not published yet' }
      }),
      definition({ kind, id: INVALID_ID, status: 'invalid', activeVersionId: 'v1', body: null })
    ],
    faults: [],
    collectable: [],
    revisions: { phase: 'r1', pipeline: 'r1', workflow: 'r1' }
  };
}

const KINDS: readonly CatalogKind[] = ['phase', 'pipeline', 'workflow'];

describe('Feature 100 T512 — the two halves of the stored-definition selectors', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      const snapshot = snapshotOf(kind);

      it('storedIds returns the draft-only entry (FR-043)', () => {
        expect(storedIds(snapshot, kind).has(DRAFT_ONLY_ID)).toBe(true);
      });

      it('storedIds returns every entry at every state, not only the readable ones', () => {
        expect([...storedIds(snapshot, kind)].sort()).toEqual(
          [ACTIVE_ID, DRAFT_ONLY_ID, INVALID_ID].sort()
        );
      });

      it('storedRows omits the draft-only entry body (FR-007)', () => {
        const bodies = storedRows(snapshot, kind);
        // The active definition contributes; neither the draft-only entry nor the
        // unreadable one does. Asserted by count AND by content so a selector that
        // substituted `draftBody` for a missing `body` — the tempting one-line
        // "fix" that would put unpublished work into the effective catalog —
        // fails here.
        expect(bodies).toHaveLength(1);
        expect(bodies).toEqual([{ phaseId: ACTIVE_ID }]);
      });

      it('the draft body never appears in the effective projection', () => {
        expect(JSON.stringify(storedRows(snapshot, kind))).not.toContain('not published yet');
      });

      it('the two selectors differ by exactly the definitions with no active body', () => {
        // The relationship, stated once: `storedIds` is a superset of the row ids,
        // and the difference is not empty in this snapshot. A change that made
        // them agree would satisfy every per-selector assertion above about the
        // one it kept and still break the rule.
        const ids = storedIds(snapshot, kind);
        const rowIds = new Set(
          storedRows(snapshot, kind).map((row) => (row as { phaseId: string }).phaseId)
        );
        for (const rowId of rowIds) expect(ids.has(rowId)).toBe(true);
        expect(ids.size).toBeGreaterThan(rowIds.size);
      });
    });
  }
});

describe('Feature 100 T512 — the presence oracles read both halves (FR-044)', () => {
  const phaseRows: readonly PhaseSourceRecord[] = [
    { phaseId: ACTIVE_ID, status: 'effective' } as PhaseSourceRecord
  ];
  const pipelineRows: readonly PipelineSourceRecord[] = [
    { pipelineId: ACTIVE_ID, status: 'effective' } as PipelineSourceRecord
  ];
  const workflowRows: readonly WorkflowSourceRecord[] = [
    { workflowId: ACTIVE_ID, status: 'effective' } as WorkflowSourceRecord
  ];
  const ids: ReadonlySet<string> = new Set([ACTIVE_ID, DRAFT_ONLY_ID]);

  // One table for three oracles, because the property is the same in all three
  // catalogs and stating it three times invites two of them to drift.
  const ORACLES = [
    { kind: 'phase', find: (id: string) => findPhaseIdPresence(phaseRows, id, ids) },
    { kind: 'pipeline', find: (id: string) => findPipelineIdPresence(pipelineRows, id, ids) },
    { kind: 'workflow', find: (id: string) => findWorkflowIdPresence(workflowRows, id, ids) }
  ] as const;

  for (const oracle of ORACLES) {
    describe(oracle.kind, () => {
      it('a draft-only id is present, and reports as a draft', () => {
        // Not `null`: an import of this id must plan as a skip, never as a write
        // over the operator's unpublished work (FR-044).
        expect(oracle.find(DRAFT_ONLY_ID)).toEqual({ status: 'draft' });
      });

      it('a row-backed id still reports its own status, not "draft"', () => {
        // The id set contains it too, so an oracle that consulted the set FIRST
        // would answer `draft` for every present id and lose the distinction the
        // skip row shows the operator.
        expect(oracle.find(ACTIVE_ID)).toEqual({ status: 'effective' });
      });

      it('an id the store does not hold is absent', () => {
        expect(oracle.find('never-heard-of-it')).toBeNull();
      });

      it('presence is not answered by the rows alone', () => {
        // The regression guard. With an empty id set — which is what a caller that
        // forgot to supply one would produce — the draft-only id goes missing, and
        // that is precisely the failure this task exists to prevent.
        expect(findPhaseIdPresence(phaseRows, DRAFT_ONLY_ID, new Set())).toBeNull();
      });
    });
  }
});
