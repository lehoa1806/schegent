import type { WorkflowSnapshot } from '../../lib/snapshot-types';

/** Every backend the editor shows a section for, whatever either list holds. */
const EDITABLE_BACKENDS: readonly string[] = ['claude', 'codex', 'agy'];

/**
 * The editable catalog, seeded from CONFIGURATION — `schegent.models` — and
 * from nothing else.
 *
 * This read `availableModels` until the Models page was found to be showing
 * the capability service's list instead of the operator's own: a confirmed
 * import wrote `schegent.models` and the page never changed, and "Save All
 * Models" would then write the displayed list back over what was imported.
 *
 * There is deliberately no preseed. Whatever this returns is what "Save All
 * Models" persists, so a hardcoded default here is a hardcoded default one
 * click away from becoming the operator's real catalog — which is how the
 * old claude preseed could silently replace an imported one. An empty
 * catalog now shows as empty, and is filled by typing an id or by Detect.
 */
export function initialModels(
  configured: WorkflowSnapshot['configuredModels']
): Record<string, string[]> {
  const models: Record<string, string[]> = {};
  for (const kind of new Set([...EDITABLE_BACKENDS, ...Object.keys(configured ?? {})])) {
    models[kind] = [...(configured?.[kind as keyof NonNullable<typeof configured>] ?? [])];
  }
  return models;
}

/**
 * `current` followed by whatever in `detected` is not already in it, in order.
 *
 * Append-only and order-preserving on purpose: this backs Detect, and an
 * operator's catalog is theirs — a merge that reordered or dropped entries
 * would edit work they did not ask to have edited. Comparison is
 * byte-for-byte, matching how the import planner decides `already-exists`, so
 * Detect and an import agree on what counts as the same model.
 */
export function mergeDetectedModels(
  current: readonly string[],
  detected: readonly string[]
): string[] {
  const merged = [...current];
  const seen = new Set(current);
  for (const model of detected) {
    if (model.length === 0 || seen.has(model)) continue;
    seen.add(model);
    merged.push(model);
  }
  return merged;
}

/**
 * The catalog with `value` appended under `backend`, or `null` when there is
 * nothing to do — an empty id, or one the backend already holds. `null` rather
 * than an unchanged record so the caller can tell an accepted add from a
 * refused one; only an accepted one clears the input box.
 */
export function withModelAdded(
  models: Record<string, string[]>,
  backend: string,
  value: string
): Record<string, string[]> | null {
  const trimmed = value.trim();
  const current = models[backend] ?? [];
  if (trimmed.length === 0 || current.includes(trimmed)) return null;
  return { ...models, [backend]: [...current, trimmed] };
}

/** The catalog with `backend`'s entry at `index` dropped. */
export function withModelRemoved(
  models: Record<string, string[]>,
  backend: string,
  index: number
): Record<string, string[]> {
  const current = models[backend];
  if (!current) return models;
  return { ...models, [backend]: current.filter((_, position) => position !== index) };
}

/** The catalog with `backend`'s entry at `index` retyped to `value`. */
export function withModelReplaced(
  models: Record<string, string[]>,
  backend: string,
  index: number,
  value: string
): Record<string, string[]> {
  const current = models[backend];
  if (!current) return models;
  const next = [...current];
  next[index] = value;
  return { ...models, [backend]: next };
}

/**
 * The catalog with whatever `backend`'s CLI reported folded in, skipping ids
 * already held. This backs Detect, and it stages into the editor rather than
 * saving: Detect stays reviewable and reversible until the operator saves,
 * the same standing every other edit on this page has. Only `agy` ever
 * supplies anything — the `claude` and `codex` CLIs cannot enumerate models.
 */
export function withModelsDetected(
  models: Record<string, string[]>,
  backend: string,
  detected: readonly string[]
): Record<string, string[]> {
  return { ...models, [backend]: mergeDetectedModels(models[backend] ?? [], detected) };
}

/**
 * Turns a Model Catalog import-commit rejection into one line the operator
 * can act on — the Model Catalog counterpart to `formatPipelineSaveRejection`
 * and `formatWorkflowSaveRejection` in the sibling `*-catalog-state.ts`
 * files. A single reason rather than a table of them: FR-015/research.md
 * Decision 9 rule out a cross-reference gate, a consumer-removal-block gate,
 * and a capability-trust gate for Model Catalog, so `stale-catalog` is the
 * only structured rejection this write can return; everything else (a
 * timeout, a persistence failure, the config API being unavailable) has no
 * extra detail to add beyond the code itself.
 */
export function formatModelCatalogSaveRejection(reason: string): string {
  if (reason === 'stale-catalog') {
    return `${reason} — the catalog changed since this document was inspected; inspect it again`;
  }
  return reason;
}
