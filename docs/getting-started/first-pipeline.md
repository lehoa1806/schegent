# Your First Pipeline

This guide walks you through enqueueing your first feature request and watching Schegent drive it from a one-line description to an implemented, finalized feature. Plan for 15–60 minutes of CLI runtime depending on the feature's size; you can step away once it is in-flight.

## Before you start

Confirm the prerequisites in [Installation](installation.md):

- The Claude CLI is installed and authenticated.
- A VS Code workspace is open and trusted.
- The Schegent sidebar shows **CLI ready**.
- **You have imported a pipeline.** Schegent ships an empty catalog, so a fresh install has nothing to run. Import `examples/speckit-new-feature.pipeline.yaml` from the extension package first — see step 2 of the [Quickstart](quickstart.md#2-importing-a-process-document). The rest of this page assumes you did.

For your first run, pick a small feature. "Add a dark-mode toggle to the settings page" is a good shape; "Rewrite the data layer" is not. The pipeline is generic, but smaller features finish faster and let you observe the whole loop in one sitting.

## Step 1: Enqueue the feature

In the Schegent sidebar, click **Enqueue Feature**. A modal opens with three fields:

- **Description** — a one- or two-sentence statement of what you want built. This is what the `speckit-specify` phase will read.
- **Pipeline** — pick `speckit-new-feature`, the pipeline you imported. There is no shipped default: `schegent.defaultPipelineId` is empty until you set it, and a launch that resolves no pipeline is refused rather than defaulted.
- **Phase overrides** *(optional)* — open the disclosure if you want to override the model or effort of a specific phase for this task only. Most of the time you do not need to.

Click **Enqueue**.

You can also enqueue from the command palette: **Schegent: Enqueue Feature Request** (`schegent.schedule`). The dialog is identical.

The task appears at the bottom of the **Pending** list in the sidebar.

## Step 2: Watch the drainer pick it up

If no other task is in-flight and the queue is not paused, the drainer picks up the new task within a few seconds. You will see:

1. The task moves from **Pending** to **In-flight**.
2. The header changes from "Idle" to "Running: speckit-specify" (or similar).
3. The phase log feed beneath the task starts filling with tool calls, file writes, and messages as Claude executes.

![Operations Dashboard](../assets/walkthrough/04_orchestrator.png)

This is the moment the workspace lock is acquired. If a competing run tries to start, it will queue up behind this one.

## Step 3: Read the phase log feed

Beneath the in-flight task, the **phase log feed** renders the live activity of the current phase. You will see:

- **Tool calls** — each invocation of `Read`, `Write`, `Edit`, `Bash`, etc. with sanitized arguments.
- **Messages** — text Claude emits between tool calls.
- **Phase boundaries** — when one phase completes and the next begins.

The feed is sanitized — secrets in tool arguments are scrubbed before the line reaches you. For a deeper, unredacted view, you can enable [Verbose Diagnostics](../features/verbose-diagnostics.md) before the next phase starts.

The header above the feed shows the current phase id, the elapsed time, and a live PID indicator if the subprocess is running.

## Step 4: Watch the phases advance

The Spec Driven Development pipeline you imported walks through nine phases in order. For each, you should see roughly this rhythm:

- **`speckit-specify`** — a fresh spec file appears under `specs/<NNN-name>/spec.md`. The phase ends and the spec is committed to the workspace.
- **`speckit-clarify`** — the phase may loop a few times as Claude resolves ambiguity markers. The sidebar shows iteration counts when it loops.
- **`speckit-plan`** — `plan.md` appears in the same spec directory.
- **`speckit-tasks`** — `tasks.md` appears.
- **`speckit-checklist`** — a requirements-quality checklist appears under `checklists/`. This phase is non-blocking: a missing checklist warns and the run advances.
- **`speckit-analyze`** — a consistency audit runs. If issues are found, the phase loops; if none, it advances.
- **`speckit-implement`** — the longest phase. Claude executes the task list, writing code and tests. Expect minutes to tens of minutes here for non-trivial features.
- **`speckit-review`** — finishes any task left incomplete, then loops code review and security review until both report zero findings.
- **`finalize`** — a verification pass. Builds, tests, regenerates derived docs.

After the last phase the run reaches the terminal `done` state and the task moves from **In-flight** to **Completed** in the history. `done` is not one of the pipeline's phases — the host supplies it as the successor to whatever the pipeline names last, so a pipeline never has to declare a sentinel of its own.

At every phase boundary, the audit log gets a `phase-start` and `phase-end` event. If you ever want to know what happened during phase X, the `phase-end` payload is your starting point — it carries the outcome, the metrics, the cause of failure (if any), and the duration.

## Step 5: (Optional) Pause to inspect

If you want to stop mid-run and look at the generated artefacts before continuing, click **Pause** on the in-flight task. Pause is **aggressive**: the host immediately kills the active subprocess and the run sits at the phase boundary it just left.

Click **Resume** to continue. The run picks up where it left off, optionally with `--continue` so Claude resumes its prior context instead of starting the phase fresh.

For a guided introduction to mid-run intervention, see [Intervention Playbook](../operations/intervention.md).

## Step 6: Verify the result

When the task reaches **Completed**, you should find:

- A new spec directory under `specs/<NNN-feature-name>/` with `spec.md`, `plan.md`, and `tasks.md`.
- Implementation code under your repo's normal structure.
- Updated tests, run-able from your test runner.
- A clean audit-log trail of every phase, every tool call, and every file write.

Run your test suite to confirm the implementation actually works:

```bash
npm test            # or your project's equivalent
```

If tests fail, you have two paths:

- **Cosmetic / small fix** — make the fix yourself, commit, and you are done.
- **Substantial gap** — enqueue a new task with a new description to address the substantial gap.

## Step 7: Tidy up

The completed task stays in **History** until you remove it. To free disk space:

1. Right-click the history row → **Remove task**.
2. The confirmation dialog asks whether to also remove the per-run session tree (`raw-<runId>.log` and any verbose-diagnostics directory). For a small feature you can safely say yes; for a feature you may want to revisit, say no and clean up later.
3. The audit log is **not** affected by task removal — the events stay in `audit.log` forever (subject to rotation).

## What just happened

In one run you exercised every major piece of Schegent:

- The **queue** moved a task from pending to in-flight via the drainer.
- The **workspace lock** held throughout the run, preventing concurrent runs from racing.
- The **pipeline snapshot** froze the phase sequence and per-phase settings the moment the run started.
- The **phase runner** invoked the Claude CLI once per phase — nine times, plus one more for each loop iteration — each with sanitized argv composition and stdout parsing.
- The **audit pipeline** wrote a structured, sanitized record of every event to `.schegent/audit.log`.
- The **raw transcript** captured the unredacted scrollback to `.schegent/sessions/raw-<runId>.log` for local debug.
- The **state store** persisted the run's progress at every phase boundary so a crash or reload would recover cleanly.

You can now enqueue features at will. The next page, [Sidebar Tour](sidebar-tour.md), walks through every panel in the sidebar so you know what each control does.
