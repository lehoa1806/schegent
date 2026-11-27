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

---

## 7. Nested Workflow Controls, Paired Pause/Retry Markers & Scoped Retry (`FR-R5-F03-T01`..`T05`)

1. **Invocation-Scoped Control Transition Table (`workflow-control-transition-table.ts`)**:
   - Every control operation (`pause`, `resume`, `cancel`, `retry-phase`, `retry-invocation`, `continue-handoff`) addresses a specific `targetInvocationId` (defaulting to the root invocation when omitted) and optional `targetNodeId`.
   - Each `WorkflowInvocationFrame` carries lifecycle `status` (`'in-flight' | 'waiting-for-handoff' | 'paused' | 'completed' | 'failed' | 'canceled'`) and explicit `InvocationControlMarkers`:
     - `manualPauseAt: number | null` and `manualPauseCause: WorkflowPauseCause | null` (`'operator-pause' | 'credit-exhausted' | 'recovery-uncertain-effect' | 'spend-bound-exceeded'`), strictly paired (`(manualPauseAt === null) === (manualPauseCause === null)`).
     - `pendingRetryAt: number | null` and `pendingRetryCause: WorkflowDelayedRetryCause | null` (`'transient-backoff' | 'rate-limit-backoff'`), strictly paired and cleared whenever a frame is paused or canceled.
2. **Subtree Pause, Resume & Cancellation (`WorkflowControlService`)**:
   - **Pause**: Transitions the target invocation and any non-terminal descendant frames to `status: 'paused'`, sets paired `manualPauseAt`/`manualPauseCause`, clears any armed `pendingRetryAt`/`pendingRetryCause`, marks the active leaf `NodeAttemptRecord` as `'paused'`, aborts the active leaf runner process, and blocks new descendant admission while retaining the bound `queueId` lease.
   - **Resume**: Clears `manualPauseAt`/`manualPauseCause` across the target paused subtree. If the leaf frame had an interrupted `'paused'` attempt, `resume` appends a new `NodeAttemptRecord` (`attemptIndex + 1`) and dispatches it; if the frame paused at a `waiting-for-handoff` boundary without an accepted continuation envelope, `resume` restores `'waiting-for-handoff'`.
   - **Cancel (Root vs. Child)**:
     - *Root cancel*: Aborts the active leaf runner, clears retry timers, marks all non-terminal frames `'canceled'`, and releases the bound `queueId` lease.
     - *Child-only cancel*: Aborts the active leaf inside that child subtree, marks the child subtree `'canceled'`, and settles the parent's `workflow` node attempt as `'canceled'`. The parent frame then evaluates outgoing connections from that workflow call node: if an explicit connection matches `node-status == 'canceled'`, the parent continues along that edge; otherwise cancellation propagates to the parent frame.
3. **Scoped Retry (`retry-phase` vs. `retry-invocation`)**:
   - **`retry-phase`**: Appends a new `NodeAttemptRecord` (`attemptIndex + 1`) for the failed, canceled, or paused leaf Phase node inside the existing `WorkflowInvocationFrame`, preserving all prior attempt records and completed upstream nodes. Enforces `maxPhaseAttempts` (default `5`) and optional `spendBoundUsd`.
   - **`retry-invocation`**: Valid for a `failed`, `canceled`, or `completed` child (or root) `WorkflowInvocationFrame` when no active descendant is executing. Retains the prior child frame in `invocations` as immutable historical evidence, appends a new `NodeAttemptRecord` (`attemptIndex + 1`) on the parent workflow-call node, invalidates superseded parent output bindings from the prior child frame, and spawns a fresh child `WorkflowInvocationFrame` starting at `startNodeIds[0]` while keeping completed sibling nodes untouched.

---

## 8. Command Idempotency, Restart Recovery & Bounded Ancestry Evidence (`FR-R5-F03-T06`..`T09`)

1. **Serialized Mutation Boundary & Command Idempotency**:
   - All control, retry, continuation, and completion mutations for a bound `queueId` execute through a per-queue FIFO serialization lock in `WorkflowControlService`.
   - Every command carries `commandId` and `expectedRevision`. If `commandId` is already present in `run.commandReceipts` (bounded ring of `MAX_COMMAND_RECEIPTS = 64`), the service returns the committed receipt with `idempotentReplay: true` without re-mutating state or spawning duplicate work. Otherwise, a mismatch between `expectedRevision` and `run.revision` is refused with `'stale-revision'`.
2. **Deterministic Restart Recovery (`WorkflowRecoveryService`)**:
   - On host restart, persisted `ConnectedWorkflowRun` records are reconciled into explicit `RecoveryDispositionRecord` outcomes:
     - `'clean-handoff'`: A frame in `'waiting-for-handoff'` without an accepted continuation envelope remains waiting without synthesizing a continuation.
     - `'pending-dispatch-recovered'`: A frame whose `pendingHandoff.acceptedEnvelope` (`acceptedAt`) was persisted before an interruption recovers and dispatches the target node from that persisted `InvocationInputEnvelope` without consulting live UI or catalog state.
     - `'settled-from-evidence'`: An `'in-flight'` phase attempt with durable completion evidence settles forward and advances the workflow graph.
     - `'uncertain-effect-paused'`: An interrupted `'in-flight'` phase attempt without durable completion evidence transitions to `'paused'` with `manualPauseCause: 'recovery-uncertain-effect'`, requiring explicit operator `retry-phase`, `resume`, or `cancel` rather than blind replay.
     - `'orphaned-canceled'`: If the bound `queueId` or backing task was deleted while the run was non-terminal, only that orphaned run is canceled and its lease released without disturbing sibling queues.
3. **Bounded Ancestry Evidence & Authoritative Control Projections (`WorkflowControlProjector`)**:
   - Every nested runtime event and control audit record includes `AncestryEvidenceMetadata` (`rootRunId`, `invocationId`, `parentInvocationId`, `nodePath`, `attemptId`, `attemptIndex`, `queueId`). Parent frames reference child invocations by ID without duplicating child transcripts.
   - `buildWorkflowRunControlProjection()` computes the authoritative `WorkflowRunControlProjection` (root and per-frame `allowedActions`, `waitingReason`, `pauseCause`, `failureReason`, `recoveryDisposition`, `revision`), exposed identically through host and `src/headless/workflow-run-api.ts` entry points.

---

## 9. Backend Completion Lifecycle Contract & Protocol Parity (`FR-R5-F11`)

1. **Common Observable Lifecycle Contract (`src/runner/claude-cli.ts`, `src/runner/process-lifecycle-runner.ts`)**:
   - **Spawn & `processError` Attribution**: Every backend spawns with `shell: false` in its own process group (`processTreeSpawnOptions()`), tracks the group at exit (`trackGroupAtExit`), and emits a `started` sidecar event with `invocationId`, `pid`, and `armedMaxDurationMs(request)`. If the child emits `'error'` with `pid === undefined` (e.g., `ENOENT`), `waitForChildCompletion` sets `processError: true` and suppresses false `stdinDeliveryFailed` attribution.
   - **Stdin Delivery (`src/runner/child-stdin.ts`)**: Prompts are written through `writePromptToStdin` (`request.prompt` for `claude-cli` and `codex-cli`; NDJSON `{"event":"user","message":{"content":...}}` envelope for `agy-cli`). Any `EPIPE`/`ECONNRESET` write error sets `stdinDeliveryFailed: true`, `stdinErrorCode`, and appends `'stdin-delivery-failed'` to `diagnosticWarnings`.
   - **Live-Stream Fatal Scanning (`src/lib/incremental-fatal-scanner.ts`)**: When `request.effectiveFatalSignatures` is supplied, all three adapters scan `stdout` and `stderr` chunks incrementally across chunk boundaries, finalize any trailing un-newlined diagnostic line on completion, and populate `streamFatalMatch: combineStreamScans(stdoutScanner, stderrScanner)` while ignoring structured JSON envelopes (`{`/`[`) and lines over `MAX_DIAGNOSTIC_LINE_LENGTH` (Hard Rule 17).
   - **Post-Exit Buffered Output & Stdio Close Grace (`src/runner/child-completion.ts`)**: `waitForChildCompletion(child)` waits up to `STDIO_CLOSE_GRACE_MS` (2,000 ms) after `'exit'` for `'close'` so post-exit buffered `stdout`/`stderr` chunks are retained; if a descendant holds stdio open past grace, `waitForChildCompletion` settles with `stdioCloseTimedOut: true`, logs a warning, destroys local pipe readers, and (`claude-cli`) flushes any trailing line in `stdoutFramer`.
   - **Output Sink Backpressure (`src/runner/output-sink-backpressure.ts`)**: When `outputSink.write` returns `false`, the runner pauses the blocked stream and suspends the idle/settle timer until `onceDrain` fires on all blocked streams.
   - **Idle Window vs. Absolute Deadline**: `timeoutMs` bounds silence between unblocked chunks (`timedOut: true`); `maxDurationMs` arms a non-resetting wall-clock timer at spawn (`deadlineExceeded: true, timedOut: false`) that is not suspended by backpressure and wins on same-tick expiry.
   - **Cancellation & Process-Tree Confirmation (`src/runner/process-tree.ts`, `src/runner/teardown-ledger.ts`)**: `cancellationSignal` abort and `cancelActive()` run `escalateAndReportTree` (`SIGTERM` -> `SIGKILL` -> group probe) and register active ladders in `TeardownLedger` so `settleTeardowns(deadline)` awaits bounded process-tree confirmation before releasing execution ownership.
2. **Intentional Backend-Specific Completion Decoding (Qualified against `claude` 2.1.302 / 2.1.316, `codex-cli` 0.159.2 / 0.163.0, `agy` 1.4.2 / 1.4.12)**:
   - **`claude-cli`**: Decodes stream-json lines via `LineFramer` and arms `COMPLETION_SETTLE_MS` (15,000 ms) upon an accepted top-level `{"type":"result"}` envelope (subject to `BackgroundTaskTracker` holds and resumed-session history replay suppression), setting `sawTerminalResult: true` and (if the process lingers past the settle window, as observed in `Feature 030 BUG-002`) `completedAwaitingExit: true, timedOut: false, killed: false`.
   - **`codex-cli` and `agy-cli`**: Complete on process `'exit'` plus stdio `'close'` (`waitForChildCompletion`). Terminal JSON rows (`{"type":"turn.completed"}` in Codex; `{"event":"result"}` / `{"type":"result"}` in Agy) are captured as stream data rather than process-termination triggers, and `sawTerminalResult` / `completedAwaitingExit` are omitted (`undefined`), as pinned in `tests/unit/runner/{codex-cli,agy-cli}-lifecycle.test.ts` and `tests/lint/result-envelope-unknown-is-unwritten.test.ts`.

