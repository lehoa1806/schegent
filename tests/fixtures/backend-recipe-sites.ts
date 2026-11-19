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
  { path: 'src/contracts/backend-kinds.ts', role: 'Kind list and manifest', how: 'literal', note: 'canonical BackendRunnerKind union, SUPPORTED_BACKENDS order, and DEFAULT_BACKEND' },
  { path: 'src/contracts/backend-descriptors.ts', role: 'Kind list and manifest', how: 'record', note: 'canonical exhaustive Record<BackendRunnerKind, BackendDescriptor> pure-data table' },
  { path: 'package.json', role: 'Kind list and manifest', how: 'literal', note: 'VS Code manifest backend enums, validated against BACKEND_DESCRIPTORS by contracts:check' },

  // ---- Construction
  {
    path: 'src/runner/backend-runner-factory.ts',
    role: 'Construction',
    how: 'switch',
    note: 'behavior: constructs per-backend CLI adapter class with adapter-specific constructor options; exhaustive never default'
  },
  {
    path: 'src/runner/acp-backed-runner.ts',
    role: 'ACP runtime and bridge launch',
    how: 'equality',
    note: 'behavior: synthesizes backend-specific wire-format JSONL terminal usage envelopes for ACP turns'
  },
  {
    path: 'src/services/acp-runtime/bridges/acp-stdio-bridge.ts',
    role: 'ACP runtime and bridge launch',
    how: 'equality',
    note: 'behavior: maintained ACP v1 stdio bridge CLI flag translation and stdout stream parsing for bridged backends (claude and codex)'
  },

  // ---- Permission posture and policy
  {
    path: 'src/services/capability-enforcement-plan.ts',
    role: 'Permission posture and policy',
    how: 'record',
    note: 'behavior: declares per-backend CLI capability withholding flags, enforcement classes, and conditional residuals'
  },
  { path: 'src/runner/claude-cli.ts', role: 'Permission posture and policy', how: 'literal', note: 'behavior: Claude CLI subprocess adapter argv construction and unconditional permission literal' },
  { path: 'src/runner/codex-cli.ts', role: 'Permission posture and policy', how: 'literal', note: 'behavior: Codex CLI subprocess adapter argv construction and unconditional sandbox literal' },
  { path: 'src/runner/agy-cli.ts', role: 'Permission posture and policy', how: 'literal', note: 'behavior: Agy CLI subprocess adapter argv construction, effort rejection, and unconditional permission literal' },

  // ---- Export and IPC
  {
    path: 'src/ui/sidebar/commands/router-types.ts',
    role: 'Export and IPC',
    how: 'record',
    note: 'runtime RouterDeps.readModelsConfig type signature (untouched during FR-R7-06 due to pre-existing working-tree edit)'
  },

  // ---- Spend and usage
  {
    path: 'src/parser/invocation-usage.ts',
    role: 'Spend and usage',
    how: 'record',
    note: 'behavior: function-valued JSONL usage row discriminators, envelope extractors, and token/cost field mappings per backend'
  },

  // ---- Runner label
  { path: 'src/contracts/backend-runner.ts', role: 'Runner label', how: 'literal', note: 'RunnerLabel names the adapter, not the backend' },

  // ---- Webview
  { path: 'webview-ui/src/components/settings/BackendHealthSection.svelte', role: 'Webview', how: 'record' },
  { path: 'webview-ui/src/components/settings/general/BackendEnvironmentGroup.svelte', role: 'Webview', how: 'record' },
  { path: 'webview-ui/src/components/settings/RawJsonPhaseEditor.svelte', role: 'Webview', how: 'literal' },
  { path: 'webview-ui/src/components/PipelineBuilderEditors/PhaseEditorForm.svelte', role: 'Webview', how: 'equality' },
  { path: 'webview-ui/src/components/PipelineBuilderEditors/ModelCatalogEditor.svelte', role: 'Webview', how: 'equality' },
  { path: 'webview-ui/src/components/PipelineBuilderEditors/model-catalog-state.ts', role: 'Webview', how: 'literal' },

  // ---- Tests that fail when a backend is missing from a record
  { path: 'tests/lint/backend-runner-kind-exhaustive.test.ts', role: 'Tests', how: 'literal' },
  { path: 'tests/lint/backend-permission-posture.test.ts', role: 'Tests', how: 'literal' },
  { path: 'tests/unit/services/backend-containment-policy.test.ts', role: 'Tests', how: 'literal' },
  { path: 'tests/unit/build/qualified-versions-parity.test.ts', role: 'Tests', how: 'literal' },
  { path: 'webview-ui/src/components/settings/__tests__/backend-record-exhaustiveness.test.ts', role: 'Tests', how: 'literal' }
];
