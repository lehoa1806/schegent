// Feature 083 (US1, T030) — the definition-shape half of the Workflow catalog
// projection. Contract:
// `specs/083-workflow-graph-builder/contracts/workflow-catalog-snapshot.md`.
//
// Split out of `workflow-catalog-projector.ts` so both modules stay inside the
// ≤300-line sidebar-projector rule in `tests/lint/source-loc-budget.test.ts`.
// Both names carry `projector` deliberately: the rule reads
// `src/ui/sidebar` non-recursively and matches on that substring, so a sibling
// named otherwise would escape the budget rather than respect it.
//
// Every string here is operator-authored, so every one is sanitized exactly once
// and bounded (C5, C7). Numeric positions and closed-union members are host- or
// contract-controlled and pass through unchanged.

import type { PipelineExecutionDefaults } from '../../contracts/pipeline-definitions';
import { isTypedCondition, isTypedLeafTest, type TypedCondition, type TypedLeaf } from '../../contracts/decision-results';
import type {
  WorkflowBinding,
  WorkflowCondition,
  WorkflowConditionOperand,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowDerivedPort,
  WorkflowInputPort,
  WorkflowNode,
  WorkflowOutputPort
} from '../../contracts/workflow-definitions';

export const ID_MAX = 64;
export const NAME_MAX = 80;
export const LABEL_MAX = 128;
export const DESCRIPTION_MAX = 1024;
/** Wider than the Pipeline cap: a Workflow field path is positional (`connections[12].to`). */
export const FIELD_MAX = 48;
export const CODE_MAX = 64;
export const MESSAGE_MAX = 512;
/** `executionDefaults.model` is free text the validator trims but does not bound. */
const MODEL_MAX = 512;

export type Sanitize = (value: string) => string;

export function text(value: string, sanitize: Sanitize, max: number): string {
  return sanitize(value).slice(0, max);
}

function projectNode(node: WorkflowNode, sanitize: Sanitize): WorkflowNode {
  return Object.freeze({
    nodeId: text(node.nodeId, sanitize, ID_MAX),
    ...(node.kind !== undefined ? { kind: node.kind } : {}),
    ...(node.phaseId !== undefined ? { phaseId: text(node.phaseId, sanitize, ID_MAX) } : {}),
    ...(node.workflowId !== undefined
      ? { workflowId: text(node.workflowId, sanitize, ID_MAX) }
      : {}),
    ...(node.pipelineId !== undefined
      ? { pipelineId: text(node.pipelineId, sanitize, ID_MAX) }
      : {}),
    ...(node.label !== undefined ? { label: text(node.label, sanitize, LABEL_MAX) } : {})
  });
}

function projectOperand(
  operand: WorkflowConditionOperand,
  sanitize: Sanitize
): WorkflowConditionOperand {
  return Object.freeze(
    operand.source === 'node-output'
      ? {
        source: 'node-output' as const,
        nodeId: text(operand.nodeId, sanitize, ID_MAX),
        field: text(operand.field, sanitize, FIELD_MAX)
      }
      : { source: 'node-status' as const, nodeId: text(operand.nodeId, sanitize, ID_MAX) }
  );
}

/**
 * A literal is operator-authored, so its string form is sanitized too; numbers and
 * booleans carry nothing to redact and pass through unchanged.
 */
function projectLiteral(
  value: WorkflowCondition['right'],
  sanitize: Sanitize
): WorkflowCondition['right'] {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => (typeof entry === 'string' ? text(entry, sanitize, MESSAGE_MAX) : entry))
    );
  }
  return typeof value === 'string' ? text(value, sanitize, MESSAGE_MAX) : value;
}

function projectTypedLeaf(leaf: TypedLeaf, sanitize: Sanitize): TypedLeaf {
  const left =
    leaf.left.source === 'result-field'
      ? Object.freeze({ source: 'result-field' as const, fieldId: text(leaf.left.fieldId, sanitize, ID_MAX) })
      : Object.freeze({
          source: 'node-result' as const,
          nodeId: text(leaf.left.nodeId, sanitize, ID_MAX),
          fieldId: text(leaf.left.fieldId, sanitize, ID_MAX)
        });
  return Object.freeze({
    left,
    operator: leaf.operator,
    ...(leaf.right !== undefined ? { right: projectLiteral(leaf.right, sanitize) } : {})
  });
}

function projectCondition(
  condition: WorkflowCondition | TypedCondition,
  sanitize: Sanitize
): WorkflowCondition | TypedCondition {
  if (isTypedCondition(condition)) {
    const test = isTypedLeafTest(condition.test)
      ? projectTypedLeaf(condition.test, sanitize)
      : 'all' in condition.test
        ? Object.freeze({ all: Object.freeze(condition.test.all.map((l) => projectTypedLeaf(l, sanitize))) })
        : Object.freeze({ any: Object.freeze(condition.test.any.map((l) => projectTypedLeaf(l, sanitize))) });
    return Object.freeze({ version: 1 as const, kind: 'typed' as const, test });
  }
  return Object.freeze({
    left: projectOperand(condition.left, sanitize),
    operator: condition.operator,
    ...(condition.right !== undefined ? { right: projectLiteral(condition.right, sanitize) } : {})
  });
}

function projectConnection(connection: WorkflowConnection, sanitize: Sanitize): WorkflowConnection {
  return Object.freeze({
    from: Object.freeze({
      nodeId: text(connection.from.nodeId, sanitize, ID_MAX),
      ...(connection.from.portId !== undefined
        ? { portId: text(connection.from.portId, sanitize, ID_MAX) }
        : {})
    }),
    to: Object.freeze({
      nodeId: text(connection.to.nodeId, sanitize, ID_MAX),
      ...(connection.to.portId !== undefined
        ? { portId: text(connection.to.portId, sanitize, ID_MAX) }
        : {}),
      ...(connection.to.kind !== undefined ? { kind: connection.to.kind } : {})
    }),
    ...(connection.handoff !== undefined ? { handoff: connection.handoff } : {}),
    ...(connection.condition !== undefined
      ? { condition: projectCondition(connection.condition, sanitize) }
      : {}),
    ...(connection.priority !== undefined ? { priority: connection.priority } : {}),
    ...(connection.isDefault !== undefined ? { isDefault: connection.isDefault } : {}),
    ...(connection.selection !== undefined ? { selection: connection.selection } : {})
  });
}

function projectInputPort(port: WorkflowInputPort, sanitize: Sanitize): WorkflowInputPort {
  return Object.freeze({
    portId: text(port.portId, sanitize, ID_MAX),
    label: text(port.label, sanitize, LABEL_MAX),
    type: port.type,
    ...(port.required !== undefined ? { required: port.required } : {}),
    ...(port.description !== undefined
      ? { description: text(port.description, sanitize, DESCRIPTION_MAX) }
      : {})
  });
}

function projectOutputPort(port: WorkflowOutputPort, sanitize: Sanitize): WorkflowOutputPort {
  return Object.freeze({
    portId: text(port.portId, sanitize, ID_MAX),
    label: text(port.label, sanitize, LABEL_MAX),
    type: port.type,
    ...(port.required !== undefined ? { required: port.required } : {}),
    ...(port.description !== undefined
      ? { description: text(port.description, sanitize, DESCRIPTION_MAX) }
      : {})
  });
}

/**
 * Bindings carry operator-authored node ids, port keys and an output label, so
 * every string in them is sanitized; the closed-union members pass through.
 */
function projectBinding(binding: WorkflowBinding, sanitize: Sanitize): WorkflowBinding {
  if (binding.kind === 'output') {
    return Object.freeze({
      kind: 'output' as const,
      nodeId: text(binding.nodeId, sanitize, ID_MAX),
      portId: text(binding.portId, sanitize, ID_MAX),
      ...(binding.outputKey !== undefined
        ? { outputKey: text(binding.outputKey, sanitize, ID_MAX) }
        : {}),
      ...(binding.sourcePortId !== undefined
        ? { sourcePortId: text(binding.sourcePortId, sanitize, ID_MAX) }
        : {}),
      ...(binding.type !== undefined ? { type: binding.type } : {}),
      ...(binding.label !== undefined ? { label: text(binding.label, sanitize, LABEL_MAX) } : {}),
      ...(binding.selection !== undefined ? { selection: binding.selection } : {})
    });
  }
  return Object.freeze({
    kind: 'input' as const,
    nodeId: text(binding.nodeId, sanitize, ID_MAX),
    inputKey: text(binding.inputKey, sanitize, ID_MAX),
    ...(binding.type !== undefined ? { type: binding.type } : {}),
    ...(binding.required !== undefined ? { required: binding.required } : {}),
    source: Object.freeze(
      binding.source.from === 'workflow-input'
        ? {
            from: 'workflow-input' as const,
            portId: text(binding.source.portId, sanitize, ID_MAX)
          }
        : {
            from: 'node-output' as const,
            nodeId: text(binding.source.nodeId, sanitize, ID_MAX),
            portId: text(binding.source.portId, sanitize, ID_MAX)
          }
    ),
    ...(binding.selection !== undefined ? { selection: binding.selection } : {})
  });
}

function projectExecutionDefaults(
  defaults: PipelineExecutionDefaults,
  sanitize: Sanitize
): PipelineExecutionDefaults {
  return Object.freeze({
    ...(defaults.runner !== undefined ? { runner: text(defaults.runner, sanitize, ID_MAX) } : {}),
    ...(defaults.model !== undefined ? { model: text(defaults.model, sanitize, MODEL_MAX) } : {}),
    ...(defaults.effort !== undefined ? { effort: defaults.effort } : {}),
    ...(defaults.timeoutSeconds !== undefined ? { timeoutSeconds: defaults.timeoutSeconds } : {})
  });
}

/** C12: `nodes` and `connections` keep authored order — the projection performs no sort. */
export function projectWorkflowDefinition(
  definition: WorkflowDefinition,
  sanitize: Sanitize
): WorkflowDefinition {
  return Object.freeze({
    workflowId: text(definition.workflowId, sanitize, ID_MAX),
    name: text(definition.name, sanitize, NAME_MAX),
    ...(definition.description !== undefined
      ? { description: text(definition.description, sanitize, DESCRIPTION_MAX) }
      : {}),
    version: definition.version,
    ...(definition.inputs !== undefined
      ? { inputs: Object.freeze(definition.inputs.map((port) => projectInputPort(port, sanitize))) }
      : {}),
    ...(definition.outputs !== undefined
      ? {
          outputs: Object.freeze(
            definition.outputs.map((port) => projectOutputPort(port, sanitize))
          )
        }
      : {}),
    nodes: Object.freeze(definition.nodes.map((node) => projectNode(node, sanitize))),
    connections: Object.freeze(
      definition.connections.map((connection) => projectConnection(connection, sanitize))
    ),
    ...(definition.bindings !== undefined
      ? {
          bindings: Object.freeze(
            definition.bindings.map((binding) => projectBinding(binding, sanitize))
          )
        }
      : {}),
    startNodeIds: Object.freeze(definition.startNodeIds.map((id) => text(id, sanitize, ID_MAX))),
    ...(definition.executionDefaults !== undefined
      ? { executionDefaults: projectExecutionDefaults(definition.executionDefaults, sanitize) }
      : {}),
    ...(definition.recommendedNext !== undefined
      ? {
          recommendedNext: Object.freeze(
            definition.recommendedNext.map((id) => text(id, sanitize, ID_MAX))
          )
        }
      : {})
  });
}

export function projectWorkflowPort(
  port: WorkflowDerivedPort,
  sanitize: Sanitize
): WorkflowDerivedPort {
  return Object.freeze({
    nodeId: text(port.nodeId, sanitize, ID_MAX),
    portId: text(port.portId, sanitize, ID_MAX),
    label: text(port.label, sanitize, LABEL_MAX),
    type: port.type
  });
}
