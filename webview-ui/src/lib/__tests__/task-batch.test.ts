import { describe, expect, it } from 'vitest';
import {
  TASK_DELIMITER,
  formatBatchHaltStatus,
  formatBatchTimeoutStatus,
  remainingAfter,
  splitTaskInstructions,
  submitButtonLabel
} from '../task-batch';

describe('task-batch — splitTaskInstructions (F36-T04, AC-06)', () => {
  it('returns an empty list for undefined, empty, or whitespace-only text', () => {
    expect(splitTaskInstructions(undefined)).toEqual([]);
    expect(splitTaskInstructions('')).toEqual([]);
    expect(splitTaskInstructions('   \n\t  \n  ')).toEqual([]);
  });

  it('returns a single trimmed segment when no delimiter line is present', () => {
    expect(splitTaskInstructions('  Audit the retry policy.\nCheck edge cases.  ')).toEqual([
      'Audit the retry policy.\nCheck edge cases.'
    ]);
  });

  it('splits multiple tasks on whole-line ---schegent-task--- delimiters with LF and CRLF', () => {
    const input = [
      'First task body',
      '---schegent-task---',
      'Second task body\nwith two lines',
      '  ---schegent-task---  ',
      'Third task body'
    ].join('\r\n');

    expect(splitTaskInstructions(input)).toEqual([
      'First task body',
      'Second task body\nwith two lines',
      'Third task body'
    ]);
  });

  it('drops leading, trailing, consecutive, and whitespace-only delimiter blocks', () => {
    const input = [
      '---schegent-task---',
      '   ',
      '---schegent-task---',
      'Only real task',
      '---schegent-task---',
      '---schegent-task---',
      '  \t  '
    ].join('\n');

    expect(splitTaskInstructions(input)).toEqual(['Only real task']);
    expect(splitTaskInstructions('---schegent-task---\n   \n---schegent-task---')).toEqual([]);
  });

  it('treats inline occurrences and case variants as ordinary prose rather than delimiters', () => {
    const input = [
      'Explain how ---schegent-task--- splits batches in the composer.',
      '---SCHEGENT-TASK---',
      'Prefix ---schegent-task---',
      '---schegent-task--- suffix',
      '---schegent-task---',
      'Second task'
    ].join('\n');

    expect(splitTaskInstructions(input)).toEqual([
      [
        'Explain how ---schegent-task--- splits batches in the composer.',
        '---SCHEGENT-TASK---',
        'Prefix ---schegent-task---',
        '---schegent-task--- suffix'
      ].join('\n'),
      'Second task'
    ]);
  });
});

describe('task-batch — remainingAfter & status helpers (F36-T04, AC-06)', () => {
  it('reconstructs the unsubmitted remainder from either a segment array or raw text', () => {
    const segments = ['Task 1', 'Task 2', 'Task 3'];
    expect(remainingAfter(segments, 0)).toBe(
      `Task 1\n\n${TASK_DELIMITER}\n\nTask 2\n\n${TASK_DELIMITER}\n\nTask 3`
    );
    expect(remainingAfter(segments, 1)).toBe(`Task 2\n\n${TASK_DELIMITER}\n\nTask 3`);
    expect(remainingAfter(segments, 2)).toBe('Task 3');
    expect(remainingAfter(segments, 3)).toBe('');

    const raw = `Task A\n${TASK_DELIMITER}\nTask B\n${TASK_DELIMITER}\nTask C`;
    expect(remainingAfter(raw, 1)).toBe(`Task B\n\n${TASK_DELIMITER}\n\nTask C`);
  });

  it('formats submit button labels and batch halt/timeout status lines', () => {
    expect(
      submitButtonLabel({ pending: false, queueId: 'default', segmentCount: 0 })
    ).toBe('Add task');
    expect(
      submitButtonLabel({ pending: false, queueId: undefined, segmentCount: 1 })
    ).toBe('Run Workflow');
    expect(
      submitButtonLabel({ pending: true, queueId: 'default', segmentCount: 1 })
    ).toBe('Submitting…');
    expect(
      submitButtonLabel({ pending: false, queueId: 'default', segmentCount: 3 })
    ).toBe('Add 3 tasks');
    expect(
      submitButtonLabel({ pending: true, queueId: 'default', segmentCount: 3 })
    ).toBe('Adding 3 tasks…');

    expect(formatBatchHaltStatus(1, 3, 'The queue refused this run.')).toBe(
      'Added 1 of 3 tasks. The queue refused this run.'
    );
    expect(formatBatchTimeoutStatus(1, 3, 'Outcome is not yet known.')).toBe(
      'Added 1 of 3 tasks; task 2 of 3 is awaiting host acknowledgement. Outcome is not yet known.'
    );
  });
});

