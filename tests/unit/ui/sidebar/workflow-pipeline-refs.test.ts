// Feature 082 (US1 FR-002, US7 FR-022a) — the shared definition of a
// "consuming Workflow".
//
// Two surfaces read this list and must never disagree: the Library's
// consuming-Workflow display and gate 13's removal block. The rule under test
// is that a request stops being a consumer the moment it starts, because the
// Run has by then frozen the Pipeline contract (FR-027) and no catalog edit can
// reach it.
//
// Feature 083 (FR-041) added a second sense of "consuming Workflow" — a stored
// Workflow *definition* whose node names a Pipeline — so every reference now
// carries a `kind` discriminant. This collector's selection rule is unchanged;
// it only stamps `run-request` on what it already reported.

import { describe, expect, it } from 'vitest';
import { collectWorkflowPipelineRefs } from '../../../../src/ui/sidebar/workflow-pipeline-refs';
import type { FeatureRequest } from '../../../../src/queue/feature-request';

function request(overrides: Partial<FeatureRequest>): FeatureRequest {
  return {
    id: 'wf-a',
    description: 'do the thing',
    enqueuedAt: 0,
    createdAt: 0,
    startedAt: null,
    updatedAt: 0,
    completedAt: null,
    status: 'pending',
    position: 0,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    ...overrides
  };
}

describe('collectWorkflowPipelineRefs', () => {
  it('reports a pending request that pins a pipelineId', () => {
    expect(
      collectWorkflowPipelineRefs([request({ id: 'wf-a', pipelineId: 'custom-flow' })])
    ).toEqual([{ workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' }]);
  });

  it('drops a request that has started a Run — its contract is frozen (FR-027)', () => {
    expect(
      collectWorkflowPipelineRefs([
        request({ id: 'wf-a', pipelineId: 'custom-flow', status: 'in-flight', runId: 'run-1' }),
        request({ id: 'wf-b', pipelineId: 'custom-flow', status: 'completed', runId: 'run-2' }),
        request({ id: 'wf-c', pipelineId: 'custom-flow', status: 'failed', runId: 'run-3' })
      ])
    ).toEqual([]);
  });

  it('drops a request canceled before it ever started', () => {
    // `QueueManager.cancel()` only reaches a *pending* request and leaves
    // `runId` null, so "has it started?" alone would report a canceled Workflow
    // as a live consumer and block a removal nothing is waiting on.
    expect(
      collectWorkflowPipelineRefs([
        request({ id: 'wf-a', pipelineId: 'custom-flow', status: 'canceled', runId: null })
      ])
    ).toEqual([]);
  });

  it('keeps a request paused before it started — it still resolves the Pipeline when it runs', () => {
    expect(
      collectWorkflowPipelineRefs([
        request({ id: 'wf-a', pipelineId: 'custom-flow', status: 'paused', runId: null })
      ])
    ).toEqual([{ workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' }]);
  });

  it('drops a request that pins no pipelineId', () => {
    expect(collectWorkflowPipelineRefs([request({ id: 'wf-a' })])).toEqual([]);
  });

  it('preserves one entry per request, so two Workflows on one id both count', () => {
    expect(
      collectWorkflowPipelineRefs([
        request({ id: 'wf-a', pipelineId: 'custom-flow' }),
        request({ id: 'wf-b', pipelineId: 'custom-flow' }),
        request({ id: 'wf-c', pipelineId: 'other-flow' })
      ])
    ).toEqual([
      { workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' },
      { workflowId: 'wf-b', pipelineId: 'custom-flow', kind: 'run-request' },
      { workflowId: 'wf-c', pipelineId: 'other-flow', kind: 'run-request' }
    ]);
  });

  it('reports nothing for an empty queue', () => {
    expect(collectWorkflowPipelineRefs([])).toEqual([]);
  });
});
