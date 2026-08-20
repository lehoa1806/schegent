// Feature 102 (US2) — the snapshot the launch surface is mounted against.
//
// Three test files in this directory mount `RunsSurface.svelte` against the same
// two definitions, and a fourth asserts structurally over the sources beside it.
// The fixture is shared rather than copied so "the Pipeline the projection offers
// is the Pipeline the effective catalog resolves" stays true by construction —
// a per-file copy drifts, and the launcher then fails to mount for a reason that
// has nothing to do with the test that noticed.

import type {
  Launchable,
  LaunchProjection,
  LaunchSection,
  PipelineDefinition,
  PortableWorkflowDefinition,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';

/**
 * The effective catalog entry `RunLauncher` mounts against. Its id matches
 * `ANALYSIS.id` below: the surface resolves the launchable to a definition, and
 * a fixture whose two halves disagree tests the disagreement.
 */
export const ANALYSIS_DEFINITION: PipelineDefinition = {
  id: 'analysis-pipeline',
  name: 'Analysis Pipeline',
  phases: ['speckit-specify', 'speckit-plan'],
  inputs: [
    { portId: 'topic', label: 'Topic', type: 'text', required: true },
    { portId: 'notes', label: 'Notes', type: 'text' }
  ],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

export const ANALYSIS: Launchable = {
  kind: 'pipeline',
  id: 'analysis-pipeline',
  name: 'Analysis Pipeline',
  description: 'Reads a corpus and writes the findings up.',
  activeVersionId: 'v3',
  inputs: [
    { portId: 'topic', label: 'Topic', type: 'text', required: true, description: 'What to look at.' },
    { portId: 'notes', label: 'Notes', type: 'text' }
  ]
};

/** Same id as the Pipeline above, deliberately: FR-014's identity is `(kind, id)`. */
export const RESEARCH: Launchable = {
  kind: 'workflow',
  id: 'analysis-pipeline',
  name: 'Research Workflow',
  activeVersionId: 'v2',
  inputs: [{ portId: 'seed', label: 'Seed', type: 'text', nodeId: 'node-a' }],
  startNodeIds: ['node-a']
};

// ---------------------------------------------------------------------------
// US3 — the graph a Workflow trigger joins against
// ---------------------------------------------------------------------------
//
// The launch projection says WHICH nodes a Workflow starts from and WHAT each
// unsatisfied port is; it carries no node-to-Pipeline map. The Pipeline a start
// node names lives in the graph, and a launch has to name it — the host refuses
// `pipeline-mismatch` otherwise — so the trigger form joins the two. These are
// the graph half.

export const DRAFT_DEFINITION: PipelineDefinition = {
  id: 'draft-pipeline',
  name: 'Draft',
  phases: ['speckit-specify'],
  inputs: [
    { portId: 'seed', label: 'Seed', type: 'text' },
    { portId: 'brief', label: 'Brief', type: 'local-file' }
  ],
  outputs: [{ portId: 'draft', label: 'Draft', type: 'markdown' }]
};

export const REVIEW_DEFINITION: PipelineDefinition = {
  id: 'review-pipeline',
  name: 'Review',
  phases: ['speckit-analyze'],
  inputs: [{ portId: 'draft', label: 'Draft', type: 'text' }],
  outputs: [{ portId: 'verdict', label: 'Verdict', type: 'markdown' }]
};

/**
 * `node-c` carries no label on purpose: `WorkflowNode.label` is optional, and a
 * start-node question that named its choices by label alone would offer a blank
 * one. The node id is the only name every node is guaranteed to have.
 */
export const RESEARCH_GRAPH: PortableWorkflowDefinition = {
  workflowId: 'analysis-pipeline',
  name: 'Research Workflow',
  version: 2,
  nodes: [
    { nodeId: 'node-a', pipelineId: 'draft-pipeline', label: 'Draft the report' },
    { nodeId: 'node-b', pipelineId: 'review-pipeline', label: 'Review the draft' },
    { nodeId: 'node-c', pipelineId: 'review-pipeline' }
  ],
  connections: [
    { from: { nodeId: 'node-a', portId: 'draft' }, to: { nodeId: 'node-b', portId: 'draft' } }
  ],
  startNodeIds: ['node-a']
};

export function graphWithStarts(...startNodeIds: readonly string[]): PortableWorkflowDefinition {
  return { ...RESEARCH_GRAPH, startNodeIds };
}

export function entries(...items: readonly Launchable[]): LaunchSection {
  return { state: 'entries', entries: items };
}

export function projection(
  pipelines: LaunchSection = entries(ANALYSIS),
  workflows: LaunchSection = entries(RESEARCH)
): LaunchProjection {
  return { pipelines, workflows };
}

export function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: [],
      liveActivity: null,
      workflowElapsedMs: 0
    }),
    queue: { orderedItems: [], inFlight: null, pending: [], recent: [], paused: false },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-08-20T00:00:00.000Z',
    connectedRuns: [],
    availablePipelines: [ANALYSIS_DEFINITION, DRAFT_DEFINITION, REVIEW_DEFINITION],
    availablePhases: [],
    availableModels: { claude: [], codex: [], agy: [] },
    availableBackends: ['claude'],
    workflowCatalog: {
      state: 'ready',
      records: [],
      effective: [RESEARCH_GRAPH],
      revision: 'wf-1',
      warnings: []
    },
    launchables: projection(),
    ...overrides
  } as unknown as WorkflowSnapshot;
}
