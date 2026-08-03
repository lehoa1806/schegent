// Feature 083 (US6, T049) — the definition-side half of "a Workflow that
// consumes a Pipeline" (FR-041).
//
// Contract: `specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md`.
//
// The one property that makes this collector correct is counter-intuitive
// enough to be worth stating: **its input is every stored source layer, not the
// effective catalog**. Everywhere else in this feature, resolution runs against
// the effective catalog — the repository hard rule. Here it deliberately does
// not, because FR-041 blocks on any *stored* reference:
//
//   * a record shadowed by a higher-precedence scope holds a reference that goes
//     live the moment the shadow is deleted;
//   * a record retained as `invalid` under FR-031 holds one that goes live the
//     moment its defects are corrected.
//
// Resolving first would drop both and let a removal strand a definition that the
// operator can restore with a single edit. So the tests below assert the
// shadowed and invalid cases as hard requirements, not as tolerated noise.
//
// The refusal names each blocking Workflow with its scope, since the same
// identifier may exist in more than one layer — hence one reference per
// `(workflowId, scope, pipelineId)` triple rather than per identifier.

import { describe, expect, it } from 'vitest';
import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../../../../src/contracts/pipeline-definitions';
import type { WorkflowSourceRecord } from '../../../../src/contracts/workflow-definitions';
import { resolveWorkflowCatalog } from '../../../../src/config/workflow-catalog';
import { collectWorkflowDefinitionPipelineRefs } from '../../../../src/ui/sidebar/workflow-definition-pipeline-refs';

const pipeline = (pipelineId: string): PipelineDefinition => ({
  pipelineId,
  name: pipelineId,
  version: 1,
  phaseIds: ['plan'],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
  outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }],
  bindings: [],
  recommendedNext: []
});

const effectiveRecord = (definition: PipelineDefinition): PipelineSourceRecord => ({
  key: `user::${definition.pipelineId}::0`,
  pipelineId: definition.pipelineId,
  scope: 'user',
  status: 'effective',
  definition,
  display: {},
  errors: []
});

const STANDARD = pipeline('standard');
const REVIEW = pipeline('review');

const PIPELINES = {
  effective: [STANDARD, REVIEW],
  records: [effectiveRecord(STANDARD), effectiveRecord(REVIEW)]
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

const records = (input: {
  builtIn?: readonly unknown[];
  user?: readonly unknown[];
  workspace?: readonly unknown[];
}): readonly WorkflowSourceRecord[] =>
  resolveWorkflowCatalog({
    builtIn: input.builtIn ?? [],
    user: input.user,
    workspace: input.workspace,
    pipelineCatalog: PIPELINES
  }).records;

const refs = (input: Parameters<typeof records>[0]) =>
  collectWorkflowDefinitionPipelineRefs(records(input));

const statusOf = (input: Parameters<typeof records>[0], key: string) =>
  records(input).find((record) => record.key === key)?.status;

describe('collectWorkflowDefinitionPipelineRefs', () => {
  it('reports nothing for an empty catalog', () => {
    expect(refs({})).toEqual([]);
  });

  it('emits one reference per node Pipeline, stamped with kind and scope', () => {
    expect(refs({ user: [row('release')] })).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
        scope: 'user',
        kind: 'workflow-definition'
      }
    ]);
  });

  it('deduplicates two nodes on the same Pipeline into one reference', () => {
    const twoNodes = row('release', {
      nodes: [
        { nodeId: 'a', pipelineId: 'standard' },
        { nodeId: 'b', pipelineId: 'standard' }
      ],
      connections: [
        { from: { nodeId: 'a', portId: 'plan' }, to: { nodeId: 'b', portId: 'brief' } }
      ],
      startNodeIds: ['a']
    });
    expect(refs({ user: [twoNodes] })).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
        scope: 'user',
        kind: 'workflow-definition'
      }
    ]);
  });

  it('emits a reference per distinct Pipeline in one definition', () => {
    const mixed = row('release', {
      nodes: [
        { nodeId: 'a', pipelineId: 'standard' },
        { nodeId: 'b', pipelineId: 'review' }
      ],
      connections: [
        { from: { nodeId: 'a', portId: 'plan' }, to: { nodeId: 'b', portId: 'brief' } }
      ],
      startNodeIds: ['a']
    });
    expect(refs({ user: [mixed] }).map((ref) => ref.pipelineId)).toEqual(['standard', 'review']);
  });

  it('counts a built-in record, so a shipped Workflow blocks a removal too', () => {
    expect(refs({ builtIn: [row('shipped')] })).toEqual([
      {
        workflowId: 'shipped',
        pipelineId: 'standard',
        scope: 'built-in',
        kind: 'workflow-definition'
      }
    ]);
  });
});

describe('stored means stored, not effective (FR-041, FR-031)', () => {
  it('counts a shadowed record — its reference goes live when the shadow is deleted', () => {
    const input = {
      user: [row('release', { nodes: [{ nodeId: 'a', pipelineId: 'review' }] })],
      workspace: [row('release')]
    };
    // Precondition: the workspace row wins, so the user row is genuinely hidden.
    expect(statusOf(input, 'workspace::release::0')).toBe('effective');
    expect(statusOf(input, 'user::release::0')).toBe('shadowed');

    expect(refs(input)).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'review',
        scope: 'user',
        kind: 'workflow-definition'
      },
      {
        workflowId: 'release',
        pipelineId: 'standard',
        scope: 'workspace',
        kind: 'workflow-definition'
      }
    ]);
  });

  it('keeps the same identifier in two scopes as two references', () => {
    const input = { user: [row('release')], workspace: [row('release')] };
    expect(refs(input).map((ref) => ref.scope)).toEqual(['user', 'workspace']);
  });

  it('counts an invalid record — its reference goes live when the defects are fixed', () => {
    // Invalid for a reason that has nothing to do with the nodes: no name.
    const input = { user: [row('release', { name: '' })] };
    expect(statusOf(input, 'user::release::0')).toBe('invalid');

    expect(refs(input)).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
        scope: 'user',
        kind: 'workflow-definition'
      }
    ]);
  });

  it('counts an invalid record whose defect is in the graph itself', () => {
    // A cycle: both nodes parse, the graph does not.
    const cyclic = row('release', {
      nodes: [
        { nodeId: 'a', pipelineId: 'standard' },
        { nodeId: 'b', pipelineId: 'review' }
      ],
      connections: [
        { from: { nodeId: 'a', portId: 'plan' }, to: { nodeId: 'b', portId: 'brief' } },
        { from: { nodeId: 'b', portId: 'plan' }, to: { nodeId: 'a', portId: 'brief' } }
      ],
      startNodeIds: ['a']
    });
    const input = { user: [cyclic] };
    expect(statusOf(input, 'user::release::0')).toBe('invalid');
    expect(refs(input).map((ref) => ref.pipelineId)).toEqual(['standard', 'review']);
  });

  it('counts both rows of a duplicate-id pair, which the resolver invalidates together', () => {
    const input = {
      user: [row('release'), row('release', { nodes: [{ nodeId: 'a', pipelineId: 'review' }] })]
    };
    expect(statusOf(input, 'user::release::0')).toBe('invalid');
    expect(statusOf(input, 'user::release::1')).toBe('invalid');
    expect(refs(input).map((ref) => ref.pipelineId)).toEqual(['standard', 'review']);
  });
});

describe('best-effort node parse invents nothing (FR-041)', () => {
  const nodesOf = (nodes: readonly unknown[]) => refs({ user: [row('release', { nodes })] });

  it('recovers the well-formed nodes of a row whose other nodes are malformed', () => {
    expect(
      nodesOf([
        { nodeId: 'a', pipelineId: 'standard' },
        { nodeId: 'b', pipelineId: 'NOT A PIPELINE ID' }
      ]).map((ref) => ref.pipelineId)
    ).toEqual(['standard']);
  });

  it('invents no reference for a node with no pipelineId at all', () => {
    expect(
      nodesOf([{ nodeId: 'a', pipelineId: 'standard' }, { nodeId: 'b' }]).map(
        (ref) => ref.pipelineId
      )
    ).toEqual(['standard']);
  });

  it('invents no reference for a non-string pipelineId', () => {
    expect(
      nodesOf([
        { nodeId: 'a', pipelineId: 'standard' },
        { nodeId: 'b', pipelineId: 42 },
        { nodeId: 'c', pipelineId: null },
        { nodeId: 'd', pipelineId: { pipelineId: 'review' } }
      ]).map((ref) => ref.pipelineId)
    ).toEqual(['standard']);
  });

  it('invents no reference for a node that is not an object', () => {
    expect(
      nodesOf(['standard', null, { nodeId: 'a', pipelineId: 'standard' }]).map(
        (ref) => ref.pipelineId
      )
    ).toEqual(['standard']);
  });

  it('reports nothing for a row whose nodes field is not an array', () => {
    expect(refs({ user: [row('release', { nodes: 'standard' })] })).toEqual([]);
    expect(refs({ user: [row('release', { nodes: {} })] })).toEqual([]);
    expect(refs({ user: [row('release', { nodes: [] })] })).toEqual([]);
  });

  it('reports nothing for a row that is not an object', () => {
    expect(refs({ user: ['standard', null, 7] })).toEqual([]);
  });

  it('trims a padded pipelineId the way the definition validator does', () => {
    expect(nodesOf([{ nodeId: 'a', pipelineId: '  standard  ' }])).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
        scope: 'user',
        kind: 'workflow-definition'
      }
    ]);
  });

  it('keeps an unresolvable but well-formed reference, which is what makes repair possible', () => {
    // `absent` names no Pipeline, so the row is invalid. The reference is still
    // real: it is exactly what the operator must edit before the removal.
    expect(nodesOf([{ nodeId: 'a', pipelineId: 'absent' }]).map((ref) => ref.pipelineId)).toEqual([
      'absent'
    ]);
  });
});
