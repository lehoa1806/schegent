// Catalog-save wire shapes. Split out of the `sidebar-ipc` barrel so the
// authoring commands for both catalogs sit in one focused module.
//
// Catalog rows stay `unknown` at the transport boundary and are narrowed by the
// host validators. All three saves carry the same scoped, revisioned
// complete-layer envelope so the Phase, Pipeline, and Workflow catalogs share
// one mutation-intent algebra (`src/ui/sidebar/commands/save-layer-intent.ts`).

import type {
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_WORKFLOWS,
  CommandBase
} from '../sidebar-ipc';
import type { PhaseCatalogMutation, WritablePhaseDefinitionScope } from '../process-definitions';
import type {
  PipelineCatalogMutation,
  WritablePipelineDefinitionScope
} from '../pipeline-definitions';
import type {
  WorkflowCatalogMutation,
  WritableWorkflowDefinitionScope
} from '../workflow-definitions';

/** Feature 082 (T023). */
export interface SavePipelinesCommand extends CommandBase<typeof CMD_SAVE_PIPELINES> {
  readonly payload: {
    readonly scope: WritablePipelineDefinitionScope;
    readonly expectedRevision: string;
    readonly mutation: PipelineCatalogMutation;
    readonly pipelines: readonly unknown[];
  };
}

/** Feature 083 (T024). */
export interface SaveWorkflowsCommand extends CommandBase<typeof CMD_SAVE_WORKFLOWS> {
  readonly payload: {
    readonly scope: WritableWorkflowDefinitionScope;
    readonly expectedRevision: string;
    readonly mutation: WorkflowCatalogMutation;
    readonly workflows: readonly unknown[];
  };
}

/** Feature 081. */
export interface SavePhasesCommand extends CommandBase<typeof CMD_SAVE_PHASES> {
  readonly payload: {
    readonly scope: WritablePhaseDefinitionScope;
    readonly expectedRevision: string;
    readonly mutation: PhaseCatalogMutation;
    readonly phases: readonly unknown[];
  };
}
