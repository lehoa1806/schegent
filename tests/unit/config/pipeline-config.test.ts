import { describe, it, expect } from 'vitest';
import {
  ALLOWED_PHASE_FIELDS,
  BUILT_IN_BUGFIX_PIPELINE,
  BUILT_IN_BUGFIX_PIPELINE_ID,
  BUILT_IN_PHASES,
  BUILT_IN_PHASE_IDS,
  BUILT_IN_PIPELINE,
  BUILT_IN_PIPELINE_ID,
  BUILT_IN_PIPELINES,
  EFFORT_LEVELS,
  INSTRUCTION_MAX_LEN,
  NAME_MAX_LEN,
  PHASE_ID_PATTERN,
  SOFT_CAP_PHASES,
  SOFT_CAP_PIPELINES,
  SOFT_CAP_PIPELINE_PHASES,
  TIMEOUT_MAX,
  buildCatalog,
  isPhaseDef,
  isPipelineDef,
  mergeCatalog,
  validateCatalog,
  validatePhaseRaw,
  validatePipelineRaw,
  type PhaseDef,
  type PipelineDef
} from '../../../src/config/pipeline-config';

const validPhase = (overrides: Partial<PhaseDef> = {}): PhaseDef => ({
  id: 'security-audit',
  name: 'Security Audit',
  instruction: 'Audit the staged diff for security regressions.',
  
  ...overrides
});

const validPipeline = (overrides: Partial<PipelineDef> = {}): PipelineDef => ({
  id: 'security',
  name: 'Security Audit Pipeline',
  phases: ['speckit-specify', 'security-audit'],
  ...overrides
});

describe('validatePhaseRaw — error rules from contracts/pipeline-config.md', () => {
  it('rejects bad id pattern (uppercase)', () => {
    const errs = validatePhaseRaw(validPhase({ id: 'SecurityAudit' }));
    expect(errs.some((e) => e.source === 'phase' && e.field === 'id')).toBe(true);
  });

  it('rejects empty id', () => {
    const errs = validatePhaseRaw(validPhase({ id: '' }));
    expect(errs.some((e) => e.field === 'id')).toBe(true);
  });

  it('rejects id exceeding 64 characters', () => {
    const errs = validatePhaseRaw(validPhase({ id: 'a'.repeat(65) }));
    expect(errs.some((e) => e.field === 'id')).toBe(true);
  });

  it('rejects empty name', () => {
    const errs = validatePhaseRaw(validPhase({ name: '' }));
    expect(errs.some((e) => e.field === 'name')).toBe(true);
  });

  it('rejects name longer than 80 chars', () => {
    const errs = validatePhaseRaw(validPhase({ name: 'x'.repeat(NAME_MAX_LEN + 1) }));
    expect(errs.some((e) => e.field === 'name')).toBe(true);
  });

  it('rejects empty instruction', () => {
    const errs = validatePhaseRaw(validPhase({ instruction: '' }));
    expect(errs.some((e) => e.field === 'instruction')).toBe(true);
  });

  it('rejects instruction longer than 8192 chars', () => {
    const errs = validatePhaseRaw(validPhase({ instruction: 'x'.repeat(INSTRUCTION_MAX_LEN + 1) }));
    expect(errs.some((e) => e.field === 'instruction')).toBe(true);
  });

  it('rejects model defined but empty string', () => {
    const errs = validatePhaseRaw(validPhase({ model: '' }));
    expect(errs.some((e) => e.field === 'model')).toBe(true);
  });

  it('rejects invalid effort value', () => {
    const errs = validatePhaseRaw({ ...validPhase(), effort: 'extreme' as never });
    expect(errs.some((e) => e.field === 'effort')).toBe(true);
  });

  it('accepts every documented effort level', () => {
    for (const effort of EFFORT_LEVELS) {
      const errs = validatePhaseRaw(validPhase({ effort }));
      expect(errs).toEqual([]);
    }
  });

  it('rejects timeoutSeconds below 1', () => {
    const errs = validatePhaseRaw(validPhase({ timeoutSeconds: 0 }));
    expect(errs.some((e) => e.field === 'timeoutSeconds')).toBe(true);
  });

  it('rejects timeoutSeconds above 3600', () => {
    const errs = validatePhaseRaw(validPhase({ timeoutSeconds: TIMEOUT_MAX + 1 }));
    expect(errs.some((e) => e.field === 'timeoutSeconds')).toBe(true);
  });

  it('rejects non-integer timeoutSeconds', () => {
    const errs = validatePhaseRaw(validPhase({ timeoutSeconds: 1.5 }));
    expect(errs.some((e) => e.field === 'timeoutSeconds')).toBe(true);
  });

  it('accepts valid retryCondition', () => {
    const errs = validatePhaseRaw(validPhase({ retryCondition: 'open_questions > 0' }));
    expect(errs.some((e) => e.field === 'retryCondition')).toBe(false);
  });

  it('rejects non-string retryCondition', () => {
    const errs = validatePhaseRaw({ ...validPhase(), retryCondition: 123 } as never);
    expect(errs.some((e) => e.field === 'retryCondition')).toBe(true);
  });

  it('rejects additional unknown property', () => {
    const errs = validatePhaseRaw({ ...validPhase(), unexpected: 'leak' } as never);
    expect(errs.some((e) => e.field === 'unexpected')).toBe(true);
  });

  it('rejects non-object phase entry', () => {
    expect(validatePhaseRaw(null).length).toBeGreaterThan(0);
    expect(validatePhaseRaw('hello').length).toBeGreaterThan(0);
    expect(validatePhaseRaw([]).length).toBeGreaterThan(0);
  });

  it('accepts a fully-specified valid phase', () => {
    const errs = validatePhaseRaw(
      validPhase({ model: 'claude-opus-4-7', effort: 'high', timeoutSeconds: 600 })
    );
    expect(errs).toEqual([]);
  });
});

describe('validatePipelineRaw — error rules from contracts/pipeline-config.md', () => {
  const knownIds = new Set(['speckit-specify', 'security-audit']);

  it('rejects empty phases array', () => {
    const errs = validatePipelineRaw(validPipeline({ phases: [] }), knownIds);
    expect(errs.some((e) => e.field === 'phases')).toBe(true);
  });

  it('rejects unknown phase id reference', () => {
    const errs = validatePipelineRaw(
      validPipeline({ phases: ['speckit-specify', 'made-up-phase'] }),
      knownIds
    );
    expect(errs.some((e) => e.field === 'phases[1]')).toBe(true);
  });

  it('rejects bad pipeline id pattern', () => {
    const errs = validatePipelineRaw(validPipeline({ id: 'BadId' }), knownIds);
    expect(errs.some((e) => e.field === 'id')).toBe(true);
  });

  it('rejects empty pipeline name', () => {
    const errs = validatePipelineRaw(validPipeline({ name: '' }), knownIds);
    expect(errs.some((e) => e.field === 'name')).toBe(true);
  });

  it('rejects name longer than 80 chars', () => {
    const errs = validatePipelineRaw(
      validPipeline({ name: 'x'.repeat(NAME_MAX_LEN + 1) }),
      knownIds
    );
    expect(errs.some((e) => e.field === 'name')).toBe(true);
  });

  it('rejects unknown property on pipeline', () => {
    const errs = validatePipelineRaw(
      { ...validPipeline(), extra: 'leak' } as never,
      knownIds
    );
    expect(errs.some((e) => e.field === 'extra')).toBe(true);
  });

  it('accepts a valid pipeline definition', () => {
    const errs = validatePipelineRaw(validPipeline(), knownIds);
    expect(errs).toEqual([]);
  });
});

describe('validateCatalog — soft caps and warnings', () => {
  it('warns when total phases exceeds SOFT_CAP_PHASES (>50)', () => {
    const phases: PhaseDef[] = [];
    for (let i = 0; i < SOFT_CAP_PHASES + 1; i++) {
      phases.push(validPhase({ id: `phase-${i}`, name: `P ${i}` }));
    }
    const report = validateCatalog({
      phases,
      pipelines: [validPipeline({ phases: ['phase-0'] })],
      defaultPipelineId: 'security'
    });
    expect(report.warnings.some((w) => w.source === 'limit')).toBe(true);
  });

  it('warns when total pipelines exceeds SOFT_CAP_PIPELINES (>20)', () => {
    const pipelines: PipelineDef[] = [];
    for (let i = 0; i < SOFT_CAP_PIPELINES + 1; i++) {
      pipelines.push(validPipeline({ id: `p-${i}`, name: `P ${i}`, phases: ['speckit-specify'] }));
    }
    const report = validateCatalog({
      phases: [validPhase({ id: 'speckit-specify', name: 'Spec-kit Specify' })],
      pipelines,
      defaultPipelineId: 'p-0'
    });
    expect(report.warnings.some((w) => w.source === 'limit')).toBe(true);
  });

  it('warns when a pipeline has more than 50 phase entries', () => {
    const phaseIds: string[] = [];
    const phases: PhaseDef[] = [];
    for (let i = 0; i < SOFT_CAP_PIPELINE_PHASES + 1; i++) {
      phaseIds.push(`p-${i}`);
      phases.push(validPhase({ id: `p-${i}`, name: `P ${i}` }));
    }
    const report = validateCatalog({
      phases,
      pipelines: [validPipeline({ id: 'huge', name: 'Huge', phases: phaseIds })],
      defaultPipelineId: 'huge'
    });
    expect(report.warnings.some((w) => w.source === 'limit' && w.id === 'huge')).toBe(true);
  });

  it('warns when defaultPipelineId references unknown pipeline', () => {
    const report = validateCatalog({
      phases: [...BUILT_IN_PHASES],
      pipelines: [BUILT_IN_PIPELINE],
      defaultPipelineId: 'non-existent'
    });
    expect(report.warnings.some((w) => w.source === 'pipeline' && w.id === 'non-existent')).toBe(
      true
    );
  });

  it('returns no errors for built-in catalog', () => {
    const report = validateCatalog({
      phases: [...BUILT_IN_PHASES],
      pipelines: [BUILT_IN_PIPELINE],
      defaultPipelineId: BUILT_IN_PIPELINE_ID
    });
    expect(report.errors).toEqual([]);
  });

  it('T055: emits one limit warning per soft-cap breach without rejecting the catalog', () => {
    const phases: PhaseDef[] = [];
    for (let i = 0; i < SOFT_CAP_PHASES + 1; i++) {
      phases.push(validPhase({ id: `phase-${i}`, name: `P ${i}` }));
    }
    const hugePhaseIds = phases
      .slice(0, SOFT_CAP_PIPELINE_PHASES + 1)
      .map((p) => p.id);
    const pipelines: PipelineDef[] = [
      validPipeline({ id: 'huge', name: 'Huge', phases: hugePhaseIds })
    ];
    for (let i = 0; i < SOFT_CAP_PIPELINES; i++) {
      pipelines.push(
        validPipeline({ id: `extra-${i}`, name: `Extra ${i}`, phases: ['phase-0'] })
      );
    }
    const report = validateCatalog({
      phases,
      pipelines,
      defaultPipelineId: 'huge'
    });
    expect(report.errors).toEqual([]);
    const limitWarnings = report.warnings.filter((w) => w.source === 'limit');
    const phaseCountWarnings = limitWarnings.filter((w) => w.id === undefined && /phases/.test(w.message) && /soft cap is 50/.test(w.message));
    const pipelineCountWarnings = limitWarnings.filter((w) => w.id === undefined && /pipelines/.test(w.message) && /soft cap is 20/.test(w.message));
    const pipelinePhaseWarnings = limitWarnings.filter((w) => w.id === 'huge');
    expect(phaseCountWarnings.length).toBe(1);
    expect(pipelineCountWarnings.length).toBe(1);
    expect(pipelinePhaseWarnings.length).toBe(1);
  });
});

describe('mergeCatalog — precedence and duplicate warnings', () => {
  it('user shadows workspace shadows builtin for shared ids (BUG-003)', () => {
    const customSpecify: PhaseDef = {
      id: 'speckit-specify',
      name: 'Workspace Specify',
      instruction: 'Workspace-level override',
      
    };
    const userSpecify: PhaseDef = {
      id: 'speckit-specify',
      name: 'User Specify',
      instruction: 'User-level override',
      
    };
    const merge = mergeCatalog(
      { phases: BUILT_IN_PHASES },
      { phases: [userSpecify] },
      { phases: [customSpecify] }
    );
    const merged = merge.catalog.phases.find((p) => p.id === 'speckit-specify');
    expect(merged?.name).toBe('User Specify');
  });

  it('flags duplicate phase ids within the same precedence layer', () => {
    const merge = mergeCatalog(
      { phases: BUILT_IN_PHASES },
      {
        phases: [
          validPhase({ id: 'audit-x', name: 'A' }),
          validPhase({ id: 'audit-x', name: 'B' })
        ]
      },
      {}
    );
    expect(merge.duplicateWarnings.some((w) => w.source === 'phase' && w.id === 'audit-x')).toBe(
      true
    );
  });

  it('flags duplicate pipeline ids within the same precedence layer', () => {
    const merge = mergeCatalog(
      { pipelines: [BUILT_IN_PIPELINE] },
      {
        pipelines: [
          validPipeline({ id: 'sec', phases: ['speckit-specify'] }),
          validPipeline({ id: 'sec', phases: ['speckit-specify'] })
        ]
      },
      {}
    );
    expect(merge.duplicateWarnings.some((w) => w.source === 'pipeline' && w.id === 'sec')).toBe(
      true
    );
  });
});

describe('isPhaseDef / isPipelineDef predicates', () => {
  it('returns true for a valid PhaseDef', () => {
    expect(isPhaseDef(validPhase())).toBe(true);
  });

  it('returns true for a valid PipelineDef', () => {
    expect(isPipelineDef(validPipeline())).toBe(true);
  });

  it('returns false when phases is not an array', () => {
    expect(isPipelineDef({ id: 'x', name: 'X', phases: 'speckit-specify' } as never)).toBe(false);
  });
});

describe('buildCatalog — constructs by-id maps', () => {
  it('exposes phasesById and pipelinesById', () => {
    const catalog = buildCatalog([...BUILT_IN_PHASES], [BUILT_IN_PIPELINE], [], BUILT_IN_PIPELINE_ID);
    expect(catalog.phasesById.get('speckit-specify')?.name).toBe('Spec-kit Specify');
    expect(catalog.pipelinesById.get(BUILT_IN_PIPELINE_ID)?.id).toBe(BUILT_IN_PIPELINE_ID);
  });
});

describe('Feature 026 T021 — speckit-bugfix built-in catalog members', () => {
  const BUGFIX_PHASE_IDS = [
    'bugfix-report',
    'bugfix-patch',
    'bugfix-verify-pre',
    'bugfix-implement',
    'bugfix-verify-post'
  ] as const;

  it('(a) BUILT_IN_PHASES.length === 12', () => {
    // 7 standard (specify, clarify, plan, tasks, analyze, implement,
    // finalize) + 5 bugfix (report, patch, verify-pre, implement,
    // verify-post) = 12.
    expect(BUILT_IN_PHASES.length).toBe(12);
  });

  it('(b) every new bugfix phase id is present in BUILT_IN_PHASE_IDS', () => {
    for (const id of BUGFIX_PHASE_IDS) {
      expect((BUILT_IN_PHASE_IDS as readonly string[]).includes(id)).toBe(true);
    }
  });

  it('(c) BUILT_IN_PIPELINES.length === 2 with bugfix pipeline second in id + ordered phases', () => {
    expect(BUILT_IN_PIPELINES.length).toBe(2);
    const bugfix = BUILT_IN_PIPELINES[1];
    expect(bugfix.id).toBe('speckit-bugfix');
    expect(bugfix.id).toBe(BUILT_IN_BUGFIX_PIPELINE_ID);
    expect([...bugfix.phases]).toEqual([...BUGFIX_PHASE_IDS]);
    // The exported pipeline constant is the same identity used in the
    // array — guards against accidental duplication.
    expect(BUILT_IN_BUGFIX_PIPELINE.phases).toEqual(bugfix.phases);
  });

  it('(d) BUILT_IN_PIPELINE_ID remains `speckit-new-feature` (default unchanged)', () => {
    expect(BUILT_IN_PIPELINE_ID).toBe('speckit-new-feature');
  });

  it('(e) every bugfix phase id matches PHASE_ID_PATTERN', () => {
    for (const id of BUGFIX_PHASE_IDS) {
      expect(PHASE_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

describe('Feature 026 T017 — phase Effort + Model validator coverage', () => {
  // (a) ALLOWED_PHASE_FIELDS keeps `model` and `effort` (no widening,
  // no narrowing). The "additional unknown property" test elsewhere
  // already asserts the negative case for unknown keys.
  it('ALLOWED_PHASE_FIELDS continues to include both `model` and `effort`', () => {
    expect(ALLOWED_PHASE_FIELDS.has('model')).toBe(true);
    expect(ALLOWED_PHASE_FIELDS.has('effort')).toBe(true);
  });

  // (b) EFFORT_LEVELS is the exact 5-element ordered list. A change in
  // contents OR order trips this regression.
  it('EFFORT_LEVELS deep-equals [low, medium, high, xhigh, max]', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  // (c) effort: 'high' accepted; effort: 'turbo' rejected with a
  // per-row error code (the message identifies the field).
  it('validatePhaseRaw accepts effort: "high" and rejects effort: "turbo" with a per-row code', () => {
    const accept = validatePhaseRaw(validPhase({ effort: 'high' }));
    expect(accept).toEqual([]);
    const reject = validatePhaseRaw({ ...validPhase(), effort: 'turbo' } as never);
    const effortErr = reject.find((e) => e.field === 'effort');
    expect(effortErr).toBeDefined();
    expect(effortErr?.source).toBe('phase');
    expect(effortErr?.id).toBe('security-audit');
    // The per-row code is the (source, id, field, message) tuple. The
    // message MUST cite EFFORT_LEVELS so future drift on the allowed
    // list also breaks the message contract.
    expect(effortErr?.message).toMatch(/low.*medium.*high.*xhigh.*max/);
  });

  // (d) model: 'claude-sonnet-4-6' accepted; model: '' rejected with
  // a per-row code (the model identifier shape check enforces FR-005
  // at the validator layer; the permitted-models set is enforced at
  // catalog-load time and the integration test in T018).
  it('validatePhaseRaw accepts a non-empty model identifier and rejects empty/non-string model', () => {
    const acceptKnown = validatePhaseRaw(validPhase({ model: 'claude-sonnet-4-6' }));
    expect(acceptKnown).toEqual([]);
    const rejectEmpty = validatePhaseRaw(validPhase({ model: '' }));
    const emptyErr = rejectEmpty.find((e) => e.field === 'model');
    expect(emptyErr).toBeDefined();
    expect(emptyErr?.source).toBe('phase');
    expect(emptyErr?.id).toBe('security-audit');
    const rejectNonString = validatePhaseRaw({ ...validPhase(), model: 123 } as never);
    expect(rejectNonString.some((e) => e.field === 'model')).toBe(true);
  });
});
