# Command Palette reference

This is the manifest-parity index for every command Schegent contributes to the VS Code Command Palette. The full boundary contract—including accepted arguments, eight registered-only command IDs, all 61 webview messages, guards, and backend argv—is in [API and command reference](api-and-cli.md).

<!-- Source: package.json -->
<!-- Source: src/activation/ui-wiring.ts -->

| Command | Palette title | Operator result | Source |
|---|---|---|---|
| `schegent.auto` | Schegent: Run Autonomous Workflow | Collect a missing task description and start the autonomous workflow. | <!-- Source: package.json --><!-- Source: src/commands/auto.ts --> |
| `schegent.schedule` | Schegent: Enqueue Feature Request | Collect a Pipeline and request, then enqueue it for the selected/default time. | <!-- Source: package.json --><!-- Source: src/commands/schedule.ts --> |
| `schegent.resume` | Schegent: Resume Paused or Failed Workflow | Resume the sole paused or failed Run. | <!-- Source: package.json --><!-- Source: src/commands/resume.ts --> |
| `schegent.cancel` | Schegent: Cancel In-Flight Workflow | Cancel the addressed Task, or the sole running Run when no ID is supplied. | <!-- Source: package.json --><!-- Source: src/commands/cancel.ts --> |
| `schegent.reset` | Schegent: Reset Workspace State | Ask for confirmation and run the staged workspace reset. | <!-- Source: package.json --><!-- Source: src/commands/reset.ts --> |
| `schegent.showAuditLog` | Schegent: Show Audit Log | Open the workspace audit log. | <!-- Source: package.json --><!-- Source: src/commands/show-audit.ts --> |
| `schegent.exportAuditLog` | Schegent: Export Metadata-Only Audit | Save a schema-v3 metadata-only audit export. | <!-- Source: package.json --><!-- Source: src/commands/export-audit.ts --> |
| `schegent.pauseQueue` | Schegent: Pause Queue | Pause the default queue, optionally with a reason. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.resumeQueue` | Schegent: Resume Queue | Resume the default queue. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.retryQueuedItem` | Schegent: Retry Queued Item | Retry the addressed queued item. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.moveQueuedItemUp` | Schegent: Move Queued Item Up | Move the addressed pending item one position up. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.moveQueuedItemDown` | Schegent: Move Queued Item Down | Move the addressed pending item one position down. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.clearCompleted` | Schegent: Clear Completed Queue Items | Remove completed queue items. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.clearFailed` | Schegent: Clear Failed Queue Items | Remove failed queue items. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.rerunFromHistory` | Schegent: Rerun From History | Enqueue a new run from an eligible history entry. | <!-- Source: package.json --><!-- Source: src/commands/rerun-from-history.ts --> |
| `schegent.showActiveRun` | Schegent: Show Active Run | Reveal the Schegent Activity Bar and announce the selected Run. | <!-- Source: package.json --><!-- Source: src/commands/show-active-run.ts --> |
| `schegent.openDashboard` | Schegent: Open Dashboard | Open the singleton Dashboard for the current workspace. | <!-- Source: package.json --><!-- Source: src/commands/open-dashboard.ts --> |
| `schegent.retryActiveRun` | Schegent: Retry Active Run | Retry the best eligible active, queued, or historical Run. | <!-- Source: package.json --><!-- Source: src/commands/retry-active-run.ts --> |
| `schegent.redetectClaudeTransport` | Schegent: Re-detect Claude CLI prompt transport | Report that Claude prompt transport is fixed to stdin streaming. | <!-- Source: package.json --><!-- Source: src/activation/ui-wiring.ts --> |

The manifest contributes no command menus, keybindings, or `enablement` clauses. Activation and successful Stage 2 initialization still determine which registrations are available at runtime.

<!-- Source: package.json -->
<!-- Source: src/extension.ts -->
