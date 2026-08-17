import { createHash } from 'node:crypto';
import type {
  PhaseCatalogResolution,
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseFieldError,
  PhaseSourceRecord,
  PhaseSourceStatus,
  WritablePhaseDefinitionScope
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
  readonly scope: PhaseDefinitionScope;
  status: PhaseSourceStatus;
  definition: PhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  errors: PhaseFieldError[];
}

export interface ResolvedPhaseCatalog extends PhaseCatalogResolution {
  readonly effectivePhaseDefs: readonly PhaseDef[];
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(',')}}`;
}

export function phaseLayerRevision(raw: readonly unknown[] | undefined): string {
  return createHash('sha256')
    .update(stableJsonStringify(raw ?? []), 'utf8')
    .digest('hex');
}

function authoredBuiltInRow(phase: PhaseDef): Record<string, unknown> {
  return {
    id: phase.id,
    name: phase.name,
    version: phase.version ?? 1,
    ...(phase.description !== undefined ? { description: phase.description } : {}),
    ...(phase.instruction !== undefined ? { instruction: phase.instruction } : {}),
    ...(phase.skill !== undefined ? { skill: phase.skill } : {}),
    ...(phase.model !== undefined ? { model: phase.model } : {}),
    ...(phase.effort !== undefined ? { effort: phase.effort } : {}),
    ...(phase.timeoutSeconds !== undefined ? { timeoutSeconds: phase.timeoutSeconds } : {}),
    ...(phase.loopable !== undefined ? { loopable: phase.loopable } : {}),
    ...(phase.retryCondition !== undefined ? { retryCondition: phase.retryCondition } : {}),
    ...(phase.isRequired !== undefined ? { isRequired: phase.isRequired } : {}),
    ...(phase.forceContinueOnRetryCap !== undefined
      ? { forceContinueOnRetryCap: phase.forceContinueOnRetryCap }
      : {}),
    ...(phase.runner !== undefined ? { runner: phase.runner } : {})
  };
}

function parseLayer(
  scope: PhaseDefinitionScope,
  rows: readonly unknown[],
  defaultVersion: number
): MutableSourceRecord[] {
  return rows.map((row, index) => {
    const result = validatePhaseDefinition(row, { allowLegacyId: true, defaultVersion });
    const phaseId = phaseSourceIdentity(row, index);
    const errors = [...result.errors];
    let definition = result.definition;
    if (definition?.runner !== undefined) {
      const runnerPolicyError = phaseRunnerPolicyError(definition.phaseId, definition.runner);
      if (runnerPolicyError !== null) {
        errors.push({
          phaseId: definition.phaseId, field: 'runner',
          code: 'git-metadata-write-required', message: runnerPolicyError
        });
        definition = null;
      }
    }
    return {
      key: `${scope}::${phaseId}::${index}`,
      phaseId,
      scope,
      status: errors.length === 0 ? 'shadowed' : 'invalid',
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
    message: `Phase id '${phaseId}' appears more than once in this scope`
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

export function phaseDefinitionToPhaseDef(
  definition: PhaseDefinition,
  scope: PhaseDefinitionScope,
  builtInById: ReadonlyMap<string, PhaseDef>
): PhaseDef {
  const builtIn = scope === 'built-in' ? builtInById.get(definition.phaseId) : undefined;
  const pinnedRunner = definition.runner ?? builtIn?.runner;
  return Object.freeze({
    id: definition.phaseId,
    name: definition.name,
    version: definition.version,
    sourceScope: scope,
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
    ...(pinnedRunner !== undefined ? { runner: pinnedRunner } : {}),
    ...(builtIn?.sideEffects !== undefined ? { sideEffects: builtIn.sideEffects } : {}),
    ...(builtIn?.evidencePolicy !== undefined ? { evidencePolicy: builtIn.evidencePolicy } : {}),
    ...(builtIn?.promptVersion !== undefined ? { promptVersion: builtIn.promptVersion } : {})
  });
}

export function resolvePhaseCatalog(input: {
  readonly builtIn: readonly PhaseDef[];
  readonly user: readonly unknown[] | undefined;
  readonly workspace: readonly unknown[] | undefined;
}): ResolvedPhaseCatalog {
  const builtInRows = input.builtIn.map(authoredBuiltInRow);
  const builtInRecords = parseLayer('built-in', builtInRows, 1);
  const userRecords = parseLayer('user', input.user ?? [], 1);
  const workspaceRecords = parseLayer('workspace', input.workspace ?? [], 1);
  invalidateDuplicates(userRecords);
  invalidateDuplicates(workspaceRecords);

  const records = [...builtInRecords, ...userRecords, ...workspaceRecords];
  const phaseIds = new Set(records.map((record) => record.phaseId));
  const effective: PhaseDefinition[] = [];
  const effectivePhaseDefs: PhaseDef[] = [];
  const builtInById = new Map(input.builtIn.map((phase) => [phase.id, phase]));
  const scopeOrder: readonly PhaseDefinitionScope[] = ['workspace', 'user', 'built-in'];

  for (const phaseId of phaseIds) {
    if (phaseId.startsWith(SYNTHETIC_PHASE_ID_PREFIX)) continue;
    let selected: MutableSourceRecord | undefined;
    for (const scope of scopeOrder) {
      selected = records.find(
        (record) =>
          record.phaseId === phaseId &&
          record.scope === scope &&
          record.status !== 'invalid' &&
          record.definition !== null
      );
      if (selected) break;
    }
    if (!selected?.definition) continue;
    selected.status = 'effective';
    effective.push(selected.definition);
    effectivePhaseDefs.push(phaseDefinitionToPhaseDef(selected.definition, selected.scope, builtInById));
  }

  const frozenRecords: PhaseSourceRecord[] = records.map((record) =>
    Object.freeze({
      key: record.key,
      phaseId: record.phaseId,
      scope: record.scope,
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

  const revisions: Record<WritablePhaseDefinitionScope, string> = {
    user: phaseLayerRevision(input.user),
    workspace: phaseLayerRevision(input.workspace)
  };
  return Object.freeze({
    records: Object.freeze(frozenRecords),
    effective: Object.freeze(effective),
    effectivePhaseDefs: Object.freeze(effectivePhaseDefs),
    revisions: Object.freeze(revisions),
    warnings: Object.freeze(warnings)
  });
}
