// FR-R5-F23 (SPEC-01, D1) — Phase repetition and branch decision observation contract.
//
// Defines the versioned, closed-shape `ExecutionDecisionObservation` (`version: 1`)
// and `ExecutionBranchDisposition` taxonomy shared across the Phase controller,
// Workflow routing selector, durable run state, sidebar projector, and webview.
//
// Zero `vscode` imports and zero I/O: pure contract leaf importable by both host
// and webview bundles.

import type { RetryCapOutcome } from './process-definitions';
import type { LimitOrigin } from './snapshot-projections';
import type { WorkflowCondition } from './workflow-definitions';

export const EXECUTION_DECISION_OBSERVATION_VERSION = 1 as const;

export const EXECUTION_BRANCH_DISPOSITIONS = [
  'selected',
  'condition-false',
  'unresolved',
  'priority-lost',
  'fallback',
  'failure-excluded',
  'manual-handoff',
  'no-route'
] as const;

export type ExecutionBranchDisposition =
  (typeof EXECUTION_BRANCH_DISPOSITIONS)[number];

export const EXECUTION_DECISION_EXIT_REASONS = [
  'condition-cleared',
  'repeat',
  'cap-failed',
  'cap-continued',
  'cap-degraded',
  'no-progress',
  'missing-evidence',
  'host-control'
] as const;

export type ExecutionDecisionExitReason =
  (typeof EXECUTION_DECISION_EXIT_REASONS)[number];

export const EXECUTION_DECISION_CAP_OUTCOMES = [
  'fail',
  'continue',
  'continue-degraded'
] as const;

export type ExecutionDecisionCapOutcome =
  (typeof EXECUTION_DECISION_CAP_OUTCOMES)[number];

export const EXECUTION_DECISION_LIMIT_ORIGINS = [
  'default',
  'user',
  'workspace',
  'workspace-folder',
  'phase',
  'override',
  'setting'
] as const;

export type ExecutionDecisionSettingOrigin =
  | LimitOrigin
  | (typeof EXECUTION_DECISION_LIMIT_ORIGINS)[number];

export const MAX_OBSERVED_VALUE_ENTRIES = 32;
export const MAX_OBSERVED_STRING_LENGTH = 256;
export const MAX_DECISION_ID_LENGTH = 256;

export interface ExecutionDecisionSettingSources {
  readonly maxIterations: ExecutionDecisionSettingOrigin;
  readonly capOutcome: ExecutionDecisionSettingOrigin;
  readonly noProgressThreshold?: ExecutionDecisionSettingOrigin;
}

export interface ExecutionDecisionBranchRecord {
  /** Position in the Workflow's `connections`, or `-1` for a synthetic `'no-route'` terminal record. */
  readonly connectionIndex: number;
  readonly targetNodeId?: string;
  readonly isDefault: boolean;
  readonly priority?: number;
  readonly disposition: ExecutionBranchDisposition;
  readonly summary: string;
  readonly observedValue?: string | number | boolean;
}

export interface ExecutionDecisionObservation {
  readonly version: typeof EXECUTION_DECISION_OBSERVATION_VERSION;
  readonly decisionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly evaluatedAt: number;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly retryCondition: string;
  readonly capOutcome: RetryCapOutcome;
  readonly noProgressThreshold?: number;
  readonly settingSources: ExecutionDecisionSettingSources;
  readonly observedValues: Readonly<Record<string, string | number | boolean>>;
  readonly exitReason: ExecutionDecisionExitReason;
  readonly branches: readonly ExecutionDecisionBranchRecord[];
}

export interface ExecutionDecisionObservationFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type ExecutionDecisionObservationValidationResult =
  | {
      readonly valid: true;
      readonly value: ExecutionDecisionObservation;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly errors: readonly ExecutionDecisionObservationFieldError[];
    };

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'version',
  'decisionId',
  'runId',
  'nodeId',
  'attemptId',
  'evaluatedAt',
  'iteration',
  'maxIterations',
  'retryCondition',
  'capOutcome',
  'noProgressThreshold',
  'settingSources',
  'observedValues',
  'exitReason',
  'branches'
]);

const SETTING_SOURCES_KEYS: ReadonlySet<string> = new Set([
  'maxIterations',
  'capOutcome',
  'noProgressThreshold'
]);

const BRANCH_RECORD_KEYS: ReadonlySet<string> = new Set([
  'connectionIndex',
  'targetNodeId',
  'isDefault',
  'priority',
  'disposition',
  'summary',
  'observedValue'
]);

const DISPOSITION_SET: ReadonlySet<string> = new Set(EXECUTION_BRANCH_DISPOSITIONS);
const EXIT_REASON_SET: ReadonlySet<string> = new Set(EXECUTION_DECISION_EXIT_REASONS);
const CAP_OUTCOME_SET: ReadonlySet<string> = new Set(EXECUTION_DECISION_CAP_OUTCOMES);
const LIMIT_ORIGIN_SET: ReadonlySet<string> = new Set(EXECUTION_DECISION_LIMIT_ORIGINS);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasInvalidUtf8OrSurrogates(text: string): boolean {
  if (text.includes('\uFFFD')) {
    return true;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidNonEmptyString(
  value: unknown,
  maxLength = MAX_DECISION_ID_LENGTH
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !hasInvalidUtf8OrSurrogates(value)
  );
}

function isValidStringAllowEmpty(
  value: unknown,
  maxLength = MAX_OBSERVED_STRING_LENGTH
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    !hasInvalidUtf8OrSurrogates(value)
  );
}

function isValidObservedScalar(value: unknown): value is string | number | boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return isValidStringAllowEmpty(value, MAX_OBSERVED_STRING_LENGTH);
  return false;
}

/**
 * Validate an unknown value as a closed-shape `ExecutionDecisionObservation` (`version: 1`).
 *
 * Rejects unknown keys, unknown versions, non-finite numbers, invalid UTF-8 strings,
 * out-of-set enum members, and `null` on optional fields.
 */
export function validateExecutionDecisionObservation(
  value: unknown
): ExecutionDecisionObservationValidationResult {
  const errors: ExecutionDecisionObservationFieldError[] = [];

  if (!isPlainRecord(value)) {
    return {
      valid: false,
      errors: [
        {
          field: 'observation',
          code: 'invalid-type',
          message: 'ExecutionDecisionObservation must be a plain object.'
        }
      ]
    };
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push({
        field: key,
        code: 'unknown-field',
        message: `Unknown field '${key}' on ExecutionDecisionObservation.`
      });
    }
  }

  if (value.version !== EXECUTION_DECISION_OBSERVATION_VERSION) {
    errors.push({
      field: 'version',
      code: 'unsupported-version',
      message: `Expected version ${EXECUTION_DECISION_OBSERVATION_VERSION}.`
    });
  }

  if (!isValidNonEmptyString(value.decisionId)) {
    errors.push({
      field: 'decisionId',
      code: 'invalid-decision-id',
      message: 'decisionId must be a non-empty valid UTF-8 string.'
    });
  }

  if (!isValidNonEmptyString(value.runId)) {
    errors.push({
      field: 'runId',
      code: 'invalid-run-id',
      message: 'runId must be a non-empty valid UTF-8 string.'
    });
  }

  if (!isValidNonEmptyString(value.nodeId)) {
    errors.push({
      field: 'nodeId',
      code: 'invalid-node-id',
      message: 'nodeId must be a non-empty valid UTF-8 string.'
    });
  }

  if ('attemptId' in value) {
    if (value.attemptId === null || !isValidNonEmptyString(value.attemptId)) {
      errors.push({
        field: 'attemptId',
        code: 'invalid-attempt-id',
        message: 'attemptId must be omitted or a non-empty valid UTF-8 string (never null).'
      });
    }
  }

  if (
    typeof value.evaluatedAt !== 'number' ||
    !Number.isInteger(value.evaluatedAt) ||
    value.evaluatedAt < 0
  ) {
    errors.push({
      field: 'evaluatedAt',
      code: 'invalid-evaluated-at',
      message: 'evaluatedAt must be a finite non-negative integer.'
    });
  }

  if (
    typeof value.iteration !== 'number' ||
    !Number.isInteger(value.iteration) ||
    value.iteration < 1
  ) {
    errors.push({
      field: 'iteration',
      code: 'invalid-iteration',
      message: 'iteration must be a finite integer >= 1.'
    });
  }

  if (
    typeof value.maxIterations !== 'number' ||
    !Number.isInteger(value.maxIterations) ||
    value.maxIterations < 1
  ) {
    errors.push({
      field: 'maxIterations',
      code: 'invalid-max-iterations',
      message: 'maxIterations must be a finite integer >= 1.'
    });
  }

  if (!isValidNonEmptyString(value.retryCondition)) {
    errors.push({
      field: 'retryCondition',
      code: 'invalid-retry-condition',
      message: 'retryCondition must be a non-empty valid UTF-8 string.'
    });
  }

  if (typeof value.capOutcome !== 'string' || !CAP_OUTCOME_SET.has(value.capOutcome)) {
    errors.push({
      field: 'capOutcome',
      code: 'invalid-cap-outcome',
      message: 'capOutcome must be one of fail, continue, continue-degraded.'
    });
  }

  if ('noProgressThreshold' in value) {
    if (
      value.noProgressThreshold === null ||
      typeof value.noProgressThreshold !== 'number' ||
      !Number.isInteger(value.noProgressThreshold) ||
      value.noProgressThreshold < 0
    ) {
      errors.push({
        field: 'noProgressThreshold',
        code: 'invalid-no-progress-threshold',
        message: 'noProgressThreshold must be omitted or a finite non-negative integer (never null).'
      });
    }
  }

  if (!isPlainRecord(value.settingSources)) {
    errors.push({
      field: 'settingSources',
      code: 'invalid-setting-sources',
      message: 'settingSources must be a plain object.'
    });
  } else {
    for (const key of Object.keys(value.settingSources)) {
      if (!SETTING_SOURCES_KEYS.has(key)) {
        errors.push({
          field: `settingSources.${key}`,
          code: 'unknown-field',
          message: `Unknown field '${key}' on settingSources.`
        });
      }
    }
    if (
      typeof value.settingSources.maxIterations !== 'string' ||
      !LIMIT_ORIGIN_SET.has(value.settingSources.maxIterations)
    ) {
      errors.push({
        field: 'settingSources.maxIterations',
        code: 'invalid-limit-origin',
        message: 'settingSources.maxIterations must be override, setting, or default.'
      });
    }
    if (
      typeof value.settingSources.capOutcome !== 'string' ||
      !LIMIT_ORIGIN_SET.has(value.settingSources.capOutcome)
    ) {
      errors.push({
        field: 'settingSources.capOutcome',
        code: 'invalid-limit-origin',
        message: 'settingSources.capOutcome must be override, setting, or default.'
      });
    }
    if ('noProgressThreshold' in value.settingSources) {
      if (
        value.settingSources.noProgressThreshold === null ||
        typeof value.settingSources.noProgressThreshold !== 'string' ||
        !LIMIT_ORIGIN_SET.has(value.settingSources.noProgressThreshold)
      ) {
        errors.push({
          field: 'settingSources.noProgressThreshold',
          code: 'invalid-limit-origin',
          message: 'settingSources.noProgressThreshold must be omitted or override, setting, default.'
        });
      }
    }
  }

  if (!isPlainRecord(value.observedValues)) {
    errors.push({
      field: 'observedValues',
      code: 'invalid-observed-values',
      message: 'observedValues must be a plain object.'
    });
  } else {
    const entries = Object.entries(value.observedValues);
    if (entries.length > MAX_OBSERVED_VALUE_ENTRIES) {
      errors.push({
        field: 'observedValues',
        code: 'too-many-observed-values',
        message: `observedValues exceeds maximum of ${MAX_OBSERVED_VALUE_ENTRIES} entries.`
      });
    }
    for (const [k, v] of entries) {
      if (!isValidNonEmptyString(k, 128) || !isValidObservedScalar(v)) {
        errors.push({
          field: `observedValues.${k}`,
          code: 'invalid-observed-value',
          message: `observedValues['${k}'] must be a finite number, boolean, or bounded valid UTF-8 string.`
        });
      }
    }
  }

  if (typeof value.exitReason !== 'string' || !EXIT_REASON_SET.has(value.exitReason)) {
    errors.push({
      field: 'exitReason',
      code: 'invalid-exit-reason',
      message: 'exitReason must be a valid ExecutionDecisionExitReason.'
    });
  }

  if (!Array.isArray(value.branches)) {
    errors.push({
      field: 'branches',
      code: 'invalid-branches',
      message: 'branches must be an array.'
    });
  } else {
    for (let index = 0; index < value.branches.length; index += 1) {
      const branch = value.branches[index];
      const prefix = `branches[${index}]`;
      if (!isPlainRecord(branch)) {
        errors.push({
          field: prefix,
          code: 'invalid-branch-record',
          message: 'Branch record must be a plain object.'
        });
        continue;
      }
      for (const key of Object.keys(branch)) {
        if (!BRANCH_RECORD_KEYS.has(key)) {
          errors.push({
            field: `${prefix}.${key}`,
            code: 'unknown-field',
            message: `Unknown field '${key}' on branch record.`
          });
        }
      }
      if (
        typeof branch.connectionIndex !== 'number' ||
        !Number.isInteger(branch.connectionIndex) ||
        branch.connectionIndex < -1
      ) {
        errors.push({
          field: `${prefix}.connectionIndex`,
          code: 'invalid-connection-index',
          message: 'connectionIndex must be a finite integer >= -1.'
        });
      }
      if ('targetNodeId' in branch) {
        if (branch.targetNodeId === null || !isValidNonEmptyString(branch.targetNodeId)) {
          errors.push({
            field: `${prefix}.targetNodeId`,
            code: 'invalid-target-node-id',
            message: 'targetNodeId must be omitted or a non-empty valid UTF-8 string.'
          });
        }
      }
      if (typeof branch.isDefault !== 'boolean') {
        errors.push({
          field: `${prefix}.isDefault`,
          code: 'invalid-is-default',
          message: 'isDefault must be a boolean.'
        });
      }
      if ('priority' in branch) {
        if (
          branch.priority === null ||
          typeof branch.priority !== 'number' ||
          !Number.isInteger(branch.priority)
        ) {
          errors.push({
            field: `${prefix}.priority`,
            code: 'invalid-priority',
            message: 'priority must be omitted or a finite integer.'
          });
        }
      }
      if (typeof branch.disposition !== 'string' || !DISPOSITION_SET.has(branch.disposition)) {
        errors.push({
          field: `${prefix}.disposition`,
          code: 'invalid-disposition',
          message: 'disposition must be a valid ExecutionBranchDisposition.'
        });
      }
      if (!isValidNonEmptyString(branch.summary, MAX_OBSERVED_STRING_LENGTH)) {
        errors.push({
          field: `${prefix}.summary`,
          code: 'invalid-summary',
          message: 'summary must be a non-empty valid UTF-8 string.'
        });
      }
      if ('observedValue' in branch) {
        if (branch.observedValue === null || !isValidObservedScalar(branch.observedValue)) {
          errors.push({
            field: `${prefix}.observedValue`,
            code: 'invalid-observed-value',
            message: 'observedValue must be omitted or a valid scalar (never null).'
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: value as unknown as ExecutionDecisionObservation,
    errors: []
  };
}

export function isExecutionDecisionObservation(
  value: unknown
): value is ExecutionDecisionObservation {
  return validateExecutionDecisionObservation(value).valid;
}

const OPERATOR_SYMBOLS: Readonly<Record<WorkflowCondition['operator'], string>> = {
  equals: '=',
  notEquals: '!=',
  in: 'in',
  exists: 'exists',
  greaterThan: '>',
  greaterThanOrEqual: '>=',
  lessThan: '<',
  lessThanOrEqual: '<='
};

/**
 * Deterministic human-readable summary for a branch condition or fallback/unconditional arm.
 */
export function formatConditionSummary(
  condition: WorkflowCondition | undefined,
  isDefault?: boolean
): string {
  if (condition !== undefined) {
    const left =
      condition.left.source === 'node-status'
        ? `${condition.left.nodeId} status`
        : `${condition.left.nodeId}.${condition.left.field}`;
    if (condition.operator === 'exists') {
      return `${left} exists`;
    }
    const op = OPERATOR_SYMBOLS[condition.operator];
    const right = Array.isArray(condition.right)
      ? `[${condition.right.map(String).join(', ')}]`
      : String(condition.right ?? '');
    return `${left} ${op} ${right}`;
  }
  if (isDefault === true) {
    return 'Otherwise';
  }
  return 'Always';
}

/**
 * Deterministic badge summary for a Phase's repetition policy in the Builder and Run surfaces.
 */
export function formatPhaseRetrySummary(input: {
  readonly retryCondition?: string;
  readonly maxIterations?: number;
  readonly capOutcome?: RetryCapOutcome;
  readonly noProgressThreshold?: number;
}): string {
  const condition = input.retryCondition?.trim();
  if (!condition) {
    return 'Single pass (no retry condition)';
  }
  const parts: string[] = [`Repeats on ${condition}`];
  if (input.maxIterations !== undefined && Number.isFinite(input.maxIterations)) {
    parts.push(`max ${input.maxIterations}`);
  }
  if (input.capOutcome !== undefined) {
    parts.push(`on cap: ${input.capOutcome}`);
  }
  if (
    input.noProgressThreshold !== undefined &&
    Number.isFinite(input.noProgressThreshold) &&
    input.noProgressThreshold > 0
  ) {
    parts.push(`no-progress: ${input.noProgressThreshold}`);
  }
  return parts.join(' · ');
}

export function describeBranchDisposition(disposition: ExecutionBranchDisposition): string {
  switch (disposition) {
    case 'selected':
      return 'Selected';
    case 'fallback':
      return 'Selected (fallback)';
    case 'manual-handoff':
      return 'Selected (manual handoff)';
    case 'condition-false':
      return 'Not taken (condition false)';
    case 'unresolved':
      return 'Not taken (operand unresolved)';
    case 'priority-lost':
      return 'Not taken (lower priority)';
    case 'failure-excluded':
      return 'Not taken (unhandled node failure)';
    case 'no-route':
      return 'No route matched';
  }
}

export function describeExitReason(exitReason: ExecutionDecisionExitReason): string {
  switch (exitReason) {
    case 'condition-cleared':
      return 'Condition cleared';
    case 'repeat':
      return 'Repeating phase';
    case 'cap-failed':
      return 'Stopped at iteration cap (failed)';
    case 'cap-continued':
      return 'Continued at iteration cap';
    case 'cap-degraded':
      return 'Continued degraded at iteration cap';
    case 'no-progress':
      return 'Stopped on unchanged metrics';
    case 'missing-evidence':
      return 'Stopped on missing verification evidence';
    case 'host-control':
      return 'Halted by host control';
  }
}
