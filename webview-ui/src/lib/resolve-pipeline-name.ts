import type { PipelineDefinition, QueueItem } from './snapshot-types';

const UNKNOWN_PIPELINE_NAME = 'Unknown pipeline';

type PipelineReferencingTask = Pick<QueueItem, 'currentPipelineId'>;

export function findTaskPipeline(
  task: PipelineReferencingTask,
  availablePipelines: readonly PipelineDefinition[]
): PipelineDefinition | undefined {
  return availablePipelines.find((pipeline) => pipeline.id === task.currentPipelineId);
}

export function resolveTaskPipelineName(
  task: PipelineReferencingTask,
  availablePipelines: readonly PipelineDefinition[]
): string {
  return findTaskPipeline(task, availablePipelines)?.name ?? UNKNOWN_PIPELINE_NAME;
}
