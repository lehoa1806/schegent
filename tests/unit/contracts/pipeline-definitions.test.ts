import { describe, expect, it } from 'vitest';
import {
  PIPELINE_DEFINITION_SCOPES,
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES,
  PIPELINE_WRITABLE_SCOPES,
  isPipelineDefinitionScope,
  isPipelineInputPortType,
  isPipelineOutputPortType,
  isWritablePipelineDefinitionScope
} from '../../../src/contracts/pipeline-definitions';
import type {
  PhaseBinding,
  PipelineCatalogMutation,
  PipelineDefinition,
  PipelineDefinitionScope,
  PipelineInputPortType,
  PipelineOutputPortType,
  ScopedPipelineSavePayload,
  WritablePipelineDefinitionScope
} from '../../../src/contracts/pipeline-definitions';

describe('pipeline definition scopes', () => {
  it('declares the three catalog layers in precedence-agnostic authored order', () => {
    expect(PIPELINE_DEFINITION_SCOPES).toEqual(['built-in', 'user', 'workspace']);
  });

  it('exposes only the two writable scopes', () => {
    expect(PIPELINE_WRITABLE_SCOPES).toEqual(['user', 'workspace']);
  });

  it('narrows unknown strings away from the scope union', () => {
    expect(isPipelineDefinitionScope('workspace')).toBe(true);
    expect(isPipelineDefinitionScope('built-in')).toBe(true);
    expect(isPipelineDefinitionScope('global')).toBe(false);
    expect(isPipelineDefinitionScope(undefined)).toBe(false);
  });

  it('rejects built-in as a writable target', () => {
    expect(isWritablePipelineDefinitionScope('user')).toBe(true);
    expect(isWritablePipelineDefinitionScope('workspace')).toBe(true);
    expect(isWritablePipelineDefinitionScope('built-in')).toBe(false);
  });
});

describe('closed port-type unions', () => {
  it('enumerates the eight input port types exactly as specified', () => {
    expect(PIPELINE_INPUT_PORT_TYPES).toEqual([
      'text',
      'source',
      'source-list',
      'local-file',
      'local-folder',
      'web-url',
      'pipeline-output',
      'repository-context'
    ]);
  });

  it('enumerates the six output port types exactly as specified', () => {
    expect(PIPELINE_OUTPUT_PORT_TYPES).toEqual([
      'markdown',
      'file',
      'file-set',
      'structured-data',
      'run-request',
      'external-reference'
    ]);
  });

  it('keeps the input and output namespaces distinct', () => {
    const inputs = new Set<string>(PIPELINE_INPUT_PORT_TYPES);
    const shared = PIPELINE_OUTPUT_PORT_TYPES.filter((type) => inputs.has(type));
    expect(shared).toEqual([]);
  });

  it('narrows unknown strings away from both unions', () => {
    expect(isPipelineInputPortType('pipeline-output')).toBe(true);
    expect(isPipelineInputPortType('markdown')).toBe(false);
    expect(isPipelineOutputPortType('markdown')).toBe(true);
    expect(isPipelineOutputPortType('text')).toBe(false);
    expect(isPipelineInputPortType(42)).toBe(false);
    expect(isPipelineOutputPortType(null)).toBe(false);
  });

  it('carries no duplicate member in either union', () => {
    expect(new Set<string>(PIPELINE_INPUT_PORT_TYPES).size).toBe(PIPELINE_INPUT_PORT_TYPES.length);
    expect(new Set<string>(PIPELINE_OUTPUT_PORT_TYPES).size).toBe(
      PIPELINE_OUTPUT_PORT_TYPES.length
    );
  });
});

describe('mutation kind exhaustiveness', () => {
  const describeMutation = (mutation: PipelineCatalogMutation): string => {
    switch (mutation.kind) {
      case 'create':
        return `create:${mutation.pipelineId}`;
      case 'edit':
        return `edit:${mutation.pipelineId}`;
      case 'duplicate':
        return `duplicate:${mutation.sourceScope}:${mutation.sourcePipelineId}:${mutation.pipelineId}`;
      case 'remove':
        return `remove:${mutation.pipelineId}`;
      case 'reset':
        return 'reset';
      default: {
        const unreachable: never = mutation;
        return unreachable;
      }
    }
  };

  it('covers all five intents with no residual union member', () => {
    const mutations: readonly PipelineCatalogMutation[] = [
      { kind: 'create', pipelineId: 'alpha' },
      { kind: 'edit', pipelineId: 'alpha' },
      { kind: 'duplicate', sourceScope: 'built-in', sourcePipelineId: 'alpha', pipelineId: 'beta' },
      { kind: 'remove', pipelineId: 'alpha' },
      { kind: 'reset' }
    ];
    expect(mutations.map(describeMutation)).toEqual([
      'create:alpha',
      'edit:alpha',
      'duplicate:built-in:alpha:beta',
      'remove:alpha',
      'reset'
    ]);
  });
});

describe('contract shapes are structurally assignable', () => {
  it('accepts a fully populated definition and save payload', () => {
    const bindings: readonly PhaseBinding[] = [
      {
        kind: 'input',
        phaseIndex: 0,
        inputKey: 'brief',
        source: { from: 'pipeline-input', portId: 'brief' }
      },
      {
        kind: 'input',
        phaseIndex: 1,
        inputKey: 'spec',
        source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' }
      },
      { kind: 'output', phaseIndex: 1, portId: 'plan', outputKey: 'plan' }
    ];
    const inputType: PipelineInputPortType = 'text';
    const outputType: PipelineOutputPortType = 'markdown';
    const definition: PipelineDefinition = {
      pipelineId: 'alpha',
      name: 'Alpha',
      description: 'demo',
      version: 1,
      phaseIds: ['specify', 'plan'],
      inputs: [{ portId: 'brief', label: 'Brief', type: inputType, required: true }],
      outputs: [{ portId: 'plan', label: 'Plan', type: outputType }],
      bindings,
      executionDefaults: { runner: 'claude', effort: 'high', timeoutSeconds: 600 },
      recommendedNext: ['beta']
    };
    const scope: WritablePipelineDefinitionScope = 'workspace';
    const payload: ScopedPipelineSavePayload = {
      scope,
      expectedRevision: 'abc123',
      mutation: { kind: 'create', pipelineId: 'alpha' },
      pipelines: [definition]
    };
    const anyScope: PipelineDefinitionScope = scope;

    expect(payload.pipelines).toHaveLength(1);
    expect(definition.bindings).toHaveLength(3);
    expect(anyScope).toBe('workspace');
  });

  it('accepts the minimal definition with empty collections', () => {
    const definition: PipelineDefinition = {
      pipelineId: 'minimal',
      name: 'Minimal',
      version: 1,
      phaseIds: ['done'],
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    };
    expect(definition.executionDefaults).toBeUndefined();
    expect(definition.description).toBeUndefined();
  });
});
