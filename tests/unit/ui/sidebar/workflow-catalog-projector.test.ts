// Feature 083 (US1, T029) — projection guarantees C1–C13 from
// `specs/083-workflow-graph-builder/contracts/workflow-catalog-snapshot.md`.
//
// The projector is the last host stage before operator-authored strings reach
// the webview, so these tests pin the two properties that stop being provable
// once the shape drifts: every source row survives (C1) and every string is
// sanitized exactly once and bounded (C5, C7).

import { describe, expect, it } from 'vitest';
import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../../../../src/contracts/pipeline-definitions';
import type { WorkflowCatalogResolution } from '../../../../src/contracts/workflow-definitions';
import { resolveWorkflowCatalog } from '../../../../src/config/workflow-catalog';
import { deriveWorkflowPorts } from '../../../../src/config/workflow-derived-ports';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  composeWorkflowCatalogProjection,
  projectWorkflowCatalog
} from '../../../../src/ui/sidebar/workflow-catalog-projector';

const STANDARD: PipelineDefinition = {
  pipelineId: 'standard',
  name: 'Standard',
  version: 1,
  phaseIds: ['plan'],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
  outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }],
  bindings: [],
  recommendedNext: []
};

const effectiveRecord = (pipeline: PipelineDefinition): PipelineSourceRecord => ({
  key: `user::${pipeline.pipelineId}::0`,
  pipelineId: pipeline.pipelineId,
  scope: 'user',
  status: 'effective',
  definition: pipeline,
  display: {},
  errors: []
});

const invalidRecord = (pipelineId: string, message: string): PipelineSourceRecord => ({
  key: `user::${pipelineId}::0`,
  pipelineId,
  scope: 'user',
  status: 'invalid',
  definition: null,
  display: {},
  errors: [{ pipelineId, field: 'phaseIds[0]', code: 'unknown-phase', message }]
});

const PIPELINES = {
  effective: [STANDARD],
  records: [effectiveRecord(STANDARD)]
};

const row = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  version: 1,
  nodes: [{ nodeId: 'a', pipelineId: 'standard' }],
  connections: [],
  startNodeIds: ['a'],
  ...overrides
});

/** Two nodes wired plan → brief, so exactly one input and one output stay unbound. */
const pairRow = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  version: 1,
  nodes: [
    { nodeId: 'first', pipelineId: 'standard' },
    { nodeId: 'second', pipelineId: 'standard' }
  ],
  connections: [
    { from: { nodeId: 'first', portId: 'plan' }, to: { nodeId: 'second', portId: 'brief' } }
  ],
  startNodeIds: ['first']
});

const resolve = (input: {
  builtIn?: readonly unknown[];
  user?: readonly unknown[];
  workspace?: readonly unknown[];
  pipelines?: { effective: readonly PipelineDefinition[]; records: readonly PipelineSourceRecord[] };
}): WorkflowCatalogResolution =>
  resolveWorkflowCatalog({
    builtIn: input.builtIn ?? [],
    user: input.user,
    workspace: input.workspace,
    pipelineCatalog: input.pipelines ?? PIPELINES
  });

const sanitize = (value: string): string => new SanitizedLogger().sanitize(value);

const project = (input: Parameters<typeof resolve>[0]) =>
  projectWorkflowCatalog(resolve(input), {
    sanitize,
    effectivePipelines: (input.pipelines ?? PIPELINES).effective
  });

/** Every string leaf reachable from the projection, for the whole-shape scans. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, into);
  else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) strings(entry, into);
  }
  return into;
}

describe('projectWorkflowCatalog — record retention (C1, C2, C3)', () => {
  it('projects every source row from every layer, including invalid ones', () => {
    const projection = project({
      user: [row('alpha'), { id: 'broken', name: '' }],
      workspace: [row('alpha', { name: 'workspace copy' })]
    });
    expect(projection.state).toBe('ready');
    expect(projection.records.map((record) => [record.workflowId, record.scope, record.status]))
      .toEqual([
        ['alpha', 'user', 'shadowed'],
        ['broken', 'user', 'invalid'],
        ['alpha', 'workspace', 'effective']
      ]);
  });

  it('keys a record `${scope}:${workflowId}` and keeps duplicate ids in one scope distinct', () => {
    const projection = project({ user: [row('dup'), row('dup')] });
    expect(projection.records.map((record) => record.key)).toEqual(['user:dup', 'user:dup:1']);
  });

  it('projects only effective definitions in `effective`, never an invalid one', () => {
    const projection = project({ user: [row('alpha'), { id: 'broken', name: '' }] });
    expect(projection.effective.map((definition) => definition.workflowId)).toEqual(['alpha']);
    expect(projection.records.find((record) => record.workflowId === 'broken')?.definition).toBeNull();
  });

  it('echoes the layer fingerprints the webview must send back as expectedRevision (C4)', () => {
    const resolution = resolve({ user: [row('alpha')] });
    const projection = projectWorkflowCatalog(resolution, {
      sanitize,
      effectivePipelines: PIPELINES.effective
    });
    expect(projection.revisions).toEqual(resolution.revisions);
  });
});

describe('projectWorkflowCatalog — sanitization and bounds (C5, C6, C7)', () => {
  it('sanitizes an authored secret out of a name exactly once', () => {
    const projection = project({
      user: [row('alpha', { name: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB build' })]
    });
    const name = projection.records[0]?.definition?.name ?? '';
    expect(name).not.toContain('ghp_0123456789');
    expect(name).toContain('build');
  });

  it('sanitizes node labels, connection endpoints, start ids, and display alike', () => {
    const secret = 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789';
    const projection = project({
      user: [
        {
          id: 'alpha',
          name: 'Alpha',
          description: `see ${secret}`,
          version: 1,
          nodes: [{ nodeId: 'a', pipelineId: 'standard', label: `node ${secret}` }],
          connections: [],
          startNodeIds: ['a']
        }
      ]
    });
    expect(strings(projection).some((value) => value.includes(secret))).toBe(false);
  });

  it('caps each projected error field at its declared length', () => {
    const projection = project({
      user: [
        row('alpha', {
          nodes: [{ nodeId: 'a'.repeat(200), pipelineId: 'standard' }],
          startNodeIds: ['a'.repeat(200)]
        })
      ]
    });
    for (const error of projection.records[0]?.errors ?? []) {
      expect(error.field.length).toBeLessThanOrEqual(48);
      expect(error.code.length).toBeLessThanOrEqual(64);
      expect(error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('truncates a record past 20 errors and reports the truncation as a warning, never a drop', () => {
    const nodes = Array.from({ length: 25 }, (_, index) => ({
      nodeId: `n${index}`,
      pipelineId: `missing-${index}`
    }));
    const projection = project({
      user: [row('alpha', { nodes, startNodeIds: ['n0'] })]
    });
    const record = projection.records[0];
    expect(record?.errors.length).toBe(20);
    expect(projection.warnings.map((warning) => warning.code)).toContain(
      'workflow-errors-truncated'
    );
  });

  it('projects no run identifier, session value, or absolute workspace path', () => {
    const projection = project({ user: [pairRow('alpha')] });
    for (const value of strings(projection)) {
      expect(value.startsWith('/')).toBe(false);
      expect(value).not.toMatch(/[A-Za-z]:\\/);
      expect(value).not.toMatch(/\brunId\b|\bsessionId\b/);
    }
  });
});

describe('projectWorkflowCatalog — warnings, not errors (C8, C9)', () => {
  it('carries soft-cap breaches as warnings and keeps state ready', () => {
    const projection = project({
      user: Array.from({ length: 21 }, (_, index) => row(`w${index}`))
    });
    expect(projection.state).toBe('ready');
    expect(projection.warnings.map((warning) => warning.code)).toContain('workflow-soft-cap-scope');
  });

  it('projects a whole-catalog failure as state error with empty records', () => {
    const projection = composeWorkflowCatalogProjection(
      {
        getWorkflowCatalog: () => {
          throw new Error('catalog read failed');
        }
      },
      sanitize
    );
    expect(projection?.state).toBe('error');
    expect(projection?.records).toEqual([]);
    expect(projection?.effective).toEqual([]);
    expect(projection?.error?.code).toBe('workflow-catalog-unavailable');
  });

  it('projects state error when the Pipeline catalog the ports derive from throws', () => {
    const warnings: string[] = [];
    const projection = composeWorkflowCatalogProjection(
      {
        getWorkflowCatalog: () => resolve({ user: [row('alpha')] }),
        getPipelineCatalog: () => {
          throw new Error('pipeline catalog read failed');
        }
      },
      sanitize,
      (message) => warnings.push(message)
    );
    expect(projection?.state).toBe('error');
    expect(warnings).toHaveLength(1);
  });

  it('projects no field at all when the host has not resolved a catalog yet', () => {
    expect(
      composeWorkflowCatalogProjection({ getWorkflowCatalog: () => undefined }, sanitize)
    ).toBeUndefined();
    expect(composeWorkflowCatalogProjection({}, sanitize)).toBeUndefined();
  });

  it('derives ports from the composer-supplied effective Pipeline catalog', () => {
    const projection = composeWorkflowCatalogProjection(
      {
        getWorkflowCatalog: () => resolve({ user: [pairRow('alpha')] }),
        getPipelineCatalog: () => ({ effective: PIPELINES.effective })
      },
      sanitize
    );
    expect(projection?.records[0]?.derivedInputs).toEqual([
      { nodeId: 'first', portId: 'brief', label: 'Brief', type: 'text' }
    ]);
  });
});

describe('projectWorkflowCatalog — derived ports (C11)', () => {
  it('computes the same port surface the validator does, and never writes it back', () => {
    const resolution = resolve({ user: [pairRow('alpha')] });
    const projection = projectWorkflowCatalog(resolution, {
      sanitize,
      effectivePipelines: PIPELINES.effective
    });
    const definition = resolution.records[0]?.definition;
    expect(definition).not.toBeNull();
    const expected = deriveWorkflowPorts(definition!, PIPELINES.effective);
    expect(projection.records[0]?.derivedInputs).toEqual(expected.inputs);
    expect(projection.records[0]?.derivedOutputs).toEqual(expected.outputs);
    expect(projection.records[0]?.derivedInputs).toEqual([
      { nodeId: 'first', portId: 'brief', label: 'Brief', type: 'text' }
    ]);
    expect(projection.records[0]?.derivedOutputs).toEqual([
      { nodeId: 'second', portId: 'plan', label: 'Plan', type: 'markdown' }
    ]);
    expect(definition).not.toHaveProperty('derivedInputs');
    expect(Object.keys(projection.effective[0] ?? {})).not.toContain('derivedInputs');
  });

  it('projects empty port lists for a record with no definition', () => {
    const projection = project({ user: [{ id: 'broken', name: '' }] });
    expect(projection.records[0]?.derivedInputs).toEqual([]);
    expect(projection.records[0]?.derivedOutputs).toEqual([]);
  });
});

describe('projectWorkflowCatalog — authored order and Pipeline drift (C12, C13)', () => {
  it('preserves authored node and connection order with no sort', () => {
    const nodes = [
      { nodeId: 'zulu', pipelineId: 'standard' },
      { nodeId: 'alpha', pipelineId: 'standard' },
      { nodeId: 'mike', pipelineId: 'standard' }
    ];
    const connections = [
      { from: { nodeId: 'alpha', portId: 'plan' }, to: { nodeId: 'mike', portId: 'brief' } },
      { from: { nodeId: 'zulu', portId: 'plan' }, to: { nodeId: 'alpha', portId: 'brief' } }
    ];
    const projection = project({
      user: [row('alpha', { nodes, connections, startNodeIds: ['zulu'] })]
    });
    const definition = projection.records[0]?.definition;
    expect(definition?.nodes.map((node) => node.nodeId)).toEqual(['zulu', 'alpha', 'mike']);
    expect(definition?.connections.map((connection) => connection.from.nodeId)).toEqual([
      'alpha',
      'zulu'
    ]);
  });

  it('marks a Workflow whose node names an unknown Pipeline invalid and names the Pipeline', () => {
    const projection = project({
      user: [row('alpha', { nodes: [{ nodeId: 'a', pipelineId: 'nope' }] })]
    });
    const record = projection.records[0];
    expect(record?.status).toBe('invalid');
    expect(record?.errors.map((error) => error.code)).toContain('unknown-pipeline');
    expect(record?.errors.some((error) => error.message.includes('nope'))).toBe(true);
  });

  it('names the transitive cause when the referenced Pipeline is itself invalid', () => {
    const projection = project({
      user: [row('alpha', { nodes: [{ nodeId: 'a', pipelineId: 'broken' }] })],
      pipelines: {
        effective: [STANDARD],
        records: [effectiveRecord(STANDARD), invalidRecord('broken', 'phase "ghost" is unknown')]
      }
    });
    const record = projection.records[0];
    expect(record?.status).toBe('invalid');
    expect(record?.errors.map((error) => error.code)).toContain('pipeline-invalid');
    expect(record?.errors.some((error) => error.message.includes('ghost'))).toBe(true);
  });
});
