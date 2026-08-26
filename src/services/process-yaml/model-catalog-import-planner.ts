// Feature 096 — Model Catalog import classification (data-model.md
// "Classification" flowchart).
//
// One row per declared model id, not per group: a group's `models` list can
// name several ids, and each gets an independent import/skip outcome. Backend
// recognition is decided here, at plan time, never in the parser
// (data-model.md Decision 3) — an unrecognized backend does not invalidate the
// document, it turns every one of that group's model ids into a skip row.
//
// A model id equal to the empty string is silently dropped rather than
// reported: neither `ModelCatalogSkipRow` reason ('already-exists' /
// 'unrecognized-backend') describes it, and there is no third reason in the
// closed union to invent one. `groupsFromModelsConfig` /
// `modelsConfigFromGroups` (`../config/model-catalog.ts`) already drop empty
// ids the same way, so this is the established convention, not a new one.

import { isBackendRunnerKind, type BackendRunnerKind } from '../../contracts/backend-kinds';
import type { ImportPlanRow, ModelCatalogYamlDocument } from './types';

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

/**
 * `currentModelsConfig` is the catalog the plan is computed against — the
 * same one `ImportPlan.computedAgainstModelsRevision` records the revision
 * of, so a plan and the staleness gate that later re-validates it always
 * agree on what "current" meant.
 */
export function planModelCatalogImport(
  document: ModelCatalogYamlDocument,
  currentModelsConfig: ModelsConfig
): ImportPlanRow[] {
  const seenByBackend: Record<BackendRunnerKind, Set<string>> = {
    claude: new Set(currentModelsConfig.claude),
    codex: new Set(currentModelsConfig.codex),
    agy: new Set(currentModelsConfig.agy)
  };

  const rows: ImportPlanRow[] = [];
  for (const group of document.groups) {
    for (const modelId of group.models ?? []) {
      if (modelId.length === 0) continue;

      if (!isBackendRunnerKind(group.backend)) {
        rows.push({
          outcome: 'skip',
          resourceKind: 'modelCatalog',
          resourceId: modelId,
          backend: group.backend,
          modelId,
          reason: 'unrecognized-backend'
        });
        continue;
      }

      // Byte-for-byte membership — no case-folding, no whitespace-trimming
      // (data-model.md "Model Group" validation). The set is grown as each
      // id is admitted so a later duplicate of an id declared earlier in
      // THIS document — even under a repeated backend group — also resolves
      // to already-exists rather than importing twice.
      const backendSeen = seenByBackend[group.backend];
      if (backendSeen.has(modelId)) {
        rows.push({
          outcome: 'skip',
          resourceKind: 'modelCatalog',
          resourceId: modelId,
          backend: group.backend,
          modelId,
          reason: 'already-exists'
        });
        continue;
      }

      backendSeen.add(modelId);
      rows.push({
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: modelId,
        backend: group.backend,
        modelId
      });
    }
  }
  return rows;
}
