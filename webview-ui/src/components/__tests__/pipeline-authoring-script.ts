// Feature 184 (FR-R3-141, T005a/T049) — the authoring script both surfaces run.
//
// The acceptance boundary of this feature is that the rework changes where an
// operator clicks and nothing about what gets saved. That claim is only worth
// something if it is proved against a body recorded from the **old** surface
// before the old surface is deleted — a golden recorded afterwards proves the
// new surface equals itself, which is true of any surface.
//
// So the sequence below is described once, here, and run twice: by
// `pipeline-save-body.golden.test.ts` against `PipelineCatalogEditor`'s form
// while it still exists, and by `PipelineFlowBuilder.golden.test.ts` against the
// canvas afterwards. Both serialise `toSavePipelineRow` through `serializeBody`
// and compare to the same committed JSON.

import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import type { MutablePhase, MutablePipeline } from '../PipelineBuilderEditors/types';
import { toSavePipelineRow } from '../PipelineBuilderEditors/pipeline-catalog-state';

/**
 * The authored sequence, in the order the operator performs it: name the row,
 * give it an id and a description, append three Phases, move one up, remove one.
 *
 * Three appends and then a move and a remove is not arbitrary. One append would
 * not distinguish "appends" from "replaces"; a move exercises
 * `reorderPipelinePhases`, which carries the binding remap with it; and the
 * remove leaves a sequence whose final order is reachable by no single
 * operation, so a surface that quietly reimplemented the reorder would produce a
 * different body rather than the same one.
 */
export const AUTHORED = {
  name: 'Golden Flow',
  id: 'golden-flow',
  description: 'Recorded before the rework, replayed after it.',
  /** Appended in this order. */
  appends: ['speckit-specify', 'speckit-plan', 'done'] as const,
  /** Then position 2 moves up, and position 0 is removed. */
  moveUpFrom: 2,
  removeAt: 0
} as const;

/** `['speckit-specify','speckit-plan','done']` → move 2 up → remove 0. */
export const EXPECTED_PHASES: readonly string[] = ['done', 'speckit-plan'];

export const GOLDEN_PHASES: readonly MutablePhase[] = [
  {
    id: 'speckit-specify',
    name: 'Specify',
    version: 1,
    instruction: 'Write the spec.',
    sourceKey: 'speckit-specify::0',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  },
  {
    id: 'speckit-plan',
    name: 'Plan',
    version: 1,
    instruction: 'Write the plan.',
    sourceKey: 'speckit-plan::1',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  },
  {
    id: 'done',
    name: 'Done',
    version: 1,
    instruction: 'Finish.',
    sourceKey: 'done::2',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  }
];

const READY_CATALOG = {
  state: 'ready',
  records: [],
  effective: [],
  revisions: { user: 'u', workspace: 'w' },
  warnings: []
};

export const GOLDEN_SNAPSHOT = {
  isPrimary: true,
  availableBackends: ['claude'],
  availableModels: { claude: ['model-a'] },
  availablePipelines: [],
  pipelineCatalog: READY_CATALOG
} as unknown as WorkflowSnapshot;

/** The row the authoring script starts from: an empty draft, never persisted. */
export function goldenSeedRow(): MutablePipeline {
  return {
    id: 'new-pipeline',
    name: 'New Pipeline',
    version: 1,
    phases: [],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: [],
    sourceKey: 'draft::new-pipeline',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: false
  } as MutablePipeline;
}

/**
 * The comparison form. Two-space JSON of `toSavePipelineRow`, so a diff between
 * a recorded and a replayed body reads as a diff and not as one long line.
 *
 * Key order is `toSavePipelineRow`'s own and is deliberately not sorted: the
 * function builds the object with conditional spreads, so a change to which
 * optional fields are emitted moves keys, and that is a change to the saved body
 * this test should notice.
 */
export function serializeBody(pipeline: MutablePipeline): string {
  return JSON.stringify(toSavePipelineRow(pipeline), null, 2);
}
