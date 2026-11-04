# Workflow Execution Runtime Contract (`FR-R5-F02`)

This document defines the normative execution semantics for frozen, composable `WorkflowDefinition` runs in Schegent (`FR-R5-F02`). Both the VS Code extension host and the headless programmatic surface (`src/headless/workflow-run-api.ts`) enforce this contract through the shared runtime services under `src/services/run-request/` and `src/services/workflow-execution/`.

---

## 1. Admission & Frozen Transitive Closure (`FR-R5-F02-T02`, `FR-R5-F02-T03`)

1. **Single Envelope Construction**:
   - Every launch request (`RunRequest`) MUST pass through `validateRunRequest()` (`src/services/run-request/run-request-validator.ts`) before queuing or starting execution.
   - `validateRunRequest()` is the sole constructor of `ExecutionEnvelope` (`FrozenRunPlan`). No runtime or continuation path may reconstruct or spread an `ExecutionEnvelope`.
2. **Entry Node Selection**:
   - Root Workflow launches accept an optional `entryNodeId`. When omitted, `workflow.startNodeIds[0]` is selected. When supplied, `entryNodeId` MUST be present in the root Workflow's `startNodeIds`; otherwise admission fails with `invalid-entry-node`.
   - Child Workflow calls (`{ kind: 'workflow', workflowId }`) ALWAYS enter at `childWorkflow.startNodeIds[0]`.
3. **Transitive Closure & Provenance**:
   - At admission time, `createFrozenWorkflowClosure()` (`src/config/pipeline-snapshot.ts`) resolves the complete transitive closure of reachable `WorkflowDefinition` and `PhaseDefinition` records via `resolveWorkflowClosure`.
   - Enforced structural limits:
     - `MAX_WORKFLOW_NESTING_DEPTH = 8`
     - `MAX_WORKFLOW_CLOSURE_DEFINITIONS = 64`
     - `MAX_WORKFLOW_EXPANDED_NODES = 256`
   - Every definition in `workflowsById` and `phasesById` is deep-frozen and accompanied by a `CatalogVersionRef` (`id`, `kind`, `version`, `sourceScope`, `contentDigest`) in `catalogVersionsById`.
   - Subsequent edits to the live catalog do not affect any admitted, running, or waiting run.
4. **Advisory `executionDefaults`**:
   - Authored `executionDefaults` on a definition are copied into snapshots solely for provenance in `src/config/pipeline-snapshot.ts` and are never read by the runtime controller, workflow execution services, or runner.

---

## 2. Occurrence Identity & Invocation Tree (`FR-R5-F02-T04`)

The runtime separates the root run's immutable `FrozenWorkflowClosure` from mutable execution frames (`WorkflowInvocationFrame`) and node attempts (`NodeAttemptRecord`). Every occurrence and attempt carries five orthogonal identifiers:

| Field | Semantics |
|---|---|
| `rootRunId` | Identifier of the top-level Workflow run. |
| `invocationId` | Identifier of the owning `WorkflowInvocationFrame` (`rootRunId` for the root frame; unique generated ID for each child Workflow call). |
| `parentInvocationId` | `null` for the root frame; the calling frame's `invocationId` for a child Workflow invocation. |
| `nodePath` | Slash-separated hierarchical path from the root invocation (e.g., `/specify` at root, `/verify-suite/unit-tests` inside child workflow node `verify-suite`). |
| `attemptId` & `attemptIndex` | Unique attempt ID (`${invocationId}:${nodeId}:attempt-${attemptIndex}`) and 1-based attempt ordinal within `(invocationId, nodeId)`. |

Calling the same child `workflowId` from two different parent nodes (`/call-a` and `/call-b`) or across multiple attempts produces distinct `invocationId`, `nodePath`, and `attemptId` records with zero state collision.

---

## 3. Call, Selected-Path Completion, and Return (`FR-R5-F02-T01`, `FR-R5-F02-T05`)

1. **Phase Node Execution (`kind: 'phase'`)**:
   - Resolves `phaseId` from `frozenClosure.phasesById`, resolves input bindings into an immutable `InvocationInputEnvelope`, and dispatches the Phase attempt through the runner boundary with full occurrence metadata (`rootRunId`, `invocationId`, `parentInvocationId`, `nodePath`, `attemptId`, `attemptIndex`).
2. **Child Workflow Node Execution (`kind: 'workflow'`)**:
   - Resolves `workflowId` from `frozenClosure.workflowsById`, resolves parent-to-child `node.bindings` into the child invocation's `boundInputs`, verifies all required child public inputs are present, spawns a child `WorkflowInvocationFrame` entering at `childWorkflow.startNodeIds[0]`, and executes the child frame serially.
3. **Selected-Path Completion & Return**:
   - Within any `WorkflowInvocationFrame`, unselected conditional branches are not required to execute.
   - An invocation reaches completion when its active node attempt finishes and either:
     - The winning outgoing connection has `target: { kind: 'return' }`, OR
     - The completed node is a terminal sink node (zero outgoing connections in `workflow.connections`).
   - Upon reaching return, the runtime resolves the Workflow's declared `outputBindings` from completed attempts in that invocation frame:
     - If all required public outputs are resolved, the invocation transitions to `status: 'completed'` and (for a child invocation) returns `resolvedOutputs` as the parent `workflow` node attempt's `declaredOutputs`.
     - If any required public output is missing or unresolved along the selected path, the invocation transitions to `status: 'failed'` with `failureCode: 'missing-required-output'`.

---

## 4. Scoped Data Bindings & Collection Selection (`FR-R5-F02-T06`)

1. **Control vs. Data Separation**:
   - Connections (`workflow.connections`) govern only control transfer and handoff mode; data flows exclusively through explicit `node.bindings` (`workflow-input`, `node-output`, `output`) and `workflow.outputBindings`.
2. **Same-Frame Completed-Attempt Visibility**:
   - A `node-output` binding reads only from the latest *completed* `NodeAttemptRecord` (`status === 'completed'`) of `fromNodeId` within the *same* `WorkflowInvocationFrame`.
   - Failed, cancelled, running, or unvisited attempts are never read.
   - Internal child node outputs never leak to parent or sibling invocations unless exported through the child Workflow's `outputBindings`.
3. **Collection Selection**:
   - `all`: Passes all resolved artifact items in order.
   - `first`: Selects `[items[0]]` (fails with `collection-selection-violation` if `items.length === 0` for a required input/output).
   - `last`: Selects `[items[items.length - 1]]` (fails with `collection-selection-violation` if `items.length === 0` for a required input/output).
   - `exactlyOne`: Selects `[items[0]]` when `items.length === 1`; fails with `collection-selection-violation` when `items.length !== 1`.

---

## 5. Routing Conditions, Manual Handoffs & Continuation Envelopes (`FR-R5-F02-T07`)

1. **Deterministic Connection Evaluation**:
   - Outgoing connections from a completed node are evaluated in two tiers:
     1. Non-default connections (`!conn.isDefault`) sorted by ascending `priority` (`undefined` treated as `Infinity`), ties broken by authored index in `workflow.connections`.
     2. Default connections (`conn.isDefault === true`) sorted by ascending `priority` then authored index, evaluated only when zero non-default connections matched.
   - If the completed node has one or more outgoing connections and zero connections match, the invocation fails with `failureCode: 'no-eligible-transition'`.
2. **Handoff Modes**:
   - `handoff: 'auto'` (default): Immediately advances to the target node or completes the `{ kind: 'return' }` transition.
   - `handoff: 'manual'`: Transitions the invocation frame (and root run status projection) into `'waiting-for-handoff'` with `pendingHandoff` metadata recorded.
3. **Manual Continuation & `InvocationInputEnvelope`**:
   - When the operator approves continuation (`ContinuationService`), any edited inputs are validated against workspace path containment and target port contracts, then persisted as an immutable `InvocationInputEnvelope` (`source: 'manual-continuation'`, `acceptedAt: number`) on the target invocation/attempt *before* dispatching the next node.
   - `FrozenWorkflowClosure` is never mutated during continuation.

---

## 6. Queue Ownership & Legacy State Quarantine (`FR-R5-F02-T08`, `FR-R5-F02-T10`)

1. **Single Root Queue Slot (`queueId`)**:
   - The root Workflow run claims a single serial queue slot upon admission.
   - Child Phase attempts and child Workflow invocations execute within the root run's active queue claim (`boundQueueSlot: true`) so a parent Workflow never deadlocks waiting for its own child step to acquire the same serial queue slot.
   - Admission/start failures release any acquired workspace lock or queue claim in a `finally` block.
2. **Direct New-Schema Persistence & Legacy Quarantine**:
   - Runs are persisted with their `frozenClosure`, `invocationsById`, and `InvocationInputEnvelope` records.
   - Unsupported legacy pre-F02 Pipeline-run shapes are refused/quarantined with a bounded diagnostic (`unsupported-run-schema-version`) without synthesizing fake nested runs or silently deleting developer workspace state.

