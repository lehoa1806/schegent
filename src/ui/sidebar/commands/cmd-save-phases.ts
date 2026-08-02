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

/** Projects a Phase mutation onto the entity-agnostic intent the algebra reads. */
function phaseIntent(mutation: PhaseCatalogMutation): LayerMutationIntent {
  return { kind: mutation.kind, targetId: mutation.kind === 'reset' ? null : mutation.phaseId };
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
  if (!ctx.deps.updateConfig || !ctx.deps.readPhaseConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  const { scope, expectedRevision, mutation } = command.payload;
  const intent = phaseIntent(mutation);
  const layers = ctx.deps.readPhaseConfig();
  const currentRows = layers[scope];
  const currentRevision = phaseLayerRevision(currentRows);
  const currentLayer = normalizeLayer(currentRows);
  const currentById = definitionMap(currentLayer.definitions, phaseIntentAdapter);
  const currentIdentities = layerIdentities(currentRows, phaseIntentAdapter);

  if (expectedRevision !== currentRevision) {
    await ack(ctx, 'rejected', 'stale-catalog', {
      currentRevision,
      current: currentMetadata(mutation, currentById, scope, ctx.deps.logger.sanitize)
    });
    return;
  }

  const proposedLayer = normalizeLayer(command.payload.phases);
  if (proposedLayer.errors.length > 0) {
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
    const targetId = mutation.kind === 'reset'
      ? null
      : mutation.kind === 'duplicate'
        ? mutation.sourcePhaseId
        : mutation.phaseId;
    const builtInOnly = (mutation.kind === 'edit' || mutation.kind === 'remove')
      && targetId !== null
      && builtInIds.has(targetId)
      && !currentById.has(targetId);
    await ack(
      ctx,
      'rejected',
      builtInOnly ? 'built-in-immutable' : 'phase-mutation-mismatch'
    );
    return;
  }

  for (const raw of command.payload.phases) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const phaseId = typeof row.phaseId === 'string'
      ? row.phaseId
      : typeof row.id === 'string' ? row.id : null;
    if (phaseId === null || row.version === undefined) continue;
    const expectedVersions = currentIdentities.versions.get(
      phaseId === repairTargetId && mutation.kind === 'edit' ? mutation.phaseId : phaseId
    ) ?? new Set([1]);
    if (!expectedVersions.has(row.version as number)) {
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
  const persistedRows = versioned.map(persistedRow);

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
    await ack(ctx, 'rejected', 'persistence-failed');
    return;
  }

  await ack(ctx, 'accepted', undefined, {
    scope,
    revision: phaseLayerRevision(persistedRows),
    mutation: mutation.kind
  });
};
