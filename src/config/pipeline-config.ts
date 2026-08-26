export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
import type { PhaseCapability } from '../contracts/phase-capabilities';
import { SUPPORTED_BACKENDS, isBackendRunnerKind, type BackendRunnerKind } from '../contracts/backend-kinds';
// One declaration serves the authored contract and the runtime shape. These were
// duplicated string unions here; a Phase now declares its own containment class,
// so a second copy would let the document field and the runtime field drift with
// nothing to catch it. Re-exported because `PhaseSideEffects` /
// `PhaseEvidencePolicy` are part of this module's published surface.
export {
  PHASE_SIDE_EFFECTS,
  PHASE_EVIDENCE_POLICIES,
  EVIDENCE_POLICY_ORIGINS,
  type PhaseSideEffects,
  type PhaseEvidencePolicy,
  type EvidencePolicyOrigin
} from '../contracts/process-definitions';
import type {
  PhaseSideEffects,
  PhaseEvidencePolicy,
  EvidencePolicyOrigin,
  PhaseHostVerification
} from '../contracts/process-definitions';
import type {
  PhaseBinding,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from '../contracts/pipeline-definitions';
import { AUTHORED_PHASE_FIELDS, validatePhaseDefinition } from './process-definition-validator';
import { validatePipelineDefinition } from './pipeline-definition-validator';
export interface PhaseDef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  /** FR-R3-112 — per-phase spend bound in USD; see `PhaseDefinitionBase`. */
  readonly spendBoundUsd?: number;
  /** FR-R3-112 — per-phase spend bound in tokens, for backends reporting no cost. */
  readonly spendBoundTokens?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  /**
   * Advance instead of failing when `retryCondition` is still truthy at the
   * iteration cap. Overrides `schegent.retry.forceContinueOnCap`; see
   * `PhaseDefLike.forceContinueOnRetryCap` in controller/phase.ts.
   */
  readonly forceContinueOnRetryCap?: boolean;
  readonly runner?: BackendRunnerKind;
  readonly sideEffects?: PhaseSideEffects; // Omission => `workspace` at the freeze.
  readonly evidencePolicy?: PhaseEvidencePolicy;
  /**
   * FR-R3-096 — where `evidencePolicy` came from. Written by the freeze, never
   * authored: an operator document that set it would be forging its own consent.
   * Absent means `'default'`, which is every snapshot taken before this field.
   */
  readonly evidencePolicyDeclaredAt?: EvidencePolicyOrigin;
  /** FR-R3-058 — omission means `model-token`. */
  readonly hostVerification?: PhaseHostVerification;
  readonly promptVersion?: string;
  /**
   * FR-R3-086 — what this phase's agent may do.
   *
   * **Omission means every capability**, which is the historical behaviour and
   * the common case: the phase spawns with today's argv, byte for byte.
   * Narrowing is opt-in, per phase, and is frozen into the Run's pipeline
   * snapshot with the rest of the plan.
   */
  readonly capabilities?: readonly PhaseCapability[];
}
// Feature 082 — the runtime Pipeline shape. `id`, `name`, and `phases` are the
// legacy required trio; every contract field added by the Pipeline Builder is
// optional and normalizes on parse so a row authored before those fields existed
// keeps resolving without a rewrite (research R2).
export interface PipelineDef {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
  readonly description?: string;
  readonly version?: number;
  readonly inputs?: readonly PipelineInputPort[];
  readonly outputs?: readonly PipelineOutputPort[];
  readonly bindings?: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
}
export interface PipelineCatalog {
  readonly phases: readonly PhaseDef[];
  readonly pipelines: readonly PipelineDef[];
  readonly models: Record<BackendRunnerKind, readonly string[]>;
  readonly defaultPipelineId: string;
  readonly phasesById: ReadonlyMap<string, PhaseDef>;
  readonly pipelinesById: ReadonlyMap<string, PipelineDef>;
}
export interface ValidationError {
  readonly source: 'phase' | 'pipeline' | 'defaultPipelineId';
  readonly id?: string;
  readonly field?: string;
  readonly message: string;
}
export interface ValidationWarning {
  readonly source: 'phase' | 'pipeline' | 'limit';
  readonly id?: string;
  readonly message: string;
}
export interface ValidationReport {
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}
export const PHASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const ID_MAX_LEN = 64;
export const NAME_MAX_LEN = 80;
export const INSTRUCTION_MAX_LEN = 8192;
export const TIMEOUT_MIN = 1;
export const TIMEOUT_MAX = 3600;
export const SOFT_CAP_PHASES = 50;
export const SOFT_CAP_PIPELINES = 20;
export const SOFT_CAP_PIPELINE_PHASES = 50;
/**
 * `true` iff `payload` is the reset-to-defaults save: the empty catalog.
 *
 * Feature 099 (T489, FR-039) — this replaces `equalsBuiltInPhases`,
 * `equalsBuiltInPipelines`, and `equalsBuiltInWorkflows`, which each compared a
 * payload against its layer's `BUILT_IN_*` constant. All three constants were
 * `Object.freeze([])` by the end of feature 098, and all three are deleted with
 * the layer tier, so "byte-equivalent to the built-in layer" is now spelled
 * "empty" — one function rather than three, because three answers to one
 * question is three chances to drift.
 *
 * The trust gate reads this to recognize a reset, so an operator can always
 * return to defaults from a denied state (feature 059's I-2 invariant). Only the
 * Phase gate still consults it: the Pipeline and Workflow override capabilities
 * are gone (FR-045), so their saves have no per-capability gate left to bypass.
 */
export function isResetToDefaultsPayload(payload: readonly unknown[]): boolean {
  return payload.length === 0;
}

/**
 * The authored fields `validateCatalog` keeps when it strips a resolved
 * `PhaseDef` back down to what an operator wrote, before handing it to the
 * portable validator.
 *
 * Derived from `AUTHORED_PHASE_FIELDS` rather than restated. It was a hand-kept
 * copy, and it fell two behind: feature 098 added `sideEffects` and
 * `evidencePolicy` to the authored set, so this filter discarded both before
 * `validatePhaseRaw` could reach its own enum checks for them — the one oracle
 * whose job is to catch a bad containment class could not see the field. Only
 * `phaseId` is dropped, the YAML spelling of `id` that a stored Phase row
 * never carries.
 */
export const ALLOWED_PHASE_FIELDS: ReadonlySet<string> = new Set(
  Array.from(AUTHORED_PHASE_FIELDS).filter((field) => field !== 'phaseId')
);

const ALLOWED_PIPELINE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'phases',
  'description',
  'version',
  'inputs',
  'outputs',
  'bindings',
  'executionDefaults',
  'recommendedNext'
]);

export function isPhaseDef(value: unknown): value is PhaseDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const hasInstruction = typeof v.instruction === 'string' && v.instruction.trim().length > 0;
  const hasSkill = typeof v.skill === 'string' && v.skill.trim().length > 0;
  const structurallyValid = (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    hasInstruction !== hasSkill &&
    (v.description === undefined || typeof v.description === 'string') &&
    (v.version === undefined || (Number.isSafeInteger(v.version) && (v.version as number) > 0)) &&
    (v.model === undefined || typeof v.model === 'string') &&
    (v.effort === undefined ||
      (typeof v.effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v.effort))) &&
    (v.timeoutSeconds === undefined || typeof v.timeoutSeconds === 'number') &&
    (v.loopable === undefined || typeof v.loopable === 'boolean') &&
    (v.retryCondition === undefined ||
      (typeof v.retryCondition === 'string' && v.retryCondition.length > 0)) &&
    (v.isRequired === undefined || typeof v.isRequired === 'boolean') &&
    (v.forceContinueOnRetryCap === undefined ||
      typeof v.forceContinueOnRetryCap === 'boolean') &&
    (v.runner === undefined || isBackendRunnerKind(v.runner))
  );
  return structurallyValid;
}

function isObjectArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((e) => !!e && typeof e === 'object' && !Array.isArray(e));
}

export function isPipelineDef(value: unknown): value is PipelineDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    Array.isArray(v.phases) &&
    v.phases.every((p) => typeof p === 'string') &&
    (v.description === undefined || typeof v.description === 'string') &&
    (v.version === undefined || (Number.isSafeInteger(v.version) && (v.version as number) > 0)) &&
    (v.inputs === undefined || isObjectArray(v.inputs)) &&
    (v.outputs === undefined || isObjectArray(v.outputs)) &&
    (v.bindings === undefined || isObjectArray(v.bindings)) &&
    (v.executionDefaults === undefined ||
      (!!v.executionDefaults &&
        typeof v.executionDefaults === 'object' &&
        !Array.isArray(v.executionDefaults))) &&
    (v.recommendedNext === undefined ||
      (Array.isArray(v.recommendedNext) &&
        v.recommendedNext.every((r) => typeof r === 'string')))
  );
}

export interface RuntimePolicyInput {
  readonly models?: Record<BackendRunnerKind, readonly string[]> | readonly string[]; // support migration from array
  readonly defaultPipelineId?: string;
}

/**
 * Merge the two runtime-policy settings that are still layered: the model lists
 * (union, workspace then user) and `defaultPipelineId` (workspace wins).
 *
 * Feature 099 (T489, FR-042) — this is what is left of `mergeCatalog`. That
 * function merged Phases and Pipelines across `built-in`/`user`/`workspace` too,
 * and both of those halves are gone: definitions now come from one layer, so
 * `resolvePhaseCatalog` and `resolvePipelineCatalog` produce the whole effective
 * set on their own and there is nothing left to precedence-order. Its
 * per-layer duplicate warnings go with it — `invalidateDuplicates` in the two
 * resolvers already reports a repeated id, and reports it as a defect on the row
 * rather than as "last-defined wins".
 *
 * `schegent.models` and `schegent.defaultPipelineId` are not retired keys
 * (FR-054 names only the three definition keys), so they keep their user and
 * workspace scopes and keep needing this.
 */
export function mergeRuntimePolicy(
  user: RuntimePolicyInput,
  workspace: RuntimePolicyInput
): {
  models: Record<BackendRunnerKind, readonly string[]>;
  defaultPipelineId: string;
} {
  const modelsMap = new Map<BackendRunnerKind, Set<string>>();

  // Workspace before user, the established model union order.
  for (const input of [workspace, user]) {
    if (!input.models) continue;
    if (Array.isArray(input.models)) {
      let set = modelsMap.get('claude');
      if (!set) {
        set = new Set<string>();
        modelsMap.set('claude', set);
      }
      for (const m of input.models) set.add(m);
      continue;
    }
    for (const kind of SUPPORTED_BACKENDS) {
      const arr = (input.models as Record<BackendRunnerKind, readonly string[]>)[kind];
      if (!arr) continue;
      let set = modelsMap.get(kind);
      if (!set) {
        set = new Set<string>();
        modelsMap.set(kind, set);
      }
      for (const m of arr) set.add(m);
    }
  }

  return {
    models: {
      claude: Object.freeze(Array.from(modelsMap.get('claude') ?? [])),
      codex: Object.freeze(Array.from(modelsMap.get('codex') ?? [])),
      agy: Object.freeze(Array.from(modelsMap.get('agy') ?? []))
    },
    // Feature 098 (T081, FR-033) — no layer supplies a built-in default, so an
    // unconfigured host has none, and the empty string is how that is spelled.
    defaultPipelineId: workspace.defaultPipelineId ?? user.defaultPipelineId ?? ''
  };
}

export function buildCatalog(
  phases: readonly PhaseDef[],
  pipelines: readonly PipelineDef[],
  models: Record<BackendRunnerKind, readonly string[]>,
  defaultPipelineId: string
): PipelineCatalog {
  const phasesById = new Map<string, PhaseDef>();
  const normalizedPhases = phases.map((phase) =>
    phase.version === undefined ? Object.freeze({ ...phase, version: 1 }) : phase
  );
  for (const p of normalizedPhases) {
    phasesById.set(p.id, p);
  }
  const pipelinesById = new Map<string, PipelineDef>();
  for (const pl of pipelines) {
    pipelinesById.set(pl.id, pl);
  }
  return Object.freeze({
    phases: Object.freeze(normalizedPhases),
    pipelines: Object.freeze([...pipelines]),
    models: Object.freeze(models),
    defaultPipelineId,
    phasesById,
    pipelinesById
  });
}

/**
 * The catalog with nothing in it: no Phases, no Pipelines, no models, and — since
 * there are no Pipelines to name — no default.
 *
 * Feature 098 (T036/T041) — this replaces `BUILT_IN_CATALOG` in the one role it
 * had left, as the fallback a caller reaches for when it was handed no catalog.
 * `BUILT_IN_CATALOG` was that fallback built from the seventeen built-in Phases
 * and three built-in Pipelines, so a host with no configuration came up offering
 * a process the operator had never imported. Built through `buildCatalog` rather
 * than hand-rolled, so the frozen arrays and empty id maps have the same shape
 * every other catalog has. `pipeline-config-loader.ts` reads this too; it is one
 * constant so the two cannot answer differently.
 */
export const EMPTY_CATALOG: PipelineCatalog = buildCatalog(
  [],
  [],
  { claude: [], codex: [], agy: [] },
  ''
);

export function validatePhaseRaw(value: unknown): readonly ValidationError[] {
  const result = validatePhaseDefinition(value, { allowLegacyId: true, defaultVersion: 1 });
  return result.errors.map((error) => ({
    source: 'phase' as const,
    id: error.phaseId === '?' ? undefined : error.phaseId,
    field: error.field === 'phaseId' ? 'id' : error.field,
    message: error.message
  }));
}

/**
 * Maps a portable `PipelineFieldError.field` onto the legacy authored field
 * name this settings-layer report has always used (`pipelineId` → `id`,
 * `phaseIds…` → `phases…`), so existing consumers keep their field contract
 * while the shape checks move into `pipeline-definition-validator.ts`.
 */
function legacyPipelineField(field: string): string {
  if (field === 'pipelineId') return 'id';
  if (field === 'phaseIds') return 'phases';
  if (field.startsWith('phaseIds[')) return `phases${field.slice('phaseIds'.length)}`;
  return field;
}

export function validatePipelineRaw(
  value: unknown,
  knownPhaseIds: ReadonlySet<string>
): readonly ValidationError[] {
  const result = validatePipelineDefinition(value, { allowLegacyId: true, defaultVersion: 1 });
  const id = result.pipelineId === '?' ? undefined : result.pipelineId;
  const errors: ValidationError[] = result.errors.map((error) => ({
    source: 'pipeline' as const,
    id,
    field: legacyPipelineField(error.field),
    message: error.message
  }));

  // Cross-reference against the resolved phase catalog stays here: the portable
  // validator is shape-only and has no view of which phase ids actually exist.
  const phaseIds = result.definition?.phaseIds ?? [];
  for (let i = 0; i < phaseIds.length; i++) {
    const ref = phaseIds[i] as string;
    if (!knownPhaseIds.has(ref)) {
      errors.push({
        source: 'pipeline',
        id,
        field: `phases[${i}]`,
        message: `Pipeline.phases[${i}] references unknown phase id '${ref}'`
      });
    }
  }

  return errors;
}

export function validateCatalog(catalog: {
  phases: readonly PhaseDef[];
  pipelines: readonly PipelineDef[];
  defaultPipelineId: string;
}): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  for (const p of catalog.phases) {
    const authored = Object.fromEntries(
      Object.entries(p).filter(([key]) => ALLOWED_PHASE_FIELDS.has(key))
    );
    errors.push(...validatePhaseRaw(authored));
  }

  const knownPhaseIds = new Set(catalog.phases.map((p) => p.id));
  for (const pl of catalog.pipelines) {
    const authored = Object.fromEntries(
      Object.entries(pl).filter(([key]) => ALLOWED_PIPELINE_FIELDS.has(key))
    );
    errors.push(...validatePipelineRaw(authored, knownPhaseIds));
  }

  if (
    catalog.defaultPipelineId &&
    !catalog.pipelines.some((p) => p.id === catalog.defaultPipelineId)
  ) {
    warnings.push({
      source: 'pipeline',
      id: catalog.defaultPipelineId,
      // Feature 098 (T081) — this used to promise a fallback to the built-in
      // Pipeline. There is none: an unresolvable default is refused at launch
      // by name (FR-023), so the warning reports the fact and stops there.
      message: `defaultPipelineId '${catalog.defaultPipelineId}' references unknown pipeline`
    });
  }

  if (catalog.phases.length > SOFT_CAP_PHASES) {
    warnings.push({
      source: 'limit',
      message: `Catalog has ${catalog.phases.length} phases; soft cap is ${SOFT_CAP_PHASES}`
    });
  }
  if (catalog.pipelines.length > SOFT_CAP_PIPELINES) {
    warnings.push({
      source: 'limit',
      message: `Catalog has ${catalog.pipelines.length} pipelines; soft cap is ${SOFT_CAP_PIPELINES}`
    });
  }
  for (const pl of catalog.pipelines) {
    if (pl.phases.length > SOFT_CAP_PIPELINE_PHASES) {
      warnings.push({
        source: 'limit',
        id: pl.id,
        message: `Pipeline '${pl.id}' has ${pl.phases.length} phases; soft cap is ${SOFT_CAP_PIPELINE_PHASES}`
      });
    }
  }

  return { errors, warnings };
}
