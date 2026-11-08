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
  workflowId: 'wf-child-item',
  name: 'Child Item Workflow',
  version: 1,
  inputs: [
    { portId: 'itemPayload', label: 'Item Payload', type: 'text', required: true },
    { portId: 'sharedNote', label: 'Shared Note', type: 'text', required: false }
  ],
  outputs: [],
  nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-item' }],
  connections: [],
  startNodeIds: ['n1']
};

function makeInspectorRow(nodeOverrides: Partial<WorkflowNode> = {}): MutableWorkflow {
  return {
    workflowId: 'wf-parent-fe',
    name: 'Parent ForEach Workflow',
    description: '',
    version: 1,
    nodes: [
      {
        nodeId: 'node-foreach',
        kind: 'workflow',
        workflowId: 'wf-child-item',
        ...nodeOverrides
      }
    ],
    connections: [],
    startNodeIds: ['node-foreach'],
    sourceKey: 'wf-parent-fe',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true,
    derivedInputs: [],
    derivedOutputs: []
  };
}

describe('WorkflowForEach authoring & runtime surfaces (FR-R5-F34 / SPEC-12)', () => {
  it('toggles ForEachControl on a child-Workflow node and edits collection.source, nodeId, portId, itemInputPortId, itemKeyField, maxItems, and onItemError', async () => {
    const onnodepatch = vi.fn();
    const rowWithoutForEach = makeInspectorRow();

    const { unmount } = render(WorkflowInspector, {
      props: {
        row: rowWithoutForEach,
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

    const toggle = screen.getByTestId('toggle-foreach-control');
    await fireEvent.change(toggle);
    expect(onnodepatch).toHaveBeenCalledWith(0, {
      control: {
        version: 1,
        kind: 'for-each',
        collection: {
          source: 'workflow-input',
          portId: 'itemsFile'
        },
        itemInputPortId: 'itemPayload',
        maxItems: 50,
        onItemError: 'stop'
      }
    });
    unmount();

    const onnodepatchActive = vi.fn();
    const rowWithForEach = makeInspectorRow({
      control: {
        version: 1,
        kind: 'for-each',
        collection: {
          source: 'node-output',
          nodeId: 'node-upstream',
          portId: 'itemsPort'
        },
        itemKeyField: 'id',
        itemInputPortId: 'itemPayload',
        maxItems: 25,
        onItemError: 'stop'
      }
    });

    render(WorkflowInspector, {
      props: {
        row: rowWithForEach,
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

    await fireEvent.input(screen.getByTestId('foreach-collection-node-id'), {
      target: { value: 'node-planner' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          collection: {
            source: 'node-output',
            nodeId: 'node-planner',
            portId: 'itemsPort'
          }
        })
      })
    );

    await fireEvent.input(screen.getByTestId('foreach-collection-port-id'), {
      target: { value: 'batchOut' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          collection: {
            source: 'node-output',
            nodeId: 'node-upstream',
            portId: 'batchOut'
          }
        })
      })
    );

    await fireEvent.input(screen.getByTestId('foreach-item-input-port-id'), {
      target: { value: 'customItemPort' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ itemInputPortId: 'customItemPort' })
      })
    );

    await fireEvent.input(screen.getByTestId('foreach-item-key-field'), {
      target: { value: 'taskKey' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ itemKeyField: 'taskKey' })
      })
    );

    await fireEvent.input(screen.getByTestId('foreach-max-items'), {
      target: { value: '80' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ maxItems: 80 })
      })
    );

    await fireEvent.change(screen.getByTestId('foreach-on-item-error'), {
      target: { value: 'continue' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({ onItemError: 'continue' })
      })
    );

    await fireEvent.change(screen.getByTestId('foreach-collection-source'), {
      target: { value: 'workflow-input' }
    });
    expect(onnodepatchActive).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        control: expect.objectContaining({
          collection: {
            source: 'workflow-input',
            portId: 'itemsPort'
          }
        })
      })
    );
  });

  it('renders ConnectedForEachNodeProjection with distinct item counter and leaf attempt count, accessible hasErrors banner, ordered slots, and empty collection state', () => {
    const nodes: readonly ConnectedNodeProjection[] = [
      {
        nodeId: 'node-fe-active',
        pipelineId: 'wf-child-item',
        nodeKind: 'workflow',
        state: 'completed',
        actions: [],
        attemptCount: 3,
        forEachProjection: {
          version: 1,
          kind: 'for-each',
          collectionRef: 'fe-col-1234',
          collectionSha256: 'deadbeef',
          itemCount: 3,
          currentIndex: 2,
          onItemError: 'continue',
          hasErrors: true,
          errorCount: 1,
          resultIndexRef: 'fe-idx-5678',
          leafAttemptCount: 6,
          slots: [
            { index: 0, itemKey: 'item-a', state: 'completed', resultRef: 'res-0' },
            {
              index: 1,
              itemKey: 'item-b',
              state: 'failed',
              error: { code: 'child-failed', message: 'Candidate block exhausted on item-b' }
            },
            { index: 2, itemKey: 'item-c', state: 'completed', resultRef: 'res-2' }
          ]
        }
      },
      {
        nodeId: 'node-fe-empty',
        pipelineId: 'wf-child-item',
        nodeKind: 'workflow',
        state: 'completed',
        actions: [],
        attemptCount: 1,
        forEachProjection: {
          version: 1,
          kind: 'for-each',
          itemCount: 0,
          currentIndex: 0,
          onItemError: 'stop',
          hasErrors: false,
          errorCount: 0,
          leafAttemptCount: 0,
          slots: []
        }
      }
    ];

    render(WorkflowNodeStates, {
      props: {
        nodes,
        queueItems: []
      }
    });

    expect(screen.getByTestId('foreach-item-counter-node-fe-active').textContent).toContain(
      'Item 3 of 3'
    );
    expect(screen.getByTestId('foreach-leaf-attempts-node-fe-active').textContent).toContain(
      '6 leaf attempts'
    );
    expect(screen.getByTestId('foreach-on-item-error-node-fe-active').textContent).toContain(
      'onItemError: continue'
    );
    expect(screen.getByTestId('foreach-collection-ref-node-fe-active').textContent).toContain(
      'fe-col-1234'
    );
    expect(screen.getByTestId('foreach-result-index-ref-node-fe-active').textContent).toContain(
      'fe-idx-5678'
    );
    const errSummary = screen.getByTestId('foreach-error-summary-node-fe-active');
    expect(errSummary.getAttribute('role')).toBe('status');
    expect(errSummary.textContent).toContain('Completed with 1 item error (hasErrors: true)');
    expect(screen.getByTestId('foreach-slot-node-fe-active-1').textContent).toContain(
      '#1 (item-b): failed — child-failed: Candidate block exhausted on item-b'
    );

    expect(screen.getByTestId('foreach-item-counter-node-fe-empty').textContent).toContain(
      '0 items (empty collection)'
    );
    expect(screen.getByTestId('foreach-leaf-attempts-node-fe-empty').textContent).toContain(
      '0 leaf attempts'
    );
  });
});

