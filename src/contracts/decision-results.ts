// FR-R5-F24 (D2, SPEC-02) — Typed Phase/Workflow decision results, bounded
// result contracts, versioned 3-valued TypedCondition predicates, and closed
// AttemptOutcome envelopes.

export type Primitive = string | number | boolean;

export const MAX_RESULT_SOURCE_BYTES = 262_144;
export const MAX_DIAGNOSTIC_RECORD_BYTES = 65_536;
export const RESULT_OPERATOR_DEADLINE_MS = 2_000;
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_VALUE_NODES = 8_192;
export const MAX_DECISION_FIELDS = 32;
export const MAX_RESULT_STRING_BYTES = 1_024;
export const MAX_SELECTOR_SEGMENTS = 5;
export const MAX_SELECTOR_SEGMENT_BYTES = 64;
export const MAX_TYPED_LEAVES = 16;
export const MAX_IN_VALUES = 32;
export const MAX_EVIDENCE_REF_BYTES = 128;

export const RESULT_CONTRACT_VERSION = 1 as const;
export const RESULT_OPERATOR_VERSION = 1 as const;
export const TYPED_CONDITION_VERSION = 1 as const;
export const ATTEMPT_OUTCOME_VERSION = 1 as const;

export const AUTHORED_DECISION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const DECISION_FIELD_TYPES = Object.freeze(['string', 'number', 'boolean'] as const);
export type DecisionFieldType = (typeof DECISION_FIELD_TYPES)[number];

export const RESULT_OPERATOR_KINDS = Object.freeze(['structured-result', 'diagnostic-result'] as const);
export type ResultOperatorKind = (typeof RESULT_OPERATOR_KINDS)[number];

export const RESULT_CONTRACT_SOURCE_KINDS = Object.freeze([
  'declared-output',
  'backend-result',
  'diagnostic-records'
] as const);
export type ResultContractSourceKind = (typeof RESULT_CONTRACT_SOURCE_KINDS)[number];

export const FORBIDDEN_SELECTOR_SEGMENTS = Object.freeze(['__proto__', 'prototype', 'constructor'] as const);

export interface DecisionField {
  readonly fieldId: string;
  readonly type: DecisionFieldType;
  readonly required: boolean;
  readonly selector: readonly string[];
}

export type ResultContractSource =
  | { readonly kind: 'declared-output'; readonly outputKey: string }
  | { readonly kind: 'backend-result' }
  | { readonly kind: 'diagnostic-records'; readonly recordType: string };

export const TYPED_OPERAND_SOURCES = Object.freeze(['result-field', 'node-result'] as const);
export type TypedOperandSource = (typeof TYPED_OPERAND_SOURCES)[number];

export type TypedOperand =
  | { readonly source: 'result-field'; readonly fieldId: string }
  | { readonly source: 'node-result'; readonly nodeId: string; readonly fieldId: string };

export const TYPED_CONDITION_OPERATORS = Object.freeze([
  'equals',
  'notEquals',
  'in',
  'exists',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
] as const);
export type TypedOperator = (typeof TYPED_CONDITION_OPERATORS)[number];

export interface TypedLeaf {
  readonly left: TypedOperand;
  readonly operator: TypedOperator;
  readonly right?: Primitive | readonly Primitive[];
}

export type TypedConditionTest =
  | TypedLeaf
  | { readonly all: readonly TypedLeaf[] }
  | { readonly any: readonly TypedLeaf[] };

export interface TypedCondition {
  readonly version: 1;
  readonly kind: 'typed';
  readonly test: TypedConditionTest;
}

export interface ResultContract {
  readonly version: 1;
  readonly operator: ResultOperatorKind;
  readonly operatorVersion: 1;
  readonly fields: readonly DecisionField[];
  readonly source: ResultContractSource;
  readonly completion: TypedCondition;
}

export type ThreeValuedResult = true | false | 'unresolved';

export const ATTEMPT_OUTCOME_STATUSES = Object.freeze([
  'done',
  'incomplete',
  'failed',
  'temporarily-unavailable',
  'invalid-result'
] as const);
export type AttemptOutcomeStatus = (typeof ATTEMPT_OUTCOME_STATUSES)[number];

export const ATTEMPT_OUTCOME_REASONS = Object.freeze([
  'completed',
  'work-remaining',
  'credits',
  'rate-limit',
  'authentication',
  'top-up-required',
  'incompatible-backend',
  'process-failure',
  'startup-failure',
  'missing-evidence',
  'malformed-evidence',
  'unattributed-evidence',
  'conflicting-evidence',
  'operator-timeout',
  'evidence-too-large',
  'unresolved-condition'
] as const);
export type AttemptOutcomeReason = (typeof ATTEMPT_OUTCOME_REASONS)[number];

export const ATTEMPT_OUTCOME_RECOVERIES = Object.freeze([
  'none',
  'retry-current',
  'reselect',
  'retire',
  'candidate-intervention',
  'block-intervention'
] as const);
export type AttemptOutcomeRecovery = (typeof ATTEMPT_OUTCOME_RECOVERIES)[number];

export const ATTEMPT_PROVENANCE_OPERATORS = Object.freeze([
  'structured-result',
  'diagnostic-result',
  'canonical-diagnostic'
] as const);
export type AttemptProvenanceOperator = (typeof ATTEMPT_PROVENANCE_OPERATORS)[number];

export const ATTEMPT_PROVENANCE_SOURCES = Object.freeze([
  'declared-output',
  'backend-result',
  'diagnostic-records',
  'host'
] as const);
export type AttemptProvenanceSource = (typeof ATTEMPT_PROVENANCE_SOURCES)[number];

export interface AttemptOutcomeProvenance {
  readonly operator: AttemptProvenanceOperator;
  readonly operatorVersion: 1;
  readonly source: AttemptProvenanceSource;
  readonly evidenceRef?: string;
  readonly evaluatedAt: number;
}

export interface AttemptOutcome {
  readonly version: 1;
  readonly attemptId: string;
  readonly status: AttemptOutcomeStatus;
  readonly reason: AttemptOutcomeReason;
  readonly recovery: AttemptOutcomeRecovery;
  readonly values: Readonly<Record<string, Primitive>>;
  readonly provenance: AttemptOutcomeProvenance;
}

export interface DecisionValidationDefect {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const EMPTY_DEFECTS: readonly DecisionValidationDefect[] = Object.freeze([]);
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(FORBIDDEN_SELECTOR_SEGMENTS);
const RESULT_CONTRACT_KEYS: ReadonlySet<string> = new Set(['version', 'operator', 'operatorVersion', 'fields', 'source', 'completion']);
const DECISION_FIELD_KEYS: ReadonlySet<string> = new Set(['fieldId', 'type', 'required', 'selector']);
const TYPED_CONDITION_KEYS: ReadonlySet<string> = new Set(['version', 'kind', 'test']);
const TYPED_LEAF_KEYS: ReadonlySet<string> = new Set(['left', 'operator', 'right']);
const ATTEMPT_OUTCOME_KEYS: ReadonlySet<string> = new Set(['version', 'attemptId', 'status', 'reason', 'recovery', 'values', 'provenance']);
const PROVENANCE_KEYS: ReadonlySet<string> = new Set(['operator', 'operatorVersion', 'source', 'evidenceRef', 'evaluatedAt']);
const INVALID_RESULT_REASONS: ReadonlySet<AttemptOutcomeReason> = new Set([
  'missing-evidence',
  'malformed-evidence',
  'unattributed-evidence',
  'conflicting-evidence',
  'operator-timeout',
  'evidence-too-large',
  'unresolved-condition'
]);

const UTF8_ENCODER = new TextEncoder();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function isPrimitiveValue(value: unknown): value is Primitive {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isValidDeclaredOutputKey(value: string): boolean {
  if (AUTHORED_DECISION_ID_PATTERN.test(value)) return true;
  if (
    value.length === 0 ||
    utf8ByteLength(value) > 256 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export function isDecisionFieldType(value: unknown): value is DecisionFieldType {
  return typeof value === 'string' && (DECISION_FIELD_TYPES as readonly string[]).includes(value);
}

export function isTypedOperator(value: unknown): value is TypedOperator {
  return typeof value === 'string' && (TYPED_CONDITION_OPERATORS as readonly string[]).includes(value);
}

export function isTypedLeafTest(test: TypedConditionTest): test is TypedLeaf {
  return 'left' in test && 'operator' in test;
}

export function isTypedConditionCandidate(raw: unknown): boolean {
  return (
    isPlainRecord(raw) &&
    (Object.hasOwn(raw, 'version') || Object.hasOwn(raw, 'kind') || Object.hasOwn(raw, 'test'))
  );
}

export function isTypedCondition(value: unknown): value is TypedCondition {
  return (
    isPlainRecord(value) &&
    value.version === TYPED_CONDITION_VERSION &&
    value.kind === 'typed' &&
    isPlainRecord(value.test)
  );
}

export function isForbiddenSelectorSegment(segment: string): boolean {
  return FORBIDDEN_SEGMENTS.has(segment);
}

export function isValidAttemptOutcomeCombination(
  status: AttemptOutcomeStatus,
  reason: AttemptOutcomeReason,
  recovery: AttemptOutcomeRecovery
): boolean {
  switch (status) {
    case 'temporarily-unavailable':
      return (reason === 'credits' || reason === 'rate-limit') && recovery === 'reselect';
    case 'failed':
      if (reason === 'authentication' || reason === 'top-up-required') return recovery === 'candidate-intervention';
      if (reason === 'incompatible-backend') return recovery === 'retire';
      if (reason === 'startup-failure') return recovery === 'retry-current';
      if (reason === 'process-failure') return recovery === 'retry-current' || recovery === 'retire';
      return false;
    case 'done':
      return reason === 'completed' && recovery === 'none';
    case 'incomplete':
      return reason === 'work-remaining' && recovery === 'retry-current';
    case 'invalid-result':
      return INVALID_RESULT_REASONS.has(reason) && recovery === 'block-intervention';
  }
}

function pushDefect(defects: DecisionValidationDefect[], field: string, code: string, message: string): void {
  defects.push(Object.freeze({ field, code, message }));
}

function checkUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  defects: DecisionValidationDefect[]
): boolean {
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      pushDefect(defects, prefix ? `${prefix}.${key}` : key, 'unknown-field', `Unknown key '${key}'`);
      ok = false;
    }
  }
  return ok;
}

function isOpaqueEvidenceRef(ref: string): boolean {
  if (ref.length === 0 || utf8ByteLength(ref) > MAX_EVIDENCE_REF_BYTES) return false;
  if (ref.includes('/') || ref.includes('\\') || ref.includes('..') || ref.includes(':') || ref.includes('\0')) {
    return false;
  }
  return /^[\x21-\x7e]+$/.test(ref);
}

export type ValidateAttemptOutcomeResult =
  | { readonly ok: true; readonly value: AttemptOutcome; readonly outcome: AttemptOutcome; readonly errors: readonly DecisionValidationDefect[]; readonly defects: readonly DecisionValidationDefect[] }
  | { readonly ok: false; readonly value: null; readonly outcome: null; readonly errors: readonly DecisionValidationDefect[]; readonly defects: readonly DecisionValidationDefect[] };

export function validateAttemptOutcome(raw: unknown): ValidateAttemptOutcomeResult {
  const defects: DecisionValidationDefect[] = [];
  if (!isPlainRecord(raw)) {
    pushDefect(defects, 'attemptOutcome', 'object-required', 'AttemptOutcome must be an object');
    const frozen = Object.freeze(defects);
    return { ok: false, value: null, outcome: null, errors: frozen, defects: frozen };
  }
  checkUnknownKeys(raw, ATTEMPT_OUTCOME_KEYS, '', defects);
  if (raw.version !== ATTEMPT_OUTCOME_VERSION) {
    pushDefect(defects, 'version', 'invalid-version', 'AttemptOutcome version must be 1');
  }
  const attemptId = typeof raw.attemptId === 'string' ? raw.attemptId.trim() : '';
  if (attemptId.length === 0 || utf8ByteLength(attemptId) > MAX_EVIDENCE_REF_BYTES) {
    pushDefect(defects, 'attemptId', 'non-empty-required', 'attemptId must be a non-empty string');
  }
  const { status, reason, recovery } = raw;
  const validStatus = typeof status === 'string' && (ATTEMPT_OUTCOME_STATUSES as readonly string[]).includes(status);
  const validReason = typeof reason === 'string' && (ATTEMPT_OUTCOME_REASONS as readonly string[]).includes(reason);
  const validRecovery =
    typeof recovery === 'string' && (ATTEMPT_OUTCOME_RECOVERIES as readonly string[]).includes(recovery);
  if (!validStatus) pushDefect(defects, 'status', 'invalid-enum', 'Invalid AttemptOutcome status');
  if (!validReason) pushDefect(defects, 'reason', 'invalid-enum', 'Invalid AttemptOutcome reason');
  if (!validRecovery) pushDefect(defects, 'recovery', 'invalid-enum', 'Invalid AttemptOutcome recovery');
  if (
    validStatus &&
    validReason &&
    validRecovery &&
    !isValidAttemptOutcomeCombination(
      status as AttemptOutcomeStatus,
      reason as AttemptOutcomeReason,
      recovery as AttemptOutcomeRecovery
    )
  ) {
    pushDefect(defects, 'status', 'invalid-outcome-combination', 'Invalid AttemptOutcome combination');
  }

  const values: Record<string, Primitive> = {};
  if (!isPlainRecord(raw.values)) {
    pushDefect(defects, 'values', 'object-required', 'AttemptOutcome values must be an object');
  } else {
    const keys = Object.keys(raw.values);
    if (keys.length > MAX_DECISION_FIELDS) pushDefect(defects, 'values', 'too-many-fields', 'Too many values');
    if (validStatus && status !== 'done' && status !== 'incomplete' && keys.length > 0) {
      pushDefect(defects, 'values', 'non-empty-values-on-failure', 'Non-result failures must have empty values');
    }
    for (const key of keys) {
      if (!AUTHORED_DECISION_ID_PATTERN.test(key)) pushDefect(defects, `values.${key}`, 'invalid-field-id', 'Invalid fieldId');
      const val = raw.values[key];
      if (!isPrimitiveValue(val)) {
        pushDefect(defects, `values.${key}`, 'invalid-value-type', 'Value must be primitive');
      } else if (typeof val === 'string' && utf8ByteLength(val) > MAX_RESULT_STRING_BYTES) {
        pushDefect(defects, `values.${key}`, 'string-too-long', 'String value exceeds 1,024 UTF-8 bytes');
      } else {
        values[key] = val;
      }
    }
  }

  let provenance: AttemptOutcomeProvenance | null = null;
  if (!isPlainRecord(raw.provenance)) {
    pushDefect(defects, 'provenance', 'object-required', 'Provenance must be an object');
  } else {
    const prov = raw.provenance;
    checkUnknownKeys(prov, PROVENANCE_KEYS, 'provenance', defects);
    const op = prov.operator;
    const validOp = typeof op === 'string' && (ATTEMPT_PROVENANCE_OPERATORS as readonly string[]).includes(op);
    if (!validOp) pushDefect(defects, 'provenance.operator', 'invalid-enum', 'Invalid provenance operator');
    if (prov.operatorVersion !== RESULT_OPERATOR_VERSION) {
      pushDefect(defects, 'provenance.operatorVersion', 'unsupported-operator-version', 'operatorVersion must be 1');
    }
    const src = prov.source;
    const validSrc = typeof src === 'string' && (ATTEMPT_PROVENANCE_SOURCES as readonly string[]).includes(src);
    if (!validSrc) pushDefect(defects, 'provenance.source', 'invalid-enum', 'Invalid provenance source');
    let evidenceRef: string | undefined;
    if (prov.evidenceRef !== undefined) {
      if (typeof prov.evidenceRef !== 'string' || !isOpaqueEvidenceRef(prov.evidenceRef)) {
        pushDefect(defects, 'provenance.evidenceRef', 'invalid-evidence-ref', 'Invalid evidenceRef');
      } else {
        evidenceRef = prov.evidenceRef;
      }
    }
    const evaluatedAt = prov.evaluatedAt;
    const validTime =
      typeof evaluatedAt === 'number' &&
      Number.isSafeInteger(evaluatedAt) &&
      evaluatedAt >= 0 &&
      evaluatedAt <= MAX_TIMESTAMP_MS;
    if (!validTime) {
      pushDefect(defects, 'provenance.evaluatedAt', 'invalid-timestamp', 'Invalid evaluatedAt');
    } else if (validOp && prov.operatorVersion === RESULT_OPERATOR_VERSION && validSrc) {
      provenance = Object.freeze({
        operator: op as AttemptProvenanceOperator,
        operatorVersion: RESULT_OPERATOR_VERSION,
        source: src as AttemptProvenanceSource,
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        evaluatedAt
      });
    }
  }

  if (defects.length > 0 || provenance === null) {
    const frozen = Object.freeze(defects);
    return { ok: false, value: null, outcome: null, errors: frozen, defects: frozen };
  }
  const outcome: AttemptOutcome = Object.freeze({
    version: ATTEMPT_OUTCOME_VERSION,
    attemptId,
    status: status as AttemptOutcomeStatus,
    reason: reason as AttemptOutcomeReason,
    recovery: recovery as AttemptOutcomeRecovery,
    values: Object.freeze(values),
    provenance
  });
  return { ok: true, value: outcome, outcome, errors: EMPTY_DEFECTS, defects: EMPTY_DEFECTS };
}

export interface TypedConditionValidationOptions {
  readonly scope?: 'result-contract' | 'workflow-connection' | 'repeat-until';
  readonly declaredFields?: ReadonlyMap<string, DecisionField>;
}

const RESULT_FIELD_OPERAND_KEYS: ReadonlySet<string> = new Set(['source', 'fieldId']);
const NODE_RESULT_OPERAND_KEYS: ReadonlySet<string> = new Set(['source', 'nodeId', 'fieldId']);

function validateOperand(
  raw: unknown,
  fieldPath: string,
  options: TypedConditionValidationOptions,
  defects: DecisionValidationDefect[]
): TypedOperand | null {
  if (!isPlainRecord(raw)) {
    pushDefect(defects, fieldPath, 'unsupported-condition', 'Operand must be an object');
    return null;
  }
  const source = raw.source;
  const scope = options.scope ?? 'workflow-connection';
  if (source === 'result-field') {
    if (!checkUnknownKeys(raw, RESULT_FIELD_OPERAND_KEYS, fieldPath, defects)) return null;
    if (scope === 'workflow-connection') {
      pushDefect(defects, `${fieldPath}.source`, 'condition-operand-scope', 'result-field not allowed on connection');
      return null;
    }
    const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId : '';
    if (!AUTHORED_DECISION_ID_PATTERN.test(fieldId)) {
      pushDefect(defects, `${fieldPath}.fieldId`, 'invalid-field-id', 'Invalid fieldId');
      return null;
    }
    return Object.freeze({ source: 'result-field', fieldId });
  }
  if (source === 'node-result') {
    if (!checkUnknownKeys(raw, NODE_RESULT_OPERAND_KEYS, fieldPath, defects)) return null;
    if (scope === 'result-contract' || scope === 'repeat-until') {
      pushDefect(defects, `${fieldPath}.source`, 'condition-operand-scope', 'node-result not allowed in completion or repeat-until');
      return null;
    }
    const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : '';
    const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId : '';
    let ok = true;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(nodeId)) {
      pushDefect(defects, `${fieldPath}.nodeId`, 'invalid-node-id', 'Invalid nodeId');
      ok = false;
    }
    if (!AUTHORED_DECISION_ID_PATTERN.test(fieldId)) {
      pushDefect(defects, `${fieldPath}.fieldId`, 'invalid-field-id', 'Invalid fieldId');
      ok = false;
    }
    return ok ? Object.freeze({ source: 'node-result', nodeId, fieldId }) : null;
  }
  pushDefect(defects, `${fieldPath}.source`, 'condition-operand-unknown', 'Invalid operand source');
  return null;
}

export function validateLeafAgainstField(
  leaf: TypedLeaf,
  fieldDef: DecisionField,
  fieldPath = 'condition.test',
  sink?: DecisionValidationDefect[]
): readonly DecisionValidationDefect[] {
  const local: DecisionValidationDefect[] = [];
  const { operator, right } = leaf;
  const fieldType = fieldDef.type;

  if (operator === 'exists') {
    if (fieldDef.required) {
      pushDefect(local, `${fieldPath}.operator`, 'exists-on-required-field', 'exists requires optional field');
    }
  } else if (
    operator === 'greaterThan' ||
    operator === 'greaterThanOrEqual' ||
    operator === 'lessThan' ||
    operator === 'lessThanOrEqual'
  ) {
    if (fieldType !== 'number') {
      pushDefect(local, `${fieldPath}.operator`, 'condition-comparison-unsupported', 'Ordering requires number field');
    }
  } else if (operator === 'in') {
    if (!Array.isArray(right) || !right.every((entry) => typeof entry === fieldType)) {
      pushDefect(local, `${fieldPath}.right`, 'condition-right-invalid', `List must contain '${fieldType}' values`);
    }
  } else if (right === undefined || Array.isArray(right) || typeof right !== fieldType) {
    pushDefect(local, `${fieldPath}.right`, 'condition-right-invalid', `Right must be '${fieldType}'`);
  }

  if (sink !== undefined) sink.push(...local);
  return Object.freeze(local);
}

function validateTypedLeaf(
  raw: unknown,
  fieldPath: string,
  options: TypedConditionValidationOptions,
  defects: DecisionValidationDefect[]
): TypedLeaf | null {
  if (!isPlainRecord(raw)) {
    pushDefect(defects, fieldPath, 'object-required', 'TypedLeaf must be an object');
    return null;
  }
  let ok = checkUnknownKeys(raw, TYPED_LEAF_KEYS, fieldPath, defects);
  const left = validateOperand(raw.left, `${fieldPath}.left`, options, defects);
  if (left === null) ok = false;
  if (!isTypedOperator(raw.operator)) {
    pushDefect(defects, `${fieldPath}.operator`, 'unsupported-condition', 'Invalid operator');
    return null;
  }
  const operator = raw.operator;
  const rightRaw = raw.right;
  let right: Primitive | readonly Primitive[] | undefined;

  if (operator === 'exists') {
    if (rightRaw !== undefined) {
      pushDefect(defects, `${fieldPath}.right`, 'condition-right-invalid', "Operator 'exists' forbids right operand");
      ok = false;
    }
  } else if (operator === 'in') {
    if (!Array.isArray(rightRaw) || rightRaw.length === 0 || rightRaw.length > MAX_IN_VALUES) {
      pushDefect(defects, `${fieldPath}.right`, 'condition-right-invalid', 'Invalid in list length');
      ok = false;
    } else if (!rightRaw.every((item) => isPrimitiveValue(item))) {
      pushDefect(defects, `${fieldPath}.right`, 'condition-right-invalid', 'Invalid in list items');
      ok = false;
    } else {
      const firstType = typeof rightRaw[0];
      const uniform = rightRaw.every((item) => typeof item === firstType);
      const stringBoundsOk = rightRaw.every(
        (item) => typeof item !== 'string' || utf8ByteLength(item) <= MAX_RESULT_STRING_BYTES
      );
      if (!uniform || !stringBoundsOk) {
        pushDefect(defects, `${fieldPath}.right`, 'condition-right-invalid', 'Non-uniform or oversized in list');
        ok = false;
      } else {
        right = Object.freeze([...(rightRaw as Primitive[])]);
      }
    }
  } else if (
    operator === 'greaterThan' ||
    operator === 'greaterThanOrEqual' ||
    operator === 'lessThan' ||
    operator === 'lessThanOrEqual'
  ) {
    if (typeof rightRaw !== 'number' || !Number.isFinite(rightRaw)) {
      pushDefect(defects, `${fieldPath}.right`, 'condition-right-invalid', 'Ordering requires finite number');
      ok = false;
    } else {
      right = rightRaw;
    }
  } else if (
    !isPrimitiveValue(rightRaw) ||
    (typeof rightRaw === 'string' && utf8ByteLength(rightRaw) > MAX_RESULT_STRING_BYTES)
  ) {
    pushDefect(defects, `${fieldPath}.right`, 'condition-right-invalid', 'Comparison requires valid primitive right');
    ok = false;
  } else {
    right = rightRaw;
  }

  if (!ok || left === null) return null;
  const candidateLeaf: TypedLeaf = Object.freeze({ left, operator, ...(right !== undefined ? { right } : {}) });
  if (left.source === 'result-field' && options.declaredFields !== undefined) {
    const fieldDef = options.declaredFields.get(left.fieldId);
    if (fieldDef === undefined) {
      pushDefect(defects, `${fieldPath}.left.fieldId`, 'condition-field-undeclared', 'Undeclared fieldId');
      return null;
    }
    if (validateLeafAgainstField(candidateLeaf, fieldDef, fieldPath, defects).length > 0) return null;
  }
  return candidateLeaf;
}

export type ValidateTypedConditionResult =
  | { readonly ok: true; readonly value: TypedCondition; readonly condition: TypedCondition; readonly errors: readonly DecisionValidationDefect[]; readonly defects: readonly DecisionValidationDefect[] }
  | { readonly ok: false; readonly value: null; readonly condition: null; readonly errors: readonly DecisionValidationDefect[]; readonly defects: readonly DecisionValidationDefect[] };

export function validateTypedCondition(
  raw: unknown,
  fieldPath = 'condition',
  options: TypedConditionValidationOptions = {}
): ValidateTypedConditionResult {
  const defects: DecisionValidationDefect[] = [];
  if (!isPlainRecord(raw)) {
    pushDefect(defects, fieldPath, 'unsupported-condition', 'TypedCondition must be an object');
    const frozen = Object.freeze(defects);
    return { ok: false, value: null, condition: null, errors: frozen, defects: frozen };
  }
  let ok = checkUnknownKeys(raw, TYPED_CONDITION_KEYS, fieldPath, defects);
  if (raw.version !== TYPED_CONDITION_VERSION) {
    pushDefect(defects, `${fieldPath}.version`, 'invalid-version', 'TypedCondition version must be 1');
    ok = false;
  }
  if (raw.kind !== 'typed') {
    pushDefect(defects, `${fieldPath}.kind`, 'invalid-enum', "TypedCondition kind must be 'typed'");
    ok = false;
  }

  let testValue: TypedConditionTest | null = null;
  const rawTest = raw.test;
  if (!isPlainRecord(rawTest)) {
    pushDefect(defects, `${fieldPath}.test`, 'object-required', 'TypedCondition.test must be an object');
    ok = false;
  } else {
    const keys = Object.keys(rawTest);
    const hasAll = Object.hasOwn(rawTest, 'all');
    const hasAny = Object.hasOwn(rawTest, 'any');
    if (hasAll || hasAny) {
      const groupKey = hasAll && !hasAny ? 'all' : !hasAll && hasAny ? 'any' : null;
      if (groupKey === null || keys.length !== 1) {
        pushDefect(defects, `${fieldPath}.test`, 'unknown-field', "Composite test must contain 'all' or 'any'");
        ok = false;
      } else {
        const listRaw = rawTest[groupKey];
        if (!Array.isArray(listRaw) || listRaw.length === 0 || listRaw.length > MAX_TYPED_LEAVES) {
          pushDefect(defects, `${fieldPath}.test.${groupKey}`, 'too-many-leaves', 'Invalid leaf count');
          ok = false;
        } else {
          const leaves: TypedLeaf[] = [];
          listRaw.forEach((entry, idx) => {
            const parsedLeaf = validateTypedLeaf(entry, `${fieldPath}.test.${groupKey}[${idx}]`, options, defects);
            if (parsedLeaf === null) ok = false;
            else leaves.push(parsedLeaf);
          });
          if (ok) {
            testValue =
              groupKey === 'all'
                ? Object.freeze({ all: Object.freeze(leaves) })
                : Object.freeze({ any: Object.freeze(leaves) });
          }
        }
      }
    } else {
      const parsedLeaf = validateTypedLeaf(rawTest, `${fieldPath}.test`, options, defects);
      if (parsedLeaf === null) ok = false;
      else testValue = parsedLeaf;
    }
  }

  if (!ok || testValue === null || defects.length > 0) {
    const frozen = Object.freeze(defects);
    return { ok: false, value: null, condition: null, errors: frozen, defects: frozen };
  }
  const condition: TypedCondition = Object.freeze({
    version: TYPED_CONDITION_VERSION,
    kind: 'typed',
    test: testValue
  });
  return { ok: true, value: condition, condition, errors: EMPTY_DEFECTS, defects: EMPTY_DEFECTS };
}

export function collectTypedConditionLeaves(
  condition: TypedCondition,
  baseField = 'condition'
): readonly { readonly leaf: TypedLeaf; readonly fieldPath: string; readonly path: string }[] {
  const { test } = condition;
  if (isTypedLeafTest(test)) {
    const p = `${baseField}.test`;
    return Object.freeze([Object.freeze({ leaf: test, fieldPath: p, path: p })]);
  }
  const [group, list] = 'all' in test ? (['all', test.all] as const) : (['any', test.any] as const);
  return Object.freeze(
    list.map((leaf, idx) => {
      const p = `${baseField}.test.${group}[${idx}]`;
      return Object.freeze({ leaf, fieldPath: p, path: p });
    })
  );
}

function validateDecisionField(
  raw: unknown,
  fieldPath: string,
  seenFieldIds: Set<string>,
  seenSelectors: Set<string>,
  defects: DecisionValidationDefect[]
): DecisionField | null {
  if (!isPlainRecord(raw)) {
    pushDefect(defects, fieldPath, 'object-required', 'DecisionField must be an object');
    return null;
  }
  let ok = checkUnknownKeys(raw, DECISION_FIELD_KEYS, fieldPath, defects);
  const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId : '';
  if (!AUTHORED_DECISION_ID_PATTERN.test(fieldId)) {
    pushDefect(defects, `${fieldPath}.fieldId`, 'invalid-field-id', 'Invalid fieldId');
    ok = false;
  } else if (seenFieldIds.has(fieldId)) {
    pushDefect(defects, `${fieldPath}.fieldId`, 'duplicate-field-id', `Duplicate DecisionField '${fieldId}'`);
    ok = false;
  } else {
    seenFieldIds.add(fieldId);
  }

  const fieldType = isDecisionFieldType(raw.type) ? raw.type : null;
  if (fieldType === null) {
    pushDefect(defects, `${fieldPath}.type`, 'invalid-enum', 'Invalid DecisionField type');
    ok = false;
  }

  let required = true;
  if (raw.required !== undefined) {
    if (typeof raw.required !== 'boolean') {
      pushDefect(defects, `${fieldPath}.required`, 'boolean-required', 'required must be boolean');
      ok = false;
    } else {
      required = raw.required;
    }
  }

  let selector: readonly string[] = [];
  if (!Array.isArray(raw.selector)) {
    pushDefect(defects, `${fieldPath}.selector`, 'array-required', 'selector must be a string array');
    ok = false;
  } else if (raw.selector.length === 0 || raw.selector.length > MAX_SELECTOR_SEGMENTS) {
    pushDefect(defects, `${fieldPath}.selector`, 'invalid-length', 'Invalid selector length');
    ok = false;
  } else {
    const segments: string[] = [];
    raw.selector.forEach((seg, segIdx) => {
      if (typeof seg !== 'string' || seg.length === 0 || utf8ByteLength(seg) > MAX_SELECTOR_SEGMENT_BYTES) {
        pushDefect(defects, `${fieldPath}.selector[${segIdx}]`, 'invalid-selector-segment', 'Invalid segment');
        ok = false;
      } else if (isForbiddenSelectorSegment(seg)) {
        pushDefect(defects, `${fieldPath}.selector[${segIdx}]`, 'forbidden-selector-segment', 'Forbidden segment');
        ok = false;
      } else if (seg.includes('*') || seg.includes('[') || seg.includes(']')) {
        pushDefect(defects, `${fieldPath}.selector[${segIdx}]`, 'invalid-selector-segment', 'No arrays or wildcards');
        ok = false;
      } else {
        segments.push(seg);
      }
    });
    if (segments.length === raw.selector.length) {
      const selectorKey = segments.join('\0');
      if (seenSelectors.has(selectorKey)) {
        pushDefect(defects, `${fieldPath}.selector`, 'duplicate-selector', 'Duplicate selector');
        ok = false;
      } else {
        seenSelectors.add(selectorKey);
        selector = Object.freeze(segments);
      }
    }
  }

  if (!ok || fieldType === null) return null;
  return Object.freeze({ fieldId, type: fieldType, required, selector });
}

export type ValidateResultContractResult =
  | { readonly ok: true; readonly value: ResultContract; readonly contract: ResultContract; readonly errors: readonly DecisionValidationDefect[]; readonly defects: readonly DecisionValidationDefect[] }
  | { readonly ok: false; readonly value: null; readonly contract: null; readonly errors: readonly DecisionValidationDefect[]; readonly defects: readonly DecisionValidationDefect[] };

const DECLARED_OUTPUT_SOURCE_KEYS: ReadonlySet<string> = new Set(['kind', 'outputKey']);
const BACKEND_RESULT_SOURCE_KEYS: ReadonlySet<string> = new Set(['kind']);
const DIAGNOSTIC_RECORDS_SOURCE_KEYS: ReadonlySet<string> = new Set(['kind', 'recordType']);

export function validateResultContract(
  raw: unknown,
  baseField = 'resultContract'
): ValidateResultContractResult {
  const defects: DecisionValidationDefect[] = [];
  if (!isPlainRecord(raw)) {
    pushDefect(defects, baseField, 'object-required', 'ResultContract must be an object');
    const frozen = Object.freeze(defects);
    return { ok: false, value: null, contract: null, errors: frozen, defects: frozen };
  }
  let ok = checkUnknownKeys(raw, RESULT_CONTRACT_KEYS, baseField, defects);
  if (raw.version !== RESULT_CONTRACT_VERSION) {
    pushDefect(defects, `${baseField}.version`, 'invalid-version', 'ResultContract version must be 1');
    ok = false;
  }
  const operator = raw.operator;
  const validOperator =
    typeof operator === 'string' && (RESULT_OPERATOR_KINDS as readonly string[]).includes(operator);
  if (!validOperator) {
    pushDefect(defects, `${baseField}.operator`, 'invalid-enum', 'Invalid ResultContract operator');
    ok = false;
  }
  if (raw.operatorVersion !== RESULT_OPERATOR_VERSION) {
    pushDefect(defects, `${baseField}.operatorVersion`, 'unsupported-operator-version', 'operatorVersion must be 1');
    ok = false;
  }

  let source: ResultContractSource | null = null;
  if (!isPlainRecord(raw.source)) {
    pushDefect(defects, `${baseField}.source`, 'object-required', 'ResultContract.source must be an object');
    ok = false;
  } else {
    const srcKind = raw.source.kind;
    const srcField = `${baseField}.source`;
    if (srcKind === 'declared-output') {
      if (!checkUnknownKeys(raw.source, DECLARED_OUTPUT_SOURCE_KEYS, srcField, defects)) ok = false;
      if (validOperator && operator !== 'structured-result') {
        pushDefect(defects, `${srcField}.kind`, 'incompatible-operator-source', 'Incompatible source');
        ok = false;
      }
      const outputKey = typeof raw.source.outputKey === 'string' ? raw.source.outputKey : '';
      if (!isValidDeclaredOutputKey(outputKey)) {
        pushDefect(defects, `${srcField}.outputKey`, 'invalid-output-key', 'Invalid outputKey');
        ok = false;
      } else if (ok) {
        source = Object.freeze({ kind: 'declared-output', outputKey });
      }
    } else if (srcKind === 'backend-result') {
      if (!checkUnknownKeys(raw.source, BACKEND_RESULT_SOURCE_KEYS, srcField, defects)) ok = false;
      if (validOperator && operator !== 'structured-result') {
        pushDefect(defects, `${srcField}.kind`, 'incompatible-operator-source', 'Incompatible source');
        ok = false;
      } else if (ok) {
        source = Object.freeze({ kind: 'backend-result' });
      }
    } else if (srcKind === 'diagnostic-records') {
      if (!checkUnknownKeys(raw.source, DIAGNOSTIC_RECORDS_SOURCE_KEYS, srcField, defects)) ok = false;
      if (validOperator && operator !== 'diagnostic-result') {
        pushDefect(defects, `${srcField}.kind`, 'incompatible-operator-source', 'Incompatible source');
        ok = false;
      }
      const recordType = typeof raw.source.recordType === 'string' ? raw.source.recordType : '';
      if (!AUTHORED_DECISION_ID_PATTERN.test(recordType)) {
        pushDefect(defects, `${srcField}.recordType`, 'invalid-record-type', 'Invalid recordType');
        ok = false;
      } else if (ok) {
        source = Object.freeze({ kind: 'diagnostic-records', recordType });
      }
    } else {
      pushDefect(defects, `${srcField}.kind`, 'invalid-enum', 'Invalid ResultContract.source.kind');
      ok = false;
    }
  }

  const fields: DecisionField[] = [];
  const fieldMap = new Map<string, DecisionField>();
  if (!Array.isArray(raw.fields)) {
    pushDefect(defects, `${baseField}.fields`, 'array-required', 'fields must be an array');
    ok = false;
  } else if (raw.fields.length === 0 || raw.fields.length > MAX_DECISION_FIELDS) {
    pushDefect(defects, `${baseField}.fields`, 'invalid-length', `fields must contain 1..${MAX_DECISION_FIELDS} entries`);
    ok = false;
  } else {
    const seenFieldIds = new Set<string>();
    const seenSelectors = new Set<string>();
    raw.fields.forEach((entry, idx) => {
      const parsed = validateDecisionField(entry, `${baseField}.fields[${idx}]`, seenFieldIds, seenSelectors, defects);
      if (parsed === null) ok = false;
      else {
        fields.push(parsed);
        fieldMap.set(parsed.fieldId, parsed);
      }
    });
  }

  let completion: TypedCondition | null = null;
  if (raw.completion === undefined) {
    pushDefect(defects, `${baseField}.completion`, 'required', 'ResultContract.completion is required');
    ok = false;
  } else {
    const compResult = validateTypedCondition(raw.completion, `${baseField}.completion`, {
      scope: 'result-contract',
      declaredFields: fieldMap
    });
    if (!compResult.ok) {
      defects.push(...compResult.defects);
      ok = false;
    } else {
      completion = compResult.condition;
    }
  }

  if (!ok || !validOperator || source === null || completion === null || defects.length > 0) {
    const capped = Object.freeze(
      defects.map((d) =>
        Object.freeze({
          field: d.field.length <= 32 ? d.field : d.field.slice(0, 32),
          code: d.code,
          message: d.message
        })
      )
    );
    return { ok: false, value: null, contract: null, errors: capped, defects: capped };
  }

  const contract: ResultContract = Object.freeze({
    version: RESULT_CONTRACT_VERSION,
    operator: operator as ResultOperatorKind,
    operatorVersion: RESULT_OPERATOR_VERSION,
    fields: Object.freeze(fields),
    source,
    completion
  });
  return { ok: true, value: contract, contract, errors: EMPTY_DEFECTS, defects: EMPTY_DEFECTS };
}

function freezeTypedLeaf(leaf: TypedLeaf): TypedLeaf {
  const { left, operator, right } = leaf;
  const frozenLeft: TypedOperand =
    left.source === 'result-field'
      ? Object.freeze({ source: 'result-field', fieldId: left.fieldId })
      : Object.freeze({ source: 'node-result', nodeId: left.nodeId, fieldId: left.fieldId });
  const frozenRight = right === undefined ? undefined : Array.isArray(right) ? Object.freeze([...right]) : right;
  return Object.freeze({ left: frozenLeft, operator, ...(frozenRight !== undefined ? { right: frozenRight } : {}) });
}

export function freezeTypedCondition(condition: TypedCondition): TypedCondition {
  const { test } = condition;
  const frozenTest: TypedConditionTest = isTypedLeafTest(test)
    ? freezeTypedLeaf(test)
    : 'all' in test
      ? Object.freeze({ all: Object.freeze(test.all.map(freezeTypedLeaf)) })
      : Object.freeze({ any: Object.freeze(test.any.map(freezeTypedLeaf)) });
  return Object.freeze({ version: TYPED_CONDITION_VERSION, kind: 'typed', test: frozenTest });
}

export function freezeResultContract(contract: ResultContract): ResultContract {
  const frozenSource: ResultContractSource = Object.freeze({ ...contract.source });
  const frozenFields = Object.freeze(
    contract.fields.map((f) => Object.freeze({ ...f, selector: Object.freeze([...f.selector]) }))
  );
  return Object.freeze({
    version: RESULT_CONTRACT_VERSION,
    operator: contract.operator,
    operatorVersion: RESULT_OPERATOR_VERSION,
    fields: frozenFields,
    source: frozenSource,
    completion: freezeTypedCondition(contract.completion)
  });
}
