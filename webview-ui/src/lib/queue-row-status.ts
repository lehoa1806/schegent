import type { QueueItemStatus } from './snapshot-types';

/**
 * The status chip a Queue Detail row draws: the `sg` status class that colours it, the mark drawn
 * before the words, and the words. The mark is the whole reference to a sprite icon, never one
 * built from parts, so the sprite test can check that each one exists; `null` draws a dot.
 *
 * The words are the product's own status labels rather than the mockup's ("Pending", not
 * "Waiting"), so a row and the run it opens name the same status the same way.
 */
export interface QueueRowStatusChip {
  readonly tone: 's-run' | 's-ok' | 's-err' | 's-warn' | 's-idle';
  readonly icon: '#i-pause' | '#i-check' | '#i-x' | null;
  readonly label: string;
}

const QUEUE_ROW_STATUS_CHIPS: Readonly<Record<QueueItemStatus, QueueRowStatusChip>> = {
  pending: { tone: 's-idle', icon: null, label: 'Pending' },
  'in-flight': { tone: 's-run', icon: null, label: 'Running' },
  paused: { tone: 's-warn', icon: '#i-pause', label: 'Paused' },
  completed: { tone: 's-ok', icon: '#i-check', label: 'Completed' },
  failed: { tone: 's-err', icon: '#i-x', label: 'Failed' },
  canceled: { tone: 's-idle', icon: '#i-x', label: 'Canceled' }
};

/** The chip for a Task's, or a connected run's, queue status. */
export function queueRowStatusChip(status: QueueItemStatus): QueueRowStatusChip {
  return QUEUE_ROW_STATUS_CHIPS[status];
}
