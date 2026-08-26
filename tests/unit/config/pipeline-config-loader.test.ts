import { describe, it, expect } from 'vitest';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import { isPhaseDef } from '../../../src/config/pipeline-config';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';
// Feature 098 (T080) — the Pipelines these tests author name `speckit-specify`,
// `speckit-clarify` and `finalize`, which used to resolve out of the built-in
// Phase layer. That layer is empty now, so a test about *Pipeline* resolution has
// to supply the Phases its Pipelines reference or every row quarantines as
// `unknown-phase` and reports `pipeline-validation` instead of the gate under
// test. See the fixture header for why the ids are the real Spec Kit ones.
import { SPECKIT_PHASE_DEFS } from '../../fixtures/speckit-catalog-fixture';
// Feature 099 (T496f, FR-042/FR-054) — definitions arrive as a store snapshot,
// not as configuration. `getPhases`/`getPipelines` are gone from the reader, so a
// test that used to seed a layer now seeds the store; `getModels` and
// `getDefaultPipelineId` are the two keys the store does not own and they keep
// both settings scopes, which is why `userDefault`/`workspaceDefault` survive
// below while `userPhases`/`workspacePhases` do not.
import { EMPTY_SNAPSHOT, snapshotOf } from '../../fixtures/catalog-snapshot-fixture';

/** The Phase rows the Pipelines below reference, as the store supplies them. */
const REFERENCED_PHASES = SPECKIT_PHASE_DEFS;

interface LoadOptions {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly userDefault?: string;
  readonly workspaceDefault?: string;
}

function makeReader(opts: LoadOptions): CatalogConfigReader {
  return {
    getDefaultPipelineId: (scope) => (scope === 'user' ? opts.userDefault : opts.workspaceDefault),
    getModels: () => undefined
  };
}

/** One store snapshot plus the two surviving configuration keys. */
function load(opts: LoadOptions) {
  return loadCatalog(
    snapshotOf({ phases: opts.phases, pipelines: opts.pipelines }),
    makeReader(opts)
  );
}

describe('loadCatalog (T044, T045, US3)', () => {
  // Feature 098 (T021, US3, FR-027, SC-012) — a load with no configured reader
  // used to answer with `BUILT_IN_CATALOG`, which is how a host with no settings
  // source at all still came up holding seventeen Phases and three Pipelines the
  // operator never authored. There is no reader, so there is nothing to report;
  // the honest catalog is the empty one, and the default Pipeline is unset.
  //
  // `models` is deliberately excluded from the sweep: the manifest default is
  // already empty and this feature does not touch it.
  it('returns an empty catalog when no reader is supplied', () => {
    const result = loadCatalog(EMPTY_SNAPSHOT);

    expect(result.catalog.phases).toEqual([]);
    expect(result.catalog.pipelines).toEqual([]);
    expect(result.catalog.phasesById.size).toBe(0);
    expect(result.catalog.pipelinesById.size).toBe(0);
    expect(result.catalog.defaultPipelineId).toBe('');
    expect(result.defaultPipelineId).toBe('');
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  it('reads the store the same way whether or not a reader is supplied', () => {
    // Feature 099 (T494, FR-042/FR-054) — the reader used to carry the definitions,
    // so "no reader" meant "no catalog" and the branch answering it could be a
    // constant. The store carries them now, and the reader is down to two keys
    // that name neither a Phase nor a Pipeline. Its absence must therefore change
    // exactly those two answers and nothing else — in particular it must not
    // decide whether the resolved catalog is validated at all, which is how a load
    // comes to report a clean catalog that a load one argument longer would not.
    //
    // Twenty-one Pipelines because the soft cap is twenty: the divergence is only
    // observable on a catalog big enough for `validateCatalog` to have something to
    // say about it, and an empty store is the one input on which any two code paths
    // agree.
    const pipelines = Array.from({ length: 21 }, (_unused, index) => ({
      id: `pipeline-${index}`,
      name: `Pipeline ${index}`,
      phases: ['speckit-specify']
    }));
    const snapshot = snapshotOf({ phases: REFERENCED_PHASES, pipelines });
    const supplyingNothing: CatalogConfigReader = {
      getModels: () => undefined,
      getDefaultPipelineId: () => undefined
    };

    const withoutReader = loadCatalog(snapshot);
    const withEmptyReader = loadCatalog(snapshot, supplyingNothing);

    expect(withoutReader.warnings).toEqual(withEmptyReader.warnings);
    expect(withoutReader.errors).toEqual(withEmptyReader.errors);
    expect(withoutReader.usedFallback).toBe(withEmptyReader.usedFallback);
    expect(withoutReader.defaultPipelineId).toBe(withEmptyReader.defaultPipelineId);
    expect(withoutReader.catalog.pipelines).toEqual(withEmptyReader.catalog.pipelines);
    // The vacuity guard: an assertion that two warning lists match is worth
    // nothing if both are empty.
    expect(withEmptyReader.warnings.length).toBeGreaterThan(0);
  });

  it('substitutes no definition of its own for the reader it does not have', () => {
    // The specific substitution FR-027 removes, named rather than implied: with
    // no reader the loader reached for the built-in layer by constant, not
    // through layer resolution, so emptying the layer would not have reached it.
    const result = loadCatalog(EMPTY_SNAPSHOT);

    // The ids are spelled out rather than read off `BUILT_IN_PIPELINE_ID`: the
    // constant is itself scheduled for deletion, and a test that the host supplies
    // no definition should not source the id it checks from the host.
    expect(result.catalog.phasesById.has('speckit-specify')).toBe(false);
    expect(result.catalog.pipelinesById.has('speckit-new-feature')).toBe(false);
  });

  // Feature 099 (T496f, FR-043) — three cases stood here: workspace shadowing
  // user for a shared Phase id, the same for a Pipeline id, and user shadowing
  // built-in. All three asserted precedence between layers, and there is one
  // layer. They are deleted rather than reduced to a single-layer variant: "the
  // only row wins" is not a precedence rule, it is the absence of one, and a test
  // asserting it would pass on any implementation at all. What a shared id now
  // produces — two rows claiming one id, both invalidated — is the duplicate case
  // further down, which is a different rule and already has its own test.

  // `defaultPipelineId` is NOT a definition, so it keeps both settings scopes and
  // keeps this precedence (FR-054). The Pipelines it names come from the store.
  it('workspace defaultPipelineId shadows user defaultPipelineId for scalar setting precedence', () => {
    const result = load({
      userDefault: 'user-default',
      workspaceDefault: 'workspace-default',
      pipelines: [
        { id: 'user-default', name: 'User Default', phases: ['speckit-specify'] },
        { id: 'workspace-default', name: 'Workspace Default', phases: ['speckit-specify'] }
      ],
      phases: REFERENCED_PHASES
    });
    expect(result.errors).toEqual([]);
    expect(result.catalog.defaultPipelineId).toBe('workspace-default');
  });

  it('quarantines invalid source rows without discarding the effective catalog', () => {
    const badPhase = {
      id: 'INVALID-ID-CAPITAL',
      name: 'Bad',
      instruction: 'x',
      
    };
    const opts = { phases: [badPhase, ...REFERENCED_PHASES] };
    expect(() => load(opts)).not.toThrow();
    const result = load(opts);
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    // Feature 098 (T028) — an unresolvable default re-anchors to `''` rather than
    // to a Pipeline the loader picked. The quarantine this test is about is
    // unaffected either way.
    expect(result.catalog.defaultPipelineId).toBe('');
    expect(result.catalog.phasesById.has('speckit-specify')).toBe(true);
    expect(result.catalog.phasesById.has('INVALID-ID-CAPITAL')).toBe(false);
    expect(result.phaseCatalog.records.some((record) => record.status === 'invalid')).toBe(true);
  });

  // Feature 082 FR-002 replaces the earlier all-or-nothing fallback: a Pipeline
  // row that references an unknown Phase is quarantined as an invalid source
  // record instead of discarding the whole configured layer.
  it('quarantines a pipeline that references an unknown phase id without falling back', () => {
    const opts = {
      pipelines: [
        {
          id: 'broken',
          name: 'Broken Pipeline',
          phases: ['speckit-specify', 'does-not-exist', 'finalize']
        },
        {
          id: 'intact',
          name: 'Intact Pipeline',
          phases: ['speckit-specify', 'finalize']
        }
      ],
      phases: REFERENCED_PHASES
    };
    const result = load(opts);
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    expect(result.catalog.pipelinesById.has('broken')).toBe(false);
    expect(result.catalog.pipelinesById.has('intact')).toBe(true);
    const record = result.pipelineCatalog.records.find((entry) => entry.pipelineId === 'broken');
    expect(record?.status).toBe('invalid');
    expect(record?.errors.some((error) => error.code === 'unknown-phase')).toBe(true);
    expect(result.warnings.some((warning) => warning.id === 'broken')).toBe(true);
  });

  it('reports no default when defaultPipelineId references an unknown pipeline (T045)', () => {
    const opts = {
      userDefault: 'phantom-pipeline'
    };
    const result = load(opts);
    // Feature 098 (T028, FR-026) — the phantom does not resolve, and the loader
    // used to re-anchor to `BUILT_IN_PIPELINE_ID`: a default the operator never
    // named, offered as though they had. It reports no default instead, and still
    // never throws.
    expect(result.catalog.defaultPipelineId).toBe('');
    expect(result.defaultPipelineId).toBe('');
  });

  it('coerces malformed phase/pipeline entries silently (T045)', () => {
    const opts = {
      phases: [
        null,
        'not-an-object',
        42,
        { id: 123 },
        { id: 'missing-fields' },
        {
          id: 'valid-phase',
          name: 'Valid Phase',
          instruction: 'ok',
          
        }
      ] as readonly unknown[],
      pipelines: [
        null,
        { id: 'no-phases-array' },
        {
          id: 'valid-pipeline',
          name: 'Valid Pipeline',
          phases: ['valid-phase']
        }
      ] as readonly unknown[]
    };
    expect(() => load(opts)).not.toThrow();
    const result = load(opts);
    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.has('valid-phase')).toBe(true);
    expect(result.catalog.pipelinesById.has('valid-pipeline')).toBe(true);
  });

  it('emits duplicate warnings when the catalog holds an id twice (T044)', () => {
    const opts = {
      phases: [
        { id: 'twin', name: 'First', instruction: 'a' },
        { id: 'twin', name: 'Second', instruction: 'b' }
      ]
    };
    const result = load(opts);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.id === 'twin')).toBe(true);
    expect(result.catalog.phasesById.has('twin')).toBe(false);
    expect(
      result.phaseCatalog.records
        .filter((record) => record.phaseId === 'twin')
        .every((record) => record.status === 'invalid')
    ).toBe(true);
  });
});

describe('loadCatalog — resolved Pipeline catalog (082 FR-002, FR-003)', () => {
  // Feature 099 (T496f, FR-044a) — was "per-scope revisions", asserting a hash
  // per layer computed from that layer's rows. There is one catalog and the
  // revision is the store's, so the claim that survives is the one that matters
  // to the Builder: whatever the store said, the resolution reports back
  // unchanged. It is deliberately NOT re-derived here — a test that recomputed
  // the revision would pass against a value the store never issued.
  it('reports the store revision the snapshot carried', () => {
    const result = loadCatalog(
      snapshotOf({
        pipelines: [{ id: 'custom', name: 'Custom', phases: ['finalize'] }],
        revisions: { pipeline: 'rev-from-store', phase: 'rev-phase-from-store' }
      })
    );
    expect(result.pipelineCatalog.revision).toBe('rev-from-store');
    expect(result.phaseCatalog.revision).toBe('rev-phase-from-store');
  });

  // Feature 098 (T036, FR-027) — this used to assert that a reader-less load still
  // exposed a built-in Pipeline in the effective set. The built-in layer ships no
  // rows; feature 099 (FR-001a) makes the same case reachable through an empty
  // store, which is what a workspace nobody has saved into presents.
  it('exposes an empty resolution for an empty store', () => {
    const result = loadCatalog(EMPTY_SNAPSHOT);
    expect(result.pipelineCatalog.records).toEqual([]);
    expect(result.pipelineCatalog.effective).toEqual([]);
  });

  it('retains every stored row as a record, including malformed ones', () => {
    // Feature 099 (T496f) — the first row was `null` while the layer was a
    // settings array, where `null` is a value an operator can type. A stored
    // definition with a `null` body is a different thing entirely: `storedRows`
    // skips it because it means the record is unreadable (an integrity fault,
    // FR-027) or holds a draft and no active version, neither of which is a
    // malformed row for the resolver to quarantine. `42` is the degenerate body
    // the store CAN hold, so it carries the same "not even an object" case
    // without asserting a claim about faults that belongs elsewhere.
    const result = load({
        pipelines: [
          42,
          { id: 'no-phases-array' },
          { id: 'good', name: 'Good', phases: ['finalize'] }
        ] as readonly unknown[],
        phases: REFERENCED_PHASES
      });
    const records = result.pipelineCatalog.records;
    expect(records).toHaveLength(3);
    expect(records.filter((record) => record.status === 'invalid')).toHaveLength(2);
    expect(records.find((record) => record.pipelineId === 'good')?.status).toBe('effective');
  });

  it('places only effective valid definitions in catalog.pipelines', () => {
    const result = load({
        pipelines: [
          { id: 'good', name: 'Good', phases: ['finalize'] },
          { id: 'bad', name: 'Bad', phases: [] }
        ] as readonly unknown[],
        phases: REFERENCED_PHASES
      });
    const ids = result.catalog.pipelines.map((pipeline) => pipeline.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('bad');
    expect(
      result.catalog.pipelines.every((pipeline) =>
        result.pipelineCatalog.effective.some((entry) => entry.pipelineId === pipeline.id)
      )
    ).toBe(true);
  });

  // Feature 099 (T496f, FR-043) — the `sourceScope` stamp is deleted with the
  // field. It named which of three layers a definition resolved out of, and the
  // answer is now the same for every row by construction, so there is nothing
  // left for a resolver to get wrong. Nothing weaker is asserted in its place:
  // that a definition came out of the store is what every other case here
  // already relies on.

  it('surfaces resolver warnings without producing catalog errors', () => {
    const result = load({
        pipelines: [
          { id: 'suggester', name: 'Suggester', phases: ['finalize'], recommendedNext: ['ghost'] }
        ] as readonly unknown[],
        phases: REFERENCED_PHASES
      });
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    expect(result.warnings.some((warning) => /ghost/.test(warning.message))).toBe(true);
  });

  it('keeps a defaultPipelineId naming a Pipeline only the store supplies', () => {
    const result = load({
        workspaceDefault: 'scoped',
        pipelines: [{ id: 'scoped', name: 'Scoped', phases: ['finalize'] }],
        phases: REFERENCED_PHASES
      });
    expect(result.defaultPipelineId).toBe('scoped');
  });
});

describe('loadCatalog — retryCondition validation (010, T022, US2)', () => {
  it('preserves a valid retryCondition on the loaded PhaseDef (FR-014)', () => {
    const opts = {
      phases: [
        {
          id: 'security-audit',
          name: 'Security Audit',
          instruction: 'audit',
          
          retryCondition: 'open_questions > 0'
        }
      ]
    };
    const result = load(opts);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('security-audit');
    expect(phase?.retryCondition).toBe('open_questions > 0');
  });

  it('quarantines a syntactically invalid retryCondition row', () => {
    const opts = {
      phases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          
          retryCondition: 'open_questions > 0 AND broken'
        }
      ]
    };
    const result = load(opts);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('broken');
    expect(phase).toBeUndefined();
    expect(
      result.phaseCatalog.records.find((record) => record.phaseId === 'broken')?.status
    ).toBe('invalid');
  });

  it('emits exactly one warning per load naming the offending phase id', () => {
    const opts = {
      phases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          
          retryCondition: '@@invalid'
        }
      ]
    };
    const result = load(opts);
    const matches = result.warnings.filter((w) => w.id === 'broken');
    expect(matches.length).toBe(1);
    expect(matches[0].message ?? '').toMatch(/retry condition/i);
  });

  it('keeps extension activation alive when a retryCondition is invalid', () => {
    const opts = {
      phases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          
          retryCondition: '!!!'
        },
        {
          id: 'ok',
          name: 'OK',
          instruction: 'inst',
          
        }
      ]
    };
    const result = load(opts);
    expect(result.usedFallback).toBe(false);
  });
});

describe('loadCatalog — runner validation (074, T033)', () => {
  it.each([true, false])('preserves isRequired: %s', (isRequired) => {
    const opts = {
      phases: [
        {
          id: 'optional-policy',
          name: 'Optional Policy',
          instruction: 'Check policy.',
          isRequired
        }
      ]
    };

    const result = load(opts);

    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.get('optional-policy')?.isRequired).toBe(isRequired);
  });

  it('leaves isRequired absent for legacy phase definitions', () => {
    const opts = {
      phases: [
        {
          id: 'legacy-required',
          name: 'Legacy Required',
          instruction: 'Run as required.'
        }
      ]
    };

    expect(load(opts).catalog.phasesById.get('legacy-required')?.isRequired)
      .toBeUndefined();
  });

  // Feature 098 (T036, FR-010) — a block here read `BUILT_IN_PHASES` for five
  // named ids and asserted each pinned `runner: 'claude'`. Both halves of that
  // assertion are gone: the built-in layer ships no rows to read, and T018 already
  // re-keyed the Git-runner rule off the id list onto the Phase's own declared
  // `sideEffects` (FR-007), with FR-008 permitting no replacement list. The
  // `sideEffects`-keyed block further down is the successor.

  it.each(SUPPORTED_BACKENDS)('accepts phase definitions with runner: %s', (runner) => {
    const opts = {
      phases: [
        {
          id: 'test-runner-1',
          name: 'Test Runner',
          instruction: 'inst',
          runner
        }
      ]
    };
    const result = load(opts);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('test-runner-1');
    expect(phase?.runner).toBe(runner);
    expect(isPhaseDef(phase)).toBe(true);
  });

  it('rejects phase definitions with invalid runner', () => {
    const opts = {
      phases: [
        {
          id: 'test-runner-2',
          name: 'Test Runner',
          instruction: 'inst',
          runner: 'invalid-runner-name'
        }
      ]
    };
    const result = load(opts);
    expect(result.warnings.filter((warning) => warning.id === 'test-runner-2')).toHaveLength(1);
    // Invalid runner causes the phase to fail schema validation, meaning it doesn't get loaded
    expect(result.catalog.phasesById.has('test-runner-2')).toBe(false);
    expect(isPhaseDef({
      id: 'test-runner-2',
      name: 'Test Runner',
      instruction: 'inst',
      runner: 'invalid-runner-name'
    })).toBe(false);
  });

  it('accepts phase definitions with omitted runner', () => {
    const opts = {
      phases: [
        {
          id: 'test-runner-3',
          name: 'Test Runner',
          instruction: 'inst'
        }
      ]
    };
    const result = load(opts);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('test-runner-3');
    expect(phase?.runner).toBeUndefined();
  });

  it('preserves the deprecated loopable compatibility field', () => {
    const opts = {
      phases: [
        {
          id: 'legacy-loopable',
          name: 'Legacy loopable',
          instruction: 'inst',
          loopable: true
        }
      ]
    };

    const result = load(opts);

    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.get('legacy-loopable')?.loopable).toBe(true);
  });

  // Feature 098 T018 — the Git-runner rule was re-keyed from a list of five
  // known ids onto the Phase's own declared `sideEffects` (FR-007), and FR-008
  // permits no replacement id list. So in the three blocks below the id is
  // scenery: it keeps each case recognisable as the one it replaced, and the
  // declaration is what the rule reads. A row that declares nothing is admitted
  // whatever it is called, which is the point of the first block.
  it.each([
    'speckit-specify',
    'specify-brainstorm',
    'superpowers-implement',
    'finalize',
    'superpowers-review-close'
  ] as const)('does not inherit the pinned runner for custom %s shadows', (id) => {
    const phase = {
      id,
      name: 'Git phase override',
      instruction: 'Create or close the branch.'
    };
    const opts = { phases: [phase] };

    const result = load(opts);

    expect(result.usedFallback).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.get(id)?.runner).toBeUndefined();
    expect(isPhaseDef(phase)).toBe(true);
  });

  it.each([
    'speckit-specify',
    'specify-brainstorm',
    'superpowers-implement',
    'finalize',
    'superpowers-review-close'
  ] as const)('quarantines an explicit Codex custom shadow of protected phase %s', (id) => {
    const phase = {
      id,
      name: 'Git phase override',
      version: 1,
      instruction: 'Create or close the branch.',
      runner: 'codex' as const,
      sideEffects: 'git' as const
    };
    const opts = { phases: [phase] };
    const result = load(opts);

    expect(result.usedFallback).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'phase', id })
    ]));
    // Feature 098 (T036) — quarantining the row used to leave a built-in
    // definition standing under the same id, so the assertion was that the pinned
    // `claude` runner survived the rejection. There is nothing underneath any more:
    // rejecting the only row that claims the id leaves the id unresolved, which is
    // the outcome the quarantine now produces.
    expect(result.catalog.phasesById.has(id)).toBe(false);
    expect(isPhaseDef(phase)).toBe(true);
  });

  it.each(['claude', 'agy'] as const)(
    'accepts Git-mutating overrides with explicit %s runner',
    (runner) => {
      const opts = {
        phases: [
          {
            id: 'finalize',
            name: 'Finalize override',
            instruction: 'Commit and merge the work.',
            runner,
            sideEffects: 'git' as const
          }
        ]
      };

      const result = load(opts);

      expect(result.errors).toEqual([]);
      expect(result.catalog.phasesById.get('finalize')?.runner).toBe(runner);
    }
  );
});
