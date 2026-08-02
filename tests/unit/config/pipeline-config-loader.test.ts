import { describe, it, expect } from 'vitest';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import {
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINE_ID,
  isPhaseDef
} from '../../../src/config/pipeline-config';
import { SUPPORTED_BACKENDS } from '../../../src/runner/backend-runner-factory';

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
  it('returns the built-in catalog when no reader is supplied', () => {
    const result = loadCatalog();
    expect(result.catalog.defaultPipelineId).toBe(BUILT_IN_PIPELINE_ID);
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    expect(result.catalog.phasesById.has('speckit-specify')).toBe(true);
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

  it('user settings shadow workspace settings for shared pipeline ids (BUG-003, FR-018)', () => {
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
      workspacePipelines: [workspacePipeline]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const pipeline = result.catalog.pipelinesById.get('security');
    expect(pipeline).toBeDefined();
    expect(pipeline!.name).toBe('User Security Pipeline');
    expect(pipeline!.phases).toEqual(['speckit-specify', 'finalize']);
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
      ]
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
      userPhases: [badPhase]
    });
    expect(() => loadCatalog(reader)).not.toThrow();
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    expect(result.catalog.defaultPipelineId).toBe(BUILT_IN_PIPELINE_ID);
    expect(result.catalog.phasesById.has('speckit-specify')).toBe(true);
    expect(result.catalog.phasesById.has('INVALID-ID-CAPITAL')).toBe(false);
    expect(result.phaseCatalog.records.some((record) => record.status === 'invalid')).toBe(true);
  });

  it('falls back when a pipeline references an unknown phase id (T045)', () => {
    const reader = makeReader({
      userPipelines: [
        {
          id: 'broken',
          name: 'Broken Pipeline',
          phases: ['speckit-specify', 'does-not-exist', 'finalize']
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.usedFallback).toBe(true);
    expect(result.catalog.pipelinesById.has('broken')).toBe(false);
  });

  it('falls back when defaultPipelineId references an unknown pipeline (T045)', () => {
    const reader = makeReader({
      userDefault: 'phantom-pipeline'
    });
    const result = loadCatalog(reader);
    // The catalog merge resolves the defaultPipelineId fallback to BUILT_IN
    // (since the user-supplied phantom is not present), so the result must still be
    // built-in-only and never throw.
    expect(result.catalog.defaultPipelineId).toBe(BUILT_IN_PIPELINE_ID);
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

  it.each(['speckit-specify', 'specify-brainstorm', 'superpowers-implement', 'finalize', 'superpowers-review-close'])(
    'pins the built-in Git-mutating phase %s to Claude',
    (phaseId) => {
      expect(BUILT_IN_PHASES.find((phase) => phase.id === phaseId)?.runner).toBe('claude');
    }
  );

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
      runner: 'codex' as const
    };
    const reader = makeReader({ workspacePhases: [phase] });
    const result = loadCatalog(reader);

    expect(result.usedFallback).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'phase', id })
    ]));
    expect(result.catalog.phasesById.get(id)?.runner).toBe('claude');
    expect(result.catalog.phasesById.get(id)?.sourceScope).toBe('built-in');
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
            runner
          }
        ]
      });

      const result = loadCatalog(reader);

      expect(result.errors).toEqual([]);
      expect(result.catalog.phasesById.get('finalize')?.runner).toBe(runner);
    }
  );
});
