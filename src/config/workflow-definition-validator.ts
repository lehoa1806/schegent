import {
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES,
  isPipelineInputPortType,
  isPipelineOutputPortType,
  type PipelineExecutionDefaults
} from '../contracts/pipeline-definitions';
import { PHASE_EFFORT_LEVELS } from '../contracts/process-definitions';
import { SUPPORTED_BACKENDS } from '../contracts/backend-kinds';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_HANDOFF_MODES,
  WORKFLOW_ID_MAX_LEN,
  WORKFLOW_NODE_KINDS,
  isWorkflowConditionOperator,
  isWorkflowHandoffMode,
  isWorkflowNodeKind,
  isWorkflowSelectionRule,
  type WorkflowBinding,
  type WorkflowCondition,
  type WorkflowConditionLiteral,
  type WorkflowConditionOperand,
  type WorkflowConnection,
  type WorkflowConnectionEndpoint,
  type WorkflowDefinition,
  type WorkflowFieldError,
  type WorkflowHandoffMode,
  type WorkflowInputBinding,
  type WorkflowInputBindingSource,
  type WorkflowInputPort,
  type WorkflowNode,
  type WorkflowNodeControl,
  type WorkflowNodeKind,
  type WorkflowOutputBinding,
  type WorkflowOutputPort,
  type WorkflowSelectionRule,
  type CandidateBlockControl,
  type WorkflowDecisionResults
} from '../contracts/workflow-definitions';
import {
  isTypedConditionCandidate,
  validateTypedCondition,
  type TypedCondition
} from '../contracts/decision-results';
import {
  validateCandidateBlockControl, validateCandidateBlockGraphStructure,
  validateWorkflowDecisionResults, validateWorkflowNodeControl
} from './workflow-control-validator';
import { readConnectionContextPolicy } from './workflow-handoff-policy-validator';
import {
  AUTHORED_EXECUTION_DEFAULT_FIELDS,
  PIPELINE_ID_PATTERN,
  PIPELINE_TIMEOUT_MAX,
  PIPELINE_TIMEOUT_MIN
} from './pipeline-definition-validator';
import { recognizedAuthoredDisplay } from './authored-display';

/**
 * Field, identity, and shape validation for one authored Workflow row. Cross-reference
 * resolution — Phase/Workflow/Pipeline existence, port endpoints, port-type compatibility,
 * cycles, reachability, condition ancestry, and closure limits — is a separate pass in
 * `workflow-graph-validator.ts`.
 */

export { WORKFLOW_ID_MAX_LEN };
export const WORKFLOW_NAME_MAX_LEN = 80;
export const WORKFLOW_DESCRIPTION_MAX_LEN = 1024;
export const WORKFLOW_LABEL_MAX_LEN = 80;
export const WORKFLOW_ERROR_FIELD_MAX = 48;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 512;

export const AUTHORED_WORKFLOW_FIELDS: ReadonlySet<string> = new Set([
  'id', 'workflowId', 'name', 'description', 'version', 'inputs', 'outputs',
  'nodes', 'connections', 'bindings', 'startNodeIds', 'executionDefaults', 'recommendedNext',
  'control', 'decisionResults'
]);

/** Closed set of fields a Workflow node may carry (feature 254, FR-042, V3; compared with `WORKFLOW_NODE_KEY_ORDER`). */
export const AUTHORED_NODE_FIELDS: ReadonlySet<string> = new Set(['nodeId', 'kind', 'phaseId', 'workflowId', 'label', 'control']);
const AUTHORED_CONNECTION_FIELDS: ReadonlySet<string> = new Set(['from', 'to', 'handoff', 'condition', 'priority', 'isDefault', 'selection', 'contextPolicy']);
const AUTHORED_ENDPOINT_FIELDS: ReadonlySet<string> = new Set(['nodeId', 'portId', 'kind']);
const AUTHORED_CONDITION_FIELDS: ReadonlySet<string> = new Set(['left', 'operator', 'right']);
const AUTHORED_PORT_FIELDS: ReadonlySet<string> = new Set(['portId', 'label', 'type', 'required', 'description']);
const AUTHORED_BINDING_FIELDS: ReadonlySet<string> = new Set([
  'kind', 'nodeId', 'inputKey', 'portId', 'outputKey', 'sourcePortId', 'type', 'required', 'label', 'source', 'selection', 'phaseIndex'
]);

export interface WorkflowDefinitionValidationResult {
  readonly ok: boolean;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly unrecognized: Readonly<Record<string, unknown>>;
  readonly errors: readonly WorkflowFieldError[];
}

export interface WorkflowDefinitionValidationOptions {
  readonly allowLegacyId?: boolean;
  /** Read a node `pipelineId` and a binding `outputKey`. Default false: refused (feature 285). */
  readonly allowLegacyPipelineId?: boolean;
  readonly defaultVersion?: number;
}

const LEGACY_PIPELINE_FIELD = { code: 'legacy-pipeline-field', pipelineId: "Retired Pipeline field 'pipelineId': a Workflow node references a Phase with 'phaseId' or a child Workflow with 'workflowId'", outputKey: "Retired Pipeline field 'outputKey': a binding source names its port with 'portId'" } as const;

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function fieldError(workflowId: string, field: string, code: string, message: string): WorkflowFieldError {
  return Object.freeze({
    workflowId: bounded(workflowId || '?', WORKFLOW_ID_MAX_LEN),
    field: bounded(field, WORKFLOW_ERROR_FIELD_MAX),
    code: bounded(code, ERROR_CODE_MAX),
    message: bounded(message, ERROR_MESSAGE_MAX)
  });
}

export const workflowFieldError = fieldError;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectRequiredResult(): WorkflowDefinitionValidationResult {
  return {
    ok: false, workflowId: '?', definition: null,
    display: Object.freeze({}), unrecognized: Object.freeze({}),
    errors: Object.freeze([fieldError('?', 'entry', 'object-required', 'Workflow entry must be an object')])
  };
}

function recognizedDisplay(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return recognizedAuthoredDisplay(raw, AUTHORED_WORKFLOW_FIELDS);
}

function unrecognizedFields(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_WORKFLOW_FIELDS.has(key) && key !== 'derivedInputs' && key !== 'derivedOutputs') kept[key] = raw[key];
  }
  return Object.freeze(kept);
}

function readIdentifier(raw: unknown, workflowId: string, field: string, label: string, errors: WorkflowFieldError[]): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!PIPELINE_ID_PATTERN.test(value)) {
    errors.push(fieldError(workflowId, field, 'invalid-pattern', `${label} must match ${PIPELINE_ID_PATTERN.source}`));
    return null;
  }
  return value;
}

function readPorts<TType extends string>(
  rawList: unknown,
  fieldKey: 'inputs' | 'outputs',
  labelPrefix: 'Input' | 'Output',
  allowedTypes: readonly TType[],
  isTypeGuard: (value: unknown) => value is TType,
  workflowId: string,
  errors: WorkflowFieldError[]
): readonly { readonly portId: string; readonly label: string; readonly type: TType; readonly required?: boolean; readonly description?: string }[] | undefined {
  if (rawList === undefined) return undefined;
  if (!Array.isArray(rawList)) {
    errors.push(fieldError(workflowId, fieldKey, 'array-required', `Workflow ${fieldKey} must be an array`));
    return [];
  }
  const seen = new Set<string>();
  const ports: { readonly portId: string; readonly label: string; readonly type: TType; readonly required?: boolean; readonly description?: string }[] = [];
  rawList.forEach((raw, index) => {
    const base = `${fieldKey}[${index}]`;
    if (!isPlainObject(raw)) {
      errors.push(fieldError(workflowId, base, 'object-required', `${labelPrefix} port must be an object`));
      return;
    }
    let ok = true;
    for (const key of Object.keys(raw)) {
      if (!AUTHORED_PORT_FIELDS.has(key)) {
        errors.push(fieldError(workflowId, `${base}.${key}`, 'unknown-field', `Unknown authored ${labelPrefix.toLowerCase()} port field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
        ok = false;
      }
    }
    const portId = readIdentifier(raw.portId, workflowId, `${base}.portId`, `${labelPrefix} port id`, errors);
    if (portId !== null) {
      if (seen.has(portId)) {
        errors.push(fieldError(workflowId, `${base}.portId`, 'duplicate-port-id', `${labelPrefix} port id '${bounded(portId, WORKFLOW_ID_MAX_LEN)}' is declared more than once`));
        ok = false;
      } else {
        seen.add(portId);
      }
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (label.length === 0 || label.length > WORKFLOW_LABEL_MAX_LEN) {
      errors.push(fieldError(workflowId, `${base}.label`, 'invalid-length', `${labelPrefix} port label must contain 1 to ${WORKFLOW_LABEL_MAX_LEN} characters`));
      ok = false;
    }
    if (!isTypeGuard(raw.type)) {
      errors.push(fieldError(workflowId, `${base}.type`, 'invalid-enum', `${labelPrefix} port type must be one of ${allowedTypes.join(', ')}`));
      ok = false;
    }
    let required: boolean | undefined;
    if (raw.required !== undefined) {
      if (typeof raw.required !== 'boolean') {
        errors.push(fieldError(workflowId, `${base}.required`, 'boolean-required', `${labelPrefix} port required flag must be boolean`));
        ok = false;
      } else {
        required = raw.required;
      }
    }
    let description: string | undefined;
    if (raw.description !== undefined) {
      if (typeof raw.description !== 'string' || raw.description.length > WORKFLOW_DESCRIPTION_MAX_LEN) {
        errors.push(fieldError(workflowId, `${base}.description`, 'invalid-length', `${labelPrefix} port description must be at most ${WORKFLOW_DESCRIPTION_MAX_LEN} characters`));
        ok = false;
      } else {
        description = raw.description;
      }
    }
    if (!ok || portId === null || !isTypeGuard(raw.type)) return;
    ports.push(
      Object.freeze({
        portId,
        label,
        type: raw.type,
        ...(required !== undefined ? { required } : {}),
        ...(description !== undefined ? { description } : {})
      })
    );
  });
  return ports;
}

function readInputPorts(value: Record<string, unknown>, workflowId: string, errors: WorkflowFieldError[]): readonly WorkflowInputPort[] | undefined {
  return readPorts(value.inputs, 'inputs', 'Input', PIPELINE_INPUT_PORT_TYPES, isPipelineInputPortType, workflowId, errors);
}

function readOutputPorts(value: Record<string, unknown>, workflowId: string, errors: WorkflowFieldError[]): readonly WorkflowOutputPort[] | undefined {
  return readPorts(value.outputs, 'outputs', 'Output', PIPELINE_OUTPUT_PORT_TYPES, isPipelineOutputPortType, workflowId, errors);
}

function readNodes(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[],
  allowLegacyPipelineId = false
): readonly WorkflowNode[] {
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    errors.push(fieldError(workflowId, 'nodes', 'non-empty-required', 'Workflow nodes must be a non-empty array'));
    return [];
  }

  const seen = new Set<string>();
  const nodes: WorkflowNode[] = [];
  value.nodes.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(fieldError(workflowId, `nodes[${index}]`, 'object-required', 'Node entry must be an object'));
      return;
    }
    let unknownNodeField = false;
    for (const key of Object.keys(raw)) {
      if (key === 'pipelineId' ? !allowLegacyPipelineId : !AUTHORED_NODE_FIELDS.has(key)) {
        errors.push(key === 'pipelineId' ? fieldError(workflowId, `nodes[${index}].pipelineId`, LEGACY_PIPELINE_FIELD.code, LEGACY_PIPELINE_FIELD.pipelineId) : fieldError(workflowId, `nodes[${index}].${key}`, 'unknown-field', `Unknown authored node field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
        unknownNodeField = true;
      }
    }

    const nodeId = readIdentifier(raw.nodeId, workflowId, `nodes[${index}].nodeId`, 'Node id', errors);

    let kind: WorkflowNodeKind | undefined;
    if (raw.kind !== undefined) {
      if (!isWorkflowNodeKind(raw.kind)) {
        errors.push(fieldError(workflowId, `nodes[${index}].kind`, 'invalid-enum', `Node kind must be one of ${WORKFLOW_NODE_KINDS.join(', ')}`));
      } else {
        kind = raw.kind;
      }
    }

    const hasPhaseId = raw.phaseId !== undefined;
    const hasWorkflowId = raw.workflowId !== undefined;
    const hasPipelineId = allowLegacyPipelineId && raw.pipelineId !== undefined;
    const targetCount = Number(hasPhaseId) + Number(hasWorkflowId) + Number(hasPipelineId);

    if (targetCount > 1) {
      errors.push(fieldError(workflowId, `nodes[${index}]`, 'ambiguous-node-target', 'Node must reference exactly one target (phaseId or workflowId), not multiple targets'));
    }

    let phaseId: string | null = null;
    let targetWorkflowId: string | null = null;
    let pipelineId: string | null = null;

    if (kind === 'phase' || (kind === undefined && hasPhaseId && !hasWorkflowId)) {
      if (hasWorkflowId) {
        errors.push(fieldError(workflowId, `nodes[${index}].workflowId`, 'ambiguous-node-target', "Phase node cannot declare 'workflowId'"));
      }
      phaseId = readIdentifier(raw.phaseId, workflowId, `nodes[${index}].phaseId`, 'Node phaseId', errors);
      kind = 'phase';
    } else if (kind === 'workflow' || (hasWorkflowId && !hasPhaseId)) {
      if (hasPhaseId) {
        errors.push(fieldError(workflowId, `nodes[${index}].phaseId`, 'ambiguous-node-target', "Workflow node cannot declare 'phaseId'"));
      }
      targetWorkflowId = readIdentifier(raw.workflowId, workflowId, `nodes[${index}].workflowId`, 'Node workflowId', errors);
      kind = 'workflow';
    } else if (hasPipelineId) {
      // Feature 285: a node with no target at all is `missing-node-target` in both modes.
      pipelineId = readIdentifier(raw.pipelineId, workflowId, `nodes[${index}].pipelineId`, 'Node pipelineId', errors);
    } else if (!unknownNodeField && raw.kind === undefined) {
      errors.push(fieldError(workflowId, `nodes[${index}]`, 'missing-node-target', 'Node must reference a phaseId or workflowId'));
    }

    let label: string | undefined;
    if (raw.label !== undefined) {
      if (typeof raw.label !== 'string' || raw.label.trim().length === 0 || raw.label.length > WORKFLOW_LABEL_MAX_LEN) {
        errors.push(fieldError(workflowId, `nodes[${index}].label`, 'invalid-length', `Node label must contain 1 to ${WORKFLOW_LABEL_MAX_LEN} characters`));
      } else {
        label = raw.label.trim();
      }
    }

    let nodeControl: WorkflowNodeControl | undefined;
    let nodeControlOk = true;
    if (raw.control !== undefined) {
      if (kind !== 'workflow') {
        errors.push(fieldError(workflowId, `nodes[${index}].control`, 'control-requires-workflow-node', 'Repeat and ForEach controls are allowed only on child-Workflow nodes'));
        nodeControlOk = false;
      } else {
        const parsedControl = validateWorkflowNodeControl(raw.control, workflowId, `nodes[${index}].control`);
        if (!parsedControl.ok || parsedControl.value === null) {
          errors.push(...parsedControl.errors);
          nodeControlOk = false;
        } else {
          nodeControl = parsedControl.value;
        }
      }
    }

    if (nodeId !== null) {
      if (seen.has(nodeId)) {
        errors.push(fieldError(workflowId, `nodes[${index}].nodeId`, 'duplicate-node-id', `Node id '${bounded(nodeId, WORKFLOW_ID_MAX_LEN)}' is declared more than once`));
      } else {
        seen.add(nodeId);
      }
    }

    const hasValidTarget =
      !unknownNodeField &&
      nodeControlOk &&
      targetCount <= 1 &&
      (phaseId !== null || targetWorkflowId !== null || pipelineId !== null);
    if (nodeId === null || !hasValidTarget) return;

    nodes.push(
      Object.freeze({
        nodeId,
        ...(raw.kind !== undefined && kind !== undefined ? { kind } : {}),
        ...(phaseId !== null ? { phaseId } : {}),
        ...(targetWorkflowId !== null ? { workflowId: targetWorkflowId } : {}),
        ...(pipelineId !== null ? { pipelineId } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(nodeControl !== undefined ? { control: nodeControl } : {})
      })
    );
  });
  return nodes;
}

function readEndpoint(
  raw: unknown,
  workflowId: string,
  field: string,
  side: 'from' | 'to',
  errors: WorkflowFieldError[]
): WorkflowConnectionEndpoint | null {
  if (!isPlainObject(raw)) {
    errors.push(fieldError(workflowId, field, 'object-required', 'Endpoint must be an object'));
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_ENDPOINT_FIELDS.has(key)) {
      errors.push(fieldError(workflowId, `${field}.${key}`, 'unknown-field', `Unknown authored endpoint field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
    }
  }

  let kind: 'node' | 'return' | undefined;
  if (raw.kind !== undefined) {
    if (side === 'from' || (raw.kind !== 'node' && raw.kind !== 'return')) {
      errors.push(
        fieldError(
          workflowId,
          `${field}.kind`,
          'invalid-enum',
          side === 'from' ? "Source endpoint cannot declare 'kind'" : "Target endpoint kind must be 'node' or 'return'"
        )
      );
      return null;
    }
    kind = raw.kind;
  }

  const nodeId =
    kind === 'return' && raw.nodeId === undefined
      ? 'return'
      : readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Endpoint node id', errors);

  let portId: string | undefined;
  if (raw.portId !== undefined) {
    const parsedPort = readIdentifier(raw.portId, workflowId, `${field}.portId`, 'Endpoint port id', errors);
    if (parsedPort === null) return null;
    portId = parsedPort;
  }

  if (nodeId === null) return null;
  return Object.freeze({
    nodeId,
    ...(portId !== undefined ? { portId } : {}),
    ...(kind !== undefined ? { kind } : {})
  });
}

function isConditionLiteral(value: unknown): value is WorkflowConditionLiteral {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function readOperand(
  raw: unknown,
  workflowId: string,
  field: string,
  errors: WorkflowFieldError[]
): WorkflowConditionOperand | null {
  if (!isPlainObject(raw)) {
    errors.push(fieldError(workflowId, field, 'unsupported-condition', 'Condition operand must be an object'));
    return null;
  }
  if (raw.source === 'node-status') {
    for (const key of Object.keys(raw)) {
      if (key !== 'source' && key !== 'nodeId') {
        errors.push(fieldError(workflowId, `${field}.${key}`, 'unsupported-condition', 'A node-status operand accepts only source and nodeId'));
        return null;
      }
    }
    const nodeId = readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Operand node id', errors);
    return nodeId === null ? null : Object.freeze({ source: 'node-status', nodeId });
  }
  if (raw.source === 'node-output') {
    for (const key of Object.keys(raw)) {
      if (key !== 'source' && key !== 'nodeId' && key !== 'field') {
        errors.push(fieldError(workflowId, `${field}.${key}`, 'unsupported-condition', 'A node-output operand accepts only source, nodeId, and field'));
        return null;
      }
    }
    const nodeId = readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Operand node id', errors);
    const fieldName = typeof raw.field === 'string' ? raw.field.trim() : '';
    if (!isWellFormedFieldPath(fieldName)) {
      errors.push(fieldError(workflowId, `${field}.field`, 'condition-operand-unknown', 'Operand field must be dot-separated portable identifiers'));
      return null;
    }
    return nodeId === null ? null : Object.freeze({ source: 'node-output', nodeId, field: fieldName });
  }
  errors.push(fieldError(workflowId, `${field}.source`, 'condition-operand-unknown', "Condition operand source must be 'node-output' or 'node-status'"));
  return null;
}

export function isWellFormedFieldPath(value: string): boolean {
  if (value.length === 0 || value.length > WORKFLOW_ID_MAX_LEN) return false;
  return value.split('.').every((segment) => PIPELINE_ID_PATTERN.test(segment));
}

function readCondition(
  raw: unknown,
  workflowId: string,
  field: string,
  errors: WorkflowFieldError[]
): WorkflowCondition | TypedCondition | null {
  if (!isPlainObject(raw)) {
    errors.push(fieldError(workflowId, field, 'unsupported-condition', 'Condition must be structured data, not an expression'));
    return null;
  }
  if (isTypedConditionCandidate(raw)) {
    const typed = validateTypedCondition(raw, field);
    if (!typed.ok) {
      for (const defect of typed.errors) {
        errors.push(fieldError(workflowId, defect.field, defect.code, defect.message));
      }
      return null;
    }
    return typed.value;
  }
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_CONDITION_FIELDS.has(key)) {
      errors.push(fieldError(workflowId, `${field}.${key}`, 'unsupported-condition', `Unknown authored condition field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
      ok = false;
    }
  }
  if (!isWorkflowConditionOperator(raw.operator)) {
    errors.push(fieldError(workflowId, `${field}.operator`, 'unsupported-condition', `Condition operator must be one of ${WORKFLOW_CONDITION_OPERATORS.join(', ')}`));
    ok = false;
  }
  const left = readOperand(raw.left, workflowId, `${field}.left`, errors);
  if (left === null) ok = false;

  const right = raw.right;
  if (right !== undefined) {
    const literalList = Array.isArray(right) && right.length > 0 && right.every((entry) => isConditionLiteral(entry));
    if (!isConditionLiteral(right) && !literalList) {
      errors.push(fieldError(workflowId, `${field}.right`, 'condition-right-invalid', 'Right operand must be a literal or a non-empty literal array'));
      ok = false;
    }
  }

  if (!ok || left === null || !isWorkflowConditionOperator(raw.operator)) return null;
  return Object.freeze({
    left,
    operator: raw.operator,
    ...(right !== undefined ? { right: (Array.isArray(right) ? Object.freeze([...right]) : right) as NonNullable<WorkflowCondition['right']> } : {})
  });
}

function readConnections(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[]
): readonly WorkflowConnection[] {
  if (value.connections === undefined) return [];
  if (!Array.isArray(value.connections)) {
    errors.push(fieldError(workflowId, 'connections', 'array-required', 'Workflow connections must be an array'));
    return [];
  }

  const connections: WorkflowConnection[] = [];
  value.connections.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(fieldError(workflowId, `connections[${index}]`, 'object-required', 'Connection entry must be an object'));
      return;
    }
    let ok = true;
    for (const key of Object.keys(raw)) {
      if (!AUTHORED_CONNECTION_FIELDS.has(key)) {
        errors.push(fieldError(workflowId, `connections[${index}].${key}`, 'unknown-field', `Unknown authored connection field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
        ok = false;
      }
    }

    const from = readEndpoint(raw.from, workflowId, `connections[${index}].from`, 'from', errors);
    const to = readEndpoint(raw.to, workflowId, `connections[${index}].to`, 'to', errors);

    let handoff: WorkflowHandoffMode | undefined;
    if (raw.handoff !== undefined) {
      if (!isWorkflowHandoffMode(raw.handoff)) {
        errors.push(fieldError(workflowId, `connections[${index}].handoff`, 'invalid-enum', `Connection handoff must be one of ${WORKFLOW_HANDOFF_MODES.join(', ')}`));
        ok = false;
      } else {
        handoff = raw.handoff;
      }
    }

    let condition: WorkflowCondition | TypedCondition | undefined;
    if (raw.condition !== undefined) {
      const parsed = readCondition(raw.condition, workflowId, `connections[${index}].condition`, errors);
      if (parsed === null) ok = false;
      else condition = parsed;
    }

    let priority: number | undefined;
    if (raw.priority !== undefined) {
      if (typeof raw.priority !== 'number' || !Number.isSafeInteger(raw.priority)) {
        errors.push(fieldError(workflowId, `connections[${index}].priority`, 'invalid-range', 'Connection priority must be an integer'));
        ok = false;
      } else {
        priority = raw.priority;
      }
    }

    let isDefault: boolean | undefined;
    if (raw.isDefault !== undefined) {
      if (typeof raw.isDefault !== 'boolean') {
        errors.push(fieldError(workflowId, `connections[${index}].isDefault`, 'boolean-required', 'Connection isDefault must be boolean'));
        ok = false;
      } else {
        isDefault = raw.isDefault;
      }
    }

    let selection: WorkflowSelectionRule | undefined;
    if (raw.selection !== undefined) {
      if (!isWorkflowSelectionRule(raw.selection)) {
        errors.push(fieldError(workflowId, `connections[${index}].selection`, 'invalid-enum', "Connection selection must be 'first', 'last', or 'exactlyOne'"));
        ok = false;
      } else {
        selection = raw.selection;
      }
    }

    const parsedPolicy = readConnectionContextPolicy(raw.contextPolicy, workflowId, `connections[${index}].contextPolicy`, errors);
    if (!parsedPolicy.ok) ok = false;

    if (!ok || from === null || to === null) return;
    connections.push(Object.freeze({
      from, to,
      ...(handoff !== undefined ? { handoff } : {}), ...(condition !== undefined ? { condition } : {}),
      ...(priority !== undefined ? { priority } : {}), ...(isDefault !== undefined ? { isDefault } : {}),
      ...(selection !== undefined ? { selection } : {}),
      ...(parsedPolicy.policy !== undefined ? { contextPolicy: parsedPolicy.policy } : {})
    }));
  });
  return connections;
}

function readInputBindingSource(
  raw: unknown,
  workflowId: string,
  field: string,
  errors: WorkflowFieldError[],
  allowLegacyPipelineId = false
): WorkflowInputBindingSource | null {
  if (!isPlainObject(raw)) {
    errors.push(fieldError(workflowId, field, 'object-required', 'Binding source must be an object'));
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'phaseIndex')) {
    errors.push(fieldError(workflowId, `${field}.phaseIndex`, 'index-addressing-forbidden', 'Workflow bindings must address nodes by nodeId, never phaseIndex'));
    return null;
  }
  let sourceOk = true;
  for (const key of Object.keys(raw)) {
    if (key === 'outputKey' ? !allowLegacyPipelineId : key !== 'from' && key !== 'nodeId' && key !== 'portId') {
      errors.push(key === 'outputKey' ? fieldError(workflowId, `${field}.outputKey`, LEGACY_PIPELINE_FIELD.code, LEGACY_PIPELINE_FIELD.outputKey) : fieldError(workflowId, `${field}.${key}`, 'unknown-field', `Unknown authored binding source field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
      sourceOk = false;
    }
  }
  if (raw.from === 'workflow-input') {
    if (raw.nodeId !== undefined) {
      errors.push(fieldError(workflowId, `${field}.nodeId`, 'unknown-field', "A workflow-input binding source cannot declare 'nodeId'"));
      sourceOk = false;
    }
    const portId = readIdentifier(raw.portId, workflowId, `${field}.portId`, 'Binding workflow-input portId', errors);
    return !sourceOk || portId === null ? null : Object.freeze({ from: 'workflow-input', portId });
  }
  if (raw.from === 'node-output') {
    const nodeId = readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Binding source nodeId', errors);
    const portId = readIdentifier(
      allowLegacyPipelineId ? (raw.portId ?? raw.outputKey) : raw.portId,
      workflowId,
      `${field}.portId`,
      'Binding source portId',
      errors
    );
    return !sourceOk || nodeId === null || portId === null ? null : Object.freeze({ from: 'node-output', nodeId, portId });
  }
  errors.push(fieldError(workflowId, `${field}.from`, 'invalid-enum', "Binding source.from must be 'workflow-input' or 'node-output'"));
  return null;
}

function readBindings(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[],
  allowLegacyPipelineId = false
): readonly WorkflowBinding[] | undefined {
  if (value.bindings === undefined) return undefined;
  if (!Array.isArray(value.bindings)) {
    errors.push(fieldError(workflowId, 'bindings', 'array-required', 'Workflow bindings must be an array'));
    return [];
  }
  const bindings: WorkflowBinding[] = [];
  value.bindings.forEach((raw, index) => {
    const baseField = `bindings[${index}]`;
    if (!isPlainObject(raw)) {
      errors.push(fieldError(workflowId, baseField, 'object-required', 'Binding entry must be an object'));
      return;
    }
    let ok = true;
    for (const key of Object.keys(raw)) {
      if (!AUTHORED_BINDING_FIELDS.has(key)) {
        errors.push(fieldError(workflowId, `${baseField}.${key}`, 'unknown-field', `Unknown authored binding field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
        ok = false;
      }
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'phaseIndex')) {
      errors.push(fieldError(workflowId, `${baseField}.phaseIndex`, 'index-addressing-forbidden', 'Workflow bindings must address nodes by nodeId, never phaseIndex'));
      ok = false;
    }

    const nodeId = readIdentifier(raw.nodeId, workflowId, `${baseField}.nodeId`, 'Binding nodeId', errors);
    let selection: WorkflowSelectionRule | undefined;
    if (raw.selection !== undefined) {
      if (!isWorkflowSelectionRule(raw.selection)) {
        errors.push(fieldError(workflowId, `${baseField}.selection`, 'invalid-enum', "Binding selection must be 'first', 'last', or 'exactlyOne'"));
        ok = false;
      } else {
        selection = raw.selection;
      }
    }

    if (raw.kind === 'input') {
      const inputKey = readIdentifier(raw.inputKey ?? raw.portId, workflowId, `${baseField}.inputKey`, 'Binding inputKey', errors);
      const source = readInputBindingSource(raw.source, workflowId, `${baseField}.source`, errors, allowLegacyPipelineId);
      if (raw.type !== undefined && !isPipelineInputPortType(raw.type)) {
        errors.push(fieldError(workflowId, `${baseField}.type`, 'invalid-enum', `Binding input type must be one of ${PIPELINE_INPUT_PORT_TYPES.join(', ')}`));
        ok = false;
      }
      if (raw.required !== undefined && typeof raw.required !== 'boolean') {
        errors.push(fieldError(workflowId, `${baseField}.required`, 'boolean-required', 'Binding required flag must be boolean'));
        ok = false;
      }
      if (!ok || nodeId === null || inputKey === null || source === null) return;
      const binding: WorkflowInputBinding = Object.freeze({
        kind: 'input',
        nodeId,
        inputKey,
        ...(isPipelineInputPortType(raw.type) ? { type: raw.type } : {}),
        ...(typeof raw.required === 'boolean' ? { required: raw.required } : {}),
        source,
        ...(selection !== undefined ? { selection } : {})
      });
      bindings.push(binding);
      return;
    }

    if (raw.kind === 'output') {
      const portId = readIdentifier(raw.portId, workflowId, `${baseField}.portId`, 'Binding output portId', errors);
      let outputKey: string | undefined;
      if (raw.outputKey !== undefined) {
        const parsed = readIdentifier(raw.outputKey, workflowId, `${baseField}.outputKey`, 'Binding outputKey', errors);
        if (parsed === null) ok = false;
        else outputKey = parsed;
      }
      let sourcePortId: string | undefined;
      if (raw.sourcePortId !== undefined) {
        const parsed = readIdentifier(raw.sourcePortId, workflowId, `${baseField}.sourcePortId`, 'Binding sourcePortId', errors);
        if (parsed === null) ok = false;
        else sourcePortId = parsed;
      }
      if (raw.type !== undefined && !isPipelineOutputPortType(raw.type)) {
        errors.push(fieldError(workflowId, `${baseField}.type`, 'invalid-enum', `Binding output type must be one of ${PIPELINE_OUTPUT_PORT_TYPES.join(', ')}`));
        ok = false;
      }
      let label: string | undefined;
      if (raw.label !== undefined) {
        if (typeof raw.label !== 'string' || raw.label.trim().length === 0 || raw.label.length > WORKFLOW_LABEL_MAX_LEN) {
          errors.push(fieldError(workflowId, `${baseField}.label`, 'invalid-length', `Binding label must contain 1 to ${WORKFLOW_LABEL_MAX_LEN} characters`));
          ok = false;
        } else {
          label = raw.label.trim();
        }
      }
      if (!ok || nodeId === null || portId === null) return;
      const binding: WorkflowOutputBinding = Object.freeze({
        kind: 'output',
        nodeId,
        portId,
        ...(outputKey !== undefined ? { outputKey } : {}),
        ...(sourcePortId !== undefined ? { sourcePortId } : {}),
        ...(isPipelineOutputPortType(raw.type) ? { type: raw.type } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(selection !== undefined ? { selection } : {})
      });
      bindings.push(binding);
      return;
    }

    errors.push(fieldError(workflowId, `${baseField}.kind`, 'invalid-enum', "Binding kind must be 'input' or 'output'"));
  });
  return bindings;
}

function readExecutionDefaults(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[]
): PipelineExecutionDefaults | undefined {
  if (value.executionDefaults === undefined) return undefined;
  if (!isPlainObject(value.executionDefaults)) {
    errors.push(fieldError(workflowId, 'executionDefaults', 'object-required', 'Workflow executionDefaults must be an object'));
    return undefined;
  }
  const raw = value.executionDefaults;
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_EXECUTION_DEFAULT_FIELDS.has(key)) {
      errors.push(fieldError(workflowId, `executionDefaults.${key}`, 'execution-defaults-unknown-field', `Unknown execution default '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`));
      ok = false;
    }
  }

  let runner: string | undefined;
  if (raw.runner !== undefined) {
    if (typeof raw.runner !== 'string' || !(SUPPORTED_BACKENDS as readonly string[]).includes(raw.runner)) {
      errors.push(fieldError(workflowId, 'executionDefaults.runner', 'invalid-enum', `Execution default runner must be one of ${SUPPORTED_BACKENDS.join(', ')}`));
      ok = false;
    } else {
      runner = raw.runner;
    }
  }

  let model: string | undefined;
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model.trim().length === 0) {
      errors.push(fieldError(workflowId, 'executionDefaults.model', 'non-empty-required', 'Execution default model must be non-empty'));
      ok = false;
    } else {
      model = raw.model.trim();
    }
  }

  let effort: PipelineExecutionDefaults['effort'];
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !(PHASE_EFFORT_LEVELS as readonly string[]).includes(raw.effort)) {
      errors.push(fieldError(workflowId, 'executionDefaults.effort', 'invalid-enum', `Execution default effort must be one of ${PHASE_EFFORT_LEVELS.join(', ')}`));
      ok = false;
    } else {
      effort = raw.effort as PipelineExecutionDefaults['effort'];
    }
  }

  let timeoutSeconds: number | undefined;
  if (raw.timeoutSeconds !== undefined) {
    if (
      typeof raw.timeoutSeconds !== 'number' ||
      !Number.isInteger(raw.timeoutSeconds) ||
      raw.timeoutSeconds < PIPELINE_TIMEOUT_MIN ||
      raw.timeoutSeconds > PIPELINE_TIMEOUT_MAX
    ) {
      errors.push(fieldError(workflowId, 'executionDefaults.timeoutSeconds', 'invalid-range', `Execution default timeoutSeconds must be an integer from ${PIPELINE_TIMEOUT_MIN} to ${PIPELINE_TIMEOUT_MAX}`));
      ok = false;
    } else {
      timeoutSeconds = raw.timeoutSeconds;
    }
  }

  if (!ok) return undefined;
  return Object.freeze({
    ...(runner !== undefined ? { runner } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {})
  });
}

function readRecommendedNext(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[]
): readonly string[] | undefined {
  if (value.recommendedNext === undefined) return undefined;
  if (!Array.isArray(value.recommendedNext)) {
    errors.push(fieldError(workflowId, 'recommendedNext', 'array-required', 'Workflow recommendedNext must be an array'));
    return undefined;
  }
  const next: string[] = [];
  value.recommendedNext.forEach((entry, index) => {
    const id = readIdentifier(entry, workflowId, `recommendedNext[${index}]`, 'Recommended next workflowId', errors);
    if (id !== null) next.push(id);
  });
  return Object.freeze(next);
}

function readStartNodeIds(
  value: Record<string, unknown>,
  workflowId: string,
  nodes: readonly WorkflowNode[],
  errors: WorkflowFieldError[]
): readonly string[] {
  const raw = value.startNodeIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(fieldError(workflowId, 'startNodeIds', 'invalid-start-set', 'Workflow must declare at least one allowed start node'));
    return [];
  }
  const known = new Set(nodes.map((node) => node.nodeId));
  const starts: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PIPELINE_ID_PATTERN.test(entry.trim())) {
      errors.push(fieldError(workflowId, `startNodeIds[${index}]`, 'invalid-start-set', `Allowed start must match ${PIPELINE_ID_PATTERN.source}`));
      return;
    }
    const nodeId = entry.trim();
    if (!known.has(nodeId)) {
      errors.push(fieldError(workflowId, `startNodeIds[${index}]`, 'invalid-start-set', `Allowed start '${bounded(nodeId, WORKFLOW_ID_MAX_LEN)}' names no node in this Workflow`));
      return;
    }
    starts.push(nodeId);
  });
  return starts;
}

export function validateWorkflowDefinition(
  raw: unknown,
  options: WorkflowDefinitionValidationOptions = {}
): WorkflowDefinitionValidationResult {
  if (!isPlainObject(raw)) return objectRequiredResult();

  const value = raw;
  const display = recognizedDisplay(value);
  const unrecognized = unrecognizedFields(value);
  const errors: WorkflowFieldError[] = [];

  const hasPortableId = Object.prototype.hasOwnProperty.call(value, 'workflowId');
  const hasLegacyId = Object.prototype.hasOwnProperty.call(value, 'id');
  const rawId = hasPortableId ? value.workflowId : options.allowLegacyId !== false ? value.id : undefined;
  const workflowId = typeof rawId === 'string' ? rawId.trim() : '?';

  if (hasPortableId && hasLegacyId) {
    errors.push(fieldError(workflowId, 'workflowId', 'identity-ambiguous', 'Use workflowId or legacy id, not both'));
  }
  if (typeof rawId !== 'string' || !PIPELINE_ID_PATTERN.test(workflowId)) {
    errors.push(fieldError(workflowId, 'workflowId', 'invalid-pattern', `Workflow id must match ${PIPELINE_ID_PATTERN.source}`));
  }

  if (Object.prototype.hasOwnProperty.call(value, 'derivedInputs')) {
    errors.push(fieldError(workflowId, 'derivedInputs', 'derived-ports-not-storable', 'Derived ports are computed on read and must not be stored'));
  }
  if (Object.prototype.hasOwnProperty.call(value, 'derivedOutputs')) {
    errors.push(fieldError(workflowId, 'derivedOutputs', 'derived-ports-not-storable', 'Derived ports are computed on read and must not be stored'));
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > WORKFLOW_NAME_MAX_LEN) {
    errors.push(fieldError(workflowId, 'name', 'invalid-length', `Workflow name must contain 1 to ${WORKFLOW_NAME_MAX_LEN} characters`));
  }

  let description: string | undefined;
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.length > WORKFLOW_DESCRIPTION_MAX_LEN) {
      errors.push(fieldError(workflowId, 'description', 'invalid-length', `Workflow description must be at most ${WORKFLOW_DESCRIPTION_MAX_LEN} characters`));
    } else {
      description = value.description;
    }
  }

  const versionValue = value.version ?? options.defaultVersion ?? 1;
  const version = typeof versionValue === 'number' ? versionValue : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    errors.push(fieldError(workflowId, 'version', 'positive-integer-required', 'Workflow version must be a positive integer'));
  }

  const inputs = readInputPorts(value, workflowId, errors);
  const outputs = readOutputPorts(value, workflowId, errors);
  const nodes = readNodes(value, workflowId, errors, options.allowLegacyPipelineId === true);
  const connections = readConnections(value, workflowId, errors);
  const bindings = readBindings(value, workflowId, errors, options.allowLegacyPipelineId === true);
  const startNodeIds = readStartNodeIds(value, workflowId, nodes, errors);
  const executionDefaults = readExecutionDefaults(value, workflowId, errors);
  const recommendedNext = readRecommendedNext(value, workflowId, errors);

  let control: CandidateBlockControl | undefined;
  if (value.control !== undefined) {
    const parsedControl = validateCandidateBlockControl(value.control, workflowId, 'control');
    if (!parsedControl.ok || parsedControl.value === null) {
      errors.push(...parsedControl.errors);
    } else {
      control = parsedControl.value;
      if (errors.length === 0) {
        validateCandidateBlockGraphStructure(workflowId, control, nodes, connections, startNodeIds, errors);
      }
      (bindings ?? []).forEach((binding, index) => {
        if (binding.kind === 'input' && binding.source.from === 'node-output') {
          errors.push(fieldError(workflowId, `bindings[${index}].source`, 'cross-candidate-input-binding', 'Candidate-block input bindings must read from workflow-input, never node-output'));
        }
      });
    }
  }

  let decisionResults: WorkflowDecisionResults | undefined;
  if (value.decisionResults !== undefined) {
    const parsedDecisionResults = validateWorkflowDecisionResults(value.decisionResults, workflowId, value.control !== undefined, 'decisionResults');
    if (!parsedDecisionResults.ok || parsedDecisionResults.value === null) {
      errors.push(...parsedDecisionResults.errors);
    } else {
      decisionResults = parsedDecisionResults.value;
    }
  }

  if (errors.length > 0) {
    return {
      ok: false, workflowId, definition: null,
      display, unrecognized, errors: Object.freeze(errors)
    };
  }

  const definition: WorkflowDefinition = Object.freeze({
    workflowId,
    name,
    ...(description !== undefined ? { description } : {}),
    version,
    ...(inputs !== undefined ? { inputs: Object.freeze(inputs) } : {}),
    ...(outputs !== undefined ? { outputs: Object.freeze(outputs) } : {}),
    nodes: Object.freeze(nodes),
    connections: Object.freeze(connections),
    ...(bindings !== undefined ? { bindings: Object.freeze(bindings) } : {}),
    startNodeIds: Object.freeze(startNodeIds),
    ...(executionDefaults !== undefined ? { executionDefaults } : {}),
    ...(recommendedNext !== undefined ? { recommendedNext } : {}),
    ...(control !== undefined ? { control } : {}),
    ...(decisionResults !== undefined ? { decisionResults } : {})
  });
  return { ok: true, workflowId, definition, display, unrecognized, errors: Object.freeze([]) };
}
