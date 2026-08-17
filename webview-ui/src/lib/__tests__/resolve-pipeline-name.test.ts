// Feature 097 (T001, FR-010, SC-003) — resolving a Task's Pipeline and its
// display name from the snapshot's `availablePipelines` list.
//
// This is the single resolver both the Queue Detail row and the Run Detail
// tier call, so a Task's Pipeline name can never read differently between
// the two tiers. The fallback case matters most: a Task can reference a
// Pipeline id that no longer exists in the catalog (deleted after the Task
// was enqueued), and the UI must show a labeled placeholder rather than the
// raw id or nothing at all.

import { describe, expect, it } from 'vitest';

import { findTaskPipeline, resolveTaskPipelineName } from '../resolve-pipeline-name';
import type { PipelineDefinition } from '../snapshot-types';

const PIPELINES: readonly PipelineDefinition[] = [
  { id: 'standard', name: 'Standard', phases: ['speckit-specify', 'speckit-plan'] },
  { id: 'hotfix', name: 'Hotfix', phases: ['speckit-implement'] }
];

describe('findTaskPipeline', () => {
  it('finds the Pipeline whose id matches the Task\'s currentPipelineId', () => {
    expect(findTaskPipeline({ currentPipelineId: 'hotfix' }, PIPELINES)).toEqual(PIPELINES[1]);
  });

  it('returns undefined when no Pipeline in the list matches', () => {
    expect(findTaskPipeline({ currentPipelineId: 'deleted-pipeline' }, PIPELINES)).toBeUndefined();
  });

  it('returns undefined against an empty catalog', () => {
    expect(findTaskPipeline({ currentPipelineId: 'standard' }, [])).toBeUndefined();
  });
});

describe('resolveTaskPipelineName', () => {
  it('resolves to the matching Pipeline\'s name', () => {
    expect(resolveTaskPipelineName({ currentPipelineId: 'standard' }, PIPELINES)).toBe('Standard');
  });

  it('falls back to a labeled placeholder rather than the raw id when unresolved', () => {
    const name = resolveTaskPipelineName({ currentPipelineId: 'deleted-pipeline' }, PIPELINES);

    expect(name).toBe('Unknown pipeline');
    expect(name).not.toContain('deleted-pipeline');
  });
});
