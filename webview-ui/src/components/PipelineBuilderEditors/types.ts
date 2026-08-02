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
  PipelineSourceStatus
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
