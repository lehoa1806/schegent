import { describe, expect, it } from 'vitest';
import { QUEUE_ROW_VIEWS, queueRowVisible, type QueueRowView } from '../queue-row-filter';
import type { QueueItemStatus } from '../snapshot-types';

const STATUSES: readonly QueueItemStatus[] = ['pending', 'in-flight', 'paused', 'completed', 'failed', 'canceled'];

function shownUnder(view: QueueRowView): readonly QueueItemStatus[] {
  return STATUSES.filter((status) => queueRowVisible({ status, label: 'Add login', id: 'task-1' }, view, ''));
}

describe('queueRowVisible — the status views', () => {
  it('lists the views in the order the toolbar shows them', () => {
    expect(QUEUE_ROW_VIEWS.map((view) => view.label)).toEqual(['All', 'Active', 'Pending', 'Finished']);
  });

  it('shows every status under All', () => {
    expect(shownUnder('all')).toEqual(STATUSES);
  });

  it('shows the in-flight and paused rows under Active', () => {
    expect(shownUnder('active')).toEqual(['in-flight', 'paused']);
  });

  it('shows only the pending rows under Pending', () => {
    expect(shownUnder('pending')).toEqual(['pending']);
  });

  it('shows the completed, failed and canceled rows under Finished', () => {
    expect(shownUnder('finished')).toEqual(['completed', 'failed', 'canceled']);
  });
});

describe('queueRowVisible — the search', () => {
  const row = { status: 'pending', label: 'Add OAuth login', id: 'task-7f3a' } as const;

  it('matches every row while the search is empty or blank', () => {
    expect(queueRowVisible(row, 'all', '')).toBe(true);
    expect(queueRowVisible(row, 'all', '   ')).toBe(true);
  });

  it('matches the label, ignoring case and the spaces around the search', () => {
    expect(queueRowVisible(row, 'all', '  oauth ')).toBe(true);
    expect(queueRowVisible(row, 'all', 'logout')).toBe(false);
  });

  it('matches the id the row shows', () => {
    expect(queueRowVisible(row, 'all', '7F3A')).toBe(true);
  });

  it('applies the view and the search together', () => {
    expect(queueRowVisible(row, 'finished', 'oauth')).toBe(false);
    expect(queueRowVisible(row, 'pending', 'oauth')).toBe(true);
  });
});
