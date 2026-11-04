import type { PipelineDefinition } from '../contracts/pipeline-definitions';
import type {
  WorkflowDefinition,
  WorkflowDerivedPort,
  WorkflowDerivedPorts
} from '../contracts/workflow-definitions';

/**
 * Derives a Workflow's port surface on read (FR-048, research R9, FR-R5-F01). Pure: the
 * definition is read, never written. A Workflow never persists `derivedInputs` or
 * `derivedOutputs` alongside the definition.
 *
 * Supports both transitional Pipeline-node graphs and unified Phase/child-Workflow graphs:
 *   - **input**  — a node input port that no connection or input binding binds, or declared
 *                  Workflow inputs when the Workflow has no child port-bearing nodes
 *   - **output** — a node output port that no connection consumes, or declared Workflow outputs
 *
 * No `vscode` import — the sidebar projector and the graph validator both call this, and the
 * projection contract requires them to agree by construction rather than by convention.
 */
export function deriveWorkflowPorts(
  definition: WorkflowDefinition,
  effectivePipelines: readonly PipelineDefinition[] = [],
  effectiveWorkflows: readonly WorkflowDefinition[] = []
): WorkflowDerivedPorts {
  const byPipelineId = new Map(effectivePipelines.map((entry) => [entry.pipelineId, entry]));
  const byWorkflowId = new Map(effectiveWorkflows.map((entry) => [entry.workflowId, entry]));

  const boundInputs = new Set<string>();
  const consumedOutputs = new Set<string>();

  for (const connection of definition.connections) {
    if (connection.to.portId !== undefined && connection.to.kind !== 'return') {
      boundInputs.add(portKey(connection.to.nodeId, connection.to.portId));
    }
    if (connection.from.portId !== undefined) {
      consumedOutputs.add(portKey(connection.from.nodeId, connection.from.portId));
    }
  }

  for (const binding of definition.bindings ?? []) {
    if (binding.kind === 'input') {
      boundInputs.add(portKey(binding.nodeId, binding.inputKey));
      if (binding.source.from === 'node-output') {
        consumedOutputs.add(portKey(binding.source.nodeId, binding.source.portId));
      }
    } else {
      const sourcePort = binding.sourcePortId ?? binding.outputKey ?? binding.portId;
      consumedOutputs.add(portKey(binding.nodeId, sourcePort));
    }
  }

  const inputs: WorkflowDerivedPort[] = [];
  const outputs: WorkflowDerivedPort[] = [];
  for (const node of definition.nodes) {
    if (node.pipelineId !== undefined) {
      const pipeline = byPipelineId.get(node.pipelineId);
      if (pipeline) {
        collect(inputs, node.nodeId, pipeline.inputs, boundInputs);
        collect(outputs, node.nodeId, pipeline.outputs, consumedOutputs);
      }
      continue;
    }
    if (node.workflowId !== undefined) {
      const child = byWorkflowId.get(node.workflowId);
      if (child) {
        collect(inputs, node.nodeId, child.inputs ?? [], boundInputs);
        collect(outputs, node.nodeId, child.outputs ?? [], consumedOutputs);
      }
    }
  }

  const anchorNodeId =
    definition.startNodeIds.at(0) ?? definition.nodes.at(0)?.nodeId ?? definition.workflowId;
  for (const port of definition.inputs ?? []) {
    if (!inputs.some((existing) => existing.portId === port.portId)) {
      inputs.unshift({
        nodeId: anchorNodeId,
        portId: port.portId,
        label: port.label,
        type: port.type
      });
    }
  }
  for (const port of definition.outputs ?? []) {
    if (!outputs.some((existing) => existing.portId === port.portId)) {
      outputs.push({
        nodeId: anchorNodeId,
        portId: port.portId,
        label: port.label,
        type: port.type
      });
    }
  }

  return { inputs, outputs };
}

interface DeclaredPort {
  readonly portId: string;
  readonly label: string;
  readonly type: WorkflowDerivedPort['type'];
}

function portKey(nodeId: string, portId: string): string {
  return `${nodeId}\u0000${portId}`;
}

function collect(
  into: WorkflowDerivedPort[],
  nodeId: string,
  declared: readonly DeclaredPort[],
  claimed: ReadonlySet<string>
): void {
  for (const port of declared) {
    if (claimed.has(portKey(nodeId, port.portId))) {
      continue;
    }
    into.push({ nodeId, portId: port.portId, label: port.label, type: port.type });
  }
}
