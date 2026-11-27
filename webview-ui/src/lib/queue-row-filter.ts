import type { QueueItemStatus } from './snapshot-types';

/**
 * The Queue Detail toolbar's status views. The filter only changes which rows are drawn: run order,
 * the row numbers and every reorder command stay those of the whole queue.
 */
export type QueueRowView = 'all' | 'active' | 'pending' | 'finished';

/** The views in the order the toolbar shows them. */
export const QUEUE_ROW_VIEWS: readonly { readonly id: QueueRowView; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'pending', label: 'Pending' },
  { id: 'finished', label: 'Finished' }
];

const VIEW_STATUSES: Readonly<Record<Exclude<QueueRowView, 'all'>, readonly QueueItemStatus[]>> = {
  active: ['in-flight', 'paused'],
  pending: ['pending'],
  finished: ['completed', 'failed', 'canceled']
};

/** What the filter reads from a row: a Task's, or a connected run's, status, name and id. */
export interface QueueRowFacts {
  readonly status: QueueItemStatus;
  readonly label: string;
  readonly id: string;
}

/**
 * Whether a row is drawn under `view` with `query` in the search box. The search ignores case and
 * the spaces around it, and matches the row's name or the id it shows; an empty search matches.
 */
export function queueRowVisible(row: QueueRowFacts, view: QueueRowView, query: string): boolean {
  if (view !== 'all' && !VIEW_STATUSES[view].includes(row.status)) return false;
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return row.label.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle);
}
