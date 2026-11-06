// FR-R5-F19 (spec 278, T19.2, FR-006; tasks T024) — the drill-down row's error line names a retained
// error as a previous failure unless the row itself is failed.
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import QueueTaskRow from '../QueueTaskRow.svelte';
import type { QueueItem } from '../../../lib/snapshot-types';

afterEach(() => cleanup());

const ERROR_TEXT = 'invocation-failed: the last phase reported remaining issues';

function task(status: QueueItem['status']): QueueItem {
  return {
    id: 'task-1',
    label: 'A task',
    enqueuedAt: '2026-05-10T11:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T11:09:00.000Z',
    completedAt: null,
    status,
    retryCount: 1,
    lastErrorSummary: ERROR_TEXT,
    pausedReason: null,
    currentPhase: null,
    queueId: 'default',
    position: 0,
    pauseCause: null,
    phaseProgress: null
  } as QueueItem;
}

function errorLine(status: QueueItem['status']): string {
  const view = render(QueueTaskRow, {
    props: {
      task: task(status),
      rowIndex: 0,
      pipeline: undefined,
      pipelineName: 'Pipe',
      progress: null,
      timing: { kind: 'elapsed', value: 60_000 },
      isSelected: false,
      onSelect: () => {},
      onKeyDown: () => {}
    }
  });
  const text = view.queryByTestId('queue-task-error-task-1')?.textContent ?? '';
  cleanup();
  return text.replace(/\s+/g, ' ').trim();
}

describe('the drill-down row error line', () => {
  it('shows a failed row exactly as before: the warning mark and the error', () => {
    expect(errorLine('failed')).toBe(`⚠ ${ERROR_TEXT}`);
  });

  it.each(['pending', 'in-flight', 'paused', 'completed', 'canceled'] as const)(
    'labels the retained error of a %s row "Previous failure" with no warning mark',
    (status) => {
      const line = errorLine(status);

      expect(line).toBe(`Previous failure: ${ERROR_TEXT}`);
      expect(line).not.toContain('⚠');
    }
  );
});
