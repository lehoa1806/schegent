// Feature 089 (T017, T018, T019, US3, FR-017, FR-019, FR-020, SC-005) — a
// Pipeline stored before this platform hydrates with empty contracts, keeps its
// Phase sequence, stays runnable, and is a perfectly good Workflow node.
//
// Like its Phase counterpart, this is a **characterization** fixture: it records
// what a pre-platform row does today, so a change that makes `inputs`,
// `outputs`, or `bindings` required fails here rather than in an operator's
// settings. The row below is written the way the catalog wrote one before ports
// existed — an id, a name, a version, and a Phase sequence.
//
// Three properties, and each is a different failure it prevents:
//
//   **Empty, not absent** (FR-017) — the three port fields hydrate to `[]`. A
//   Pipeline whose ports read `undefined` would make every consumer test for it,
//   and the first one that forgot would throw on an operator's oldest Pipeline.
//
//   **No write-back** (FR-019) — the stored rows are handed over deep-frozen, so
//   an in-place upgrade throws under ESM strict mode, and compared field by
//   field afterwards, so an upgraded copy returned for the host to persist
//   fails too.
//
//   **A valid node, not a defective one** (FR-020) — a Pipeline with no ports
//   used as a Workflow node derives nothing and needs nothing bound. "No ports"
//   must read as an empty surface, never as an unsatisfied requirement; the
//   graph validator has to return zero errors for it, or every legacy Pipeline
//   becomes unusable in a Workflow the day Workflows ship.

import { describe, expect, it } from 'vitest';
import {
  pipelineDefinitionToPipelineDef,
  resolvePipelineCatalog
} from '../../../src/config/pipeline-catalog';
import { validatePipelineBindings } from '../../../src/config/pipeline-binding-validator';
import { deriveWorkflowPorts } from '../../../src/config/workflow-derived-ports';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

/** Recursively freezes, so an in-place upgrade of a nested value throws too. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

const phase = (phaseId: string): PhaseDefinition => ({
  phaseId,
  name: phaseId,
  version: 1,
  instruction: phaseId
});

/** Legacy Phases, themselves declaring no ports — see `legacy-phase-hydration`. */
const PHASE_CATALOG: readonly PhaseDefinition[] = [
  phase('legacy-draft'),
  phase('legacy-review'),
  phase('finalize')
];

/**
 * A user-layer Pipeline as it was stored before ports existed: an id, a name, a
 * version, and the Phase sequence. No `inputs`, no `outputs`, no `bindings`, no
 * `recommendedNext`.
 */
const LEGACY_PIPELINE_ROW = {
  id: 'legacy-flow',
  name: 'Legacy Flow',
  version: 1,
  phases: ['legacy-draft', 'legacy-review', 'finalize']
} as const;

function resolveLegacyLayer(rows: readonly unknown[]) {
  return resolvePipelineCatalog({
    builtIn: [],
    user: rows,
    workspace: [],
    phaseCatalog: PHASE_CATALOG
  });
}

describe('a Pipeline stored before this platform hydrates unchanged (FR-017, SC-005)', () => {
  it('resolves effective with no field errors and no repair warnings', () => {
    const rows = deepFreeze([{ ...LEGACY_PIPELINE_ROW }]);
    const resolved = resolveLegacyLayer(rows);

    expect(resolved.records.map((record) => record.status)).toEqual(['effective']);
    expect(resolved.records.flatMap((record) => record.errors)).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it('hydrates the three port fields as empty arrays, never absent', () => {
    const rows = deepFreeze([{ ...LEGACY_PIPELINE_ROW }]);
    const definition = resolveLegacyLayer(rows).effective[0]!;

    expect(definition.inputs).toEqual([]);
    expect(definition.outputs).toEqual([]);
    expect(definition.bindings).toEqual([]);
    // Empty is a value here; a consumer that reads `.length` on any of the three
    // must not have to guard first.
    expect(Array.isArray(definition.inputs)).toBe(true);
    expect(Array.isArray(definition.outputs)).toBe(true);
    expect(Array.isArray(definition.bindings)).toBe(true);
  });

  it('resolves its Phase sequence unchanged', () => {
    const rows = deepFreeze([{ ...LEGACY_PIPELINE_ROW }]);
    const definition = resolveLegacyLayer(rows).effective[0]!;

    expect(definition.phaseIds).toEqual(['legacy-draft', 'legacy-review', 'finalize']);
  });

  it('projects onto a runnable PipelineDef and needs no binding to be valid', () => {
    const rows = deepFreeze([{ ...LEGACY_PIPELINE_ROW }]);
    const resolved = resolveLegacyLayer(rows);
    const definition = resolved.effective[0]!;

    expect(resolved.effectivePipelineDefs[0]).toEqual({
      id: 'legacy-flow',
      name: 'Legacy Flow',
      version: 1,
      phases: ['legacy-draft', 'legacy-review', 'finalize'],
      sourceScope: 'user',
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    });
    // The same projection the run path uses, reached directly.
    expect(pipelineDefinitionToPipelineDef(definition, 'user')).toEqual(
      resolved.effectivePipelineDefs[0]
    );
    // Nothing declared, so nothing to satisfy: the binding validator — the
    // single site that decides whether a binding resolves — has no complaint.
    expect(validatePipelineBindings(definition, PHASE_CATALOG)).toEqual([]);
  });
});

describe('hydration writes nothing back to configuration (T018, FR-019)', () => {
  it('leaves the stored layer byte-identical, and never writes through it', () => {
    const stored = deepFreeze([{ ...LEGACY_PIPELINE_ROW }]);
    const before = JSON.parse(JSON.stringify(stored)) as unknown[];

    // Frozen input: an in-place upgrade throws under strict mode rather than
    // silently succeeding, so this call is itself half the assertion.
    const resolved = resolveLegacyLayer(stored);
    expect(resolved.effective).toHaveLength(1);

    expect(JSON.parse(JSON.stringify(stored))).toEqual(before);
    expect(stored[0]).toEqual(LEGACY_PIPELINE_ROW);
    // The hydrated `inputs: []` exists on the resolved definition only — the
    // operator's row still has no such key, and acquires one only when they
    // save or import.
    expect(stored[0]).not.toHaveProperty('inputs');
    expect(stored[0]).not.toHaveProperty('outputs');
    expect(stored[0]).not.toHaveProperty('bindings');
  });

  it('is stable under repeated resolution — reading twice is reading once', () => {
    const stored = deepFreeze([{ ...LEGACY_PIPELINE_ROW }]);
    const first = resolveLegacyLayer(stored);
    const second = resolveLegacyLayer(stored);

    expect(second.revisions).toEqual(first.revisions);
    expect(second.effective).toEqual(first.effective);
    expect(second.effectivePipelineDefs).toEqual(first.effectivePipelineDefs);
  });
});

describe('a legacy Pipeline is a valid Workflow node (T019, FR-020)', () => {
  const NODE_ID = 'n-legacy';

  /** One node, no connections — the smallest Workflow that holds a Pipeline. */
  const WORKFLOW: WorkflowDefinition = {
    workflowId: 'legacy-workflow',
    name: 'Legacy Workflow',
    version: 1,
    nodes: [{ nodeId: NODE_ID, pipelineId: 'legacy-flow' }],
    connections: [],
    startNodeIds: [NODE_ID]
  };

  function effectivePipelines() {
    return resolveLegacyLayer(deepFreeze([{ ...LEGACY_PIPELINE_ROW }])).effective;
  }

  it('derives no inputs and no outputs', () => {
    // A Workflow's port surface is the unbound ports of its nodes. A node whose
    // Pipeline declares none contributes none — an empty surface, which is a
    // different thing from a node that failed to contribute.
    expect(deriveWorkflowPorts(WORKFLOW, effectivePipelines())).toEqual({
      inputs: [],
      outputs: []
    });
  });

  it('requires no bindings — the graph validates with zero errors', () => {
    // The distinction this pins: "no ports" is an empty requirement, not an
    // unsatisfied one. A validator that read an absent port surface as a defect
    // would make every Pipeline authored before this platform unusable in a
    // Workflow.
    expect(validateWorkflowGraph(WORKFLOW, effectivePipelines())).toEqual([]);
  });

  it('is still a valid node when a second node follows it, unconnected', () => {
    // Two nodes and no connection between them: neither can be waved off as
    // "trivially fine because it is the only one", and an unconnected pair is
    // reachable from `startNodeIds`, so nothing here is a reachability defect.
    const twoNodes: WorkflowDefinition = {
      ...WORKFLOW,
      nodes: [
        { nodeId: NODE_ID, pipelineId: 'legacy-flow' },
        { nodeId: 'n-legacy-2', pipelineId: 'legacy-flow' }
      ],
      startNodeIds: [NODE_ID, 'n-legacy-2']
    };

    expect(validateWorkflowGraph(twoNodes, effectivePipelines())).toEqual([]);
    expect(deriveWorkflowPorts(twoNodes, effectivePipelines())).toEqual({
      inputs: [],
      outputs: []
    });
  });
});
