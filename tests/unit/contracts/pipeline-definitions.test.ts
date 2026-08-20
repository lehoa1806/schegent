import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES,
  isPipelineInputPortType,
  isPipelineOutputPortType
} from '../../../src/contracts/pipeline-definitions';
import type {
  PhaseBinding,
  PipelineCatalogMutation,
  PipelineDefinition,
  PipelineInputPortType,
  PipelineOutputPortType,
  PipelineSavePayload
} from '../../../src/contracts/pipeline-definitions';

const CONTRACT_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'contracts',
  'pipeline-definitions.ts'
);

// Feature 099 (T496f, FR-042, FR-043) — the scope union and its writable twin
// are deleted, not narrowed to one arm. Four tests pinned their membership and
// their guards; nothing they asserted is reachable, so what replaces them is the
// bar that keeps the concept from growing back: the contract must declare no
// scope vocabulary at all. A one-armed union reintroduced "for symmetry" fails
// here, which is the only way this file can still earn its place.
describe('the layer tier leaves no residue in the contract', () => {
  const source = readFileSync(CONTRACT_SOURCE, 'utf8');

  it('declares no scope union, writable twin, or guard', () => {
    expect(source).not.toMatch(/PIPELINE_DEFINITION_SCOPES/);
    expect(source).not.toMatch(/PIPELINE_WRITABLE_SCOPES/);
    expect(source).not.toMatch(/PipelineDefinitionScope/);
    expect(source).not.toMatch(/isWritablePipelineDefinitionScope/);
  });

  it('names none of the three retired layers as a value anywhere', () => {
    expect(source).not.toMatch(/'built-in'/);
    expect(source).not.toMatch(/'workspace'/);
  });

  it('carries no `scope` field on the record or the save payload', () => {
    expect(source).not.toMatch(/^\s*(readonly\s+)?scope\s*[?:]/m);
  });

  it('resolves a save payload with no scope on it', () => {
    const payload: PipelineSavePayload = {
      expectedRevision: 'rev-pipeline-1',
      mutation: { kind: 'create', pipelineId: 'flow' },
      pipelines: []
    };
    expect(payload).not.toHaveProperty('scope');
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
        // Feature 099 (T496f, FR-042) — the source layer left the intent with the
        // tier: there is one catalog to duplicate out of, so naming it said nothing.
        return `duplicate:${mutation.sourcePipelineId}:${mutation.pipelineId}`;
      case 'remove':
        return `remove:${mutation.pipelineId}`;
      case 'reset':
        return 'reset';
      case 'import-package':
        // The one intent that names a SET rather than a single id: a confirmed
        // package import appends every eligible resource in a single write.
        return `import-package:${mutation.pipelineIds.join(',')}`;
      default: {
        const unreachable: never = mutation;
        return unreachable;
      }
    }
  };

  it('covers all six intents with no residual union member', () => {
    const mutations: readonly PipelineCatalogMutation[] = [
      { kind: 'create', pipelineId: 'alpha' },
      { kind: 'edit', pipelineId: 'alpha' },
      { kind: 'duplicate', sourcePipelineId: 'alpha', pipelineId: 'beta' },
      { kind: 'remove', pipelineId: 'alpha' },
      { kind: 'reset' },
      { kind: 'import-package', pipelineIds: ['alpha', 'beta'] }
    ];
    expect(mutations.map(describeMutation)).toEqual([
      'create:alpha',
      'edit:alpha',
      'duplicate:alpha:beta',
      'remove:alpha',
      'reset',
      'import-package:alpha,beta'
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
    const payload: PipelineSavePayload = {
      expectedRevision: 'abc123',
      mutation: { kind: 'create', pipelineId: 'alpha' },
      pipelines: [definition]
    };

    expect(payload.pipelines).toHaveLength(1);
    expect(definition.bindings).toHaveLength(3);
    // Feature 099 (T496f, FR-042, FR-044) — the two scope types this stanza used
    // to exercise are deleted, and the revision the save is optimistic against
    // took their place in the payload. Pinned by compile failure rather than by
    // value: the day `scope` returns, the suppression is unused and this errors.
    expect(payload.expectedRevision).toBe('abc123');
    // @ts-expect-error - PipelineSavePayload declares no scope
    expect(payload.scope).toBeUndefined();
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
