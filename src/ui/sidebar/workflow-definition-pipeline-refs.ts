// Feature 083 (US6, FR-041) — the definition-side half of "a Workflow that
// consumes a Pipeline". Its run-request sibling is `workflow-pipeline-refs.ts`;
// `extension.ts` concatenates the two into one list and gate 13 in
// `commands/cmd-save-pipelines.ts` reads that list unchanged.
//
// The input is **every stored source record, not the effective catalog**. That
// is the opposite of the rule the rest of this feature follows, and it is
// deliberate: FR-041 blocks a removal on any *stored* reference.
//
//   * a record shadowed by a higher-precedence scope holds a reference that goes
//     live the moment the shadow is deleted;
//   * a record retained as `invalid` under FR-031 holds one that goes live the
//     moment its defects are corrected.
//
// Resolving to the effective catalog first would drop both, and a removal would
// strand a definition the operator can restore with a single edit. Validation
// paths still resolve against the effective Pipeline catalog per the repository
// hard rule — this is a reachability question, not a validation one.
//
// The reference is keyed by `(workflowId, scope, pipelineId)` rather than by
// identifier alone, because the same identifier may exist in more than one layer
// and the refusal has to name which record blocked.

import type { WorkflowSourceRecord } from '../../contracts/workflow-definitions';
import type { WorkflowDefinitionPipelineReference } from './commands/router-types';

export function collectWorkflowDefinitionPipelineRefs(
  records: readonly WorkflowSourceRecord[]
): readonly WorkflowDefinitionPipelineReference[] {
  const refs: WorkflowDefinitionPipelineReference[] = [];
  for (const record of records) {
    // `nodePipelineIds` is read best-effort from the stored row and is already
    // deduplicated, so an invalid record contributes exactly the references an
    // operator would restore by fixing it — and nothing is invented for a node
    // whose `pipelineId` is absent or malformed.
    for (const pipelineId of record.nodePipelineIds) {
      refs.push({
        workflowId: record.workflowId,
        pipelineId,
        scope: record.scope,
        kind: 'workflow-definition'
      });
    }
  }
  return refs;
}
