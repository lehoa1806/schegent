# Glossary

Schegent has three composition layers — Phase, Pipeline, Workflow — and a separate
run-time vocabulary for work that is actually executing. One word, **Workflow**, is
used in both places for different things. This page is the authoritative record of
which sense is meant where.

Read the disambiguation section first if you are reading Schegent source, audit
events, or settings for the first time. The rest of the page is lookup material.

## The two senses of "Workflow"

The word predates the Workflow *definition* feature and was never renamed, because
renaming it would have changed persisted state, IPC payloads, and audit event shapes
that operators and integrations already depend on. Both senses are live. They are
distinguished by context, never by spelling.

### Workflow Run — the run-side sense

A **Workflow Run** is one queued task being driven through a Pipeline. It is the
executing thing: it has a status, a current Phase, an iteration count, a frozen
Pipeline snapshot, and a growing list of completed Phase results. It is persisted in
workspace state as `WorkflowRun` and is what the sidebar, status bar, and dashboard
are showing you while work is in flight.

A Workflow Run runs **a Pipeline**. It does not run a Workflow definition. Nothing
about this sense changed when the definition sense was introduced.

Where you will meet it: the `WorkflowRun` record in workspace state, `workflowRunId`
and `runId` in audit events and raw transcript filenames, the intervention actions in
the [Intervention Playbook](../operations/intervention.md), and the phase-level
evidence under `.schegent/sessions/<runId>/`.

### Workflow — the definition-side sense

A **Workflow** (unqualified, in the definition catalogs) is a saved, reusable,
acyclic graph whose nodes are Pipelines. It is a document, not an execution. Saving
one starts nothing; it describes how Pipeline outputs may guide explicit follow-up
runs.

Where you will meet it: the `workflows/` subtree of the catalog store, the Workflow
Library in the Pipeline Builder sidebar, `WorkflowDefinition` in the contracts module,
and the `Workflow` kind in a `schegent/v1` document.

### Telling them apart in practice

| Signal | Run-side sense | Definition-side sense |
|---|---|---|
| Type name | `WorkflowRun` | `WorkflowDefinition` |
| Identifier | `runId` (host-issued, per execution) | `workflowId` (operator-authored, stable) |
| Where it lives | workspace state (`workspaceState`) | the catalog store, under `workflows/` |
| Lifetime | one execution | until edited or deleted |
| What it contains | a Pipeline snapshot and progress | nodes, connections, start nodes |
| What it does | executes | describes |

When a document needs to be unambiguous, it writes **Workflow Run** for the first and
**Workflow definition** for the second. Bare "Workflow" in the composition layers,
the Builder UI, and the configuration reference means the definition.

## Composition vocabulary

The three definition kinds, smallest first. Each is a separate catalog with the same
save and versioning semantics.

- **Phase** — one backend CLI invocation: a prompt template, a runner, a retry policy,
  and declared input and output ports. The smallest unit that produces evidence. See
  [Phase catalog](../operations/configuration.md).
- **Pipeline** — an ordered sequence of Phases, with bindings that carry one Phase's
  output into a later Phase's input. A Pipeline is what a Workflow Run executes.
  Bindings address a Phase by **`phaseIndex`**, because a sequence may legitimately
  repeat the same Phase.
- **Workflow** (definition) — an acyclic graph whose nodes are Pipelines, with typed
  connections between their ports and bounded conditional routing. Composes Pipelines
  without hiding which Pipeline a node runs, and without starting anything.

### Graph vocabulary

- **Node** — one Pipeline placed in a Workflow graph, addressed by a stable `nodeId`
  that is unique within the graph. Two nodes may name the same Pipeline. Connections
  address a node by **`nodeId`**, never by position, so reordering, inserting, or
  removing a node preserves every endpoint with no remap step. This is the deliberate
  opposite of Pipeline bindings, which address by index and must be remapped.
- **Connection** — a directed edge from one node's output port to a later node's input
  port. A connection carries no identifier of its own; its position in the ordered
  list is used for defect reporting only.
- **Start node** — a node in `startNodeIds`, the non-empty set where a composed run
  would begin. Every other node must be reachable from one of them.
- **Port** — a named, typed attachment point declared by a Pipeline. Output types are
  `markdown`, `file`, `file-set`, `structured-data`, `run-request`, and
  `external-reference`; input types are `text`, `source`, `local-file`,
  `local-folder`, `source-list`, `pipeline-output`, and `web-url`.
- **Port compatibility** — the frozen matrix deciding which output type may feed which
  input type. It is fixed in code, never operator-authored, so a portable Workflow
  behaves the same on every host that opens it.
- **Collection port** — `file-set` on the output side and `source-list` on the input
  side. Connecting a collection output into a non-collection input requires an
  explicit **selection rule**, because "which one of these" is a decision the graph
  must state rather than imply.
- **Condition** — a guard on a connection, expressed as structured data
  (`{ left, operator, right }`) drawn from a closed operand set. There is no
  expression language, no string form, and no evaluator; conditions are compared
  field-wise. An operand reading an upstream node's output must reference an ancestor
  of the connection it guards.
- **Derived ports** — a Workflow's own inputs and outputs, computed on read from the
  unbound ports of its node Pipelines. Projection-only: never stored, because a stored
  copy would go stale the moment a node's Pipeline changed shape.

## Catalog vocabulary

All three definition catalogs — Phase, Pipeline, Workflow — share this vocabulary and
these rules.

- **Catalog store** — the file-backed home of every definition, under
  `<workspaceRoot>/.schegent/catalog/`. There is exactly **one layer**: no
  built-in scope, no user-versus-workspace tier, and so no precedence to resolve
  and nothing that shadows anything.
- **Manifest** — `manifest.json`, the only mutable file in the store and its single
  ordering point. It names, per definition, which version is active.
- **Version record** — one immutable file at `<kind>/<id>/<versionId>.json`, written
  once and never rewritten. Every save produces one.
- **`versionId`** — the monotonic per-definition version number. Never reused, never
  reordered. Distinct from a definition's own `version` field, which is
  operator-visible and host-defaulted.
- **`contentHash`** — a SHA-256 over the definition's canonical JSON. A save whose
  hash matches the active version writes nothing, so opening an editor and closing it
  cannot manufacture history.
- **Effective catalog** — the set of definitions that resolve. A definition is either
  effective or **invalid**; there is no third status. Cross-catalog references resolve
  against the effective catalog only — a Pipeline binding against effective Phases, a
  Workflow node against effective Pipelines — because an invalid definition must not
  appear to satisfy a reference that runtime resolution will not honor.
- **Revision** — an opaque per-kind token sent with every save. The host re-reads the
  catalog and rejects a superseded token as `stale-catalog` rather than overwriting a
  concurrent edit.
- **Mutation intent** — the single declared reason for a save (`create`, `edit`,
  `duplicate`, `remove`, `reset`, `import-package`). Exactly one per write, checked
  against the proposed contents, so a save cannot claim one shape of change and
  perform another.
- **Retention** — the 50-version bound on each definition's history, pruned
  oldest-first and reported. The active version is never pruned, and neither is a
  version a retained run's provenance references — an exemption already wired,
  and load-bearing once run history records which version it ran.
- **Trust scope** — a per-capability grant keyed on what a document *says*:
  `schegent.trust.allowCustomPhases` and
  `schegent.trust.allowCustomRetryConditions`. Editing pipelines and workflows is
  gated by Workspace Trust alone. See
  [Trust Scopes](../operations/trust-scopes.md).

## Run vocabulary

- **Task** — a queued unit of work: a feature to drive through a Pipeline. Tasks are
  ordered in the queue and can be reordered while pending.
- **Queue** — the single ordered list of tasks, with a lifecycle that governs whether
  the next task may start.
- **Run** — the execution of one task. Shorthand for Workflow Run; `runId` identifies
  it in evidence paths and audit events.
- **Pipeline snapshot** — the copy of the resolved Pipeline frozen onto the run at the
  moment the task went in-flight. Editing catalogs mid-run has no effect on it; the
  change takes effect on the next enqueue.
- **Iteration** — one attempt at the current Phase within a run. A retry increments it.
- **Phase result** — the recorded outcome of one completed Phase within a run.

## Near-miss pairs

Terms that read as synonyms and are not.

| Pair | Distinction |
|---|---|
| Workflow / Workflow Run | Definition versus execution. See above. |
| Pipeline / Pipeline snapshot | The catalog definition versus the frozen copy on a run. |
| `phaseIndex` / `nodeId` | Pipeline bindings address by index; Workflow connections address by identifier. |
| Stored / effective | Everything the catalog holds, versus the subset that resolves. An invalid definition is stored and visible but not effective. |
| Condition / retry condition | A Workflow connection guard is structured data with no evaluator. A Phase `retryCondition` is a sandboxed expression DSL. Different mechanisms, unrelated safety properties. |
| `version` / `versionId` | `version` is a field on the definition, authored-visible and host-defaulted. `versionId` is the store's own monotonic counter, assigned on every save. |

## See also

- [Settings](settings.md) — every `schegent.*` key, plus the shape of a stored definition.
- [Audit Events](audit-events.md) — where `runId` and the run-side vocabulary appear on disk.
- [File Layout](file-layout.md) — how `runId` maps to evidence paths.
