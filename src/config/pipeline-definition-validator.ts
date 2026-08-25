import {
  PIPELINE_ID_MAX_LEN,
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES,
  isPipelineInputPortType,
  isPipelineOutputPortType,
  type PhaseBinding,
  type PipelineDefinition,
  type PipelineExecutionDefaults,
  type PipelineFieldError,
  type PipelineInputPort,
  type PipelineOutputPort
} from '../contracts/pipeline-definitions';
import { PHASE_EFFORT_LEVELS } from '../contracts/process-definitions';
import { SUPPORTED_BACKENDS } from '../contracts/backend-kinds';

export const PIPELINE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export { PIPELINE_ID_MAX_LEN };
export const PIPELINE_NAME_MAX_LEN = 80;
export const PIPELINE_DESCRIPTION_MAX_LEN = 1024;
export const PIPELINE_PORT_LABEL_MAX_LEN = 80;
export const PIPELINE_PORT_KEY_MAX_LEN = 64;
export const PIPELINE_TIMEOUT_MIN = 1;
export const PIPELINE_TIMEOUT_MAX = 3600;

export const AUTHORED_PIPELINE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'pipelineId',
  'name',
  'description',
  'version',
  'phases',
  'phaseIds',
  'inputs',
  'outputs',
  'bindings',
  'executionDefaults',
  'recommendedNext'
]);

export const AUTHORED_EXECUTION_DEFAULT_FIELDS: ReadonlySet<string> = new Set([
  'runner',
  'model',
  'effort',
  'timeoutSeconds'
]);

const ERROR_MESSAGE_MAX = 512;
const ERROR_FIELD_MAX = 32;
const ERROR_CODE_MAX = 64;

export interface PipelineDefinitionValidationOptions {
  readonly allowLegacyId?: boolean;
  readonly defaultVersion?: number;
}

export interface PipelineDefinitionValidationResult {
  readonly ok: boolean;
  readonly pipelineId: string;
  readonly definition: PipelineDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PipelineFieldError[];
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function fieldError(
  pipelineId: string,
  field: string,
  code: string,
  message: string
): PipelineFieldError {
  return Object.freeze({
    pipelineId: bounded(pipelineId || '?', PIPELINE_ID_MAX_LEN),
    field: bounded(field, ERROR_FIELD_MAX),
    code: bounded(code, ERROR_CODE_MAX),
    message: bounded(message, ERROR_MESSAGE_MAX)
  });
}

function recognizedDisplay(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const display: Record<string, unknown> = {};
  for (const field of AUTHORED_PIPELINE_FIELDS) {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectRequiredResult(): PipelineDefinitionValidationResult {
  return {
    ok: false,
    pipelineId: '?',
    definition: null,
    display: Object.freeze({}),
    errors: Object.freeze([
      fieldError('?', 'entry', 'object-required', 'Pipeline entry must be an object')
    ])
  };
}

function readSequence(
  value: Record<string, unknown>,
  pipelineId: string,
  errors: PipelineFieldError[]
): readonly string[] {
  const hasPortable = Object.prototype.hasOwnProperty.call(value, 'phaseIds');
  const hasLegacy = Object.prototype.hasOwnProperty.call(value, 'phases');
  if (hasPortable && hasLegacy) {
    errors.push(
      fieldError(pipelineId, 'phaseIds', 'sequence-ambiguous', 'Use phaseIds or legacy phases, not both')
    );
  }
  const raw = hasPortable ? value.phaseIds : value.phases;
  if (!Array.isArray(raw)) {
    errors.push(
      fieldError(pipelineId, 'phaseIds', 'non-empty-required', 'Pipeline phaseIds must be a non-empty array')
    );
    return [];
  }
  if (raw.length === 0) {
    errors.push(
      fieldError(pipelineId, 'phaseIds', 'non-empty-required', 'Pipeline phaseIds must be a non-empty array')
    );
    return [];
  }
  const sequence: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PIPELINE_ID_PATTERN.test(entry.trim())) {
      errors.push(
        fieldError(
          pipelineId,
          `phaseIds[${index}]`,
          'invalid-pattern',
          `Phase reference must match ${PIPELINE_ID_PATTERN.source}`
        )
      );
      return;
    }
    sequence.push(entry.trim());
  });
  return sequence;
}

function readPortCommon(
  raw: unknown,
  pipelineId: string,
  namespace: 'inputs' | 'outputs',
  index: number,
  seen: Set<string>,
  errors: PipelineFieldError[]
): { readonly portId: string; readonly label: string; readonly description?: string } | null {
  if (!isPlainObject(raw)) {
    errors.push(
      fieldError(pipelineId, `${namespace}[${index}]`, 'object-required', 'Port entry must be an object')
    );
    return null;
  }
  let ok = true;
  const portId = typeof raw.portId === 'string' ? raw.portId.trim() : '';
  if (!PIPELINE_ID_PATTERN.test(portId)) {
    errors.push(
      fieldError(
        pipelineId,
        `${namespace}[${index}].portId`,
        'invalid-pattern',
        `Port id must match ${PIPELINE_ID_PATTERN.source}`
      )
    );
    ok = false;
  } else if (seen.has(portId)) {
    errors.push(
      fieldError(
        pipelineId,
        `${namespace}[${index}].portId`,
        'duplicate-port-id',
        `Port id '${bounded(portId, PIPELINE_ID_MAX_LEN)}' is declared more than once`
      )
    );
    ok = false;
  } else {
    seen.add(portId);
  }

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label.length === 0 || label.length > PIPELINE_PORT_LABEL_MAX_LEN) {
    errors.push(
      fieldError(
        pipelineId,
        `${namespace}[${index}].label`,
        'invalid-length',
        `Port label must contain 1 to ${PIPELINE_PORT_LABEL_MAX_LEN} characters`
      )
    );
    ok = false;
  }

  let description: string | undefined;
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > PIPELINE_DESCRIPTION_MAX_LEN) {
      errors.push(
        fieldError(
          pipelineId,
          `${namespace}[${index}].desc`,
          'invalid-length',
          `Port description must be at most ${PIPELINE_DESCRIPTION_MAX_LEN} characters`
        )
      );
      ok = false;
    } else {
      description = raw.description;
    }
  }

  for (const key of Object.keys(raw)) {
    const permitted =
      key === 'portId' ||
      key === 'label' ||
      key === 'type' ||
      key === 'description' ||
      (namespace === 'inputs' && key === 'required');
    if (!permitted) {
      errors.push(
        fieldError(
          pipelineId,
          `${namespace}[${index}].${key}`,
          'unknown-field',
          `Unknown authored port field '${bounded(key, ERROR_FIELD_MAX)}'`
        )
      );
      ok = false;
    }
  }

  return ok ? { portId, label, ...(description !== undefined ? { description } : {}) } : null;
}

function readInputs(
  value: Record<string, unknown>,
  pipelineId: string,
  errors: PipelineFieldError[]
): readonly PipelineInputPort[] {
  if (value.inputs === undefined) return [];
  if (!Array.isArray(value.inputs)) {
    errors.push(fieldError(pipelineId, 'inputs', 'array-required', 'Pipeline inputs must be an array'));
    return [];
  }
  const seen = new Set<string>();
  const ports: PipelineInputPort[] = [];
  value.inputs.forEach((raw, index) => {
    const common = readPortCommon(raw, pipelineId, 'inputs', index, seen, errors);
    const entry = isPlainObject(raw) ? raw : {};
    if (!isPipelineInputPortType(entry.type)) {
      errors.push(
        fieldError(
          pipelineId,
          `inputs[${index}].type`,
          'invalid-enum',
          `Input port type must be one of ${PIPELINE_INPUT_PORT_TYPES.join(', ')}`
        )
      );
      return;
    }
    let required = true;
    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean') {
        errors.push(
          fieldError(
            pipelineId,
            `inputs[${index}].required`,
            'boolean-required',
            'Port required must be boolean'
          )
        );
        return;
      }
      required = entry.required;
    }
    if (!common) return;
    ports.push(Object.freeze({ ...common, type: entry.type, required }));
  });
  return ports;
}

function readOutputs(
  value: Record<string, unknown>,
  pipelineId: string,
  errors: PipelineFieldError[]
): readonly PipelineOutputPort[] {
  if (value.outputs === undefined) return [];
  if (!Array.isArray(value.outputs)) {
    errors.push(fieldError(pipelineId, 'outputs', 'array-required', 'Pipeline outputs must be an array'));
    return [];
  }
  const seen = new Set<string>();
  const ports: PipelineOutputPort[] = [];
  value.outputs.forEach((raw, index) => {
    const common = readPortCommon(raw, pipelineId, 'outputs', index, seen, errors);
    const entry = isPlainObject(raw) ? raw : {};
    if (!isPipelineOutputPortType(entry.type)) {
      errors.push(
        fieldError(
          pipelineId,
          `outputs[${index}].type`,
          'invalid-enum',
          `Output port type must be one of ${PIPELINE_OUTPUT_PORT_TYPES.join(', ')}`
        )
      );
      return;
    }
    if (!common) return;
    ports.push(Object.freeze({ ...common, type: entry.type }));
  });
  return ports;
}

function readPortKey(
  raw: unknown,
  pipelineId: string,
  field: string,
  errors: PipelineFieldError[]
): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > PIPELINE_PORT_KEY_MAX_LEN) {
    errors.push(
      fieldError(
        pipelineId,
        field,
        'non-empty-required',
        `Binding ${field} must contain 1 to ${PIPELINE_PORT_KEY_MAX_LEN} characters`
      )
    );
    return null;
  }
  return raw.trim();
}

function readPhaseIndex(
  raw: unknown,
  pipelineId: string,
  field: string,
  errors: PipelineFieldError[]
): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    errors.push(
      fieldError(pipelineId, field, 'invalid-range', 'Binding phaseIndex must be a non-negative integer')
    );
    return null;
  }
  return raw;
}

function readBinding(
  raw: unknown,
  pipelineId: string,
  index: number,
  errors: PipelineFieldError[]
): PhaseBinding | null {
  if (!isPlainObject(raw)) {
    errors.push(
      fieldError(pipelineId, `bindings[${index}]`, 'object-required', 'Binding entry must be an object')
    );
    return null;
  }
  if (raw.kind !== 'input' && raw.kind !== 'output') {
    errors.push(
      fieldError(
        pipelineId,
        `bindings[${index}].kind`,
        'invalid-enum',
        "Binding kind must be 'input' or 'output'"
      )
    );
    return null;
  }
  const phaseIndex = readPhaseIndex(
    raw.phaseIndex,
    pipelineId,
    `bindings[${index}].phaseIndex`,
    errors
  );

  if (raw.kind === 'output') {
    const portId = readPortKey(raw.portId, pipelineId, `bindings[${index}].portId`, errors);
    const outputKey = readPortKey(raw.outputKey, pipelineId, `bindings[${index}].outKey`, errors);
    if (phaseIndex === null || portId === null || outputKey === null) return null;
    return Object.freeze({ kind: 'output', phaseIndex, portId, outputKey });
  }

  const inputKey = readPortKey(raw.inputKey, pipelineId, `bindings[${index}].inKey`, errors);
  const source = raw.source;
  if (!isPlainObject(source) || (source.from !== 'pipeline-input' && source.from !== 'phase-output')) {
    errors.push(
      fieldError(
        pipelineId,
        `bindings[${index}].source`,
        'invalid-enum',
        "Binding source must be 'pipeline-input' or 'phase-output'"
      )
    );
    return null;
  }
  const portId = readPortKey(source.portId, pipelineId, `bindings[${index}].src.portId`, errors);
  if (source.from === 'pipeline-input') {
    if (phaseIndex === null || inputKey === null || portId === null) return null;
    return Object.freeze({
      kind: 'input',
      phaseIndex,
      inputKey,
      source: Object.freeze({ from: 'pipeline-input', portId })
    });
  }
  const sourceIndex = readPhaseIndex(
    source.phaseIndex,
    pipelineId,
    `bindings[${index}].src.phaseIndex`,
    errors
  );
  if (phaseIndex === null || inputKey === null || portId === null || sourceIndex === null) return null;
  return Object.freeze({
    kind: 'input',
    phaseIndex,
    inputKey,
    source: Object.freeze({ from: 'phase-output', phaseIndex: sourceIndex, portId })
  });
}

function readBindings(
  value: Record<string, unknown>,
  pipelineId: string,
  errors: PipelineFieldError[]
): readonly PhaseBinding[] {
  if (value.bindings === undefined) return [];
  if (!Array.isArray(value.bindings)) {
    errors.push(
      fieldError(pipelineId, 'bindings', 'array-required', 'Pipeline bindings must be an array')
    );
    return [];
  }
  const bindings: PhaseBinding[] = [];
  value.bindings.forEach((raw, index) => {
    const binding = readBinding(raw, pipelineId, index, errors);
    if (binding) bindings.push(binding);
  });
  return bindings;
}

function readExecutionDefaults(
  value: Record<string, unknown>,
  pipelineId: string,
  errors: PipelineFieldError[]
): PipelineExecutionDefaults | undefined {
  if (value.executionDefaults === undefined) return undefined;
  if (!isPlainObject(value.executionDefaults)) {
    errors.push(
      fieldError(
        pipelineId,
        'executionDefaults',
        'object-required',
        'Pipeline executionDefaults must be an object'
      )
    );
    return undefined;
  }
  const raw = value.executionDefaults;
  for (const key of Object.keys(raw)) {
    if (!AUTHORED_EXECUTION_DEFAULT_FIELDS.has(key)) {
      errors.push(
        fieldError(
          pipelineId,
          `executionDefaults.${key}`,
          'execution-defaults-unknown-field',
          `Unknown execution default '${bounded(key, ERROR_FIELD_MAX)}'`
        )
      );
    }
  }

  let runner: string | undefined;
  if (raw.runner !== undefined) {
    if (typeof raw.runner !== 'string' || !(SUPPORTED_BACKENDS as readonly string[]).includes(raw.runner)) {
      errors.push(
        fieldError(
          pipelineId,
          'executionDefaults.runner',
          'invalid-enum',
          `Execution default runner must be one of ${SUPPORTED_BACKENDS.join(', ')}`
        )
      );
    } else {
      runner = raw.runner;
    }
  }

  let model: string | undefined;
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model.trim().length === 0) {
      errors.push(
        fieldError(
          pipelineId,
          'executionDefaults.model',
          'non-empty-required',
          'Execution default model must be non-empty'
        )
      );
    } else {
      model = raw.model.trim();
    }
  }

  let effort: PipelineExecutionDefaults['effort'];
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !(PHASE_EFFORT_LEVELS as readonly string[]).includes(raw.effort)) {
      errors.push(
        fieldError(
          pipelineId,
          'executionDefaults.effort',
          'invalid-enum',
          `Execution default effort must be one of ${PHASE_EFFORT_LEVELS.join(', ')}`
        )
      );
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
      errors.push(
        fieldError(
          pipelineId,
          'executionDefaults.timeoutSeconds',
          'invalid-range',
          `Execution default timeoutSeconds must be an integer from ${PIPELINE_TIMEOUT_MIN} to ${PIPELINE_TIMEOUT_MAX}`
        )
      );
    } else {
      timeoutSeconds = raw.timeoutSeconds;
    }
  }

  return Object.freeze({
    ...(runner !== undefined ? { runner } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {})
  });
}

function readRecommendedNext(
  value: Record<string, unknown>,
  pipelineId: string,
  errors: PipelineFieldError[]
): readonly string[] {
  if (value.recommendedNext === undefined) return [];
  if (!Array.isArray(value.recommendedNext)) {
    errors.push(
      fieldError(
        pipelineId,
        'recommendedNext',
        'array-required',
        'Pipeline recommendedNext must be an array'
      )
    );
    return [];
  }
  const next: string[] = [];
  value.recommendedNext.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PIPELINE_ID_PATTERN.test(entry.trim())) {
      errors.push(
        fieldError(
          pipelineId,
          `recommendedNext[${index}]`,
          'invalid-pattern',
          `Recommended next id must match ${PIPELINE_ID_PATTERN.source}`
        )
      );
      return;
    }
    next.push(entry.trim());
  });
  return next;
}

/**
 * Field, port, binding-shape, and execution-default validation for one authored
 * Pipeline row. Cross-reference resolution (Phase existence, binding endpoints,
 * port types across a binding) is a separate pass — see
 * `pipeline-binding-validator.ts` — because it needs the effective Phase catalog.
 */
export function validatePipelineDefinition(
  raw: unknown,
  options: PipelineDefinitionValidationOptions = {}
): PipelineDefinitionValidationResult {
  if (!isPlainObject(raw)) return objectRequiredResult();

  const value = raw;
  const display = recognizedDisplay(value);
  const errors: PipelineFieldError[] = [];
  const hasPortableId = Object.prototype.hasOwnProperty.call(value, 'pipelineId');
  const hasLegacyId = Object.prototype.hasOwnProperty.call(value, 'id');
  const rawId = hasPortableId
    ? value.pipelineId
    : options.allowLegacyId !== false
      ? value.id
      : undefined;
  const pipelineId = typeof rawId === 'string' ? rawId.trim() : '?';

  for (const key of Object.keys(value)) {
    if (!AUTHORED_PIPELINE_FIELDS.has(key)) {
      errors.push(
        fieldError(
          pipelineId,
          key,
          'unknown-field',
          `Unknown authored Pipeline field '${bounded(key, ERROR_FIELD_MAX)}'`
        )
      );
    }
  }
  if (hasPortableId && hasLegacyId) {
    errors.push(
      fieldError(pipelineId, 'pipelineId', 'identity-ambiguous', 'Use pipelineId or legacy id, not both')
    );
  }
  if (typeof rawId !== 'string' || !PIPELINE_ID_PATTERN.test(pipelineId)) {
    errors.push(
      fieldError(
        pipelineId,
        'pipelineId',
        'invalid-pattern',
        `Pipeline id must match ${PIPELINE_ID_PATTERN.source}`
      )
    );
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > PIPELINE_NAME_MAX_LEN) {
    errors.push(
      fieldError(
        pipelineId,
        'name',
        'invalid-length',
        `Pipeline name must contain 1 to ${PIPELINE_NAME_MAX_LEN} characters`
      )
    );
  }

  let description: string | undefined;
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.length > PIPELINE_DESCRIPTION_MAX_LEN) {
      errors.push(
        fieldError(
          pipelineId,
          'description',
          'invalid-length',
          `Pipeline description must be at most ${PIPELINE_DESCRIPTION_MAX_LEN} characters`
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
        pipelineId,
        'version',
        'positive-integer-required',
        'Pipeline version must be a positive integer'
      )
    );
  }

  const phaseIds = readSequence(value, pipelineId, errors);
  const inputs = readInputs(value, pipelineId, errors);
  const outputs = readOutputs(value, pipelineId, errors);
  const bindings = readBindings(value, pipelineId, errors);
  const executionDefaults = readExecutionDefaults(value, pipelineId, errors);
  const recommendedNext = readRecommendedNext(value, pipelineId, errors);

  if (errors.length > 0) {
    return {
      ok: false,
      pipelineId,
      definition: null,
      display,
      errors: Object.freeze(errors)
    };
  }

  const definition: PipelineDefinition = Object.freeze({
    pipelineId,
    name,
    ...(description !== undefined ? { description } : {}),
    version,
    phaseIds: Object.freeze(phaseIds),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    bindings: Object.freeze(bindings),
    ...(executionDefaults !== undefined ? { executionDefaults } : {}),
    recommendedNext: Object.freeze(recommendedNext)
  });
  return {
    ok: true,
    pipelineId,
    definition,
    display,
    errors: Object.freeze([])
  };
}
