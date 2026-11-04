import type { PhaseDefinition } from '../contracts/process-definitions';
import type {
  PipelineDefinition,
  PipelineInputPortType,
  PipelineOutputPortType
} from '../contracts/pipeline-definitions';
import {
  WORKFLOW_NODE_TERMINAL_STATUSES,
  isWorkflowConditionOperator,
  isWorkflowNodeTerminalStatus,
  type WorkflowCondition,
  type WorkflowConnection,
  type WorkflowDefinition,
  type WorkflowFieldError,
  type WorkflowInputBinding,
  type WorkflowInputPort,
  type WorkflowNode,
  type WorkflowOutputBinding,
  type WorkflowOutputPort
} from '../contracts/workflow-definitions';
import { resolveWorkflowClosure } from './workflow-closure-resolver';
import { workflowFieldError } from './workflow-definition-validator';
import {
  ancestorSets,
  reachableFrom,
  stronglyConnectedComponents,
  topologicalOrder,
  type WorkflowGraphEdge
} from './workflow-graph';

/**
 * Cross-reference validation for one Workflow against the resolved **effective** Phase,
 * Workflow, and Pipeline catalogs. Pure: no `vscode` import, no configuration read, no
 * mutation of its arguments.
 */

export const WORKFLOW_PORT_COMPATIBILITY: Readonly<
  Record<PipelineOutputPortType, readonly PipelineInputPortType[]>
> = Object.freeze({
  markdown: Object.freeze(['text', 'source'] as const),
  file: Object.freeze(['local-file', 'source'] as const),
  'file-set': Object.freeze(['local-folder', 'source-list'] as const),
  'structured-data': Object.freeze(['pipeline-output'] as const),
  'run-request': Object.freeze(['pipeline-output'] as const),
  'external-reference': Object.freeze(['web-url', 'source'] as const)
});

const COLLECTION_OUTPUT_TYPES: ReadonlySet<PipelineOutputPortType> = new Set(['file-set']);
const COLLECTION_INPUT_TYPES: ReadonlySet<PipelineInputPortType> = new Set(['source-list']);
const STRUCTURED_OUTPUT_TYPES: ReadonlySet<PipelineOutputPortType> = new Set([
  'structured-data',
  'run-request'
]);

export interface WorkflowGraphValidationOptions {
  readonly effectivePhases?: readonly PhaseDefinition[] | undefined;
  readonly invalidPhases?: ReadonlyMap<string, string> | undefined;
  readonly effectiveWorkflows?: readonly WorkflowDefinition[] | undefined;
  readonly invalidWorkflows?: ReadonlyMap<string, string> | undefined;
}

interface PortBearingTarget {
  readonly kind: 'pipeline' | 'workflow' | 'phase';
  readonly id: string;
  readonly inputs: readonly WorkflowInputPort[];
  readonly outputs: readonly WorkflowOutputPort[];
}

interface ResolvedNode {
  readonly node: WorkflowNode;
  readonly index: number;
  readonly pipeline: PipelineDefinition | null;
  readonly phase: PhaseDefinition | null;
  readonly workflow: WorkflowDefinition | null;
  readonly target: PortBearingTarget | null;
}

interface GraphContext {
  readonly definition: WorkflowDefinition;
  readonly nodes: ReadonlyMap<string, ResolvedNode>;
  readonly edges: readonly WorkflowGraphEdge[];
  readonly errors: WorkflowFieldError[];
}

function isReturnEndpoint(
  endpoint: WorkflowConnection['to'],
  nodes: ReadonlyMap<string, ResolvedNode>
): boolean {
  return endpoint.kind === 'return' || (endpoint.nodeId === 'return' && !nodes.has('return'));
}

export function validateWorkflowGraph(
  definition: WorkflowDefinition,
  effectivePipelines: readonly PipelineDefinition[] = [],
  invalidPipelines: ReadonlyMap<string, string> = new Map(),
  options: WorkflowGraphValidationOptions = {}
): readonly WorkflowFieldError[] {
  const errors: WorkflowFieldError[] = [];
  const nodes = resolveNodes(definition, effectivePipelines, invalidPipelines, options, errors);
  const edges = definition.connections
    .filter((c) => nodes.has(c.from.nodeId) && !isReturnEndpoint(c.to, nodes) && nodes.has(c.to.nodeId))
    .map((c) => ({ from: c.from.nodeId, to: c.to.nodeId }));
  const context: GraphContext = { definition, nodes, edges, errors };

  validateConnections(context);
  validateDuplicateInputBindings(context);
  const acyclic = validateCycles(context);
  validateReachability(context, acyclic);
  validateConditions(context, acyclic);
  validateBindingsAndOutputs(context, acyclic);
  return errors;
}

function resolveNodes(
  definition: WorkflowDefinition,
  effectivePipelines: readonly PipelineDefinition[],
  invalidPipelines: ReadonlyMap<string, string>,
  options: WorkflowGraphValidationOptions,
  errors: WorkflowFieldError[]
): ReadonlyMap<string, ResolvedNode> {
  const byPipelineId = new Map(effectivePipelines.map((entry) => [entry.pipelineId, entry]));
  const byPhaseId = new Map((options.effectivePhases ?? []).map((entry) => [entry.phaseId, entry]));
  const byWorkflowId = new Map((options.effectiveWorkflows ?? []).map((entry) => [entry.workflowId, entry]));
  const resolved = new Map<string, ResolvedNode>();

  const hasUnifiedNodes = definition.nodes.some(
    (n) => n.kind === 'phase' || n.kind === 'workflow' || n.phaseId !== undefined || n.workflowId !== undefined
  );

  if (hasUnifiedNodes) {
    const closure = resolveWorkflowClosure(definition, options);
    errors.push(...closure.errors);
  }

  definition.nodes.forEach((node, index) => {
    let pipeline: PipelineDefinition | null = null;
    let phase: PhaseDefinition | null = null;
    let workflow: WorkflowDefinition | null = null;
    let target: PortBearingTarget | null = null;

    if (node.kind === 'phase' || (node.kind === undefined && node.phaseId !== undefined)) {
      if (node.phaseId !== undefined) {
        phase = byPhaseId.get(node.phaseId) ?? null;
        if (phase) {
          target = { kind: 'phase', id: phase.phaseId, inputs: [], outputs: [] };
        }
      }
    } else if (node.kind === 'workflow' || node.workflowId !== undefined) {
      if (node.workflowId !== undefined && node.workflowId !== definition.workflowId) {
        workflow = byWorkflowId.get(node.workflowId) ?? null;
        if (workflow) {
          target = {
            kind: 'workflow',
            id: workflow.workflowId,
            inputs: workflow.inputs ?? [],
            outputs: workflow.outputs ?? []
          };
        }
      }
    } else if (node.pipelineId !== undefined) {
      pipeline = byPipelineId.get(node.pipelineId) ?? null;
      const cause = invalidPipelines.get(node.pipelineId);
      if (!pipeline && cause !== undefined) {
        errors.push(
          error(definition, `nodes[${index}].pipelineId`, 'pipeline-invalid', `Pipeline '${node.pipelineId}' is invalid: ${cause}`)
        );
      } else if (!pipeline) {
        errors.push(
          error(definition, `nodes[${index}].pipelineId`, 'unknown-pipeline', `Pipeline '${node.pipelineId}' is not in the effective catalog`)
        );
      } else {
        target = {
          kind: 'pipeline',
          id: pipeline.pipelineId,
          inputs: pipeline.inputs,
          outputs: pipeline.outputs
        };
      }
    }

    if (!resolved.has(node.nodeId)) {
      resolved.set(node.nodeId, { node, index, pipeline, phase, workflow, target });
    }
  });
  return resolved;
}

function validateConnections(context: GraphContext): void {
  const defaultsBySource = new Set<string>();
  context.definition.connections.forEach((connection, index) => {
    const from = readEndpoint(context, connection, index, 'from');
    const to = readEndpoint(context, connection, index, 'to');
    countDefault(context, connection, index, defaultsBySource);
    if (!from || !to || from.type === null || to.type === null) return;
    validatePortPair(context, `connections[${index}]`, connection.selection, from.type, to.type);
  });
}

type EndpointSide = 'from' | 'to';

function readEndpoint(
  context: GraphContext,
  connection: WorkflowConnection,
  index: number,
  side: EndpointSide
): { readonly type: PipelineOutputPortType | PipelineInputPortType | null } | null {
  const endpoint = side === 'from' ? connection.from : connection.to;
  const field = `connections[${index}].${side}`;
  if (side === 'to' && isReturnEndpoint(connection.to, context.nodes)) {
    return { type: null };
  }
  const resolved = context.nodes.get(endpoint.nodeId);
  if (!resolved) {
    context.errors.push(
      error(context.definition, field, 'unresolved-endpoint', `Connection names node '${endpoint.nodeId}', which this Workflow does not declare`)
    );
    return null;
  }
  if (endpoint.portId === undefined) return { type: null };
  if (!resolved.target) return null;
  if (resolved.target.kind === 'phase') return { type: null };

  const ports = side === 'from' ? resolved.target.outputs : resolved.target.inputs;
  const port = ports.find((entry) => entry.portId === endpoint.portId);
  if (!port) {
    const kindLabel = resolved.target.kind === 'workflow' ? 'Workflow' : 'Pipeline';
    context.errors.push(
      error(
        context.definition,
        field,
        'unresolved-endpoint',
        `${kindLabel} '${resolved.target.id}' declares no ${side === 'from' ? 'output' : 'input'} port '${endpoint.portId}'`
      )
    );
    return null;
  }
  return { type: port.type };
}

function validatePortPair(
  context: GraphContext,
  fieldPrefix: string,
  selection: WorkflowConnection['selection'],
  fromType: PipelineOutputPortType | PipelineInputPortType,
  toType: PipelineOutputPortType | PipelineInputPortType
): void {
  const source = fromType as PipelineOutputPortType;
  const target = toType as PipelineInputPortType;
  const accepted = WORKFLOW_PORT_COMPATIBILITY[source] ?? [];
  if (!accepted.includes(target)) {
    context.errors.push(
      error(context.definition, fieldPrefix, 'incompatible-port-types', `Output type '${source}' is not accepted by input type '${target}'`)
    );
    return;
  }
  if (COLLECTION_OUTPUT_TYPES.has(source) && !COLLECTION_INPUT_TYPES.has(target) && selection === undefined) {
    context.errors.push(
      error(
        context.definition,
        `${fieldPrefix}.selection`,
        'selection-rule-required',
        `A '${source}' source feeding a single-valued '${target}' target requires a selection rule`
      )
    );
  }
}

function countDefault(
  context: GraphContext,
  connection: WorkflowConnection,
  index: number,
  seen: Set<string>
): void {
  if (connection.isDefault !== true) return;
  if (seen.has(connection.from.nodeId)) {
    context.errors.push(
      error(
        context.definition,
        `connections[${index}].isDefault`,
        'multiple-default-branches',
        `Node '${connection.from.nodeId}' declares more than one default outgoing connection`
      )
    );
    return;
  }
  seen.add(connection.from.nodeId);
}

function validateDuplicateInputBindings(context: GraphContext): void {
  const groups = new Map<string, number[]>();
  context.definition.connections.forEach((connection, index) => {
    if (connection.to.portId === undefined || isReturnEndpoint(connection.to, context.nodes)) return;
    const key = `${connection.to.nodeId}.${connection.to.portId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(index);
      return;
    }
    groups.set(key, [index]);
  });

  for (const [key, indices] of groups) {
    if (indices.length < 2) continue;
    context.errors.push(
      error(
        context.definition,
        `connections[${indices.at(0) ?? 0}].to`,
        'duplicate-input-binding',
        `Input port '${key}' is bound by connections ${indices.join(', ')}`
      )
    );
  }

  const bindingGroups = new Map<string, number[]>();
  (context.definition.bindings ?? []).forEach((binding, index) => {
    if (binding.kind !== 'input') return;
    const key = `${binding.nodeId}.${binding.inputKey}`;
    const existing = bindingGroups.get(key);
    if (existing) {
      existing.push(index);
      return;
    }
    bindingGroups.set(key, [index]);
  });

  for (const [key, indices] of bindingGroups) {
    if (indices.length < 2) continue;
    context.errors.push(
      error(
        context.definition,
        `bindings[${indices.at(0) ?? 0}].inputKey`,
        'duplicate-input-binding',
        `Input '${key}' is bound by bindings ${indices.join(', ')}`
      )
    );
  }
}

function validateCycles(context: GraphContext): boolean {
  const nodeIds = [...context.nodes.keys()];
  const { residual } = topologicalOrder(nodeIds, context.edges);
  if (residual.length === 0) return true;
  for (const component of stronglyConnectedComponents(residual, context.edges)) {
    const anchor = context.nodes.get(component.at(0) ?? '');
    context.errors.push(
      error(
        context.definition,
        `nodes[${anchor?.index ?? 0}].nodeId`,
        'graph-cycle',
        `Nodes form a cycle: ${[...component].sort().join(', ')}`
      )
    );
  }
  return false;
}

function validateReachability(context: GraphContext, acyclic: boolean): void {
  const starts = context.definition.startNodeIds.filter((nodeId) => context.nodes.has(nodeId));
  if (starts.length === 0) return;
  const reached = reachableFrom(starts, context.edges);
  for (const resolved of context.nodes.values()) {
    if (reached.has(resolved.node.nodeId)) continue;
    context.errors.push(
      error(
        context.definition,
        `nodes[${resolved.index}].nodeId`,
        'unreachable-node',
        `Node '${resolved.node.nodeId}' is not reachable from any allowed start`
      )
    );
  }

  if (!acyclic) return;
  const explicitReturns = context.definition.connections.filter((c) => isReturnEndpoint(c.to, context.nodes));
  if (explicitReturns.length > 0) {
    const anyReachableReturn = explicitReturns.some((c) => reached.has(c.from.nodeId));
    if (!anyReachableReturn) {
      context.errors.push(
        error(context.definition, 'connections', 'unreachable-return', 'No return transition is reachable from any allowed start node')
      );
    }
  }
}

function validateConditions(context: GraphContext, acyclic: boolean): void {
  const scopes = acyclic ? conditionScopes(context) : null;
  context.definition.connections.forEach((connection, index) => {
    const condition = connection.condition;
    if (condition === undefined) return;
    const field = `connections[${index}].condition`;
    const shapeDefect = conditionShapeDefect(condition);
    if (shapeDefect) {
      context.errors.push(error(context.definition, field, 'unsupported-condition', shapeDefect));
      return;
    }
    if (!validateRightOperand(context, condition, field)) {
      const fixed = fixedOutcomeDefect(condition);
      if (fixed !== null) {
        context.errors.push(error(context.definition, field, 'condition-comparison-unsupported', fixed));
      }
    }
    if (validateLeftOperand(context, condition, field)) {
      validateOperandScope(context, connection, condition, field, scopes);
    }
  });
}

function conditionScopes(context: GraphContext): ReadonlyMap<string, ReadonlySet<string>> {
  const { order } = topologicalOrder([...context.nodes.keys()], context.edges);
  const ancestors = ancestorSets(order, context.edges);
  const scopes = new Map<string, ReadonlySet<string>>();
  for (const [nodeId, set] of ancestors) {
    scopes.set(nodeId, new Set([...set, nodeId]));
  }
  return scopes;
}

function conditionShapeDefect(condition: unknown): string | null {
  if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
    return 'Condition must be structured data, not an expression';
  }
  const raw = condition as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'left' && key !== 'operator' && key !== 'right') {
      return `Unknown authored condition field '${key}'`;
    }
  }
  if (!isWorkflowConditionOperator(raw.operator)) {
    return 'Condition operator is not a member of the closed operator set';
  }
  const left = raw.left;
  if (typeof left !== 'object' || left === null || Array.isArray(left)) {
    return 'Condition left operand must be an object';
  }
  const operand = left as Record<string, unknown>;
  if (operand.source === 'node-status') {
    return typeof operand.nodeId === 'string' ? null : 'Operand node id must be a string';
  }
  if (operand.source === 'node-output') {
    return typeof operand.nodeId === 'string' && typeof operand.field === 'string'
      ? null
      : 'A node-output operand requires a string node id and field';
  }
  return "Condition operand source must be 'node-output' or 'node-status'";
}

function validateLeftOperand(
  context: GraphContext,
  condition: WorkflowCondition,
  field: string
): boolean {
  const resolved = context.nodes.get(condition.left.nodeId);
  if (!resolved) {
    context.errors.push(
      error(
        context.definition,
        `${field}.left`,
        'condition-operand-unknown',
        `Condition operand names node '${condition.left.nodeId}', which this Workflow does not declare`
      )
    );
    return false;
  }
  if (condition.left.source === 'node-status' || !resolved.target || resolved.target.kind === 'phase') {
    return true;
  }
  const structured = resolved.target.outputs.some((port) => STRUCTURED_OUTPUT_TYPES.has(port.type));
  if (!structured) {
    const kindLabel = resolved.target.kind === 'workflow' ? 'Workflow' : 'Pipeline';
    context.errors.push(
      error(
        context.definition,
        `${field}.left`,
        'condition-operand-unknown',
        `${kindLabel} '${resolved.target.id}' declares no structured output port to read a field from`
      )
    );
    return false;
  }
  return true;
}

function validateOperandScope(
  context: GraphContext,
  connection: WorkflowConnection,
  condition: WorkflowCondition,
  field: string,
  scopes: ReadonlyMap<string, ReadonlySet<string>> | null
): void {
  if (!scopes) return;
  const scope = scopes.get(connection.from.nodeId);
  if (scope?.has(condition.left.nodeId)) return;
  context.errors.push(
    error(
      context.definition,
      `${field}.left`,
      'condition-operand-not-ancestor',
      `Node '${condition.left.nodeId}' has not run when the branch out of '${connection.from.nodeId}' is evaluated`
    )
  );
}

function validateRightOperand(
  context: GraphContext,
  condition: WorkflowCondition,
  field: string
): boolean {
  const right = condition.right;
  const defect = rightOperandDefect(condition.operator, right);
  if (defect) {
    context.errors.push(error(context.definition, `${field}.right`, 'condition-right-invalid', defect));
    return true;
  }
  if (condition.left.source !== 'node-status' || right === undefined) return false;
  const values = Array.isArray(right) ? right : [right];
  if (values.every((value) => isWorkflowNodeTerminalStatus(value))) return false;
  context.errors.push(
    error(
      context.definition,
      `${field}.right`,
      'condition-right-invalid',
      `A node-status operand compares against ${WORKFLOW_NODE_TERMINAL_STATUSES.join(', ')} only`
    )
  );
  return true;
}

const ORDERING_OPERATORS: ReadonlySet<string> = new Set([
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
]);

const TEXT_OPERANDS_NOTE =
  "Workflow conditions compare text in v1 (a node status or an output's location reference)";

function nonTextKind(value: unknown): 'number' | 'boolean' | null {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
}

function fixedOutcomeDefect(condition: WorkflowCondition): string | null {
  const { operator, right } = condition;
  if (ORDERING_OPERATORS.has(operator)) {
    return `${TEXT_OPERANDS_NOTE}, so '${operator}' can never match and the default route would always be taken`;
  }
  if (operator === 'equals' || operator === 'notEquals') {
    const kind = nonTextKind(right);
    return kind === null
      ? null
      : `${TEXT_OPERANDS_NOTE}, so '${operator}' with a ${kind} can never match, and the default route would always be taken`;
  }
  if (operator === 'in' && Array.isArray(right)) {
    const kinds = new Set(right.map(nonTextKind).filter((kind) => kind !== null));
    if (kinds.size === 0) return null;
    const named = [...kinds].sort().join(' and ');
    return `${TEXT_OPERANDS_NOTE}, so a ${named} member of an 'in' list can never match`;
  }
  return null;
}

function rightOperandDefect(operator: string, right: unknown): string | null {
  if (operator === 'exists') {
    return right === undefined ? null : "The 'exists' operator takes no right operand";
  }
  if (operator === 'in') {
    return Array.isArray(right) && right.length > 0 && right.every(isLiteral)
      ? null
      : "The 'in' operator requires a non-empty array of literals";
  }
  return isLiteral(right) ? null : 'Right operand must be a string, number, or boolean literal';
}

function isLiteral(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function validateBindingsAndOutputs(context: GraphContext, acyclic: boolean): void {
  const { definition, nodes } = context;
  const bindings = definition.bindings ?? [];
  const declaredInputs = new Map((definition.inputs ?? []).map((p) => [p.portId, p]));
  const declaredOutputs = new Map((definition.outputs ?? []).map((p) => [p.portId, p]));

  const ancestors = acyclic
    ? ancestorSets(topologicalOrder([...nodes.keys()], context.edges).order, context.edges)
    : null;

  const boundChildInputs = new Set<string>();
  for (const conn of definition.connections) {
    if (conn.to.portId !== undefined && !isReturnEndpoint(conn.to, nodes)) {
      boundChildInputs.add(`${conn.to.nodeId}.${conn.to.portId}`);
    }
  }

  bindings.forEach((binding, index) => {
    const field = `bindings[${index}]`;
    const targetNode = nodes.get(binding.nodeId);
    if (!targetNode) {
      context.errors.push(
        error(definition, `${field}.nodeId`, 'unresolved-endpoint', `Binding names node '${binding.nodeId}', which this Workflow does not declare`)
      );
      return;
    }

    if (binding.kind === 'input') {
      validateInputBinding(context, binding, index, targetNode, declaredInputs, ancestors, boundChildInputs);
    } else {
      validateOutputBinding(context, binding, index, targetNode, declaredOutputs);
    }
  });

  for (const resolved of nodes.values()) {
    if (resolved.target?.kind !== 'workflow') continue;
    for (const inputPort of resolved.target.inputs) {
      if (inputPort.required === false) continue;
      if (!boundChildInputs.has(`${resolved.node.nodeId}.${inputPort.portId}`)) {
        context.errors.push(
          error(
            definition,
            `nodes[${resolved.index}].workflowId`,
            'missing-required-input',
            `Child Workflow '${resolved.target.id}' on node '${resolved.node.nodeId}' requires input port '${inputPort.portId}'`
          )
        );
      }
    }
  }

  if (acyclic && (definition.outputs ?? []).length > 0) {
    validateRequiredOutputsOnBranches(context);
  }
}

function validateInputBinding(
  context: GraphContext,
  binding: WorkflowInputBinding,
  index: number,
  targetNode: ResolvedNode,
  declaredInputs: ReadonlyMap<string, WorkflowInputPort>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>> | null,
  boundChildInputs: Set<string>
): void {
  const field = `bindings[${index}]`;
  boundChildInputs.add(`${binding.nodeId}.${binding.inputKey}`);

  let targetType: PipelineInputPortType | undefined = binding.type;
  if (targetNode.target && targetNode.target.kind !== 'phase') {
    const targetPort = targetNode.target.inputs.find((p) => p.portId === binding.inputKey);
    if (!targetPort) {
      const kindLabel = targetNode.target.kind === 'workflow' ? 'Workflow' : 'Pipeline';
      context.errors.push(
        error(context.definition, `${field}.inputKey`, 'unresolved-endpoint', `${kindLabel} '${targetNode.target.id}' declares no input port '${binding.inputKey}'`)
      );
      return;
    }
    targetType = targetPort.type;
  }

  if (binding.source.from === 'workflow-input') {
    const wfInput = declaredInputs.get(binding.source.portId);
    if (!wfInput) {
      context.errors.push(
        error(context.definition, `${field}.source.portId`, 'unresolved-endpoint', `Workflow '${context.definition.workflowId}' declares no input port '${binding.source.portId}'`)
      );
      return;
    }
    if (targetType !== undefined && wfInput.type !== targetType) {
      if (COLLECTION_INPUT_TYPES.has(wfInput.type) && !COLLECTION_INPUT_TYPES.has(targetType)) {
        if (binding.selection === undefined) {
          context.errors.push(
            error(context.definition, `${field}.selection`, 'selection-rule-required', `A '${wfInput.type}' workflow input feeding a single-valued '${targetType}' target requires a selection rule`)
          );
        }
      } else {
        context.errors.push(
          error(context.definition, field, 'incompatible-port-types', `Workflow input type '${wfInput.type}' is not accepted by input type '${targetType}'`)
        );
      }
    }
    return;
  }

  const sourceNode = context.nodes.get(binding.source.nodeId);
  if (!sourceNode) {
    context.errors.push(
      error(context.definition, `${field}.source.nodeId`, 'unresolved-endpoint', `Binding source names node '${binding.source.nodeId}', which this Workflow does not declare`)
    );
    return;
  }

  if (ancestors !== null) {
    const nodeAncestors = ancestors.get(binding.nodeId);
    if (!nodeAncestors?.has(binding.source.nodeId)) {
      context.errors.push(
        error(context.definition, `${field}.source.nodeId`, 'binding-source-not-ancestor', `Binding source node '${binding.source.nodeId}' is not a guaranteed execution ancestor of '${binding.nodeId}'`)
      );
    }
  }

  if (sourceNode.target && sourceNode.target.kind !== 'phase') {
    const sourcePort = sourceNode.target.outputs.find((p) => p.portId === binding.source.portId);
    if (!sourcePort) {
      const kindLabel = sourceNode.target.kind === 'workflow' ? 'Workflow' : 'Pipeline';
      context.errors.push(
        error(context.definition, `${field}.source.portId`, 'unresolved-endpoint', `${kindLabel} '${sourceNode.target.id}' declares no output port '${binding.source.portId}'`)
      );
      return;
    }
    if (targetType !== undefined) {
      validatePortPair(context, field, binding.selection, sourcePort.type, targetType);
    }
  }
}

function validateOutputBinding(
  context: GraphContext,
  binding: WorkflowOutputBinding,
  index: number,
  sourceNode: ResolvedNode,
  declaredOutputs: ReadonlyMap<string, WorkflowOutputPort>
): void {
  const field = `bindings[${index}]`;
  const declared = declaredOutputs.get(binding.portId);
  if ((context.definition.outputs ?? []).length > 0 && !declared) {
    context.errors.push(
      error(context.definition, `${field}.portId`, 'unresolved-endpoint', `Workflow '${context.definition.workflowId}' declares no output port '${binding.portId}'`)
    );
    return;
  }

  if (sourceNode.target && sourceNode.target.kind !== 'phase') {
    const sourcePortId = binding.sourcePortId ?? binding.outputKey ?? binding.portId;
    const sourcePort = sourceNode.target.outputs.find((p) => p.portId === sourcePortId);
    if (!sourcePort) {
      const kindLabel = sourceNode.target.kind === 'workflow' ? 'Workflow' : 'Pipeline';
      context.errors.push(
        error(context.definition, `${field}.portId`, 'unresolved-endpoint', `${kindLabel} '${sourceNode.target.id}' declares no output port '${sourcePortId}'`)
      );
      return;
    }
    if (declared && sourcePort.type !== declared.type) {
      context.errors.push(
        error(context.definition, field, 'incompatible-port-types', `Node output type '${sourcePort.type}' does not match declared Workflow output type '${declared.type}'`)
      );
    }
  } else if (declared && binding.type !== undefined && binding.type !== declared.type) {
    context.errors.push(
      error(context.definition, field, 'incompatible-port-types', `Binding output type '${binding.type}' does not match declared Workflow output type '${declared.type}'`)
    );
  }
}

function validateRequiredOutputsOnBranches(context: GraphContext): void {
  const { definition, nodes } = context;
  const outputs = definition.outputs ?? [];
  if (outputs.length === 0) return;

  const starts = definition.startNodeIds.filter((id) => nodes.has(id));
  if (starts.length === 0) return;

  const outgoingByNode = new Map<string, string[]>();
  const returnSources = new Set<string>();
  for (const nodeId of nodes.keys()) {
    outgoingByNode.set(nodeId, []);
  }
  for (const conn of definition.connections) {
    if (!nodes.has(conn.from.nodeId)) continue;
    if (isReturnEndpoint(conn.to, nodes)) {
      returnSources.add(conn.from.nodeId);
    } else if (nodes.has(conn.to.nodeId)) {
      outgoingByNode.get(conn.from.nodeId)?.push(conn.to.nodeId);
    }
  }

  const paths: ReadonlySet<string>[] = [];
  function walk(nodeId: string, visited: Set<string>): void {
    const nextVisited = new Set(visited);
    nextVisited.add(nodeId);
    const nextNodes = outgoingByNode.get(nodeId) ?? [];
    if (returnSources.has(nodeId) || nextNodes.length === 0) {
      paths.push(nextVisited);
    }
    for (const nextId of nextNodes) {
      if (!nextVisited.has(nextId)) {
        walk(nextId, nextVisited);
      }
    }
  }
  for (const startId of starts) {
    walk(startId, new Set());
  }

  if (paths.length === 0) return;

  const producersByOutput = new Map<string, Set<string>>();
  for (const binding of definition.bindings ?? []) {
    if (binding.kind !== 'output' || !nodes.has(binding.nodeId)) continue;
    const set = producersByOutput.get(binding.portId) ?? new Set<string>();
    set.add(binding.nodeId);
    producersByOutput.set(binding.portId, set);
  }

  outputs.forEach((output, outIndex) => {
    if (output.required === false) return;
    const producers = producersByOutput.get(output.portId);
    const coveredOnEveryBranch =
      producers !== undefined &&
      producers.size > 0 &&
      paths.every((path) => [...producers].some((producerId) => path.has(producerId)));
    if (!coveredOnEveryBranch) {
      context.errors.push(
        error(
          definition,
          `outputs[${outIndex}].portId`,
          'missing-required-output-on-branch',
          `Required Workflow output '${output.portId}' is not produced on every reachable return branch`
        )
      );
    }
  });
}

function error(
  definition: WorkflowDefinition,
  field: string,
  code: string,
  message: string
): WorkflowFieldError {
  return workflowFieldError(definition.workflowId, field, code, message);
}
