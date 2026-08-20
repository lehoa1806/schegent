// Feature 096 T021 — two call sites share this command (contracts
// specs/096-model-list-import-export/contracts/model-catalog-exchange.md
// §4). Manual add/remove (`expectedRevision`/`mutation` both omitted) keeps
// its pre-existing unconditional write byte-for-byte. Import-confirm (both
// present) runs the gated sequence below, narrowed from
// `cmd-save-pipelines.ts`'s pattern to what Model Catalog actually needs: no
// cross-reference gate, no consumer-removal-block gate, no capability-trust
// gate (none apply — FR-015, research.md Decision 9).

import { modelsLayerRevision } from '../../../config/model-catalog';
import { isBackendRunnerKind, type BackendRunnerKind } from '../../../runner/backend-runner-factory';
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

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

const EMPTY_MODELS_CONFIG: ModelsConfig = { claude: [], codex: [], agy: [] };

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
  const merged: Record<BackendRunnerKind, string[]> = {
    claude: [...current.claude],
    codex: [...current.codex],
    agy: [...current.agy]
  };
  for (const row of rows) {
    if (row.outcome !== 'import' || row.resourceKind !== 'modelCatalog') continue;
    if (isBackendRunnerKind(row.backend)) merged[row.backend].push(row.modelId);
  }
  return merged;
}

export const handler: CommandHandler<SaveModelsCommand> = async (ctx, command) => {
  const { models, expectedRevision, mutation } = command.payload;

  if (!ctx.deps.updateConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  // Manual add/remove — pre-existing behavior, unchanged.
  if (mutation === undefined) {
    await ctx.deps.updateConfig('models', models);
    await ack(ctx, 'accepted');
    return;
  }

  // Import-confirm — gated sequence.
  const exchange: ImportCommitTarget = {
    resourceKind: 'modelCatalog',
    resourceIds: Object.values(models).flat()
  };

  const currentModelsConfig = ctx.deps.readModelsConfig?.() ?? EMPTY_MODELS_CONFIG;
  const currentRevision = modelsLayerRevision(currentModelsConfig);

  // Revision gate, before any other check.
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
