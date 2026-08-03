import {
  WORKFLOW_CONDITION_OPERATORS,
  isWorkflowConditionOperator,
  isWorkflowSelectionRule,
  type WorkflowCondition,
  type WorkflowConditionLiteral,
  type WorkflowConditionOperand,
  type WorkflowConnection,
  type WorkflowDefinition,
  type WorkflowFieldError,
  type WorkflowNode,
  type WorkflowSelectionRule
} from '../contracts/workflow-definitions';
import { PIPELINE_ID_PATTERN } from './pipeline-definition-validator';

/**
 * Field, identity, and shape validation for one authored Workflow row. Cross-reference
 * resolution — Pipeline existence, port endpoints, port-type compatibility, cycles,
 * reachability, and condition ancestry — is a separate pass in
 * `workflow-graph-validator.ts`, because it needs the effective Pipeline catalog.
 *
 * The identifier grammar is the one already shipped for Phase and Pipeline ids
 * (`PIPELINE_ID_PATTERN`), reused rather than copied so the three families cannot drift.
 */

export const WORKFLOW_ID_MAX_LEN = 64;
export const WORKFLOW_NAME_MAX_LEN = 80;
export const WORKFLOW_DESCRIPTION_MAX_LEN = 1024;
export const WORKFLOW_LABEL_MAX_LEN = 80;

/** Wider than the Pipeline cap so a positional connection path such as `connections[12].to` fits. */
export const WORKFLOW_ERROR_FIELD_MAX = 48;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 512;

export const AUTHORED_WORKFLOW_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'workflowId',
  'name',
  'description',
  'version',
  'nodes',
  'connections',
  'startNodeIds'
]);

const AUTHORED_NODE_FIELDS: ReadonlySet<string> = new Set(['nodeId', 'pipelineId', 'label']);

const AUTHORED_CONNECTION_FIELDS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'condition',
  'priority',
  'isDefault',
  'selection'
]);

const AUTHORED_ENDPOINT_FIELDS: ReadonlySet<string> = new Set(['nodeId', 'portId']);

const AUTHORED_CONDITION_FIELDS: ReadonlySet<string> = new Set(['left', 'operator', 'right']);

export interface WorkflowDefinitionValidationResult {
  readonly ok: boolean;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition | null;
  /** Recognized scalar authored fields only. Host-internal; sanitized before IPC. */
  readonly display: Readonly<Record<string, unknown>>;
  /** Unrecognized authored keys, preserved verbatim for round-trip fidelity (FR-007). */
  readonly unrecognized: Readonly<Record<string, unknown>>;
  readonly errors: readonly WorkflowFieldError[];
}

export interface WorkflowDefinitionValidationOptions {
  readonly allowLegacyId?: boolean;
  readonly defaultVersion?: number;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function fieldError(
  workflowId: string,
  field: string,
  code: string,
  message: string
): WorkflowFieldError {
  return Object.freeze({
    workflowId: bounded(workflowId || '?', WORKFLOW_ID_MAX_LEN),
    field: bounded(field, WORKFLOW_ERROR_FIELD_MAX),
    code: bounded(code, ERROR_CODE_MAX),
    message: bounded(message, ERROR_MESSAGE_MAX)
  });
}

/**
 * The same bounded constructor, exported so the graph pass in `workflow-graph-validator.ts`
 * emits defects under identical caps. Two constructors would let one pass exceed the
 * projection's field/code/message limits while the other stayed inside them.
 */
export const workflowFieldError = fieldError;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectRequiredResult(): WorkflowDefinitionValidationResult {
  return {
    ok: false,
    workflowId: '?',
    definition: null,
    display: Object.freeze({}),
    unrecognized: Object.freeze({}),
    errors: Object.freeze([
      fieldError('?', 'entry', 'object-required', 'Workflow entry must be an object')
    ])
  };
}

function recognizedDisplay(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const display: Record<string, unknown> = {};
  for (const field of AUTHORED_WORKFLOW_FIELDS) {
    const value = raw[field];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      display[field] = value;
    }
  }
  return Object.freeze(display);
}

/**
 * FR-007: unknown keys are kept, not rejected. This differs from the Pipeline validator, which
 * reports `unknown-field`, and the difference is deliberate — a Workflow row authored by a newer
 * host must survive a round trip through an older one without losing data.
 */
function unrecognizedFields(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_WORKFLOW_FIELDS.has(key)) kept[key] = raw[key];
  }
  return Object.freeze(kept);
}

function readIdentifier(
  raw: unknown,
  workflowId: string,
  field: string,
  label: string,
  errors: WorkflowFieldError[]
): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!PIPELINE_ID_PATTERN.test(value)) {
    errors.push(
      fieldError(
        workflowId,
        field,
        'invalid-pattern',
        `${label} must match ${PIPELINE_ID_PATTERN.source}`
      )
    );
    return null;
  }
  return value;
}

function readNodes(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[]
): readonly WorkflowNode[] {
  if (!Array.isArray(value.nodes)) {
    errors.push(
      fieldError(workflowId, 'nodes', 'non-empty-required', 'Workflow nodes must be a non-empty array')
    );
    return [];
  }
  if (value.nodes.length === 0) {
    errors.push(
      fieldError(workflowId, 'nodes', 'non-empty-required', 'Workflow nodes must be a non-empty array')
    );
    return [];
  }

  const seen = new Set<string>();
  const nodes: WorkflowNode[] = [];
  value.nodes.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(
        fieldError(workflowId, `nodes[${index}]`, 'object-required', 'Node entry must be an object')
      );
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!AUTHORED_NODE_FIELDS.has(key)) {
        errors.push(
          fieldError(
            workflowId,
            `nodes[${index}].${key}`,
            'unknown-field',
            `Unknown authored node field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`
          )
        );
      }
    }

    const nodeId = readIdentifier(raw.nodeId, workflowId, `nodes[${index}].nodeId`, 'Node id', errors);
    const pipelineId = readIdentifier(
      raw.pipelineId,
      workflowId,
      `nodes[${index}].pipelineId`,
      'Node pipelineId',
      errors
    );

    let label: string | undefined;
    if (raw.label !== undefined) {
      if (typeof raw.label !== 'string' || raw.label.trim().length === 0 || raw.label.length > WORKFLOW_LABEL_MAX_LEN) {
        errors.push(
          fieldError(
            workflowId,
            `nodes[${index}].label`,
            'invalid-length',
            `Node label must contain 1 to ${WORKFLOW_LABEL_MAX_LEN} characters`
          )
        );
      } else {
        label = raw.label.trim();
      }
    }

    if (nodeId !== null) {
      if (seen.has(nodeId)) {
        errors.push(
          fieldError(
            workflowId,
            `nodes[${index}].nodeId`,
            'duplicate-node-id',
            `Node id '${bounded(nodeId, WORKFLOW_ID_MAX_LEN)}' is declared more than once`
          )
        );
      } else {
        seen.add(nodeId);
      }
    }

    if (nodeId === null || pipelineId === null) return;
    nodes.push(Object.freeze({ nodeId, pipelineId, ...(label !== undefined ? { label } : {}) }));
  });
  return nodes;
}

function readEndpoint(
  raw: unknown,
  workflowId: string,
  field: string,
  errors: WorkflowFieldError[]
): { readonly nodeId: string; readonly portId: string } | null {
  if (!isPlainObject(raw)) {
    errors.push(fieldError(workflowId, field, 'object-required', 'Endpoint must be an object'));
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_ENDPOINT_FIELDS.has(key)) {
      errors.push(
        fieldError(
          workflowId,
          `${field}.${key}`,
          'unknown-field',
          `Unknown authored endpoint field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`
        )
      );
    }
  }
  const nodeId = readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Endpoint node id', errors);
  const portId = readIdentifier(raw.portId, workflowId, `${field}.portId`, 'Endpoint port id', errors);
  if (nodeId === null || portId === null) return null;
  return Object.freeze({ nodeId, portId });
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
    errors.push(
      fieldError(workflowId, field, 'unsupported-condition', 'Condition operand must be an object')
    );
    return null;
  }
  if (raw.source === 'node-status') {
    for (const key of Object.keys(raw)) {
      if (key !== 'source' && key !== 'nodeId') {
        errors.push(
          fieldError(
            workflowId,
            `${field}.${key}`,
            'unsupported-condition',
            'A node-status operand accepts only source and nodeId'
          )
        );
        return null;
      }
    }
    const nodeId = readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Operand node id', errors);
    return nodeId === null ? null : Object.freeze({ source: 'node-status', nodeId });
  }
  if (raw.source === 'node-output') {
    for (const key of Object.keys(raw)) {
      if (key !== 'source' && key !== 'nodeId' && key !== 'field') {
        errors.push(
          fieldError(
            workflowId,
            `${field}.${key}`,
            'unsupported-condition',
            'A node-output operand accepts only source, nodeId, and field'
          )
        );
        return null;
      }
    }
    const nodeId = readIdentifier(raw.nodeId, workflowId, `${field}.nodeId`, 'Operand node id', errors);
    const fieldName = typeof raw.field === 'string' ? raw.field.trim() : '';
    if (!isWellFormedFieldPath(fieldName)) {
      errors.push(
        fieldError(
          workflowId,
          `${field}.field`,
          'condition-operand-unknown',
          'Operand field must be dot-separated portable identifiers'
        )
      );
      return null;
    }
    return nodeId === null
      ? null
      : Object.freeze({ source: 'node-output', nodeId, field: fieldName });
  }
  errors.push(
    fieldError(
      workflowId,
      `${field}.source`,
      'condition-operand-unknown',
      "Condition operand source must be 'node-output' or 'node-status'"
    )
  );
  return null;
}

/**
 * Well-formedness only. Whether the producing Pipeline actually emits this field is not
 * decidable here: `PipelineOutputPort` declares a port *type*, never field names. That check
 * belongs to run composition (FR-R2-007); inventing a field registry here would reject
 * valid graphs.
 */
export function isWellFormedFieldPath(value: string): boolean {
  if (value.length === 0 || value.length > WORKFLOW_ID_MAX_LEN) return false;
  return value.split('.').every((segment) => PIPELINE_ID_PATTERN.test(segment));
}

function readCondition(
  raw: unknown,
  workflowId: string,
  field: string,
  errors: WorkflowFieldError[]
): WorkflowCondition | null {
  // Shape rejection precedes any content inspection (FR-021): a string condition — including
  // any JavaScript, shell, template, or Agent expression — never reaches an interpreter,
  // because there is no interpreter to reach.
  if (!isPlainObject(raw)) {
    errors.push(
      fieldError(
        workflowId,
        field,
        'unsupported-condition',
        'Condition must be structured data, not an expression'
      )
    );
    return null;
  }
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_CONDITION_FIELDS.has(key)) {
      errors.push(
        fieldError(
          workflowId,
          `${field}.${key}`,
          'unsupported-condition',
          `Unknown authored condition field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`
        )
      );
      ok = false;
    }
  }
  if (!isWorkflowConditionOperator(raw.operator)) {
    errors.push(
      fieldError(
        workflowId,
        `${field}.operator`,
        'unsupported-condition',
        `Condition operator must be one of ${WORKFLOW_CONDITION_OPERATORS.join(', ')}`
      )
    );
    ok = false;
  }
  const left = readOperand(raw.left, workflowId, `${field}.left`, errors);
  if (left === null) ok = false;

  const right = raw.right;
  if (right !== undefined) {
    const literalList =
      Array.isArray(right) && right.length > 0 && right.every((entry) => isConditionLiteral(entry));
    if (!isConditionLiteral(right) && !literalList) {
      errors.push(
        fieldError(
          workflowId,
          `${field}.right`,
          'condition-right-invalid',
          'Right operand must be a literal or a non-empty literal array'
        )
      );
      ok = false;
    }
  }

  if (!ok || left === null || !isWorkflowConditionOperator(raw.operator)) return null;
  return Object.freeze({
    left,
    operator: raw.operator,
    ...(right !== undefined
      ? { right: (Array.isArray(right) ? Object.freeze([...right]) : right) as WorkflowCondition['right'] }
      : {})
  });
}

function readConnections(
  value: Record<string, unknown>,
  workflowId: string,
  errors: WorkflowFieldError[]
): readonly WorkflowConnection[] {
  if (value.connections === undefined) return [];
  if (!Array.isArray(value.connections)) {
    errors.push(
      fieldError(workflowId, 'connections', 'array-required', 'Workflow connections must be an array')
    );
    return [];
  }

  const connections: WorkflowConnection[] = [];
  value.connections.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(
        fieldError(
          workflowId,
          `connections[${index}]`,
          'object-required',
          'Connection entry must be an object'
        )
      );
      return;
    }
    let ok = true;
    for (const key of Object.keys(raw)) {
      if (!AUTHORED_CONNECTION_FIELDS.has(key)) {
        errors.push(
          fieldError(
            workflowId,
            `connections[${index}].${key}`,
            'unknown-field',
            `Unknown authored connection field '${bounded(key, WORKFLOW_ERROR_FIELD_MAX)}'`
          )
        );
        ok = false;
      }
    }

    const from = readEndpoint(raw.from, workflowId, `connections[${index}].from`, errors);
    const to = readEndpoint(raw.to, workflowId, `connections[${index}].to`, errors);

    let condition: WorkflowCondition | undefined;
    if (raw.condition !== undefined) {
      const parsed = readCondition(
        raw.condition,
        workflowId,
        `connections[${index}].condition`,
        errors
      );
      if (parsed === null) ok = false;
      else condition = parsed;
    }

    let priority: number | undefined;
    if (raw.priority !== undefined) {
      if (typeof raw.priority !== 'number' || !Number.isSafeInteger(raw.priority)) {
        errors.push(
          fieldError(
            workflowId,
            `connections[${index}].priority`,
            'invalid-range',
            'Connection priority must be an integer'
          )
        );
        ok = false;
      } else {
        priority = raw.priority;
      }
    }

    let isDefault: boolean | undefined;
    if (raw.isDefault !== undefined) {
      if (typeof raw.isDefault !== 'boolean') {
        errors.push(
          fieldError(
            workflowId,
            `connections[${index}].isDefault`,
            'boolean-required',
            'Connection isDefault must be boolean'
          )
        );
        ok = false;
      } else {
        isDefault = raw.isDefault;
      }
    }

    let selection: WorkflowSelectionRule | undefined;
    if (raw.selection !== undefined) {
      if (!isWorkflowSelectionRule(raw.selection)) {
        errors.push(
          fieldError(
            workflowId,
            `connections[${index}].selection`,
            'invalid-enum',
            "Connection selection must be 'first', 'last', or 'exactlyOne'"
          )
        );
        ok = false;
      } else {
        selection = raw.selection;
      }
    }

    if (!ok || from === null || to === null) return;
    connections.push(
      Object.freeze({
        from,
        to,
        ...(condition !== undefined ? { condition } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(isDefault !== undefined ? { isDefault } : {}),
        ...(selection !== undefined ? { selection } : {})
      })
    );
  });
  return connections;
}

function readStartNodeIds(
  value: Record<string, unknown>,
  workflowId: string,
  nodes: readonly WorkflowNode[],
  errors: WorkflowFieldError[]
): readonly string[] {
  const raw = value.startNodeIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(
      fieldError(
        workflowId,
        'startNodeIds',
        'invalid-start-set',
        'Workflow must declare at least one allowed start node'
      )
    );
    return [];
  }
  const known = new Set(nodes.map((node) => node.nodeId));
  const starts: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PIPELINE_ID_PATTERN.test(entry.trim())) {
      errors.push(
        fieldError(
          workflowId,
          `startNodeIds[${index}]`,
          'invalid-start-set',
          `Allowed start must match ${PIPELINE_ID_PATTERN.source}`
        )
      );
      return;
    }
    const nodeId = entry.trim();
    if (!known.has(nodeId)) {
      errors.push(
        fieldError(
          workflowId,
          `startNodeIds[${index}]`,
          'invalid-start-set',
          `Allowed start '${bounded(nodeId, WORKFLOW_ID_MAX_LEN)}' names no node in this Workflow`
        )
      );
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
  const rawId = hasPortableId
    ? value.workflowId
    : options.allowLegacyId !== false
      ? value.id
      : undefined;
  const workflowId = typeof rawId === 'string' ? rawId.trim() : '?';

  if (hasPortableId && hasLegacyId) {
    errors.push(
      fieldError(workflowId, 'workflowId', 'identity-ambiguous', 'Use workflowId or legacy id, not both')
    );
  }
  if (typeof rawId !== 'string' || !PIPELINE_ID_PATTERN.test(workflowId)) {
    errors.push(
      fieldError(
        workflowId,
        'workflowId',
        'invalid-pattern',
        `Workflow id must match ${PIPELINE_ID_PATTERN.source}`
      )
    );
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > WORKFLOW_NAME_MAX_LEN) {
    errors.push(
      fieldError(
        workflowId,
        'name',
        'invalid-length',
        `Workflow name must contain 1 to ${WORKFLOW_NAME_MAX_LEN} characters`
      )
    );
  }

  let description: string | undefined;
  if (value.description !== undefined) {
    if (
      typeof value.description !== 'string' ||
      value.description.length > WORKFLOW_DESCRIPTION_MAX_LEN
    ) {
      errors.push(
        fieldError(
          workflowId,
          'description',
          'invalid-length',
          `Workflow description must be at most ${WORKFLOW_DESCRIPTION_MAX_LEN} characters`
        )
      );
    } else {
      description = value.description;
    }
  }

  const versionValue = value.version ?? options.defaultVersion ?? 1;
  const version = typeof versionValue === 'number' ? versionValue : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    errors.push(
      fieldError(
        workflowId,
        'version',
        'positive-integer-required',
        'Workflow version must be a positive integer'
      )
    );
  }

  const nodes = readNodes(value, workflowId, errors);
  const connections = readConnections(value, workflowId, errors);
  const startNodeIds = readStartNodeIds(value, workflowId, nodes, errors);

  if (errors.length > 0) {
    return {
      ok: false,
      workflowId,
      definition: null,
      display,
      unrecognized,
      errors: Object.freeze(errors)
    };
  }

  const definition: WorkflowDefinition = Object.freeze({
    workflowId,
    name,
    ...(description !== undefined ? { description } : {}),
    version,
    nodes: Object.freeze(nodes),
    connections: Object.freeze(connections),
    startNodeIds: Object.freeze(startNodeIds)
  });
  return {
    ok: true,
    workflowId,
    definition,
    display,
    unrecognized,
    errors: Object.freeze([])
  };
}
