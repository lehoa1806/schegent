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

export function taskDeleteConfirmation(item: Pick<QueueItem, 'label' | 'status'>): DeleteConfirmationCopy {
  const label = truncateLabel(item.label);
  if (item.status === 'in-flight') {
    return {
      title: 'Delete active task',
      message: `This will stop the active task "${label}" and permanently delete its session data (logs, diagnostics) from disk. Continue?`,
      confirmLabel: 'Delete task'
    };
  }
  if (item.status === 'pending') {
    return {
      title: 'Delete pending task',
      message: `This will remove the pending task "${label}" from the queue. Continue?`,
      confirmLabel: 'Delete task'
    };
  }
  if (item.status === 'paused') {
    return {
      title: 'Delete paused task',
      message: `This will remove the paused task "${label}" and permanently delete its session data from disk. Continue?`,
      confirmLabel: 'Delete task'
    };
  }
  return {
    title: 'Delete task history',
    message: `This will permanently remove "${label}" and its session data (logs, diagnostics) from disk. Continue?`,
    confirmLabel: 'Delete task'
  };
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

function truncateLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;
}
