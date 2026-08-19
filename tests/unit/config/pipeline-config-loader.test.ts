import { describe, it, expect } from 'vitest';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import { isPhaseDef } from '../../../src/config/pipeline-config';
import { pipelineLayerRevision } from '../../../src/config/pipeline-catalog';
import { SUPPORTED_BACKENDS } from '../../../src/runner/backend-runner-factory';
// Feature 098 (T080) — the Pipelines these tests author name `speckit-specify`,
// `speckit-clarify` and `finalize`, which used to resolve out of the built-in
// Phase layer. That layer is empty now, so a test about *Pipeline* resolution has
// to supply the Phases its Pipelines reference or every row quarantines as
// `unknown-phase` and reports `pipeline-validation` instead of the gate under
// test. See the fixture header for why the ids are the real Spec Kit ones.
import { SPECKIT_PHASE_DEFS } from '../../fixtures/speckit-catalog-fixture';

/** The Phase rows the Pipelines below reference, as a settings layer supplies them. */
const REFERENCED_PHASES = SPECKIT_PHASE_DEFS;

function makeReader(opts: {
  userPhases?: readonly unknown[];
  userPipelines?: readonly unknown[];
  userDefault?: string;
  workspacePhases?: readonly unknown[];
  workspacePipelines?: readonly unknown[];
  workspaceDefault?: string;
}): CatalogConfigReader {
  return {
    getPhases: (scope) => (scope === 'user' ? opts.userPhases : opts.workspacePhases),
    getPipelines: (scope) => (scope === 'user' ? opts.userPipelines : opts.workspacePipelines),
    getDefaultPipelineId: (scope) => (scope === 'user' ? opts.userDefault : opts.workspaceDefault),
    getModels: () => undefined
  };
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
    const result = loadCatalog();

    expect(result.catalog.phases).toEqual([]);
    expect(result.catalog.pipelines).toEqual([]);
    expect(result.catalog.phasesById.size).toBe(0);
    expect(result.catalog.pipelinesById.size).toBe(0);
    expect(result.catalog.defaultPipelineId).toBe('');
    expect(result.defaultPipelineId).toBe('');
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  it('substitutes no definition of its own for the reader it does not have', () => {
    // The specific substitution FR-027 removes, named rather than implied: with
    // no reader the loader reached for the built-in layer by constant, not
    // through layer resolution, so emptying the layer would not have reached it.
    const result = loadCatalog();

    // The ids are spelled out rather than read off `BUILT_IN_PIPELINE_ID`: the
    // constant is itself scheduled for deletion, and a test that the host supplies
    // no definition should not source the id it checks from the host.
    expect(result.catalog.phasesById.has('speckit-specify')).toBe(false);
    expect(result.catalog.pipelinesById.has('speckit-new-feature')).toBe(false);
  });

  it('workspace settings shadow user settings for shared Phase ids (081 FR-003)', () => {
    const userPhase = {
      id: 'security-audit',
      name: 'User Security Audit',
      instruction: 'User-level instruction (wins).',
      
    };
    const workspacePhase = {
      id: 'security-audit',
      name: 'Workspace Security Audit',
      instruction: 'Workspace-level instruction.',
      
      model: 'claude-opus-4-7',
      effort: 'high' as const
    };
    const reader = makeReader({
      userPhases: [userPhase],
      workspacePhases: [workspacePhase]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('security-audit');
    expect(phase).toBeDefined();
    expect(phase!.name).toBe('Workspace Security Audit');
    expect(phase!.instruction).toBe('Workspace-level instruction.');
    expect(phase!.model).toBe('claude-opus-4-7');
    expect(phase!.effort).toBe('high');
  });

  // Feature 082 FR-003 supersedes the earlier BUG-003 pipeline merge order:
  // Pipeline precedence is now workspace over user over built-in, matching the
  // Phase catalog precedence established by feature 081.
  it('workspace settings shadow user settings for shared pipeline ids (082 FR-003)', () => {
    const userPipeline = {
      id: 'security',
      name: 'User Security Pipeline',
      phases: ['speckit-specify', 'finalize']
    };
    const workspacePipeline = {
      id: 'security',
      name: 'Workspace Security Pipeline',
      phases: ['speckit-specify', 'speckit-clarify', 'finalize']
    };
    const reader = makeReader({
      userPipelines: [userPipeline],
      workspacePipelines: [workspacePipeline],
      workspacePhases: REFERENCED_PHASES
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const pipeline = result.catalog.pipelinesById.get('security');
    expect(pipeline).toBeDefined();
    expect(pipeline!.name).toBe('Workspace Security Pipeline');
    expect(pipeline!.phases).toEqual(['speckit-specify', 'speckit-clarify', 'finalize']);
    expect(
      result.pipelineCatalog.records.find(
        (record) => record.pipelineId === 'security' && record.scope === 'user'
      )?.status
    ).toBe('shadowed');
  });

  it('user settings shadow built-in defaults for shared ids (T044)', () => {
    const userOverride = {
      id: 'speckit-specify',
      name: 'Custom Specify',
      instruction: 'User-overridden specify instruction.',
      
    };
    const reader = makeReader({
      userPhases: [userOverride]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('speckit-specify');
    expect(phase!.name).toBe('Custom Specify');
    expect(phase!.instruction).toBe('User-overridden specify instruction.');
  });

  it('workspace defaultPipelineId shadows user defaultPipelineId for scalar setting precedence', () => {
    const reader = makeReader({
      userDefault: 'user-default',
      workspaceDefault: 'workspace-default',
      userPipelines: [{ id: 'user-default', name: 'User Default', phases: ['speckit-specify'] }],
      workspacePipelines: [
        { id: 'workspace-default', name: 'Workspace Default', phases: ['speckit-specify'] }
      ],
      workspacePhases: REFERENCED_PHASES
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    expect(result.catalog.defaultPipelineId).toBe('workspace-default');
  });

  it('quarantines invalid source rows without discarding the effective catalog', () => {
    const badPhase = {
      id: 'INVALID-ID-CAPITAL',
      name: 'Bad',
      instruction: 'x',
      
    };
    const reader = makeReader({
      userPhases: [badPhase],
      workspacePhases: REFERENCED_PHASES
    });
    expect(() => loadCatalog(reader)).not.toThrow();
    const result = loadCatalog(reader);
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
    const reader = makeReader({
      userPipelines: [
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
      workspacePhases: REFERENCED_PHASES
    });
    const result = loadCatalog(reader);
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
    const reader = makeReader({
      userDefault: 'phantom-pipeline'
    });
    const result = loadCatalog(reader);
    // Feature 098 (T028, FR-026) — the phantom does not resolve, and the loader
    // used to re-anchor to `BUILT_IN_PIPELINE_ID`: a default the operator never
    // named, offered as though they had. It reports no default instead, and still
    // never throws.
    expect(result.catalog.defaultPipelineId).toBe('');
    expect(result.defaultPipelineId).toBe('');
  });

  it('coerces malformed phase/pipeline entries silently (T045)', () => {
    const reader = makeReader({
      userPhases: [
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
      userPipelines: [
        null,
        { id: 'no-phases-array' },
        {
          id: 'valid-pipeline',
          name: 'Valid Pipeline',
          phases: ['valid-phase']
        }
      ] as readonly unknown[]
    });
    expect(() => loadCatalog(reader)).not.toThrow();
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.has('valid-phase')).toBe(true);
    expect(result.catalog.pipelinesById.has('valid-pipeline')).toBe(true);
  });

  it('emits duplicate warnings when the same workspace setting defines an id twice (T044)', () => {
    const reader = makeReader({
      workspacePhases: [
        { id: 'twin', name: 'First', instruction: 'a' },
        { id: 'twin', name: 'Second', instruction: 'b' }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.id === 'twin')).toBe(true);
    expect(result.catalog.phasesById.has('twin')).toBe(false);
    expect(
      result.phaseCatalog.records
        .filter((record) => record.scope === 'workspace' && record.phaseId === 'twin')
        .every((record) => record.status === 'invalid')
    ).toBe(true);
  });
});

describe('loadCatalog — resolved Pipeline catalog (082 FR-002, FR-003)', () => {
  it('exposes a pipelineCatalog resolution with per-scope revisions', () => {
    const userPipelines = [{ id: 'custom', name: 'Custom', phases: ['finalize'] }];
    const result = loadCatalog(makeReader({ userPipelines }));
    expect(result.pipelineCatalog.revisions.user).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pipelineCatalog.revisions.workspace).toBe(pipelineLayerRevision([]));
    expect(result.pipelineCatalog.revisions.user).toBe(pipelineLayerRevision(userPipelines));
  });

  // Feature 098 (T036, FR-027) — this used to assert that a reader-less load still
  // exposed a built-in Pipeline in the effective set. The built-in layer ships no
  // rows, so the resolution a reader-less load exposes is the empty one: no
  // records at all, in any scope, and nothing effective.
  it('exposes an empty resolution when no reader is supplied', () => {
    const result = loadCatalog();
    expect(result.pipelineCatalog.records).toEqual([]);
    expect(result.pipelineCatalog.effective).toEqual([]);
  });

  it('retains every configured row as a record, including malformed ones', () => {
    const result = loadCatalog(
      makeReader({
        userPipelines: [
          null,
          { id: 'no-phases-array' },
          { id: 'good', name: 'Good', phases: ['finalize'] }
        ] as readonly unknown[],
        workspacePhases: REFERENCED_PHASES
      })
    );
    const userRecords = result.pipelineCatalog.records.filter((record) => record.scope === 'user');
    expect(userRecords).toHaveLength(3);
    expect(userRecords.filter((record) => record.status === 'invalid')).toHaveLength(2);
    expect(userRecords.find((record) => record.pipelineId === 'good')?.status).toBe('effective');
  });

  it('places only effective valid definitions in catalog.pipelines', () => {
    const result = loadCatalog(
      makeReader({
        userPipelines: [
          { id: 'good', name: 'Good', phases: ['finalize'] },
          { id: 'bad', name: 'Bad', phases: [] }
        ] as readonly unknown[],
        workspacePhases: REFERENCED_PHASES
      })
    );
    const ids = result.catalog.pipelines.map((pipeline) => pipeline.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('bad');
    expect(
      result.catalog.pipelines.every((pipeline) =>
        result.pipelineCatalog.effective.some((entry) => entry.pipelineId === pipeline.id)
      )
    ).toBe(true);
  });

  it('stamps the resolved sourceScope onto each effective pipeline', () => {
    const result = loadCatalog(
      makeReader({
        workspacePipelines: [{ id: 'scoped', name: 'Scoped', phases: ['finalize'] }],
        userPhases: REFERENCED_PHASES
      })
    );
    expect(result.catalog.pipelinesById.get('scoped')?.sourceScope).toBe('workspace');
    // Feature 098 (T036) — the second half of this assertion used to name a
    // built-in Pipeline id and expect `built-in`. No row carries that scope now,
    // so the stamp is only observable across the two configured layers.
    expect(result.catalog.pipelines.every((pipeline) => pipeline.sourceScope !== 'built-in')).toBe(
      true
    );
  });

  it('surfaces resolver warnings without producing catalog errors', () => {
    const result = loadCatalog(
      makeReader({
        userPipelines: [
          { id: 'suggester', name: 'Suggester', phases: ['finalize'], recommendedNext: ['ghost'] }
        ] as readonly unknown[],
        workspacePhases: REFERENCED_PHASES
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    expect(result.warnings.some((warning) => /ghost/.test(warning.message))).toBe(true);
  });

  it('keeps a defaultPipelineId that only a configured layer supplies', () => {
    const result = loadCatalog(
      makeReader({
        workspaceDefault: 'scoped',
        workspacePipelines: [{ id: 'scoped', name: 'Scoped', phases: ['finalize'] }],
        userPhases: REFERENCED_PHASES
      })
    );
    expect(result.defaultPipelineId).toBe('scoped');
  });
});

describe('loadCatalog — retryCondition validation (010, T022, US2)', () => {
  it('preserves a valid retryCondition on the loaded PhaseDef (FR-014)', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'security-audit',
          name: 'Security Audit',
          instruction: 'audit',
          
          retryCondition: 'open_questions > 0'
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('security-audit');
    expect(phase?.retryCondition).toBe('open_questions > 0');
  });

  it('quarantines a syntactically invalid retryCondition row', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          
          retryCondition: 'open_questions > 0 AND broken'
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('broken');
    expect(phase).toBeUndefined();
    expect(
      result.phaseCatalog.records.find((record) => record.phaseId === 'broken')?.status
    ).toBe('invalid');
  });

  it('emits exactly one warning per load naming the offending phase id', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          
          retryCondition: '@@invalid'
        }
      ]
    });
    const result = loadCatalog(reader);
    const matches = result.warnings.filter((w) => w.id === 'broken');
    expect(matches.length).toBe(1);
    expect(matches[0].message ?? '').toMatch(/retry condition/i);
  });

  it('keeps extension activation alive when a retryCondition is invalid', () => {
    const reader = makeReader({
      workspacePhases: [
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
    });
    const result = loadCatalog(reader);
    expect(result.usedFallback).toBe(false);
  });
});

describe('loadCatalog — runner validation (074, T033)', () => {
  it.each([true, false])('preserves isRequired: %s', (isRequired) => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'optional-policy',
          name: 'Optional Policy',
          instruction: 'Check policy.',
          isRequired
        }
      ]
    });

    const result = loadCatalog(reader);

    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.get('optional-policy')?.isRequired).toBe(isRequired);
  });

  it('leaves isRequired absent for legacy phase definitions', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'legacy-required',
          name: 'Legacy Required',
          instruction: 'Run as required.'
        }
      ]
    });

    expect(loadCatalog(reader).catalog.phasesById.get('legacy-required')?.isRequired)
      .toBeUndefined();
  });

  // Feature 098 (T036, FR-010) — a block here read `BUILT_IN_PHASES` for five
  // named ids and asserted each pinned `runner: 'claude'`. Both halves of that
  // assertion are gone: the built-in layer ships no rows to read, and T018 already
  // re-keyed the Git-runner rule off the id list onto the Phase's own declared
  // `sideEffects` (FR-007), with FR-008 permitting no replacement list. The
  // `sideEffects`-keyed block further down is the successor.

  it.each(SUPPORTED_BACKENDS)('accepts phase definitions with runner: %s', (runner) => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'test-runner-1',
          name: 'Test Runner',
          instruction: 'inst',
          runner
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('test-runner-1');
    expect(phase?.runner).toBe(runner);
    expect(isPhaseDef(phase)).toBe(true);
  });

  it('rejects phase definitions with invalid runner', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'test-runner-2',
          name: 'Test Runner',
          instruction: 'inst',
          runner: 'invalid-runner-name'
        }
      ]
    });
    const result = loadCatalog(reader);
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
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'test-runner-3',
          name: 'Test Runner',
          instruction: 'inst'
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('test-runner-3');
    expect(phase?.runner).toBeUndefined();
  });

  it('preserves the deprecated loopable compatibility field', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'legacy-loopable',
          name: 'Legacy loopable',
          instruction: 'inst',
          loopable: true
        }
      ]
    });

    const result = loadCatalog(reader);

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
    const reader = makeReader({ workspacePhases: [phase] });

    const result = loadCatalog(reader);

    expect(result.usedFallback).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.catalog.phasesById.get(id)?.runner).toBeUndefined();
    expect(result.catalog.phasesById.get(id)?.sourceScope).toBe('workspace');
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
    const reader = makeReader({ workspacePhases: [phase] });
    const result = loadCatalog(reader);

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
      const reader = makeReader({
        workspacePhases: [
          {
            id: 'finalize',
            name: 'Finalize override',
            instruction: 'Commit and merge the work.',
            runner,
            sideEffects: 'git' as const
          }
        ]
      });

      const result = loadCatalog(reader);

      expect(result.errors).toEqual([]);
      expect(result.catalog.phasesById.get('finalize')?.runner).toBe(runner);
    }
  );
});
