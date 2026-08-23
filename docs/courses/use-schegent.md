# Course: Use Schegent

This is the shortest path for an operator who wants Schegent to run an existing
process. You do not need to understand the extension architecture or read the
whole documentation set. By the end, you will have connected a backend,
activated a process, queued one Task, and found its Run evidence.

<!-- Source: ../../README.md -->
<!-- Source: ../tutorials/user-quickstart.md -->

## The path

| Lesson | Outcome |
|---|---|
| 1. Install and open a safe workspace | Schegent is running in a trusted, recoverable folder. |
| 2. Connect one backend | Schegent can find an authenticated Claude, Codex, or Agy CLI. |
| 3. Activate a process | At least one Phase and Pipeline are Active. |
| 4. Queue and follow a Task | The request enters a Queue and its Run is visible. |
| 5. Keep only the references you need | You know where to look when the normal path stops. |

Stop after lesson 4 if you only need to operate a process supplied by your
team. Lessons about architecture, IPC, storage, and contribution are not
prerequisites.

## 1. Install and open a safe workspace

Use a VSIX attached to a tagged [GitHub Release](https://github.com/lehoa1806/schegent/releases)
when one is available, then install it with VS Code's VSIX installation flow.
Tagged release automation is the durable distribution route; ordinary workflow
artifacts are temporary.

If no suitable release VSIX is available, build one from source:

```bash
git clone https://github.com/lehoa1806/schegent.git
cd schegent
npm install
npm run build
npm run package
```

Install the generated `.vsix` in VS Code. Node.js and npm are required for this
source-build fallback, not for ordinary use of an already-built VSIX.

<!-- Source: ../../RELEASE.md -->
<!-- Source: ../../package.json -->
<!-- Source: ../../.github/workflows/release.yml -->

Open a folder whose current state you can restore, grant Workspace Trust, open
the **Schegent** view from the Activity Bar, and select **Open Dashboard**. The
dashboard header must say **Workspace Connected**. A window marked **Read-only
Window** can inspect state but cannot launch or mutate work.

Schegent runs backend CLIs against the open working tree. Claude and Agy run
with their CLI approval prompts disabled and without a Schegent-supplied OS
sandbox. Codex uses `--sandbox workspace-write`, which permits workspace writes
but leaves `.git` read-only. Treat a disposable branch or restorable checkout
as the normal starting point.

<!-- Source: ../tutorials/user-quickstart.md -->
<!-- Source: ../../src/runner/claude-cli.ts -->
<!-- Source: ../../src/runner/codex-cli.ts -->
<!-- Source: ../../src/runner/agy-cli.ts -->

## 2. Connect one backend

Install and authenticate one supported CLI before asking Schegent to invoke it.
Schegent does not install the CLI, sign in for you, or provide a hosted model
service.

For the default case—Claude is authenticated and `claude` is on `PATH`—you do
not need to set any Schegent setting. Configure only the differences in your
environment:

| Need | Setting | Required when |
|---|---|---|
| Select the backend | `schegent.backend.runner` | You use Codex or Agy instead of the default Claude runner. |
| Locate Claude | `schegent.cli.path` | `claude` is not available on `PATH`. |
| Locate Codex | `schegent.codex.path` | `codex` is not available on `PATH`. |
| Locate Agy | `schegent.agy.path` | `agy` is not available on `PATH`. |
| Restrict environment inheritance | `schegent.cli.environmentMode`, `schegent.cli.environmentAllowlist`, `schegent.cli.inheritEnvironment` | Your security or CLI setup needs a non-default environment policy. |
| Choose an enqueue fallback | `schegent.defaultPipelineId` | A caller may omit the Pipeline ID. It is not required for dashboard launches. |

Set backend selection and environment policy in VS Code **Settings**. Reload
the VS Code window after changing them because Schegent captures them during
workspace activation. Executable-path settings are read per invocation and do
not require a reload.

<!-- Source: ../../package.json -->
<!-- Source: ../reference/settings.md -->
<!-- Source: ../operations/configuration.md -->

Use these interfaces for the normal operator path:

| Interface | Use it for |
|---|---|
| VS Code **Settings** | Backend choice, executable paths, and environment policy. |
| Dashboard **Builder** | Import, inspect, and publish process definitions. |
| Dashboard **Runs** | Select a Pipeline and compose a Task. |
| Dashboard **Queues** and Run detail | Start, pause, monitor, retry, or inspect work. |
| **History**, **Audit Log**, and **System Log** | Evidence and diagnosis when needed. |

There is no Schegent server, database, or HTTP API to connect.

<!-- Source: ../../package.json -->
<!-- Source: ../../src/state/workspace-state.ts -->
<!-- Source: ../../webview-ui/src/dashboard/routes.ts -->

## 3. Activate a process

Schegent ships with an empty active catalog. Your team must give you a process
YAML package, or you must author and publish at least one Phase and Pipeline.

1. Open **Builder**.
2. Select **Import…** and choose the supplied YAML document.
3. Review every preflight row and any blocked dependency.
4. Select **Confirm import** only when the planned definitions are expected.
5. Verify that the Pipeline is Active and appears in **Runs**.

<!-- Source: ../../src/config/pipeline-config.ts -->
<!-- Source: ../operations/process-yaml.md -->
<!-- Source: ../../webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte -->

The repository example at `examples/speckit-new-feature.pipeline.yaml` is an
advanced development workflow, not a harmless hello-world sample. It selects a
specific Claude model, invokes Spec Kit and review skills, changes the working
tree, and includes Git operations. Use it only in a disposable checkout after
reviewing the entire YAML and satisfying its prerequisites. For everyday use,
prefer a process package supplied and reviewed by your team.

<!-- Source: ../../examples/speckit-new-feature.pipeline.yaml -->

## 4. Queue and follow a Task

1. Open **Runs** and keep **Pipelines** selected.
2. Select an Active Pipeline and then **Trigger**.
3. Enter the requested inputs and **Instructions**.
4. Review the process preview and declared side effects.
5. Select **Run Pipeline** and complete any Git side-effect approval.
6. When the form reports `Queued as <request-id>.`, open **Queues**.
7. Open the Queue card, select the Task, and follow its Run detail.
8. Inspect **Phase log**, **Run outputs**, and **Context** until the Run reaches a
   terminal state.

`Queued as …` confirms admission only; it does not mean that execution
completed. A process's declared side effects support consent and recovery, but
they are not an operating-system sandbox. Pausing a Queue prevents future
promotion; it does not stop a subprocess that is already executing.

<!-- Source: ../tutorials/user-quickstart.md -->
<!-- Source: ../../webview-ui/src/components/RunLauncher/RunLauncher.svelte -->
<!-- Source: ../../src/services/auto-drain-coordinator.ts -->
<!-- Source: ../concepts/unprompted-agent-not-contained.md -->

The data flow you are connecting is intentionally local:

```text
process YAML -> Builder import -> active Phase/Pipeline catalog
operator inputs -> Runs -> host validation -> Queue -> backend CLI
backend result -> Run detail + History + Audit + workspace-local evidence
```

Schegent freezes the accepted plan before execution, then sends each Phase to
the configured local CLI and projects progress and evidence back into the UI.

<!-- Source: ../../src/contracts/run-request.ts -->
<!-- Source: ../../src/queue/queue-manager.ts -->
<!-- Source: ../../src/controller/workflow-controller.ts -->
<!-- Source: ../reference/file-layout.md -->

## 5. Read only when the task requires it

- For ordinary queue, run, repeat, and audit operations, use [Product workflows](../how-to/product-workflows.md).
- For exact Command Palette titles and behavior, use the [Command Palette reference](../reference/commands.md).
- To change or diagnose a backend, use [Backend operations](../operations/backends.md).
- To look up a setting, use [Settings reference](../reference/settings.md).
- To understand retained sessions and logs, use [Sessions and logs](../concepts/sessions-and-logs.md).
- Before unattended or sensitive work, use the [Threat model](../security/threat-model.md).
- If you want the product vocabulary after your first successful Run, read [Core concepts](../explanation/core-concepts.md).

Return to the [documentation path selector](../README.md) when your goal changes.
