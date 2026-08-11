// Feature 089 (T016, T018, US3, FR-016, FR-019, SC-005) — a Phase stored before
// this platform still hydrates, still runs, and is never rewritten on the way in.
//
// The fixture below is a **characterization** test, not a behavior test: it
// records what a pre-platform row does today so a future change that makes an
// optional field required fails here instead of failing in an operator's
// settings. Every row is written the way the pre-085 catalog wrote one — the
// four fields a Phase has always had, and nothing else.
//
// On "empty input and output contracts" (FR-016): a `PhaseDefinition` declares
// no ports at all. Ports live one level up, on the Pipeline, and a binding
// addresses a Phase by `phaseIndex` and a free-form key rather than by anything
// the Phase declares. So a Phase's port surface is empty by construction, and
// what this file pins is that it *stays* empty and stays valid — no key is
// invented on the way through hydration, and no absent key is required. The
// binding half of FR-016 (a Pipeline over such a Phase needs no bindings) is
// pinned next door in `legacy-pipeline-hydration.test.ts`, which is where the
// binding validator lives.
//
// FR-019 is asserted structurally rather than by watching for a write call.
// `resolvePhaseCatalog` takes rows as values and has no write port, so the
// honest way to state "hydration writes nothing back" is to hand it rows that
// **cannot** be written to — deep-frozen, under ESM strict mode, where a
// write throws — and then compare the stored layer field by field afterwards.
// A resolver that upgraded a legacy row in place would throw; one that returned
// an upgraded copy for the host to persist would fail the comparison.

import { describe, expect, it } from 'vitest';
import {
  phaseDefinitionToPhaseDef,
  resolvePhaseCatalog
} from '../../../src/config/process-catalog';
import type { PhaseDef } from '../../../src/config/pipeline-config';

/** Recursively freezes, so an in-place upgrade of a nested value throws too. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

/**
 * A user-layer Phase as it was stored before this platform: an id, a name, a
 * version, and an instruction. No `loopable`, no `retryCondition`, no
 * `isRequired`, no `runner` — and, by definition, no port declarations.
 */
const LEGACY_INSTRUCTION_ROW = {
  phaseId: 'legacy-draft',
  name: 'Legacy Draft',
  version: 1,
  instruction: 'Draft the thing.'
} as const;

/** The other authored shape of the same era: a Phase that names a skill. */
const LEGACY_SKILL_ROW = {
  phaseId: 'legacy-review',
  name: 'Legacy Review',
  version: 1,
  skill: 'reviewer'
} as const;

/** Port-shaped keys that must never appear on a hydrated Phase. */
const PORT_KEYS = ['inputs', 'outputs', 'ports', 'inputContract', 'outputContract'] as const;

function resolveLegacyLayer(rows: readonly unknown[]) {
  return resolvePhaseCatalog({ builtIn: [], user: rows, workspace: [] });
}

describe('a Phase stored before this platform hydrates unchanged (FR-016, SC-005)', () => {
  it('resolves effective with no field errors', () => {
    const rows = deepFreeze([{ ...LEGACY_INSTRUCTION_ROW }, { ...LEGACY_SKILL_ROW }]);
    const resolved = resolveLegacyLayer(rows);

    expect(resolved.records.map((record) => record.status)).toEqual(['effective', 'effective']);
    expect(resolved.records.flatMap((record) => record.errors)).toEqual([]);
    expect(resolved.effective.map((definition) => definition.phaseId)).toEqual([
      'legacy-draft',
      'legacy-review'
    ]);
    // A soft-cap or invalid-row warning here would mean the row was treated as
    // needing repair, which is exactly what "unchanged" rules out.
    expect(resolved.warnings).toEqual([]);
  });

  it('declares empty input and output contracts, and acquires no port keys', () => {
    const rows = deepFreeze([{ ...LEGACY_INSTRUCTION_ROW }]);
    const resolved = resolveLegacyLayer(rows);
    const definition = resolved.effective[0]!;

    // Stated as a key-set equality rather than five `toBeUndefined()` calls: a
    // port field added under a name nobody thought to list would slip past the
    // latter and fail here.
    expect(Object.keys(definition).sort()).toEqual(
      ['instruction', 'name', 'phaseId', 'version'].sort()
    );
    for (const key of PORT_KEYS) {
      expect(definition).not.toHaveProperty(key);
    }
  });

  it('projects onto a runnable PhaseDef with the same empty surface', () => {
    const rows = deepFreeze([{ ...LEGACY_INSTRUCTION_ROW }]);
    const resolved = resolveLegacyLayer(rows);
    const phaseDef: PhaseDef = resolved.effectivePhaseDefs[0]!;

    // Everything the runtime reads off a Phase, and nothing it does not.
    expect(phaseDef).toEqual({
      id: 'legacy-draft',
      name: 'Legacy Draft',
      version: 1,
      instruction: 'Draft the thing.',
      sourceScope: 'user'
    });
    for (const key of PORT_KEYS) {
      expect(phaseDef).not.toHaveProperty(key);
    }
    // The same projection the run path uses, reached directly — so this holds
    // for a Phase resolved anywhere, not only through the catalog walk above.
    expect(phaseDefinitionToPhaseDef(resolved.effective[0]!, 'user', new Map())).toEqual(phaseDef);
  });
});

describe('hydration writes nothing back to configuration (T018, FR-019)', () => {
  it('leaves the stored layer byte-identical, and never writes through it', () => {
    const stored = deepFreeze([{ ...LEGACY_INSTRUCTION_ROW }, { ...LEGACY_SKILL_ROW }]);
    const before = JSON.parse(JSON.stringify(stored)) as unknown[];

    // Frozen input: an in-place upgrade throws under strict mode rather than
    // silently succeeding, so this call is itself half the assertion.
    const resolved = resolveLegacyLayer(stored);
    expect(resolved.effective).toHaveLength(2);

    expect(JSON.parse(JSON.stringify(stored))).toEqual(before);
    expect(stored[0]).toEqual(LEGACY_INSTRUCTION_ROW);
    expect(stored[1]).toEqual(LEGACY_SKILL_ROW);
  });

  it('is stable under repeated resolution — reading twice is reading once', () => {
    const stored = deepFreeze([{ ...LEGACY_INSTRUCTION_ROW }]);
    const first = resolveLegacyLayer(stored);
    const second = resolveLegacyLayer(stored);

    // A resolver that upgraded the shape would produce a different revision on
    // the second pass, because the revision hashes the layer it was given.
    expect(second.revisions).toEqual(first.revisions);
    expect(second.effective).toEqual(first.effective);
    expect(second.effectivePhaseDefs).toEqual(first.effectivePhaseDefs);
  });
});
