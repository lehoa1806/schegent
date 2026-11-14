import { describe, expect, it } from 'vitest';
import { runStatusChip } from '../run-status-chip';
import type { WorkflowStatus } from '../snapshot-types';

// The chip a run draws for its status in History: the colour class, the mark beside the words, and
// the words. A queue row and a History row draw the same chip for the same state, so the two agree
// on tone and mark; the words are the run vocabulary's short labels, capitalised, never the raw
// status value. The mark is a whole sprite reference, or null for the dot.
describe('runStatusChip', () => {
  const cases: readonly (readonly [WorkflowStatus, string, string | null, string])[] = [
    ['idle', 's-idle', null, 'Idle'],
    ['running', 's-run', null, 'Running'],
    ['paused', 's-warn', '#i-pause', 'Paused'],
    ['completed', 's-ok', '#i-check', 'Completed'],
    ['failed', 's-err', '#i-x', 'Failed'],
    ['canceled', 's-idle', '#i-x', 'Canceled']
  ];

  it.each(cases)('reads %s as a %s chip with the mark %s and the word %s', (status, tone, icon, label) => {
    expect(runStatusChip(status)).toEqual({ tone, icon, label });
  });
});
