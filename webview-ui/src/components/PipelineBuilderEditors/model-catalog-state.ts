import type { WorkflowSnapshot } from '../../lib/snapshot-types';

const PRESEEDED_CLAUDE_MODELS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-haiku-4-5'
];

export function initialModels(
  available: NonNullable<WorkflowSnapshot['availableModels']>
): Record<string, string[]> {
  const models: Record<string, string[]> = {};
  for (const kind of Object.keys(available)) {
    const loaded = [...(available[kind as keyof typeof available] ?? [])];
    models[kind] = loaded.length > 0
      ? loaded
      : kind === 'claude' ? [...PRESEEDED_CLAUDE_MODELS] : [];
  }
  return models;
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
