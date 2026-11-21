# Example definitions

Importable Phase and Workflow packages, plus the Model catalog. Import a Workflow package and you have a
launchable process without authoring anything first.

| File | Kind | What it is |
|---|---|---|
| `speckit-new-feature.workflow.yaml` | Workflow package | The spec-driven feature process, with backend choices for Implement, Converge, and both reviews |
| `speckit-bugfix.workflow.yaml` | Workflow package | The bugfix process (`kind: Workflow`), with all 5 Phase definitions it references included |
| `model-catalog.yaml` | Model catalog | The model list, read by its own importer rather than the process importer |

## Import them

The [quickstart](../docs/tutorials/user-quickstart.md) walks the whole path. In short: **Builder** →
**Import…** → choose a file → read the preflight → **Confirm import**. Each `.workflow.yaml` file is a
*package*: it defines the root Workflow and includes all the Phase and child Workflow definitions in its
transitive closure, so one file is one import.

The new-feature workflow defaults to Claude, with Phase IDs such as `claude-speckit-specify`.
Install the Spec Kit commands for each backend you select. To switch a phase to another backend,
select its variant in the Workflow editor, then save and publish. Choose matching variants for
Implement and Converge. Choose Code Review and Security Review independently. The default flow
ends at Finalize.

## This is documentation, not shipped state

The catalog ships **empty**, by decision:
[`FR-R3-014`](../../docs/features/round_3/DONE_14_FR-R3-014_runtime_only_process_catalog.md) ruled it
runtime-only with no bundled definitions, and `FR-R3-132` and `FR-R5-F07` do not reopen that. Nothing
here is **not shipped** as catalog content in the sense that matters: nothing is seeded, nothing is
installed, and a fresh workspace starts with an empty Builder and the guidance that explains it. These
files arrive the way your own definitions do — through the process-YAML import boundary — which is the
point. An example that bypassed the import path would demonstrate a product nobody runs.

The examples in this directory track this checkout, which can be newer than the build you have
installed. A build older than this checkout can refuse them, or report field defects on a valid file,
because it reads them with its own, older grammar. The remedy is to install the build that matches this
checkout and reload the window before importing; a window that was already open keeps running the build
it loaded.

## They cannot rot

Three suites sweep this directory:

- `repo/tests/integration/process-yaml/shipped-examples-compatibility.test.ts` — every file parses,
  preflights, and produces an import plan with **no defect on any row**;
- `repo/tests/integration/process-yaml/examples-round-trip.test.ts` — every id each document declares
  resolves as *effective* after importing into an empty catalog, and no invalid record is left behind
  once all of them have been imported;
- `repo/tests/integration/examples-import.test.ts` (`FR-R3-132`, `FR-R5-F07`) — pins the example **set**,
  so a file added or removed is a decision rather than a silent change, and checks that every Workflow
  node references Phase and child Workflow ids declared in the package closure.
