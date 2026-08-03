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
  type WorkflowNode
} from '../contracts/workflow-definitions';
import { workflowFieldError } from './workflow-definition-validator';
import {
  ancestorSets,
  reachableFrom,
  stronglyConnectedComponents,
  topologicalOrder,
  type WorkflowGraphEdge
} from './workflow-graph';

/**
 * Cross-reference validation for one Workflow against the resolved **effective** Pipeline
 * catalog. Pure: no `vscode` import, no configuration read, no mutation of its arguments.
 *
 * Every check accumulates (FR-019) — the pass never returns at the first defect, because an
 * operator repairing a graph one error per save round-trip is the failure mode this feature
 * exists to avoid. There is exactly one ordering dependency, documented at
 * {@link validateConditions}.
 */

/**
 * Frozen compatibility table (data-model §4). A fixed matrix, never an operator-authored
 * mapping: letting a definition declare its own coercions would make a portable Workflow
 * behave differently depending on which host opened it.
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

/** The collection-typed members of each union (FR-018). */
const COLLECTION_OUTPUT_TYPES: ReadonlySet<PipelineOutputPortType> = new Set(['file-set']);
const COLLECTION_INPUT_TYPES: ReadonlySet<PipelineInputPortType> = new Set(['source-list']);

/**
 * Output port types a `node-output` condition operand may read a field from (FR-022). These are
 * the two output types the compatibility table maps to the `pipeline-output` input type; the
 * data-model's shorthand "a `structured-data` or `pipeline-output` output port" names that
 * coupling from the input side, and `pipeline-output` is not itself a member of
 * `PipelineOutputPortType`.
 */
const STRUCTURED_OUTPUT_TYPES: ReadonlySet<PipelineOutputPortType> = new Set([
  'structured-data',
  'run-request'
]);

interface ResolvedNode {
  readonly node: WorkflowNode;
  readonly index: number;
  /** Null when the Pipeline is unknown or invalid; downstream port checks are then skipped. */
  readonly pipeline: PipelineDefinition | null;
}

interface GraphContext {
  readonly definition: WorkflowDefinition;
  readonly nodes: ReadonlyMap<string, ResolvedNode>;
  readonly edges: readonly WorkflowGraphEdge[];
  readonly errors: WorkflowFieldError[];
}

/**
 * @param definition       a Workflow that already passed `validateWorkflowDefinition`
 * @param effectivePipelines the resolved effective Pipeline catalog — the only layer a node may
 *                         bind against, mirroring the Pipeline-to-Phase rule
 * @param invalidPipelines `pipelineId` → short cause, for ids that resolved to an *invalid*
 *                         record rather than being absent. Without it an invalid Pipeline is
 *                         indistinguishable from a missing one and FR-017 could not name the
 *                         transitive cause.
 */
export function validateWorkflowGraph(
  definition: WorkflowDefinition,
  effectivePipelines: readonly PipelineDefinition[],
  invalidPipelines: ReadonlyMap<string, string> = new Map()
): readonly WorkflowFieldError[] {
  const errors: WorkflowFieldError[] = [];
  const nodes = resolveNodes(definition, effectivePipelines, invalidPipelines, errors);
  const edges = definition.connections
    .filter((c) => nodes.has(c.from.nodeId) && nodes.has(c.to.nodeId))
    .map((c) => ({ from: c.from.nodeId, to: c.to.nodeId }));
  const context: GraphContext = { definition, nodes, edges, errors };

  validateConnections(context);
  validateDuplicateInputBindings(context);
  const acyclic = validateCycles(context);
  validateReachability(context);
  validateConditions(context, acyclic);
  return errors;
}

function resolveNodes(
  definition: WorkflowDefinition,
  effectivePipelines: readonly PipelineDefinition[],
  invalidPipelines: ReadonlyMap<string, string>,
  errors: WorkflowFieldError[]
): ReadonlyMap<string, ResolvedNode> {
  const byPipelineId = new Map(effectivePipelines.map((entry) => [entry.pipelineId, entry]));
  const resolved = new Map<string, ResolvedNode>();

  definition.nodes.forEach((node, index) => {
    const pipeline = byPipelineId.get(node.pipelineId) ?? null;
    const cause = invalidPipelines.get(node.pipelineId);
    if (!pipeline && cause !== undefined) {
      errors.push(
        error(
          definition,
          `nodes[${index}].pipelineId`,
          'pipeline-invalid',
          `Pipeline '${node.pipelineId}' is invalid: ${cause}`
        )
      );
    } else if (!pipeline) {
      errors.push(
        error(
          definition,
          `nodes[${index}].pipelineId`,
          'unknown-pipeline',
          `Pipeline '${node.pipelineId}' is not in the effective catalog`
        )
      );
    }
    // A duplicate nodeId is the field pass's defect; keep the first occurrence so the graph
    // checks still run against a coherent node set.
    if (!resolved.has(node.nodeId)) {
      resolved.set(node.nodeId, { node, index, pipeline });
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
    if (!from || !to) {
      // Type compatibility on an endpoint that does not resolve would be a cascade, not a defect.
      return;
    }
    validatePortPair(context, connection, index, from.type, to.type);
  });
}

type EndpointSide = 'from' | 'to';

function readEndpoint(
  context: GraphContext,
  connection: WorkflowConnection,
  index: number,
  side: EndpointSide
): { readonly type: PipelineOutputPortType | PipelineInputPortType } | null {
  const endpoint = side === 'from' ? connection.from : connection.to;
  const field = `connections[${index}].${side}`;
  const resolved = context.nodes.get(endpoint.nodeId);
  if (!resolved) {
    context.errors.push(
      error(
        context.definition,
        field,
        'unresolved-endpoint',
        `Connection names node '${endpoint.nodeId}', which this Workflow does not declare`
      )
    );
    return null;
  }
  if (!resolved.pipeline) {
    // The unknown/invalid Pipeline is already reported against the node.
    return null;
  }
  const ports = side === 'from' ? resolved.pipeline.outputs : resolved.pipeline.inputs;
  const port = ports.find((entry) => entry.portId === endpoint.portId);
  if (!port) {
    context.errors.push(
      error(
        context.definition,
        field,
        'unresolved-endpoint',
        `Pipeline '${resolved.pipeline.pipelineId}' declares no ${side === 'from' ? 'output' : 'input'} port '${endpoint.portId}'`
      )
    );
    return null;
  }
  return { type: port.type };
}

function validatePortPair(
  context: GraphContext,
  connection: WorkflowConnection,
  index: number,
  fromType: PipelineOutputPortType | PipelineInputPortType,
  toType: PipelineOutputPortType | PipelineInputPortType
): void {
  const source = fromType as PipelineOutputPortType;
  const target = toType as PipelineInputPortType;
  const accepted = WORKFLOW_PORT_COMPATIBILITY[source] ?? [];
  if (!accepted.includes(target)) {
    context.errors.push(
      error(
        context.definition,
        `connections[${index}]`,
        'incompatible-port-types',
        `Output type '${source}' is not accepted by input type '${target}'`
      )
    );
    return;
  }
  if (
    COLLECTION_OUTPUT_TYPES.has(source) &&
    !COLLECTION_INPUT_TYPES.has(target) &&
    connection.selection === undefined
  ) {
    context.errors.push(
      error(
        context.definition,
        `connections[${index}].selection`,
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
  if (connection.isDefault !== true) {
    return;
  }
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

/** FR-010a: an input port accepts one producer, so two connections into it is a defect. */
function validateDuplicateInputBindings(context: GraphContext): void {
  const groups = new Map<string, number[]>();
  context.definition.connections.forEach((connection, index) => {
    const key = `${connection.to.nodeId}.${connection.to.portId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(index);
      return;
    }
    groups.set(key, [index]);
  });

  for (const [key, indices] of groups) {
    if (indices.length < 2) {
      continue;
    }
    context.errors.push(
      error(
        context.definition,
        `connections[${indices[0]}].to`,
        'duplicate-input-binding',
        `Input port '${key}' is bound by connections ${indices.join(', ')}`
      )
    );
  }
}

/** @returns true when the graph is acyclic, which is the precondition for ancestry. */
function validateCycles(context: GraphContext): boolean {
  const nodeIds = [...context.nodes.keys()];
  const { residual } = topologicalOrder(nodeIds, context.edges);
  if (residual.length === 0) {
    return true;
  }
  for (const component of stronglyConnectedComponents(residual, context.edges)) {
    const anchor = context.nodes.get(component[0]);
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

function validateReachability(context: GraphContext): void {
  const starts = context.definition.startNodeIds.filter((nodeId) => context.nodes.has(nodeId));
  if (starts.length === 0) {
    // An empty or entirely unresolvable start set is `invalid-start-set` from the field pass;
    // calling every node unreachable on top of it would bury the real defect.
    return;
  }
  const reached = reachableFrom(starts, context.edges);
  for (const resolved of context.nodes.values()) {
    if (reached.has(resolved.node.nodeId)) {
      continue;
    }
    context.errors.push(
      error(
        context.definition,
        `nodes[${resolved.index}].nodeId`,
        'unreachable-node',
        `Node '${resolved.node.nodeId}' is not reachable from any allowed start`
      )
    );
  }
}

/**
 * Condition validation (FR-020 – FR-024). No parser, no evaluator, no sandbox: a condition is
 * structured data, so the checks below are shape and catalog lookups.
 *
 * `acyclic` is the pass's single ordering dependency (research R11). Ancestry is undefined while
 * a cycle exists, so the FR-023 scope check is skipped rather than guessed — every other
 * condition check is graph-independent and still runs.
 */
function validateConditions(context: GraphContext, acyclic: boolean): void {
  const scopes = acyclic ? conditionScopes(context) : null;
  context.definition.connections.forEach((connection, index) => {
    const condition = connection.condition;
    if (condition === undefined) {
      return;
    }
    const field = `connections[${index}].condition`;
    const shapeDefect = conditionShapeDefect(condition);
    if (shapeDefect) {
      // Shape rejection precedes content inspection (FR-021).
      context.errors.push(error(context.definition, field, 'unsupported-condition', shapeDefect));
      return;
    }
    validateRightOperand(context, condition, field);
    if (validateLeftOperand(context, condition, field)) {
      validateOperandScope(context, connection, condition, field, scopes);
    }
  });
}

/** `anc[v] ∪ {v}`: the branching node's own result exists when its outgoing branch is chosen. */
function conditionScopes(context: GraphContext): ReadonlyMap<string, ReadonlySet<string>> {
  const { order } = topologicalOrder([...context.nodes.keys()], context.edges);
  const ancestors = ancestorSets(order, context.edges);
  const scopes = new Map<string, ReadonlySet<string>>();
  for (const [nodeId, set] of ancestors) {
    scopes.set(nodeId, new Set([...set, nodeId]));
  }
  return scopes;
}

/**
 * Second-boundary shape guard. `validateWorkflowDefinition` rejects these shapes first, but a
 * caller that builds a `WorkflowDefinition` directly — the YAML exchange importers of
 * FR-R2-005 and FR-R2-006 will — must not be able to slip an expression string past this layer.
 */
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

/** @returns true when the operand resolved, so the scope check is still worth performing. */
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
  if (condition.left.source === 'node-status') {
    return true;
  }
  if (!resolved.pipeline) {
    // The unknown or invalid Pipeline is already reported against the node. Ancestry does not
    // depend on it, so the scope check below is still worth performing.
    return true;
  }
  const structured = resolved.pipeline.outputs.some((port) => STRUCTURED_OUTPUT_TYPES.has(port.type));
  if (!structured) {
    context.errors.push(
      error(
        context.definition,
        `${field}.left`,
        'condition-operand-unknown',
        `Pipeline '${resolved.pipeline.pipelineId}' declares no structured output port to read a field from`
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
  if (!scopes) {
    return;
  }
  const scope = scopes.get(connection.from.nodeId);
  if (scope?.has(condition.left.nodeId)) {
    return;
  }
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
): void {
  const right = condition.right;
  const defect = rightOperandDefect(condition.operator, right);
  if (defect) {
    context.errors.push(
      error(context.definition, `${field}.right`, 'condition-right-invalid', defect)
    );
    return;
  }
  if (condition.left.source !== 'node-status' || right === undefined) {
    return;
  }
  const values = Array.isArray(right) ? right : [right];
  if (values.every((value) => isWorkflowNodeTerminalStatus(value))) {
    return;
  }
  context.errors.push(
    error(
      context.definition,
      `${field}.right`,
      'condition-right-invalid',
      `A node-status operand compares against ${WORKFLOW_NODE_TERMINAL_STATUSES.join(', ')} only`
    )
  );
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

function error(
  definition: WorkflowDefinition,
  field: string,
  code: string,
  message: string
): WorkflowFieldError {
  return workflowFieldError(definition.workflowId, field, code, message);
}
