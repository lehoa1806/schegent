import type { PipelineInputPortType, PipelineOutputPortType } from './pipeline-definitions';

/**
 * Portable contract for the *definition* sense of "Workflow": a reusable acyclic graph of
 * Pipeline nodes. This is a different thing from the run-side `WorkflowRun*` family in
 * `src/state/workflow-run.ts`, which describes a queued request already in flight. No name
 * here collides with that family, and neither vocabulary is being renamed (FR-046).
 *
 * No `vscode` import: this module is consumed by the headless validators, the sidebar
 * projector, and the webview type mirror alike.
 */

/** How long a Workflow id may be. See `PHASE_ID_MAX_LEN` for why it lives here. */
export const WORKFLOW_ID_MAX_LEN = 64;

export const WORKFLOW_DEFINITION_SCOPES = ['built-in', 'user', 'workspace'] as const;
export type WorkflowDefinitionScope = (typeof WORKFLOW_DEFINITION_SCOPES)[number];
export type WritableWorkflowDefinitionScope = Exclude<WorkflowDefinitionScope, 'built-in'>;

export const WORKFLOW_WRITABLE_SCOPES = ['user', 'workspace'] as const;

export function isWorkflowDefinitionScope(value: unknown): value is WorkflowDefinitionScope {
  return (
    typeof value === 'string' && (WORKFLOW_DEFINITION_SCOPES as readonly string[]).includes(value)
  );
}

export function isWritableWorkflowDefinitionScope(
  value: unknown
): value is WritableWorkflowDefinitionScope {
  return typeof value === 'string' && (WORKFLOW_WRITABLE_SCOPES as readonly string[]).includes(value);
}

/** Collection selection rules (FR-018). `exactlyOne` fails at run time on any size but one. */
export const WORKFLOW_SELECTION_RULES = ['first', 'last', 'exactlyOne'] as const;
export type WorkflowSelectionRule = (typeof WORKFLOW_SELECTION_RULES)[number];

export function isWorkflowSelectionRule(value: unknown): value is WorkflowSelectionRule {
  return typeof value === 'string' && (WORKFLOW_SELECTION_RULES as readonly string[]).includes(value);
}

/**
 * Closed comparison operator set (FR-020). Adding a member is a contract change, not a
 * configuration change — there is deliberately no operator registry and no way for an
 * operator-authored definition to introduce one.
 */
export const WORKFLOW_CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'in',
  'exists',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
] as const;
export type WorkflowConditionOperator = (typeof WORKFLOW_CONDITION_OPERATORS)[number];

export function isWorkflowConditionOperator(value: unknown): value is WorkflowConditionOperator {
  return (
    typeof value === 'string' && (WORKFLOW_CONDITION_OPERATORS as readonly string[]).includes(value)
  );
}

/**
 * Closed terminal run-status enum a `node-status` operand may be compared against (FR-022).
 * Mirrors the shipped run-side `HistoryTerminalStatus` exactly — do not add a member here
 * without adding it there. Note the single-l `canceled`, which is the canonical spelling in
 * `src/state/history-entry.ts` and `src/contracts/audit-events.ts`.
 */
export const WORKFLOW_NODE_TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;
export type WorkflowNodeTerminalStatus = (typeof WORKFLOW_NODE_TERMINAL_STATUSES)[number];

export function isWorkflowNodeTerminalStatus(value: unknown): value is WorkflowNodeTerminalStatus {
  return (
    typeof value === 'string' &&
    (WORKFLOW_NODE_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * A condition is structured data, never an expression string (FR-021). There is no text to
 * compile, evaluate, or sandbox, so the non-executability holds by construction rather than
 * by a rejection rule. Evaluation itself is FR-R2-008's concern.
 */
export type WorkflowConditionOperand =
  | { readonly source: 'node-output'; readonly nodeId: string; readonly field: string }
  | { readonly source: 'node-status'; readonly nodeId: string };

export type WorkflowConditionLiteral = string | number | boolean;

export interface WorkflowCondition {
  readonly left: WorkflowConditionOperand;
  readonly operator: WorkflowConditionOperator;
  readonly right?: WorkflowConditionLiteral | readonly WorkflowConditionLiteral[];
}

/**
 * The node identifier is the address, not the Pipeline identifier: two nodes may reference the
 * same `pipelineId` and are distinguished solely by `nodeId` (FR-003). Reorder, insert, and
 * remove preserve every surviving `nodeId`, so no connection endpoint needs remapping (FR-043).
 *
 * Deliberately unlike Pipeline bindings, which address a Phase by `phaseIndex` because
 * `phaseIds` is a bare string list with no per-occurrence identifier available.
 */
export interface WorkflowNode {
  readonly nodeId: string;
  readonly pipelineId: string;
  readonly label?: string;
}

/**
 * A connection carries no identifier of its own (FR-004): defects address it by position in
 * the authored list (`connections[2].to`), while its endpoints address nodes by the stable
 * `nodeId` of FR-002 (FR-044).
 *
 * It also carries no concurrency or fan-out-all marker. Several outgoing connections on one
 * node are mutually exclusive alternatives resolved one at a time, so parallel node execution
 * is excluded by construction rather than by a rejection rule (FR-012, FR-040).
 */
export interface WorkflowConnection {
  readonly from: { readonly nodeId: string; readonly portId: string };
  readonly to: { readonly nodeId: string; readonly portId: string };
  readonly condition?: WorkflowCondition;
  /** Integer; ascending evaluation order, then authored order for ties. */
  readonly priority?: number;
  /** At most one per source node; considered last. */
  readonly isDefault?: boolean;
  readonly selection?: WorkflowSelectionRule;
}

export interface WorkflowDefinition {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  /** Authored order preserved; carries no execution semantics (FR-049). */
  readonly nodes: readonly WorkflowNode[];
  /** Authored order preserved; the equal-priority tie-break only (FR-049). */
  readonly connections: readonly WorkflowConnection[];
  /** Non-empty; every entry names an existing node (FR-015). */
  readonly startNodeIds: readonly string[];
}

/**
 * Derived, never stored (FR-048): a Workflow's inputs are the node input ports no connection
 * binds, and its outputs are the node output ports no connection consumes.
 */
export interface WorkflowDerivedPort {
  readonly nodeId: string;
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType | PipelineOutputPortType;
}

export interface WorkflowDerivedPorts {
  readonly inputs: readonly WorkflowDerivedPort[];
  readonly outputs: readonly WorkflowDerivedPort[];
}

export interface WorkflowFieldError {
  readonly workflowId: string;
  /** Positional for connections, e.g. `connections[2].to`, `nodes[0].nodeId`. */
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type WorkflowSourceStatus = 'effective' | 'shadowed' | 'invalid';

export interface WorkflowSourceRecord {
  readonly key: string;
  readonly workflowId: string;
  readonly scope: WorkflowDefinitionScope;
  readonly status: WorkflowSourceStatus;
  readonly definition: WorkflowDefinition | null;
  /** Recognized authored fields only. Host-internal; sanitized before IPC. */
  readonly display: Readonly<Record<string, unknown>>;
  /**
   * The Pipelines this stored row names, deduplicated in authored node order.
   *
   * Read best-effort and kept on the record rather than derived from
   * `definition`, because an `invalid` record has no `definition` and yet still
   * holds a reference that blocks a Pipeline removal (FR-041, FR-031): the
   * reference goes live the moment the defects are corrected. A node whose
   * `pipelineId` is absent or malformed contributes nothing — no reference is
   * invented for it.
   *
   * Host-internal, like `display`: it never crosses IPC.
   */
  readonly nodePipelineIds: readonly string[];
  readonly errors: readonly WorkflowFieldError[];
}

export interface WorkflowCatalogWarning {
  readonly code: string;
  readonly message: string;
}

export interface WorkflowCatalogResolution {
  readonly records: readonly WorkflowSourceRecord[];
  readonly effective: readonly WorkflowDefinition[];
  readonly revisions: Readonly<Record<WritableWorkflowDefinitionScope, string>>;
  readonly warnings: readonly WorkflowCatalogWarning[];
}

export type WorkflowCatalogMutation =
  | { readonly kind: 'create'; readonly workflowId: string }
  /**
   * Feature 086 (FR-037, FR-045) — the Workflow half of one confirmed package
   * import, and the LAST of the three writes it performs (FR-038). The order is
   * fixed: Phases, then Pipelines, then this. A Workflow's node Pipelines must
   * already be effective before it is published, or it resolves against nothing.
   * Mirrors `PhaseCatalogMutation['import-package']` and
   * `PipelineCatalogMutation['import-package']`.
   */
  | { readonly kind: 'import-package'; readonly workflowIds: readonly string[] }
  | { readonly kind: 'edit'; readonly workflowId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourceScope: WorkflowDefinitionScope;
      readonly sourceWorkflowId: string;
      readonly workflowId: string;
    }
  | { readonly kind: 'remove'; readonly workflowId: string }
  | { readonly kind: 'reset' };

export interface ScopedWorkflowSavePayload {
  readonly scope: WritableWorkflowDefinitionScope;
  readonly expectedRevision: string;
  readonly mutation: WorkflowCatalogMutation;
  /** Rows stay `unknown` at the boundary; the host is the authoritative validator (FR-008). */
  readonly workflows: readonly unknown[];
}
