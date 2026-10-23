/**
 * FR-R3-198 — which backgrounded tasks are open in one claude invocation.
 *
 * In print mode the CLI keeps the process alive past a turn's `result` while a
 * command that turn started in the background still runs, and wakes the model
 * with a new turn when the command finishes. `ClaudeCliRunner` holds its settle
 * window while such a task is open; this is what it asks.
 *
 * A task opens on its `system/task_started` line when `is_backgrounded` is
 * `true`, and closes on its `system/task_notification`, whatever the status.
 * The CLI can write one task's notification twice, so closing a closed or
 * unknown id changes nothing. Only parsed structural fields are read, on
 * records the CLI harness writes around the model's content, which model text
 * cannot produce (threat model T25). Nothing is logged, task ids included.
 */

/**
 * How long a hold may last after the result that began it. It is the default
 * of the CLI's own `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, at which the CLI
 * stops the tasks itself, so this backstops a CLI that does not.
 */
export const BACKGROUND_HOLD_CEILING_MS = 600_000;

/** The `system` subtypes the CLI writes about its tasks. None starts a turn. */
const BOOKKEEPING_SUBTYPES: ReadonlySet<string> = new Set([
  'task_notification',
  'task_updated',
  'background_tasks_changed'
]);

/**
 * Whether a parsed stream-json record is the CLI's bookkeeping about its
 * background tasks, rather than activity of the turn.
 */
export function isBackgroundBookkeepingEvent(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (!('type' in parsed) || !('subtype' in parsed)) return false;
  return parsed.type === 'system' &&
    typeof parsed.subtype === 'string' &&
    BOOKKEEPING_SUBTYPES.has(parsed.subtype);
}

export class BackgroundTaskTracker {
  private readonly open = new Set<string>();

  public get openCount(): number {
    return this.open.size;
  }

  /** Reads one framed stdout line. Anything but a task's start or close changes nothing. */
  public observe(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    if (!('type' in parsed) || parsed.type !== 'system') return;
    if (!('subtype' in parsed) || !('task_id' in parsed)) return;
    const taskId = parsed.task_id;
    if (typeof taskId !== 'string') return;

    if (parsed.subtype === 'task_notification') {
      this.open.delete(taskId);
      return;
    }
    const backgrounded = 'is_backgrounded' in parsed && parsed.is_backgrounded === true;
    if (parsed.subtype === 'task_started' && backgrounded) this.open.add(taskId);
  }
}
