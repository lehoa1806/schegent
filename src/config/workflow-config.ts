import type {
  WorkflowDefinition,
  WritableWorkflowDefinitionScope
} from '../contracts/workflow-definitions';

/**
 * The configuration layer for `schegent.workflows`. No `vscode` import: the key literal, the
 * built-in layer, and the reset comparison are all host-internal facts the headless validators
 * and the save command need, and `src/extension.ts` supplies the VS Code-shaped seams.
 */

/** The single place the setting key is spelled; the section is `schegent`. */
export const WORKFLOW_CONFIG_KEY = 'workflows';

/**
 * The code-resident built-in layer. Empty by design (FR-026): a Workflow composes an operator's
 * own Pipelines, so there is no useful default graph to ship, and shipping one would put a row in
 * a scope that is never a save target. The scope itself still exists so a future built-in
 * Workflow needs no resolution change.
 */
export const BUILT_IN_WORKFLOWS: readonly WorkflowDefinition[] = Object.freeze([]);

export interface WorkflowConfigReader {
  /** `user` reads VS Code's Global target; `workspace` reads the Workspace target. */
  getWorkflows(scope: WritableWorkflowDefinitionScope): readonly unknown[] | undefined;
}

export interface WorkflowConfigLayers {
  readonly user: readonly unknown[];
  readonly workspace: readonly unknown[];
}

/** Matches `deps.updateConfig`, so the save command's one write goes through this seam. */
export type WorkflowConfigWriter = (
  key: typeof WORKFLOW_CONFIG_KEY,
  value: unknown,
  scope: WritableWorkflowDefinitionScope
) => Promise<void>;

/**
 * A configuration value is untrusted input: a hand-edited `settings.json` can hold a string or an
 * object where the array belongs. A non-array reads as an empty layer instead of propagating a
 * shape the resolver would have to re-check on every row.
 */
function asRows(value: readonly unknown[] | undefined): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readWorkflowLayers(reader?: WorkflowConfigReader): WorkflowConfigLayers {
  if (!reader) return { user: [], workspace: [] };
  return {
    user: asRows(reader.getWorkflows('user')),
    workspace: asRows(reader.getWorkflows('workspace'))
  };
}

/** The only site that pairs the key literal with a write; rows are persisted verbatim. */
export function writeWorkflowLayer(
  write: WorkflowConfigWriter,
  rows: readonly unknown[],
  scope: WritableWorkflowDefinitionScope
): Promise<void> {
  return write(WORKFLOW_CONFIG_KEY, rows, scope);
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(',')}}`;
}

/**
 * `true` iff `payload` is byte-equivalent (after key-sorted JSON normalization) to the built-in
 * layer. The trust gate reads this to recognize a reset-to-defaults save, so an operator can
 * always return to defaults from a denied state — the same I-2 invariant the Phase and Pipeline
 * save commands observe.
 */
export function equalsBuiltInWorkflows(payload: readonly unknown[]): boolean {
  return stableJsonStringify(payload) === stableJsonStringify(BUILT_IN_WORKFLOWS);
}
