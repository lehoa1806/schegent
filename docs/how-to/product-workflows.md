# Product workflows

These workflows use only operator surfaces that are registered by the extension host. Perform mutations in the VS Code window whose Schegent dashboard says **Workspace Connected**; other windows are intentionally read-only.
<!-- Source: src/activation/ui-wiring.ts -->
<!-- Source: webview-ui/src/dashboard/App.svelte -->

## 1. Add work, then choose when its queue starts

Use this path when you want enqueueing and execution to be separate decisions.

1. Open the dashboard, select **Queues**, then open the target queue card.
2. Select **Add work**.
3. Choose a published Pipeline, enter a description of at most 4,096 characters, and select **Add task**.
4. Wait for `Enqueued to <queue-name>`.
5. If the queue was empty, use the inline **Start the queue** chooser. Choose one of:

   - **Start now**.
   - **Start in HH:MM**, entering whole hours and minutes.
   - **Start at HH:MM**, entering the host's local 24-hour clock time.
   - **Close**, which changes nothing.

An enqueued task does not itself carry a start intent. On an otherwise empty active queue, the host leaves it `idle-pending` for this separate choice. A scheduled start must be no more than seven days away.
<!-- Source: webview-ui/src/components/drilldown/QueueDetailTier.svelte -->
<!-- Source: webview-ui/src/components/QueueInputForm.svelte -->
<!-- Source: webview-ui/src/components/drilldown/QueueIdlePendingPanel.svelte -->
<!-- Source: webview-ui/src/components/StartModeChooser.svelte -->
<!-- Source: src/commands/start-queue.ts -->

After scheduling, the queue shows its resolved local fire time. Use **Cancel** to remove the schedule while retaining the pending work, **Change** to replace it, or **Start now** to run immediately.
<!-- Source: webview-ui/src/components/ScheduledStartIndicator.svelte -->

## 2. Create and configure parallel queues

1. On **Queues**, select **New Queue**, enter a name, and select **Create**.
2. Use **Queue Settings** to set:

   - **Concurrent runs**: an integer from `1` through `20`.
   - **Default queue**: the queue that receives an otherwise unaddressed task.

3. Open a queue and select **Settings** to rename it.
4. For a pending task, use **Move to…** to transfer it to another queue, or the arrow/drag controls to change its order within the queue.

There may be at most 20 queues. A queue name is 1–64 characters after trimming and must be unique case-insensitively. Queue positions are contiguous, and pending work is processed in ascending position order.
<!-- Source: webview-ui/src/components/drilldown/QueuesTier.svelte -->
<!-- Source: webview-ui/src/components/QueueConfigModal.svelte -->
<!-- Source: webview-ui/src/components/drilldown/QueueDetailTier.svelte -->
<!-- Source: webview-ui/src/components/drilldown/QueueDetailRows.svelte -->
<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: src/queue/queue-manager.ts -->

To delete a queue, open it and select **Delete Queue**. The host first calculates the impact and the confirmation names its pending-task and connected-run counts. The default queue cannot be deleted, and no queue with an in-flight task can be deleted. To delete the current default, first make a different queue the default in **Queue Settings**.
<!-- Source: webview-ui/src/components/drilldown/QueueDetailTier.svelte -->
<!-- Source: webview-ui/src/lib/queue-control-ipc.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-delete-queue.ts -->
<!-- Source: src/queue/queue-manager.ts -->

The concurrency cap is workspace-wide while each individual queue still runs at most one task. Multiple runs share one working tree; increasing the cap does not create isolated checkouts.
<!-- Source: package.json -->
<!-- Source: src/services/auto-drain-coordinator.ts -->

## 3. Pause, resume, or restart a phase

1. On **Queues**, open the queue, then select its executing task.
2. In run detail, select the active phase.
3. Use **Pause** to request a pause at the active phase.
4. When paused, optionally enter a **Resume prompt**, then select **Resume**.
5. Use **Restart** when the active phase should be invoked again from its start.

The controls are enabled only in the primary window and only when the detail view describes the run actually executing on that queue. The host addresses lifecycle commands by queue so a control cannot silently operate on a sibling run.
<!-- Source: webview-ui/src/components/drilldown/RunDetailTier.svelte -->
<!-- Source: webview-ui/src/components/PhaseControlMenu.svelte -->
<!-- Source: webview-ui/src/lib/phase-control.ts -->
<!-- Source: src/controller/workflow-controller.ts -->

For a workspace with exactly one paused or failed run, the Command Palette action **Schegent: Resume Paused or Failed Workflow** is a shortcut. With several resumable runs it refuses and directs you to resume a specific run from the UI; it never guesses a target.
<!-- Source: package.json -->
<!-- Source: src/commands/resume.ts -->
<!-- Source: src/controller/sole-run-resolver.ts -->

## 4. Repeat a historical run with current definitions

1. Open **History**.
2. Locate a terminal run and select **Rerun**, or open its detail and select **Run again**.
3. Read the **Repeat this run** notices before editing the form. The panel explicitly reports:

   - when the Active Pipeline version differs from the version frozen by the old run;
   - when the old run was a Workflow member and only that Pipeline will be repeated;
   - whether the same queue will be used or the deleted queue was replaced by the default.

4. Review the pre-filled **Instructions**, provide any required Pipeline inputs and outputs, then select **Run Pipeline**.

The repeat form uses the recorded description preview and has no prior input-port values to restore. Only that preview is pre-filled; if it was truncated, the panel reports the retained and original character counts. A repeat always passes through the current launch form and host validation, and it resolves the currently Active definition rather than resurrecting an inactive catalog body.
<!-- Source: webview-ui/src/components/HistoryDashboard.svelte -->
<!-- Source: webview-ui/src/components/HistorySection.svelte -->
<!-- Source: webview-ui/src/components/HistoryRunDetail.svelte -->
<!-- Source: webview-ui/src/components/HistoryRerunPanel.svelte -->
<!-- Source: webview-ui/src/lib/history-rerun.ts -->
<!-- Source: webview-ui/src/components/RunLauncher/RunLauncher.svelte -->

## 5. Inspect or export audit evidence

Use **Schegent: Show Audit Log** in the Command Palette to open `.schegent/audit.log` as a preview editor. If the file does not exist, Schegent reports `Schegent: no audit log yet.`
<!-- Source: package.json -->
<!-- Source: src/commands/show-audit.ts -->

Use **Schegent: Export Metadata-Only Audit** when the recipient should not receive full payload text:

1. Run the command from the Command Palette.
2. Accept or replace the default filename `schegent-audit-v3.jsonl` in the workspace root.
3. Save the JSON Lines file.

The export includes only parseable schema-v3 entries. It retains the entry identity, timestamp, event type, phase, iteration, outcome, and schema version, plus only these payload keys when present: `exitCode`, `fileChangeCounts`, `metrics`, `omittedFileEvidenceCount`, `omittedToolEvidenceCount`, `outcome`, `terminationReason`, and `toolCategoryCounts`. It is a filtered export; the original audit log is unchanged.
<!-- Source: package.json -->
<!-- Source: src/commands/export-audit.ts -->
<!-- Source: src/parser/audit-log-parser.ts -->
