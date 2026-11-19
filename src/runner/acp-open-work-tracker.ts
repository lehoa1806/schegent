/**
 * FR-R3-198 & BUG-001 (FR-005a) — open backgrounded work tracking for one ACP invocation.
 *
 * Over ACP (`agy acp --stdio` and sibling ACP profiles), ending a conversational turn after
 * launching async work (`run_command` exceeding `WaitMsBeforeAsync`, `schedule` / `Run schedule`
 * timers, `invoke_subagent`, or `run_workflow`) settles the `session/prompt` JSON-RPC request
 * immediately (`stopReason: 'end_turn'`). `AcpBackedRunner` observes live `display` events during
 * the prompt with one `AcpOpenWorkTracker` per invocation so `backgroundWorkOpenAtResult` reports
 * whether backgrounded or delegated work remained open when the prompt settled.
 *
 * History-origin replay (`origin !== 'live'`) changes nothing. Bounds match `BackgroundTaskTracker`
 * (`MAX_OPEN_TASKS = 256`, `MAX_TASK_ID_LENGTH = 256`); overflow latches `untracked = true` without
 * holding dropped IDs. Zero `vscode`, `child_process`, or audit imports, and zero IDs logged.
 */
import type { AcpNormalizedEvent } from '../services/phase-log/acp-live-projection';
import { MAX_OPEN_TASKS, MAX_TASK_ID_LENGTH } from './background-task-tracker';

/**
 * Tools whose contract requires the model to end its current ACP prompt turn and wait for an
 * asynchronous wakeup or timer notification, even when the tool call's own synchronous launch
 * `tool-result` (`conversationId` / schedule handle) has already closed.
 */
const ASYNC_DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  'invoke_subagent',
  'schedule',
  'Run schedule',
  'run_workflow'
]);

/**
 * Antigravity harness prefix emitted in a synchronous `tool-result` when `run_command` exceeds
 * `WaitMsBeforeAsync` and continues running in the background.
 */
const BACKGROUND_TASK_HANDOFF_PREFIX = 'Tool is running as a background task with task id:';

export class AcpOpenWorkTracker {
  private readonly open = new Set<string>();
  private dropped = false;
  private asyncWait = false;

  public get openCount(): number {
    return this.open.size;
  }

  /** True when a live tool-call ID exceeded `MAX_TASK_ID_LENGTH` or `MAX_OPEN_TASKS`. */
  public get untracked(): boolean {
    return this.dropped;
  }

  /** True when a live async delegation/timer tool or background-task handoff was observed. */
  public get asyncWaitStarted(): boolean {
    return this.asyncWait;
  }

  /** True when unclosed live tool calls, a dropped bound overflow, or an async wait is active. */
  public get hasOpenWork(): boolean {
    return this.open.size > 0 || this.dropped || this.asyncWait;
  }

  public observe(event: AcpNormalizedEvent): void {
    if (event.origin !== 'live') return;

    if (event.kind === 'tool-call') {
      if (event.toolName !== undefined && ASYNC_DELEGATION_TOOLS.has(event.toolName)) {
        this.asyncWait = true;
      }
      const id = event.sourceEventId;
      if (id === null) return;
      if (this.open.has(id)) return;
      if (id.length > MAX_TASK_ID_LENGTH || this.open.size >= MAX_OPEN_TASKS) {
        this.dropped = true;
        return;
      }
      this.open.add(id);
      return;
    }

    if (event.kind === 'tool-result') {
      if (event.text !== undefined && event.text.startsWith(BACKGROUND_TASK_HANDOFF_PREFIX)) {
        this.asyncWait = true;
      }
      if (event.sourceEventId !== null) {
        this.open.delete(event.sourceEventId);
      }
    }
  }
}

