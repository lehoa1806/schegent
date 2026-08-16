// Feature 096 — Model Catalog revision + document/domain mapping.
//
// Model Catalog has exactly one writable layer (`'workspace'`), unlike the
// Phase/Pipeline/Workflow catalogs' built-in/user/workspace tiering, so its
// revision is a single string rather than a `{user, workspace}` pair
// (research.md Decision 6).

import { createHash } from 'node:crypto';
import {
  SUPPORTED_BACKENDS,
  isBackendRunnerKind,
  type BackendRunnerKind
} from '../runner/backend-runner-factory';
import type { ModelCatalogYamlGroup } from '../services/process-yaml/types';

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

// Mirrors the private helper of the same name in `./process-catalog.ts`
// (`phaseLayerRevision`'s dependency) — not imported, because that one is
// module-private and this catalog has its own, differently-shaped revision
// input (a keyed Record, not a row array).
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

/**
 * Mirrors `phaseLayerRevision()` (`./process-catalog.ts`), single-layer shape:
 * one string for the whole Model Catalog rather than one per scope.
 */
export function modelsLayerRevision(config: ModelsConfig | undefined): string {
  return createHash('sha256')
    .update(stableJsonStringify(config ?? {}), 'utf8')
    .digest('hex');
}

/**
 * One group per `SUPPORTED_BACKENDS` member, in that order, so export is
 * deterministic (SC-004). `models` is omitted — never `models: []` — when a
 * backend has no custom models (research R3's absent-not-empty convention).
 */
export function groupsFromModelsConfig(config: ModelsConfig): ModelCatalogYamlGroup[] {
  return SUPPORTED_BACKENDS.map((backend) => {
    const models = (config[backend] ?? [])
      .map((modelId) => modelId.trim())
      .filter((modelId) => modelId.length > 0);
    return models.length > 0 ? { backend, models } : { backend };
  });
}

/**
 * Inverse of `groupsFromModelsConfig`. A group naming an unrecognized backend
 * contributes nothing here — classifying and reporting that case is
 * `planModelCatalogImport`'s job (contracts §6), not this mapper's; this
 * function only ever needs to round-trip what `groupsFromModelsConfig` itself
 * produces.
 */
export function modelsConfigFromGroups(groups: readonly ModelCatalogYamlGroup[]): ModelsConfig {
  const out: Record<BackendRunnerKind, string[]> = { claude: [], codex: [], agy: [] };
  for (const group of groups) {
    if (!isBackendRunnerKind(group.backend)) continue;
    for (const modelId of group.models ?? []) {
      const trimmed = modelId.trim();
      if (trimmed.length > 0) out[group.backend].push(trimmed);
    }
  }
  return out;
}
