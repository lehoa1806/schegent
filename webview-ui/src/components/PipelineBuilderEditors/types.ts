import type {
  PhaseBinding,
  PhaseCatalogSourceRecord,
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseSourceStatus,
  PipelineCatalogSourceRecord,
  PipelineDefinition,
  PipelineDefinitionScope,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineInputPortType,
  PipelineOutputPort,
  PipelineOutputPortType,
  PipelineSourceStatus,
  WorkflowCatalogFieldErrorProjection,
  WorkflowCatalogPortProjection,
  WorkflowConnection,
  WorkflowDefinitionScope,
  WorkflowNode,
  WorkflowSourceStatus
} from '../../lib/snapshot-types';

/**
 * Feature 082 — a field-level edit to one input or output port. Spelled out as
 * an explicit optional-field shape rather than
 * `Partial<PipelineInputPort & PipelineOutputPort>`: the two port-type unions
 * are disjoint, so that intersection reduces to `never`.
 */
export interface PipelinePortPatch {
  readonly portId?: string;
  readonly label?: string;
  readonly type?: PipelineInputPortType | PipelineOutputPortType;
  readonly required?: boolean;
  readonly description?: string;
}

/**
 * Feature 082 — an editable Pipeline row. Mirrors `MutablePhase`: the authored
 * contract fields plus the precedence metadata the Library needs to render a
 * scope badge, a source status, and field-adjacent validation errors.
 *
 * The ordered Phase reference list keeps the legacy authored key (`phases`),
 * which is also the key form persisted back to configuration.
 */
export type MutablePipeline = Omit<PipelineDefinition, 'phases'> & {
  phases: string[];
  version: number;
  inputs: PipelineInputPort[];
  outputs: PipelineOutputPort[];
  bindings: PhaseBinding[];
  executionDefaults?: PipelineExecutionDefaults;
  recommendedNext: string[];
  /** Stable list key; mirrors the projection record key for persisted rows. */
  sourceKey: string;
  scope: PipelineDefinitionScope;
  sourceStatus: PipelineSourceStatus;
  sourceErrors: PipelineCatalogSourceRecord['errors'];
  /** False for a draft that has never been accepted by the host. */
  persisted: boolean;
};

export type MutablePhase = {
  id: string;
  name: string;
  description?: string;
  version: number;
  instruction?: string;
  skill?: string;
  model?: string;
  effort?: PhaseDefinition['effort'];
  timeoutSeconds?: number;
  loopable?: boolean;
  retryCondition?: string;
  isRequired?: boolean;
  runner?: PhaseDefinition['runner'];
  sourceKey: string;
  scope: PhaseDefinitionScope;
  sourceStatus: PhaseSourceStatus;
  sourceErrors: PhaseCatalogSourceRecord['errors'];
  modelAvailable?: boolean;
  persisted: boolean;
  [key: string]: unknown;
};

export type PhaseEditState = {
  rawJsonMode: boolean;
};

/**
 * Feature 083 — an editable Workflow row. Same shape of thing as
 * `MutablePipeline`: the authored contract fields plus the precedence metadata
 * the Library renders.
 *
 * Two deliberate differences from the Pipeline row. The identity key is
 * `workflowId` and only `workflowId` — `schegent.workflows` is new in this
 * feature, so unlike `MutablePipeline` there is no legacy `id` spelling to
 * carry. And the nested arrays are mutable copies rather than the readonly
 * projection arrays, because the Builder edits node and connection rows in
 * place and the authored position of each is part of the definition (FR-049).
 */
export type MutableWorkflow = {
  workflowId: string;
  name: string;
  description?: string;
  version: number;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  startNodeIds: string[];
  /** Stable list key; mirrors the projection record key for persisted rows. */
  sourceKey: string;
  scope: WorkflowDefinitionScope;
  sourceStatus: WorkflowSourceStatus;
  sourceErrors: readonly WorkflowCatalogFieldErrorProjection[];
  /** False for a draft that has never been accepted by the host. */
  persisted: boolean;
  /**
   * Feature 083 (US5, FR-048) — the host's derived ports, carried for display
   * only and stripped by `toSaveWorkflowRow` along with the other
   * projection-only fields above.
   *
   * Empty on any row no host has projected — a new draft, and a duplicate,
   * which clears them for the same reason it clears `sourceErrors`. Deriving
   * them webview-side would put a second answer next to the authoritative one
   * and let the two disagree the moment the local rules drifted.
   */
  derivedInputs: readonly WorkflowCatalogPortProjection[];
  derivedOutputs: readonly WorkflowCatalogPortProjection[];
};
