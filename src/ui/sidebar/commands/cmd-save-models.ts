import { coerceModels } from '../../../config/pipeline-config-loader';
import { modelsLayerRevision } from '../../../config/model-catalog';
import { isBackendRunnerKind } from '../../../contracts/backend-kinds';
import {
  mapMutableBackends,
  type BackendMap
} from '../../../contracts/backend-descriptors';
import { planModelCatalogImport } from '../../../services/process-yaml/model-catalog-import-planner';
import {
  MODEL_CATALOG_YAML_KIND,
  PHASE_YAML_API_VERSION,
  type ModelCatalogYamlGroup
} from '../../../services/process-yaml/types';
import type { SaveModelsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';
import {
  auditImportCommitted,
  auditImportRefused,
  type ImportCommitTarget
} from './process-exchange-commit-audit';

type ModelsConfig = BackendMap<readonly string[]>;

/**
 * Reshapes the wire payload directly into planner input, deliberately NOT
 * via `groupsFromModelsConfig` (`../../../config/model-catalog.ts`) — that
 * helper trims and drops empty ids, which is right when projecting the
 * *persisted* catalog into an exported document but wrong here: re-planning
 * (below) must classify the exact strings preflight already classified,
 * byte-for-byte (data-model.md: no whitespace-trimming). Trimming first
 * would let the re-plan disagree with the plan the operator already
 * confirmed, silently dropping an entry that differs from an existing one
 * only by whitespace. An unrecognized key is dropped, the same as every
 * other read of a `BackendRunnerKind` in this file.
 */
function groupsFromPayload(models: Record<string, readonly string[]>): ModelCatalogYamlGroup[] {
  return Object.keys(models)
    .filter(isBackendRunnerKind)
    .map((backend) => ({ backend, models: models[backend] }));
}

/**
 * Only the `import`-outcome rows land — a `skip` row re-confirms what the
 * delta already believed (or, for a delta the server does not trust, corrects
 * it); either way it is a no-op here, never a merge (contracts §4 step 5).
 */
function mergeImportedRows(
  current: ModelsConfig,
  rows: ReturnType<typeof planModelCatalogImport>
): ModelsConfig {
  const merged = mapMutableBackends((descriptor) => [...current[descriptor.kind]]);
  for (const row of rows) {
    if (row.outcome !== 'import' || row.resourceKind !== 'modelCatalog') continue;
    if (isBackendRunnerKind(row.backend)) merged[row.backend].push(row.modelId);
  }
  return merged;
}

export const handler: CommandHandler<SaveModelsCommand> = async (ctx, command) => {
  const { models, expectedRevision, mutation } = command.payload;

  if (!ctx.deps.updateConfig || !ctx.deps.readModelsConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  const currentModelsConfig = ctx.deps.readModelsConfig();
  const currentRevision = modelsLayerRevision(currentModelsConfig);
  // Older editors have no trustworthy base revision. Return an actionable refusal.
  if (mutation === undefined || expectedRevision === undefined) {
    await ack(ctx, 'rejected', 'stale-catalog', { currentRevision });
    return;
  }
  if (mutation.kind === 'manual-edit') {
    if (expectedRevision !== currentRevision) {
      await ack(ctx, 'rejected', 'stale-catalog', { currentRevision });
      return;
    }
    await ctx.deps.updateConfig('models', models);
    await ack(ctx, 'accepted', undefined, { revision: modelsLayerRevision(coerceModels(models)) });
    return;
  }
  const exchange: ImportCommitTarget = {
    resourceKind: 'modelCatalog',
    resourceIds: Object.values(models).flat()
  };
  if (expectedRevision !== currentRevision) {
    await auditImportRefused(ctx, exchange, 'stale-catalog');
    await ack(ctx, 'rejected', 'stale-catalog', { currentRevision });
    return;
  }

  // Re-run the planner against the CURRENT catalog (FR-016) — the revision
  // match just confirmed nothing changed, but the delta's own classification
  // is never trusted directly; this re-derives it server-side.
  const proposedDocument = {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: MODEL_CATALOG_YAML_KIND,
    groups: groupsFromPayload(models)
  } as const;
  const rows = planModelCatalogImport(proposedDocument, currentModelsConfig);
  const mergedCatalog = mergeImportedRows(currentModelsConfig, rows);

  try {
    await ctx.deps.updateConfig('models', mergedCatalog);
  } catch (error) {
    ctx.deps.logger.warn(
      `model catalog save failed: ${ctx.deps.logger.sanitize((error as Error).message)}`
    );
    await auditImportRefused(ctx, exchange, 'persistence-failed');
    await ack(ctx, 'rejected', 'persistence-failed');
    return;
  }

  await auditImportCommitted(ctx, exchange);
  await ack(ctx, 'accepted', undefined, {
    revision: modelsLayerRevision(mergedCatalog),
    mutation: mutation.kind
  });
};
