export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
import { SUPPORTED_BACKENDS, isBackendRunnerKind, type BackendRunnerKind } from '../runner/backend-runner-factory';
import type { PhaseDefinitionScope } from '../contracts/process-definitions';
// One declaration serves the authored contract and the runtime shape. These were
// duplicated string unions here; a Phase now declares its own containment class,
// so a second copy would let the document field and the runtime field drift with
// nothing to catch it. Re-exported because `PhaseSideEffects` /
// `PhaseEvidencePolicy` are part of this module's published surface.
export {
  PHASE_SIDE_EFFECTS,
  PHASE_EVIDENCE_POLICIES,
  type PhaseSideEffects,
  type PhaseEvidencePolicy
} from '../contracts/process-definitions';
import type { PhaseSideEffects, PhaseEvidencePolicy } from '../contracts/process-definitions';
import {
  isPipelineDefinitionScope,
  type PhaseBinding,
  type PipelineDefinitionScope,
  type PipelineExecutionDefaults,
  type PipelineInputPort,
  type PipelineOutputPort
} from '../contracts/pipeline-definitions';
import { mergePhaseRunnerPolicy } from './pipeline-snapshot';
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
  readonly promptVersion?: string;
  /** Resolution origin used only to derive host-owned runtime policy. */
  readonly sourceScope?: PhaseDefinitionScope;
}
// Feature 082 — the runtime Pipeline shape. `id`, `name`, and `phases` are the
// legacy required trio; every contract field added by the Pipeline Builder is
// optional and normalizes on parse so an existing `schegent.pipelines` row keeps
// resolving without a configuration rewrite (research R2).
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
  readonly sourceScope?: PipelineDefinitionScope;
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
// Feature 098 (T036, FR-010, FR-011) — the built-in layer, emptied.
//
// It held seventeen Phases and three Pipelines, and `import-planner.ts` scans
// every layer including this one before writing, so the two example documents
// that ship in the VSIX resolved to sixteen skip rows and zero writes: the
// import UI was the only route in and it wrote nothing. The rows moved to
// `examples/`, where an operator imports them; the layer stays because
// three-scope precedence, the `shadowed` status and the presence scan are all
// still the machinery this product resolves with (FR-017, and the retention
// test `tests/unit/config/built-in-scope-retention.test.ts`).
//
// `BUILT_IN_WORKFLOWS` has been `Object.freeze([])` since feature 086, which is
// the existence proof that the seventeen `{ builtIn, user, workspace }` call
// sites need no change to accept an empty first layer.
export const BUILT_IN_PHASES: readonly PhaseDef[] = Object.freeze([]);

// The Pipeline half of the same change (T036). Two of the three definitions this
// array held are now `examples/speckit-new-feature.pipeline.yaml` and
// `examples/speckit-bugfix.pipeline.yaml`. The third, `dev-new-feature`, has no
// document successor: the shipped example set is good as it stands (standing
// decision, 2026-08-19), so an operator who wants that Pipeline authors it like
// any other. Nothing here is load-bearing for it — a Pipeline with no document
// is simply one nobody has imported.
//
// Feature 098 (T081) — four id constants stood here until this point:
// `BUILT_IN_PIPELINE_ID`, `BUILT_IN_BUGFIX_PIPELINE_ID`,
// `BUILT_IN_DEV_NEW_FEATURE_PIPELINE_ID` and `DEFAULT_PIPELINE_ID`. T036 left
// them deliberately, because thirteen expressions still substituted them for an
// absent Pipeline id and deleting them alongside the rows would have ended that
// phase on a tree that did not compile. Those consumers are gone, so the names
// go too: a constant naming a definition no installation has is a standing
// invitation to substitute it again.
export const BUILT_IN_PIPELINES: readonly PipelineDef[] = Object.freeze([]);

// Feature 059 — default-detection helpers used by the per-capability
// trust gate in `cmd-save-phases.ts` and `cmd-save-pipelines.ts`. The
// I-2 invariant of the save-command contract requires that saving the
// built-in payload bypasses the gate unconditionally so an operator can
// always reset-to-defaults from a denied state.
//
// `stableJsonStringify` produces a key-sorted, deterministic JSON
// rendering so byte equality is independent of object-property order
// from the wire (the webview emits properties in declaration order, but
// that order is a JS-engine implementation detail). Stable across runs.
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJsonStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableJsonStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * `true` iff `payload` is byte-equivalent (after key-sorted JSON
 * normalization) to the built-in Phase layer — which, since T036, means
 * `payload` is empty. The trust gate reads this to recognize a
 * reset-to-defaults save, so an operator can always return to defaults from
 * a denied state (feature 059's I-2 invariant).
 *
 * Feature 098 (T037) kept the comparison in this form rather than reducing it
 * to `payload.length === 0`. The two are equivalent for an array, and this is
 * the form `equalsBuiltInWorkflows()` has used since feature 086 against its
 * own empty layer: the three functions are one family, read together by the
 * three save commands, and a fourteen-line saving is not worth two of them
 * answering the question differently from the third.
 */
export function equalsBuiltInPhases(payload: readonly unknown[]): boolean {
  return stableJsonStringify(payload) === stableJsonStringify(BUILT_IN_PHASES);
}

/** The Pipeline half of {@link equalsBuiltInPhases}, on the same terms. */
export function equalsBuiltInPipelines(payload: readonly unknown[]): boolean {
  return stableJsonStringify(payload) === stableJsonStringify(BUILT_IN_PIPELINES);
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
 * `phaseId` is dropped, the YAML spelling of `id` that a `schegent.phases` row
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
    (v.runner === undefined || isBackendRunnerKind(v.runner)) &&
    (v.sourceScope === undefined ||
      v.sourceScope === 'built-in' ||
      v.sourceScope === 'user' ||
      v.sourceScope === 'workspace')
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
        v.recommendedNext.every((r) => typeof r === 'string'))) &&
    (v.sourceScope === undefined || isPipelineDefinitionScope(v.sourceScope))
  );
}

interface MergeInput {
  readonly phases?: readonly PhaseDef[];
  readonly pipelines?: readonly PipelineDef[];
  readonly models?: Record<BackendRunnerKind, readonly string[]> | readonly string[]; // support migration from array
  readonly defaultPipelineId?: string;
}

export function mergeCatalog(
  builtin: MergeInput,
  user: MergeInput,
  workspace: MergeInput
): {
  catalog: {
    phases: readonly PhaseDef[];
    pipelines: readonly PipelineDef[];
    models: Record<BackendRunnerKind, readonly string[]>;
    defaultPipelineId: string;
  };
  duplicateWarnings: readonly ValidationWarning[];
} {
  const duplicateWarnings: ValidationWarning[] = [];
  const phasesMap = new Map<string, PhaseDef>();
  const pipelinesMap = new Map<string, PipelineDef>();
  const modelsMap = new Map<BackendRunnerKind, Set<string>>();

  const phaseLayers: ReadonlyArray<{ name: string; input: MergeInput }> = [
    { name: 'builtin', input: builtin },
    { name: 'user', input: user },
    { name: 'workspace', input: workspace }
  ];

  for (const { name, input } of phaseLayers) {
    const layerPhaseIds = new Set<string>();
    for (const p of input.phases ?? []) {
      if (layerPhaseIds.has(p.id) && name !== 'builtin') {
        duplicateWarnings.push({
          source: 'phase',
          id: p.id,
          message: `Duplicate phase id '${p.id}' in ${name} settings; last-defined wins`
        });
      }
      layerPhaseIds.add(p.id);
      phasesMap.set(p.id, mergePhaseRunnerPolicy(phasesMap.get(p.id), p));
    }
  }

  // Feature 081 changes Phase precedence only. Pipeline and model merge order
  // remains the established built-in -> workspace -> user behavior.
  const catalogLayers: ReadonlyArray<{ name: string; input: MergeInput }> = [
    { name: 'builtin', input: builtin },
    { name: 'workspace', input: workspace },
    { name: 'user', input: user }
  ];

  for (const { name, input } of catalogLayers) {
    const layerPipelineIds = new Set<string>();
    for (const pl of input.pipelines ?? []) {
      if (layerPipelineIds.has(pl.id) && name !== 'builtin') {
        duplicateWarnings.push({
          source: 'pipeline',
          id: pl.id,
          message: `Duplicate pipeline id '${pl.id}' in ${name} settings; last-defined wins`
        });
      }
      layerPipelineIds.add(pl.id);
      pipelinesMap.set(pl.id, pl);
    }

    if (input.models) {
      if (Array.isArray(input.models)) {
        let set = modelsMap.get('claude');
        if (!set) {
          set = new Set<string>();
          modelsMap.set('claude', set);
        }
        for (const m of input.models) set.add(m);
      } else {
        for (const kind of SUPPORTED_BACKENDS) {
          const arr = (input.models as Record<BackendRunnerKind, readonly string[]>)[kind];
          if (arr) {
            let set = modelsMap.get(kind);
            if (!set) {
              set = new Set<string>();
              modelsMap.set(kind, set);
            }
            for (const m of arr) set.add(m);
          }
        }
      }
    }
  }

  // Feature 098 (T081, FR-033) — the final fallback named the built-in
  // Pipeline. With no layer supplying one, the merged catalog has no default,
  // and the empty string is how that is spelled (FR-033a).
  const defaultPipelineId =
    workspace.defaultPipelineId ?? user.defaultPipelineId ?? builtin.defaultPipelineId ?? '';

  const mergedModels: Record<BackendRunnerKind, readonly string[]> = {
    claude: Object.freeze(Array.from(modelsMap.get('claude') ?? [])),
    codex: Object.freeze(Array.from(modelsMap.get('codex') ?? [])),
    agy: Object.freeze(Array.from(modelsMap.get('agy') ?? []))
  };

  return {
    catalog: {
      phases: Array.from(phasesMap.values()),
      pipelines: Array.from(pipelinesMap.values()),
      models: mergedModels,
      defaultPipelineId
    },
    duplicateWarnings
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
