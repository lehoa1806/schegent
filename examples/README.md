# Example definitions

Importable Phase, Pipeline and Workflow packages. Import one and you have a launchable process
without authoring anything first.

| File | Kind | What it is |
|---|---|---|
| `speckit-new-feature.pipeline.yaml` | Pipeline package | The spec-driven feature process, with every Phase it references included |
| `speckit-bugfix.pipeline.yaml` | Pipeline package | The bugfix process, likewise self-contained |
| `example-two-node.workflow.yaml` | Workflow package | Two nodes with one conditional edge, plus the two small Pipelines and two Phases it needs — one import |
| `model-catalog.yaml` | Model catalog | The model list, read by its own importer rather than the process importer |

## Import them

The [quickstart](../docs/tutorials/user-quickstart.md) walks the whole path. In short: **Builder** →
**Import…** → choose a file → read the preflight → **Confirm import**. Each pipeline file is a
*package*: it defines the pipeline and includes all the phase definitions it needs, so one file is one
import. The workflow is a package too: it includes the two small pipelines and two phases it needs, so it
imports on its own without the two speckit packages.

## The workflow example, and why it has a condition

`example-two-node.workflow.yaml` (`FR-R3-132`, 2026-08-28) exists because both other packages are
Pipelines, and the graph feature — the thing that distinguishes this product from a task runner — had
no importable demonstration.

Its single edge is **conditional**: the revise node runs only when the draft node's status is
`failed`. That is the smallest graph in which a condition does real work — delete the condition and the
second node runs unconditionally, which demonstrates a different product.

It carries its own pipelines rather than pointing at the two speckit packages, because those declare no
ports, and an edge with nothing to carry cannot show what a connection is for. Both included Phases
write **one file each and nothing else**, so the graph is safe to run against a scratch checkout.

## This is documentation, not shipped state

The catalog ships **empty**, by decision:
[`FR-R3-014`](../../docs/features/round_3/DONE_14_FR-R3-014_runtime_only_process_catalog.md) ruled it
runtime-only with no bundled definitions, and `FR-R3-132` does not reopen that. Nothing here is **not
shipped** as catalog content in the sense that matters: nothing is seeded, nothing is installed, and a
fresh workspace starts with an empty Builder and the guidance that explains it. These files arrive the
way your own definitions do — through the process-YAML import boundary — which is the point. An
example that bypassed the import path would demonstrate a product nobody runs.

## They cannot rot

Three suites sweep this directory:

- `repo/tests/integration/process-yaml/shipped-examples-compatibility.test.ts` — every file parses,
  preflights, and produces an import plan with **no defect on any row**;
- `repo/tests/integration/process-yaml/examples-round-trip.test.ts` — every id each document declares
  resolves as *effective* after importing into an empty catalog, and no invalid record is left behind
  once all of them have been imported;
- `repo/tests/integration/examples-import.test.ts` (`FR-R3-132`, T1504) — pins the example **set**, so
  a file added or removed is a decision rather than a silent change, and checks that the workflow
  references pipeline ids this folder actually declares.

The first two caught four real defects in `example-two-node.workflow.yaml` within seconds of it
landing — a condition authored on the node instead of the connection, a wrong operand shape, an
invalid port type, and a binding that port type made impossible — which is exactly what they are for.
