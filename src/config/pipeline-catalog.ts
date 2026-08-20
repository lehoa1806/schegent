import type {
  PipelineCatalogResolution,
  PipelineCatalogWarning,
  PipelineDefinition,
  PipelineFieldError,
  PipelineSourceRecord,
  PipelineSourceStatus
} from '../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../contracts/process-definitions';
import type { PipelineDef } from './pipeline-config';
import { validatePipelineBindings } from './pipeline-binding-validator';
import { validatePipelineDefinition } from './pipeline-definition-validator';

/** Advisory ceiling on effective Pipelines; exceeding it warns and never blocks (FR-033). */
export const PIPELINE_CATALOG_SOFT_CAP = 20;
/** Advisory ceiling on one Pipeline's Phase sequence (FR-033). */
export const PIPELINE_PHASE_SOFT_CAP = 50;

const SYNTHETIC_PIPELINE_ID_PREFIX = '?invalid-';
const PIPELINE_ID_MAX_LEN = 64;
const MODEL_ID_MAX_LEN = 64;

/**
 * The stable per-row identity. A row that cannot supply one keeps its slot under
 * a synthetic id so it stays visible for repair without ever resolving (FR-002).
 */
export function pipelineSourceIdentity(row: unknown, index: number): string {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const value = row as Record<string, unknown>;
    const rawId =
      typeof value.pipelineId === 'string'
        ? value.pipelineId
        : typeof value.id === 'string'
          ? value.id
          : null;
    const pipelineId = rawId?.trim();
    if (pipelineId) return pipelineId;
  }
  return `${SYNTHETIC_PIPELINE_ID_PREFIX}${index + 1}`;
}

interface MutableSourceRecord {
  readonly key: string;
  readonly pipelineId: string;
  status: PipelineSourceStatus;
  definition: PipelineDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  errors: PipelineFieldError[];
}

export interface ResolvedPipelineCatalog extends PipelineCatalogResolution {
  readonly effectivePipelineDefs: readonly PipelineDef[];
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Every `phaseIds` entry must name a Phase that resolves in the effective Phase
 * catalog (FR-011). Reported per position because the sequence is positional and
 * ids may legitimately repeat.
 *
 * Exported so gate 5 of the save handler and this resolver share one
 * implementation — a fork would let a Pipeline pass the save gate and then
 * resolve as invalid on reload.
 */
export function unknownPhaseErrors(
  definition: PipelineDefinition,
  knownPhaseIds: ReadonlySet<string>
): PipelineFieldError[] {
  const errors: PipelineFieldError[] = [];
  definition.phaseIds.forEach((phaseId, index) => {
    if (knownPhaseIds.has(phaseId)) return;
    errors.push(
      Object.freeze({
        pipelineId: definition.pipelineId,
        field: `phaseIds[${index}]`,
        code: 'unknown-phase',
        message: `Phase '${bounded(phaseId, PIPELINE_ID_MAX_LEN)}' at position ${index} has no effective definition`
      })
    );
  });
  return errors;
}

/**
 * Parse the stored rows into source records.
 *
 * Feature 099 (T489, FR-042) — formerly `parseLayer`, called three times. See
 * `parseRows` in `process-catalog.ts` for why `key` drops its scope segment and
 * why a clean row now starts `effective` rather than `shadowed`.
 */
function parseRows(
  rows: readonly unknown[],
  defaultVersion: number,
  effectivePhases: readonly PhaseDefinition[],
  knownPhaseIds: ReadonlySet<string>
): MutableSourceRecord[] {
  return rows.map((row, index) => {
    const result = validatePipelineDefinition(row, { allowLegacyId: true, defaultVersion });
    const pipelineId = pipelineSourceIdentity(row, index);
    const errors = [...result.errors];
    let definition = result.definition;
    if (definition !== null) {
      errors.push(...unknownPhaseErrors(definition, knownPhaseIds));
      errors.push(...validatePipelineBindings(definition, effectivePhases));
      if (errors.length > 0) definition = null;
    }
    return {
      key: `${pipelineId}::${index}`,
      pipelineId,
      status: errors.length === 0 ? 'effective' : 'invalid',
      definition,
      display: result.display,
      errors
    };
  });
}

function duplicateError(pipelineId: string): PipelineFieldError {
  return Object.freeze({
    pipelineId,
    field: 'pipelineId',
    code: 'duplicate-in-scope',
    message: `Pipeline id '${bounded(pipelineId, PIPELINE_ID_MAX_LEN)}' appears more than once in the catalog`
  });
}

function invalidateDuplicates(records: MutableSourceRecord[]): void {
  const byId = new Map<string, MutableSourceRecord[]>();
  for (const record of records) {
    if (record.pipelineId.startsWith(SYNTHETIC_PIPELINE_ID_PREFIX)) continue;
    const matches = byId.get(record.pipelineId) ?? [];
    matches.push(record);
    byId.set(record.pipelineId, matches);
  }
  for (const [pipelineId, matches] of byId) {
    if (matches.length < 2) continue;
    for (const match of matches) {
      match.status = 'invalid';
      match.definition = null;
      match.errors.push(duplicateError(pipelineId));
    }
  }
}

/**
 * Projects a resolved Pipeline onto the runtime `PipelineDef` shape consumed by
 * Run creation.
 *
 * Feature 099 (T489, FR-039) — the `scope` parameter is gone with the layer tier,
 * and with it the `sourceScope` field it stamped. `snapshotPipelineContract`
 * already dropped that field on the way into a Run, so nothing persisted carries
 * it and no `STATE_SCHEMA_VERSION` bump follows.
 */
export function pipelineDefinitionToPipelineDef(definition: PipelineDefinition): PipelineDef {
  return Object.freeze({
    id: definition.pipelineId,
    name: definition.name,
    version: definition.version,
    phases: Object.freeze([...definition.phaseIds]),
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    inputs: Object.freeze([...definition.inputs]),
    outputs: Object.freeze([...definition.outputs]),
    bindings: Object.freeze([...definition.bindings]),
    ...(definition.executionDefaults !== undefined
      ? { executionDefaults: definition.executionDefaults }
      : {}),
    recommendedNext: Object.freeze([...definition.recommendedNext])
  });
}

function softCapWarnings(effective: readonly PipelineDefinition[]): PipelineCatalogWarning[] {
  const warnings: PipelineCatalogWarning[] = [];
  if (effective.length > PIPELINE_CATALOG_SOFT_CAP) {
    warnings.push(
      Object.freeze({
        code: 'pipeline-soft-cap',
        message: `Catalog has ${effective.length} effective Pipelines; advisory limit is ${PIPELINE_CATALOG_SOFT_CAP}`
      })
    );
  }
  for (const pipeline of effective) {
    if (pipeline.phaseIds.length <= PIPELINE_PHASE_SOFT_CAP) continue;
    warnings.push(
      Object.freeze({
        code: 'pipeline-phase-soft-cap',
        message: `Pipeline '${bounded(pipeline.pipelineId, PIPELINE_ID_MAX_LEN)}' has ${pipeline.phaseIds.length} Phases; advisory limit is ${PIPELINE_PHASE_SOFT_CAP}`
      })
    );
  }
  return warnings;
}

/**
 * `recommendedNext` is a soft reference: an id with no effective definition is
 * surfaced as advice-quality drift, never as a validation error (FR-019a).
 */
function recommendedNextWarnings(
  effective: readonly PipelineDefinition[]
): PipelineCatalogWarning[] {
  const known = new Set(effective.map((pipeline) => pipeline.pipelineId));
  const unresolved = new Set<string>();
  for (const pipeline of effective) {
    for (const next of pipeline.recommendedNext) {
      if (!known.has(next)) unresolved.add(bounded(next, PIPELINE_ID_MAX_LEN));
    }
  }
  if (unresolved.size === 0) return [];
  return [
    Object.freeze({
      code: 'pipeline-recommended-next-unresolved',
      message: `Recommended follow-up Pipelines have no effective definition: ${[...unresolved].join(', ')}`
    })
  ];
}

/**
 * FR-035 — an execution default naming a model the catalog does not offer is
 * advice, never an error: the identifier stays stored and visible so switching
 * back to a backend that has it restores the operator's choice instead of
 * finding it silently rewritten.
 *
 * An absent or empty list means availability is unknown, not that everything is
 * unavailable — a host that has not enumerated any model yet must not brand
 * every execution default as broken.
 */
function unavailableModelWarnings(
  effective: readonly PipelineDefinition[],
  availableModels: Readonly<Record<string, readonly string[]>> | undefined,
  defaultRunnerKind: string | undefined
): PipelineCatalogWarning[] {
  if (availableModels === undefined) return [];
  const warnings: PipelineCatalogWarning[] = [];
  for (const pipeline of effective) {
    const model = pipeline.executionDefaults?.model;
    if (model === undefined) continue;
    const runner = pipeline.executionDefaults?.runner ?? defaultRunnerKind;
    if (runner === undefined) continue;
    const offered = availableModels[runner];
    if (offered === undefined || offered.length === 0 || offered.includes(model)) continue;
    warnings.push(
      Object.freeze({
        code: 'pipeline-model-unavailable',
        message: `Pipeline '${bounded(pipeline.pipelineId, PIPELINE_ID_MAX_LEN)}' requests model '${bounded(model, MODEL_ID_MAX_LEN)}', which runner '${bounded(runner, PIPELINE_ID_MAX_LEN)}' does not currently offer; the stored value is kept`
      })
    );
  }
  return warnings;
}

/**
 * Resolve the one Pipeline layer.
 *
 * Feature 099 (T489, FR-042) — `rows` is the stored catalog and `revision` is the
 * store's manifest revision (FR-044a). See `resolvePhaseCatalog` for the shape of
 * the collapse.
 *
 * **Feature 100 (FR-R3-016) T505 — the effective catalog is the set of ACTIVE
 * versions** (FR-007), and this resolver is unchanged for it. `rows` comes from
 * `storedRows`, which reads a definition's active body and never its draft, so a
 * Pipeline saved as a draft is absent from `effective` and from `records` alike —
 * it cannot be launched, and it cannot satisfy another definition's reference,
 * until it is published (FR-008). The `phaseCatalog` this validates bindings
 * against is that same active-only set one level down, so a draft Phase cannot
 * make a Pipeline resolve either.
 */
export function resolvePipelineCatalog(input: {
  readonly rows: readonly unknown[] | undefined;
  readonly revision: string;
  readonly phaseCatalog: readonly PhaseDefinition[];
  /**
   * Model ids the host currently offers per runner, for the FR-035 advisory.
   *
   * Availability is a live backend fact, not a configuration one, so it is
   * injected rather than read here. `loadCatalog` deliberately passes nothing:
   * it resolves once per configuration change, while availability moves as
   * backends are probed, so a list captured there would go stale and warn
   * falsely. The operator-facing live cue is the per-record `modelAvailable`
   * flag, recomputed every snapshot in `pipeline-catalog-projection.ts` from
   * the capability service. Omitting the list disables the advisory entirely.
   */
  readonly availableModels?: Readonly<Record<string, readonly string[]>>;
  /** Runner assumed for an execution default that names a model but no runner. */
  readonly defaultRunnerKind?: string;
}): ResolvedPipelineCatalog {
  const knownPhaseIds = new Set(input.phaseCatalog.map((phase) => phase.phaseId));
  const records = parseRows(input.rows ?? [], 1, input.phaseCatalog, knownPhaseIds);
  invalidateDuplicates(records);

  const effective: PipelineDefinition[] = [];
  const effectivePipelineDefs: PipelineDef[] = [];
  for (const record of records) {
    if (record.pipelineId.startsWith(SYNTHETIC_PIPELINE_ID_PREFIX)) continue;
    if (record.status !== 'effective' || record.definition === null) continue;
    effective.push(record.definition);
    effectivePipelineDefs.push(pipelineDefinitionToPipelineDef(record.definition));
  }

  const frozenRecords: PipelineSourceRecord[] = records.map((record) =>
    Object.freeze({
      key: record.key,
      pipelineId: record.pipelineId,
      status: record.status,
      definition: record.definition,
      display: record.display,
      errors: Object.freeze([...record.errors])
    })
  );

  const warnings: PipelineCatalogWarning[] = [
    ...softCapWarnings(effective),
    ...recommendedNextWarnings(effective),
    ...unavailableModelWarnings(effective, input.availableModels, input.defaultRunnerKind)
  ];
  const invalidCount = frozenRecords.filter((record) => record.status === 'invalid').length;
  if (invalidCount > 0) {
    warnings.push(
      Object.freeze({
        code: 'invalid-source-rows',
        message: `${invalidCount} Pipeline source row${invalidCount === 1 ? '' : 's'} require repair`
      })
    );
  }

  return Object.freeze({
    records: Object.freeze(frozenRecords),
    effective: Object.freeze(effective),
    effectivePipelineDefs: Object.freeze(effectivePipelineDefs),
    revision: input.revision,
    warnings: Object.freeze(warnings)
  });
}
