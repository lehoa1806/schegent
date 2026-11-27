import type {
  PipelineExecutionDefaults,
  PipelineInputPortType,
  PipelineOutputPortType
} from './pipeline-definitions';
import type { TypedCondition } from './decision-results';
import type {
  CandidateBlockControl,
  WorkflowDecisionResults,
  WorkflowNodeControl
} from './workflow-controls';
import type { HandoffPolicy } from './phase-context/context-policy';

export type { TypedCondition } from './decision-results';
export type { ContextSelector, HandoffPolicy } from './phase-context/context-policy';
export type {
  CandidateBlockControl,
  CandidateSpec,
  DecisionResultBinding,
  ForEachControl,
  RepeatControl,
  WorkflowControl,
  WorkflowDecisionResultField,
  WorkflowDecisionResults,
  WorkflowDecisionResultsContract,
  WorkflowNodeControl
} from './workflow-controls';

/**
 * Portable contract for the *definition* sense of "Workflow": a reusable acyclic graph of
 * Phase and child-Workflow nodes (with transitional Pipeline-node compatibility for downstream
 * Round 5 migrations). This is a different thing from the run-side `WorkflowRun*` family in
 * `src/state/workflow-run.ts`, which describes a queued request already in flight. No name
 * here collides with that family, and neither vocabulary is being renamed (FR-046).
 *
 * No `vscode` import: this module is consumed by the headless validators, the sidebar
 * projector, and the webview type mirror alike.
 */

/** How long a Workflow id may be. See `PHASE_ID_MAX_LEN` for why it lives here. */
export const WORKFLOW_ID_MAX_LEN = 64;

/** Canonical executable node kinds in the unified Workflow model (FR-R5-F01, FR-002). */
export const WORKFLOW_NODE_KINDS = ['phase', 'workflow'] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return typeof value === 'string' && (WORKFLOW_NODE_KINDS as readonly string[]).includes(value);
}

/** Per-transition execution handoff modes (FR-R5-F01, FR-005). */
export const WORKFLOW_HANDOFF_MODES = ['auto', 'manual'] as const;
export type WorkflowHandoffMode = (typeof WORKFLOW_HANDOFF_MODES)[number];

export function isWorkflowHandoffMode(value: unknown): value is WorkflowHandoffMode {
  return (
    typeof value === 'string' && (WORKFLOW_HANDOFF_MODES as readonly string[]).includes(value)
  );
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

/**
 * FR-R4-F07 (FR-027; contract C, C8) -- the operators that compare text, which is what v1 operands are:
 * a node status, or the location reference an output is recorded as.
 *
 * A subset of {@link WORKFLOW_CONDITION_OPERATORS}, which is unchanged: a stored Workflow may still carry
 * an ordering operator, and the graph validator reports it as `condition-comparison-unsupported` rather
 * than as an unknown operator. This is the list an authoring surface offers. The evaluator is not
 * involved and is not edited; it compares only values of the same type, so an ordering operator, or a
 * number or boolean literal, can never match a text operand.
 */
export const WORKFLOW_TEXT_COMPARISON_OPERATORS = [
  'equals',
  'notEquals',
  'in',
  'exists'
] as const satisfies readonly WorkflowConditionOperator[];

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
 * Public Workflow input port declaration (FR-R5-F01, FR-004).
 */
export interface WorkflowInputPort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType;
  readonly required?: boolean;
  readonly description?: string;
}

/**
 * Public Workflow output port declaration (FR-R5-F01, FR-004).
 * `required` defaults to `true` when omitted; `required: false` marks a branch-optional output.
 */
export interface WorkflowOutputPort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineOutputPortType;
  readonly required?: boolean;
  readonly description?: string;
}

/**
 * The node identifier is the address, not the target definition identifier: two nodes may
 * reference the same `phaseId` or `workflowId` and are distinguished solely by `nodeId`
 * (FR-003). Reorder, insert, and remove preserve every surviving `nodeId`, so no connection
 * or binding endpoint needs remapping (FR-043).
 */
export interface WorkflowNode {
  readonly nodeId: string;
  readonly kind?: WorkflowNodeKind;
  readonly phaseId?: string;
  readonly workflowId?: string;
  readonly pipelineId?: string;
  readonly label?: string;
  /** FR-R5-F25 (D9) — Repeat or ForEach control decorating a child-Workflow call node. */
  readonly control?: WorkflowNodeControl;
}

export interface WorkflowConnectionEndpoint {
  readonly nodeId: string;
  readonly portId?: string;
  readonly kind?: 'node' | 'return';
}

/**
 * A connection carries no identifier of its own (FR-004): defects address it by position in
 * the authored list (`connections[2].to`), while its endpoints address nodes by the stable
 * `nodeId` of FR-002 (FR-044).
 *
 * Execution transitions (`connections`) are separate from data bindings (`bindings`) so
 * sequencing two Phase nodes requires no synthetic ports or bindings (FR-R5-F01, FR-005).
 */
export interface WorkflowConnection {
  readonly from: { readonly nodeId: string; readonly portId?: string };
  readonly to: WorkflowConnectionEndpoint;
  readonly handoff?: WorkflowHandoffMode;
  readonly condition?: WorkflowCondition | TypedCondition;
  /** Integer; ascending evaluation order, then authored order for ties. */
  readonly priority?: number;
  /** At most one per source node; considered last. */
  readonly isDefault?: boolean;
  readonly selection?: WorkflowSelectionRule;
  /** FR-R6-F15 (F15-FR-01) — versioned opt-in phase-to-phase context handoff policy. */
  readonly contextPolicy?: HandoffPolicy;
}

export type WorkflowInputBindingSource =
  | { readonly from: 'workflow-input'; readonly portId: string }
  | { readonly from: 'node-output'; readonly nodeId: string; readonly portId: string };

export interface WorkflowInputBinding {
  readonly kind: 'input';
  readonly nodeId: string;
  readonly inputKey: string;
  readonly type?: PipelineInputPortType;
  readonly required?: boolean;
  readonly source: WorkflowInputBindingSource;
  readonly selection?: WorkflowSelectionRule;
}

export interface WorkflowOutputBinding {
  readonly kind: 'output';
  readonly nodeId: string;
  /** Public Workflow output portId bound by this node output. */
  readonly portId: string;
  /** Phase output key or child-Workflow output portId (defaults to `portId` when omitted). */
  readonly outputKey?: string;
  readonly sourcePortId?: string;
  readonly type?: PipelineOutputPortType;
  readonly label?: string;
  readonly selection?: WorkflowSelectionRule;
}

export type WorkflowBinding = WorkflowInputBinding | WorkflowOutputBinding;

export interface WorkflowDefinition {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly inputs?: readonly WorkflowInputPort[];
  readonly outputs?: readonly WorkflowOutputPort[];
  /** Authored order preserved; carries no execution semantics (FR-049). */
  readonly nodes: readonly WorkflowNode[];
  /** Authored order preserved; the equal-priority tie-break only (FR-049). */
  readonly connections: readonly WorkflowConnection[];
  readonly bindings?: readonly WorkflowBinding[];
  /** Non-empty; every entry names an existing node (FR-015). */
  readonly startNodeIds: readonly string[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
  /** FR-R5-F25 (D3) — Candidate-block control when this Workflow is a reusable candidate block. */
  readonly control?: CandidateBlockControl;
  /** FR-R5-F25 (D3) — Public typed decision result fields and explicit bindings. */
  readonly decisionResults?: WorkflowDecisionResults;
}

/**
 * Derived, never stored (FR-048): a Workflow's derived ports are projected on read from the
 * graph and never persisted as a second copy alongside the definition.
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
  /** Positional for connections/bindings, e.g. `connections[2].to`, `nodes[0].nodeId`. */
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** Feature 099 (FR-040) — two arms. See `PhaseSourceStatus` for why `shadowed` is gone. */
export type WorkflowSourceStatus = 'effective' | 'invalid';

export interface WorkflowSourceRecord {
  readonly key: string;
  readonly workflowId: string;
  readonly status: WorkflowSourceStatus;
  readonly definition: WorkflowDefinition | null;
  /** Recognized authored fields only. Host-internal; sanitized before IPC. */
  readonly display: Readonly<Record<string, unknown>>;
  /**
   * The Phases and child Workflows this stored row names, deduplicated in authored node order.
   * Kept on the record even when `definition` is `null` so an invalid active Workflow still
   * blocks deactivating a referenced Phase or child Workflow (hard rule 38, FR-R5-F01).
   */
  readonly nodePhaseIds?: readonly string[];
  readonly nodeWorkflowIds?: readonly string[];
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
  /** One revision for the one layer (FR-044), derived from the store's manifest (FR-044a). */
  readonly revision: string;
  readonly warnings: readonly WorkflowCatalogWarning[];
  /**
   * BUG-001 (101) — the saved-but-unpublished rows, for the Builder's Library alone.
   * See `PhaseCatalogResolution.draftOnlyRecords` for why this is a second list
   * and not more of `records`.
   */
  readonly draftOnlyRecords: readonly WorkflowSourceRecord[];
}

export type WorkflowCatalogMutation =
  | { readonly kind: 'create'; readonly workflowId: string }
  | { readonly kind: 'import-package'; readonly workflowIds: readonly string[] }
  | { readonly kind: 'edit'; readonly workflowId: string }
  | {
    readonly kind: 'duplicate';
    readonly sourceWorkflowId: string;
    readonly workflowId: string;
  }
  | { readonly kind: 'remove'; readonly workflowId: string }
  | { readonly kind: 'reset' };

/** One save against the one layer. Formerly `ScopedWorkflowSavePayload` (FR-043). */
export interface WorkflowSavePayload {
  readonly expectedRevision: string;
  readonly mutation: WorkflowCatalogMutation;
  /** Rows stay `unknown` at the boundary; the host is the authoritative validator (FR-008). */
  readonly workflows: readonly unknown[];
}
