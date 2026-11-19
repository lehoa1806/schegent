/**
 * FR-R3-198 & BUG-001 (T1883) — open backgrounded work tracking for one ACP invocation.
 *
 * `AcpOpenWorkTracker` tracks live `display` events emitted on an ACP `session/prompt`:
 *   - opens a live `tool-call` by `sourceEventId` and closes it on a matching live `tool-result`;
 *   - ignores `origin === 'history'` events and `sourceEventId === null` for the ID set;
 *   - bounds `openToolCalls` to `MAX_OPEN_TASKS` (`256`) and `MAX_TASK_ID_LENGTH` (`256`),
 *     latching `untracked = true` on overflow without storing dropped IDs;
 *   - latches `asyncWaitStarted = true` when a live `tool-call` names an async delegation/timer
 *     tool (`invoke_subagent`, `schedule`, `Run schedule`, `run_workflow`) or a live
 *     `tool-result` starts with `Tool is running as a background task with task id:`.
 */
import { describe, expect, it } from 'vitest';
import { AcpOpenWorkTracker } from '../../../src/runner/acp-open-work-tracker';
import { MAX_OPEN_TASKS, MAX_TASK_ID_LENGTH } from '../../../src/runner/background-task-tracker';
import type { AcpNormalizedEvent } from '../../../src/services/phase-log/acp-live-projection';

function liveToolCall(
  sourceEventId: string | null,
  toolName = 'read_file',
  toolArgs: unknown = {}
): AcpNormalizedEvent {
  return {
    connectionGeneration: 'gen-1',
    attemptId: 'att-1',
    sourceEventId,
    origin: 'live',
    kind: 'tool-call',
    toolName,
    toolArgs
  };
}

function liveToolResult(sourceEventId: string | null, text = 'completed'): AcpNormalizedEvent {
  return {
    connectionGeneration: 'gen-1',
    attemptId: 'att-1',
    sourceEventId,
    origin: 'live',
    kind: 'tool-result',
    text
  };
}

function trackerAfter(events: ReadonlyArray<AcpNormalizedEvent>): AcpOpenWorkTracker {
  const tracker = new AcpOpenWorkTracker();
  for (const event of events) {
    tracker.observe(event);
  }
  return tracker;
}

describe('AcpOpenWorkTracker FR-R3-198 / BUG-001 (T1883)', () => {
  it('AT1: starts with zero open tool calls, no untracked drop, no async wait, and hasOpenWork false', () => {
    const tracker = new AcpOpenWorkTracker();
    expect(tracker.openCount).toBe(0);
    expect(tracker.untracked).toBe(false);
    expect(tracker.asyncWaitStarted).toBe(false);
    expect(tracker.hasOpenWork).toBe(false);
  });

  it('AT2: opens a live tool-call by sourceEventId and closes it on matching live tool-result', () => {
    const opened = trackerAfter([liveToolCall('tc-1', 'run_command')]);
    expect(opened.openCount).toBe(1);
    expect(opened.hasOpenWork).toBe(true);

    const closed = trackerAfter([liveToolCall('tc-1', 'run_command'), liveToolResult('tc-1', 'exit 0')]);
    expect(closed.openCount).toBe(0);
    expect(closed.hasOpenWork).toBe(false);

    const partial = trackerAfter([
      liveToolCall('tc-1', 'read_file'),
      liveToolCall('tc-2', 'run_command'),
      liveToolResult('tc-1', 'ok')
    ]);
    expect(partial.openCount).toBe(1);
    expect(partial.hasOpenWork).toBe(true);
  });

  it('AT3: ignores history-origin observations, null sourceEventId on non-async tools, unknown/repeated tool-results, and non-tool events', () => {
    const historyEvents: AcpNormalizedEvent[] = [
      { ...liveToolCall('tc-hist-1', 'run_command'), origin: 'history' },
      { ...liveToolCall('tc-hist-2', 'invoke_subagent'), origin: 'history' },
      {
        ...liveToolResult(
          'tc-hist-3',
          'Tool is running as a background task with task id: task-99'
        ),
        origin: 'history'
      }
    ];
    const fromHistory = trackerAfter(historyEvents);
    expect(fromHistory.openCount).toBe(0);
    expect(fromHistory.untracked).toBe(false);
    expect(fromHistory.asyncWaitStarted).toBe(false);
    expect(fromHistory.hasOpenWork).toBe(false);

    const nullId = trackerAfter([
      liveToolCall(null, 'read_file'),
      liveToolResult(null, 'ok'),
      {
        connectionGeneration: 'gen-1',
        attemptId: 'att-1',
        sourceEventId: null,
        origin: 'live',
        kind: 'message',
        text: 'Invoke invoke_subagent or Tool is running as a background task with task id: fake'
      },
      {
        connectionGeneration: 'gen-1',
        attemptId: 'att-1',
        sourceEventId: null,
        origin: 'live',
        kind: 'status',
        text: 'thinking...'
      },
      {
        connectionGeneration: 'gen-1',
        attemptId: 'att-1',
        sourceEventId: null,
        origin: 'live',
        kind: 'plan',
        text: '[in_progress] step 1'
      }
    ]);
    expect(nullId.openCount).toBe(0);
    expect(nullId.hasOpenWork).toBe(false);

    const repeatedClose = trackerAfter([
      liveToolCall('tc-1'),
      liveToolCall('tc-2'),
      liveToolResult('tc-unknown'),
      liveToolResult('tc-1'),
      liveToolResult('tc-1')
    ]);
    expect(repeatedClose.openCount).toBe(1);
    expect(repeatedClose.hasOpenWork).toBe(true);
  });

  it('AT4: latches untracked past MAX_TASK_ID_LENGTH without storing the over-long id', () => {
    const exactId = 'c'.repeat(MAX_TASK_ID_LENGTH);
    const atBound = trackerAfter([liveToolCall(exactId)]);
    expect(atBound.openCount).toBe(1);
    expect(atBound.untracked).toBe(false);
    expect(atBound.hasOpenWork).toBe(true);

    const overLongId = 'c'.repeat(MAX_TASK_ID_LENGTH + 1);
    const overLong = trackerAfter([liveToolCall(overLongId), liveToolResult(overLongId)]);
    expect(overLong.openCount).toBe(0);
    expect(overLong.untracked).toBe(true);
    expect(overLong.hasOpenWork).toBe(true);
  });

  it('AT5: latches untracked past MAX_OPEN_TASKS and does not treat a repeated open id as a drop', () => {
    const maxIds = Array.from({ length: MAX_OPEN_TASKS }, (_, idx) => `tc-${idx}`);
    const full = trackerAfter(maxIds.map((id) => liveToolCall(id)));
    expect(full.openCount).toBe(MAX_OPEN_TASKS);
    expect(full.untracked).toBe(false);

    // Repeating an already-open id at the cap does not latch untracked.
    full.observe(liveToolCall('tc-0'));
    expect(full.untracked).toBe(false);
    expect(full.openCount).toBe(MAX_OPEN_TASKS);

    // Closing one frees a slot cleanly when untracked has not latched.
    full.observe(liveToolResult('tc-0'));
    expect(full.openCount).toBe(MAX_OPEN_TASKS - 1);
    full.observe(liveToolCall('tc-replacement'));
    expect(full.openCount).toBe(MAX_OPEN_TASKS);
    expect(full.untracked).toBe(false);

    // A 257th concurrent live tool-call latches untracked for the rest of the invocation.
    const overflowIds = Array.from({ length: MAX_OPEN_TASKS + 1 }, (_, idx) => `ov-${idx}`);
    const overflowed = trackerAfter([
      ...overflowIds.map((id) => liveToolCall(id)),
      ...overflowIds.map((id) => liveToolResult(id))
    ]);
    expect(overflowed.openCount).toBe(0);
    expect(overflowed.untracked).toBe(true);
    expect(overflowed.hasOpenWork).toBe(true);
  });

  it('AT6: latches asyncWaitStarted when a live tool-call names an async delegation or timer tool, even after its tool-result closes', () => {
    for (const asyncTool of ['invoke_subagent', 'schedule', 'Run schedule', 'run_workflow']) {
      const tracker = trackerAfter([
        liveToolCall('tc-async-1', asyncTool),
        liveToolResult('tc-async-1', '{"conversationId":"conv-1"}')
      ]);
      expect(tracker.openCount).toBe(0);
      expect(tracker.asyncWaitStarted).toBe(true);
      expect(tracker.hasOpenWork).toBe(true);

      const nullSourceIdTracker = trackerAfter([liveToolCall(null, asyncTool)]);
      expect(nullSourceIdTracker.openCount).toBe(0);
      expect(nullSourceIdTracker.asyncWaitStarted).toBe(true);
      expect(nullSourceIdTracker.hasOpenWork).toBe(true);
    }
  });

  it('AT7: latches asyncWaitStarted when a live tool-result starts with Antigravity background-task handoff prefix', () => {
    const tracker = trackerAfter([
      liveToolCall('tc-bg-1', 'run_command'),
      liveToolResult(
        'tc-bg-1',
        'Tool is running as a background task with task id: task-8\nWait for notification.'
      )
    ]);
    expect(tracker.openCount).toBe(0);
    expect(tracker.asyncWaitStarted).toBe(true);
    expect(tracker.hasOpenWork).toBe(true);
  });
});

