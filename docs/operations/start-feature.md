# Start a Feature

How to drive a single feature through the Schegent pipeline.

## Prerequisites

- Schegent extension installed and active.
- Workspace open in VS Code.
- `claude` CLI on `PATH` (or `schegent.cli.path` set in settings).
- `.specify/` scaffold present (Spec Driven Development workflow-initialized repo).
- **At least one Pipeline in the catalog.** Schegent ships none. See
  [First run: the catalog is empty](#first-run-the-catalog-is-empty) below.

## First run: the catalog is empty

A fresh install has no Phases, Pipelines, Workflows, or Models. That is an
unconfigured install, not a broken one. The Dashboard's **Runs** tab says so:
where the Pipeline picker would be, its **Start a Run** zone reads *"No process
definitions yet"* and names `examples/`, the directory of process documents that
ships inside the extension.

Import one before you start a feature:

1. Open the process import surface and choose a document. The extension ships
   `speckit-new-feature.pipeline.yaml` (one Pipeline, nine Phases),
   `speckit-bugfix.pipeline.yaml` (one Pipeline, five Phases), and
   `model-catalog.yaml`.
2. Read the plan. Nothing is written yet: you get one row per resource, marked
   import, skip, blocked, or invalid.
3. Pick the scope to write into — workspace or user. There is no default, and an
   unchosen scope never resolves to the workspace on your behalf.
4. Confirm. Re-importing the same document later produces all skip rows and
   overwrites nothing.

`schegent.defaultPipelineId` also ships empty. Leaving it empty is supported —
you pick a Pipeline per task — but set it to one of your imported ids if you
want the enqueue dialog pre-selected.

See [Process YAML import and export](process-yaml.md) for the full import
reference.

## Quick path

1. Open the **Schegent** sidebar (activity bar icon).
2. Click **Open Dashboard** at the bottom of the sidebar, or run **Schegent: Open Dashboard** from the Command Palette.
3. From the Dashboard, type a feature description into the queue input, pick a Pipeline, and submit; or run **Schegent: Run Autonomous Workflow** (`schegent.auto`) directly from the Command Palette.
4. The state machine drives the Phases the chosen Pipeline names, in order. For the shipped Spec Driven Development example that is `specify → clarify → plan → tasks → checklist → analyze → implement → review → finalize`, then the host's terminal `done`.

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
| Launch refused: *"Nothing to run: the process catalog is empty"* | The reason is `catalog-empty`. Nothing has been imported yet — follow [First run: the catalog is empty](#first-run-the-catalog-is-empty). The same message and the same reason are used whether you launched by hand or a scheduled start fired, so the two cannot drift apart. |
| Launch refused naming a Pipeline id that "is not in the effective catalog" | The reason is `pipeline-not-found`: the catalog has Pipelines but not that one. An empty id here means the launch fell through to an unset `schegent.defaultPipelineId` — pick a Pipeline explicitly, or set the default. A named id means it was never imported, or its row is invalid and therefore not effective. |
| Run paused with `pausedReason: rate-limited` | Read [handle-rate-limits.md](handle-rate-limits.md) — the watchdog auto-resumes when credits return. |
| Run paused with `pausedReason: stalled` | Read [debug-stuck-runs.md](debug-stuck-runs.md). |
| Run failed | Open the Dashboard (or run `Schegent: Retry Active Run` / `schegent.retryActiveRun` from the Command Palette). The CLI is invoked again from the same phase. |
| Workspace lock held | Wait for the existing run to terminate, or check `.schegent/audit.log` for the holding `runId`. The lock auto-releases on terminal completion. |

## Where to look next

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — workflow controller and state machine.
- [recover-after-restart.md](recover-after-restart.md) — what happens when VS Code restarts mid-run.
- [reset-safely.md](reset-safely.md) — abort and clean up.
