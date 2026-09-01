import { describe, expect, it } from 'vitest';
import {
  PIPELINE_DESCRIPTION_MAX_LEN,
  PIPELINE_ID_PATTERN,
  PIPELINE_NAME_MAX_LEN,
  validatePipelineDefinition
} from '../../../src/config/pipeline-definition-validator';
import type { PipelineFieldError } from '../../../src/contracts/pipeline-definitions';

const valid = (overrides: Record<string, unknown> = {}) => ({
  pipelineId: 'alpha',
  name: 'Alpha',
  version: 1,
  phaseIds: ['specify', 'plan'],
  ...overrides
});

const codes = (errors: readonly PipelineFieldError[]) => errors.map((error) => error.code);
const fields = (errors: readonly PipelineFieldError[]) => errors.map((error) => error.field);

describe('validatePipelineDefinition — entry shape', () => {
  it.each([
    ['null', null],
    ['a string', 'alpha'],
    ['an array', []]
  ])('rejects %s with object-required', (_label, raw) => {
    const result = validatePipelineDefinition(raw);
    expect(result.ok).toBe(false);
    expect(result.definition).toBeNull();
    expect(codes(result.errors)).toEqual(['object-required']);
  });

  it('rejects an unknown authored field', () => {
    const result = validatePipelineDefinition(valid({ colour: 'red' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'colour', code: 'unknown-field' })
    );
  });

  it('exposes only recognized authored fields in display, lists included', () => {
    // `phaseIds` is carried because three sites read a list back out of `display`
    // for an invalid row — see `src/config/authored-display.ts`. The claim this
    // assertion still makes is the closed one: nothing outside the authored set
    // reaches `display`, whatever its type.
    const result = validatePipelineDefinition(valid({ description: 'demo', colour: 'red' }));
    expect(result.display).toEqual({
      pipelineId: 'alpha',
      name: 'Alpha',
      version: 1,
      phaseIds: ['specify', 'plan'],
      description: 'demo'
    });
  });
});

describe('validatePipelineDefinition — identity (FR-007)', () => {
  it('accepts an id matching the portable grammar', () => {
    const result = validatePipelineDefinition(valid());
    expect(result.ok).toBe(true);
    expect(result.pipelineId).toBe('alpha');
    expect(result.definition?.pipelineId).toBe('alpha');
  });

  it.each([
    ['uppercase', 'Alpha'],
    ['leading digit', '1alpha'],
    ['underscore', 'alpha_beta'],
    ['empty', ''],
    ['65 characters', `a${'b'.repeat(64)}`]
  ])('rejects an id with %s', (_label, pipelineId) => {
    const result = validatePipelineDefinition(valid({ pipelineId }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'pipelineId', code: 'invalid-pattern' })
    );
  });

  it('accepts exactly 64 characters and rejects 65', () => {
    const at64 = `a${'b'.repeat(63)}`;
    expect(at64).toHaveLength(64);
    expect(PIPELINE_ID_PATTERN.test(at64)).toBe(true);
    expect(validatePipelineDefinition(valid({ pipelineId: at64 })).ok).toBe(true);
    expect(validatePipelineDefinition(valid({ pipelineId: `${at64}c` })).ok).toBe(false);
  });

  it('rejects carrying both pipelineId and legacy id', () => {
    const result = validatePipelineDefinition({
      pipelineId: 'alpha',
      id: 'alpha',
      name: 'Alpha',
      version: 1,
      phaseIds: ['plan']
    });
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('identity-ambiguous');
  });

  it('bounds a runaway id inside the reported error', () => {
    const result = validatePipelineDefinition(valid({ pipelineId: 'a'.repeat(400) }));
    expect(result.ok).toBe(false);
    for (const error of result.errors) {
      expect(error.pipelineId.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('validatePipelineDefinition — metadata (FR-008, FR-009, FR-010)', () => {
  it('rejects an empty or whitespace-only name', () => {
    for (const name of ['', '   ']) {
      const result = validatePipelineDefinition(valid({ name }));
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'name', code: 'invalid-length' })
      );
    }
  });

  it('accepts a name at the 80-character bound and rejects 81', () => {
    expect(validatePipelineDefinition(valid({ name: 'n'.repeat(PIPELINE_NAME_MAX_LEN) })).ok).toBe(
      true
    );
    const over = validatePipelineDefinition(
      valid({ name: 'n'.repeat(PIPELINE_NAME_MAX_LEN + 1) })
    );
    expect(over.ok).toBe(false);
    expect(fields(over.errors)).toContain('name');
  });

  it('accepts a description at the 1024-character bound and rejects 1025', () => {
    expect(
      validatePipelineDefinition(valid({ description: 'd'.repeat(PIPELINE_DESCRIPTION_MAX_LEN) })).ok
    ).toBe(true);
    const over = validatePipelineDefinition(
      valid({ description: 'd'.repeat(PIPELINE_DESCRIPTION_MAX_LEN + 1) })
    );
    expect(over.ok).toBe(false);
    expect(over.errors).toContainEqual(
      expect.objectContaining({ field: 'description', code: 'invalid-length' })
    );
  });

  it.each([[0], [-1], [1.5], ['1'], [Number.NaN]])(
    'rejects a non-positive-integer version %p',
    (version) => {
      const result = validatePipelineDefinition(valid({ version }));
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'version', code: 'positive-integer-required' })
      );
    }
  );

  it('applies defaultVersion when version is absent', () => {
    const raw = valid();
    delete (raw as Record<string, unknown>).version;
    const result = validatePipelineDefinition(raw, { defaultVersion: 4 });
    expect(result.ok).toBe(true);
    expect(result.definition?.version).toBe(4);
  });
});

describe('validatePipelineDefinition — phase references (FR-011)', () => {
  it('rejects an empty phaseIds sequence', () => {
    const result = validatePipelineDefinition(valid({ phaseIds: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'phaseIds', code: 'non-empty-required' })
    );
  });

  it('rejects a missing or non-array phaseIds', () => {
    const raw = valid();
    delete (raw as Record<string, unknown>).phaseIds;
    expect(validatePipelineDefinition(raw).ok).toBe(false);
    expect(validatePipelineDefinition(valid({ phaseIds: 'plan' })).ok).toBe(false);
  });

  it('rejects a malformed phase reference and names its position', () => {
    const result = validatePipelineDefinition(valid({ phaseIds: ['plan', 'Bad Id'] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'phaseIds[1]', code: 'invalid-pattern' })
    );
  });

  it('permits a repeated phase reference — the sequence is positional', () => {
    const result = validatePipelineDefinition(valid({ phaseIds: ['review', 'plan', 'review'] }));
    expect(result.ok).toBe(true);
    expect(result.definition?.phaseIds).toEqual(['review', 'plan', 'review']);
  });
});

describe('validatePipelineDefinition — ports (FR-012, FR-013, FR-014)', () => {
  const port = (overrides: Record<string, unknown> = {}) => ({
    portId: 'brief',
    label: 'Brief',
    type: 'text',
    ...overrides
  });

  it('accepts declared input and output ports', () => {
    const result = validatePipelineDefinition(
      valid({
        inputs: [port()],
        outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }]
      })
    );
    expect(result.ok).toBe(true);
    expect(result.definition?.inputs).toEqual([
      { portId: 'brief', label: 'Brief', type: 'text', required: true }
    ]);
    expect(result.definition?.outputs).toEqual([
      { portId: 'plan', label: 'Plan', type: 'markdown' }
    ]);
  });

  it('rejects an unknown input port type', () => {
    const result = validatePipelineDefinition(valid({ inputs: [port({ type: 'markdown' })] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'inputs[0].type', code: 'invalid-enum' })
    );
  });

  it('rejects an unknown output port type', () => {
    const result = validatePipelineDefinition(
      valid({ outputs: [{ portId: 'plan', label: 'Plan', type: 'text' }] })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'outputs[0].type', code: 'invalid-enum' })
    );
  });

  it('rejects a duplicate portId inside one namespace', () => {
    const result = validatePipelineDefinition(
      valid({ inputs: [port(), port({ label: 'Brief again' })] })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'inputs[1].portId', code: 'duplicate-port-id' })
    );
  });

  it('accepts the same portId in the input and output namespaces', () => {
    const result = validatePipelineDefinition(
      valid({
        inputs: [port({ portId: 'spec' })],
        outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }]
      })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a malformed portId and an over-long label', () => {
    const result = validatePipelineDefinition(
      valid({ inputs: [port({ portId: 'Brief_1', label: 'l'.repeat(81) })] })
    );
    expect(result.ok).toBe(false);
    expect(fields(result.errors)).toEqual(
      expect.arrayContaining(['inputs[0].portId', 'inputs[0].label'])
    );
  });

  it('rejects a non-object port entry', () => {
    const result = validatePipelineDefinition(valid({ inputs: ['brief'] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'inputs[0]', code: 'object-required' })
    );
  });

  it('honours an explicit required: false and defaults required to true', () => {
    const explicit = validatePipelineDefinition(valid({ inputs: [port({ required: false })] }));
    expect(explicit.definition?.inputs[0]?.required).toBe(false);
    const implied = validatePipelineDefinition(valid({ inputs: [port()] }));
    expect(implied.definition?.inputs[0]?.required).toBe(true);
  });
});

describe('validatePipelineDefinition — execution defaults (FR-018)', () => {
  it('accepts the four permitted keys', () => {
    const result = validatePipelineDefinition(
      valid({
        executionDefaults: {
          runner: 'claude',
          model: 'claude-opus-5',
          effort: 'high',
          timeoutSeconds: 600
        }
      })
    );
    expect(result.ok).toBe(true);
    expect(result.definition?.executionDefaults).toEqual({
      runner: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      timeoutSeconds: 600
    });
  });

  it('rejects any other key', () => {
    const result = validatePipelineDefinition(
      valid({ executionDefaults: { runner: 'claude', sideEffects: 'git' } })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'execution-defaults-unknown-field' })
    );
  });

  it.each([[0], [3601], [1.5], ['600']])('rejects timeoutSeconds %p', (timeoutSeconds) => {
    const result = validatePipelineDefinition(valid({ executionDefaults: { timeoutSeconds } }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: 'executionDefaults.timeoutSeconds',
        code: 'invalid-range'
      })
    );
  });

  it('accepts the timeout bounds inclusively', () => {
    expect(validatePipelineDefinition(valid({ executionDefaults: { timeoutSeconds: 1 } })).ok).toBe(
      true
    );
    expect(
      validatePipelineDefinition(valid({ executionDefaults: { timeoutSeconds: 3600 } })).ok
    ).toBe(true);
  });

  it('rejects an unknown runner and an unknown effort', () => {
    const result = validatePipelineDefinition(
      valid({ executionDefaults: { runner: 'nope', effort: 'extreme' } })
    );
    expect(result.ok).toBe(false);
    expect(fields(result.errors)).toEqual(
      expect.arrayContaining(['executionDefaults.runner', 'executionDefaults.effort'])
    );
  });

  it('rejects a non-object executionDefaults', () => {
    const result = validatePipelineDefinition(valid({ executionDefaults: 'claude' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'executionDefaults', code: 'object-required' })
    );
  });
});

describe('validatePipelineDefinition — recommendedNext (FR-019)', () => {
  it('accepts a list of well-formed pipeline ids', () => {
    const result = validatePipelineDefinition(valid({ recommendedNext: ['beta', 'gamma'] }));
    expect(result.ok).toBe(true);
    expect(result.definition?.recommendedNext).toEqual(['beta', 'gamma']);
  });

  it('rejects a malformed entry — resolution is a separate, non-blocking concern', () => {
    const result = validatePipelineDefinition(valid({ recommendedNext: ['Beta'] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'recommendedNext[0]', code: 'invalid-pattern' })
    );
  });
});

describe('validatePipelineDefinition — binding shape', () => {
  it('accepts structurally well-formed input and output bindings', () => {
    const result = validatePipelineDefinition(
      valid({
        bindings: [
          {
            kind: 'input',
            phaseIndex: 1,
            inputKey: 'spec',
            source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
          },
          { kind: 'output', phaseIndex: 1, portId: 'plan', outputKey: 'plan' }
        ]
      })
    );
    expect(result.ok).toBe(true);
    expect(result.definition?.bindings).toHaveLength(2);
  });

  it('rejects an unknown binding kind and a fractional phaseIndex', () => {
    const unknownKind = validatePipelineDefinition(
      valid({ bindings: [{ kind: 'sideways', phaseIndex: 0 }] })
    );
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.errors).toContainEqual(
      expect.objectContaining({ field: 'bindings[0].kind', code: 'invalid-enum' })
    );

    const fractional = validatePipelineDefinition(
      valid({
        bindings: [
          {
            kind: 'input',
            phaseIndex: 0.5,
            inputKey: 'spec',
            source: { from: 'pipeline-input', portId: 'brief' }
          }
        ]
      })
    );
    expect(fractional.ok).toBe(false);
    expect(fractional.errors).toContainEqual(
      expect.objectContaining({ field: 'bindings[0].phaseIndex', code: 'invalid-range' })
    );
  });

  it('rejects an unknown binding source', () => {
    const result = validatePipelineDefinition(
      valid({
        bindings: [
          { kind: 'input', phaseIndex: 0, inputKey: 'spec', source: { from: 'thin-air' } }
        ]
      })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'bindings[0].source', code: 'invalid-enum' })
    );
  });
});

describe('validatePipelineDefinition — legacy rows (research R2)', () => {
  it('accepts and normalizes a legacy { id, name, phases } row', () => {
    const result = validatePipelineDefinition({
      id: 'speckit-new-feature',
      name: 'Spec Kit New Feature',
      phases: ['speckit-specify', 'done']
    });
    expect(result.ok).toBe(true);
    expect(result.definition).toEqual({
      pipelineId: 'speckit-new-feature',
      name: 'Spec Kit New Feature',
      version: 1,
      phaseIds: ['speckit-specify', 'done'],
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    });
    expect(result.definition?.executionDefaults).toBeUndefined();
  });

  it('rejects a legacy id when allowLegacyId is false', () => {
    const result = validatePipelineDefinition(
      { id: 'alpha', name: 'Alpha', phases: ['plan'] },
      { allowLegacyId: false }
    );
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('invalid-pattern');
  });

  it('rejects carrying both phases and phaseIds', () => {
    const result = validatePipelineDefinition({
      pipelineId: 'alpha',
      name: 'Alpha',
      phases: ['plan'],
      phaseIds: ['plan']
    });
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('sequence-ambiguous');
  });
});

describe('validatePipelineDefinition — error bounds (FR-032)', () => {
  it('bounds every reported field, code, and message', () => {
    const result = validatePipelineDefinition({
      pipelineId: 'alpha',
      name: '',
      version: 0,
      phaseIds: [],
      [`x${'y'.repeat(200)}`]: 1
    });
    expect(result.ok).toBe(false);
    for (const error of result.errors) {
      expect(error.field.length).toBeLessThanOrEqual(32);
      expect(error.code.length).toBeLessThanOrEqual(64);
      expect(error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('freezes the returned definition and error list', () => {
    const ok = validatePipelineDefinition(valid());
    expect(Object.isFrozen(ok.definition)).toBe(true);
    expect(Object.isFrozen(ok.errors)).toBe(true);
    const bad = validatePipelineDefinition(valid({ name: '' }));
    expect(Object.isFrozen(bad.errors)).toBe(true);
  });
});
