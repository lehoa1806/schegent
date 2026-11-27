import { formatStatus, RUN_STATUS_FILTERS } from './format';
import type { QueueRowStatusChip } from './queue-row-status';
import type { WorkflowStatus } from './snapshot-types';

// A module of its own, not a few lines in `format.ts`, because of where `format.ts` ships: in the
// chunk the sidebar loads before it can draw, whose bytes SC-010 budgets
// (`tests/unit/ui/sidebar/bundle-size.test.ts`). Only the History page draws this chip, so only
// the History page's chunk should carry it.

/**
 * The colour class and mark a run's status chip carries in History. The same tone and mark a
 * queue row draws for the same state, so a run reads alike on both pages.
 */
const RUN_STATUS_CHIP_MARKS: Readonly<Record<WorkflowStatus, Omit<QueueRowStatusChip, 'label'>>> = {
  idle: { tone: 's-idle', icon: null },
  running: { tone: 's-run', icon: null },
  paused: { tone: 's-warn', icon: '#i-pause' },
  completed: { tone: 's-ok', icon: '#i-check' },
  failed: { tone: 's-err', icon: '#i-x' },
  canceled: { tone: 's-idle', icon: '#i-x' }
};

/**
 * The chip a run draws for its status: a capitalised word, never the raw status value. The words
 * are the outcome filter's, so a chip and the filter that matches it say the same thing; `idle`,
 * which the filter does not offer, takes its `formatStatus` word.
 */
export function runStatusChip(status: WorkflowStatus): QueueRowStatusChip {
  const filterLabel = RUN_STATUS_FILTERS.find((filter) => filter.value === status)?.label;
  return { ...RUN_STATUS_CHIP_MARKS[status], label: filterLabel ?? formatStatus(status) };
}
