# Glossary

Schegent uses separate vocabularies for authored process definitions, queued work, and running work. The word **Workflow** has two live meanings: a reusable graph is a `WorkflowDefinition`, while the older `WorkflowRun` name represents one Pipeline execution. Read the surrounding type name rather than assuming the two are interchangeable.

<!-- Source: src/contracts/workflow-definitions.ts -->
<!-- Source: src/state/workflow-run.ts -->

## Authored definitions

| Term | Exact meaning |
|---|---|
| **Phase** | A reusable `PhaseDefinition` containing a stable `phaseId`, name, numeric version, and exactly one execution form: an instruction or a skill. |
| **Pipeline** | A `PipelineDefinition`: an ordered list of Phase IDs plus typed input ports, output ports, bindings, and optional execution defaults. Repeated Phase IDs are legal, so a binding addresses a Phase occurrence by `phaseIndex`. |
| **Workflow definition** | A `WorkflowDefinition`: an acyclic graph of Pipeline nodes. Nodes have stable `nodeId` values; connections address those nodes and may carry a structured condition, priority, default marker, or collection-selection rule. |
| **Catalog** | The workspace-local versioned store for Phase, Pipeline, and Workflow definitions. A manifest entry points to immutable version records and may have a draft version, an active version, or both. |
| **Draft** | An editable catalog version that is not necessarily used for execution. |
| **Active version** | The published catalog version selected when new work resolves a definition. |

<!-- Source: src/contracts/process-definitions.ts -->
<!-- Source: src/contracts/pipeline-definitions.ts -->
<!-- Source: src/contracts/workflow-definitions.ts -->
<!-- Source: src/contracts/catalog-store.ts -->
<!-- Source: src/contracts/catalog-lifecycle.ts -->

## Queued and running work

| Term | Exact meaning |
|---|---|
| **Queue** | One ordered `QueueState` partition. It owns pending Tasks, at most one in-flight Task, lifecycle state, scheduling fields, and pause attribution. |
| **Task** | The UI term for a `FeatureRequest`: a submitted description and its queue status, timestamps, position, run identity, retry data, and optional frozen run plan. |
| **Run** | One execution record. Its canonical host type is `WorkflowRun`, even when it is executing a Pipeline rather than a Workflow definition. |
| **Pipeline snapshot** | The `WorkflowRunPipeline` body frozen for a Run, including resolved Phases and, when present, ports, bindings, execution defaults, recommendations, and catalog provenance. |
| **Execution Envelope** | The validated and frozen `ExecutionEnvelope` stored with a Run. It carries the immutable plan, normalized request data, frozen bindings, and output plan used by execution. |
| **Connected Workflow Run** | A `ConnectedWorkflowRun` coordinating child Pipeline Runs over a frozen Workflow graph. It records node state, child references, routing decisions, and the bound queue. |

Task statuses are `pending`, `in-flight`, `paused`, `completed`, `canceled`, and `failed`. Run statuses are `running`, `paused`, `failed`, `completed`, and `canceled`; the differing active-status spelling is intentional.

<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/state/workflow-run.ts -->
<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/state/connected-workflow-run.ts -->

## Evidence and history

| Term | Exact meaning |
|---|---|
| **History Entry** | A terminal summary built from a Run. It records terminal status, timing, outputs, audit-pointer metadata, and catalog provenance when available. History is partitioned by queue ID. |
| **Audit Entry** | A schema-versioned, typed host-observed event written as one JSON object per audit-log line. Audit payloads are bounded by the event contract and sanitized before persistence. |
| **Correlation ID** | The bounded identifier carried across an inbound webview command and related host activity so responses and evidence can be associated with the initiating request. |
| **Run ID** | The stable identity of one Run; it is also the key used by history audit pointers and many audit events. |

<!-- Source: src/state/history-entry.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/contracts/sidebar-ipc.ts -->

## Scope terms

| Term | Exact meaning |
|---|---|
| **Workspace** | The canonical local VS Code workspace folder selected by the extension. Schegent state and workspace-local artifacts are rooted from this folder. |
| **Primary window** | The extension host currently holding the workspace primacy lease and therefore permitted to perform authoritative mutations. |
| **Execution lease** | A separate per-queue ownership claim used to ensure only one host drains a particular queue at a time. |

<!-- Source: src/state/workspace-folder-picker.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->
