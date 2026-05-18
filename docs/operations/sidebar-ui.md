# Schegent Sidebar UI/UX Guide

The Schegent Sidebar (accessed via the Activity Bar icon) provides an at-a-glance, high-density view of the active workflow's status. It is designed to be highly scannable, letting you keep an eye on autonomous progress without breaking your coding flow.

## Visual Anatomy

```text
+-------------------------------------------------------------+
| SCHEGENT                                                  ↕ |
+-------------------------------------------------------------+
|                                                             |
|  [Status Row]                                               |
|  ● 005-stabilization-refactor                       12:45   |
|                                                             |
|  [Stats Strip]                                              |
|  implement · 3/7 tasks                                      |
|  ✔ 2   |   ◎ 4   |   ✖ 1                                    |
|                                                             |
|  [Current Task View]                                        |
|  ● live                                                     |
|  Executing tests for workflow controller                    |
|  running · stdout 2s                                        |
|                                                             |
|                                                             |
|                                                             |
|                                                             |
+-------------------------------------------------------------+
| [ Open Dashboard ]                                          |
+-------------------------------------------------------------+
```

## Section Breakdown & Responsibilities

### 1. Status Row
**Purpose:** Provides immediate awareness of the overall state of the pipeline and the current feature being worked on.
- **Workflow Status Dot:** A visual indicator of the overall run state. Green for `in-flight`, orange for `paused` (e.g., rate limits or stalls), red for `failed`, and gray for `idle`.
- **Active Feature Label:** The name of the feature currently being processed (e.g., `005-stabilization-refactor`).
- **Elapsed Pill:** Displays the elapsed time (`mm:ss` or `hh:mm:ss`) since the current feature started.
- **Secondary Badge (Optional):** Appears if the run is active in a different workspace or window, indicating the lock is held elsewhere.

### 2. Stats Strip
**Purpose:** Summarizes the current phase and aggregates the progress of discrete sub-tasks, giving a sense of completion.
- **Active-Phase Line:** Explicitly states the phase of the pipeline currently running (e.g., `implement`, `plan`, `tasks`) and the overall progression if applicable (`3/7 tasks`).
- **Progress Counters:** A horizontal metric row showing:
  - `✔ Done` - Tasks completed successfully.
  - `◎ Pending` - Tasks waiting to be executed or currently in progress.
  - `✖ Failed` - Tasks that encountered an error.

### 3. Current Task View
**Purpose:** Offers granular, real-time insight into the exact operation the Claude CLI is currently executing.
- **Freshness Dot & Label:** Indicates the health of the current CLI invocation (`live`, `slowing — 12s`, `stalled — 45s`, `paused`, `idle`). This helps identify when a process might be hanging.
- **Activity Summary:** A single-line human-readable summary of the current action (e.g., "Executing tests for workflow controller").
- **CLI Monitor Row (Optional):** Displays low-level runner metrics (e.g., `running · stdout 2s`), indicating how long it has been since the CLI last emitted output to stdout.
- **Process Telemetry Row (Optional, feature 033):** A compact summary of the Claude CLI subprocess's live resource usage, sampled every 2 seconds — `PID 12345 · 38% CPU · 412 MB · 02:14`. Renders only while a subprocess is active; clears one publish after the runner reports `exited`. When the host OS query fails (PID gone, transient `ps`/PowerShell error, etc.) the row degrades to `PID 12345 · telemetry unavailable` and the sampler emits a single WARN per (pid, errorClass) — subsequent failures of the same class are deduplicated. Telemetry is ephemeral: it is never persisted, never written to the audit log, and only the PID integer (already in the existing `phase-end` / `monitor-invocation-summary` audit events) survives a subprocess exit.

### 4. Open Dashboard Button
**Purpose:** The single canonical path to access detailed controls and full history.
- **Action:** Clicking this button opens the full Dashboard Webview, where you can manage the queue, review the full audit log, and perform manual interventions (resume, retry, cancel).
- **No-workspace behavior:** When VS Code is showing the welcome view (no folder or workspace open), clicking **Open Dashboard** surfaces a benign native warning toast (`Please open a workspace to use the Schegent Dashboard.`) instead of silently no-op'ing. The button stays visible and enabled; opening a folder and re-clicking proceeds to the Dashboard normally. The Command Palette entry behaves identically. Rapid repeated clicks while the toast is still on screen show at most one toast.
- **UX Responsibility:** By keeping complex controls off the sidebar, the sidebar remains purely informational and uncluttered.

---

**Related Documentation:**
- [Dashboard UI/UX Guide](dashboard-ui.md) - For a detailed breakdown of the main control webview.
- [Start a Feature](start-feature.md) - How to initiate this workflow.
