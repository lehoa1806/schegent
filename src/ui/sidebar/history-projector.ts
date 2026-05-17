// Feature 013 — Wave 7 (US7 / T091): history projection extracted from
// state-projector.ts. Pure function; the orchestrator passes in the
// store reference and the helper produces a frozen snapshot copy.

import type { HistoryStore } from '../../state/history-store';
import type { HistoryEntry } from './snapshot';

export function projectHistory(
  history: Pick<HistoryStore, 'list'> | null
): readonly HistoryEntry[] {
  if (!history) return [];
  return Object.freeze(history.list().slice());
}
