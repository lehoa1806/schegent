// Feature 098 T008 — the freeze resolves containment from the declaration
// (FR-004, FR-005, FR-006, SC-005).
//
// Before this feature `snapshotPhaseDef` asked *which id is this* and answered
// from two lists: `BUILT_IN_PHASE_IDS` for scope, and `GIT_METADATA_WRITE_PHASE_IDS`
// underneath `builtInSideEffects`. A Phase the operator imported was therefore
// frozen `unrestricted` no matter what it declared, because it was not on the
// list — the least contained class, assigned by omission.
//
// After it, the freeze asks *what did this Phase declare* and falls back to a
// pair of literals. The values are written out here rather than imported from
// the module under test: a test that asserts `snapshot.sideEffects` equals
// whatever the module's own default constant says would still pass if the
// default were widened back to `unrestricted`, which is the single regression
// this file exists to catch.
//
// Two negative assertions carry as much weight as the positive ones. No case
// below sets `sourceScope`, and every declaring case uses an id the product does
// not recognise, so a reintroduced id list cannot make these tests pass.

import { describe, expect, it } from 'vitest';
import { snapshotPhaseDef } from '../../../src/config/pipeline-snapshot';
import type { PhaseDef } from '../../../src/config/pipeline-config';

/** An id no built-in list claims, so nothing can resolve it by name. */
const UNKNOWN_ID = 'fixture-imported-phase';

function phase(overrides: Partial<PhaseDef> & { readonly id?: string } = {}): PhaseDef {
  return {
    id: UNKNOWN_ID,
    name: 'Imported Phase',
    instruction: 'Do the imported thing.',
    ...overrides
  };
}

describe('snapshotPhaseDef — containment comes from the declaration (FR-004)', () => {
  it.each(['none', 'workspace', 'git', 'unrestricted'] as const)(
    'freezes the declared sideEffects %s under an id the product does not know',
    (declared) => {
      const snapshot = snapshotPhaseDef(phase({ sideEffects: declared }));
      expect(snapshot.sideEffects).toBe(declared);
    }
  );

  it.each(['required', 'best-effort', 'none'] as const)(
    'freezes the declared evidencePolicy %s under an id the product does not know',
    (declared) => {
      const snapshot = snapshotPhaseDef(phase({ evidencePolicy: declared }));
      expect(snapshot.evidencePolicy).toBe(declared);
    }
  );

  it('freezes both declarations together', () => {
    const snapshot = snapshotPhaseDef(phase({ sideEffects: 'git', evidencePolicy: 'best-effort' }));
    expect(snapshot.sideEffects).toBe('git');
    expect(snapshot.evidencePolicy).toBe('best-effort');
  });

  it('freezes a declaration made under a formerly-built-in id, rather than overriding it', () => {
    // `finalize` was one of the five ids `GIT_METADATA_WRITE_PHASE_IDS` claimed.
    // A Phase carrying that id and declaring `workspace` must freeze
    // `workspace`: the id is now just a name.
    const snapshot = snapshotPhaseDef(
      phase({ id: 'finalize', sideEffects: 'workspace', evidencePolicy: 'none' })
    );
    expect(snapshot.sideEffects).toBe('workspace');
    expect(snapshot.evidencePolicy).toBe('none');
  });
});

describe('snapshotPhaseDef — the defaults for an undeclared Phase (FR-005)', () => {
  it('freezes workspace and required when the Phase declares neither', () => {
    const snapshot = snapshotPhaseDef(phase());
    expect(snapshot.sideEffects).toBe('workspace');
    expect(snapshot.evidencePolicy).toBe('required');
  });

  it('defaults one field without disturbing the other', () => {
    const onlySideEffects = snapshotPhaseDef(phase({ sideEffects: 'none' }));
    expect(onlySideEffects.sideEffects).toBe('none');
    expect(onlySideEffects.evidencePolicy).toBe('required');

    const onlyEvidence = snapshotPhaseDef(phase({ evidencePolicy: 'none' }));
    expect(onlyEvidence.sideEffects).toBe('workspace');
    expect(onlyEvidence.evidencePolicy).toBe('none');
  });

  it('applies the same defaults whatever the id, including one a list used to claim', () => {
    for (const id of [UNKNOWN_ID, 'finalize', 'speckit-specify', 'done', 'speckit-checklist']) {
      const snapshot = snapshotPhaseDef(phase({ id }));
      expect(snapshot.sideEffects, `sideEffects for ${id}`).toBe('workspace');
      expect(snapshot.evidencePolicy, `evidencePolicy for ${id}`).toBe('required');
    }
  });
});

describe('snapshotPhaseDef — no id list and no scope survives the freeze (FR-006, SC-005)', () => {
  it('resolves promptVersion to one value for every Phase', () => {
    // `builtin-v1` was the other half of the same id lookup. With no built-in
    // layer there is no second value to choose between.
    expect(snapshotPhaseDef(phase()).promptVersion).toBe('custom-v1');
    expect(snapshotPhaseDef(phase({ id: 'speckit-plan' })).promptVersion).toBe('custom-v1');
    expect(snapshotPhaseDef(phase({ promptVersion: 'authored-v9' })).promptVersion).toBe(
      'authored-v9'
    );
  });

  it('resolves containment from the declaration, not from any other key on the row', () => {
    // Feature 099 (T496f, FR-042) — this compared a `built-in` row against a
    // `workspace` one and demanded the same four resolved fields. `PhaseDef` has
    // no `sourceScope` to set, so the input becomes an unrecognized key smuggled
    // onto the row: the same question — can anything but the declaration reach
    // the resolution — asked in the only form the type still allows.
    //
    // The freeze spreads the row, so this does NOT claim the key is stripped;
    // `snapshotPipelineContract` is the one that enumerates, and its own test
    // owns that half.
    const withStrayKey = snapshotPhaseDef({
      ...phase(),
      ...({ sourceScope: 'workspace' } as Partial<PhaseDef>)
    });
    const asNothing = snapshotPhaseDef(phase());

    for (const snapshot of [withStrayKey, asNothing]) {
      expect(snapshot.sideEffects).toBe('workspace');
      expect(snapshot.evidencePolicy).toBe('required');
      expect(snapshot.promptVersion).toBe('custom-v1');
    }
  });

  it('freezes the row and copies it, so a later catalog edit cannot reach the Run', () => {
    const source: PhaseDef = phase({ sideEffects: 'none' });
    const snapshot = snapshotPhaseDef(source);
    (source as { sideEffects: string }).sideEffects = 'unrestricted';

    expect(snapshot.sideEffects).toBe('none');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
