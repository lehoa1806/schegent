import { describe, it, expect } from 'vitest';
import {
  ALLOWED_PHASE_FIELDS,
  EFFORT_LEVELS,
  INSTRUCTION_MAX_LEN,
  NAME_MAX_LEN,
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
  equalsBuiltInPipelines,
  validatePipelineRaw,
  type PhaseDef,
  type PipelineDef
} from '../../../src/config/pipeline-config';
// Feature 098 (T080) — the definitions these tests resolve over now come from the
// fixture rather than from `BUILT_IN_PHASES` / `BUILT_IN_PIPELINE`. Each test
// below is about validation, merge precedence, or by-id map construction; none of
// them was ever about which rows the product compiles in, and sourcing them from
// the built-in layer only made them fail when that layer emptied.
import {
  FIXTURE_PHASES,
  FIXTURE_PHASE_IDS,
  FIXTURE_PIPELINES,
  FIXTURE_PIPELINE_IDS,
  FIXTURE_PIPELINE_SIMPLE
} from '../../fixtures/process-catalog-fixture';

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

  it('accepts the deprecated loopable compatibility field', () => {
    expect(validatePhaseRaw(validPhase({ loopable: true }))).toEqual([]);
    expect(isPhaseDef(validPhase({ loopable: false }))).toBe(true);
  });

  it('rejects a non-boolean loopable compatibility field', () => {
    const errs = validatePhaseRaw({ ...validPhase(), loopable: 'yes' } as never);
    expect(errs.some((e) => e.field === 'loopable')).toBe(true);
  });

  it.each([true, false])('accepts isRequired: %s', (isRequired) => {
    expect(validatePhaseRaw(validPhase({ isRequired }))).toEqual([]);
    expect(isPhaseDef(validPhase({ isRequired }))).toBe(true);
  });

  it('rejects a non-boolean isRequired value', () => {
    const phase = { ...validPhase(), isRequired: 'false' } as never;
    expect(validatePhaseRaw(phase).some((e) => e.field === 'isRequired')).toBe(true);
    expect(isPhaseDef(phase)).toBe(false);
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
      phases: [...FIXTURE_PHASES],
      pipelines: [FIXTURE_PIPELINE_SIMPLE],
      defaultPipelineId: 'non-existent'
    });
    expect(report.warnings.some((w) => w.source === 'pipeline' && w.id === 'non-existent')).toBe(
      true
    );
  });

  it('returns no errors for a well-formed catalog', () => {
    const report = validateCatalog({
      phases: [...FIXTURE_PHASES],
      pipelines: [...FIXTURE_PIPELINES],
      defaultPipelineId: FIXTURE_PIPELINE_IDS.simple
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
  it('workspace shadows user shadows builtin for shared Phase ids (081 FR-003)', () => {
    const customFirst: PhaseDef = {
      id: FIXTURE_PHASE_IDS.first,
      name: 'Workspace First',
      instruction: 'Workspace-level override'
    };
    const userFirst: PhaseDef = {
      id: FIXTURE_PHASE_IDS.first,
      name: 'User First',
      instruction: 'User-level override'
    };
    const merge = mergeCatalog(
      { phases: FIXTURE_PHASES },
      { phases: [userFirst] },
      { phases: [customFirst] }
    );
    const merged = merge.catalog.phases.find((p) => p.id === FIXTURE_PHASE_IDS.first);
    expect(merged?.name).toBe('Workspace First');
  });

  it('flags duplicate phase ids within the same precedence layer', () => {
    const merge = mergeCatalog(
      { phases: FIXTURE_PHASES },
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
      { pipelines: [FIXTURE_PIPELINE_SIMPLE] },
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
    const catalog = buildCatalog(
      [...FIXTURE_PHASES],
      [...FIXTURE_PIPELINES],
      { claude: [], codex: [], agy: [] },
      FIXTURE_PIPELINE_IDS.simple
    );
    expect(catalog.phasesById.get(FIXTURE_PHASE_IDS.first)?.name).toBe('Fixture First');
    expect(catalog.pipelinesById.get(FIXTURE_PIPELINE_IDS.simple)?.id).toBe(
      FIXTURE_PIPELINE_IDS.simple
    );
  });
});

// Feature 098 (T080) — `describe('Feature 026 T021 — speckit-bugfix built-in
// catalog members')` stood here. Its five cases asserted the length of
// `BUILT_IN_PHASES`, the membership of five bugfix ids in `BUILT_IN_PHASE_IDS`,
// the length and ordering of `BUILT_IN_PIPELINES`, and the value of
// `BUILT_IN_PIPELINE_ID` — nothing but the content of the built-in rows, which
// T036 emptied. There is no behavior left to migrate: the same guarantees now
// belong to the YAML documents in `repo/examples/`, and the tests that hold them
// are the import-planner tests that plan those documents.

describe('Feature 026 T017 — phase Effort + Model validator coverage', () => {
  // (a) ALLOWED_PHASE_FIELDS keeps `model` and `effort` (no widening,
  // no narrowing). The "additional unknown property" test elsewhere
  // already asserts the negative case for unknown keys.
  it('ALLOWED_PHASE_FIELDS includes model, effort, and isRequired', () => {
    expect(ALLOWED_PHASE_FIELDS.has('model')).toBe(true);
    expect(ALLOWED_PHASE_FIELDS.has('effort')).toBe(true);
    expect(ALLOWED_PHASE_FIELDS.has('isRequired')).toBe(true);
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

// Feature 082 (T011) — the widened `PipelineDef`. Every new contract field is
// optional so an existing `{ id, name, phases }` row keeps resolving (research
// R2), and the built-ins carry the normalized `version` that FR-010 requires.
describe('Feature 082 — widened PipelineDef', () => {
  it('accepts a legacy { id, name, phases } row with no new field set', () => {
    const legacy: PipelineDef = { id: 'legacy', name: 'Legacy', phases: ['speckit-specify'] };
    expect(isPipelineDef(legacy)).toBe(true);
    expect(legacy.version).toBeUndefined();
    expect(legacy.inputs).toBeUndefined();
    expect(legacy.outputs).toBeUndefined();
    expect(legacy.bindings).toBeUndefined();
    expect(legacy.executionDefaults).toBeUndefined();
    expect(legacy.recommendedNext).toBeUndefined();
    expect(legacy.sourceScope).toBeUndefined();
  });

  it('accepts a fully-specified contract row', () => {
    const full: PipelineDef = {
      id: 'full',
      name: 'Full',
      description: 'demo',
      version: 3,
      phases: ['speckit-specify', 'security-audit'],
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
      outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'brief' }
        },
        { kind: 'output', phaseIndex: 1, portId: 'spec', outputKey: 'spec' }
      ],
      executionDefaults: { runner: 'claude', effort: 'high', timeoutSeconds: 900 },
      recommendedNext: ['legacy'],
      sourceScope: 'workspace'
    };
    expect(isPipelineDef(full)).toBe(true);
    expect(full.bindings).toHaveLength(2);
  });

  // Feature 098 (T080) — `normalizes every built-in to version 1 with no
  // authored contract collections` stood here. It looped over `BUILT_IN_PIPELINES`
  // asserting the shape of each row; with the layer empty (T036) the loop has no
  // iterations and the case would pass without testing anything. The `version`
  // normalization it guarded is a property of the YAML mapper now, and the
  // `accepts a legacy { id, name, phases } row` case above still holds the
  // optionality of every widened field.

  it('keeps equalsBuiltInPipelines matching only an empty reset payload', () => {
    // Feature 098 (T080) — this case built its payload out of `BUILT_IN_PIPELINES`
    // and asserted that a truncated copy failed to match. With the built-in layer
    // empty (T036) the honest statement is the one below: the reset payload the
    // three save commands compare against is `[]`, and any row at all is a
    // divergence from it. The comparison itself is what T037 deliberately kept.
    expect(equalsBuiltInPipelines([])).toBe(true);
    expect(equalsBuiltInPipelines([FIXTURE_PIPELINE_SIMPLE])).toBe(false);
  });

  it('rejects a row whose new field has the wrong shape', () => {
    expect(isPipelineDef({ id: 'x', name: 'X', phases: ['a'], version: '3' })).toBe(false);
    expect(isPipelineDef({ id: 'x', name: 'X', phases: ['a'], inputs: 'brief' })).toBe(false);
    expect(isPipelineDef({ id: 'x', name: 'X', phases: ['a'], recommendedNext: [7] })).toBe(false);
    expect(isPipelineDef({ id: 'x', name: 'X', phases: ['a'], sourceScope: 'global' })).toBe(false);
  });
});

describe('Feature 082 — validatePipelineRaw over the widened contract', () => {
  const knownIds = new Set(['speckit-specify', 'security-audit']);

  it('accepts the new optional fields', () => {
    const errs = validatePipelineRaw(
      validPipeline({
        description: 'demo',
        version: 2,
        inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
        outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }],
        recommendedNext: ['security']
      }) as never,
      knownIds
    );
    expect(errs).toEqual([]);
  });

  it('rejects an unknown port type and names the offending field', () => {
    const errs = validatePipelineRaw(
      validPipeline({ inputs: [{ portId: 'brief', label: 'Brief', type: 'markdown' }] } as never),
      knownIds
    );
    expect(errs.some((e) => e.field === 'inputs[0].type')).toBe(true);
    expect(errs.every((e) => e.source === 'pipeline')).toBe(true);
  });

  it('rejects a non-positive-integer version', () => {
    const errs = validatePipelineRaw(validPipeline({ version: 0 } as never), knownIds);
    expect(errs.some((e) => e.field === 'version')).toBe(true);
  });

  it('still reports an unknown phase reference against the known-id set', () => {
    const errs = validatePipelineRaw(
      validPipeline({ phases: ['speckit-specify', 'made-up-phase'] }),
      knownIds
    );
    expect(errs.some((e) => e.field === 'phases[1]')).toBe(true);
  });
});
