import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkflowInspector from '../PipelineBuilderEditors/WorkflowInspector.svelte';
import WorkflowNodeStates from '../WorkflowRun/WorkflowNodeStates.svelte';
import type {
  ConnectedNodeProjection,
  PortableWorkflowDefinition,
  WorkflowNode
} from '../../lib/snapshot-types';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import type { AnchoredWorkflowDefects } from '../PipelineBuilderEditors/workflow-catalog-state';

afterEach(() => {
  cleanup();
});

const EMPTY_DEFECTS: AnchoredWorkflowDefects = {
  byNode: [],
  byConnection: [],
  rest: []
};

const CHILD_WORKFLOW: PortableWorkflowDefinition = {
  workflowId: 'wf-child-review',
  name: 'Child Review Workflow',
  version: 1,
  inputs: [
    { portId: 'feedback', label: 'Feedback', type: 'text', required: true },
    { portId: 'attempt-note', label: 'Attempt Note', type: 'text', required: false }
  ],
  outputs: [],
  nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-review' }],
  connections: [],
  startNodeIds: ['n1'],
  decisionResults: {
    version: 1,
    fields: [
      { fieldId: 'approved', type: 'boolean', required: true },
      { fieldId: 'nextFeedback', type: 'string', required: false }
    ],
    bindings: [
      { fieldId: 'approved', source: { kind: 'node-result', nodeId: 'n1', fieldId: 'approved' } },
      { fieldId: 'nextFeedback', source: { kind: 'node-result', nodeId: 'n1', fieldId: 'nextFeedback' } }
    ]
  }
};

function makeInspectorRow(nodeOverrides: Partial<WorkflowNode> = {}): MutableWorkflow {
  return {
    workflowId: 'wf-parent',
    name: 'Parent Workflow',
    description: '',
    version: 1,
    nodes: [
      {
        nodeId: 'node-repeat',
        kind: 'workflow',
        workflowId: 'wf-child-review',
        ...nodeOverrides
      }
    ],
    connections: [],
    startNodeIds: ['node-repeat'],
    sourceKey: 'wf-parent',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true,
    derivedInputs: [],
    derivedOutputs: []
  };
}

describe('WorkflowRepeat authoring & runtime surfaces (FR-R5-F33 / SPEC-11)', () => {
  it('toggles RepeatControl on a child-Workflow node and edits maxIterations, onExhausted, until, and carry mappings', async () => {
    const onnodepatch = vi.fn();
    const rowWithoutRepeat = makeInspectorRow();

    const { unmount } = render(WorkflowInspector, {
      props: {
        row: rowWithoutRepeat,
        selection: { kind: 'node', index: 0 },
        pipelines: [],
        phases: [],
        workflows: [CHILD_WORKFLOW],
        defects: EMPTY_DEFECTS,
        editable: true,
        onworkflowpatch: vi.fn(),
        onnodepatch,
        onstarttoggle: vi.fn(),
        onbranchadd: vi.fn(),
        onretarget: vi.fn(),
        onconnectionpatch: vi.fn(),
        onconditiontoggle: vi.fn(),
        onconditionpatch: vi.fn(),
        onconditionvalue: vi.fn(),
        onconditionvalueadd: vi.fn(),
        onconditionvalueremove: vi.fn(),
        onconnectionmove: vi.fn(),
        onconnectionremove: vi.fn()
      }
    });

    const toggle = screen.getByTestId('toggle-repeat-control');
    await fireEvent.change(toggle);
    expect(onnodepatch).toHaveBeenCalledWith(0, {
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 3,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'approved' },
            operator: 'equals',
            right: true
          }
        },
        carry: [],
        onExhausted: 'pause'
      }
    });
    unmount();

    // Render with Repeat enabled and carry mapping
    const onnodepatchActive = vi.fn();
    const rowWithRepeat = makeInspectorRow({
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 5,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'approved' },
            operator: 'equals',
            right: true
          }
        },
        carry: [{ fieldId: 'nextFeedback', inputPortId: 'feedback' }],
        onExhausted: 'pause'
      }
    });

    render(WorkflowInspector, {
      props: {
        row: rowWithRepeat,
        selection: { kind: 'node', index: 0 },
        pipelines: [],
        phases: [],
        workflows: [CHILD_WORKFLOW],
        defects: EMPTY_DEFECTS,
        editable: true,
        onworkflowpatch: vi.fn(),
        onnodepatch: onnodepatchActive,
        onstarttoggle: vi.fn(),
        onbranchadd: vi.fn(),
        onretarget: vi.fn(),
        onconnectionpatch: vi.fn(),
        onconditiontoggle: vi.fn(),
        onconditionpatch: vi.fn(),
        onconditionvalue: vi.fn(),
        onconditionvalueadd: vi.fn(),
        onconditionvalueremove: vi.fn(),
        onconnectionmove: vi.fn(),
        onconnectionremove: vi.fn()
      }
    });

    await fireEvent.input(screen.getByTestId('repeat-max-iterations'), {
      target: { value: '12' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ maxIterations: 12 })
      })
    );

    await fireEvent.change(screen.getByTestId('repeat-on-exhausted'), {
      target: { value: 'fail' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ onExhausted: 'fail' })
      })
    );

    await fireEvent.input(screen.getByTestId('repeat-until-field'), {
      target: { value: 'score' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          until: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'result-field', fieldId: 'score' },
              operator: 'equals',
              right: true
            }
          }
        })
      })
    );

    await fireEvent.change(screen.getByTestId('repeat-until-operator'), {
      target: { value: 'greaterThanOrEqual' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          until: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'result-field', fieldId: 'approved' },
              operator: 'greaterThanOrEqual',
              right: true
            }
          }
        })
      })
    );

    await fireEvent.input(screen.getByTestId('repeat-until-value'), {
      target: { value: '90' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          until: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'result-field', fieldId: 'approved' },
              operator: 'equals',
              right: 90
            }
          }
        })
      })
    );

    await fireEvent.input(screen.getByTestId('repeat-carry-field-0'), {
      target: { value: 'updatedField' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          carry: [{ fieldId: 'updatedField', inputPortId: 'feedback' }]
        })
      })
    );

    await fireEvent.input(screen.getByTestId('repeat-carry-port-0'), {
      target: { value: 'attempt-note' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          carry: [{ fieldId: 'nextFeedback', inputPortId: 'attempt-note' }]
        })
      })
    );

    await fireEvent.click(screen.getByTestId('add-repeat-carry'));
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          carry: [
            { fieldId: 'nextFeedback', inputPortId: 'feedback' },
            { fieldId: 'approved', inputPortId: 'feedback' }
          ]
        })
      })
    );

    await fireEvent.click(screen.getByTestId('remove-repeat-carry-0'));
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ carry: [] })
      })
    );
  });

  it('renders Repeat runtime pass counter distinct from nested leaf Phase attempts and shows exhaustion state without fresh-iteration actions', () => {
    const nodes: readonly ConnectedNodeProjection[] = [
      {
        nodeId: 'node-repeat',
        pipelineId: 'wf-child-review',
        nodeKind: 'workflow',
        label: 'Review Loop',
        state: 'in-flight',
        actions: [],
        attemptCount: 2,
        repeatProjection: {
          version: 1,
          kind: 'repeat',
          iteration: 2,
          currentPass: 2,
          maxIterations: 5,
          conditionResult: 'false',
          currentChildInvocationId: 'child-inv-2',
          onExhausted: 'pause',
          carryEnvelopeRef: 'root:node-repeat:pass-2:carry-env',
          leafAttemptCount: 4,
          completedPasses: [
            { iteration: 1, invocationId: 'child-inv-1', status: 'completed', resultRef: 'ref:1' }
          ],
          legalActions: [
            { kind: 'pause', allowed: true },
            { kind: 'resume', allowed: false, reason: 'illegal-state' },
            { kind: 'cancel', allowed: true }
          ]
        }
      },
      {
        nodeId: 'node-exhausted',
        pipelineId: 'wf-child-review',
        nodeKind: 'workflow',
        label: 'Exhausted Loop',
        state: 'blocked',
        actions: [],
        attemptCount: 3,
        repeatProjection: {
          version: 1,
          kind: 'repeat',
          iteration: 3,
          currentPass: 3,
          maxIterations: 3,
          conditionResult: 'false',
          currentChildInvocationId: null,
          onExhausted: 'pause',
          exhaustionReason: 'repeat-exhausted',
          leafAttemptCount: 6,
          completedPasses: [
            { iteration: 1, invocationId: 'c-1', status: 'completed' },
            { iteration: 2, invocationId: 'c-2', status: 'completed' },
            { iteration: 3, invocationId: 'c-3', status: 'completed' }
          ],
          legalActions: [
            { kind: 'pause', allowed: false, reason: 'illegal-state' },
            { kind: 'resume', allowed: false, reason: 'illegal-state' },
            { kind: 'cancel', allowed: true }
          ]
        }
      }
    ];

    render(WorkflowNodeStates, {
      props: {
        nodes,
        queueItems: []
      }
    });

    expect(screen.getByTestId('repeat-pass-counter-node-repeat').textContent).toContain(
      'Pass 2 of 5'
    );
    expect(screen.getByTestId('repeat-leaf-attempts-node-repeat').textContent).toContain(
      '4 leaf attempts'
    );
    expect(screen.getByTestId('repeat-condition-result-node-repeat').textContent).toContain(
      'Until: false'
    );
    expect(screen.getByTestId('repeat-current-child-node-repeat').textContent).toContain(
      'Active child: child-inv-2'
    );
    expect(screen.getByTestId('repeat-carry-ref-node-repeat').textContent).toContain(
      'Carry envelope: root:node-repeat:pass-2:carry-env'
    );
    expect(screen.getByTestId('repeat-pass-chip-node-repeat-1').textContent).toContain(
      '#1: completed'
    );

    expect(screen.getByTestId('repeat-exhaustion-reason-node-exhausted').textContent).toContain(
      'Exhaustion: repeat-exhausted (Paused — resume cannot extend maxIterations)'
    );
    expect(screen.queryByTestId('workflow-node-action-node-exhausted-start')).toBeNull();
    expect(screen.queryByTestId('workflow-node-action-node-exhausted-restart')).toBeNull();
  });
});

