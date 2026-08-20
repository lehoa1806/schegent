import type {
  PhaseCatalogResolution,
  PhaseDefinition,
  PhaseFieldError,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../contracts/process-definitions';
import type { PhaseDef } from './pipeline-config';
import { validatePhaseDefinition } from './process-definition-validator';
import { phaseRunnerPolicyError } from './phase-runner-policy';

export const PHASE_CATALOG_SOFT_CAP = 50;
const SYNTHETIC_PHASE_ID_PREFIX = '?invalid-';

export function phaseSourceIdentity(row: unknown, index: number): string {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const value = row as Record<string, unknown>;
    const rawId = typeof value.phaseId === 'string'
      ? value.phaseId
      : typeof value.id === 'string' ? value.id : null;
    const phaseId = rawId?.trim();
    if (phaseId) return phaseId;
  }
  return `${SYNTHETIC_PHASE_ID_PREFIX}${index + 1}`;
}

interface MutableSourceRecord {
  readonly key: string;
  readonly phaseId: string;
  status: PhaseSourceStatus;
  definition: PhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  errors: PhaseFieldError[];
}

export interface ResolvedPhaseCatalog extends PhaseCatalogResolution {
  readonly effectivePhaseDefs: readonly PhaseDef[];
}

/**
 * Parse the stored rows into source records.
 *
 * Feature 099 (T489, FR-042) — formerly `parseLayer(scope, rows, defaultVersion)`,
 * called three times and merged. Two things changed with the collapse:
 *
 *   - `key` no longer embeds a scope. `<phaseId>::<index>` is unique within the
 *     one layer, which is all a key has ever had to be — it addresses a row for
 *     the Library's repair affordance, not a layer.
 *   - a clean row starts `effective`, not `shadowed`. `shadowed` was the initial
 *     state precisely because a row was hidden until precedence selected it, and
 *     with one layer a clean row is selected by existing (FR-040).
 */
function parseRows(rows: readonly unknown[], defaultVersion: number): MutableSourceRecord[] {
  return rows.map((row, index) => {
    const result = validatePhaseDefinition(row, { allowLegacyId: true, defaultVersion });
    const phaseId = phaseSourceIdentity(row, index);
    const errors = [...result.errors];
    let definition = result.definition;
    if (definition?.runner !== undefined) {
      const runnerPolicyError = phaseRunnerPolicyError(
        definition.phaseId,
        definition.sideEffects,
        definition.runner
      );
      if (runnerPolicyError !== null) {
        errors.push({
          phaseId: definition.phaseId, field: 'runner',
          code: 'git-metadata-write-required', message: runnerPolicyError
        });
        definition = null;
      }
    }
    return {
      key: `${phaseId}::${index}`,
      phaseId,
      status: errors.length === 0 ? 'effective' : 'invalid',
      definition,
      display: result.display,
      errors
    };
  });
}

function duplicateError(phaseId: string): PhaseFieldError {
  return Object.freeze({
    phaseId,
    field: 'phaseId',
    code: 'duplicate-in-scope',
    message: `Phase id '${phaseId}' appears more than once in the catalog`
  });
}

function invalidateDuplicates(records: MutableSourceRecord[]): void {
  const byId = new Map<string, MutableSourceRecord[]>();
  for (const record of records) {
    if (record.phaseId.startsWith(SYNTHETIC_PHASE_ID_PREFIX)) continue;
    const matches = byId.get(record.phaseId) ?? [];
    matches.push(record);
    byId.set(record.phaseId, matches);
  }
  for (const [phaseId, matches] of byId) {
    if (matches.length < 2) continue;
    for (const match of matches) {
      match.status = 'invalid';
      match.definition = null;
      match.errors.push(duplicateError(phaseId));
    }
  }
}

/**
 * Project a resolved definition onto the runtime `PhaseDef` shape.
 *
 * Feature 099 (T489, FR-039) — the `scope` parameter and the `builtInById` map
 * are gone with the layer tier. They existed to graft a built-in row's
 * `promptVersion` and pinned `runner`/`sideEffects` onto a definition resolved at
 * `built-in` scope; the built-in layer has held no rows since feature 098, so
 * that graft has had nothing to read from for a release, and `sourceScope` is no
 * longer a field a `PhaseDef` carries.
 *
 * Absence stays absence. The FR-005 containment default belongs to
 * `snapshotPhaseDef`, and resolving it here would make an omission
 * indistinguishable from a declaration one layer earlier than intended.
 */
export function phaseDefinitionToPhaseDef(definition: PhaseDefinition): PhaseDef {
  return Object.freeze({
    id: definition.phaseId,
    name: definition.name,
    version: definition.version,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    ...(definition.instruction !== undefined ? { instruction: definition.instruction } : {}),
    ...(definition.skill !== undefined ? { skill: definition.skill } : {}),
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.timeoutSeconds !== undefined
      ? { timeoutSeconds: definition.timeoutSeconds }
      : {}),
    ...(definition.loopable !== undefined ? { loopable: definition.loopable } : {}),
    ...(definition.retryCondition !== undefined
      ? { retryCondition: definition.retryCondition }
      : {}),
    ...(definition.isRequired !== undefined ? { isRequired: definition.isRequired } : {}),
    ...(definition.forceContinueOnRetryCap !== undefined
      ? { forceContinueOnRetryCap: definition.forceContinueOnRetryCap }
      : {}),
    ...(definition.runner !== undefined ? { runner: definition.runner } : {}),
    ...(definition.sideEffects !== undefined ? { sideEffects: definition.sideEffects } : {}),
    ...(definition.evidencePolicy !== undefined
      ? { evidencePolicy: definition.evidencePolicy }
      : {})
  });
}

/**
 * Resolve the one Phase layer.
 *
 * Feature 099 (T489, FR-042) — formerly `{ builtIn, user, workspace }` parsed
 * into three record sets, merged, and walked in `['workspace', 'user',
 * 'built-in']` precedence order to select a winner per id. `rows` is the stored
 * catalog and `revision` is the store's manifest revision (FR-044a); selection is
 * "the row parsed cleanly and its id is not duplicated", which
 * `invalidateDuplicates` has already decided by the time the loop runs.
 *
 * **Feature 100 (FR-R3-016) T505 — the effective catalog is the set of ACTIVE
 * versions** (FR-007). This resolver is not rebuilt to say so, and that is the
 * point: `effective` has always been "the rows that resolved", and the rows are
 * whatever `storedRows` hands over. FR-006 gives a definition a second body — the
 * Draft — and `storedRows` reads only the active one, so a draft-only definition
 * arrives here as no row at all and cannot reach `effective` by any path. A draft
 * therefore changes nothing about what runs until it is published (FR-008,
 * FR-009); publication is the only event that moves a body into this function's
 * input. `tests/unit/config/effective-is-active-only.test.ts` pins it.
 */
export function resolvePhaseCatalog(input: {
  readonly rows: readonly unknown[] | undefined;
  readonly revision: string;
}): ResolvedPhaseCatalog {
  const records = parseRows(input.rows ?? [], 1);
  invalidateDuplicates(records);

  const effective: PhaseDefinition[] = [];
  const effectivePhaseDefs: PhaseDef[] = [];
  for (const record of records) {
    if (record.phaseId.startsWith(SYNTHETIC_PHASE_ID_PREFIX)) continue;
    if (record.status !== 'effective' || record.definition === null) continue;
    effective.push(record.definition);
    effectivePhaseDefs.push(phaseDefinitionToPhaseDef(record.definition));
  }

  const frozenRecords: PhaseSourceRecord[] = records.map((record) =>
    Object.freeze({
      key: record.key,
      phaseId: record.phaseId,
      status: record.status,
      definition: record.definition,
      display: record.display,
      errors: Object.freeze([...record.errors])
    })
  );
  const warnings = [];
  if (effective.length > PHASE_CATALOG_SOFT_CAP) {
    warnings.push(
      Object.freeze({
        code: 'phase-soft-cap',
        message: `Catalog has ${effective.length} effective Phases; advisory limit is ${PHASE_CATALOG_SOFT_CAP}`
      })
    );
  }
  const invalidCount = frozenRecords.filter((record) => record.status === 'invalid').length;
  if (invalidCount > 0) {
    warnings.push(
      Object.freeze({
        code: 'invalid-source-rows',
        message: `${invalidCount} Phase source row${invalidCount === 1 ? '' : 's'} require repair`
      })
    );
  }

  return Object.freeze({
    records: Object.freeze(frozenRecords),
    effective: Object.freeze(effective),
    effectivePhaseDefs: Object.freeze(effectivePhaseDefs),
    revision: input.revision,
    warnings: Object.freeze(warnings)
  });
}
