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

import type {
  WorkflowCondition,
  WorkflowConditionOperand,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowDerivedPort,
  WorkflowNode
} from '../../contracts/workflow-definitions';

export const ID_MAX = 64;
export const NAME_MAX = 80;
export const LABEL_MAX = 128;
export const DESCRIPTION_MAX = 1024;
/** Wider than the Pipeline cap: a Workflow field path is positional (`connections[12].to`). */
export const FIELD_MAX = 48;
export const CODE_MAX = 64;
export const MESSAGE_MAX = 512;

export type Sanitize = (value: string) => string;

export function text(value: string, sanitize: Sanitize, max: number): string {
  return sanitize(value).slice(0, max);
}

function projectNode(node: WorkflowNode, sanitize: Sanitize): WorkflowNode {
  return Object.freeze({
    nodeId: text(node.nodeId, sanitize, ID_MAX),
    pipelineId: text(node.pipelineId, sanitize, ID_MAX),
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

function projectCondition(condition: WorkflowCondition, sanitize: Sanitize): WorkflowCondition {
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
      portId: text(connection.from.portId, sanitize, ID_MAX)
    }),
    to: Object.freeze({
      nodeId: text(connection.to.nodeId, sanitize, ID_MAX),
      portId: text(connection.to.portId, sanitize, ID_MAX)
    }),
    ...(connection.condition !== undefined
      ? { condition: projectCondition(connection.condition, sanitize) }
      : {}),
    ...(connection.priority !== undefined ? { priority: connection.priority } : {}),
    ...(connection.isDefault !== undefined ? { isDefault: connection.isDefault } : {}),
    ...(connection.selection !== undefined ? { selection: connection.selection } : {})
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
    nodes: Object.freeze(definition.nodes.map((node) => projectNode(node, sanitize))),
    connections: Object.freeze(
      definition.connections.map((connection) => projectConnection(connection, sanitize))
    ),
    startNodeIds: Object.freeze(definition.startNodeIds.map((id) => text(id, sanitize, ID_MAX)))
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
