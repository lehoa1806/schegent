import { describe, expect, it } from 'vitest';
import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../../../src/contracts/pipeline-definitions';
import type {
  WorkflowCatalogResolution,
  WorkflowSourceRecord
} from '../../../src/contracts/workflow-definitions';
import {
  WORKFLOW_CATALOG_SOFT_CAP,
  WORKFLOW_NODE_SOFT_CAP,
  resolveWorkflowCatalog,
  workflowLayerRevision,
  workflowSourceIdentity
} from '../../../src/config/workflow-catalog';

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

/** The healthy catalog every test uses unless it is specifically about Pipeline drift. */
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

/** A valid chain of `count` nodes: markdown out into text in, every node reachable. */
const chainRow = (id: string, count: number): Record<string, unknown> => {
  const nodes = Array.from({ length: count }, (_, index) => ({
    nodeId: `n${index}`,
    pipelineId: 'standard'
  }));
  const connections = Array.from({ length: count - 1 }, (_, index) => ({
    from: { nodeId: `n${index}`, portId: 'plan' },
    to: { nodeId: `n${index + 1}`, portId: 'brief' }
  }));
  return { id, name: id, version: 1, nodes, connections, startNodeIds: ['n0'] };
};

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

const forId = (
  resolution: WorkflowCatalogResolution,
  workflowId: string
): readonly WorkflowSourceRecord[] =>
  resolution.records.filter((record) => record.workflowId === workflowId);

const codes = (record: WorkflowSourceRecord | undefined): string[] =>
  (record?.errors ?? []).map((error) => error.code);

const warningCodes = (resolution: WorkflowCatalogResolution): string[] =>
  resolution.warnings.map((warning) => warning.code);

describe('workflowSourceIdentity', () => {
  it('reads the authored id and the portable workflowId alike', () => {
    expect(workflowSourceIdentity({ id: 'from-legacy' }, 0)).toBe('from-legacy');
    expect(workflowSourceIdentity({ workflowId: 'from-portable' }, 0)).toBe('from-portable');
  });

  it('gives a row that can supply no id a synthetic slot keyed by position', () => {
    expect(workflowSourceIdentity({}, 0)).toBe('?invalid-1');
    expect(workflowSourceIdentity(42, 4)).toBe('?invalid-5');
    expect(workflowSourceIdentity({ id: '   ' }, 1)).toBe('?invalid-2');
  });
});

describe('resolveWorkflowCatalog — precedence (FR-025)', () => {
  it('selects the workspace row and shadows user and built-in for the same workflowId', () => {
    const resolution = resolve({
      builtIn: [row('shared', { name: 'built-in copy' })],
      user: [row('shared', { name: 'user copy' })],
      workspace: [row('shared', { name: 'workspace copy' })]
    });

    const records = forId(resolution, 'shared');
    expect(records).toHaveLength(3);
    expect(records.filter((record) => record.status === 'effective')).toHaveLength(1);
    expect(records.find((record) => record.status === 'effective')?.scope).toBe('workspace');
    expect(records.filter((record) => record.status === 'shadowed').map((r) => r.scope).sort()).toEqual([
      'built-in',
      'user'
    ]);
    expect(resolution.effective.map((definition) => definition.name)).toEqual(['workspace copy']);
  });

  it('selects the user row when only user and built-in define the id', () => {
    const resolution = resolve({
      builtIn: [row('shared', { name: 'built-in copy' })],
      user: [row('shared', { name: 'user copy' })]
    });

    expect(resolution.effective.map((definition) => definition.name)).toEqual(['user copy']);
    expect(forId(resolution, 'shared').find((record) => record.scope === 'built-in')?.status).toBe(
      'shadowed'
    );
  });

  it('keeps different ids in different scopes independent', () => {
    const resolution = resolve({ user: [row('alpha')], workspace: [row('beta')] });

    expect(resolution.effective.map((definition) => definition.workflowId).sort()).toEqual([
      'alpha',
      'beta'
    ]);
  });

  it('promotes the lower scope when the higher one is invalid', () => {
    const resolution = resolve({
      user: [row('shared', { name: 'user copy' })],
      workspace: [row('shared', { name: 'workspace copy', startNodeIds: [] })]
    });

    expect(resolution.effective.map((definition) => definition.name)).toEqual(['user copy']);
    expect(forId(resolution, 'shared').find((record) => record.scope === 'workspace')?.status).toBe(
      'invalid'
    );
  });
});

describe('resolveWorkflowCatalog — invalid rows are retained (FR-031)', () => {
  it('keeps a structurally invalid row as an invalid record with its defects attached', () => {
    const resolution = resolve({ user: [row('broken', { nodes: [] })] });

    const record = forId(resolution, 'broken')[0];
    expect(record?.status).toBe('invalid');
    expect(record?.definition).toBeNull();
    expect(codes(record)).toContain('non-empty-required');
    expect(resolution.effective).toEqual([]);
  });

  it('keeps a row whose graph is defective and attaches the graph defect', () => {
    const resolution = resolve({
      user: [
        row('dangling', {
          connections: [
            {
              from: { nodeId: 'a', portId: 'plan' },
              to: { nodeId: 'ghost', portId: 'brief' }
            }
          ]
        })
      ]
    });

    const record = forId(resolution, 'dangling')[0];
    expect(record?.status).toBe('invalid');
    expect(codes(record)).toContain('unresolved-endpoint');
  });

  it('keeps a row that can supply no id under a synthetic slot that never resolves', () => {
    const resolution = resolve({ user: [{ name: 'nameless' }] });

    expect(resolution.records).toHaveLength(1);
    expect(resolution.records[0]?.workflowId).toBe('?invalid-1');
    expect(resolution.records[0]?.status).toBe('invalid');
    expect(resolution.effective).toEqual([]);
  });
});

describe('resolveWorkflowCatalog — duplicates inside one scope', () => {
  it('invalidates both rows when a workflowId repeats in one writable scope', () => {
    const resolution = resolve({ user: [row('dup', { name: 'first' }), row('dup', { name: 'second' })] });

    const records = forId(resolution, 'dup');
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === 'invalid')).toBe(true);
    expect(records.every((record) => record.definition === null)).toBe(true);
    expect(records.every((record) => codes(record).includes('duplicate-in-scope'))).toBe(true);
    expect(resolution.effective).toEqual([]);
  });

  it('does not treat the same id in two scopes as a duplicate', () => {
    const resolution = resolve({ user: [row('shared')], workspace: [row('shared')] });

    expect(forId(resolution, 'shared').some((record) => codes(record).includes('duplicate-in-scope'))).toBe(
      false
    );
    expect(resolution.effective).toHaveLength(1);
  });

  it('gives each row in a scope a distinct record key so two rows never collapse', () => {
    const resolution = resolve({ user: [row('dup'), row('dup')] });

    const keys = resolution.records.map((record) => record.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('workflowLayerRevision', () => {
  it('is stable across key order', () => {
    const a = [{ id: 'x', name: 'X', version: 1 }];
    const b = [{ version: 1, name: 'X', id: 'x' }];

    expect(workflowLayerRevision(a)).toBe(workflowLayerRevision(b));
  });

  it('changes when content changes', () => {
    expect(workflowLayerRevision([row('x')])).not.toBe(
      workflowLayerRevision([row('x', { name: 'renamed' })])
    );
  });

  it('treats an absent layer and an empty layer as the same fingerprint', () => {
    expect(workflowLayerRevision(undefined)).toBe(workflowLayerRevision([]));
  });

  it('is echoed per writable scope by the resolution', () => {
    const user = [row('alpha')];
    const workspace = [row('beta')];
    const resolution = resolve({ user, workspace });

    expect(resolution.revisions.user).toBe(workflowLayerRevision(user));
    expect(resolution.revisions.workspace).toBe(workflowLayerRevision(workspace));
  });
});

describe('resolveWorkflowCatalog — soft caps warn and never refuse (FR-032)', () => {
  it('pins both thresholds at the code-fixed value of 20', () => {
    expect(WORKFLOW_CATALOG_SOFT_CAP).toBe(20);
    expect(WORKFLOW_NODE_SOFT_CAP).toBe(20);
  });

  it('warns once past 20 definitions in a scope and still resolves every one of them', () => {
    const rows = Array.from({ length: 21 }, (_, index) => row(`wf-${index}`));
    const resolution = resolve({ user: rows });

    expect(warningCodes(resolution).filter((code) => code === 'workflow-soft-cap-scope')).toHaveLength(1);
    expect(resolution.effective).toHaveLength(21);
    expect(resolution.records.every((record) => record.status === 'effective')).toBe(true);
  });

  it('does not warn at exactly 20 definitions', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(`wf-${index}`));

    expect(warningCodes(resolve({ user: rows }))).not.toContain('workflow-soft-cap-scope');
  });

  it('warns per scope so a breach in one does not hide a breach in the other', () => {
    const rows = (prefix: string) => Array.from({ length: 21 }, (_, index) => row(`${prefix}-${index}`));
    const resolution = resolve({ user: rows('u'), workspace: rows('w') });

    expect(warningCodes(resolution).filter((code) => code === 'workflow-soft-cap-scope')).toHaveLength(2);
  });

  it('warns past 20 nodes in one Workflow and still resolves it', () => {
    const resolution = resolve({ user: [chainRow('long', 21)] });

    expect(warningCodes(resolution)).toContain('workflow-soft-cap-nodes');
    expect(resolution.warnings.find((warning) => warning.code === 'workflow-soft-cap-nodes')?.message).toContain(
      'long'
    );
    expect(resolution.effective).toHaveLength(1);
    expect(resolution.records[0]?.status).toBe('effective');
  });

  it('does not warn at exactly 20 nodes', () => {
    expect(warningCodes(resolve({ user: [chainRow('long', 20)] }))).not.toContain(
      'workflow-soft-cap-nodes'
    );
  });

  it('ignores an authored key that tries to raise the threshold', () => {
    const rows = Array.from({ length: 21 }, (_, index) => row(`wf-${index}`, { softCap: 100 }));

    expect(warningCodes(resolve({ user: rows }))).toContain('workflow-soft-cap-scope');
  });
});

describe('resolveWorkflowCatalog — Pipeline drift (FR-016, FR-017, US3 scenario 4)', () => {
  it('surfaces a Workflow whose Pipeline became invalid as invalid rather than dropping it', () => {
    const resolution = resolve({
      user: [row('stored')],
      pipelines: {
        effective: [],
        records: [invalidRecord('standard', "Phase 'gone' at position 0 has no effective definition")]
      }
    });

    const record = forId(resolution, 'stored')[0];
    expect(record).toBeDefined();
    expect(record?.status).toBe('invalid');
    expect(codes(record)).toContain('pipeline-invalid');
    expect(record?.errors[0]?.message).toContain('gone');
    expect(resolution.effective).toEqual([]);
  });

  it('reports unknown-pipeline when the Pipeline is absent from the catalog entirely', () => {
    const resolution = resolve({
      user: [row('stored')],
      pipelines: { effective: [], records: [] }
    });

    expect(codes(forId(resolution, 'stored')[0])).toContain('unknown-pipeline');
  });

  it('does not report drift for a Pipeline that is invalid in one scope but effective in another', () => {
    const resolution = resolve({
      user: [row('stored')],
      pipelines: {
        effective: [STANDARD],
        records: [invalidRecord('standard', 'shadowed broken copy'), effectiveRecord(STANDARD)]
      }
    });

    expect(forId(resolution, 'stored')[0]?.status).toBe('effective');
  });
});

// T044 — the cases above each resolve a stored Workflow once. FR-031 is about the
// *transition*: the row was authored while its Pipeline was healthy, the Pipeline
// later broke, and the Library must still list the row so the operator can see it
// and repair it. Dropping the row would be the silent failure — the Workflow would
// simply vanish from the Library with no explanation. These cases resolve the same
// stored bytes twice, before and after the drift, and pin what survives.
describe('resolveWorkflowCatalog — drift is a transition, not a deletion (FR-031, T044)', () => {
  const STORED = row('stored', { name: 'Ship It' });
  const BROKEN_STANDARD = {
    effective: [] as readonly PipelineDefinition[],
    records: [invalidRecord('standard', "Phase 'gone' at position 0 has no effective definition")]
  };

  it('resolves the stored Workflow as effective while its Pipeline is healthy', () => {
    const before = resolve({ user: [STORED], pipelines: PIPELINES });

    expect(before.records).toHaveLength(1);
    expect(before.records[0]?.status).toBe('effective');
    expect(before.records[0]?.definition).not.toBeNull();
    expect(before.effective.map((workflow) => workflow.workflowId)).toEqual(['stored']);
  });

  it('keeps the same record after the Pipeline breaks, flipped to invalid', () => {
    const before = resolve({ user: [STORED], pipelines: PIPELINES });
    const after = resolve({ user: [STORED], pipelines: BROKEN_STANDARD });

    // Same row count and same record key: the Library renders one row either way,
    // so the operator sees a Workflow that went bad rather than one that went away.
    expect(after.records).toHaveLength(before.records.length);
    expect(after.records[0]?.key).toBe(before.records[0]?.key);
    expect(after.records[0]?.workflowId).toBe('stored');
    expect(after.records[0]?.scope).toBe('user');

    expect(after.records[0]?.status).toBe('invalid');
    expect(after.records[0]?.definition).toBeNull();
  });

  it('carries the transitive cause naming the unresolved Phase', () => {
    const after = resolve({ user: [STORED], pipelines: BROKEN_STANDARD });
    const errors = after.records[0]?.errors ?? [];

    expect(errors.map((error) => error.code)).toContain('pipeline-invalid');
    const drift = errors.find((error) => error.code === 'pipeline-invalid');
    // The cause has to name the Phase, not just say "Pipeline is invalid" — the
    // operator's next action is to fix `gone`, and the Library row is where they
    // learn that.
    expect(drift?.message).toContain('gone');
    expect(drift?.field).toBe('nodes[0].pipelineId');
  });

  it('preserves the authored display fields so the row is still identifiable', () => {
    const before = resolve({ user: [STORED], pipelines: PIPELINES });
    const after = resolve({ user: [STORED], pipelines: BROKEN_STANDARD });

    // A row the operator cannot name is a row they cannot find and repair.
    expect(after.records[0]?.display).toEqual(before.records[0]?.display);
    expect(after.records[0]?.display.name).toBe('Ship It');
  });

  it('withholds the drifted Workflow from the effective set', () => {
    const after = resolve({ user: [STORED], pipelines: BROKEN_STANDARD });

    // Retained for display, refused for use: nothing may run a Workflow whose
    // Pipeline will not resolve.
    expect(after.effective).toEqual([]);
  });

  it('restores the Workflow once the Pipeline is repaired, without operator edits', () => {
    const repaired = resolve({ user: [STORED], pipelines: PIPELINES });

    // Same stored bytes as the drifted resolution above. Drift is not persisted
    // into the layer, so fixing the Pipeline is the whole fix.
    expect(repaired.records[0]?.status).toBe('effective');
    expect(repaired.records[0]?.errors).toEqual([]);
    expect(repaired.effective.map((workflow) => workflow.workflowId)).toEqual(['stored']);
  });
});
