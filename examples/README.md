# Example definitions

Importable Phase and Workflow packages, plus the Model catalog. Import a Workflow package and you have a
launchable process without authoring anything first.

| File | Kind | What it is |
|---|---|---|
| `speckit-new-feature.workflow.yaml` | Workflow package | The spec-driven feature process (`kind: Workflow`), with all 11 Phase definitions it references included |
| `speckit-bugfix.workflow.yaml` | Workflow package | The bugfix process (`kind: Workflow`), with all 5 Phase definitions it references included |
| `example-two-node.workflow.yaml` | Workflow package | Two Phase nodes with one conditional edge, plus the two Phases it needs — one import |
| `example-nested-delivery.workflow.yaml` | Workflow package | Three-level composable Workflow hierarchy (`delivery-root` -> `delivery-plan-and-verify` -> `delivery-verify-leaf`), reusing the child verification Workflow across two call sites |
| `model-catalog.yaml` | Model catalog | The model list, read by its own importer rather than the process importer |

## Import them

The [quickstart](../docs/tutorials/user-quickstart.md) walks the whole path. In short: **Builder** →
**Import…** → choose a file → read the preflight → **Confirm import**. Each `.workflow.yaml` file is a
*package*: it defines the root Workflow and includes all the Phase and child Workflow definitions in its
transitive closure, so one file is one import.

## The conditional and nested Workflow examples

`example-two-node.workflow.yaml` (`FR-R3-132`, 2026-08-28) demonstrates a conditional edge between two
Phase nodes: the revise node runs only when the draft node's status is `failed`. That is the smallest
graph in which a condition does real work — delete the condition and the second node runs
unconditionally, which demonstrates a different product. Both included Phases write **one file each and
nothing else**, so the graph is safe to run against a scratch checkout.

`example-nested-delivery.workflow.yaml` (`FR-R5-F07`) demonstrates Round 5 composable Workflow
authoring: a root Workflow (`delivery-root`) mixes direct `kind: phase` nodes and `kind: workflow`
child-Workflow nodes (`delivery-plan-and-verify` and `delivery-verify-leaf`), reuses
`delivery-verify-leaf` at two distinct call sites, and wires explicit public `inputs`, `outputs`, and
`bindings`.

## This is documentation, not shipped state

The catalog ships **empty**, by decision:
[`FR-R3-014`](../../docs/features/round_3/DONE_14_FR-R3-014_runtime_only_process_catalog.md) ruled it
runtime-only with no bundled definitions, and `FR-R3-132` and `FR-R5-F07` do not reopen that. Nothing
here is **not shipped** as catalog content in the sense that matters: nothing is seeded, nothing is
installed, and a fresh workspace starts with an empty Builder and the guidance that explains it. These
files arrive the way your own definitions do — through the process-YAML import boundary — which is the
point. An example that bypassed the import path would demonstrate a product nobody runs.

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
