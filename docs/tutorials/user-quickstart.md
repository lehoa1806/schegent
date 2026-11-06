# Run the shipped Spec-kit workflow

This tutorial takes a first-time operator from a source checkout to one queued Schegent run. The repository does not contain a Marketplace identifier, a checked-in VSIX, or an end-user installer, so the reproducible installation path available here is the Extension Development Host described in [Developer setup](developer-setup.md).
<!-- Source: package.json -->
<!-- Source: tests/integration/runTest.ts -->

You will import the shipped `Spec-kit Bugfix` Workflow package, supply one instruction, and verify that Schegent accepted the run.
<!-- Source: examples/speckit-bugfix.workflow.yaml -->

> **This tutorial was corrected under FR-R3-062.** It previously used
> `Spec-kit New Feature`, whose `finalize` phase declares `sideEffects: git` and instructs the agent
> to commit, switch branches and merge — in whatever workspace the reader had open, which it told
> them should be the product checkout. It also stated that a fresh checkout contains `.schegent/`.
> It does not: `.schegent/` is gitignored, and **both** activation directories have zero tracked
> files, so neither activation trigger fires on a fresh clone. All three problems are addressed
> below.

## Before you start

### Use a disposable workspace

**Do not use this repository, or any repository you care about, as the test workspace.** A Schegent
run gives an agent the ability to write to the open workspace. Create an empty directory instead:

```bash
mkdir -p /tmp/schegent-tutorial && cd /tmp/schegent-tutorial && git init
```

**Rollback.** Closing the window and deleting the directory removes the folder and VS Code's own
per-workspace state, which VS Code discards with the folder.

The backend grant is a different matter. It is a User setting, so deleting the folder does not
remove it. To undo only what this walkthrough added: if the modal added a backend, remove that one
id from `schegent.backend.uncontainedBackends`. Either select **Revoke uncontained permission** for
that backend in Schegent's Settings, under General, Backend, or edit the list back to the value you
recorded in [Record your backend grant list](#record-your-backend-grant-list). A backend you had
granted before the walkthrough stays granted. Whichever surface wrote the grant, the result is the
same: the id the walkthrough added is absent from the list.

The workflow used here — `Spec-kit Bugfix` — declares **no** `sideEffects: git` on any phase. That is
why it is the one this tutorial uses. `Spec-kit New Feature` does, on two phases, and is not a first
run.
<!-- Source: examples/speckit-bugfix.workflow.yaml -->
<!-- Source: examples/speckit-bugfix.workflow.yaml -->
<!-- Source: src/services/uncontained-grant-writer.ts -->

### Satisfy the activation condition explicitly

Schegent activates on `workspaceContains:.specify/` or `workspaceContains:.schegent/`. **Neither
directory exists in a fresh clone of this repository** — `.schegent/` is gitignored and both have
zero tracked files — so activation must be arranged deliberately:

```bash
mkdir -p /tmp/schegent-tutorial/.schegent
```

Create it before opening the folder. VS Code evaluates `workspaceContains` at folder-open time, so a
directory created afterwards does not trigger activation until the window is reloaded.
<!-- Source: package.json -->

### Launch an interactive Extension Development Host

Complete [Developer setup](developer-setup.md) for dependencies and the build. Then, **from the
Schegent checkout**, start an interactive host: run the **Run Extension** launch configuration
(<kbd>F5</kbd>). A second VS Code window opens with the extension loaded.

Use the interactive host, not `npm run test:integration`. That command runs the automated
Extension Development Host and **exits when its suites finish** — it is a gate, not a session, and
there is no window left to click through. The previous version of this tutorial pointed at it.
<!-- Source: package.json -->
<!-- Source: tests/integration/runTest.ts -->

In the new window, open `/tmp/schegent-tutorial` as the folder.

### Requirements the tutorial cannot supply

No Phase in this Workflow names a runner or a model, so it runs on the default `claude` runner with the
Claude CLI's own default model. A real run therefore also requires a working Claude CLI with access
to that model. Schegent does not install or authenticate that CLI for you.

Read the [threat model](../security/threat-model.md) before a first run. The default `claude` runner is
spawned with `--dangerously-skip-permissions`: its approval prompts are off and the agent acts
without asking, within whatever the OS user can reach. That is the reason the disposable workspace
above is a requirement and not a suggestion. Also read what leaves the machine whatever Schegent's
capture settings say: [egress and the raw transcript's lifetime](../concepts/local-first-not-offline.md#egress-and-the-raw-transcripts-lifetime).
<!-- Source: examples/speckit-bugfix.workflow.yaml -->
<!-- Source: src/runner/claude-cli.ts -->

Grant VS Code Workspace Trust to the disposable folder. In an untrusted workspace, Schegent displays `Workspace is not trusted` and disables catalog edits; the Runs surface also explains that launching is unavailable.
<!-- Source: webview-ui/src/components/TrustBanner.svelte -->
<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/components/RunsSurface.svelte -->

### Record your backend grant list

The first Run on the default `claude` backend is refused until you allow that backend. Allowing it
changes a **User** setting, not the folder (see [If the run is refused](#if-the-run-is-refused)).
So before you start, note the current value of `schegent.backend.uncontainedBackends`, either in the
Settings editor or in your User `settings.json`. The default is an empty list, `[]`. Write the value
down: the rollback note under [Use a disposable workspace](#use-a-disposable-workspace) restores
exactly that value, so it removes only what this walkthrough added and nothing you had granted
before.
<!-- Source: package.json -->
<!-- Source: src/activation/uncontained-consent.ts -->

## 1. Open the dashboard

1. In the VS Code Activity Bar, open **Schegent**.
2. In the sidebar, select **Open Dashboard**.
3. Confirm that the dashboard header says **Workspace Connected**. If it says **Read-only Window**, return to the primary VS Code window for this workspace; only that window can launch a run.

The dashboard opens on **Queues** and also exposes **Runs**, **History**, **Metrics**, **System Log**, **Builder**, and **Settings** as sibling views.
<!-- Source: webview-ui/src/components/DashboardLink.svelte -->
<!-- Source: webview-ui/src/dashboard/App.svelte -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->

## 2. Import the example process

1. Open **Builder**. Its initial tab is **Phases**, and its tabs read **Phases**, **Workflows**, **Models** — the order definitions compose in.
2. Select the **Workflows** tab. The import entry is not exclusive to it — the same kind-agnostic
   front door appears on any Builder tab whose catalog is empty, and on **Models** unconditionally —
   so this step is not what makes the import work. It puts you on the tab where the imported Workflow
   appears, which is what the steps below describe.
3. In the import panel, select **Import…**.
4. In the YAML picker, choose `examples/speckit-bugfix.workflow.yaml` from the Schegent checkout.
5. Review the preflight result. It must identify a Workflow with ID `speckit-bugfix` and name `Spec-kit Bugfix`.
6. Select **Confirm import**.

The document is a package: it defines the Workflow and includes all five phase definitions it references. A successful confirmed import publishes the complete set so that the Workflow is launchable; the implementation first stages draft records and then publishes them as one import operation.

**The other files in that folder** (`FR-R3-132`, `FR-R5-F07`): `examples/speckit-new-feature.workflow.yaml` is the
same shape for the feature process, `examples/example-two-node.workflow.yaml` is a two-node
Workflow whose single edge is conditional — the second node runs only if the first failed — and
`examples/example-nested-delivery.workflow.yaml` is a three-level composable Workflow hierarchy
demonstrating child Workflow reuse across two call sites. See
[`examples/README.md`](../../examples/README.md). Every file there is parsed and validated by
`repo/tests/integration/examples-import.test.ts`, so an example cannot rot into a broken first
experience.
<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/components/Builder/BuilderTabs.svelte -->
<!-- Source: webview-ui/src/components/Builder/CatalogEmptyState.svelte -->
<!-- Source: webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte -->
<!-- Source: src/extension.ts -->
<!-- Source: tests/integration/catalog-import-always-draft.test.ts -->
<!-- Source: examples/speckit-bugfix.workflow.yaml -->

## 3. Compose and queue the run

1. Open **Runs**, where published **Workflows** are listed.
2. Select the active row named **Spec-kit Bugfix**.
3. Select **Trigger**.
4. The sample declares no input ports, so the form says it can run as-is. Under **Additional context**, enter `e2e happy path` in **Instructions**.
5. In the detail panel above the form, the **Effective Run Policy** list has one row per Phase, in the Workflow's node order, and each row shows the Phase's name. Verify that the rows read, in this order:

   1. Spec-kit Bugfix Report (Phase `bugfix-report`)
   2. Spec-kit Bugfix Patch (Phase `bugfix-patch`)
   3. Spec-kit Bugfix Verify (pre) (Phase `bugfix-verify-pre`)
   4. Spec-kit Implement (bugfix) (Phase `bugfix-implement`)
   5. Spec-kit Bugfix Verify (post) (Phase `bugfix-verify-post`)

6. Select **Run Workflow**.

Success at this step means the host created the connected run and enqueued its entry node onto the target queue. The form reports it as `Started connected run <run-id>.`.
<!-- Source: webview-ui/src/components/RunsSurface.svelte -->
<!-- Source: webview-ui/src/components/Runs/LaunchableDetail.svelte -->
<!-- Source: webview-ui/src/components/Runs/WorkflowTriggerForm.svelte -->
<!-- Source: webview-ui/src/components/RunLauncher/SupplementalInputs.svelte -->
<!-- Source: webview-ui/src/lib/run-composition.ts -->
<!-- Source: examples/speckit-bugfix.workflow.yaml -->

## 4. Follow the run

1. Return to **Queues**.
2. Open the queue card containing the new task.
3. Select that task to open its run detail.
4. Watch **Phase log** as execution advances. The same view also exposes **Run outputs** and **Context**.

The repository's deterministic integration test, `tests/integration/bugfix-pipeline-end-to-end.test.ts`, drives the five bugfix phases, in the order listed above, to `completed` with `currentPhase` equal to `done`. That test uses a scripted CLI runner in place of the Claude CLI; a real completion additionally depends on the installed CLI, credentials, model availability, workspace contents, and the commands performed by each phase.
<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: webview-ui/src/components/drilldown/QueuesTier.svelte -->
<!-- Source: webview-ui/src/components/drilldown/QueueDetailTier.svelte -->
<!-- Source: webview-ui/src/components/drilldown/RunDetailTier.svelte -->
<!-- Source: tests/integration/bugfix-pipeline-end-to-end.test.ts -->
<!-- Source: tests/fixtures/speckit-catalog-fixture.ts -->

## If the run is refused

- **The first Run is refused until you allow the backend:** with the shipped defaults (the `claude`
  backend and an empty `schegent.backend.uncontainedBackends` list), the first Run is refused when it
  starts, after `Started connected run …` has appeared. A modal reads "Schegent cannot start the '<id>' backend
  without your approval." (`<id>` is `claude` on the default backend). Its only approving button is
  **Enable '<id>' for This Installation**. Approving adds that one backend to
  `schegent.backend.uncontainedBackends` in your User settings, so it applies to every workspace on
  this installation, and the backend then runs with no OS-enforced bound and your local user
  authority: that is a risk you accept, not a protection you gain. Cancelling or dismissing the modal
  leaves the Run refused, and nothing starts. The `codex` backend is contained and never asks.
- **No import controls:** grant Workspace Trust. Phase and Workflow mutations require it.
- **Trigger is disabled:** use the VS Code window whose header says **Workspace Connected**.
- **Validation feedback appears:** correct the named field and submit again. The extension host, rather than the webview, is authoritative for run-request validation.
- **The queue or runner fails after admission:** open the task's run detail and **System Log**. `Started connected run …` only proves the host created the run and enqueued its entry node.

<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/components/Runs/LaunchableDetail.svelte -->
<!-- Source: webview-ui/src/components/RunLauncher/RunLauncher.svelte -->
<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/activation/uncontained-consent.ts -->
<!-- Source: package.json -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->
