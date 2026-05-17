import { describe, it, expect } from 'vitest';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import { BUILT_IN_PIPELINE_ID } from '../../../src/config/pipeline-config';

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

  it('workspace settings shadow user settings for shared phase ids (T044, FR-021)', () => {
    const userPhase = {
      id: 'security-audit',
      name: 'User Security Audit',
      instruction: 'User-level instruction.',
      loopable: false
    };
    const workspacePhase = {
      id: 'security-audit',
      name: 'Workspace Security Audit',
      instruction: 'Workspace-level instruction (wins).',
      loopable: true,
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
    expect(phase!.instruction).toBe('Workspace-level instruction (wins).');
    expect(phase!.loopable).toBe(true);
    expect(phase!.model).toBe('claude-opus-4-7');
    expect(phase!.effort).toBe('high');
  });

  it('workspace settings shadow user settings for shared pipeline ids (T044, FR-021)', () => {
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
    expect(pipeline!.name).toBe('Workspace Security Pipeline');
    expect(pipeline!.phases).toEqual(['speckit-specify', 'speckit-clarify', 'finalize']);
  });

  it('user settings shadow built-in defaults for shared ids (T044)', () => {
    const userOverride = {
      id: 'speckit-specify',
      name: 'Custom Specify',
      instruction: 'User-overridden specify instruction.',
      loopable: false
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

  it('workspace defaultPipelineId shadows user defaultPipelineId (T044)', () => {
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

  it('returns built-in catalog and emits errors when validation fails — no throw (T045, FR-024)', () => {
    const badPhase = {
      id: 'INVALID-ID-CAPITAL',
      name: 'Bad',
      instruction: 'x',
      loopable: false
    };
    const reader = makeReader({
      userPhases: [badPhase]
    });
    expect(() => loadCatalog(reader)).not.toThrow();
    const result = loadCatalog(reader);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.usedFallback).toBe(true);
    expect(result.catalog.defaultPipelineId).toBe(BUILT_IN_PIPELINE_ID);
    expect(result.catalog.phasesById.has('speckit-specify')).toBe(true);
    expect(result.catalog.phasesById.has('INVALID-ID-CAPITAL')).toBe(false);
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
          loopable: false
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
        { id: 'twin', name: 'First', instruction: 'a', loopable: false },
        { id: 'twin', name: 'Second', instruction: 'b', loopable: false }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.id === 'twin')).toBe(true);
    expect(result.catalog.phasesById.get('twin')!.name).toBe('Second');
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
          loopable: true,
          retryCondition: 'open_questions > 0'
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('security-audit');
    expect(phase?.retryCondition).toBe('open_questions > 0');
  });

  it('strips a syntactically invalid retryCondition and keeps the PhaseDef loadable (FR-014, SC-006)', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          loopable: true,
          retryCondition: 'open_questions > 0 AND broken'
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.errors).toEqual([]);
    const phase = result.catalog.phasesById.get('broken');
    expect(phase).toBeDefined();
    expect(phase?.retryCondition).toBeUndefined();
  });

  it('emits exactly one warning per load naming the offending phase id', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          loopable: true,
          retryCondition: '@@invalid'
        }
      ]
    });
    const result = loadCatalog(reader);
    const matches = result.warnings.filter((w) => w.id === 'broken');
    expect(matches.length).toBe(1);
    expect(matches[0].message ?? '').toMatch(/retryCondition/i);
  });

  it('keeps extension activation alive when a retryCondition is invalid', () => {
    const reader = makeReader({
      workspacePhases: [
        {
          id: 'broken',
          name: 'Broken',
          instruction: 'inst',
          loopable: true,
          retryCondition: '!!!'
        },
        {
          id: 'ok',
          name: 'OK',
          instruction: 'inst',
          loopable: false
        }
      ]
    });
    const result = loadCatalog(reader);
    expect(result.usedFallback).toBe(false);
    expect(result.catalog.phasesById.get('ok')).toBeDefined();
  });
});
