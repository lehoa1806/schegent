// FR-R3-198 (T1876) — which backgrounded tasks are open in one claude
// invocation.
//
// A task opens on its `system/task_started` line when `is_backgrounded` is
// `true`, and closes on its `system/task_notification`, whatever the
// notification's `status` says. Nothing else opens or closes one, and a line
// that does not parse changes nothing (contract H1, H2). The three subtypes the
// CLI writes about those tasks are bookkeeping rather than activity of the
// turn, so the runner must not read them as a new turn starting (H3).

import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_HOLD_CEILING_MS,
  BackgroundTaskTracker,
  MAX_OPEN_TASKS,
  MAX_TASK_ID_LENGTH,
  isBackgroundBookkeepingEvent
} from '../../../src/runner/background-task-tracker';

const STARTED_T1 =
  '{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":"t1"}';
const STARTED_T2 =
  '{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":"t2"}';

function started(taskId: string): string {
  return `{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":"${taskId}"}`;
}

function notified(taskId: string, status = 'completed'): string {
  return `{"type":"system","subtype":"task_notification","task_id":"${taskId}","status":"${status}"}`;
}

function trackerAfter(lines: ReadonlyArray<string>): BackgroundTaskTracker {
  const tracker = new BackgroundTaskTracker();
  for (const line of lines) tracker.observe(line);
  return tracker;
}

describe('BackgroundTaskTracker FR-R3-198 (T1876)', () => {
  it('opens a task on a backgrounded task_started line (TT1)', () => {
    expect(trackerAfter([STARTED_T1]).openCount).toBe(1);
  });

  it('opens nothing unless the start is backgrounded and carries a string id (TT2)', () => {
    const notOpening = [
      '{"type":"system","subtype":"task_started","is_backgrounded":false,"task_id":"t1"}',
      '{"type":"system","subtype":"task_started","task_id":"t1"}',
      '{"type":"system","subtype":"task_started","is_backgrounded":true}',
      '{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":1}'
    ];
    for (const line of notOpening) {
      expect(trackerAfter([line]).openCount).toBe(0);
    }
  });

  it('closes a task on its notification, whatever the status (TT3)', () => {
    for (const status of ['completed', 'stopped', 'failed']) {
      expect(trackerAfter([STARTED_T1, notified('t1', status)]).openCount).toBe(0);
    }
  });

  it('ignores a notification for an unknown id and a repeated one for a closed id (TT4)', () => {
    expect(trackerAfter([STARTED_T1, notified('t9')]).openCount).toBe(1);
    // The CLI can write one task's notification twice (research R2). The
    // repeat must not close some other task.
    expect(
      trackerAfter([STARTED_T1, STARTED_T2, notified('t1'), notified('t1')]).openCount
    ).toBe(1);
  });

  it('leaves the other task open when one of two closes (TT5)', () => {
    expect(trackerAfter([STARTED_T1, STARTED_T2, notified('t1')]).openCount).toBe(1);
  });

  it('changes nothing on a truncated, non-JSON or unrelated line (TT6)', () => {
    const inert = [
      '{"type":"system","subtype":"task_started","is_backgr',
      'not json',
      'null',
      '{"type":"assistant"}'
    ];
    expect(trackerAfter(inert).openCount).toBe(0);
    expect(trackerAfter([STARTED_T1, ...inert]).openCount).toBe(1);
  });

  it('names the three bookkeeping subtypes and nothing else (TT7)', () => {
    const parse = (line: string): unknown => JSON.parse(line);
    const bookkeeping = [
      notified('t1'),
      '{"type":"system","subtype":"task_updated","task_id":"t1"}',
      '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'
    ];
    for (const line of bookkeeping) {
      expect(isBackgroundBookkeepingEvent(parse(line))).toBe(true);
    }
    const activity = [
      '{"type":"system","subtype":"init"}',
      STARTED_T1,
      // The subtype alone is not enough: the CLI writes these as `system` lines.
      '{"type":"assistant","subtype":"task_updated"}'
    ];
    for (const line of activity) {
      expect(isBackgroundBookkeepingEvent(parse(line))).toBe(false);
    }
  });

  it('holds for the CLI default background wait ceiling (TT8)', () => {
    expect(BACKGROUND_HOLD_CEILING_MS).toBe(600_000);
  });

  // The feature-228 security review, S2: a stream that is not the CLI's own
  // could open tasks without end, each id up to a line's 1 MiB.
  it('opens no task whose id is longer than the bound (TT9)', () => {
    expect(trackerAfter([started('t'.repeat(MAX_TASK_ID_LENGTH))]).openCount).toBe(1);
    expect(trackerAfter([started('t'.repeat(MAX_TASK_ID_LENGTH + 1))]).openCount).toBe(0);
  });

  it('keeps at most the bound open, and a close frees a place (TT10)', () => {
    const ids = Array.from({ length: MAX_OPEN_TASKS + 1 }, (_, index) => `t${index}`);
    const tracker = trackerAfter(ids.map(started));
    expect(tracker.openCount).toBe(MAX_OPEN_TASKS);
    tracker.observe(notified('t0'));
    expect(tracker.openCount).toBe(MAX_OPEN_TASKS - 1);
    tracker.observe(started('late'));
    expect(tracker.openCount).toBe(MAX_OPEN_TASKS);
  });
});
