import { describe, expect, it } from 'vitest';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition
} from '../../../src/contracts/workflow-definitions';
import { deriveWorkflowPorts } from '../../../src/config/workflow-derived-ports';

const pipeline = (pipelineId: string): PipelineDefinition => ({
  pipelineId,
  name: pipelineId,
  version: 1,
  phaseIds: ['plan'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text' },
    { portId: 'repo', label: 'Repository', type: 'repository-context' }
  ],
  outputs: [
    { portId: 'plan', label: 'Plan', type: 'markdown' },
    { portId: 'notes', label: 'Notes', type: 'markdown' }
  ],
  bindings: [],
  recommendedNext: []
});

const workflow = (
  nodes: readonly { readonly nodeId: string; readonly pipelineId: string }[],
  connections: readonly WorkflowConnection[]
): WorkflowDefinition => ({
  workflowId: 'wf',
  name: 'Workflow',
  version: 1,
  nodes,
  connections,
  startNodeIds: [nodes[0]?.nodeId ?? 'design']
});

const keys = (ports: readonly { readonly nodeId: string; readonly portId: string }[]): string[] =>
  ports.map((port) => `${port.nodeId}.${port.portId}`);

describe('deriveWorkflowPorts (FR-048)', () => {
  it('reports every node input port when nothing is connected', () => {
    const { inputs, outputs } = deriveWorkflowPorts(
      workflow([{ nodeId: 'design', pipelineId: 'standard' }], []),
      [pipeline('standard')]
    );

    expect(keys(inputs)).toEqual(['design.brief', 'design.repo']);
    expect(keys(outputs)).toEqual(['design.plan', 'design.notes']);
  });

  it('omits a bound input and keeps the unbound one', () => {
    const { inputs } = deriveWorkflowPorts(
      workflow(
        [
          { nodeId: 'design', pipelineId: 'standard' },
          { nodeId: 'build', pipelineId: 'standard' }
        ],
        [{ from: { nodeId: 'design', portId: 'plan' }, to: { nodeId: 'build', portId: 'brief' } }]
      ),
      [pipeline('standard')]
    );

    expect(keys(inputs)).not.toContain('build.brief');
    expect(keys(inputs)).toContain('build.repo');
    expect(keys(inputs)).toContain('design.brief');
  });

  it('omits a consumed output and keeps the unconsumed one', () => {
    const { outputs } = deriveWorkflowPorts(
      workflow(
        [
          { nodeId: 'design', pipelineId: 'standard' },
          { nodeId: 'build', pipelineId: 'standard' }
        ],
        [{ from: { nodeId: 'design', portId: 'plan' }, to: { nodeId: 'build', portId: 'brief' } }]
      ),
      [pipeline('standard')]
    );

    expect(keys(outputs)).not.toContain('design.plan');
    expect(keys(outputs)).toContain('design.notes');
    expect(keys(outputs)).toContain('build.plan');
  });

  it('contributes nothing for a node whose ports are all bound or consumed', () => {
    const definition = workflow(
      [
        { nodeId: 'a', pipelineId: 'standard' },
        { nodeId: 'mid', pipelineId: 'standard' },
        { nodeId: 'z', pipelineId: 'standard' }
      ],
      [
        { from: { nodeId: 'a', portId: 'plan' }, to: { nodeId: 'mid', portId: 'brief' } },
        { from: { nodeId: 'a', portId: 'notes' }, to: { nodeId: 'mid', portId: 'repo' } },
        { from: { nodeId: 'mid', portId: 'plan' }, to: { nodeId: 'z', portId: 'brief' } },
        { from: { nodeId: 'mid', portId: 'notes' }, to: { nodeId: 'z', portId: 'repo' } }
      ]
    );
    const { inputs, outputs } = deriveWorkflowPorts(definition, [pipeline('standard')]);

    expect(keys(inputs).filter((key) => key.startsWith('mid.'))).toEqual([]);
    expect(keys(outputs).filter((key) => key.startsWith('mid.'))).toEqual([]);
  });

  it('keys two nodes on the same Pipeline separately by nodeId (FR-003)', () => {
    const { inputs, outputs } = deriveWorkflowPorts(
      workflow(
        [
          { nodeId: 'first', pipelineId: 'standard' },
          { nodeId: 'second', pipelineId: 'standard' }
        ],
        [{ from: { nodeId: 'first', portId: 'plan' }, to: { nodeId: 'second', portId: 'brief' } }]
      ),
      [pipeline('standard')]
    );

    expect(keys(inputs)).toEqual(['first.brief', 'first.repo', 'second.repo']);
    expect(keys(outputs)).toEqual(['first.notes', 'second.plan', 'second.notes']);
  });

  it('carries the declaring port label and type through', () => {
    const { inputs, outputs } = deriveWorkflowPorts(
      workflow([{ nodeId: 'design', pipelineId: 'standard' }], []),
      [pipeline('standard')]
    );

    expect(inputs[0]).toEqual({
      nodeId: 'design',
      portId: 'brief',
      label: 'Brief',
      type: 'text'
    });
    expect(outputs[0]).toEqual({
      nodeId: 'design',
      portId: 'plan',
      label: 'Plan',
      type: 'markdown'
    });
  });

  it('contributes nothing for a node naming a Pipeline outside the effective catalog', () => {
    // The missing Pipeline is a graph defect (`unknown-pipeline`), not a derivation concern.
    const { inputs, outputs } = deriveWorkflowPorts(
      workflow(
        [
          { nodeId: 'design', pipelineId: 'standard' },
          { nodeId: 'ghost', pipelineId: 'not-in-catalog' }
        ],
        []
      ),
      [pipeline('standard')]
    );

    expect(keys(inputs).some((key) => key.startsWith('ghost.'))).toBe(false);
    expect(keys(outputs).some((key) => key.startsWith('ghost.'))).toBe(false);
    expect(keys(inputs)).toEqual(['design.brief', 'design.repo']);
  });

  it('ignores a connection endpoint naming a port the Pipeline does not declare', () => {
    const { inputs } = deriveWorkflowPorts(
      workflow(
        [{ nodeId: 'design', pipelineId: 'standard' }],
        [{ from: { nodeId: 'design', portId: 'plan' }, to: { nodeId: 'design', portId: 'ghost' } }]
      ),
      [pipeline('standard')]
    );

    expect(keys(inputs)).toEqual(['design.brief', 'design.repo']);
  });

  it('never mutates the definition and never writes a port list back onto it', () => {
    const definition = workflow([{ nodeId: 'design', pipelineId: 'standard' }], []);
    const before = JSON.stringify(definition);

    deriveWorkflowPorts(definition, [pipeline('standard')]);

    expect(JSON.stringify(definition)).toBe(before);
    expect(Object.keys(definition)).not.toContain('inputs');
    expect(Object.keys(definition)).not.toContain('outputs');
  });

  it('returns empty port lists for a Workflow with no nodes', () => {
    const empty: WorkflowDefinition = {
      workflowId: 'wf',
      name: 'Workflow',
      version: 1,
      nodes: [],
      connections: [],
      startNodeIds: []
    };
    expect(deriveWorkflowPorts(empty, [pipeline('standard')])).toEqual({ inputs: [], outputs: [] });
  });
});
