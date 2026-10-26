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

  function idsOf(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `t${index}`);
  }

  function snapshot(tracker: BackgroundTaskTracker): Record<string, boolean | number> {
    return {
      openCount: tracker.openCount,
      hasOpenWork: tracker.hasOpenWork,
      untracked: tracker.untracked
    };
  }

  // FR-R3-206 (T1890): a start dropped at a bound is remembered, holding no id.
  it('reports no open work and no dropped start for a new tracker (TT11)', () => {
    const tracker = new BackgroundTaskTracker();
    expect(tracker.hasOpenWork).toBe(false);
    expect(tracker.untracked).toBe(false);
  });

  it('remembers a start dropped for an over-long id, with nothing open (TT12)', () => {
    const tracker = trackerAfter([started('t'.repeat(MAX_TASK_ID_LENGTH + 1))]);
    expect(tracker.openCount).toBe(0);
    expect(tracker.hasOpenWork).toBe(true);
    expect(tracker.untracked).toBe(true);
    const atBound = trackerAfter([started('t'.repeat(MAX_TASK_ID_LENGTH))]);
    expect(atBound.hasOpenWork).toBe(true);
    expect(atBound.untracked).toBe(false);
  });

  it('keeps the memory of a start dropped at the open bound after every task closes (TT13)', () => {
    const ids = idsOf(MAX_OPEN_TASKS + 1);
    const dropped = trackerAfter([
      ...ids.map(started),
      ...ids.slice(0, MAX_OPEN_TASKS).map((id) => notified(id))
    ]);
    expect(dropped.openCount).toBe(0);
    expect(dropped.hasOpenWork).toBe(true);
    expect(dropped.untracked).toBe(true);
    const within = idsOf(MAX_OPEN_TASKS);
    const closed = trackerAfter([
      ...within.map(started),
      ...within.map((id) => notified(id))
    ]);
    expect(closed.openCount).toBe(0);
    expect(closed.hasOpenWork).toBe(false);
    expect(closed.untracked).toBe(false);
  });

  it('lets a notification for a dropped start change nothing (TT14)', () => {
    const overLongId = 't'.repeat(MAX_TASK_ID_LENGTH + 1);
    const overLong = trackerAfter([started(overLongId)]);
    const overLongBefore = snapshot(overLong);
    expect(overLongBefore.hasOpenWork).toBe(true);
    expect(overLongBefore.untracked).toBe(true);
    overLong.observe(notified(overLongId));
    expect(snapshot(overLong)).toEqual(overLongBefore);

    const pastBound = trackerAfter(idsOf(MAX_OPEN_TASKS + 1).map(started));
    const pastBoundBefore = snapshot(pastBound);
    expect(pastBoundBefore.hasOpenWork).toBe(true);
    expect(pastBoundBefore.untracked).toBe(true);
    pastBound.observe(notified(`t${MAX_OPEN_TASKS}`));
    expect(snapshot(pastBound)).toEqual(pastBoundBefore);
  });

  it('does not read a repeated start for a held id as a drop (TT15)', () => {
    const ids = idsOf(MAX_OPEN_TASKS);
    const tracker = trackerAfter(ids.map(started));
    tracker.observe(started('t0'));
    expect(tracker.untracked).toBe(false);
    expect(tracker.openCount).toBe(MAX_OPEN_TASKS);
    for (const id of ids) tracker.observe(notified(id));
    expect(tracker.hasOpenWork).toBe(false);
  });

  it('remembers nothing for a start that would open no task (TT16)', () => {
    const notBackgrounded = (taskId: string): string =>
      `{"type":"system","subtype":"task_started","is_backgrounded":false,"task_id":"${taskId}"}`;
    const numberId =
      '{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":7}';
    for (const line of [notBackgrounded('t'.repeat(MAX_TASK_ID_LENGTH + 1)), numberId]) {
      const tracker = trackerAfter([line]);
      expect(tracker.untracked).toBe(false);
      expect(tracker.hasOpenWork).toBe(false);
    }
    const ids = idsOf(MAX_OPEN_TASKS);
    const full = trackerAfter([...ids.map(started), notBackgrounded('late')]);
    expect(full.untracked).toBe(false);
    for (const id of ids) full.observe(notified(id));
    expect(full.hasOpenWork).toBe(false);
  });
});
