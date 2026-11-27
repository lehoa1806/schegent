/**
 * Principal review Finding 4 — UI component test ensuring ExecutionVisibilityPanel submits
 * narrow `op: 'editSummary'` with `producerAttemptId` instead of fabricating empty
 * `replacementSources`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import ExecutionVisibilityPanel from '../ExecutionVisibilityPanel.svelte';
import type {
  DecidePhaseHandoffRequest,
  DecidePhaseHandoffResponse,
  ReadExecutionVisibilityRequest,
  ReadExecutionVisibilityResponse
} from '../../lib/messages';
import type { VisibilityCallEnvelope } from '../../lib/execution-visibility-ipc';

const mockVisibility =
  vi.fn<
    (req: ReadExecutionVisibilityRequest) => Promise<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>>
  >();
const mockDecide =
  vi.fn<
    (req: DecidePhaseHandoffRequest) => Promise<VisibilityCallEnvelope<DecidePhaseHandoffResponse>>
  >();

vi.mock('../../lib/execution-visibility-ipc', () => ({
  requestExecutionVisibility: (req: ReadExecutionVisibilityRequest) => mockVisibility(req),
  requestChangeReview: vi.fn(),
  requestDecidePhaseHandoff: (req: DecidePhaseHandoffRequest) => mockDecide(req)
}));

describe('ExecutionVisibilityPanel — narrow editSummary submission (Finding 4)', () => {
  beforeEach(() => {
    mockVisibility.mockReset();
    mockDecide.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('sends op=editSummary with selected producerAttemptId and never sends replacementSources', async () => {
    mockVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'attemptDetail',
        detail: {
          available: true,
          hierarchy: {
            rootExecutionId: 'root-ui-1',
            invocationCount: 1,
            attemptCount: 2,
            dataQuality: 'complete',
            attempts: []
          },
          evidence: [],
          liveLog: { streamState: 'absent', segmentCount: 0, gapCount: 0 },
          recovery: {
            disposition: null,
            uncertainEffectCount: 0,
            hasUncertainEffects: false,
            requiresOperatorAction: false
          },
          acp: {
            runtimeState: 'idle',
            profileId: null,
            backendKind: null,
            modelId: null,
            sessionReused: false,
            liveObservations: 0,
            streamDegraded: false
          },
          lane: {
            mode: 'shared-workspace',
            laneId: null,
            laneState: null,
            candidateId: null,
            integrationState: null,
            targetRef: null,
            comparisonRevision: null,
            requestId: null
          },
          handoffs: [
            {
              handoffId: 'ho-ui-1',
              identity: {
                handoffId: 'ho-ui-1',
                rootExecutionId: 'root-ui-1',
                workflowId: 'wf-1',
                targetInvocationId: 'inv-target',
                targetNodePath: 'wf-1/implement',
                targetPhaseId: 'implement'
              },
              revision: 1,
              approval: 'manual',
              session: 'fresh',
              revisions: [
                {
                  revision: 1,
                  origin: 'prepared',
                  state: 'waiting-approval',
                  manifestDigest: 'a'.repeat(64),
                  renderedBytes: 256
                }
              ],
              sources: [
                {
                  producer: {
                    nodePath: 'wf-1/specify',
                    occurrenceId: 'occ-spec-1',
                    attemptId: 'att-spec-7'
                  },
                  coverage: 'complete',
                  required: true,
                  selectedBy: { kind: 'selector', id: 'sel-specify' },
                  outcomeCount: 2,
                  decisionCount: 1,
                  constraintCount: 1,
                  unresolvedIssueCount: 1,
                  artifactCount: 1
                },
                {
                  producer: {
                    nodePath: 'wf-1/plan',
                    occurrenceId: 'occ-plan-1',
                    attemptId: 'att-plan-11'
                  },
                  coverage: 'complete',
                  required: true,
                  selectedBy: { kind: 'selector', id: 'sel-plan' },
                  outcomeCount: 1,
                  decisionCount: 1,
                  constraintCount: 0,
                  unresolvedIssueCount: 0,
                  artifactCount: 1
                }
              ],
              omissions: [],
              omissionsUnlisted: 0
            }
          ],
          reviewLoops: []
        }
      } as unknown as ReadExecutionVisibilityResponse
    });

    mockDecide.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'editSummary',
        result: {
          ok: true,
          revision: {
            revision: 2,
            origin: 'edited',
            state: 'waiting-approval',
            manifestDigest: 'b'.repeat(64),
            serialized: '{}',
            renderedBytes: 256
          }
        }
      } as unknown as DecidePhaseHandoffResponse
    });

    const view = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'root-ui-1', isPrimary: true }
    });
    await tick();
    flushSync();

    await fireEvent.click(view.getByTestId('ev-handoff-edit-ho-ui-1'));
    flushSync();

    // Select second producer (`att-plan-11`) and submit curated summary.
    await fireEvent.change(view.getByTestId('ev-handoff-source-ho-ui-1'), {
      target: { value: 'att-plan-11' }
    });
    await fireEvent.input(view.getByTestId('ev-handoff-input-ho-ui-1'), {
      target: { value: 'Updated plan summary only' }
    });
    await fireEvent.click(view.getByTestId('ev-handoff-save-ho-ui-1'));
    await tick();
    flushSync();

    expect(mockDecide).toHaveBeenCalledTimes(1);
    const req = mockDecide.mock.calls[0]?.[0];
    expect(req).toEqual({
      op: 'editSummary',
      handoffId: 'ho-ui-1',
      baseRevision: 1,
      summary: 'Updated plan summary only',
      producerAttemptId: 'att-plan-11'
    });
    expect(view.getByTestId('execution-visibility-notice').textContent).toContain(
      'Saved edited handoff revision 2.'
    );
  });

  it('preserves draft on refusal, clears draft on toggle, and keys duplicate attemptIds by full producer tuple', async () => {
    mockVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'attemptDetail',
        detail: {
          available: true,
          hierarchy: {
            rootExecutionId: 'root-ui-2',
            invocationCount: 1,
            attemptCount: 2,
            dataQuality: 'complete',
            attempts: []
          },
          evidence: [],
          liveLog: { streamState: 'absent', segmentCount: 0, gapCount: 0 },
          recovery: {
            disposition: null,
            uncertainEffectCount: 0,
            hasUncertainEffects: false,
            requiresOperatorAction: false
          },
          acp: {
            runtimeState: 'idle',
            profileId: null,
            backendKind: null,
            modelId: null,
            sessionReused: false,
            liveObservations: 0,
            streamDegraded: false
          },
          lane: {
            mode: 'shared-workspace',
            laneId: null,
            laneState: null,
            candidateId: null,
            integrationState: null,
            targetRef: null,
            comparisonRevision: null,
            requestId: null
          },
          handoffs: [
            {
              handoffId: 'ho-ui-2',
              identity: {
                handoffId: 'ho-ui-2',
                rootExecutionId: 'root-ui-2',
                workflowId: 'wf-2',
                targetInvocationId: 'inv-target',
                targetNodePath: 'wf-2/implement',
                targetPhaseId: 'implement'
              },
              revision: 1,
              approval: 'manual',
              session: 'fresh',
              revisions: [
                {
                  revision: 1,
                  origin: 'prepared',
                  state: 'waiting-approval',
                  manifestDigest: 'a'.repeat(64),
                  renderedBytes: 256
                }
              ],
              sources: [
                {
                  producer: {
                    nodePath: 'wf-2/specify',
                    occurrenceId: 'occ-1',
                    attemptId: 'attempt-1'
                  },
                  coverage: 'complete',
                  required: true,
                  selectedBy: { kind: 'selector', id: 'sel-a' },
                  outcomeCount: 1,
                  decisionCount: 0,
                  constraintCount: 0,
                  unresolvedIssueCount: 0,
                  artifactCount: 0
                },
                {
                  producer: {
                    nodePath: 'wf-2/plan',
                    occurrenceId: 'occ-2',
                    attemptId: 'attempt-1'
                  },
                  coverage: 'complete',
                  required: true,
                  selectedBy: { kind: 'selector', id: 'sel-b' },
                  outcomeCount: 1,
                  decisionCount: 0,
                  constraintCount: 0,
                  unresolvedIssueCount: 0,
                  artifactCount: 0
                }
              ],
              omissions: [],
              omissionsUnlisted: 0
            }
          ],
          reviewLoops: []
        }
      } as unknown as ReadExecutionVisibilityResponse
    });

    mockDecide.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'editSummary',
        result: {
          ok: false,
          failure: 'invalid-source',
          detail: 'edit-summary'
        }
      } as unknown as DecidePhaseHandoffResponse
    });

    const view = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'root-ui-2', isPrimary: true }
    });
    await tick();
    flushSync();

    // Renders both options cleanly even though both sources share `attempt-1`.
    await fireEvent.click(view.getByTestId('ev-handoff-edit-ho-ui-2'));
    flushSync();
    expect(view.getByTestId('ev-handoff-source-ho-ui-2').querySelectorAll('option')).toHaveLength(2);

    const input = view.getByTestId('ev-handoff-input-ho-ui-2') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Draft preserved on refusal' } });
    await fireEvent.click(view.getByTestId('ev-handoff-save-ho-ui-2'));
    await tick();
    flushSync();

    // Refusal preserves the form open and keeps the operator's draft text.
    expect(view.getByTestId('execution-visibility-notice').textContent).toContain(
      'Could not edit handoff: invalid-source.'
    );
    expect((view.getByTestId('ev-handoff-input-ho-ui-2') as HTMLInputElement).value).toBe(
      'Draft preserved on refusal'
    );

    // Closing and reopening clears the draft cleanly.
    await fireEvent.click(view.getByTestId('ev-handoff-edit-ho-ui-2'));
    flushSync();
    await fireEvent.click(view.getByTestId('ev-handoff-edit-ho-ui-2'));
    flushSync();
    expect((view.getByTestId('ev-handoff-input-ho-ui-2') as HTMLInputElement).value).toBe('');
  });
});
