import {
  AUTHORED_DECISION_ID_PATTERN, DECISION_FIELD_TYPES, collectTypedConditionLeaves, validateLeafAgainstField, validateTypedCondition,
  type DecisionField, type DecisionFieldType
} from '../contracts/decision-results';
import type { PhaseDefinition } from '../contracts/process-definitions';
import {
  CANDIDATE_AVAILABILITY_POLICIES, CANDIDATE_BUDGET_MODES, CONTROL_CONTRACT_VERSION,
  DEFAULT_REPEAT_ON_EXHAUSTED, FOR_EACH_COLLECTION_SOURCES, FOR_EACH_ON_ITEM_ERROR_POLICIES,
  MAX_CANDIDATES_PER_BLOCK, MAX_CANDIDATE_BLOCK_DISPATCHES, MAX_CANDIDATE_MAX_ATTEMPTS,
  MAX_CANDIDATE_PRIORITY, MAX_CANDIDATE_RETRY_DELAY_MS, MAX_CANDIDATE_RETRY_MULTIPLIER,
  MAX_FOR_EACH_ITEM_KEY_BYTES, MAX_FOR_EACH_MAX_ITEMS, MAX_MONITORING_WINDOW_MS,
  MAX_REPEAT_CARRY_MAPPINGS, MAX_REPEAT_ITERATIONS, MAX_STRICT_USD_LIMIT_MICROUSD,
  MAX_WORKFLOW_DECISION_RESULT_FIELDS, MIN_CANDIDATES_PER_BLOCK, MIN_CANDIDATE_BLOCK_DISPATCHES,
  MIN_CANDIDATE_MAX_ATTEMPTS, MIN_CANDIDATE_PRIORITY, MIN_CANDIDATE_RETRY_DELAY_MS,
  MIN_CANDIDATE_RETRY_MULTIPLIER, MIN_FOR_EACH_MAX_ITEMS, MIN_MONITORING_WINDOW_MS,
  MIN_REPEAT_ITERATIONS, MIN_STRICT_USD_LIMIT_MICROUSD, REPEAT_ON_EXHAUSTED_POLICIES,
  isCandidateAvailabilityPolicy, isForEachItemErrorPolicy, isRepeatExhaustedPolicy,
  resolveCandidateBlockDefaults, resolveCandidateRetryConfig,
  type CandidateAvailabilityPolicy, type CandidateBlockBudget, type CandidateBlockControl,
  type CandidateRetryConfig, type CandidateSpec, type DecisionResultBinding,
  type DecisionResultBindingSource, type ForEachCollectionSource, type ForEachControl,
  type ForEachItemErrorPolicy, type RepeatCarryMapping, type RepeatControl,
  type RepeatExhaustedPolicy, type ResolvedCandidateBlockControl,
  type WorkflowDecisionResultField, type WorkflowDecisionResults, type WorkflowNodeControl
} from '../contracts/workflow-controls';
import {
  WORKFLOW_ID_MAX_LEN, type WorkflowDefinition, type WorkflowFieldError, type WorkflowNode
} from '../contracts/workflow-definitions';
import { PIPELINE_ID_PATTERN } from './pipeline-definition-validator';
import { ancestorSets, reachableFrom, topologicalOrder, type WorkflowGraphEdge } from './workflow-graph';

const ERROR_FIELD_MAX = 48;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 512;

const AUTHORED_CANDIDATE_BLOCK_FIELDS: ReadonlySet<string> = new Set([
  'version', 'kind', 'candidates', 'availabilityPolicy', 'maxDispatches', 'monitoringWindowMs', 'budget'
]);
const AUTHORED_CANDIDATE_SPEC_FIELDS: ReadonlySet<string> = new Set([
  'candidateId', 'nodeId', 'priority', 'maxAttempts', 'retry', 'allowUnverifiedTrial'
]);
const AUTHORED_CANDIDATE_RETRY_FIELDS: ReadonlySet<string> = new Set([
  'initialDelayMs', 'multiplier', 'maxDelayMs'
]);
const AUTHORED_DECISION_RESULTS_FIELDS: ReadonlySet<string> = new Set(['version', 'fields', 'bindings']);
const AUTHORED_DECISION_RESULT_FIELD_KEYS: ReadonlySet<string> = new Set(['fieldId', 'type', 'required']);
const AUTHORED_DECISION_RESULT_BINDING_KEYS: ReadonlySet<string> = new Set(['fieldId', 'source']);
const AUTHORED_REPEAT_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  'version', 'kind', 'maxIterations', 'until', 'carry', 'onExhausted'
]);
const AUTHORED_REPEAT_CARRY_FIELDS: ReadonlySet<string> = new Set(['fieldId', 'inputPortId']);
const AUTHORED_FOR_EACH_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  'version', 'kind', 'collection', 'itemKeyField', 'itemInputPortId', 'maxItems', 'onItemError'
]);
const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function controlError(workflowId: string, field: string, code: string, message: string): WorkflowFieldError {
  return Object.freeze({
    workflowId: bounded(workflowId || '?', WORKFLOW_ID_MAX_LEN),
    field: bounded(field, ERROR_FIELD_MAX),
    code: bounded(code, ERROR_CODE_MAX),
    message: bounded(message, ERROR_MESSAGE_MAX)
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkClosedKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, workflowId: string, fieldPrefix: string, errors: WorkflowFieldError[]): boolean {
  let ok = true;
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key) || !allowed.has(key)) {
      errors.push(controlError(workflowId, `${fieldPrefix}.${key}`, 'unknown-field', `Unknown authored control field '${bounded(key, ERROR_FIELD_MAX)}'`));
      ok = false;
    }
  }
  return ok;
}

function readPortableId(raw: unknown, workflowId: string, field: string, label: string, errors: WorkflowFieldError[]): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!PIPELINE_ID_PATTERN.test(value)) {
    errors.push(controlError(workflowId, field, 'invalid-pattern', `${label} must match ${PIPELINE_ID_PATTERN.source}`));
    return null;
  }
  return value;
}

function readDecisionFieldId(raw: unknown, workflowId: string, field: string, label: string, errors: WorkflowFieldError[]): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!AUTHORED_DECISION_ID_PATTERN.test(value)) {
    errors.push(controlError(workflowId, field, 'invalid-pattern', `${label} must match ${AUTHORED_DECISION_ID_PATTERN.source}`));
    return null;
  }
  return value;
}

function checkControlVersion(rawVersion: unknown, workflowId: string, field: string, errors: WorkflowFieldError[]): boolean {
  if (typeof rawVersion !== 'number' || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
    errors.push(controlError(workflowId, field, 'invalid-version', 'Control version must be positive integer 1'));
    return false;
  }
  if (rawVersion !== CONTROL_CONTRACT_VERSION) {
    errors.push(controlError(workflowId, field, 'unsupported-control-version', `Unsupported control contract version '${rawVersion}'; only version 1 is supported`));
    return false;
  }
  return true;
}

function readIntRange(raw: unknown, min: number, max: number, workflowId: string, field: string, label: string, errors: WorkflowFieldError[]): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    errors.push(controlError(workflowId, field, 'invalid-range', `${label} must be an integer in ${min}..${max}`));
    return null;
  }
  return raw;
}

function readCandidateRetry(raw: unknown, workflowId: string, field: string, errors: WorkflowFieldError[]): CandidateRetryConfig | null {
  if (!isPlainObject(raw)) {
    errors.push(controlError(workflowId, field, 'object-required', 'Candidate retry must be an object'));
    return null;
  }
  let ok = checkClosedKeys(raw, AUTHORED_CANDIDATE_RETRY_FIELDS, workflowId, field, errors);
  let initialDelayMs: number | undefined;
  if (raw.initialDelayMs !== undefined) {
    const v = readIntRange(raw.initialDelayMs, MIN_CANDIDATE_RETRY_DELAY_MS, MAX_CANDIDATE_RETRY_DELAY_MS, workflowId, `${field}.initialDelayMs`, 'Candidate retry initialDelayMs', errors);
    if (v === null) ok = false;
    else initialDelayMs = v;
  }
  let maxDelayMs: number | undefined;
  if (raw.maxDelayMs !== undefined) {
    const v = readIntRange(raw.maxDelayMs, MIN_CANDIDATE_RETRY_DELAY_MS, MAX_CANDIDATE_RETRY_DELAY_MS, workflowId, `${field}.maxDelayMs`, 'Candidate retry maxDelayMs', errors);
    if (v === null) ok = false;
    else maxDelayMs = v;
  }
  let multiplier: number | undefined;
  if (raw.multiplier !== undefined) {
    if (typeof raw.multiplier !== 'number' || !Number.isFinite(raw.multiplier) || raw.multiplier < MIN_CANDIDATE_RETRY_MULTIPLIER || raw.multiplier > MAX_CANDIDATE_RETRY_MULTIPLIER) {
      errors.push(controlError(workflowId, `${field}.multiplier`, 'invalid-range', `Candidate retry multiplier must be a finite number in ${MIN_CANDIDATE_RETRY_MULTIPLIER}..${MAX_CANDIDATE_RETRY_MULTIPLIER}`));
      ok = false;
    } else {
      multiplier = raw.multiplier;
    }
  }
  if (ok) {
    const resolved = resolveCandidateRetryConfig({
      ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
      ...(maxDelayMs !== undefined ? { maxDelayMs } : {}),
      ...(multiplier !== undefined ? { multiplier } : {})
    });
    if (resolved.initialDelayMs > resolved.maxDelayMs) {
      errors.push(controlError(workflowId, `${field}.initialDelayMs`, 'invalid-range', 'Candidate retry initialDelayMs must not exceed maxDelayMs'));
      ok = false;
    }
  }
  if (!ok) return null;
  return Object.freeze({
    ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(maxDelayMs !== undefined ? { maxDelayMs } : {})
  });
}

function readCandidateBudget(raw: unknown, workflowId: string, field: string, errors: WorkflowFieldError[]): CandidateBlockBudget | null {
  if (!isPlainObject(raw)) {
    errors.push(controlError(workflowId, field, 'object-required', 'Candidate budget must be an object'));
    return null;
  }
  if (raw.mode === 'count-only') {
    return checkClosedKeys(raw, new Set(['mode']), workflowId, field, errors)
      ? Object.freeze({ mode: 'count-only' as const })
      : null;
  }
  if (raw.mode === 'strict-usd') {
    const ok = checkClosedKeys(raw, new Set(['mode', 'limitMicrousd']), workflowId, field, errors);
    const limit = readIntRange(raw.limitMicrousd, MIN_STRICT_USD_LIMIT_MICROUSD, MAX_STRICT_USD_LIMIT_MICROUSD, workflowId, `${field}.limitMicrousd`, 'Strict USD limitMicrousd', errors);
    return ok && limit !== null ? Object.freeze({ mode: 'strict-usd' as const, limitMicrousd: limit }) : null;
  }
  errors.push(controlError(workflowId, `${field}.mode`, 'invalid-enum', `Candidate budget mode must be one of ${CANDIDATE_BUDGET_MODES.join(', ')}`));
  return null;
}

export interface CandidateBlockValidationResult {
  readonly ok: boolean;
  readonly value: CandidateBlockControl | null;
  readonly resolved: ResolvedCandidateBlockControl | null;
  readonly errors: readonly WorkflowFieldError[];
}

export function validateCandidateBlockControl(
  raw: unknown,
  workflowId = '?',
  field = 'control'
): CandidateBlockValidationResult {
  const errors: WorkflowFieldError[] = [];
  if (!isPlainObject(raw)) {
    errors.push(controlError(workflowId, field, 'object-required', 'Workflow control must be an object'));
    return { ok: false, value: null, resolved: null, errors: Object.freeze(errors) };
  }
  let ok = checkClosedKeys(raw, AUTHORED_CANDIDATE_BLOCK_FIELDS, workflowId, field, errors);
  if (!checkControlVersion(raw.version, workflowId, `${field}.version`, errors)) ok = false;
  if (raw.kind !== 'candidate-block') {
    errors.push(controlError(workflowId, `${field}.kind`, 'invalid-enum', "Workflow control.kind must be 'candidate-block'"));
    ok = false;
  }

  const candidates: CandidateSpec[] = [];
  if (!Array.isArray(raw.candidates)) {
    errors.push(controlError(workflowId, `${field}.candidates`, 'array-required', 'Candidates must be an array'));
    ok = false;
  } else {
    if (raw.candidates.length < MIN_CANDIDATES_PER_BLOCK || raw.candidates.length > MAX_CANDIDATES_PER_BLOCK) {
      errors.push(controlError(workflowId, `${field}.candidates`, 'invalid-range', `Candidate block must declare ${MIN_CANDIDATES_PER_BLOCK} to ${MAX_CANDIDATES_PER_BLOCK} candidates`));
      ok = false;
    }
    const seenCandidateIds = new Set<string>();
    const seenNodeIds = new Set<string>();
    raw.candidates.forEach((entry, index) => {
      const itemField = `${field}.candidates[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(controlError(workflowId, itemField, 'object-required', 'Candidate entry must be an object'));
        ok = false;
        return;
      }
      let itemOk = checkClosedKeys(entry, AUTHORED_CANDIDATE_SPEC_FIELDS, workflowId, itemField, errors);
      const candidateId = readPortableId(entry.candidateId, workflowId, `${itemField}.candidateId`, 'Candidate id', errors);
      const nodeId = readPortableId(entry.nodeId, workflowId, `${itemField}.nodeId`, 'Candidate nodeId', errors);
      if (candidateId !== null) {
        if (seenCandidateIds.has(candidateId)) {
          errors.push(controlError(workflowId, `${itemField}.candidateId`, 'duplicate-candidate-id', `Candidate id '${bounded(candidateId, WORKFLOW_ID_MAX_LEN)}' is declared more than once`));
          itemOk = false;
        } else seenCandidateIds.add(candidateId);
      }
      if (nodeId !== null) {
        if (seenNodeIds.has(nodeId)) {
          errors.push(controlError(workflowId, `${itemField}.nodeId`, 'duplicate-candidate-node-id', `Candidate nodeId '${bounded(nodeId, WORKFLOW_ID_MAX_LEN)}' is referenced by more than one candidate`));
          itemOk = false;
        } else seenNodeIds.add(nodeId);
      }
      let priority: number | undefined;
      if (entry.priority !== undefined) {
        const v = readIntRange(entry.priority, MIN_CANDIDATE_PRIORITY, MAX_CANDIDATE_PRIORITY, workflowId, `${itemField}.priority`, 'Candidate priority', errors);
        if (v === null) itemOk = false;
        else priority = v;
      }
      let maxAttempts: number | undefined;
      if (entry.maxAttempts !== undefined) {
        const v = readIntRange(entry.maxAttempts, MIN_CANDIDATE_MAX_ATTEMPTS, MAX_CANDIDATE_MAX_ATTEMPTS, workflowId, `${itemField}.maxAttempts`, 'Candidate maxAttempts', errors);
        if (v === null) itemOk = false;
        else maxAttempts = v;
      }
      let retry: CandidateRetryConfig | undefined;
      if (entry.retry !== undefined) {
        const parsedRetry = readCandidateRetry(entry.retry, workflowId, `${itemField}.retry`, errors);
        if (parsedRetry === null) itemOk = false;
        else retry = parsedRetry;
      }
      let allowUnverifiedTrial: boolean | undefined;
      if (entry.allowUnverifiedTrial !== undefined) {
        if (typeof entry.allowUnverifiedTrial !== 'boolean') {
          errors.push(controlError(workflowId, `${itemField}.allowUnverifiedTrial`, 'boolean-required', 'Candidate allowUnverifiedTrial must be boolean'));
          itemOk = false;
        } else allowUnverifiedTrial = entry.allowUnverifiedTrial;
      }
      if (!itemOk || candidateId === null || nodeId === null) {
        ok = false;
        return;
      }
      candidates.push(Object.freeze({
        candidateId,
        nodeId,
        ...(priority !== undefined ? { priority } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(retry !== undefined ? { retry } : {}),
        ...(allowUnverifiedTrial !== undefined ? { allowUnverifiedTrial } : {})
      }));
    });
  }

  let availabilityPolicy: CandidateAvailabilityPolicy | undefined;
  if (raw.availabilityPolicy !== undefined) {
    if (!isCandidateAvailabilityPolicy(raw.availabilityPolicy)) {
      errors.push(controlError(workflowId, `${field}.availabilityPolicy`, 'invalid-enum', `Candidate availabilityPolicy must be one of ${CANDIDATE_AVAILABILITY_POLICIES.join(', ')}`));
      ok = false;
    } else availabilityPolicy = raw.availabilityPolicy;
  }

  let maxDispatches: number | undefined;
  if (raw.maxDispatches !== undefined) {
    const v = readIntRange(raw.maxDispatches, MIN_CANDIDATE_BLOCK_DISPATCHES, MAX_CANDIDATE_BLOCK_DISPATCHES, workflowId, `${field}.maxDispatches`, 'Candidate block maxDispatches', errors);
    if (v === null) ok = false;
    else maxDispatches = v;
  }

  let monitoringWindowMs: number | undefined;
  if (raw.monitoringWindowMs !== undefined) {
    const v = readIntRange(raw.monitoringWindowMs, MIN_MONITORING_WINDOW_MS, MAX_MONITORING_WINDOW_MS, workflowId, `${field}.monitoringWindowMs`, 'Candidate block monitoringWindowMs', errors);
    if (v === null) ok = false;
    else monitoringWindowMs = v;
  }

  let budget: CandidateBlockBudget | undefined;
  if (raw.budget !== undefined) {
    const parsedBudget = readCandidateBudget(raw.budget, workflowId, `${field}.budget`, errors);
    if (parsedBudget === null) ok = false;
    else budget = parsedBudget;
  }

  if (!ok) return { ok: false, value: null, resolved: null, errors: Object.freeze(errors) };

  const value: CandidateBlockControl = Object.freeze({
    version: CONTROL_CONTRACT_VERSION,
    kind: 'candidate-block',
    candidates: Object.freeze(candidates),
    ...(availabilityPolicy !== undefined ? { availabilityPolicy } : {}),
    ...(maxDispatches !== undefined ? { maxDispatches } : {}),
    ...(monitoringWindowMs !== undefined ? { monitoringWindowMs } : {}),
    ...(budget !== undefined ? { budget } : {})
  });
  return { ok: true, value, resolved: resolveCandidateBlockDefaults(value), errors: Object.freeze([]) };
}

export function validateCandidateBlockGraphStructure(
  workflowId: string,
  control: CandidateBlockControl,
  nodes: readonly WorkflowNode[],
  connections: readonly unknown[],
  startNodeIds: readonly string[],
  errors: WorkflowFieldError[]
): void {
  if (connections.length > 0) {
    errors.push(controlError(workflowId, 'connections', 'candidate-connections-forbidden', 'A candidate-block Workflow must declare connections: []'));
  }
  const nodeById = new Map<string, WorkflowNode>();
  nodes.forEach((node, index) => {
    nodeById.set(node.nodeId, node);
    const isPhase = node.kind === 'phase' || (node.kind === undefined && node.phaseId !== undefined);
    if (!isPhase) {
      errors.push(controlError(workflowId, `nodes[${index}].kind`, 'candidate-node-kind-invalid', 'A candidate-block Workflow may contain only Phase nodes'));
    }
  });
  const candidateNodeIds = control.candidates.map((c) => c.nodeId);
  const candidateNodeIdSet = new Set(candidateNodeIds);
  control.candidates.forEach((candidate, index) => {
    if (!nodeById.has(candidate.nodeId)) {
      errors.push(controlError(workflowId, `control.candidates[${index}].nodeId`, 'candidate-node-missing', `Candidate '${candidate.candidateId}' references node '${candidate.nodeId}', which is not in nodes`));
    }
  });
  nodes.forEach((node, index) => {
    if (!candidateNodeIdSet.has(node.nodeId)) {
      errors.push(controlError(workflowId, `nodes[${index}].nodeId`, 'unreferenced-candidate-node', `Node '${node.nodeId}' in a candidate-block Workflow is not referenced by any candidate`));
    }
  });
  const startMatches = startNodeIds.length === candidateNodeIds.length && startNodeIds.every((id, index) => id === candidateNodeIds[index]);
  if (!startMatches) {
    errors.push(controlError(workflowId, 'startNodeIds', 'candidate-start-nodes-mismatch', 'Candidate-block startNodeIds must equal candidate nodeIds in authored candidate order'));
  }
}

export function validateWorkflowDecisionResults(
  raw: unknown,
  workflowId: string,
  hasCandidateBlockControl: boolean,
  field = 'decisionResults'
): { readonly ok: boolean; readonly value: WorkflowDecisionResults | null; readonly errors: readonly WorkflowFieldError[] } {
  const errors: WorkflowFieldError[] = [];
  if (!isPlainObject(raw)) {
    errors.push(controlError(workflowId, field, 'object-required', 'Workflow decisionResults must be an object'));
    return { ok: false, value: null, errors: Object.freeze(errors) };
  }
  let ok = checkClosedKeys(raw, AUTHORED_DECISION_RESULTS_FIELDS, workflowId, field, errors);
  if (!checkControlVersion(raw.version, workflowId, `${field}.version`, errors)) ok = false;

  const fields: WorkflowDecisionResultField[] = [];
  const declaredById = new Map<string, WorkflowDecisionResultField>();
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    errors.push(controlError(workflowId, `${field}.fields`, 'non-empty-required', 'Workflow decisionResults.fields must be a non-empty array'));
    ok = false;
  } else {
    if (raw.fields.length > MAX_WORKFLOW_DECISION_RESULT_FIELDS) {
      errors.push(controlError(workflowId, `${field}.fields`, 'invalid-range', `Workflow decisionResults.fields must contain at most ${MAX_WORKFLOW_DECISION_RESULT_FIELDS} fields`));
      ok = false;
    }
    raw.fields.forEach((entry, index) => {
      const itemField = `${field}.fields[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(controlError(workflowId, itemField, 'object-required', 'Decision result field must be an object'));
        ok = false;
        return;
      }
      let itemOk = checkClosedKeys(entry, AUTHORED_DECISION_RESULT_FIELD_KEYS, workflowId, itemField, errors);
      const fieldId = readDecisionFieldId(entry.fieldId, workflowId, `${itemField}.fieldId`, 'Decision result fieldId', errors);
      if (fieldId !== null && declaredById.has(fieldId)) {
        errors.push(controlError(workflowId, `${itemField}.fieldId`, 'duplicate-field-id', `Decision result fieldId '${bounded(fieldId, WORKFLOW_ID_MAX_LEN)}' is declared more than once`));
        itemOk = false;
      }
      const validType = typeof entry.type === 'string' && (DECISION_FIELD_TYPES as readonly string[]).includes(entry.type);
      if (!validType) {
        errors.push(controlError(workflowId, `${itemField}.type`, 'invalid-enum', `Decision result field type must be one of ${DECISION_FIELD_TYPES.join(', ')}`));
        itemOk = false;
      }
      let required = true;
      if (entry.required !== undefined) {
        if (typeof entry.required !== 'boolean') {
          errors.push(controlError(workflowId, `${itemField}.required`, 'boolean-required', 'Decision result field required flag must be boolean'));
          itemOk = false;
        } else required = entry.required;
      }
      if (!itemOk || fieldId === null || !validType) {
        ok = false;
        return;
      }
      const normalizedField: WorkflowDecisionResultField = Object.freeze({ fieldId, type: entry.type as DecisionFieldType, required });
      declaredById.set(fieldId, normalizedField);
      fields.push(normalizedField);
    });
  }

  const bindings: DecisionResultBinding[] = [];
  if (!Array.isArray(raw.bindings)) {
    errors.push(controlError(workflowId, `${field}.bindings`, 'array-required', 'Workflow decisionResults.bindings must be an array'));
    ok = false;
  } else {
    raw.bindings.forEach((entry, index) => {
      const itemField = `${field}.bindings[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(controlError(workflowId, itemField, 'object-required', 'Decision result binding must be an object'));
        ok = false;
        return;
      }
      let itemOk = checkClosedKeys(entry, AUTHORED_DECISION_RESULT_BINDING_KEYS, workflowId, itemField, errors);
      const fieldId = readDecisionFieldId(entry.fieldId, workflowId, `${itemField}.fieldId`, 'Binding fieldId', errors);
      if (fieldId !== null && declaredById.size > 0 && !declaredById.has(fieldId)) {
        errors.push(controlError(workflowId, `${itemField}.fieldId`, 'unknown-decision-result-field', `Binding references undeclared decision result field '${bounded(fieldId, WORKFLOW_ID_MAX_LEN)}'`));
        itemOk = false;
      }
      let source: DecisionResultBindingSource | null = null;
      if (!isPlainObject(entry.source)) {
        errors.push(controlError(workflowId, `${itemField}.source`, 'object-required', 'Decision result binding source must be an object'));
        itemOk = false;
      } else if (entry.source.kind === 'selected-candidate') {
        const sourceOk = checkClosedKeys(entry.source, new Set(['kind', 'fieldId']), workflowId, `${itemField}.source`, errors);
        if (!hasCandidateBlockControl) {
          errors.push(controlError(workflowId, `${itemField}.source.kind`, 'invalid-decision-result-binding-source', "A 'selected-candidate' binding source is valid only on a candidate-block Workflow"));
          itemOk = false;
        }
        const sourceFieldId = readDecisionFieldId(entry.source.fieldId, workflowId, `${itemField}.source.fieldId`, 'Selected-candidate fieldId', errors);
        if (sourceOk && sourceFieldId !== null) source = Object.freeze({ kind: 'selected-candidate' as const, fieldId: sourceFieldId });
        else itemOk = false;
      } else if (entry.source.kind === 'node-result') {
        const sourceOk = checkClosedKeys(entry.source, new Set(['kind', 'nodeId', 'fieldId']), workflowId, `${itemField}.source`, errors);
        if (hasCandidateBlockControl) {
          errors.push(controlError(workflowId, `${itemField}.source.kind`, 'invalid-decision-result-binding-source', "A candidate-block Workflow must bind decisionResults from 'selected-candidate', not 'node-result'"));
          itemOk = false;
        }
        const sourceNodeId = readPortableId(entry.source.nodeId, workflowId, `${itemField}.source.nodeId`, 'Binding source nodeId', errors);
        const sourceFieldId = readDecisionFieldId(entry.source.fieldId, workflowId, `${itemField}.source.fieldId`, 'Binding source fieldId', errors);
        if (sourceOk && sourceNodeId !== null && sourceFieldId !== null) {
          source = Object.freeze({ kind: 'node-result' as const, nodeId: sourceNodeId, fieldId: sourceFieldId });
        } else itemOk = false;
      } else {
        errors.push(controlError(workflowId, `${itemField}.source.kind`, 'invalid-enum', "Decision result binding source.kind must be 'node-result' or 'selected-candidate'"));
        itemOk = false;
      }
      if (!itemOk || fieldId === null || source === null) {
        ok = false;
        return;
      }
      bindings.push(Object.freeze({ fieldId, source }));
    });
  }

  if (!ok) return { ok: false, value: null, errors: Object.freeze(errors) };
  return {
    ok: true,
    value: Object.freeze({ version: CONTROL_CONTRACT_VERSION, fields: Object.freeze(fields), bindings: Object.freeze(bindings) }),
    errors: Object.freeze([])
  };
}

export function validateWorkflowNodeControl(
  raw: unknown,
  workflowId: string,
  field: string
): { readonly ok: boolean; readonly value: WorkflowNodeControl | null; readonly errors: readonly WorkflowFieldError[] } {
  const errors: WorkflowFieldError[] = [];
  if (!isPlainObject(raw)) {
    errors.push(controlError(workflowId, field, 'object-required', 'Node control must be an object'));
    return { ok: false, value: null, errors: Object.freeze(errors) };
  }

  if (raw.kind === 'repeat') {
    let ok = checkClosedKeys(raw, AUTHORED_REPEAT_CONTROL_FIELDS, workflowId, field, errors);
    if (!checkControlVersion(raw.version, workflowId, `${field}.version`, errors)) ok = false;
    const maxIterations = readIntRange(raw.maxIterations, MIN_REPEAT_ITERATIONS, MAX_REPEAT_ITERATIONS, workflowId, `${field}.maxIterations`, 'Repeat maxIterations', errors);
    if (maxIterations === null) ok = false;

    const untilResult = validateTypedCondition(raw.until, `${field}.until`, { scope: 'repeat-until' });
    if (!untilResult.ok) {
      for (const defect of untilResult.errors) errors.push(controlError(workflowId, defect.field, defect.code, defect.message));
      ok = false;
    }

    const carry: RepeatCarryMapping[] = [];
    if (raw.carry !== undefined) {
      if (!Array.isArray(raw.carry)) {
        errors.push(controlError(workflowId, `${field}.carry`, 'array-required', 'Repeat carry must be an array'));
        ok = false;
      } else {
        if (raw.carry.length > MAX_REPEAT_CARRY_MAPPINGS) {
          errors.push(controlError(workflowId, `${field}.carry`, 'invalid-range', `Repeat carry must contain at most ${MAX_REPEAT_CARRY_MAPPINGS} mappings`));
          ok = false;
        }
        const seenInputPorts = new Set<string>();
        raw.carry.forEach((entry, index) => {
          const itemField = `${field}.carry[${index}]`;
          if (!isPlainObject(entry)) {
            errors.push(controlError(workflowId, itemField, 'object-required', 'Repeat carry mapping must be an object'));
            ok = false;
            return;
          }
          let itemOk = checkClosedKeys(entry, AUTHORED_REPEAT_CARRY_FIELDS, workflowId, itemField, errors);
          const fieldId = readDecisionFieldId(entry.fieldId, workflowId, `${itemField}.fieldId`, 'Carry fieldId', errors);
          const inputPortId = readPortableId(entry.inputPortId, workflowId, `${itemField}.inputPortId`, 'Carry inputPortId', errors);
          if (inputPortId !== null) {
            if (seenInputPorts.has(inputPortId)) {
              errors.push(controlError(workflowId, `${itemField}.inputPortId`, 'duplicate-carry-target', `Repeat carry inputPortId '${bounded(inputPortId, WORKFLOW_ID_MAX_LEN)}' is mapped more than once`));
              itemOk = false;
            } else seenInputPorts.add(inputPortId);
          }
          if (!itemOk || fieldId === null || inputPortId === null) {
            ok = false;
            return;
          }
          carry.push(Object.freeze({ fieldId, inputPortId }));
        });
      }
    }

    let onExhausted: RepeatExhaustedPolicy = DEFAULT_REPEAT_ON_EXHAUSTED;
    if (raw.onExhausted !== undefined) {
      if (!isRepeatExhaustedPolicy(raw.onExhausted)) {
        errors.push(controlError(workflowId, `${field}.onExhausted`, 'invalid-enum', `Repeat onExhausted must be one of ${REPEAT_ON_EXHAUSTED_POLICIES.join(', ')}`));
        ok = false;
      } else onExhausted = raw.onExhausted;
    }

    if (!ok || maxIterations === null || !untilResult.ok) {
      return { ok: false, value: null, errors: Object.freeze(errors) };
    }
    return {
      ok: true,
      value: Object.freeze({ version: CONTROL_CONTRACT_VERSION, kind: 'repeat', maxIterations, until: untilResult.value, carry: Object.freeze(carry), onExhausted }),
      errors: Object.freeze([])
    };
  }

  if (raw.kind === 'for-each') {
    let ok = checkClosedKeys(raw, AUTHORED_FOR_EACH_CONTROL_FIELDS, workflowId, field, errors);
    if (!checkControlVersion(raw.version, workflowId, `${field}.version`, errors)) ok = false;

    let collection: ForEachCollectionSource | null = null;
    if (!isPlainObject(raw.collection)) {
      errors.push(controlError(workflowId, `${field}.collection`, 'object-required', 'ForEach collection must be an object'));
      ok = false;
    } else if (raw.collection.source === 'workflow-input') {
      const colOk = checkClosedKeys(raw.collection, new Set(['source', 'portId']), workflowId, `${field}.collection`, errors);
      const portId = readPortableId(raw.collection.portId, workflowId, `${field}.collection.portId`, 'Collection workflow-input portId', errors);
      if (colOk && portId !== null) collection = Object.freeze({ source: 'workflow-input' as const, portId });
      else ok = false;
    } else if (raw.collection.source === 'node-output') {
      const colOk = checkClosedKeys(raw.collection, new Set(['source', 'nodeId', 'portId']), workflowId, `${field}.collection`, errors);
      const nodeId = readPortableId(raw.collection.nodeId, workflowId, `${field}.collection.nodeId`, 'Collection nodeId', errors);
      const portId = readPortableId(raw.collection.portId, workflowId, `${field}.collection.portId`, 'Collection portId', errors);
      if (colOk && nodeId !== null && portId !== null) collection = Object.freeze({ source: 'node-output' as const, nodeId, portId });
      else ok = false;
    } else {
      errors.push(controlError(workflowId, `${field}.collection.source`, 'invalid-enum', `ForEach collection.source must be one of ${FOR_EACH_COLLECTION_SOURCES.join(', ')}`));
      ok = false;
    }

    let itemKeyField: string | undefined;
    if (raw.itemKeyField !== undefined) {
      if (typeof raw.itemKeyField !== 'string' || raw.itemKeyField.trim().length === 0 || Buffer.byteLength(raw.itemKeyField.trim(), 'utf8') > MAX_FOR_EACH_ITEM_KEY_BYTES || !AUTHORED_DECISION_ID_PATTERN.test(raw.itemKeyField.trim())) {
        errors.push(controlError(workflowId, `${field}.itemKeyField`, 'invalid-pattern', `ForEach itemKeyField must match ${AUTHORED_DECISION_ID_PATTERN.source}`));
        ok = false;
      } else itemKeyField = raw.itemKeyField.trim();
    }

    const itemInputPortId = readPortableId(raw.itemInputPortId, workflowId, `${field}.itemInputPortId`, 'ForEach itemInputPortId', errors);
    if (itemInputPortId === null) ok = false;

    let maxItems: number | undefined;
    if (raw.maxItems !== undefined) {
      const v = readIntRange(raw.maxItems, MIN_FOR_EACH_MAX_ITEMS, MAX_FOR_EACH_MAX_ITEMS, workflowId, `${field}.maxItems`, 'ForEach maxItems', errors);
      if (v === null) ok = false;
      else maxItems = v;
    }

    let onItemError: ForEachItemErrorPolicy | undefined;
    if (raw.onItemError !== undefined) {
      if (!isForEachItemErrorPolicy(raw.onItemError)) {
        errors.push(controlError(workflowId, `${field}.onItemError`, 'invalid-enum', `ForEach onItemError must be one of ${FOR_EACH_ON_ITEM_ERROR_POLICIES.join(', ')}`));
        ok = false;
      } else onItemError = raw.onItemError;
    }

    if (!ok || collection === null || itemInputPortId === null) {
      return { ok: false, value: null, errors: Object.freeze(errors) };
    }
    return {
      ok: true,
      value: Object.freeze({
        version: CONTROL_CONTRACT_VERSION,
        kind: 'for-each',
        collection,
        ...(itemKeyField !== undefined ? { itemKeyField } : {}),
        itemInputPortId,
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(onItemError !== undefined ? { onItemError } : {})
      }),
      errors: Object.freeze([])
    };
  }

  errors.push(controlError(workflowId, `${field}.kind`, 'invalid-enum', "Node control.kind must be 'repeat' or 'for-each'"));
  return { ok: false, value: null, errors: Object.freeze(errors) };
}

export interface ControlGraphValidationInput {
  readonly definition: WorkflowDefinition;
  readonly acyclic: boolean;
  readonly edges: readonly WorkflowGraphEdge[];
  readonly phasesById: ReadonlyMap<string, PhaseDefinition>;
  readonly workflowsById: ReadonlyMap<string, WorkflowDefinition>;
}

export function validateWorkflowControlsInGraph(input: ControlGraphValidationInput): readonly WorkflowFieldError[] {
  const errors: WorkflowFieldError[] = [];
  const { definition, acyclic, edges, phasesById, workflowsById } = input;
  const wfId = definition.workflowId;

  if (definition.control !== undefined) {
    validateCandidateBlockCrossTargets(definition, phasesById, errors);
  }
  if (definition.decisionResults !== undefined) {
    if (definition.control !== undefined) {
      validateCandidateBlockDecisionResults(definition, phasesById, errors);
    } else {
      validateOrdinaryWorkflowDecisionResults(definition, acyclic, edges, phasesById, workflowsById, errors);
    }
  }

  const ancestors = acyclic
    ? ancestorSets(topologicalOrder(definition.nodes.map((n) => n.nodeId), edges).order, edges)
    : null;

  definition.nodes.forEach((node, index) => {
    if (node.control === undefined) return;
    const field = `nodes[${index}].control`;
    const isWorkflowNode = node.kind === 'workflow' || (node.kind === undefined && node.workflowId !== undefined);
    if (!isWorkflowNode || node.workflowId === undefined) {
      errors.push(controlError(wfId, field, 'control-requires-workflow-node', 'Repeat and ForEach controls are allowed only on child-Workflow nodes'));
      return;
    }
    const targetWorkflow = workflowsById.get(node.workflowId);
    if (node.control.kind === 'repeat') {
      validateRepeatNodeCrossTargets(definition, node.control, targetWorkflow, field, errors);
    } else {
      validateForEachNodeCrossTargets(definition, node, node.control, targetWorkflow, workflowsById, ancestors, field, errors);
    }
  });

  return Object.freeze(errors);
}

function validateCandidateBlockCrossTargets(
  definition: WorkflowDefinition,
  phasesById: ReadonlyMap<string, PhaseDefinition>,
  errors: WorkflowFieldError[]
): void {
  const wfId = definition.workflowId;
  const control = definition.control;
  if (!control) return;

  validateCandidateBlockGraphStructure(wfId, control, definition.nodes, definition.connections, definition.startNodeIds, errors);

  const nodeById = new Map(definition.nodes.map((n) => [n.nodeId, n]));
  const candidateNodeIds = new Set(control.candidates.map((c) => c.nodeId));

  control.candidates.forEach((candidate, index) => {
    const node = nodeById.get(candidate.nodeId);
    if (!node || node.phaseId === undefined) return;
    const phase = phasesById.get(node.phaseId);
    if (!phase) return;
    if (phase.resultContract === undefined) {
      errors.push(controlError(wfId, `control.candidates[${index}].nodeId`, 'candidate-missing-result-contract', `Candidate '${candidate.candidateId}' Phase '${phase.phaseId}' must declare a resultContract`));
    }
    if (phase.retryCondition !== undefined && phase.retryCondition.trim().length > 0) {
      errors.push(controlError(wfId, `control.candidates[${index}].nodeId`, 'candidate-legacy-retry-condition', `Candidate '${candidate.candidateId}' Phase '${phase.phaseId}' cannot declare a legacy retryCondition`));
    }
  });

  const declaredInputPortIds = new Set((definition.inputs ?? []).map((p) => p.portId));
  const declaredOutputPortIds = new Set((definition.outputs ?? []).map((p) => p.portId));
  const bindings = definition.bindings ?? [];
  const inputBindingsByNodeAndPort = new Map<string, string>();
  const outputBindingsByNodeAndPort = new Map<string, number>();

  bindings.forEach((binding, index) => {
    if (!nodeById.has(binding.nodeId)) {
      errors.push(controlError(wfId, `bindings[${index}].nodeId`, 'unknown-node', `Binding nodeId '${binding.nodeId}' is not declared in workflow.nodes`));
    }
    if (binding.kind === 'input') {
      if (binding.source.from === 'node-output') {
        errors.push(controlError(wfId, `bindings[${index}].source`, 'cross-candidate-input-binding', 'Candidate-block input bindings must read from workflow-input, never node-output'));
        return;
      }
      if (!declaredInputPortIds.has(binding.source.portId)) {
        errors.push(controlError(wfId, `bindings[${index}].source.portId`, 'unknown-input-port', `Candidate-block input binding references undeclared Workflow input port '${binding.source.portId}'`));
      }
      inputBindingsByNodeAndPort.set(`${binding.nodeId}:${binding.source.portId}`, binding.inputKey);
    } else {
      if (!declaredOutputPortIds.has(binding.portId)) {
        errors.push(controlError(wfId, `bindings[${index}].portId`, 'unknown-output-port', `Candidate-block output binding references undeclared Workflow output port '${binding.portId}'`));
      }
      const key = `${binding.nodeId}:${binding.portId}`;
      const count = (outputBindingsByNodeAndPort.get(key) ?? 0) + 1;
      outputBindingsByNodeAndPort.set(key, count);
      if (count > 1) {
        errors.push(controlError(wfId, `bindings[${index}].portId`, 'duplicate-candidate-output-binding', `Candidate node '${binding.nodeId}' declares more than one output binding for '${binding.portId}'`));
      }
    }
  });

  for (const inputPort of definition.inputs ?? []) {
    if (inputPort.required === false) continue;
    for (const candidate of control.candidates) {
      if (!candidateNodeIds.has(candidate.nodeId)) continue;
      if (!inputBindingsByNodeAndPort.has(`${candidate.nodeId}:${inputPort.portId}`)) {
        errors.push(controlError(wfId, 'bindings', 'missing-candidate-input-binding', `Candidate '${candidate.candidateId}' (node '${candidate.nodeId}') does not bind required Workflow input '${inputPort.portId}'`));
      }
    }
  }

  for (const outputPort of definition.outputs ?? []) {
    if (outputPort.required === false) continue;
    for (const candidate of control.candidates) {
      if (!candidateNodeIds.has(candidate.nodeId)) continue;
      if (!outputBindingsByNodeAndPort.has(`${candidate.nodeId}:${outputPort.portId}`)) {
        errors.push(controlError(wfId, 'bindings', 'missing-candidate-output-binding', `Candidate '${candidate.candidateId}' (node '${candidate.nodeId}') does not bind required Workflow output '${outputPort.portId}'`));
      }
    }
  }
}

function validateCandidateBlockDecisionResults(
  definition: WorkflowDefinition,
  phasesById: ReadonlyMap<string, PhaseDefinition>,
  errors: WorkflowFieldError[]
): void {
  const wfId = definition.workflowId;
  const { control, decisionResults } = definition;
  if (!control || !decisionResults) return;
  const nodeById = new Map(definition.nodes.map((n) => [n.nodeId, n]));
  const bindingsByFieldId = new Map<string, DecisionResultBinding>();
  decisionResults.bindings.forEach((binding, index) => {
    if (bindingsByFieldId.has(binding.fieldId)) {
      errors.push(controlError(wfId, `decisionResults.bindings[${index}].fieldId`, 'duplicate-decision-result-binding', `Decision result field '${binding.fieldId}' is bound more than once in candidate block`));
      return;
    }
    bindingsByFieldId.set(binding.fieldId, binding);
  });
  decisionResults.fields.forEach((wfField, fieldIndex) => {
    const binding = bindingsByFieldId.get(wfField.fieldId);
    if (!binding) {
      if (wfField.required) errors.push(controlError(wfId, `decisionResults.fields[${fieldIndex}].fieldId`, 'missing-decision-result-binding', `Required decision result field '${wfField.fieldId}' has no binding`));
      return;
    }
    if (binding.source.kind !== 'selected-candidate') return;
    const sourceFieldId = binding.source.fieldId;
    for (const candidate of control.candidates) {
      const node = nodeById.get(candidate.nodeId);
      const phase = node?.phaseId !== undefined ? phasesById.get(node.phaseId) : undefined;
      if (!phase?.resultContract) continue;
      const candidateField = phase.resultContract.fields.find((f) => f.fieldId === sourceFieldId);
      if (!candidateField) {
        if (wfField.required) errors.push(controlError(wfId, `decisionResults.fields[${fieldIndex}].fieldId`, 'candidate-result-field-mismatch', `Candidate '${candidate.candidateId}' Phase '${phase.phaseId}' does not declare required decision result field '${sourceFieldId}'`));
        continue;
      }
      if (candidateField.type !== wfField.type) errors.push(controlError(wfId, `decisionResults.fields[${fieldIndex}].type`, 'candidate-result-field-mismatch', `Candidate '${candidate.candidateId}' field '${sourceFieldId}' has type '${candidateField.type}', expected '${wfField.type}'`));
      if (wfField.required && !candidateField.required) errors.push(controlError(wfId, `decisionResults.fields[${fieldIndex}].required`, 'candidate-result-field-mismatch', `Candidate '${candidate.candidateId}' field '${sourceFieldId}' is optional, but Workflow field '${wfField.fieldId}' is required`));
    }
  });
}

function validateOrdinaryWorkflowDecisionResults(
  definition: WorkflowDefinition,
  acyclic: boolean,
  edges: readonly WorkflowGraphEdge[],
  phasesById: ReadonlyMap<string, PhaseDefinition>,
  workflowsById: ReadonlyMap<string, WorkflowDefinition>,
  errors: WorkflowFieldError[]
): void {
  const wfId = definition.workflowId;
  const decisionResults = definition.decisionResults;
  if (!decisionResults) return;
  const nodeById = new Map(definition.nodes.map((n) => [n.nodeId, n]));
  const declaredById = new Map(decisionResults.fields.map((f) => [f.fieldId, f]));
  const producersByFieldId = new Map<string, string[]>();

  decisionResults.bindings.forEach((binding, index) => {
    const fieldPath = `decisionResults.bindings[${index}]`;
    const wfField = declaredById.get(binding.fieldId);
    if (!wfField || binding.source.kind !== 'node-result') return;
    const sourceNode = nodeById.get(binding.source.nodeId);
    if (!sourceNode) {
      errors.push(controlError(wfId, `${fieldPath}.source.nodeId`, 'unresolved-endpoint', `Decision result binding references node '${binding.source.nodeId}', which this Workflow does not declare`));
      return;
    }
    const list = producersByFieldId.get(binding.fieldId) ?? [];
    list.push(binding.source.nodeId);
    producersByFieldId.set(binding.fieldId, list);
    const sourceFields = sourceNode.phaseId !== undefined
      ? phasesById.get(sourceNode.phaseId)?.resultContract?.fields
      : sourceNode.workflowId !== undefined
        ? workflowsById.get(sourceNode.workflowId)?.decisionResults?.fields
        : undefined;
    if (sourceFields === undefined) {
      errors.push(controlError(wfId, `${fieldPath}.source.fieldId`, 'unknown-decision-result-field', `Node '${binding.source.nodeId}' declares no decision result contract for field '${binding.source.fieldId}'`));
      return;
    }
    const sourceField = sourceFields.find((f) => f.fieldId === binding.source.fieldId);
    if (!sourceField) {
      errors.push(controlError(wfId, `${fieldPath}.source.fieldId`, 'unknown-decision-result-field', `Node '${binding.source.nodeId}' declares no decision result field '${binding.source.fieldId}'`));
      return;
    }
    if (sourceField.type !== wfField.type) errors.push(controlError(wfId, `${fieldPath}.source.fieldId`, 'decision-result-type-mismatch', `Node '${binding.source.nodeId}' field '${binding.source.fieldId}' has type '${sourceField.type}', expected '${wfField.type}'`));
    if (wfField.required && !sourceField.required) errors.push(controlError(wfId, `${fieldPath}.source.fieldId`, 'decision-result-optional-source', `Node '${binding.source.nodeId}' field '${binding.source.fieldId}' is optional, but Workflow field '${wfField.fieldId}' is required`));
  });

  if (!acyclic) return;
  for (const [fieldId, producerNodes] of producersByFieldId) {
    for (const [i, a] of producerNodes.entries()) {
      const reachedFromA = reachableFrom([a], edges);
      for (const b of producerNodes.slice(i + 1)) {
        if (a === b || reachedFromA.has(b) || reachableFrom([b], edges).has(a)) {
          errors.push(controlError(wfId, 'decisionResults.bindings', 'ambiguous-decision-result-binding', `Decision result field '${fieldId}' has multiple bindings ('${a}', '${b}') on the same execution route`));
        }
      }
    }
  }

  const starts = definition.startNodeIds.filter((id) => nodeById.has(id));
  if (starts.length === 0) return;

  const outgoingByNode = new Map<string, string[]>();
  const returnSources = new Set<string>();
  for (const id of nodeById.keys()) outgoingByNode.set(id, []);
  for (const conn of definition.connections) {
    if (!nodeById.has(conn.from.nodeId)) continue;
    const isRet = conn.to.kind === 'return' || (conn.to.nodeId === 'return' && !nodeById.has('return'));
    if (isRet) returnSources.add(conn.from.nodeId);
    else if (nodeById.has(conn.to.nodeId)) outgoingByNode.get(conn.from.nodeId)?.push(conn.to.nodeId);
  }

  function reachesReturnAvoiding(blocked: ReadonlySet<string>): boolean {
    const seen = new Set<string>();
    const pending = starts.filter((s) => !blocked.has(s));
    while (pending.length > 0) {
      const curr = pending.pop();
      if (curr === undefined || seen.has(curr)) continue;
      seen.add(curr);
      const next = outgoingByNode.get(curr) ?? [];
      if (returnSources.has(curr) || next.length === 0) return true;
      for (const n of next) {
        if (!blocked.has(n) && !seen.has(n)) pending.push(n);
      }
    }
    return false;
  }

  decisionResults.fields.forEach((wfField, index) => {
    if (!wfField.required) return;
    const producers = new Set(producersByFieldId.get(wfField.fieldId) ?? []);
    if (producers.size === 0 || reachesReturnAvoiding(producers)) {
      errors.push(controlError(wfId, `decisionResults.fields[${index}].fieldId`, 'missing-decision-result-on-branch', `Required Workflow decisionResult '${wfField.fieldId}' is not bound on every reachable return branch`));
    }
  });
}

function validateRepeatNodeCrossTargets(
  definition: WorkflowDefinition,
  control: RepeatControl,
  targetWorkflow: WorkflowDefinition | undefined,
  field: string,
  errors: WorkflowFieldError[]
): void {
  const wfId = definition.workflowId;
  if (!targetWorkflow) return;
  const childFields = targetWorkflow.decisionResults?.fields ?? [];
  const childFieldById = new Map<string, DecisionField>(
    childFields.map((f) => [f.fieldId, { fieldId: f.fieldId, type: f.type, required: f.required, selector: [f.fieldId] }])
  );
  const leaves = collectTypedConditionLeaves(control.until, `${field}.until`);
  for (const { leaf, fieldPath } of leaves) {
    if (leaf.left.source !== 'result-field') {
      errors.push(controlError(wfId, `${fieldPath}.left.source`, 'condition-operand-unknown', "Repeat until condition operands must use source 'result-field'"));
      continue;
    }
    const declared = childFieldById.get(leaf.left.fieldId);
    if (!declared) {
      errors.push(controlError(wfId, `${fieldPath}.left.fieldId`, 'condition-operand-unknown', `Repeat body Workflow '${targetWorkflow.workflowId}' declares no decisionResult field '${leaf.left.fieldId}'`));
      continue;
    }
    for (const defect of validateLeafAgainstField(leaf, declared, fieldPath)) {
      errors.push(controlError(wfId, defect.field, defect.code, defect.message));
    }
  }
  const childInputsById = new Map((targetWorkflow.inputs ?? []).map((p) => [p.portId, p]));
  control.carry.forEach((mapping, index) => {
    const carryField = `${field}.carry[${index}]`;
    if (!childFieldById.has(mapping.fieldId)) {
      errors.push(controlError(wfId, `${carryField}.fieldId`, 'unknown-carry-field', `Repeat carry references undeclared decisionResult field '${mapping.fieldId}' on '${targetWorkflow.workflowId}'`));
    }
    const inputPort = childInputsById.get(mapping.inputPortId);
    if (!inputPort) {
      errors.push(controlError(wfId, `${carryField}.inputPortId`, 'invalid-carry-input-port', `Repeat body Workflow '${targetWorkflow.workflowId}' declares no input port '${mapping.inputPortId}'`));
    } else if (inputPort.type !== 'text') {
      errors.push(controlError(wfId, `${carryField}.inputPortId`, 'invalid-carry-input-port', `Repeat carry inputPortId '${mapping.inputPortId}' on '${targetWorkflow.workflowId}' must have type 'text'`));
    }
  });
}

function validateForEachNodeCrossTargets(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  control: ForEachControl,
  targetWorkflow: WorkflowDefinition | undefined,
  workflowsById: ReadonlyMap<string, WorkflowDefinition>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>> | null,
  field: string,
  errors: WorkflowFieldError[]
): void {
  const wfId = definition.workflowId;
  if (control.collection.source === 'workflow-input') {
    const portId = control.collection.portId;
    const wfInput = (definition.inputs ?? []).find((p) => p.portId === portId);
    if (!wfInput) {
      errors.push(controlError(wfId, `${field}.collection.portId`, 'invalid-foreach-collection-source', `Workflow '${wfId}' declares no input port '${portId}' for ForEach collection`));
    } else if (wfInput.type !== 'local-file' || wfInput.required === false) {
      errors.push(controlError(wfId, `${field}.collection.portId`, 'invalid-foreach-collection-source', `ForEach workflow-input collection port '${portId}' must be a required 'local-file' input`));
    }
  } else {
    const sourceNodeId = control.collection.nodeId;
    const sourcePortId = control.collection.portId;
    const sourceNode = definition.nodes.find((n) => n.nodeId === sourceNodeId);
    if (!sourceNode) {
      errors.push(controlError(wfId, `${field}.collection.nodeId`, 'unresolved-endpoint', `ForEach collection references node '${sourceNodeId}', which this Workflow does not declare`));
    } else {
      if (ancestors !== null && !ancestors.get(node.nodeId)?.has(sourceNodeId)) {
        errors.push(controlError(wfId, `${field}.collection.nodeId`, 'binding-source-not-ancestor', `ForEach collection source node '${sourceNodeId}' is not a guaranteed execution ancestor of '${node.nodeId}'`));
      }
      if (sourceNode.workflowId !== undefined) {
        const sourceWf = workflowsById.get(sourceNode.workflowId);
        if (sourceWf) {
          const outPort = (sourceWf.outputs ?? []).find((p) => p.portId === sourcePortId);
          if (!outPort || outPort.type !== 'structured-data') {
            errors.push(controlError(wfId, `${field}.collection.portId`, 'invalid-foreach-collection-source', `ForEach node-output collection port '${sourcePortId}' on '${sourceWf.workflowId}' must be a 'structured-data' output`));
          }
        }
      }
    }
  }

  const hasOverlappingInputBinding = (definition.bindings ?? []).some(
    (b) => b.kind === 'input' && b.nodeId === node.nodeId && b.inputKey === control.itemInputPortId
  );
  const hasOverlappingConnection = definition.connections.some(
    (c) => c.to.nodeId === node.nodeId && c.to.portId === control.itemInputPortId
  );
  if (hasOverlappingInputBinding || hasOverlappingConnection) {
    errors.push(controlError(wfId, `${field}.itemInputPortId`, 'conflicting-foreach-item-binding', `ForEach itemInputPortId '${control.itemInputPortId}' on node '${node.nodeId}' cannot also be bound by a normal input binding or connection`));
  }

  if (!targetWorkflow) return;
  const itemPort = (targetWorkflow.inputs ?? []).find((p) => p.portId === control.itemInputPortId);
  if (!itemPort) {
    errors.push(controlError(wfId, `${field}.itemInputPortId`, 'invalid-foreach-item-port', `ForEach body Workflow '${targetWorkflow.workflowId}' declares no input port '${control.itemInputPortId}'`));
  } else if (itemPort.type !== 'text' || itemPort.required === false) {
    errors.push(controlError(wfId, `${field}.itemInputPortId`, 'invalid-foreach-item-port', `ForEach itemInputPortId '${control.itemInputPortId}' on '${targetWorkflow.workflowId}' must be a required 'text' input port`));
  }
}
