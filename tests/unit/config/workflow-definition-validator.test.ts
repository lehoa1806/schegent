import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  WORKFLOW_ERROR_FIELD_MAX,
  WORKFLOW_ID_MAX_LEN,
  validateWorkflowDefinition
} from '../../../src/config/workflow-definition-validator';

const codes = (result: { readonly errors: readonly { readonly code: string }[] }): string[] =>
  result.errors.map((error) => error.code);

const fields = (result: { readonly errors: readonly { readonly field: string }[] }): string[] =>
  result.errors.map((error) => error.field);

const validRow = (): Record<string, unknown> => ({
  id: 'design-then-implement',
  name: 'Design then implement',
  version: 1,
  nodes: [
    { nodeId: 'design', pipelineId: 'design-review' },
    { nodeId: 'implement', pipelineId: 'standard' }
  ],
  connections: [
    {
      from: { nodeId: 'design', portId: 'decision' },
      to: { nodeId: 'implement', portId: 'brief' }
    }
  ],
  startNodeIds: ['design']
});

describe('identity and grammar (FR-005)', () => {
  it('accepts a well-formed row and normalizes the authored id', () => {
    const result = validateWorkflowDefinition(validRow());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.definition?.workflowId).toBe('design-then-implement');
  });

  it('accepts the portable workflowId key and normalizes it to the same internal shape', () => {
    const { id: _id, ...rest } = validRow();
    const portable = validateWorkflowDefinition({ workflowId: 'design-then-implement', ...rest });
    const legacy = validateWorkflowDefinition(validRow());
    expect(portable.errors).toEqual([]);
    expect(portable.definition).toEqual(legacy.definition);
  });

  it('rejects a row that authors both id and workflowId', () => {
    const result = validateWorkflowDefinition({ ...validRow(), workflowId: 'design-then-implement' });
    expect(codes(result)).toContain('identity-ambiguous');
  });

  it('rejects a workflowId outside the portable grammar', () => {
    for (const bad of ['Design', '1design', 'design_then', 'design then', '-design', '']) {
      const result = validateWorkflowDefinition({ ...validRow(), id: bad });
      expect(codes(result)).toContain('invalid-pattern');
    }
  });

  it('rejects a workflowId longer than 64 characters', () => {
    const long = `a${'b'.repeat(WORKFLOW_ID_MAX_LEN)}`;
    expect(long.length).toBe(WORKFLOW_ID_MAX_LEN + 1);
    const result = validateWorkflowDefinition({ ...validRow(), id: long });
    expect(codes(result)).toContain('invalid-pattern');
  });

  it('accepts a workflowId of exactly 64 characters', () => {
    const exact = `a${'b'.repeat(WORKFLOW_ID_MAX_LEN - 1)}`;
    expect(exact.length).toBe(WORKFLOW_ID_MAX_LEN);
    const result = validateWorkflowDefinition({ ...validRow(), id: exact });
    expect(result.errors).toEqual([]);
  });

  it('rejects a nodeId outside the portable grammar or over 64 characters', () => {
    const badPattern = validateWorkflowDefinition({
      ...validRow(),
      nodes: [{ nodeId: 'Design', pipelineId: 'design-review' }],
      startNodeIds: ['Design']
    });
    expect(codes(badPattern)).toContain('invalid-pattern');
    expect(fields(badPattern)).toContain('nodes[0].nodeId');

    const tooLong = `a${'b'.repeat(WORKFLOW_ID_MAX_LEN)}`;
    const badLength = validateWorkflowDefinition({
      ...validRow(),
      nodes: [{ nodeId: tooLong, pipelineId: 'design-review' }],
      startNodeIds: [tooLong]
    });
    expect(codes(badLength)).toContain('invalid-pattern');
  });

  it('bounds the reported field path so a deep connection path still fits the projection cap', () => {
    const result = validateWorkflowDefinition({ ...validRow(), nodes: 'nope' });
    for (const field of fields(result)) {
      expect(field.length).toBeLessThanOrEqual(WORKFLOW_ERROR_FIELD_MAX);
    }
    expect(WORKFLOW_ERROR_FIELD_MAX).toBe(48);
  });
});

describe('name and version (FR-001)', () => {
  it('rejects an empty or whitespace-only name', () => {
    for (const bad of ['', '   ', '\t']) {
      const result = validateWorkflowDefinition({ ...validRow(), name: bad });
      expect(codes(result)).toContain('invalid-length');
    }
  });

  it('rejects a non-string name', () => {
    const result = validateWorkflowDefinition({ ...validRow(), name: 42 });
    expect(codes(result)).toContain('invalid-length');
  });

  it('rejects a version that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '1']) {
      const result = validateWorkflowDefinition({ ...validRow(), version: bad });
      expect(codes(result)).toContain('positive-integer-required');
    }
  });

  it('defaults an absent version to 1', () => {
    const { version: _version, ...rest } = validRow();
    const result = validateWorkflowDefinition(rest);
    expect(result.errors).toEqual([]);
    expect(result.definition?.version).toBe(1);
  });
});

describe('nodes (FR-002, FR-009)', () => {
  it('rejects a duplicate nodeId and names the duplicate', () => {
    const result = validateWorkflowDefinition({
      ...validRow(),
      nodes: [
        { nodeId: 'design', pipelineId: 'design-review' },
        { nodeId: 'design', pipelineId: 'standard' }
      ]
    });
    expect(codes(result)).toContain('duplicate-node-id');
    const duplicate = result.errors.find((error) => error.code === 'duplicate-node-id');
    expect(duplicate?.message).toContain('design');
    expect(duplicate?.field).toBe('nodes[1].nodeId');
  });

  it('rejects a node carrying no pipelineId', () => {
    const missing = validateWorkflowDefinition({
      ...validRow(),
      nodes: [{ nodeId: 'design' }],
      startNodeIds: ['design']
    });
    expect(codes(missing)).toContain('invalid-pattern');
    expect(fields(missing)).toContain('nodes[0].pipelineId');
  });

  it('rejects an empty node list', () => {
    const result = validateWorkflowDefinition({ ...validRow(), nodes: [], startNodeIds: [] });
    expect(codes(result)).toContain('non-empty-required');
  });

  it('accepts two nodes referencing the same Pipeline (FR-003)', () => {
    const result = validateWorkflowDefinition({
      ...validRow(),
      nodes: [
        { nodeId: 'first', pipelineId: 'standard' },
        { nodeId: 'second', pipelineId: 'standard' }
      ],
      connections: [
        { from: { nodeId: 'first', portId: 'plan' }, to: { nodeId: 'second', portId: 'brief' } }
      ],
      startNodeIds: ['first']
    });
    expect(result.errors).toEqual([]);
    expect(result.definition?.nodes).toHaveLength(2);
  });
});

describe('allowed starts (FR-015)', () => {
  it('rejects an empty start set', () => {
    const result = validateWorkflowDefinition({ ...validRow(), startNodeIds: [] });
    expect(codes(result)).toContain('invalid-start-set');
  });

  it('rejects an absent start set', () => {
    const { startNodeIds: _starts, ...rest } = validRow();
    const result = validateWorkflowDefinition(rest);
    expect(codes(result)).toContain('invalid-start-set');
  });

  it('rejects a start naming a node that does not exist', () => {
    const result = validateWorkflowDefinition({ ...validRow(), startNodeIds: ['ghost'] });
    expect(codes(result)).toContain('invalid-start-set');
    const error = result.errors.find((entry) => entry.code === 'invalid-start-set');
    expect(error?.message).toContain('ghost');
  });

  it('accepts several allowed starts', () => {
    const result = validateWorkflowDefinition({
      ...validRow(),
      startNodeIds: ['design', 'implement']
    });
    expect(result.errors).toEqual([]);
    expect(result.definition?.startNodeIds).toEqual(['design', 'implement']);
  });
});

describe('unrecognized authored fields round-trip (FR-007, SC-013)', () => {
  it('preserves unknown top-level keys without interpreting them, and keeps them out of display', () => {
    const result = validateWorkflowDefinition({
      ...validRow(),
      futureField: { nested: true },
      anotherOne: 'kept'
    });

    expect(result.errors).toEqual([]);
    expect(result.unrecognized).toEqual({ futureField: { nested: true }, anotherOne: 'kept' });
    expect(Object.keys(result.display)).not.toContain('futureField');
    expect(Object.keys(result.display)).not.toContain('anotherOne');
    // The parsed definition is the recognized shape only — unknown keys never leak into it.
    expect(Object.keys(result.definition ?? {})).not.toContain('futureField');
  });

  it('reports no unrecognized keys for a row that authors only known fields', () => {
    const result = validateWorkflowDefinition(validRow());
    expect(result.unrecognized).toEqual({});
  });

  it('exposes only scalar recognized fields through display', () => {
    const result = validateWorkflowDefinition(validRow());
    expect(result.display.name).toBe('Design then implement');
    expect(result.display.id).toBe('design-then-implement');
    // Structural fields are read from `definition`, not re-flattened into `display`.
    expect(result.display.nodes).toBeUndefined();
  });
});

describe('defect accumulation (FR-019)', () => {
  it('reports every independent field defect in one pass rather than returning at the first', () => {
    const result = validateWorkflowDefinition({
      id: 'Bad Id',
      name: '',
      version: 0,
      nodes: [
        { nodeId: 'design', pipelineId: 'design-review' },
        { nodeId: 'design', pipelineId: 'standard' }
      ],
      connections: [],
      startNodeIds: ['ghost']
    });

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'invalid-pattern',
        'invalid-length',
        'positive-integer-required',
        'duplicate-node-id',
        'invalid-start-set'
      ])
    );
    expect(result.ok).toBe(false);
    expect(result.definition).toBeNull();
  });

  it('rejects a non-object entry without throwing', () => {
    for (const bad of [null, undefined, 42, 'row', []]) {
      const result = validateWorkflowDefinition(bad);
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain('object-required');
    }
  });
});

describe('unified Workflow definition contract (FR-R5-F01-T01, T02, T03)', () => {
  it('accepts Phase-referenced and child-Workflow-referenced nodes, ports, handoff, return transitions, bindings, executionDefaults, and recommendedNext', () => {
    const result = validateWorkflowDefinition({
      id: 'unified-review-flow',
      name: 'Unified Review Flow',
      version: 1,
      inputs: [{ portId: 'spec-doc', label: 'Spec Doc', type: 'text', required: true }],
      outputs: [
        { portId: 'final-report', label: 'Final Report', type: 'markdown', required: true },
        { portId: 'rework-notes', label: 'Rework Notes', type: 'markdown', required: false }
      ],
      nodes: [
        { nodeId: 'specify', kind: 'phase', phaseId: 'specify' },
        { nodeId: 'sub-review', kind: 'workflow', workflowId: 'child-review' }
      ],
      connections: [
        {
          from: { nodeId: 'specify' },
          to: { nodeId: 'sub-review' },
          handoff: 'manual'
        },
        {
          from: { nodeId: 'sub-review' },
          to: { nodeId: 'return', kind: 'return' },
          handoff: 'auto'
        }
      ],
      bindings: [
        {
          kind: 'input',
          nodeId: 'specify',
          inputKey: 'spec-doc',
          source: { from: 'workflow-input', portId: 'spec-doc' }
        },
        {
          kind: 'output',
          nodeId: 'sub-review',
          portId: 'final-report',
          sourcePortId: 'report'
        }
      ],
      executionDefaults: {
        runner: 'claude',
        model: 'claude-3-7-sonnet',
        effort: 'high',
        timeoutSeconds: 600
      },
      recommendedNext: ['release-flow'],
      startNodeIds: ['specify']
    });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.definition?.nodes[0]?.phaseId).toBe('specify');
    expect(result.definition?.nodes[1]?.workflowId).toBe('child-review');
    expect(result.definition?.outputs?.[0]?.required).toBe(true);
    expect(result.definition?.outputs?.[1]?.required).toBe(false);
    expect(result.definition?.connections[0]?.handoff).toBe('manual');
    expect(result.definition?.connections[1]?.to.kind).toBe('return');
    expect(result.definition?.bindings).toHaveLength(2);
    expect(result.definition?.executionDefaults?.effort).toBe('high');
    expect(result.definition?.recommendedNext).toEqual(['release-flow']);
  });

  it('rejects positional phaseIndex addressing with index-addressing-forbidden', () => {
    const result = validateWorkflowDefinition({
      id: 'bad-index-wf',
      name: 'Bad Index WF',
      version: 1,
      nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
      connections: [],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          nodeId: 'specify',
          inputKey: 'brief',
          source: { from: 'workflow-input', portId: 'brief' }
        }
      ],
      startNodeIds: ['specify']
    });

    expect(codes(result)).toContain('index-addressing-forbidden');
  });

  it('rejects stored derivedInputs and derivedOutputs with derived-ports-not-storable', () => {
    const result = validateWorkflowDefinition({
      ...validRow(),
      derivedInputs: [],
      derivedOutputs: []
    });

    expect(codes(result)).toContain('derived-ports-not-storable');
  });

  it('validates all canonical fixtures in tests/fixtures/workflow-definitions/', () => {
    for (const file of [
      'linear-phase-workflow.json',
      'branching-review-workflow.json',
      'nested-parent-workflow.json'
    ]) {
      const raw = JSON.parse(
        readFileSync(
          resolvePath(__dirname, '../../fixtures/workflow-definitions', file),
          'utf8'
        )
      ) as unknown;
      const result = validateWorkflowDefinition(raw);
      expect(result.errors, file).toEqual([]);
      expect(result.ok, file).toBe(true);
    }
  });
});
