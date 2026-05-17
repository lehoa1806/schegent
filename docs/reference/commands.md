# Commands Reference

Every command Schegent contributes to the VS Code command palette. Every command id is also callable from a keyboard binding (`keybindings.json`) or another extension's `vscode.commands.executeCommand` call.

You can also invoke any of these via the command palette: `Cmd/Ctrl + Shift + P`, then type the command title.

## Quick index

| Command id | Palette title |
|---|---|
| `schegent.auto` | Schegent: Run Autonomous Workflow |
| `schegent.schedule` | Schegent: Enqueue Feature Request |
| `schegent.resume` | Schegent: Resume Paused or Failed Workflow |
| `schegent.cancel` | Schegent: Cancel In-Flight Workflow |
| `schegent.reset` | Schegent: Reset Workspace State |
| `schegent.showAuditLog` | Schegent: Show Audit Log |
| `schegent.pauseQueue` | Schegent: Pause Queue |
| `schegent.resumeQueue` | Schegent: Resume Queue |
| `schegent.retryQueuedItem` | Schegent: Retry Queued Item |
| `schegent.moveQueuedItemUp` | Schegent: Move Queued Item Up |
| `schegent.moveQueuedItemDown` | Schegent: Move Queued Item Down |
| `schegent.clearCompleted` | Schegent: Clear Completed Queue Items |
| `schegent.clearFailed` | Schegent: Clear Failed Queue Items |
| `schegent.rerunFromHistory` | Schegent: Rerun From History |
| `schegent.showActiveRun` | Schegent: Show Active Run |
| `schegent.openDashboard` | Schegent: Open Dashboard |
| `schegent.retryActiveRun` | Schegent: Retry Active Run |
| `schegent.redetectClaudeTransport` | Schegent: Re-detect Claude CLI prompt transport |

## Lifecycle commands

### `schegent.auto`

**Title:** Schegent: Run Autonomous Workflow

Starts the autonomous workflow. Opens the enqueue dialog if there is no in-flight task, then surrenders control to the drainer until the run terminates. Functionally equivalent to **Enqueue Feature** + auto-drain.

### `schegent.schedule`

**Title:** Schegent: Enqueue Feature Request

Opens the enqueue dialog. Required input is a one- or two-sentence description; optional inputs are a pipeline id and per-phase overrides. The task lands at the bottom of the **Pending** list.

The dialog is the same as the sidebar's **Enqueue Feature** button.

### `schegent.resume`

**Title:** Schegent: Resume Paused or Failed Workflow

Resumes a paused or failed in-flight run. The next phase invocation runs with the `--continue` flag so Claude resumes its prior context.

If no task is paused or failed, the command is a no-op.

### `schegent.cancel`

**Title:** Schegent: Cancel In-Flight Workflow

Cancels the in-flight run. Kills the active subprocess, transitions the task to `failed` (with cause `canceled`), and releases the workspace lock.

The audit log records a `cancel` lifecycle event and a `task-canceled` queue-control event.

### `schegent.retryActiveRun`

**Title:** Schegent: Retry Active Run

Manually triggers a retry of the in-flight phase. Bypasses any scheduled delayed-retry timer. Emits a `retry-manual` audit event. The next invocation runs with `--continue` for context preservation.

### `schegent.reset`

**Title:** Schegent: Reset Workspace State

**Destructive.** Clears the queue, all `WorkflowRun` records, all pause and breakpoint state, and any pending-retry schedule. Re-runs the v2 → v6 migration sequence against the cleared state.

Does **not** delete `.schegent/audit.log`, the raw transcripts, or the diagnostic files. Use as a last resort after a hard crash or to start fresh.

## Queue management

### `schegent.pauseQueue`

**Title:** Schegent: Pause Queue

Pauses the queue. No new tasks drain off the pending list. The in-flight task continues; its terminal transition will not be followed by the next pending task starting.

Emits `queue-paused` with `pauseSource: 'operator'`.

### `schegent.resumeQueue`

**Title:** Schegent: Resume Queue

Resumes a paused queue. If a task became eligible while paused, the drainer picks it up.

Emits `queue-resumed`.

### `schegent.retryQueuedItem`

**Title:** Schegent: Retry Queued Item

Re-enqueues a failed history task at the bottom of pending. Equivalent to right-clicking a failed row and choosing **Rerun**.

### `schegent.moveQueuedItemUp`

**Title:** Schegent: Move Queued Item Up

Moves the selected pending task one position toward the top. The currently-selected sidebar row is the target.

Emits `task-reordered` with `source: 'arrow'`.

### `schegent.moveQueuedItemDown`

**Title:** Schegent: Move Queued Item Down

Moves the selected pending task one position toward the bottom. Mirror of `moveQueuedItemUp`.

### `schegent.clearCompleted`

**Title:** Schegent: Clear Completed Queue Items

Removes all tasks in the `completed` history bucket from the queue. The audit log records a `task-removed` event for each. The per-run session trees are *not* removed by this bulk command — use individual task removal for the session-tree cleanup dialog.

### `schegent.clearFailed`

**Title:** Schegent: Clear Failed Queue Items

Removes all tasks in the `failed` history bucket. Mirror of `clearCompleted`.

### `schegent.rerunFromHistory`

**Title:** Schegent: Rerun From History

Re-enqueues a terminal task (completed or failed) with the same description and the same per-phase overrides. The audit log records a `task-enqueued` event with `via: 'rerun-from-history'`.

## Inspection and navigation

### `schegent.showAuditLog`

**Title:** Schegent: Show Audit Log

Opens `<workspaceRoot>/.schegent/audit.log` in a VS Code editor tab. Read-only friendly: the file is append-only JSONL and rotates on size/age.

### `schegent.showActiveRun`

**Title:** Schegent: Show Active Run

Scrolls to and selects the in-flight task in the sidebar. Useful when the history is long and you have lost the scroll position.

### `schegent.openDashboard`

**Title:** Schegent: Open Dashboard

Opens the full-window Schegent dashboard in a new editor tab. The dashboard is a roomier view over the same state model that drives the sidebar.

## Maintenance and diagnostics

### `schegent.redetectClaudeTransport`

**Title:** Schegent: Re-detect Claude CLI prompt transport

Re-probes how the Claude CLI accepts the prompt (argv, file, or stdin) for your installed binary. Useful after upgrading the CLI: if the transport changed, the host will pick the new path without a reload.

## Mutating vs. read-only commands

A subset of commands are gated to the **primary host** when multiple VS Code windows are open against the same workspace. Calls from a secondary host are rejected with `reason: 'not-primary-host'`.

The mutating set (subject to the primary-host gate) includes every command that writes workspace state or workspace settings:

- `schegent.auto`, `schegent.schedule`, `schegent.resume`, `schegent.cancel`, `schegent.retryActiveRun`, `schegent.reset`
- `schegent.pauseQueue`, `schegent.resumeQueue`, `schegent.retryQueuedItem`, `schegent.moveQueuedItemUp`, `schegent.moveQueuedItemDown`
- `schegent.clearCompleted`, `schegent.clearFailed`, `schegent.rerunFromHistory`
- (Internal IPC commands behind the sidebar settings panel — e.g., save phases, save general settings, save wake-up settings, set/clear breakpoint — are also gated.)

The read-only commands (`showAuditLog`, `showActiveRun`, `openDashboard`, `redetectClaudeTransport`) work in every window.

## Keyboard bindings

Schegent ships no default key bindings — every command must be bound by you if you want one. To bind:

1. `Cmd/Ctrl + K, Cmd/Ctrl + S` to open the keyboard shortcuts editor.
2. Search for `schegent`.
3. Click the pencil for any row to assign a chord.

Or edit `keybindings.json` directly:

```jsonc
[
  { "key": "cmd+shift+e",  "command": "schegent.schedule" },
  { "key": "cmd+shift+p",  "command": "schegent.pauseQueue" },
  { "key": "cmd+alt+r",    "command": "schegent.resume" }
]
```

## Programmatic invocation

From another extension or a VS Code task, invoke any command id via `vscode.commands.executeCommand(...)`:

```ts
await vscode.commands.executeCommand('schegent.showAuditLog');
```

Mutating commands respect the primary-host gate regardless of the caller.

The next reference page is [Audit Events](audit-events.md).
