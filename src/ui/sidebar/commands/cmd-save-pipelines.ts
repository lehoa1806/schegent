// Feature 082 (US1, T025) — scoped, revisioned, intent-declaring Pipeline save.
// Contract: specs/082-pipeline-contracts-builder/contracts/save-pipelines-ipc.md
//
// The ordered gate table is implemented top to bottom and returns on the first
// failure, so no configuration write happens unless every gate passes (FR-020).
//
// Feature 059's per-capability trust gate is preserved verbatim as gates 11–12:
// a payload byte-equivalent to `BUILT_IN_PIPELINES` and a `reset` that empties
// the layer both bypass `pipelineOverrides`, so an operator can always return to
// defaults from a denied state (I-2).

import {
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINES,
  equalsBuiltInPipelines
} from '../../../config/pipeline-config';
import {
  pipelineLayerRevision,
  pipelineSourceIdentity,
  resolvePipelineCatalog,
  unknownPhaseErrors
} from '../../../config/pipeline-catalog';
import { validatePipelineBindings } from '../../../config/pipeline-binding-validator';
import {
  PIPELINE_ID_PATTERN,
  validatePipelineDefinition
} from '../../../config/pipeline-definition-validator';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import { WORKFLOW_ID_MAX_LEN } from '../../../config/workflow-definition-validator';
import type {
  PipelineCatalogMutation,
  PipelineDefinition,
  PipelineFieldError,
  WritablePipelineDefinitionScope
} from '../../../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../contracts/process-definitions';
import { isCapabilityAllowed } from '../../../state/capability-trust-resolver';
import type { SavePipelinesCommand } from '../messages';
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
  readonly definitions: readonly PipelineDefinition[];
  readonly errors: readonly PipelineFieldError[];
}

/**
 * Binds the shared mutation-intent algebra to the Pipeline catalog. The algebra
 * itself is entity-agnostic (`save-layer-intent.ts`), so both catalogs answer
 * "does the observed diff match the declared intent?" identically (research R6).
 */
const pipelineIntentAdapter: LayerIntentAdapter<PipelineDefinition> = {
  sourceIdentity: pipelineSourceIdentity,
  identityOf: (definition) => definition.pipelineId,
  parse: (row) =>
    validatePipelineDefinition(row, { allowLegacyId: true, defaultVersion: 1 }).definition
};

/**
 * Projects a Pipeline mutation onto the entity-agnostic intent the algebra reads.
 *
 * `import-package` (feature 085, research R5) is the one kind that names a SET:
 * a confirmed package import appends every eligible Pipeline in a single write,
 * which no single-id kind describes, so the set passes through as `targetIds`.
 */
function pipelineIntent(mutation: PipelineCatalogMutation): LayerMutationIntent {
  if (mutation.kind === 'import-package') {
    return { kind: 'import-package', targetId: null, targetIds: mutation.pipelineIds };
  }
  return { kind: mutation.kind, targetId: mutation.kind === 'reset' ? null : mutation.pipelineId };
}

/**
 * Feature 085 (FR-044) — the rows a package import introduces keep the `version`
 * their document declared, so exporting an imported Pipeline reproduces the
 * source document. Every other row still gets its version from
 * {@link withHostVersions}. The exemption is safe because the algebra has
 * already established that these identities are absent from the current layer:
 * a save cannot dictate a version *transition*, and there is none here.
 */
function withImportedVersion(
  versioned: readonly PipelineDefinition[],
  proposedById: ReadonlyMap<string, PipelineDefinition>,
  mutation: PipelineCatalogMutation
): readonly PipelineDefinition[] {
  if (mutation.kind !== 'import-package') return versioned;
  const importedIds = new Set(mutation.pipelineIds);
  return versioned.map((definition) => {
    if (!importedIds.has(definition.pipelineId)) return definition;
    const authored = proposedById.get(definition.pipelineId);
    return authored === undefined
      ? definition
      : Object.freeze({ ...definition, version: authored.version });
  });
}

/**
 * Gates 4 and 6: field, port, binding-shape, and execution-default validation of
 * one layer, plus the duplicate-id check that only a whole layer can see (FR-036).
 * Cross-reference resolution against the effective Phase catalog is gate 5 (T038).
 */
function normalizeLayer(rows: readonly unknown[]): NormalizedLayer {
  const definitions: PipelineDefinition[] = [];
  const errors: PipelineFieldError[] = [];
  const ids = new Map<string, number>();
  for (const row of rows) {
    const result = validatePipelineDefinition(row, { allowLegacyId: true, defaultVersion: 1 });
    errors.push(...result.errors);
    if (result.definition) {
      definitions.push(result.definition);
      ids.set(result.definition.pipelineId, (ids.get(result.definition.pipelineId) ?? 0) + 1);
    }
  }
  for (const [pipelineId, count] of ids) {
    if (count > 1) {
      errors.push({
        pipelineId,
        field: 'pipelineId',
        code: 'duplicate-in-scope',
        message: `Pipeline id '${pipelineId}' appears more than once in this scope`
      });
    }
  }
  return { definitions, errors };
}

/**
 * Gate 5 — every `phaseId` and every binding must resolve against the effective
 * Phase catalog (FR-011, FR-015, FR-016). Phase precedence is resolved before
 * the check, so a Phase authored in several scopes counts as resolvable through
 * its highest-precedence valid source (Edge Case 1). The same two checks run in
 * `resolvePipelineCatalog`, so a row that passes here also resolves on reload.
 */
function crossReferenceErrors(
  definitions: readonly PipelineDefinition[],
  effectivePhases: readonly PhaseDefinition[]
): readonly PipelineFieldError[] {
  const knownPhaseIds = new Set(effectivePhases.map((phase) => phase.phaseId));
  const errors: PipelineFieldError[] = [];
  for (const definition of definitions) {
    errors.push(...unknownPhaseErrors(definition, knownPhaseIds));
    errors.push(...validatePipelineBindings(definition, effectivePhases));
  }
  return errors;
}

/** The authored settings shape, matching the `schegent.pipelines` JSON schema. */
function persistedRow(definition: PipelineDefinition): Record<string, unknown> {
  return {
    id: definition.pipelineId,
    name: definition.name,
    version: definition.version,
    phases: [...definition.phaseIds],
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    ...(definition.inputs.length > 0 ? { inputs: definition.inputs } : {}),
    ...(definition.outputs.length > 0 ? { outputs: definition.outputs } : {}),
    ...(definition.bindings.length > 0 ? { bindings: definition.bindings } : {}),
    ...(definition.executionDefaults !== undefined
      ? { executionDefaults: definition.executionDefaults }
      : {}),
    ...(definition.recommendedNext.length > 0
      ? { recommendedNext: definition.recommendedNext }
      : {})
  };
}

function boundedValidationResult(
  errors: readonly PipelineFieldError[],
  sanitize: (value: string) => string
): unknown {
  return {
    errors: errors.slice(0, 20).map((error) => ({
      pipelineId: sanitize(error.pipelineId).slice(0, 64),
      field: sanitize(error.field).slice(0, 32),
      code: sanitize(error.code).slice(0, 64),
      message: sanitize(error.message).slice(0, 512)
    })),
    total: errors.length
  };
}

function currentMetadata(
  mutation: PipelineCatalogMutation,
  current: ReadonlyMap<string, PipelineDefinition>,
  scope: WritablePipelineDefinitionScope,
  sanitize: (value: string) => string
): unknown {
  if (mutation.kind === 'reset') return { scope, legalActions: ['refresh'] };
  // A package names a set, not a row, and `reapply` is not offered: the plan was
  // computed against the revision this gate just rejected, so its skip and
  // blocked decisions may no longer hold. The operator re-runs the preflight.
  if (mutation.kind === 'import-package') return { scope, legalActions: ['refresh'] };
  const pipelineId =
    mutation.kind === 'duplicate' ? mutation.sourcePipelineId : mutation.pipelineId;
  const definition = current.get(pipelineId);
  return {
    scope,
    pipelineId: sanitize(pipelineId).slice(0, 64),
    ...(definition
      ? { name: sanitize(definition.name).slice(0, 80), version: definition.version }
      : {}),
    legalActions: ['refresh', 'reapply']
  };
}

/**
 * The consumer-resolution seam (research R5). Given the `pipelineId`s a removal
 * would leave with no effective source, it answers which consuming Workflows
 * still reference them.
 *
 * This is deliberately the ONLY place that knows what a consumer is. The host
 * feeds it both senses through one hook — queued run requests that pin a
 * Pipeline (FR-022a) and stored Workflow definitions whose nodes name one
 * (083 FR-041) — and they are reported in separate lists so the operator can
 * tell "a queued run is waiting on this" from "a saved Workflow references
 * this"; the two call for different repairs. `recommendedNext` is NOT a
 * consumer: a recommendation pointing at a removed Pipeline degrades to the
 * `pipeline-recommended-next-unresolved` warning and never blocks (FR-019a).
 *
 * Definition names carry their scope. The same Workflow identifier may exist
 * in more than one layer, and only the blocking layer is worth editing.
 */
/**
 * `${scope}::${workflowId}` — the longest scope is `workspace`, so eleven
 * characters of prefix sit on top of a full-length Workflow identifier.
 */
const SCOPED_WORKFLOW_NAME_MAX_LEN = WORKFLOW_ID_MAX_LEN + 'workspace::'.length;

function consumingWorkflowsReferencing(
  ctx: Parameters<typeof handler>[0],
  pipelineIds: ReadonlySet<string>
): { runRequestIds: string[]; definitionIds: string[] } {
  const runRequestIds = new Set<string>();
  const definitionIds = new Set<string>();
  for (const reference of ctx.deps.readWorkflowPipelineRefs?.() ?? []) {
    if (!pipelineIds.has(reference.pipelineId)) continue;
    if (reference.kind === 'workflow-definition') {
      definitionIds.add(`${reference.scope}::${reference.workflowId}`);
    } else {
      runRequestIds.add(reference.workflowId);
    }
  }
  return { runRequestIds: [...runRequestIds].sort(), definitionIds: [...definitionIds].sort() };
}

export const handler: CommandHandler<SavePipelinesCommand> = async (ctx, command) => {
  const { scope, expectedRevision, mutation } = command.payload;
  // Feature 085 (FR-061) — the one layer write a package import is about, or
  // null for every other mutation. Read before gate 1 so a refusal at any gate
  // leaves a record; every audit call below is a no-op when null.
  const exchange: ImportCommitTarget | null =
    mutation.kind === 'import-package'
      ? { resourceKind: 'pipeline', resourceIds: mutation.pipelineIds, scope }
      : null;

  // Gate 1 — host configuration operations.
  if (!ctx.deps.updateConfig || !ctx.deps.readPipelineConfig) {
    await auditImportRefused(ctx, exchange, 'config-ops-unavailable');
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  const intent = pipelineIntent(mutation);
  const layers = ctx.deps.readPipelineConfig();
  const currentRows = layers[scope];
  const currentRevision = pipelineLayerRevision(currentRows);
  const currentLayer = normalizeLayer(currentRows);
  const currentById = definitionMap(currentLayer.definitions, pipelineIntentAdapter);
  const currentIdentities = layerIdentities(currentRows, pipelineIntentAdapter);

  // Gate 3 — the operator acted on the layer the host still holds (FR-030).
  if (expectedRevision !== currentRevision) {
    await auditImportRefused(ctx, exchange, 'stale-catalog');
    await ack(ctx, 'rejected', 'stale-catalog', {
      currentRevision,
      current: currentMetadata(mutation, currentById, scope, ctx.deps.logger.sanitize)
    });
    return;
  }

  // Gates 4 and 6 — complete-layer field, port, and execution-default validation.
  const proposedLayer = normalizeLayer(command.payload.pipelines);
  if (proposedLayer.errors.length > 0) {
    await auditImportRefused(ctx, exchange, 'pipeline-validation');
    await ack(
      ctx,
      'rejected',
      'pipeline-validation',
      boundedValidationResult(proposedLayer.errors, ctx.deps.logger.sanitize)
    );
    return;
  }

  // Gate 5 — Phase and binding resolution against the effective Phase catalog.
  const phaseLayers = ctx.deps.readPhaseConfig?.() ?? { user: [], workspace: [] };
  const effectivePhases = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: phaseLayers.user,
    workspace: phaseLayers.workspace
  }).effective;
  const unresolved = crossReferenceErrors(proposedLayer.definitions, effectivePhases);
  if (unresolved.length > 0) {
    await auditImportRefused(ctx, exchange, 'pipeline-validation');
    await ack(
      ctx,
      'rejected',
      'pipeline-validation',
      boundedValidationResult(unresolved, ctx.deps.logger.sanitize)
    );
    return;
  }

  // Gates 7, 8, and 9 — the observed diff must be exactly what the declared
  // mutation is allowed to produce, and nothing more (FR-037).
  const proposedById = definitionMap(proposedLayer.definitions, pipelineIntentAdapter);
  const proposedIdentities = layerIdentities(command.payload.pipelines, pipelineIntentAdapter);
  const diff = layerDiff(currentById, proposedById);
  const repairTargetId = identityRepairTarget(
    intent, currentIdentities.counts, proposedIdentities.counts, diff
  );
  const mutationValid = (repairTargetId !== null || mutationMatches(
    intent, diff, proposedLayer.definitions.length,
    currentIdentities.counts, proposedIdentities.counts
  )) && layerShapeMatches(
    intent, currentRows, command.payload.pipelines, repairTargetId, pipelineIntentAdapter
  );
  if (!mutationValid) {
    // Gate 7 — an `edit` that renames the row's identity is a distinct
    // operation the operator must express as a duplicate (FR-007).
    if (
      mutation.kind === 'edit' &&
      (currentIdentities.counts.get(mutation.pipelineId) ?? 0) === 1 &&
      (proposedIdentities.counts.get(mutation.pipelineId) ?? 0) === 0 &&
      [...proposedIdentities.counts.keys()].some(
        (pipelineId) => !currentIdentities.counts.has(pipelineId)
      )
    ) {
      await ack(ctx, 'rejected', 'pipeline-identity-immutable', {
        pipelineId: ctx.deps.logger.sanitize(mutation.pipelineId).slice(0, 64),
        legalActions: ['duplicate']
      });
      return;
    }
    // Gate 8 — the built-in layer is never a save target (FR-024). Only `edit`
    // and `remove` can name a row this layer does not own.
    const builtInIds = new Set(BUILT_IN_PIPELINES.map((pipeline) => pipeline.id));
    const builtInOnly = (mutation.kind === 'edit' || mutation.kind === 'remove')
      && builtInIds.has(mutation.pipelineId)
      && !currentById.has(mutation.pipelineId);
    const reason = builtInOnly ? 'built-in-immutable' : 'pipeline-mutation-mismatch';
    await auditImportRefused(ctx, exchange, reason);
    await ack(ctx, 'rejected', reason);
    return;
  }

  // Gate 10 — a row may only assert a version the host previously issued (FR-010).
  const importedIds = new Set(
    mutation.kind === 'import-package' ? mutation.pipelineIds : []
  );
  for (const raw of command.payload.pipelines) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const pipelineId = typeof row.pipelineId === 'string'
      ? row.pipelineId
      : typeof row.id === 'string' ? row.id : null;
    if (pipelineId === null || row.version === undefined) continue;
    // An imported identity declares its own version (FR-044). Skipping the echo
    // check for those alone leaves it in force for every other row.
    if (importedIds.has(pipelineId)) continue;
    const expectedVersions = currentIdentities.versions.get(
      pipelineId === repairTargetId && mutation.kind === 'edit' ? mutation.pipelineId : pipelineId
    ) ?? new Set([1]);
    if (!expectedVersions.has(row.version as number)) {
      await auditImportRefused(ctx, exchange, 'pipeline-version-invalid');
      await ack(ctx, 'rejected', 'pipeline-version-invalid', {
        pipelineId: ctx.deps.logger.sanitize(pipelineId).slice(0, 64),
        expectedVersions: [...expectedVersions].sort((a, b) => a - b)
      });
      return;
    }
  }

  // Gates 11 and 12 — feature 059 I-2: returning to defaults is always allowed,
  // whether expressed as a layer-emptying `reset` or as a payload byte-equal to
  // the built-ins. Everything else needs the `pipelineOverrides` capability.
  const reset = mutation.kind === 'reset' && proposedLayer.definitions.length === 0;
  const restoresDefaults = reset || equalsBuiltInPipelines(command.payload.pipelines);
  if (!restoresDefaults && !isCapabilityAllowed('pipelineOverrides')) {
    await denyAndAudit(ctx, 'pipelineOverrides');
    return;
  }

  const versionSources = repairTargetId !== null && mutation.kind === 'edit'
    ? new Map([
        ...currentIdentities.versions,
        [repairTargetId, currentIdentities.versions.get(mutation.pipelineId) ?? new Set([1])]
      ])
    : currentIdentities.versions;
  const versioned = withHostVersions(
    proposedLayer.definitions,
    currentById,
    currentIdentities.counts,
    versionSources,
    intent,
    pipelineIntentAdapter
  );
  const persistedRows = withImportedVersion(versioned, proposedById, mutation).map(persistedRow);

  // Gate 13 — a removal may not strand a consuming Workflow. Blocked only when
  // BOTH hold: the id has no effective source left after the write, AND some
  // Workflow still references it (FR-022, FR-022a, clarification 1). Either
  // condition alone permits the removal, so a lower-precedence valid source
  // simply becomes effective.
  if (mutation.kind === 'remove' || mutation.kind === 'reset') {
    const prospective = resolvePipelineCatalog({
      builtIn: BUILT_IN_PIPELINES,
      user: scope === 'user' ? persistedRows : layers.user,
      workspace: scope === 'workspace' ? persistedRows : layers.workspace,
      phaseCatalog: effectivePhases
    });
    const candidateIds = (mutation.kind === 'remove'
      ? [mutation.pipelineId]
      : [...currentIdentities.counts.keys()])
      .filter((pipelineId) => PIPELINE_ID_PATTERN.test(pipelineId));
    const effectiveIds = new Set(
      prospective.effective.map((definition) => definition.pipelineId)
    );
    const unresolvedIds = new Set(candidateIds.filter((id) => !effectiveIds.has(id)));
    if (unresolvedIds.size > 0) {
      const { runRequestIds, definitionIds } = consumingWorkflowsReferencing(ctx, unresolvedIds);
      if (runRequestIds.length + definitionIds.length > 0) {
        const bounded = (ids: readonly string[], maxLength = 64) =>
          ids.slice(0, 20).map((id) => ctx.deps.logger.sanitize(id).slice(0, maxLength));
        await ack(ctx, 'rejected', 'pipeline-removal-blocked', {
          pipelineIds: bounded([...unresolvedIds]),
          dependentWorkflowIds: bounded(runRequestIds),
          // Additive (083 FR-041); `dependentWorkflowIds` keeps its 082 meaning
          // of queued run requests so the existing contract stays valid. The
          // wider cap leaves room for the scope prefix on top of a full-length
          // workflow id — truncating one would defeat "the refusal names the
          // referencing Workflows".
          dependentWorkflowDefinitionIds: bounded(definitionIds, SCOPED_WORKFLOW_NAME_MAX_LEN),
          total: runRequestIds.length + definitionIds.length
        });
        return;
      }
    }
  }

  // Gate 14 — the single commit point for the targeted layer.
  try {
    await ctx.deps.updateConfig('pipelines', persistedRows, scope);
  } catch (error) {
    ctx.deps.logger.warn(
      `pipeline catalog save failed: ${ctx.deps.logger.sanitize((error as Error).message)}`
    );
    await auditImportRefused(ctx, exchange, 'persistence-failed');
    await ack(ctx, 'rejected', 'persistence-failed');
    return;
  }

  await auditImportCommitted(ctx, exchange);
  await ack(ctx, 'accepted', undefined, {
    scope,
    revision: pipelineLayerRevision(persistedRows),
    mutation: mutation.kind
  });
};
