// Catalog-save wire shapes. Split out of the `sidebar-ipc` barrel so the
// authoring commands for both catalogs sit in one focused module.
//
// Catalog rows stay `unknown` at the transport boundary and are narrowed by the
// host validators. All three saves carry the same revisioned complete-layer
// envelope so the Phase, Pipeline, and Workflow catalogs share one
// mutation-intent algebra (`src/ui/sidebar/commands/save-layer-intent.ts`).
//
// Feature 099 (T489a, FR-043) — the `scope` field is gone from all three
// payloads. It named which of `user`/`workspace` the complete layer belonged to,
// and there is one layer. `expectedRevision` stays and is now the store's
// manifest revision (FR-044, FR-044a): the single-intent, expected-revision gate
// is what FR-047 keeps, and it is the only part of this envelope the collapse
// does not touch.

import type {
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_WORKFLOWS,
  CommandBase
} from '../sidebar-ipc';
import type { PhaseCatalogMutation } from '../process-definitions';
import type { PipelineCatalogMutation } from '../pipeline-definitions';
import type { WorkflowCatalogMutation } from '../workflow-definitions';

/** Feature 082 (T023). */
export interface SavePipelinesCommand extends CommandBase<typeof CMD_SAVE_PIPELINES> {
  readonly payload: {
    readonly expectedRevision: string;
    readonly mutation: PipelineCatalogMutation;
    readonly pipelines: readonly unknown[];
  };
}

/** Feature 083 (T024). */
export interface SaveWorkflowsCommand extends CommandBase<typeof CMD_SAVE_WORKFLOWS> {
  readonly payload: {
    readonly expectedRevision: string;
    readonly mutation: WorkflowCatalogMutation;
    readonly workflows: readonly unknown[];
  };
}

/** Feature 081. */
export interface SavePhasesCommand extends CommandBase<typeof CMD_SAVE_PHASES> {
  readonly payload: {
    readonly expectedRevision: string;
    readonly mutation: PhaseCatalogMutation;
    readonly phases: readonly unknown[];
  };
}
