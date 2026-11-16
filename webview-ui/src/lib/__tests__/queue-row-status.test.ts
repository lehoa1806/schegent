import { describe, expect, it } from 'vitest';
import { queueRowStatusChip } from '../queue-row-status';
import type { QueueItemStatus } from '../snapshot-types';

// The chip a queue row draws for its status: the colour class, the mark beside the words, and the
// words. The words are the product's own status labels, so a row and the run it opens agree. The
// mark is a whole sprite reference, or null for the dot, so the sprite test can read every one.
describe('queueRowStatusChip', () => {
  const cases: readonly (readonly [QueueItemStatus, string, string | null, string])[] = [
    ['pending', 's-idle', null, 'Pending'],
    ['in-flight', 's-run', null, 'Running'],
    ['paused', 's-warn', '#i-pause', 'Paused'],
    ['completed', 's-ok', '#i-check', 'Completed'],
    ['failed', 's-err', '#i-x', 'Failed'],
    ['canceled', 's-idle', '#i-x', 'Canceled']
  ];

  it.each(cases)('reads %s as a %s chip with the mark %s and the word %s', (status, tone, icon, label) => {
    expect(queueRowStatusChip(status)).toEqual({ tone, icon, label });
  });
});
