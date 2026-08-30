# Run the shipped Spec-kit pipeline

This tutorial takes a first-time operator from a source checkout to one queued Schegent run. The repository does not contain a Marketplace identifier, a checked-in VSIX, or an end-user installer, so the reproducible installation path available here is the Extension Development Host described in [Developer setup](developer-setup.md).
<!-- Source: package.json -->
<!-- Source: tests/integration/runTest.ts -->

You will import the shipped `Spec-kit Bugfix` process, supply one instruction, and verify that Schegent accepted the run.
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->

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

**Rollback.** Everything this tutorial does is confined to that directory. To undo it entirely,
close the window and delete the directory. Nothing is written outside it except VS Code's own
per-workspace state, which VS Code discards with the folder.

The pipeline used here — `Spec-kit Bugfix` — declares **no** `sideEffects: git` on any phase. That is
why it is the one this tutorial uses. `Spec-kit New Feature` does, on two phases, and is not a first
run.
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->

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

This pipeline invokes the `claude` runner and selects `claude-sonnet-5`. A real run therefore also
requires a working Claude CLI with access to that model. Schegent does not install or authenticate
that CLI for you.

Read the [threat model](../security/threat-model.md) before a first run. The default `claude` runner is
spawned with `--dangerously-skip-permissions`: its approval prompts are off and the agent acts
without asking, within whatever the OS user can reach. That is the reason the disposable workspace
above is a requirement and not a suggestion.
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->
<!-- Source: src/runner/claude-cli.ts -->

Grant VS Code Workspace Trust to the disposable folder. In an untrusted workspace, Schegent displays `Workspace is not trusted` and disables catalog edits; the Runs surface also explains that launching is unavailable.
<!-- Source: webview-ui/src/components/TrustBanner.svelte -->
<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/components/RunsSurface.svelte -->

## 1. Open the dashboard

1. In the VS Code Activity Bar, open **Schegent**.
2. In the sidebar, select **Open Dashboard**.
3. Confirm that the dashboard header says **Workspace Connected**. If it says **Read-only Window**, return to the primary VS Code window for this workspace; only that window can launch a run.

The dashboard opens on **Queues** and also exposes **Runs**, **History**, **Metrics**, **System Log**, **Builder**, and **Settings** as sibling views.
<!-- Source: webview-ui/src/components/DashboardLink.svelte -->
<!-- Source: webview-ui/src/dashboard/App.svelte -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->

## 2. Import the example process

1. Open **Builder**. Its initial tab is **Phases**, and its tabs read **Phases**, **Pipelines**, **Workflows**, **Models** — the order definitions compose in.
2. Select the **Pipelines** tab. The import entry is not exclusive to it — the same kind-agnostic
   front door appears on any Builder tab whose catalog is empty, and on **Models** unconditionally —
   so this step is not what makes the import work. It puts you on the tab where the imported Pipeline
   appears, which is what the steps below describe.
3. In the import panel, select **Import…**.
4. In the YAML picker, choose `examples/speckit-bugfix.pipeline.yaml` from the Schegent checkout.
5. Review the preflight result. It must identify a Pipeline with ID `speckit-bugfix` and name `Spec-kit Bugfix`.
6. Select **Confirm import**.

The document is a package: it defines the pipeline and includes all five phase definitions it references. A successful confirmed import publishes the complete set so that the pipeline is launchable; the implementation first stages draft records and then publishes them as one import operation.

**The other files in that folder** (`FR-R3-132`): `examples/speckit-new-feature.pipeline.yaml` is the
same shape for the feature process, and `examples/example-two-node.workflow.yaml` is a two-node
Workflow that carries its own pipelines and phases, so it imports on its own. Its single edge is
conditional — the second node runs only if the first failed — which is the smallest graph in which a
condition does real work. See
[`examples/README.md`](../../examples/README.md). Every file there is parsed and validated by
`repo/tests/integration/examples-import.test.ts`, so an example cannot rot into a broken first
experience.
<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/components/Builder/BuilderTabs.svelte -->
<!-- Source: webview-ui/src/components/Builder/CatalogEmptyState.svelte -->
<!-- Source: webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte -->
<!-- Source: src/extension.ts -->
<!-- Source: tests/integration/catalog-import-always-draft.test.ts -->
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->

## 3. Compose and queue the run

1. Open **Runs**, then leave **Pipelines** selected.
2. Select the active row named **Spec-kit Bugfix**.
3. Select **Trigger**.
4. The sample declares no input ports, so the form says it can run as-is. Under **Additional context**, enter `e2e happy path` in **Instructions**.
5. In **Process preview**, verify this exact phase order:

   1. `bugfix-report`
   2. `bugfix-patch`
   3. `bugfix-verify-pre`
   4. `bugfix-implement`
   5. `bugfix-verify-post`

6. Select **Run Pipeline**.

Success at this step means the form reports `Queued as <request-id>.`, where `<request-id>` is generated by the host. That message confirms admission to the queue, not completion of the five phases.
<!-- Source: webview-ui/src/components/RunsSurface.svelte -->
<!-- Source: webview-ui/src/components/Runs/LaunchableDetail.svelte -->
<!-- Source: webview-ui/src/components/RunLauncher/RunLauncher.svelte -->
<!-- Source: webview-ui/src/components/RunLauncher/SupplementalInputs.svelte -->
<!-- Source: webview-ui/src/lib/run-composition.ts -->
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->

## 4. Follow the run

1. Return to **Queues**.
2. Open the queue card containing the new task.
3. Select that task to open its run detail.
4. Watch **Phase log** as execution advances. The same view also exposes **Run outputs** and **Context**.

The repository's deterministic E2E test drives the same `speckit-new-feature` pipeline to `completed` with `currentPhase` equal to `done` and asserts the nine-phase order above. That test uses a fake Claude executable; a real completion additionally depends on the installed CLI, credentials, model availability, workspace contents, and the commands performed by each phase.
<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: webview-ui/src/components/drilldown/QueuesTier.svelte -->
<!-- Source: webview-ui/src/components/drilldown/QueueDetailTier.svelte -->
<!-- Source: webview-ui/src/components/drilldown/RunDetailTier.svelte -->
<!-- Source: tests/e2e/pipeline.test.ts -->
<!-- Source: tests/e2e/fixtures/fake-claude/index.js -->

## If the run is refused

- **No import controls:** grant Workspace Trust. Pipeline and workflow mutations require it.
- **Trigger is disabled:** use the VS Code window whose header says **Workspace Connected**.
- **Validation feedback appears:** correct the named field and submit again. The extension host, rather than the webview, is authoritative for run-request validation.
- **The queue or runner fails after admission:** open the task's run detail and **System Log**. `Queued as …` only proves the request entered a queue.

<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/components/Runs/LaunchableDetail.svelte -->
<!-- Source: webview-ui/src/components/RunLauncher/RunLauncher.svelte -->
<!-- Source: src/contracts/run-request.ts -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->
