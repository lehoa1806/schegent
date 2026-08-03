import {
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINES,
  defaultRetryConditionForPhaseId,
  isPipelineDef,
  validatePipelineRaw
} from '../../../config/pipeline-config';
import {
  phaseLayerRevision,
  phaseSourceIdentity,
  resolvePhaseCatalog
} from '../../../config/process-catalog';
import { validatePhaseDefinition } from '../../../config/process-definition-validator';
import { phaseRunnerPolicyError } from '../../../config/phase-runner-policy';
import type {
  PhaseCatalogMutation,
  PhaseDefinition,
  PhaseFieldError,
  WritablePhaseDefinitionScope
} from '../../../contracts/process-definitions';
import { isCapabilityAllowed } from '../../../state/capability-trust-resolver';
import type { SavePhasesCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';
import {
  auditImportCommitted,
  auditImportRefused,
  type ImportCommitTarget
} from './process-exchange-commit-audit';
import {
  definitionMap,
  identityRepairTarget,
  layerDiff,
  layerIdentities,
  layerShapeMatches,
  mutationMatches,
  withHostVersions,
  type LayerIntentAdapter,
  type LayerMutationIntent
} from './save-layer-intent';
import { denyAndAudit } from './trust-gate';

interface NormalizedLayer {
  readonly definitions: readonly PhaseDefinition[];
  readonly errors: readonly PhaseFieldError[];
}

/**
 * Binds the shared mutation-intent algebra to the Phase catalog: how a raw
 * settings row is identified, how a parsed definition is identified, and how a
 * row is parsed. The algebra itself lives in `save-layer-intent.ts` so the
 * Pipeline catalog reuses it unchanged (research R6).
 */
const phaseIntentAdapter: LayerIntentAdapter<PhaseDefinition> = {
  sourceIdentity: phaseSourceIdentity,
  identityOf: (definition) => definition.phaseId,
  parse: (row) =>
    validatePhaseDefinition(row, { allowLegacyId: true, defaultVersion: 1 }).definition
};

/**
 * The ids one mutation declares as its targets. Empty for `reset`; a set for
 * feature 085's `import-package`; a single id for every other kind.
 */
function declaredPhaseIds(mutation: PhaseCatalogMutation): readonly string[] {
  if (mutation.kind === 'reset') return [];
  if (mutation.kind === 'import-package') return mutation.phaseIds;
  return [mutation.phaseId];
}

/**
 * Projects a Phase mutation onto the entity-agnostic intent the algebra reads.
 *
 * `import` projects to `create` (feature 084, research R2): an import adds
 * exactly one identity and touches nothing else, which is what the algebra
 * already validates a create to be. Keeping it a create here means the diff
 * check, the positional shape check, and the identity-repair rule are the
 * shipped ones rather than a second copy that can rot.
 *
 * `import-package` (feature 085, research R5) is the one kind that does NOT
 * project onto an existing one: it appends a SET in a single write, which no
 * single-id kind describes, so the algebra carries its own branch and this
 * function passes the set through as `targetIds`.
 */
function phaseIntent(mutation: PhaseCatalogMutation): LayerMutationIntent {
  if (mutation.kind === 'import-package') {
    return { kind: 'import-package', targetId: null, targetIds: mutation.phaseIds };
  }
  const kind = mutation.kind === 'import' ? 'create' : mutation.kind;
  return { kind, targetId: mutation.kind === 'reset' ? null : mutation.phaseId };
}

/**
 * Feature 084 (FR-046a) / feature 085 (FR-044) — the rows an import introduces
 * keep the `version` their document declared, so exporting an imported Phase
 * reproduces the source document.
 *
 * Every other row in the same save, including the rest of the layer, still gets
 * its version from {@link withHostVersions}. The exemption is safe precisely
 * because the algebra has already established that these identities are absent
 * from the current layer: the invariant the version rules protect is that a save
 * cannot dictate a version *transition*, and there is no prior version here to
 * transition from.
 */
function withImportedVersion(
  versioned: readonly PhaseDefinition[],
  proposedById: ReadonlyMap<string, PhaseDefinition>,
  mutation: PhaseCatalogMutation
): readonly PhaseDefinition[] {
  if (mutation.kind !== 'import' && mutation.kind !== 'import-package') return versioned;
  const importedIds = new Set(declaredPhaseIds(mutation));
  return versioned.map((definition) => {
    if (!importedIds.has(definition.phaseId)) return definition;
    const authored = proposedById.get(definition.phaseId);
    return authored === undefined
      ? definition
      : Object.freeze({ ...definition, version: authored.version });
  });
}

function normalizeLayer(rows: readonly unknown[]): NormalizedLayer {
  const definitions: PhaseDefinition[] = [];
  const errors: PhaseFieldError[] = [];
  const ids = new Map<string, number>();
  for (const row of rows) {
    const result = validatePhaseDefinition(row, { allowLegacyId: true, defaultVersion: 1 });
    errors.push(...result.errors);
    if (result.definition) {
      definitions.push(result.definition);
      ids.set(result.definition.phaseId, (ids.get(result.definition.phaseId) ?? 0) + 1);
    }
  }
  for (const [phaseId, count] of ids) {
    if (count > 1) {
      errors.push({
        phaseId,
        field: 'phaseId',
        code: 'duplicate-in-scope',
        message: `Phase id '${phaseId}' appears more than once in this scope`
      });
    }
  }
  return { definitions, errors };
}

function persistedRow(definition: PhaseDefinition): Record<string, unknown> {
  return {
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
    ...(definition.runner !== undefined ? { runner: definition.runner } : {})
  };
}

function boundedValidationResult(
  errors: readonly PhaseFieldError[],
  sanitize: (value: string) => string
): unknown {
  return {
    errors: errors.slice(0, 20).map((error) => ({
      phaseId: sanitize(error.phaseId).slice(0, 64),
      field: sanitize(error.field).slice(0, 32),
      code: sanitize(error.code).slice(0, 64),
      message: sanitize(error.message).slice(0, 512)
    })),
    total: errors.length
  };
}

function currentMetadata(
  mutation: PhaseCatalogMutation,
  current: ReadonlyMap<string, PhaseDefinition>,
  scope: WritablePhaseDefinitionScope,
  sanitize: (value: string) => string
): unknown {
  if (mutation.kind === 'reset') return { scope, legalActions: ['refresh'] };
  // A package names a set, not a row, and `reapply` is not offered: the plan was
  // computed against the revision this gate just rejected, so its skip and
  // blocked decisions may no longer hold. The operator re-runs the preflight.
  if (mutation.kind === 'import-package') return { scope, legalActions: ['refresh'] };
  const phaseId = mutation.kind === 'duplicate' ? mutation.sourcePhaseId : mutation.phaseId;
  const definition = current.get(phaseId);
  return {
    scope,
    phaseId: sanitize(phaseId).slice(0, 64),
    ...(definition
      ? { name: sanitize(definition.name).slice(0, 80), version: definition.version }
      : {}),
    legalActions: ['refresh', 'reapply']
  };
}

function configuredPipelineIdsReferencing(
  ctx: Parameters<typeof handler>[0],
  phaseIds: ReadonlySet<string>,
  knownPhaseIds: ReadonlySet<string>
): string[] {
  const configured = ctx.deps.readPipelineConfig?.();
  let rows: readonly unknown[] = ctx.deps.getCatalog?.().pipelines ?? [];
  if (configured) {
    const effective = new Map(BUILT_IN_PIPELINES.map((pipeline) => [pipeline.id, pipeline]));
    for (const raw of [...configured.workspace, ...configured.user]) {
      if (isPipelineDef(raw) && validatePipelineRaw(raw, knownPhaseIds).length === 0) {
        effective.set(raw.id, raw);
      }
    }
    rows = [...effective.values()];
  }
  const ids = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || !Array.isArray(row.phases)) continue;
    if (row.phases.some((phaseId) => typeof phaseId === 'string' && phaseIds.has(phaseId))) {
      ids.add(row.id);
    }
  }
  return [...ids].sort();
}

export const handler: CommandHandler<SavePhasesCommand> = async (ctx, command) => {
  const { scope, expectedRevision, mutation } = command.payload;
  // Feature 085 (FR-061) — the one layer write a package import is about, or
  // null for every other mutation. Read before the first gate so a refusal at
  // any of them leaves a record; every audit call below is a no-op when null.
  const exchange: ImportCommitTarget | null =
    mutation.kind === 'import-package'
      ? { resourceKind: 'phase', resourceIds: mutation.phaseIds, scope }
      : null;

  if (!ctx.deps.updateConfig || !ctx.deps.readPhaseConfig) {
    await auditImportRefused(ctx, exchange, 'config-ops-unavailable');
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  const intent = phaseIntent(mutation);
  const layers = ctx.deps.readPhaseConfig();
  const currentRows = layers[scope];
  const currentRevision = phaseLayerRevision(currentRows);
  const currentLayer = normalizeLayer(currentRows);
  const currentById = definitionMap(currentLayer.definitions, phaseIntentAdapter);
  const currentIdentities = layerIdentities(currentRows, phaseIntentAdapter);

  if (expectedRevision !== currentRevision) {
    await auditImportRefused(ctx, exchange, 'stale-catalog');
    await ack(ctx, 'rejected', 'stale-catalog', {
      currentRevision,
      current: currentMetadata(mutation, currentById, scope, ctx.deps.logger.sanitize)
    });
    return;
  }

  const proposedLayer = normalizeLayer(command.payload.phases);
  if (proposedLayer.errors.length > 0) {
    await auditImportRefused(ctx, exchange, 'phase-validation');
    await ack(
      ctx,
      'rejected',
      'phase-validation',
      boundedValidationResult(proposedLayer.errors, ctx.deps.logger.sanitize)
    );
    return;
  }
  const runnerPolicyErrors = proposedLayer.definitions.flatMap((definition) => {
    if (definition.runner === undefined) return [];
    const message = phaseRunnerPolicyError(definition.phaseId, definition.runner);
    return message === null ? [] : [{
      phaseId: definition.phaseId,
      field: 'runner',
      code: 'git-metadata-write-required',
      message
    } satisfies PhaseFieldError];
  });
  if (runnerPolicyErrors.length > 0) {
    await auditImportRefused(ctx, exchange, 'phase-validation');
    await ack(
      ctx,
      'rejected',
      'phase-validation',
      boundedValidationResult(runnerPolicyErrors, ctx.deps.logger.sanitize)
    );
    return;
  }
  const proposedById = definitionMap(proposedLayer.definitions, phaseIntentAdapter);
  const proposedIdentities = layerIdentities(command.payload.phases, phaseIntentAdapter);
  const diff = layerDiff(currentById, proposedById);
  const repairTargetId = identityRepairTarget(
    intent, currentIdentities.counts, proposedIdentities.counts, diff
  );
  const mutationValid = (repairTargetId !== null || mutationMatches(
    intent, diff, proposedLayer.definitions.length,
    currentIdentities.counts, proposedIdentities.counts
  )) && layerShapeMatches(
    intent, currentRows, command.payload.phases, repairTargetId, phaseIntentAdapter
  );
  if (!mutationValid) {
    if (
      mutation.kind === 'edit' &&
      (currentIdentities.counts.get(mutation.phaseId) ?? 0) === 1 &&
      (proposedIdentities.counts.get(mutation.phaseId) ?? 0) === 0 &&
      [...proposedIdentities.counts.keys()].some(
        (phaseId) => !currentIdentities.counts.has(phaseId)
      )
    ) {
      await ack(ctx, 'rejected', 'phase-identity-immutable', {
        phaseId: ctx.deps.logger.sanitize(mutation.phaseId).slice(0, 64),
        legalActions: ['duplicate']
      });
      return;
    }
    const builtInIds = new Set(BUILT_IN_PHASES.map((phase) => phase.id));
    // Only `edit` and `remove` can name a row this layer does not own, so the
    // target is read from the single-id kinds alone.
    const builtInOnly = (mutation.kind === 'edit' || mutation.kind === 'remove')
      && builtInIds.has(mutation.phaseId)
      && !currentById.has(mutation.phaseId);
    const reason = builtInOnly ? 'built-in-immutable' : 'phase-mutation-mismatch';
    await auditImportRefused(ctx, exchange, reason);
    await ack(ctx, 'rejected', reason);
    return;
  }

  const importedIds = new Set(
    mutation.kind === 'import' || mutation.kind === 'import-package'
      ? declaredPhaseIds(mutation)
      : []
  );
  for (const raw of command.payload.phases) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const phaseId = typeof row.phaseId === 'string'
      ? row.phaseId
      : typeof row.id === 'string' ? row.id : null;
    if (phaseId === null || row.version === undefined) continue;
    // An imported identity declares its own version (FR-046a, FR-044). Skipping
    // the echo check for those alone leaves it in force for every other row.
    if (importedIds.has(phaseId)) continue;
    const expectedVersions = currentIdentities.versions.get(
      phaseId === repairTargetId && mutation.kind === 'edit' ? mutation.phaseId : phaseId
    ) ?? new Set([1]);
    if (!expectedVersions.has(row.version as number)) {
      await auditImportRefused(ctx, exchange, 'phase-version-invalid');
      await ack(ctx, 'rejected', 'phase-version-invalid', {
        phaseId: ctx.deps.logger.sanitize(phaseId).slice(0, 64),
        expectedVersions: [...expectedVersions].sort((a, b) => a - b)
      });
      return;
    }
  }

  const reset = mutation.kind === 'reset' && proposedLayer.definitions.length === 0;
  if (!reset) {
    if (!isCapabilityAllowed('phases')) {
      await denyAndAudit(ctx, 'phases');
      return;
    }
    for (let index = 0; index < proposedLayer.definitions.length; index++) {
      const phase = proposedLayer.definitions[index];
      if (phase.retryCondition !== defaultRetryConditionForPhaseId(phase.phaseId)) {
        if (!isCapabilityAllowed('retryConditions')) {
          await denyAndAudit(ctx, 'retryConditions', index);
          return;
        }
        break;
      }
    }
  }

  const versionSources = repairTargetId !== null && mutation.kind === 'edit'
    ? new Map([
        ...currentIdentities.versions,
        [repairTargetId, currentIdentities.versions.get(mutation.phaseId) ?? new Set([1])]
      ])
    : currentIdentities.versions;
  const versioned = withHostVersions(
    proposedLayer.definitions,
    currentById,
    currentIdentities.counts,
    versionSources,
    intent,
    phaseIntentAdapter
  );
  const persistedRows = withImportedVersion(versioned, proposedById, mutation).map(persistedRow);

  if (mutation.kind === 'remove' || mutation.kind === 'reset') {
    const prospective = resolvePhaseCatalog({
      builtIn: BUILT_IN_PHASES,
      user: scope === 'user' ? persistedRows : layers.user,
      workspace: scope === 'workspace' ? persistedRows : layers.workspace
    });
    const candidateIds = (mutation.kind === 'remove'
      ? [mutation.phaseId]
      : [...currentIdentities.counts.keys()])
      .filter((phaseId) => /^[a-z][a-z0-9-]{0,63}$/.test(phaseId));
    const effectiveIds = new Set(prospective.effective.map((definition) => definition.phaseId));
    const unresolvedIds = new Set(candidateIds.filter((phaseId) => !effectiveIds.has(phaseId)));
    if (unresolvedIds.size > 0) {
      if (!ctx.deps.readPipelineConfig && !ctx.deps.getCatalog) {
        await ack(ctx, 'rejected', 'catalog-ops-unavailable');
        return;
      }
      const currentCatalog = resolvePhaseCatalog({
        builtIn: BUILT_IN_PHASES, user: layers.user, workspace: layers.workspace
      });
      const knownPhaseIds = new Set(
        currentCatalog.effective.map((definition) => definition.phaseId)
      );
      const dependentPipelineIds = configuredPipelineIdsReferencing(
        ctx, unresolvedIds, knownPhaseIds
      );
      if (dependentPipelineIds.length > 0) {
        await ack(ctx, 'rejected', 'phase-removal-blocked', {
          phaseIds: [...unresolvedIds].slice(0, 20)
            .map((id) => ctx.deps.logger.sanitize(id).slice(0, 64)),
          dependentPipelineIds: dependentPipelineIds
            .slice(0, 20)
            .map((id) => ctx.deps.logger.sanitize(id).slice(0, 64)),
          total: dependentPipelineIds.length
        });
        return;
      }
    }
  }

  try {
    await ctx.deps.updateConfig('phases', persistedRows, scope);
  } catch (error) {
    ctx.deps.logger.warn(
      `phase catalog save failed: ${ctx.deps.logger.sanitize((error as Error).message)}`
    );
    await auditImportRefused(ctx, exchange, 'persistence-failed');
    await ack(ctx, 'rejected', 'persistence-failed');
    return;
  }

  await auditImportCommitted(ctx, exchange);
  await ack(ctx, 'accepted', undefined, {
    scope,
    revision: phaseLayerRevision(persistedRows),
    mutation: mutation.kind
  });
};
