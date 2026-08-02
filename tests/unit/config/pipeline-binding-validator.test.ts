import { describe, expect, it } from 'vitest';
import { validatePipelineBindings } from '../../../src/config/pipeline-binding-validator';
import type {
  PhaseBinding,
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort
} from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';

const phase = (phaseId: string): PhaseDefinition => ({
  phaseId,
  name: phaseId,
  version: 1,
  instruction: phaseId
});

const effectivePhases: readonly PhaseDefinition[] = [
  phase('specify'),
  phase('plan'),
  phase('review')
];

const pipeline = (overrides: Partial<PipelineDefinition> = {}): PipelineDefinition => ({
  pipelineId: 'alpha',
  name: 'Alpha',
  version: 1,
  phaseIds: ['specify', 'plan'],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: [],
  ...overrides
});

const input = (
  portId: string,
  type: PipelineInputPort['type'] = 'text'
): PipelineInputPort => ({ portId, label: portId, type, required: true });

const output = (
  portId: string,
  type: PipelineOutputPort['type'] = 'markdown'
): PipelineOutputPort => ({ portId, label: portId, type });

const codes = (definition: PipelineDefinition) =>
  validatePipelineBindings(definition, effectivePhases).map((error) => error.code);

describe('validatePipelineBindings — clean cases', () => {
  it('accepts a pipeline with no bindings', () => {
    expect(validatePipelineBindings(pipeline(), effectivePhases)).toEqual([]);
  });

  it('accepts a session input feeding the first phase', () => {
    const definition = pipeline({
      inputs: [input('brief')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'brief' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toEqual([]);
  });

  it('accepts a phase writing a declared output port', () => {
    const definition = pipeline({
      outputs: [output('plan')],
      bindings: [{ kind: 'output', phaseIndex: 1, portId: 'plan', outputKey: 'plan' }]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toEqual([]);
  });

  it('accepts the phase-output to phase-input bridge through a pipeline-output typed input port', () => {
    const definition = pipeline({
      inputs: [input('spec', 'pipeline-output')],
      outputs: [output('spec')],
      bindings: [
        { kind: 'output', phaseIndex: 0, portId: 'spec', outputKey: 'spec' },
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toEqual([]);
  });

  it('accepts a pipeline whose phaseIds repeats one phase and binds each position separately', () => {
    const definition = pipeline({
      phaseIds: ['review', 'plan', 'review'],
      inputs: [input('brief'), input('draft', 'pipeline-output')],
      outputs: [output('draft')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'brief' }
        },
        { kind: 'output', phaseIndex: 1, portId: 'draft', outputKey: 'draft' },
        {
          kind: 'input',
          phaseIndex: 2,
          inputKey: 'draft',
          source: { from: 'phase-output', phaseIndex: 1, portId: 'draft' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toEqual([]);
  });
});

describe('binding-phase-out-of-range (FR-015)', () => {
  it.each([[2], [7]])('rejects a consumer position %i beyond the sequence', (phaseIndex) => {
    const definition = pipeline({
      inputs: [input('brief')],
      bindings: [
        {
          kind: 'input',
          phaseIndex,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'brief' }
        }
      ]
    });
    const errors = validatePipelineBindings(definition, effectivePhases);
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].phaseIndex',
        code: 'binding-phase-out-of-range'
      })
    );
  });

  it('rejects a producer position beyond the sequence', () => {
    const definition = pipeline({
      inputs: [input('spec', 'pipeline-output')],
      outputs: [output('spec')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: 9, portId: 'spec' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.phaseIndex',
        code: 'binding-phase-out-of-range'
      })
    );
  });

  it('rejects an out-of-range output binding position', () => {
    const definition = pipeline({
      outputs: [output('plan')],
      bindings: [{ kind: 'output', phaseIndex: 5, portId: 'plan', outputKey: 'plan' }]
    });
    expect(codes(definition)).toContain('binding-phase-out-of-range');
  });
});

describe('binding-unknown-phase (FR-011)', () => {
  it('rejects a binding onto a phase reference absent from the effective catalog', () => {
    const definition = pipeline({
      phaseIds: ['specify', 'ghost'],
      inputs: [input('brief')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'brief' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].phaseIndex',
        code: 'binding-unknown-phase'
      })
    );
  });

  it('rejects a producing phase reference absent from the effective catalog', () => {
    const definition = pipeline({
      phaseIds: ['ghost', 'plan'],
      inputs: [input('spec', 'pipeline-output')],
      outputs: [output('spec')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.phaseIndex',
        code: 'binding-unknown-phase'
      })
    );
  });

  it('resolves a phase supplied by any effective source, regardless of its scope of origin', () => {
    const definition = pipeline({
      phaseIds: ['review'],
      inputs: [input('brief')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'brief' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, [phase('review')])).toEqual([]);
  });
});

describe('binding-unknown-input-port (FR-015)', () => {
  it('rejects a session-input source naming an undeclared input port', () => {
    const definition = pipeline({
      inputs: [input('brief')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'nope' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.portId',
        code: 'binding-unknown-input-port'
      })
    );
  });

  it('rejects a phase-output bridge with no correspondingly named input port', () => {
    const definition = pipeline({
      outputs: [output('spec')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
        }
      ]
    });
    expect(codes(definition)).toContain('binding-unknown-input-port');
  });
});

describe('binding-unknown-output-port (FR-016)', () => {
  it('rejects an output binding naming an undeclared output port', () => {
    const definition = pipeline({
      outputs: [output('plan')],
      bindings: [{ kind: 'output', phaseIndex: 1, portId: 'nope', outputKey: 'plan' }]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].portId',
        code: 'binding-unknown-output-port'
      })
    );
  });

  it('rejects a phase-output source naming an undeclared output port', () => {
    const definition = pipeline({
      inputs: [input('spec', 'pipeline-output')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.portId',
        code: 'binding-unknown-output-port'
      })
    );
  });
});

describe('binding-forward-reference (FR-015)', () => {
  const bridged = (sourcePhaseIndex: number, phaseIndex: number): PipelineDefinition =>
    pipeline({
      phaseIds: ['specify', 'plan', 'review'],
      inputs: [input('spec', 'pipeline-output')],
      outputs: [output('spec')],
      bindings: [
        {
          kind: 'input',
          phaseIndex,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: sourcePhaseIndex, portId: 'spec' }
        }
      ]
    });

  it('rejects a consumer reading from a later position', () => {
    expect(validatePipelineBindings(bridged(2, 1), effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.phaseIndex',
        code: 'binding-forward-reference'
      })
    );
  });

  it('rejects a phase reading its own output', () => {
    expect(validatePipelineBindings(bridged(1, 1), effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.phaseIndex',
        code: 'binding-forward-reference'
      })
    );
  });

  it('accepts a consumer reading from a strictly earlier position', () => {
    expect(validatePipelineBindings(bridged(0, 2), effectivePhases)).toEqual([]);
  });
});

describe('binding-type-mismatch (FR-016, research R4)', () => {
  it('rejects a session-input source whose port is declared as phase-fed', () => {
    const definition = pipeline({
      inputs: [input('spec', 'pipeline-output')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'spec',
          source: { from: 'pipeline-input', portId: 'spec' }
        }
      ]
    });
    expect(validatePipelineBindings(definition, effectivePhases)).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.portId',
        code: 'binding-type-mismatch'
      })
    );
  });

  it('rejects a phase-output bridge whose input port is not typed pipeline-output', () => {
    const definition = pipeline({
      inputs: [input('spec', 'text')],
      outputs: [output('spec')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'spec',
          source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
        }
      ]
    });
    const errors = validatePipelineBindings(definition, effectivePhases);
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'bindings[0].src.portId',
        code: 'binding-type-mismatch'
      })
    );
    expect(errors[0]?.message).toContain('pipeline-output');
  });

  it('compares by exact string equality with no widening between related types', () => {
    const definition = pipeline({
      inputs: [input('artifact', 'local-file')],
      outputs: [output('artifact', 'file')],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'artifact',
          source: { from: 'phase-output', phaseIndex: 0, portId: 'artifact' }
        }
      ]
    });
    expect(codes(definition)).toContain('binding-type-mismatch');
  });
});

describe('reported error shape', () => {
  it('names the pipeline and stays inside the projection bounds', () => {
    const definition = pipeline({
      bindings: [
        {
          kind: 'input',
          phaseIndex: 9,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'nope' }
        }
      ] as readonly PhaseBinding[]
    });
    const errors = validatePipelineBindings(definition, effectivePhases);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.pipelineId).toBe('alpha');
      expect(error.field.length).toBeLessThanOrEqual(32);
      expect(error.code.length).toBeLessThanOrEqual(64);
      expect(error.message.length).toBeLessThanOrEqual(512);
      expect(Object.isFrozen(error)).toBe(true);
    }
  });

  it('reports every offending binding, not just the first', () => {
    const definition = pipeline({
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'a',
          source: { from: 'pipeline-input', portId: 'missing-a' }
        },
        {
          kind: 'input',
          phaseIndex: 1,
          inputKey: 'b',
          source: { from: 'pipeline-input', portId: 'missing-b' }
        }
      ]
    });
    const errors = validatePipelineBindings(definition, effectivePhases);
    expect(errors.map((error) => error.field)).toEqual([
      'bindings[0].src.portId',
      'bindings[1].src.portId'
    ]);
  });
});
