// Feature 083 (US6, T049) — the definition-side half of "a Workflow that
// consumes a Pipeline" (FR-041).
//
// Contract: `specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md`.
//
// The one property that makes this collector correct is counter-intuitive
// enough to be worth stating: **its input is every stored row, not the effective
// catalog**. Everywhere else in this feature, resolution runs against the
// effective catalog — the repository hard rule. Here it deliberately does not,
// because FR-041 blocks on any *stored* reference: a row retained as `invalid`
// under FR-031 holds one that goes live the moment its defects are corrected.
//
// Resolving first would drop it and let a removal strand a definition the
// operator can restore with a single edit. So the tests below assert the invalid
// cases as hard requirements, not as tolerated noise.
//
// Feature 099 (T496f, FR-042/FR-043) — the second reason used to be shadowing: a
// row hidden by a higher-precedence scope held a live-on-deletion reference too.
// That arm is gone with the layer tier, and with it the `scope` field the
// refusal carried to say WHICH record blocked. One layer names it with
// `(workflowId, pipelineId)`, so every expectation below drops `scope` and the
// two cases that were about cross-layer identity are replaced by the same-layer
// duplicate-id pair, which is the one way an identifier can still appear twice.

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
  key: `${definition.pipelineId}::0`,
  pipelineId: definition.pipelineId,
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

const records = (rows: readonly unknown[]): readonly WorkflowSourceRecord[] =>
  resolveWorkflowCatalog({ rows, revision: 'rev-1', pipelineCatalog: PIPELINES }).records;

const refs = (rows: readonly unknown[]) =>
  collectWorkflowDefinitionPipelineRefs(records(rows));

const statusOf = (rows: readonly unknown[], key: string) =>
  records(rows).find((record) => record.key === key)?.status;

describe('collectWorkflowDefinitionPipelineRefs', () => {
  it('reports nothing for an empty catalog', () => {
    expect(refs([])).toEqual([]);
  });

  it('emits one reference per node Pipeline, stamped with its kind', () => {
    expect(refs([row('release')])).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
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
    expect(refs([twoNodes])).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
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
    expect(refs([mixed]).map((ref) => ref.pipelineId)).toEqual(['standard', 'review']);
  });

  // Feature 099 (T496f, FR-042) — 'counts a built-in record, so a shipped
  // Workflow blocks a removal too' is gone with the layer that held shipped rows.
  // Every row is now an operator's, and the case above already pins that an
  // ordinary row produces a reference.
});

describe('stored means stored, not effective (FR-041, FR-031)', () => {
  // Feature 099 (T496f, FR-040) — the two cases that opened this block asserted
  // that a SHADOWED row still contributes a reference, and that one identifier in
  // two scopes contributes two. Neither has a referent under one catalog. What
  // survives them is the property they were the second example of, and the block
  // is named for it: an unresolved row is not a dropped row. The duplicate-id case
  // at the foot of the block now carries the "one identifier, two references" half
  // on its own, since duplicate rows are the only way that still happens.
  it('counts an invalid record — its reference goes live when the defects are fixed', () => {
    // Invalid for a reason that has nothing to do with the nodes: no name.
    const rows = [row('release', { name: '' })];
    expect(statusOf(rows, 'release::0')).toBe('invalid');

    expect(refs(rows)).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
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
    const rows = [cyclic];
    expect(statusOf(rows, 'release::0')).toBe('invalid');
    expect(refs(rows).map((ref) => ref.pipelineId)).toEqual(['standard', 'review']);
  });

  it('counts both rows of a duplicate-id pair, which the resolver invalidates together', () => {
    const rows = [row('release'), row('release', { nodes: [{ nodeId: 'a', pipelineId: 'review' }] })];
    expect(statusOf(rows, 'release::0')).toBe('invalid');
    expect(statusOf(rows, 'release::1')).toBe('invalid');
    expect(refs(rows).map((ref) => ref.pipelineId)).toEqual(['standard', 'review']);
  });
});

describe('best-effort node parse invents nothing (FR-041)', () => {
  const nodesOf = (nodes: readonly unknown[]) => refs([row('release', { nodes })]);

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
    expect(refs([row('release', { nodes: 'standard' })])).toEqual([]);
    expect(refs([row('release', { nodes: {} })])).toEqual([]);
    expect(refs([row('release', { nodes: [] })])).toEqual([]);
  });

  it('reports nothing for a row that is not an object', () => {
    expect(refs(['standard', null, 7])).toEqual([]);
  });

  it('trims a padded pipelineId the way the definition validator does', () => {
    expect(nodesOf([{ nodeId: 'a', pipelineId: '  standard  ' }])).toEqual([
      {
        workflowId: 'release',
        pipelineId: 'standard',
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
