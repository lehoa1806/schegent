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
