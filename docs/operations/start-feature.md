# Start a Feature

How to drive a single feature through the Schegent pipeline.

## Prerequisites

- Schegent extension installed and active.
- Workspace open in VS Code.
- `claude` CLI on `PATH` (or `schegent.cli.path` set in settings).
- `.specify/` scaffold present (Speckit-initialized repo).

## Quick path

1. Open the **Schegent** sidebar (activity bar icon).
2. Click **Open Dashboard** at the bottom of the sidebar, or run **Schegent: Open Dashboard** from the Command Palette.
3. From the Dashboard, type a feature description into the queue input and submit, or run **Schegent: Run Autonomous Workflow** (`schegent.auto`) directly from the Command Palette.
4. The state machine drives `specify → clarify → plan → tasks → analyze → implement → finalize`.

## What you can watch

Once the feature starts, you can monitor its progress in the **Schegent Sidebar**:

```text
+-------------------------------------------------------------+
| SCHEGENT                                                  ↕ |
+-------------------------------------------------------------+
|  ● 005-stabilization-refactor                       12:45   |
|  implement · 3/7 tasks                                      |
|  ✔ 2   |   ◎ 4   |   ✖ 1                                    |
|                                                             |
|  ● live                                                     |
|  Executing tests for workflow controller                    |
+-------------------------------------------------------------+
```

For a detailed breakdown of every visual element in the sidebar, see the [Sidebar UI/UX Guide](sidebar-ui.md).

For advanced controls, full queue, phase progression tiles, and the live activity feed, open the **Dashboard Webview** via the button at the bottom of the sidebar. See the [Dashboard UI/UX Guide](dashboard-ui.md) for a full visual breakdown.

The audit log lives at `.schegent/audit.log` — append-only JSONL after redaction.

## When something goes wrong

| Symptom | Action |
|---|---|
| Run paused with `pausedReason: rate-limited` | Read [handle-rate-limits.md](handle-rate-limits.md) — the watchdog auto-resumes when credits return. |
| Run paused with `pausedReason: stalled` | Read [debug-stuck-runs.md](debug-stuck-runs.md). |
| Run failed | Open the Dashboard (or run `Schegent: Retry Active Run` / `schegent.retryActiveRun` from the Command Palette). The CLI is invoked again from the same phase. |
| Workspace lock held | Wait for the existing run to terminate, or check `.schegent/audit.log` for the holding `runId`. The lock auto-releases on terminal completion. |

## Where to look next

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — workflow controller and state machine.
- [recover-after-restart.md](recover-after-restart.md) — what happens when VS Code restarts mid-run.
- [reset-safely.md](reset-safely.md) — abort and clean up.
