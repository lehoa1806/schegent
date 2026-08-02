import type {
  PhaseCatalogSourceRecord,
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseSourceStatus,
  PipelineDefinition
} from '../../lib/snapshot-types';

export type MutablePipeline = Omit<PipelineDefinition, 'phases'> & {
  phases: string[];
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
