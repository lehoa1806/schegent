/**
 * FR-R4-F06 (FR-035; research R44; data-model section 8) & FR-R7-06 (BackendDescriptor table) —
 * every surviving site that names a backend directly in code or manifest.
 *
 * HISTORY. `backend-kinds.ts` once claimed adding a backend was "three edits", while a sweep
 * found 54 scattered sites. FR-R7-06 consolidated static per-backend data into
 * `src/contracts/backend-descriptors.ts` (`BACKEND_DESCRIPTORS`), generated the webview mirror
 * (`webview-ui/src/lib/generated/backend-descriptors.ts`), and migrated all data-only host and
 * webview roles to read the table.
 *
 * WHAT REMAINS HERE. Only canonical definitions and genuine per-backend behavioural sites
 * (adapter construction, subprocess argv, ACP wire-format synthesis/bridging, capability
 * withhold policy, and usage JSONL parsing), plus the manifest enum verified by `contracts:check`.
 * Every remaining row MUST carry a non-empty one-line `note` stating why it is canonical or
 * behavioural. The census gate (`tests/lint/backend-recipe-sites.test.ts`) keeps this list true
 * in both directions and enforces the retired-census ceiling (< 27 rows).
 */
export type BackendRecipeHow = 'switch' | 'equality' | 'record' | 'literal';

export interface BackendRecipeSite {
  /** From `repo/`. */
  readonly path: string;
  readonly role: string;
  readonly how: BackendRecipeHow;
  /** Mandatory one-line rationale stating why this site is canonical data or genuine behaviour. */
  readonly note: string;
}

export const BACKEND_RECIPE_SITES: readonly BackendRecipeSite[] = [
  // ---- Canonical identity, descriptor table, and manifest
  {
    path: 'src/contracts/backend-kinds.ts',
    role: 'Kind list and manifest',
    how: 'literal',
    note: 'canonical BackendRunnerKind union, SUPPORTED_BACKENDS order, and DEFAULT_BACKEND'
  },
  {
    path: 'src/contracts/backend-descriptors.ts',
    role: 'Kind list and manifest',
    how: 'record',
    note: 'canonical exhaustive Record<BackendRunnerKind, BackendDescriptor> pure-data table'
  },
  {
    path: 'package.json',
    role: 'Kind list and manifest',
    how: 'literal',
    note: 'VS Code manifest backend enums, validated against BACKEND_DESCRIPTORS by contracts:check'
  },
  {
    path: 'src/contracts/backend-runner.ts',
    role: 'Runner label',
    how: 'literal',
    note: 'canonical closed RunnerLabel union identifying concrete subprocess adapters for audit payloads'
  },

  // ---- Construction and CLI subprocess adapters (behaviour)
  {
    path: 'src/runner/backend-runner-factory.ts',
    role: 'Construction',
    how: 'switch',
    note: 'behaviour: constructs per-backend CLI adapter class with adapter-specific constructor options; exhaustive never default'
  },
  {
    path: 'src/runner/claude-cli.ts',
    role: 'Permission posture and policy',
    how: 'literal',
    note: 'behaviour: Claude CLI subprocess adapter argv construction, transport probing, and unconditional permission literal'
  },
  {
    path: 'src/runner/codex-cli.ts',
    role: 'Permission posture and policy',
    how: 'literal',
    note: 'behaviour: Codex CLI subprocess adapter argv construction and unconditional workspace-write sandbox literal'
  },
  {
    path: 'src/runner/agy-cli.ts',
    role: 'Permission posture and policy',
    how: 'literal',
    note: 'behaviour: Agy CLI subprocess adapter argv construction, effort rejection, and unconditional permission literal'
  },

  // ---- ACP runtime protocol synthesis and stdio bridge (behaviour)
  {
    path: 'src/runner/acp-backed-runner.ts',
    role: 'ACP runtime and bridge launch',
    how: 'equality',
    note: 'behaviour: synthesizes backend-specific wire-format JSONL terminal usage envelopes for ACP turns'
  },
  {
    path: 'src/services/acp-runtime/bridges/acp-stdio-bridge.ts',
    role: 'ACP runtime and bridge launch',
    how: 'equality',
    note: 'behaviour: maintained ACP v1 stdio bridge CLI flag translation and stdout stream parsing for bridged backends'
  },

  // ---- Capability withholding policy and usage stream parsing (behaviour)
  {
    path: 'src/services/capability-enforcement-plan.ts',
    role: 'Permission posture and policy',
    how: 'record',
    note: 'behaviour: declares per-backend CLI capability withholding flags, enforcement classes, and conditional residuals'
  },
  {
    path: 'src/parser/invocation-usage.ts',
    role: 'Spend and usage',
    how: 'record',
    note: 'behaviour: function-valued JSONL usage row discriminators, envelope extractors, and token/cost field mappings per backend'
  },

  // ---- Runtime container type signature left untouched due to pre-existing unrelated working-tree edit
  {
    path: 'src/ui/sidebar/commands/router-types.ts',
    role: 'Export and IPC',
    how: 'record',
    note: 'behaviour-neutral runtime RouterDeps.readModelsConfig type signature (untouched during FR-R7-06 due to pre-existing working-tree edit)'
  }
];
