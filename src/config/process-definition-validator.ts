import {
  AUTHORED_PHASE_FIELDS,
  PHASE_EFFORT_LEVELS,
  PHASE_EVIDENCE_POLICIES,
  PHASE_HOST_VERIFICATIONS,
  PHASE_ID_MAX_LEN,
  PHASE_RETRY_CONDITION_MAX_LEN,
  PHASE_SIDE_EFFECTS,
  type PhaseDefinition,
  type PhaseEvidencePolicy,
  type PhaseHostVerification,
  type PhaseFieldError,
  type PhaseSideEffects
} from '../contracts/process-definitions';
import { validate as validateRetryCondition } from '../lib/retry-condition';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../contracts/backend-kinds';
import {
  ALL_PHASE_CAPABILITIES,
  isPhaseCapability,
  type PhaseCapability
} from '../contracts/phase-capabilities';
import { ARGV_VALUE_MAX_LEN, ARGV_VALUE_PATTERN } from '../contracts/argv-value';
import { recognizedAuthoredDisplay } from './authored-display';

export const PHASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export { PHASE_ID_MAX_LEN };
export const PHASE_NAME_MAX_LEN = 80;
export const PHASE_DESCRIPTION_MAX_LEN = 1024;
export const PHASE_INSTRUCTION_MAX_LEN = 8192;
export const PHASE_SKILL_MAX_LEN = 256;
export const PHASE_TIMEOUT_MIN = 1;
export const PHASE_TIMEOUT_MAX = 3600;

/**
 * FR-R3-112 — bounds on the authored per-phase spend override.
 *
 * A ceiling as well as a floor, for the same reason every other authored bound has
 * one: an operator-imported document controls this value, and a bound of
 * `Number.MAX_VALUE` is a bound that never fires while reading as governance. The
 * ceilings are deliberately generous — they refuse absurdity, not ambition.
 */
export const PHASE_SPEND_USD_MIN = 0.01;
export const PHASE_SPEND_USD_MAX = 10_000;
export const PHASE_SPEND_TOKENS_MIN = 1;
export const PHASE_SPEND_TOKENS_MAX = 1_000_000_000;

/**
 * FR-R3-105 — the argv boundary. Every authored field falls in exactly one of three
 * classes, and `tests/lint/argv-field-partition.test.ts` asserts the three cover
 * `AUTHORED_PHASE_FIELDS` exactly.
 *
 * WHY A PARTITION RATHER THAN A BOUND ON TWO NAMED FIELDS. A pipeline document is
 * operator-imported, **untrusted** content. `model` was validated as a non-empty string
 * and pushed as its own argv token at all three backends, so a document supplying
 * `model: "--dangerously-skip-permissions"` put that literal flag into the child's argv.
 * Spawns are `shell: false` throughout, so this is not shell injection — it is **flag
 * injection**, and the authority it grants is exactly the authority the capability plan
 * exists to narrow, through a field the narrowing never sees.
 *
 * Naming `model` and `effort` and stopping would leave the same hole open for the next
 * argv-reaching field someone authors. The partition makes that impossible to add
 * silently: a new authored field must be classified or the gate fails.
 *
 * The three classes, and why `effort` is in the second rather than the first: the source
 * item states that `effort` "has the same shape" as `model`. Its *emission* does, but its
 * *validation* does not — it is already closed to `PHASE_EFFORT_LEVELS`, a five-value
 * enum, so a leading dash cannot survive validation. Adding a charset bound to it would
 * be a redundant second check on a field that is already closed, and recording it as
 * enum-covered is more honest than pretending it was fixed here.
 */
export const ARGV_FREE_FORM_FIELDS: ReadonlySet<string> = new Set(['model']);

/** Reaches argv, but already closed to an enum, so no charset bound is owed. */
export const ARGV_ENUM_CLOSED_FIELDS: ReadonlySet<string> = new Set(['effort']);

/**
 * The charset bound is NOT declared here. `src/contracts/argv-value.ts` owns it, and both
 * this freeze-site check and the dispatch-time defensive check read that one authority —
 * two copies of "what does a safe argv value look like" is how a validator and a
 * dispatcher come to disagree, and the disagreement would present as a run that executed
 * rather than a refusal.
 */
export { ARGV_VALUE_PATTERN, ARGV_VALUE_MAX_LEN } from '../contracts/argv-value';

/**
 * The closed set of authored Phase fields, re-exported.
 *
 * `src/contracts/process-definitions.ts` owns it, on the same reasoning as
 * `PHASE_ID_MAX_LEN` and `ARGV_VALUE_PATTERN` above: the Builder is bundled into
 * the webview and cannot import this module, and a set it cannot read is a set it
 * forks. Re-exported here so every existing caller keeps naming one bound.
 */
export { AUTHORED_PHASE_FIELDS };

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

/**
 * FR-R3-112 — one bound check for both spend fields.
 *
 * Written once rather than twice because the only difference between them is
 * whether the figure is a whole number: dollars are not, tokens are. Two copies of
 * the same range check is how the USD field and the token field come to disagree
 * about what "out of range" means, and the refusal must name the field either way.
 */
function boundedSpend(
  value: unknown,
  field: 'spendBoundUsd' | 'spendBoundTokens',
  min: number,
  max: number,
  integral: boolean,
  phaseId: string,
  errors: PhaseFieldError[]
): number | undefined {
  if (value === undefined) return undefined;
  const valid =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!integral || Number.isInteger(value)) &&
    value >= min &&
    value <= max;
  if (!valid) {
    errors.push(
      fieldError(
        phaseId,
        field,
        'invalid-range',
        `Phase ${field} must be ${integral ? 'an integer' : 'a number'} from ${min} to ${max}`
      )
    );
    return undefined;
  }
  return value;
}

function recognizedDisplay(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return recognizedAuthoredDisplay(raw, AUTHORED_PHASE_FIELDS);
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
      const candidate = value.model.trim();
      // FR-R3-105 — REFUSED, never rewritten. A leading `-` is not stripped and an
      // out-of-charset value is not sanitised: the `catalogVersion` rule's reasoning
      // applies, because laundering an untrusted value into a legitimate-looking one is
      // worse than declining it. The refusal names the field so the operator knows which
      // row of their document to fix.
      if (candidate.length > ARGV_VALUE_MAX_LEN) {
        errors.push(
          fieldError(
            phaseId,
            'model',
            'invalid-length',
            `Phase model must be at most ${ARGV_VALUE_MAX_LEN} characters`
          )
        );
      } else if (!ARGV_VALUE_PATTERN.test(candidate)) {
        errors.push(
          fieldError(
            phaseId,
            'model',
            'invalid-charset',
            'Phase model reaches the backend command line, so it must start with a letter ' +
              'or digit and use only letters, digits and . _ : / -'
          )
        );
      } else {
        model = candidate;
      }
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

  // FR-R3-058 — same shape as `evidencePolicy` above, deliberately: a second
  // validation idiom for a second enum on the same object is how one of them
  // ends up looser than the other.
  let hostVerification: PhaseHostVerification | undefined;
  if (value.hostVerification !== undefined) {
    if (
      typeof value.hostVerification !== 'string' ||
      !(PHASE_HOST_VERIFICATIONS as readonly string[]).includes(value.hostVerification)
    ) {
      errors.push(
        fieldError(
          phaseId,
          'hostVerification',
          'invalid-enum',
          `Phase hostVerification must be one of ${PHASE_HOST_VERIFICATIONS.join(', ')}`
        )
      );
    } else {
      hostVerification = value.hostVerification as PhaseHostVerification;
    }
  }

  // FR-R3-086 — the declared capability set.
  //
  // REJECTED, not silently dropped, when a member is unknown. `declaredCapabilitySet`
  // filters to known members, so a typo would otherwise yield an EMPTY set — every
  // capability withheld — and the phase would be refused at run time for a reason
  // no one could see from the definition. Fail-closed is the right direction and a
  // silent one is still the wrong report.
  let capabilities: PhaseCapability[] | undefined;
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities)) {
      errors.push(
        fieldError(phaseId, 'capabilities', 'array-required', 'Phase capabilities must be an array')
      );
    } else {
      const unknown = value.capabilities.filter((entry) => !isPhaseCapability(entry));
      const members = value.capabilities as unknown[];
      const repeated = members.filter((entry, index) => members.indexOf(entry) !== index);
      if (unknown.length > 0) {
        errors.push(
          fieldError(
            phaseId,
            'capabilities',
            'invalid-enum',
            `Phase capabilities must each be one of ${ALL_PHASE_CAPABILITIES.join(', ')}`
          )
        );
      } else if (repeated.length > 0) {
        // Refused HERE as well as in the exchange format's reader, and the two
        // must agree: a definition this validator accepts but the reader refuses
        // is one that cannot survive its own export. The set is what carries
        // meaning, so a repeat carries none and is an authoring error.
        errors.push(
          fieldError(
            phaseId,
            'capabilities',
            'duplicate-member',
            'Phase capabilities must not repeat a member'
          )
        );
      } else {
        capabilities = value.capabilities as PhaseCapability[];
      }
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

  const spendBoundUsd = boundedSpend(
    value.spendBoundUsd,
    'spendBoundUsd',
    PHASE_SPEND_USD_MIN,
    PHASE_SPEND_USD_MAX,
    false,
    phaseId,
    errors
  );
  const spendBoundTokens = boundedSpend(
    value.spendBoundTokens,
    'spendBoundTokens',
    PHASE_SPEND_TOKENS_MIN,
    PHASE_SPEND_TOKENS_MAX,
    true,
    phaseId,
    errors
  );

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
    ...(spendBoundUsd !== undefined ? { spendBoundUsd } : {}),
    ...(spendBoundTokens !== undefined ? { spendBoundTokens } : {}),
    ...(typeof loopable === 'boolean' ? { loopable } : {}),
    ...(retryCondition !== undefined ? { retryCondition } : {}),
    ...(typeof isRequired === 'boolean' ? { isRequired } : {}),
    ...(typeof forceContinueOnRetryCap === 'boolean' ? { forceContinueOnRetryCap } : {}),
    ...(runner !== undefined ? { runner } : {}),
    ...(sideEffects !== undefined ? { sideEffects } : {}),
    ...(evidencePolicy !== undefined ? { evidencePolicy } : {}),
    ...(hostVerification !== undefined ? { hostVerification } : {}),
    ...(capabilities !== undefined ? { capabilities } : {})
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
