import {
  PHASE_EFFORT_LEVELS,
  PHASE_EVIDENCE_POLICIES,
  PHASE_ID_MAX_LEN,
  PHASE_RETRY_CONDITION_MAX_LEN,
  PHASE_SIDE_EFFECTS,
  type PhaseDefinition,
  type PhaseEvidencePolicy,
  type PhaseFieldError,
  type PhaseSideEffects
} from '../contracts/process-definitions';
import { validate as validateRetryCondition } from '../lib/retry-condition';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../runner/backend-runner-factory';

export const PHASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export { PHASE_ID_MAX_LEN };
export const PHASE_NAME_MAX_LEN = 80;
export const PHASE_DESCRIPTION_MAX_LEN = 1024;
export const PHASE_INSTRUCTION_MAX_LEN = 8192;
export const PHASE_SKILL_MAX_LEN = 256;
export const PHASE_TIMEOUT_MIN = 1;
export const PHASE_TIMEOUT_MAX = 3600;

export const AUTHORED_PHASE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'phaseId',
  'name',
  'description',
  'version',
  'instruction',
  'skill',
  'model',
  'effort',
  'timeoutSeconds',
  'loopable',
  'retryCondition',
  'isRequired',
  'forceContinueOnRetryCap',
  'runner',
  // Feature 098 T015 — authored, not host-resolved. The save path and the import
  // path must hold a definition to the same closed set, or a Phase would be
  // accepted by one route and refused by the other on the same field.
  'sideEffects',
  'evidencePolicy'
]);

const ERROR_MESSAGE_MAX = 512;
const ERROR_FIELD_MAX = 32;
const ERROR_CODE_MAX = 64;

export interface PhaseDefinitionValidationOptions {
  readonly allowLegacyId?: boolean;
  readonly defaultVersion?: number;
}

export interface PhaseDefinitionValidationResult {
  readonly ok: boolean;
  readonly phaseId: string;
  readonly definition: PhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PhaseFieldError[];
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function fieldError(
  phaseId: string,
  field: string,
  code: string,
  message: string
): PhaseFieldError {
  return Object.freeze({
    phaseId: bounded(phaseId || '?', PHASE_ID_MAX_LEN),
    field: bounded(field, ERROR_FIELD_MAX),
    code: bounded(code, ERROR_CODE_MAX),
    message: bounded(message, ERROR_MESSAGE_MAX)
  });
}

function recognizedDisplay(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const display: Record<string, unknown> = {};
  for (const field of AUTHORED_PHASE_FIELDS) {
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

export function validatePhaseDefinition(
  raw: unknown,
  options: PhaseDefinitionValidationOptions = {}
): PhaseDefinitionValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const error = fieldError('?', 'entry', 'object-required', 'Phase entry must be an object');
    return {
      ok: false,
      phaseId: '?',
      definition: null,
      display: Object.freeze({}),
      errors: Object.freeze([error])
    };
  }

  const value = raw as Record<string, unknown>;
  const display = recognizedDisplay(value);
  const errors: PhaseFieldError[] = [];
  const hasPortableId = Object.prototype.hasOwnProperty.call(value, 'phaseId');
  const hasLegacyId = Object.prototype.hasOwnProperty.call(value, 'id');
  const rawId = hasPortableId
    ? value.phaseId
    : options.allowLegacyId !== false
      ? value.id
      : undefined;
  const phaseId = typeof rawId === 'string' ? rawId.trim() : '?';

  for (const key of Object.keys(value)) {
    if (!AUTHORED_PHASE_FIELDS.has(key)) {
      errors.push(
        fieldError(phaseId, key, 'unknown-field', `Unknown authored Phase field '${bounded(key, ERROR_FIELD_MAX)}'`)
      );
    }
  }
  if (hasPortableId && hasLegacyId) {
    errors.push(
      fieldError(phaseId, 'phaseId', 'identity-ambiguous', 'Use phaseId or legacy id, not both')
    );
  }
  if (typeof rawId !== 'string' || !PHASE_ID_PATTERN.test(phaseId)) {
    errors.push(
      fieldError(
        phaseId,
        'phaseId',
        'invalid-pattern',
        `Phase id must match ${PHASE_ID_PATTERN.source}`
      )
    );
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > PHASE_NAME_MAX_LEN) {
    errors.push(
      fieldError(
        phaseId,
        'name',
        'invalid-length',
        `Phase name must contain 1 to ${PHASE_NAME_MAX_LEN} characters`
      )
    );
  }

  let description: string | undefined;
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.length > PHASE_DESCRIPTION_MAX_LEN) {
      errors.push(
        fieldError(
          phaseId,
          'description',
          'invalid-length',
          `Phase description must be at most ${PHASE_DESCRIPTION_MAX_LEN} characters`
        )
      );
    } else {
      description = value.description;
    }
  }

  const versionValue = value.version ?? options.defaultVersion;
  const version = typeof versionValue === 'number' ? versionValue : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    errors.push(
      fieldError(phaseId, 'version', 'positive-integer-required', 'Phase version must be a positive integer')
    );
  }

  const instruction = typeof value.instruction === 'string' ? value.instruction : undefined;
  const skill = typeof value.skill === 'string' ? value.skill.trim() : undefined;
  const hasInstruction = instruction !== undefined && instruction.trim().length > 0;
  const hasSkill = skill !== undefined && skill.length > 0;
  if (hasInstruction === hasSkill) {
    errors.push(
      fieldError(
        phaseId,
        'directive',
        'exactly-one-required',
        'Provide exactly one of instruction or skill'
      )
    );
  }
  if (instruction !== undefined && (!hasInstruction || instruction.length > PHASE_INSTRUCTION_MAX_LEN)) {
    errors.push(
      fieldError(
        phaseId,
        'instruction',
        'invalid-length',
        `Phase instruction must contain 1 to ${PHASE_INSTRUCTION_MAX_LEN} characters`
      )
    );
  }
  if (skill !== undefined && (!hasSkill || skill.length > PHASE_SKILL_MAX_LEN)) {
    errors.push(
      fieldError(
        phaseId,
        'skill',
        'invalid-length',
        `Phase skill must contain 1 to ${PHASE_SKILL_MAX_LEN} characters`
      )
    );
  }

  let model: string | undefined;
  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || value.model.trim().length === 0) {
      errors.push(fieldError(phaseId, 'model', 'non-empty-required', 'Phase model must be non-empty'));
    } else {
      model = value.model.trim();
    }
  }

  let effort: PhaseDefinition['effort'];
  if (value.effort !== undefined) {
    if (
      typeof value.effort !== 'string' ||
      !(PHASE_EFFORT_LEVELS as readonly string[]).includes(value.effort)
    ) {
      errors.push(
        fieldError(
          phaseId,
          'effort',
          'invalid-enum',
          `Phase effort must be one of ${PHASE_EFFORT_LEVELS.join(', ')}`
        )
      );
    } else {
      effort = value.effort as PhaseDefinition['effort'];
    }
  }

  let runner: BackendRunnerKind | undefined;
  if (value.runner !== undefined) {
    if (
      typeof value.runner !== 'string' ||
      !(SUPPORTED_BACKENDS as readonly string[]).includes(value.runner)
    ) {
      errors.push(
        fieldError(
          phaseId,
          'runner',
          'invalid-enum',
          `Phase runner must be one of ${SUPPORTED_BACKENDS.join(', ')}`
        )
      );
    } else {
      runner = value.runner as BackendRunnerKind;
    }
  }
  // Feature 098 T015 — membership against the same two sets the exchange reader
  // uses, value-imported from `contracts/process-definitions` so there is one
  // legal-value list per field rather than one per entry route (FR-001, FR-002).
  let sideEffects: PhaseSideEffects | undefined;
  if (value.sideEffects !== undefined) {
    if (
      typeof value.sideEffects !== 'string' ||
      !(PHASE_SIDE_EFFECTS as readonly string[]).includes(value.sideEffects)
    ) {
      errors.push(
        fieldError(
          phaseId,
          'sideEffects',
          'invalid-enum',
          `Phase sideEffects must be one of ${PHASE_SIDE_EFFECTS.join(', ')}`
        )
      );
    } else {
      sideEffects = value.sideEffects as PhaseSideEffects;
    }
  }

  let evidencePolicy: PhaseEvidencePolicy | undefined;
  if (value.evidencePolicy !== undefined) {
    if (
      typeof value.evidencePolicy !== 'string' ||
      !(PHASE_EVIDENCE_POLICIES as readonly string[]).includes(value.evidencePolicy)
    ) {
      errors.push(
        fieldError(
          phaseId,
          'evidencePolicy',
          'invalid-enum',
          `Phase evidencePolicy must be one of ${PHASE_EVIDENCE_POLICIES.join(', ')}`
        )
      );
    } else {
      evidencePolicy = value.evidencePolicy as PhaseEvidencePolicy;
    }
  }

  if (runner === 'agy' && (effort === 'xhigh' || effort === 'max')) {
    errors.push(
      fieldError(
        phaseId,
        'effort',
        'runner-incompatible',
        'Agy supports low, medium, or high effort'
      )
    );
  }

  let timeoutSeconds: number | undefined;
  if (value.timeoutSeconds !== undefined) {
    if (
      typeof value.timeoutSeconds !== 'number' ||
      !Number.isInteger(value.timeoutSeconds) ||
      value.timeoutSeconds < PHASE_TIMEOUT_MIN ||
      value.timeoutSeconds > PHASE_TIMEOUT_MAX
    ) {
      errors.push(
        fieldError(
          phaseId,
          'timeoutSeconds',
          'invalid-range',
          `Phase timeoutSeconds must be an integer from ${PHASE_TIMEOUT_MIN} to ${PHASE_TIMEOUT_MAX}`
        )
      );
    } else {
      timeoutSeconds = value.timeoutSeconds;
    }
  }

  const loopable = value.loopable;
  if (loopable !== undefined && typeof loopable !== 'boolean') {
    errors.push(fieldError(phaseId, 'loopable', 'boolean-required', 'Phase loopable must be boolean'));
  }
  const isRequired = value.isRequired;
  if (isRequired !== undefined && typeof isRequired !== 'boolean') {
    errors.push(
      fieldError(phaseId, 'isRequired', 'boolean-required', 'Phase isRequired must be boolean')
    );
  }
  const forceContinueOnRetryCap = value.forceContinueOnRetryCap;
  if (forceContinueOnRetryCap !== undefined && typeof forceContinueOnRetryCap !== 'boolean') {
    errors.push(
      fieldError(
        phaseId,
        'forceContinueOnRetryCap',
        'boolean-required',
        'Phase forceContinueOnRetryCap must be boolean'
      )
    );
  }

  let retryCondition: string | undefined;
  if (value.retryCondition !== undefined) {
    if (typeof value.retryCondition !== 'string' || value.retryCondition.trim().length === 0) {
      errors.push(
        fieldError(
          phaseId,
          'retryCondition',
          'non-empty-required',
          'Phase retryCondition must be non-empty'
        )
      );
    } else if (value.retryCondition.length > PHASE_RETRY_CONDITION_MAX_LEN) {
      // Refused before the evaluator is entered, and reported as a length rather
      // than as an invalid expression — an over-long condition is not a syntax
      // error, and an operator reading `invalid-expression` would go looking for
      // one (feature 111, FR-009, FR-029).
      //
      // The message names the actual length as well as the limit, which is the one
      // way it departs from the four sibling bounds above ("Phase name must
      // contain 1 to 64 characters"). FR-012 asks for both numbers on all three
      // routes, in the same words, because this is the only one of the five
      // bounded fields an operator meets on three of them — the import, this
      // resolver, and the runner — and "how far over" is the actionable half.
      // The runner's copy lives in `lib/retry-condition.ts` and cannot carry a
      // `Phase` prefix (it validates a bare source, and is byte-mirrored into the
      // webview), so the shared wording is the one without it.
      errors.push(
        fieldError(
          phaseId,
          'retryCondition',
          'invalid-length',
          `retryCondition is ${value.retryCondition.length} characters; the maximum is ${PHASE_RETRY_CONDITION_MAX_LEN}`
        )
      );
    } else {
      const parsed = validateRetryCondition(value.retryCondition);
      if (!parsed.ok) {
        errors.push(
          fieldError(
            phaseId,
            'retryCondition',
            'invalid-expression',
            `Retry condition is invalid: ${parsed.error}`
          )
        );
      } else {
        retryCondition = value.retryCondition;
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      phaseId,
      definition: null,
      display,
      errors: Object.freeze(errors)
    };
  }

  const common = {
    phaseId,
    name,
    version,
    ...(description !== undefined ? { description } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(typeof loopable === 'boolean' ? { loopable } : {}),
    ...(retryCondition !== undefined ? { retryCondition } : {}),
    ...(typeof isRequired === 'boolean' ? { isRequired } : {}),
    ...(typeof forceContinueOnRetryCap === 'boolean' ? { forceContinueOnRetryCap } : {}),
    ...(runner !== undefined ? { runner } : {}),
    ...(sideEffects !== undefined ? { sideEffects } : {}),
    ...(evidencePolicy !== undefined ? { evidencePolicy } : {})
  };
  const definition: PhaseDefinition = hasInstruction
    ? { ...common, instruction: instruction as string }
    : { ...common, skill: skill as string };
  return {
    ok: true,
    phaseId,
    definition: Object.freeze(definition),
    display,
    errors: Object.freeze([])
  };
}
