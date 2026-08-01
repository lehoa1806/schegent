import type { PhaseDefinition, PipelineDefinition } from '../../lib/snapshot-types';

export type MutablePipeline = Omit<PipelineDefinition, 'phases'> & {
  phases: string[];
};

export type MutablePhase = {
  id: string;
  name: string;
  instruction: string;
  model?: string;
  effort?: PhaseDefinition['effort'];
  timeoutSeconds?: number;
  loopable?: boolean;
  retryCondition?: string;
  isRequired?: boolean;
  runner?: PhaseDefinition['runner'];
  [key: string]: unknown;
};

export type PhaseEditState = {
  rawJsonMode: boolean;
};
