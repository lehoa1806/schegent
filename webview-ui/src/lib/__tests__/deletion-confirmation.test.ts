// Feature 034 T008 — taskDeleteConfirmation four-variant copy regression.
// See specs/034-task-deletion-cleanup/contracts/delete-confirmation-copy.md.
//
// Pins the exact copy strings returned by taskDeleteConfirmation for each
// of the four task-status branches. The pending branch is intentionally
// unchanged (FR-007 in spec.md). All four variants share the
// `confirmLabel === 'Delete task'` invariant.

import { describe, expect, it } from 'vitest';
import { taskDeleteConfirmation } from '../deletion-confirmation';

describe('Feature 034 T008 — taskDeleteConfirmation copy variants', () => {
  it('in-flight: stops and permanently deletes session data', () => {
    const copy = taskDeleteConfirmation({ status: 'in-flight', label: 'X' });
    expect(copy.title).toBe('Delete active task');
    expect(copy.message).toBe(
      'This will stop the active task "X" and permanently delete its session data (logs, diagnostics) from disk. Continue?'
    );
    expect(copy.confirmLabel).toBe('Delete task');
  });

  it('pending: UNCHANGED — no session-data warning', () => {
    const copy = taskDeleteConfirmation({ status: 'pending', label: 'X' });
    expect(copy.title).toBe('Delete pending task');
    expect(copy.message).toBe('This will remove the pending task "X" from the queue. Continue?');
    expect(copy.confirmLabel).toBe('Delete task');
  });

  it('paused: removes and permanently deletes session data', () => {
    const copy = taskDeleteConfirmation({ status: 'paused', label: 'X' });
    expect(copy.title).toBe('Delete paused task');
    expect(copy.message).toBe(
      'This will remove the paused task "X" and permanently delete its session data from disk. Continue?'
    );
    expect(copy.confirmLabel).toBe('Delete task');
  });

  it('completed (terminal): permanently removes and deletes session data', () => {
    const copy = taskDeleteConfirmation({ status: 'completed', label: 'X' });
    expect(copy.title).toBe('Delete task history');
    expect(copy.message).toBe(
      'This will permanently remove "X" and its session data (logs, diagnostics) from disk. Continue?'
    );
    expect(copy.confirmLabel).toBe('Delete task');
  });

  it('failed (terminal): same terminal copy as completed', () => {
    const copy = taskDeleteConfirmation({ status: 'failed', label: 'X' });
    expect(copy.title).toBe('Delete task history');
    expect(copy.message).toBe(
      'This will permanently remove "X" and its session data (logs, diagnostics) from disk. Continue?'
    );
    expect(copy.confirmLabel).toBe('Delete task');
  });

  it('canceled (terminal): same terminal copy as completed', () => {
    const copy = taskDeleteConfirmation({ status: 'canceled', label: 'X' });
    expect(copy.title).toBe('Delete task history');
    expect(copy.message).toBe(
      'This will permanently remove "X" and its session data (logs, diagnostics) from disk. Continue?'
    );
    expect(copy.confirmLabel).toBe('Delete task');
  });

  it('all four variants share confirmLabel "Delete task"', () => {
    const statuses: Array<'in-flight' | 'pending' | 'paused' | 'completed' | 'failed' | 'canceled'> = [
      'in-flight',
      'pending',
      'paused',
      'completed',
      'failed',
      'canceled'
    ];
    for (const status of statuses) {
      const copy = taskDeleteConfirmation({ status, label: 'L' });
      expect(copy.confirmLabel).toBe('Delete task');
    }
  });

  it('truncation: 60-char label is truncated to 45 chars + "..."', () => {
    const long = 'a'.repeat(60);
    const copy = taskDeleteConfirmation({ status: 'paused', label: long });
    const expected = 'a'.repeat(45) + '...';
    // The label appears once inside the message wrapped in double quotes.
    expect(copy.message).toContain(`"${expected}"`);
    // And NOT the full 60-char label.
    expect(copy.message).not.toContain('"' + long + '"');
  });
});
