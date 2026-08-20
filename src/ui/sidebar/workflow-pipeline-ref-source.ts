// Feature 083 (US6, FR-041) — the one answer to "which Workflows consume a
// Pipeline?", read by the Library's consuming-Workflow list (FR-002) and by
// gate 13's removal block (FR-022a).
//
// Two unrelated things are called a "Workflow" in this codebase and both hold
// references the removal gate must not break, so they concatenate here rather
// than at either call site — neither surface can then see one sense and miss
// the other:
//
//   * a queued run request that still resolves its Pipeline from the catalog
//     (`workflow-pipeline-refs.ts`);
//   * a stored Workflow *definition* whose node names one
//     (`workflow-definition-pipeline-refs.ts`).
//
// Both sources are read through the supplied callbacks on every call, never
// captured at construction: the host reassigns its Workflow catalog wholesale
// on a Workflow catalog reload, and a captured snapshot would answer the
// next gate decision from the pre-reload catalog.

import type { FeatureRequest } from '../../queue/feature-request';
import type { WorkflowSourceRecord } from '../../contracts/workflow-definitions';
import type { WorkflowPipelineReference } from './commands/router-types';
import { collectWorkflowDefinitionPipelineRefs } from './workflow-definition-pipeline-refs';
import { collectWorkflowPipelineRefs } from './workflow-pipeline-refs';

export interface WorkflowPipelineRefSources {
  /** The live queue, for the run-request sense. */
  readonly listRequests: () => readonly FeatureRequest[];
  /**
   * **Every stored source record, not the effective catalog.** A shadowed or
   * invalid record holds a reference that goes live the moment the shadow is
   * deleted or the defects are corrected, and FR-041 blocks a removal on any
   * stored reference. See `workflow-definition-pipeline-refs.ts`.
   */
  readonly listWorkflowRecords: () => readonly WorkflowSourceRecord[];
}

export function createWorkflowPipelineRefReader(
  sources: WorkflowPipelineRefSources
): () => readonly WorkflowPipelineReference[] {
  return () => [
    ...collectWorkflowPipelineRefs(sources.listRequests()),
    ...collectWorkflowDefinitionPipelineRefs(sources.listWorkflowRecords())
  ];
}
