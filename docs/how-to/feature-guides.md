# Feature guides

These procedures use only commands and handlers present in the current host. Mutating operations require a trusted workspace and the primary Schegent window; a second window is refused by the filesystem-backed ownership gate. Schegent also needs an active Pipeline in its catalog before a new Task can run.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/config/pipeline-config.ts -->

## 1. Enqueue or schedule a Task

Use this when you have a published Pipeline and want to submit work without constructing a Workflow graph.

1. Open the VS Code Command Palette.
2. Run **Schegent: Enqueue Feature Request** (`schegent.schedule`).
3. Select a Pipeline if the command asks. With one available Pipeline and no configured default, the host selects that sole Pipeline; with several, it opens a picker and sorts the configured default first.
4. Enter a nonempty feature description if the command asks.
5. Wait for the `Schegent: enqueued …` notification, then open the dashboard with **Schegent: Open Dashboard** (`schegent.openDashboard`) to follow the Queue.

<!-- Source: package.json -->
<!-- Source: src/commands/schedule.ts -->
<!-- Source: src/commands/open-dashboard.ts -->

With no programmatic arguments, `schegent.schedule` uses the current time as `scheduledStartAt`; the host treats that as ready to start. Automation may invoke the same command with optional `description`, `pipelineId`, `queueId`, `position`, and numeric `scheduledStartAt` fields. A paused Queue, unknown Pipeline/Queue, invalid position, validation failure, or foreign primary lock produces a refusal rather than a partially inserted Task.

<!-- Source: src/commands/schedule.ts -->
<!-- Source: src/services/guarded-run-service.ts -->

If the Pipeline picker is empty, import and publish definitions first. A fresh Schegent install has no built-in Phase, Pipeline, or Workflow records.

<!-- Source: src/config/pipeline-config.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->

## 2. Reorder or retry Queue work

Use these controls only on a Task whose current state admits the requested mutation.

1. Open the dashboard or sidebar Queue view and select the Task.
2. Choose **Move up** or **Move down**. The webview posts `CMD_MOVE_QUEUE_ITEM_UP` or `CMD_MOVE_QUEUE_ITEM_DOWN` with `{ id: taskId }`; the contributed programmatic equivalents are `schegent.moveQueuedItemUp` and `schegent.moveQueuedItemDown`.
3. For a failed or paused Task, choose **Retry**; the webview posts `CMD_RETRY_QUEUE_ITEM` with `{ id }`. A canceled row exposes the distinct **Restart** action. The contributed `schegent.retryQueuedItem` command accepts failed, canceled, or paused rows when invoked with an ID.
4. If the host reports “Already at the edge,” “No other pending items,” “Queue item not found,” or “Action not allowed in current state,” refresh the Queue and use the action allowed by the current row state.

<!-- Source: package.json -->
<!-- Source: src/commands/queue-ops.ts -->
<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: webview-ui/src/lib/reorder-task.ts -->
<!-- Source: webview-ui/src/components/QueueItemActions.svelte -->

Move commands operate only on pending order; they do not move the in-flight Task. The command accepts either a nonempty ID string or an object with a nonempty `id`. All three mutations first verify current window primacy and fail closed when the ownership record cannot be proven.

<!-- Source: src/commands/queue-ops.ts -->
<!-- Source: src/state/lock.ts -->

To remove terminal clutter without changing pending work, run **Schegent: Clear Completed Queue Items** (`schegent.clearCompleted`) or **Schegent: Clear Failed Queue Items** (`schegent.clearFailed`). Each reports the number removed or states that no matching rows exist.

<!-- Source: package.json -->
<!-- Source: src/commands/queue-ops.ts -->

## 3. Pause and resume a Queue

Use a Queue pause to stop admission of the next pending Task. It does not terminate a backend subprocess already executing a Phase.

1. Use the selected Queue's **Pause** control; it posts `CMD_PAUSE_QUEUE` with that `queueId`. The Command Palette equivalent, **Schegent: Pause Queue** (`schegent.pauseQueue`), resolves the default Queue when no address is supplied.
2. Confirm that the Queue projects as manually paused. The authoritative persisted state is `queueLifecycle: operator-paused` with operator attribution.
3. When ready, use that Queue's **Resume** control, which posts `CMD_RESUME_QUEUE` with its `queueId`, or use the Command Palette equivalent for the default Queue.
4. The next drain sweep may promote the FIFO pending head after Queue occupancy, workspace capacity, and execution-lease checks pass.

<!-- Source: package.json -->
<!-- Source: src/commands/queue-ops.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-pause-queue.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-resume-queue.ts -->
<!-- Source: webview-ui/src/components/drilldown/QueueDetailTier.svelte -->
<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->

A Queue pause differs from a Run/Phase pause. The Queue lifecycle controls future promotion; a paused `WorkflowRun` retains its Queue slot, driving session, and execution lease until it is resumed or ended. Use **Schegent: Resume Paused or Failed Workflow** (`schegent.resume`) for that Run-level case.

<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/state/workflow-run.ts -->
<!-- Source: src/controller/run-session.ts -->
<!-- Source: package.json -->

## 4. Inspect or export audit evidence

Use the structured audit log for host-observed lifecycle evidence without opening raw, unredacted transcripts.

1. Run **Schegent: Show Audit Log** (`schegent.showAuditLog`) to open `.schegent/audit.log`. If the file does not exist yet, the command reports that there is no audit log.
2. To share a reduced artifact, run **Schegent: Export Metadata-Only Audit** (`schegent.exportAuditLog`).
3. Choose the destination for `schegent-audit-v3.jsonl` in the Save dialog.
4. Review the export before sharing it. The command includes identity/timing/event fields and only the allowlisted count/outcome payload keys from valid schema-v3 rows; malformed or other-schema lines are omitted.

<!-- Source: package.json -->
<!-- Source: src/commands/show-audit.ts -->
<!-- Source: src/commands/export-audit.ts -->
<!-- Source: src/contracts/audit-events.ts -->

The metadata-only export is not a backup of the original audit log and not a raw transcript. Raw transcripts and verbose diagnostics are intentionally unredacted and live under the separate session-artifact policy.

<!-- Source: src/commands/export-audit.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->

## 5. Rerun a terminal history item

Use History when you want a new Task based on a prior terminal Run.

1. Open the dashboard and locate the History row.
2. Choose **Rerun**. The webview posts `CMD_RERUN_FROM_HISTORY` with the exact `runId`; its host handler invokes `schegent.rerunFromHistory`. The optional `force` flag exists on the programmatic payload but is not added by the ordinary History-row click.
3. If the entry has its full retained description, the host replays that description and the original Pipeline ID as a new, immediate Task.
4. If the full description is unavailable, the safe default is refusal. Only an explicit `force: true` uses the truncated preview, and the runtime log records that divergence.
5. A successful request reports the new Queue item ID; follow that new Task rather than treating the historical row as live again.

<!-- Source: package.json -->
<!-- Source: src/commands/rerun-from-history.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-rerun-from-history.ts -->
<!-- Source: webview-ui/src/components/HistorySection.svelte -->
<!-- Source: src/state/history-entry.ts -->
<!-- Source: src/services/history/history-description-store.ts -->

Rerun also requires current window primacy. A missing history entry, paused Queue, validation failure, or foreign lock is reported without altering the original History row.

<!-- Source: src/commands/rerun-from-history.ts -->
<!-- Source: src/services/guarded-run-service.ts -->

For exact command arguments and every host/webview operation, see the [API and command reference](../reference/api-and-cli.md).
