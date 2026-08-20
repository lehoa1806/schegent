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
  workflowSourceIdentity
} from '../../../src/config/workflow-catalog';

/** The revision the store reported for this catalog. Echoed back, never derived. */
const REVISION = 'rev-workflow-1';

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
  key: `${pipeline.pipelineId}::0`,
  pipelineId: pipeline.pipelineId,
  status: 'effective',
  definition: pipeline,
  display: {},
  errors: []
});

const invalidRecord = (pipelineId: string, message: string): PipelineSourceRecord => ({
  key: `${pipelineId}::0`,
  pipelineId,
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
  rows?: readonly unknown[];
  revision?: string;
  pipelines?: { effective: readonly PipelineDefinition[]; records: readonly PipelineSourceRecord[] };
}): WorkflowCatalogResolution =>
  resolveWorkflowCatalog({
    rows: input.rows,
    revision: input.revision ?? REVISION,
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

// Feature 099 (T496f, FR-042/FR-043) — `describe('resolveWorkflowCatalog —
// precedence (FR-025)')` is gone, and with it three cases whose subject was the
// selection among layers:
//
//   - 'selects the workspace row and shadows user and built-in for the same
//     workflowId'
//   - 'selects the user row when only user and built-in define the id'
//   - 'promotes the lower scope when the higher one is invalid'
//
// All three assert a winner picked from competing copies, and `shadowed` — the
// status they read to name the losers — is a deleted arm of
// `WorkflowSourceStatus`. With one layer a clean row is selected by existing, so
// there is no weaker variant of these to keep: rewriting them as "the only row
// wins" would assert nothing an implementation could fail.
//
// The fourth case survives below because it was never about precedence: two ids
// resolving independently is a property of the catalog whatever its shape.
describe('resolveWorkflowCatalog — ids resolve independently', () => {
  it('keeps two distinct ids independent of one another', () => {
    const resolution = resolve({ rows: [row('alpha'), row('beta')] });

    expect(resolution.effective.map((definition) => definition.workflowId).sort()).toEqual([
      'alpha',
      'beta'
    ]);
  });
});

describe('resolveWorkflowCatalog — invalid rows are retained (FR-031)', () => {
  it('keeps a structurally invalid row as an invalid record with its defects attached', () => {
    const resolution = resolve({ rows: [row('broken', { nodes: [] })] });

    const record = forId(resolution, 'broken')[0];
    expect(record?.status).toBe('invalid');
    expect(record?.definition).toBeNull();
    expect(codes(record)).toContain('non-empty-required');
    expect(resolution.effective).toEqual([]);
  });

  it('keeps a row whose graph is defective and attaches the graph defect', () => {
    const resolution = resolve({
      rows: [
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
    const resolution = resolve({ rows: [{ name: 'nameless' }] });

    expect(resolution.records).toHaveLength(1);
    expect(resolution.records[0]?.workflowId).toBe('?invalid-1');
    expect(resolution.records[0]?.status).toBe('invalid');
    expect(resolution.effective).toEqual([]);
  });
});

describe('resolveWorkflowCatalog — duplicates inside the catalog', () => {
  // Feature 099 (T496f) — 'does not treat the same id in two scopes as a
  // duplicate' is gone: there are no two scopes to spread the id across, so the
  // case cannot be constructed at all. Its point was that `duplicate-in-scope`
  // was keyed on (scope, id) rather than id alone; the key is now id alone, and
  // that IS the rule the first case asserts. The error code keeps its string for
  // host/webview parity while its meaning becomes "twice in the one catalog".
  it('invalidates both rows when a workflowId repeats', () => {
    const resolution = resolve({ rows: [row('dup', { name: 'first' }), row('dup', { name: 'second' })] });

    const records = forId(resolution, 'dup');
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === 'invalid')).toBe(true);
    expect(records.every((record) => record.definition === null)).toBe(true);
    expect(records.every((record) => codes(record).includes('duplicate-in-scope'))).toBe(true);
    expect(resolution.effective).toEqual([]);
  });

  it('gives each row a distinct record key so two rows never collapse', () => {
    const resolution = resolve({ rows: [row('dup'), row('dup')] });

    const keys = resolution.records.map((record) => record.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveWorkflowCatalog — revision (FR-044a)', () => {
  // Feature 099 (T496f) — replaces `describe('workflowLayerRevision')`, whose
  // four cases pinned a hash the resolver computed itself: stability across key
  // order, sensitivity to content, absent-equals-empty, and the per-scope echo.
  // The resolver no longer computes one — the store issues it — so the first
  // three now belong to the store's content hashing, where
  // `tests/unit/catalog/` asserts them. What is left here is the only part that
  // was ever this resolver's: the string it was handed is the string it reports.
  //
  // Deliberately not re-derived. A test that recomputed the hash would assert
  // that two copies of the same computation agree, and would pass against a
  // value the store never issued.
  it('reports back the revision the store issued, verbatim', () => {
    const resolution = resolve({ rows: [row('alpha')], revision: 'rev-issued-by-the-store' });

    expect(resolution.revision).toBe('rev-issued-by-the-store');
  });

  it('reports the issued revision even for an absent row list', () => {
    // An empty catalog still has a revision: it is what a save must present to
    // prove it read the state it is overwriting.
    expect(resolve({ rows: undefined, revision: 'rev-empty' }).revision).toBe('rev-empty');
  });
});

describe('resolveWorkflowCatalog — soft caps warn and never refuse (FR-032)', () => {
  it('pins both thresholds at the code-fixed value of 20', () => {
    expect(WORKFLOW_CATALOG_SOFT_CAP).toBe(20);
    expect(WORKFLOW_NODE_SOFT_CAP).toBe(20);
  });

  it('warns once past 20 definitions and still resolves every one of them', () => {
    const rows = Array.from({ length: 21 }, (_, index) => row(`wf-${index}`));
    const resolution = resolve({ rows });

    expect(warningCodes(resolution).filter((code) => code === 'workflow-soft-cap')).toHaveLength(1);
    expect(resolution.effective).toHaveLength(21);
    expect(resolution.records.every((record) => record.status === 'effective')).toBe(true);
  });

  it('does not warn at exactly 20 definitions', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(`wf-${index}`));

    expect(warningCodes(resolve({ rows }))).not.toContain('workflow-soft-cap');
  });

  // Feature 099 (T496f) — 'warns per scope so a breach in one does not hide a
  // breach in the other' is gone. It asserted the cap was counted per layer
  // rather than over the merged set; with one layer there is one count, which
  // the case above already pins at exactly one warning. The `-scope` suffix left
  // the warning code with it: it is now `workflow-soft-cap`.

  it('warns past 20 nodes in one Workflow and still resolves it', () => {
    const resolution = resolve({ rows: [chainRow('long', 21)] });

    expect(warningCodes(resolution)).toContain('workflow-soft-cap-nodes');
    expect(resolution.warnings.find((warning) => warning.code === 'workflow-soft-cap-nodes')?.message).toContain(
      'long'
    );
    expect(resolution.effective).toHaveLength(1);
    expect(resolution.records[0]?.status).toBe('effective');
  });

  it('does not warn at exactly 20 nodes', () => {
    expect(warningCodes(resolve({ rows: [chainRow('long', 20)] }))).not.toContain(
      'workflow-soft-cap-nodes'
    );
  });

  it('ignores an authored key that tries to raise the threshold', () => {
    const rows = Array.from({ length: 21 }, (_, index) => row(`wf-${index}`, { softCap: 100 }));

    expect(warningCodes(resolve({ rows }))).toContain('workflow-soft-cap');
  });
});

describe('resolveWorkflowCatalog — Pipeline drift (FR-016, FR-017, US3 scenario 4)', () => {
  it('surfaces a Workflow whose Pipeline became invalid as invalid rather than dropping it', () => {
    const resolution = resolve({
      rows: [row('stored')],
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
      rows: [row('stored')],
      pipelines: { effective: [], records: [] }
    });

    expect(codes(forId(resolution, 'stored')[0])).toContain('unknown-pipeline');
  });

  it('does not report drift for a Pipeline that still resolves despite a retained invalid record', () => {
    // Feature 099 (T496f) — was 'does not report drift for a Pipeline that is
    // invalid in one scope but effective in another'. The two-scope fixture is
    // unconstructible now, but the property is not a layer effect and is not
    // relaxed: `invalidPipelineCauses` keys drift on whether the id RESOLVES,
    // not on whether some record for it is invalid. That distinction is what
    // this asserts, and it is still the guard standing between a retained
    // repair row and a false drift report on a healthy Pipeline.
    const resolution = resolve({
      rows: [row('stored')],
      pipelines: {
        effective: [STANDARD],
        records: [invalidRecord('standard', 'retained broken copy'), effectiveRecord(STANDARD)]
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
    const before = resolve({ rows: [STORED], pipelines: PIPELINES });

    expect(before.records).toHaveLength(1);
    expect(before.records[0]?.status).toBe('effective');
    expect(before.records[0]?.definition).not.toBeNull();
    expect(before.effective.map((workflow) => workflow.workflowId)).toEqual(['stored']);
  });

  it('keeps the same record after the Pipeline breaks, flipped to invalid', () => {
    const before = resolve({ rows: [STORED], pipelines: PIPELINES });
    const after = resolve({ rows: [STORED], pipelines: BROKEN_STANDARD });

    // Same row count and same record key: the Library renders one row either way,
    // so the operator sees a Workflow that went bad rather than one that went away.
    expect(after.records).toHaveLength(before.records.length);
    expect(after.records[0]?.key).toBe(before.records[0]?.key);
    expect(after.records[0]?.workflowId).toBe('stored');

    expect(after.records[0]?.status).toBe('invalid');
    expect(after.records[0]?.definition).toBeNull();
  });

  it('carries the transitive cause naming the unresolved Phase', () => {
    const after = resolve({ rows: [STORED], pipelines: BROKEN_STANDARD });
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
    const before = resolve({ rows: [STORED], pipelines: PIPELINES });
    const after = resolve({ rows: [STORED], pipelines: BROKEN_STANDARD });

    // A row the operator cannot name is a row they cannot find and repair.
    expect(after.records[0]?.display).toEqual(before.records[0]?.display);
    expect(after.records[0]?.display.name).toBe('Ship It');
  });

  it('withholds the drifted Workflow from the effective set', () => {
    const after = resolve({ rows: [STORED], pipelines: BROKEN_STANDARD });

    // Retained for display, refused for use: nothing may run a Workflow whose
    // Pipeline will not resolve.
    expect(after.effective).toEqual([]);
  });

  it('restores the Workflow once the Pipeline is repaired, without operator edits', () => {
    const repaired = resolve({ rows: [STORED], pipelines: PIPELINES });

    // Same stored bytes as the drifted resolution above. Drift is not persisted
    // into the layer, so fixing the Pipeline is the whole fix.
    expect(repaired.records[0]?.status).toBe('effective');
    expect(repaired.records[0]?.errors).toEqual([]);
    expect(repaired.effective.map((workflow) => workflow.workflowId)).toEqual(['stored']);
  });
});
