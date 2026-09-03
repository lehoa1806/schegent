import type { QueueItem } from './snapshot-types';

export type DeleteTargetKind = 'task' | 'phase';
export type DeleteConfirmationStatus =
  | QueueItem['status']
  | 'active'
  | 'future'
  | 'completed'
  | 'skipped'
  | 'disabled'
  | 'failed'
  | 'terminal'
  | 'stale';

export interface DeleteConfirmationCopy {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
}

export function phaseDeleteConfirmation(
  phaseId: string,
  status: DeleteConfirmationStatus
): DeleteConfirmationCopy {
  const label = truncateLabel(phaseId);
  if (status === 'active') {
    return {
      title: 'Delete active phase',
      message: `This will stop the active phase "${label}" and move to the next eligible phase. Continue?`,
      confirmLabel: 'Delete phase'
    };
  }
  if (status === 'future') {
    return {
      title: 'Delete future phase',
      message: `This will remove "${label}" from this task's remaining pipeline. Continue?`,
      confirmLabel: 'Delete phase'
    };
  }
  return {
    title: 'Delete phase',
    message: `This will remove "${label}" from this task's phase progression. Continue?`,
    confirmLabel: 'Delete phase'
  };
}

// Code-review fix (2026-09-03) — exported. `taskDeleteConfirmation` (FR-R3-153
// retired it in favor of `action-copy.ts`'s `renderActionBody`) was this
// helper's only caller until now; the removal dropped label truncation for
// the `queue.remove-item` confirmation entirely rather than carrying it over.
// `phaseDeleteConfirmation` above still needs the same 48-char/45-char rule,
// so this stays here and `action-copy.ts` imports it rather than restating it.
export function truncateLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;
}
