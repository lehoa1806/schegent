/**
 * Feature 099 (T489a, FR-043) — the projected record key survives a
 * maximum-length id, in all three catalogs.
 *
 * The collapse to one layer changed what a record key *is*. It used to be
 * `${scope}:${id}`, composed inside each projection from an id the projection had
 * already bounded. It is now `${id}::${index}`, composed by the resolver and
 * carried through — and the index is the half that makes it unique, because two
 * rows may legitimately hold the same id (that is the duplicate case, and both
 * copies are retained as records so the operator can see the collision).
 *
 * Which makes the cap the projection bounds the key with load-bearing in a way it
 * was not before. `CATALOG_ID_PATTERN` admits 64 characters, so a *legal* id can
 * fill the bare-id cap exactly, and bounding the composite by that same cap
 * truncates the `::index` away — leaving two records keyed identically, which is
 * precisely the collision the index exists to prevent. Downstream that is not a
 * mis-render: the Builder lists these with a keyed `{#each}`, and duplicate keys
 * are a runtime error there.
 *
 * The Phase projector already bounds the key separately from the id; this pins
 * the property for all three, so a fourth catalog copying any of them inherits it.
 */

import { describe, expect, it } from 'vitest';

import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../../../src/config/pipeline-catalog';
import { resolveWorkflowCatalog } from '../../../../src/config/workflow-catalog';
import { composePhaseCatalogProjection } from '../../../../src/ui/sidebar/phase-catalog-projection';
import { composePipelineCatalogProjection } from '../../../../src/ui/sidebar/pipeline-catalog-projection';
import { composeWorkflowCatalogProjection } from '../../../../src/ui/sidebar/workflow-catalog-projector';

/**
 * The longest id `CATALOG_ID_PATTERN` (`/^[a-z][a-z0-9-]{0,63}/`) accepts: one
 * leading letter and 63 more characters. Not a pathological string — an operator
 * naming a Phase after the thing it does reaches this length without trying.
 */
const MAX_LENGTH_ID = `p${'x'.repeat(63)}`;

const REVISION = 'rev-key-bound';
const identity = (value: string): string => value;
const MODELS = { claude: ['claude-opus-5'], codex: [], agy: [] } as const;

/** Two rows sharing one id: the case where the `::index` half is what distinguishes them. */
const PHASE_ROWS: readonly unknown[] = [
  { phaseId: MAX_LENGTH_ID, name: 'First', version: 1, instruction: 'Do the work' },
  { phaseId: MAX_LENGTH_ID, name: 'Second', version: 1, instruction: 'Do it again' }
];

const PIPELINE_ROWS: readonly unknown[] = [
  { pipelineId: MAX_LENGTH_ID, name: 'First', version: 1, phaseIds: [MAX_LENGTH_ID] },
  { pipelineId: MAX_LENGTH_ID, name: 'Second', version: 1, phaseIds: [MAX_LENGTH_ID] }
];

const WORKFLOW_ROWS: readonly unknown[] = [
  {
    workflowId: MAX_LENGTH_ID,
    name: 'First',
    version: 1,
    nodes: [{ nodeId: 'a', pipelineId: MAX_LENGTH_ID }],
    connections: [],
    startNodeIds: ['a']
  },
  {
    workflowId: MAX_LENGTH_ID,
    name: 'Second',
    version: 1,
    nodes: [{ nodeId: 'a', pipelineId: MAX_LENGTH_ID }],
    connections: [],
    startNodeIds: ['a']
  }
];

/** The three boundary payloads, built by the code that really builds them. */
function projectedKeys(): Readonly<Record<string, readonly string[]>> {
  const phaseCatalog = resolvePhaseCatalog({ rows: PHASE_ROWS, revision: REVISION });
  const pipelineCatalog = resolvePipelineCatalog({
    rows: PIPELINE_ROWS,
    revision: REVISION,
    phaseCatalog: phaseCatalog.effective
  });
  const workflowCatalog = resolveWorkflowCatalog({
    rows: WORKFLOW_ROWS,
    revision: REVISION,
    pipelineCatalog: { effective: pipelineCatalog.effective, records: pipelineCatalog.records }
  });

  const phases = composePhaseCatalogProjection(phaseCatalog, {
    sanitize: identity,
    availableModels: MODELS,
    defaultRunnerKind: 'claude'
  });
  const pipelines = composePipelineCatalogProjection(() => pipelineCatalog, {
    sanitize: identity,
    availableModels: MODELS,
    defaultRunnerKind: 'claude'
  });
  const workflows = composeWorkflowCatalogProjection(
    {
      getWorkflowCatalog: () => workflowCatalog,
      getPipelineCatalog: () => ({ effective: pipelineCatalog.effective })
    },
    identity
  );

  const keysOf = (payload: unknown): readonly string[] =>
    (payload as { readonly records: readonly { readonly key: string }[] }).records.map(
      (record) => record.key
    );

  return { phases: keysOf(phases), pipelines: keysOf(pipelines), workflows: keysOf(workflows) };
}

describe('catalog record keys survive a maximum-length id (FR-043)', () => {
  it('keeps the `::index` half that makes two rows with one id distinct', () => {
    for (const [kind, keys] of Object.entries(projectedKeys())) {
      // Vacuity guard: both rows must be retained, or "the keys differ" is a
      // statement about one record.
      expect(keys.length, `${kind} must retain both source rows`).toBe(2);
      expect(keys, `${kind} truncated the record key`).toEqual([
        `${MAX_LENGTH_ID}::0`,
        `${MAX_LENGTH_ID}::1`
      ]);
      expect(new Set(keys).size, `${kind} projected two records under one key`).toBe(2);
    }
  });
});
