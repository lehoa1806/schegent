/**
 * FR-R4-F06 (FR-035; research R44; data-model section 8) -- every place a new backend has to be named.
 *
 * WHY THIS EXISTS. `backend-kinds.ts` used to say "ADDING A BACKEND still means three edits". It did not:
 * the sweep that built this table found about thirty source files that compare to a backend literal or
 * key a record by `BackendRunnerKind`, and a factory `switch` whose `default:` ran every unlisted backend
 * as Claude. A recipe that says three is a recipe that ships a fourth backend half-wired.
 *
 * WHAT THIS IS. One row per site: the path (from `repo/`), the role the site plays, and HOW it names the
 * backend. The census gate (`tests/lint/backend-recipe-sites.test.ts`) keeps it true in both directions:
 * a `src/` or `webview-ui/src/` file that compares to a backend literal or keys a record by the union and
 * is not listed fails; a listed site that no longer matches its `how` fails.
 *
 *   - `switch`:   a `switch` over the kind. The gate also fails one whose `default:` absorbs a backend.
 *   - `equality`: an `===` or `!==` against a backend literal. Includes an `if` chain with a fallback.
 *   - `record`:   a `Record<BackendRunnerKind, ...>`, so a new kind is a compile error until it is keyed.
 *   - `literal`:  the backend list written out as data (a manifest enum, an array, a union). Only its
 *                 existence is checked: nothing in `src/` can compare to them.
 *
 * The gate's own scan is authoritative. A site it finds that is not here is added with its role, not
 * waived.
 */
export type BackendRecipeHow = 'switch' | 'equality' | 'record' | 'literal';

export interface BackendRecipeSite {
  /** From `repo/`. */
  readonly path: string;
  readonly role: string;
  readonly how: BackendRecipeHow;
  /** Anything the row must say that the role does not. */
  readonly note?: string;
}

export const BACKEND_RECIPE_SITES: readonly BackendRecipeSite[] = [
  // ---- Kind list and manifest
  { path: 'src/contracts/backend-kinds.ts', role: 'Kind list and manifest', how: 'literal' },
  { path: 'package.json', role: 'Kind list and manifest', how: 'literal', note: 'the schegent.backend.runner enum' },
  { path: 'src/config/settings-schema.ts', role: 'Kind list and manifest', how: 'literal' },
  { path: 'src/config/general-settings-keys.ts', role: 'Kind list and manifest', how: 'literal' },

  // ---- Construction
  {
    path: 'src/runner/backend-runner-factory.ts',
    role: 'Construction',
    how: 'switch',
    note: 'each backend has its own case; the default assigns the kind to never and throws (TA7)'
  },

  // ---- Path resolution
  {
    path: 'src/config/cli-path-accessor.ts',
    role: 'Path resolution',
    how: 'equality',
    note: 'an `if` chain over agy and codex whose fallback is Claude, so a fourth backend would resolve Claude\'s path'
  },

  // ---- Permission posture and policy
  { path: 'src/services/backend-containment-policy.ts', role: 'Permission posture and policy', how: 'literal' },
  { path: 'src/services/capability-enforcement-plan.ts', role: 'Permission posture and policy', how: 'record' },
  { path: 'src/services/capability-confirmed-flags.ts', role: 'Permission posture and policy', how: 'record' },
  { path: 'src/runner/claude-cli.ts', role: 'Permission posture and policy', how: 'literal', note: 'the adapter\'s unrestricted argv' },
  { path: 'src/runner/codex-cli.ts', role: 'Permission posture and policy', how: 'literal', note: 'the adapter\'s unrestricted argv' },
  { path: 'src/runner/agy-cli.ts', role: 'Permission posture and policy', how: 'literal', note: 'the adapter\'s unrestricted argv' },
  { path: 'src/config/phase-runner-policy.ts', role: 'Permission posture and policy', how: 'equality' },

  // ---- Permission-mode audit and Claude-only behaviour
  { path: 'src/audit/audit-payload.ts', role: 'Permission-mode audit', how: 'equality' },
  { path: 'src/controller/phase-runner.ts', role: 'Claude-only behaviour and permission-mode audit', how: 'equality' },

  // ---- Validation
  { path: 'src/config/process-definition-validator.ts', role: 'Validation', how: 'equality' },
  { path: 'src/services/process-yaml/phase-yaml-validator.ts', role: 'Validation', how: 'equality' },
  { path: 'src/contracts/runtime-validators.ts', role: 'Validation', how: 'equality' },

  // ---- Export and IPC
  { path: 'src/contracts/sidebar-ipc.ts', role: 'Export and IPC', how: 'equality' },
  { path: 'src/ui/sidebar/commands/cmd-ping-backend.ts', role: 'Export and IPC', how: 'literal' },
  { path: 'src/ui/sidebar/commands/router-types.ts', role: 'Export and IPC', how: 'record' },

  // ---- Capability probing
  { path: 'src/services/backend-capability-service.ts', role: 'Capability probing', how: 'record' },
  { path: 'src/services/ambient-config-observer.ts', role: 'Capability probing', how: 'switch' },

  // ---- Spend and usage
  { path: 'src/parser/invocation-usage.ts', role: 'Spend and usage', how: 'record' },
  { path: 'src/contracts/backend-spend-denomination.ts', role: 'Spend and usage', how: 'record' },

  // ---- Qualification
  { path: 'src/contracts/qualified-backend-versions.ts', role: 'Qualification', how: 'literal' },
  {
    path: 'src/headless/backend-qualification-api.ts',
    role: 'Qualification',
    how: 'record',
    note: 'a Partial record of acceptance bindings, keyed by kind; a new kind is accepted with no binding'
  },

  // ---- Models and projection
  { path: 'src/ui/sidebar/snapshot-composer.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/ui/sidebar/snapshot.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/ui/sidebar/state-projector.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/ui/sidebar/placeholder-projector.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/ui/sidebar/phase-catalog-projection.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/ui/sidebar/commands/cmd-save-models.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/config/pipeline-config.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/config/pipeline-config-loader.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/config/model-catalog.ts', role: 'Models and projection', how: 'record' },
  { path: 'src/services/process-yaml/model-catalog-import-planner.ts', role: 'Models and projection', how: 'record' },

  // ---- Runner label
  { path: 'src/contracts/backend-runner.ts', role: 'Runner label', how: 'literal', note: 'RunnerLabel names the adapter, not the backend' },

  // ---- Webview
  { path: 'webview-ui/src/lib/snapshot-types.ts', role: 'Webview', how: 'record' },
  { path: 'webview-ui/src/components/settings/BackendHealthSection.svelte', role: 'Webview', how: 'record' },
  { path: 'webview-ui/src/components/settings/general/BackendEnvironmentGroup.svelte', role: 'Webview', how: 'record' },
  { path: 'webview-ui/src/components/settings/RawJsonPhaseEditor.svelte', role: 'Webview', how: 'literal' },
  { path: 'webview-ui/src/components/PipelineBuilderEditors/PhaseCatalogEditor.svelte', role: 'Webview', how: 'equality' },
  { path: 'webview-ui/src/components/PipelineBuilderEditors/ModelCatalogEditor.svelte', role: 'Webview', how: 'equality' },
  { path: 'webview-ui/src/components/PipelineBuilderEditors/model-catalog-state.ts', role: 'Webview', how: 'literal' },

  // ---- Tests that fail when a backend is missing from a record
  { path: 'tests/lint/backend-runner-kind-exhaustive.test.ts', role: 'Tests', how: 'literal' },
  { path: 'tests/lint/backend-permission-posture.test.ts', role: 'Tests', how: 'literal' },
  { path: 'tests/unit/services/backend-containment-policy.test.ts', role: 'Tests', how: 'literal' },
  { path: 'tests/unit/build/qualified-versions-parity.test.ts', role: 'Tests', how: 'literal' },
  { path: 'webview-ui/src/components/settings/__tests__/backend-record-exhaustiveness.test.ts', role: 'Tests', how: 'literal' }
];
