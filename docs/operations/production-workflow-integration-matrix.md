# Production Workflow Integration and Support Boundary Matrix (`FR-R6-F01`)

**Declared**: 2026-11-09 (`specs/300-production-workflow-integration/spec.md`)

This runbook publishes the observed production support boundary for workflow control-plane execution, recovery, refusal categories, and cross-surface parity (`FR-022`). For control-flow authoring bounds, see [`docs/operations/workflow-control-recovery.md`](workflow-control-recovery.md).

---

## 1. Public Entry-Point Wiring Census (`FR-001`, `FR-016`)

Every public launch, continuation, retry, control command, headless API call, activation recovery pass, and terminal settlement transition reaches the shared `ProductionWorkflowComposition` (`src/services/workflow-execution/production-workflow-composition.ts`):

| Entry Point ID | Surface | Source Module | Supplied Collaborators |
|---|---|---|---|
| `ui.launchWorkflow` | Editor UI | `src/ui/sidebar/commands/cmd-launch-workflow.ts` → `src/services/workflow-execution/workflow-launcher.ts` | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `quotaPermitArbiter`, `backendAvailability`, `cutoverAuthorityGuard` |
| `ui.continueWorkflow` | Editor UI | `src/ui/sidebar/commands/cmd-continue-workflow.ts` → `src/services/workflow-execution/continuation-service.ts` | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `controlCommandService`, `durableHandoffSeam`, `cutoverAuthorityGuard` |
| `ui.retryWorkflow` | Editor UI | `src/services/workflow-execution/continuation-service.ts` | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `quotaPermitArbiter`, `controlCommandService`, `cutoverAuthorityGuard` |
| `ui.controlCommand` | Editor UI | `src/services/workflow-execution/control-command-service.ts` | `controlCommandService`, `quotaPermitArbiter`, `cutoverAuthorityGuard` |
| `headless.launchWorkflow` | Headless API | `src/headless/workflow-run-api.ts` | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `quotaPermitArbiter`, `backendAvailability`, `cutoverAuthorityGuard` |
| `headless.continueWorkflow` | Headless API | `src/headless/workflow-run-api.ts` | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `controlCommandService`, `durableHandoffSeam`, `cutoverAuthorityGuard` |
| `headless.controlCommand` | Headless API | `src/headless/workflow-run-api.ts` | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `controlCommandService`, `quotaPermitArbiter`, `cutoverAuthorityGuard` |
| `activation.recovery` | Host Activation | `src/activation/run-safety-wiring.ts` (`reconcileComposableWorkflowRuns`) | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `quotaPermitArbiter`, `backendAvailability`, `durableHandoffSeam`, `cutoverAuthorityGuard` |
| `activation.settlementTransition` | Host Settlement | `src/activation/run-safety-wiring.ts` (`recordConnectedWorkflowTransition`) | `controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `resultOperator`, `controlCommandService`, `quotaPermitArbiter`, `cutoverAuthorityGuard` |

---

## 2. Observed Control Path Support Matrix (`FR-002`–`FR-014`, `FR-020`, `FR-022`)

| Control Path / Capability | Status | Observed Behavior |
|---|---|---|
| Phase-first & control-first workflow roots | **Supported** | `launchWorkflow`, `launchComposableWorkflow`, and `launchComposableWorkflowRun` admit both Phase-first and control-first (`Repeat`, `ForEach`, `candidate-block`) roots through `ProductionWorkflowComposition`. |
| Candidate recovery blocks (`candidate-block`) | **Supported** | `CandidateBlockExecutor` is wired through `workflow-launcher.ts`, `connected-run-coordinator.ts`, `candidate-block-coordinator.ts`, `workflow-control-service.ts`, `workflow-recovery-service.ts`, and `ui-wiring.ts` (`controlProjectionsByInvocationId`). It selects candidates in `(priority, authoredOrder)` order, enforces per-candidate, block, and strict-USD budgets, commits `returnCommitId` once, and reconciles mid-switch crashes (`tests/integration/workflow-candidate-fallback-launch.test.ts`). |
| Scoped child-Workflow `Repeat` | **Supported** | `RepeatExecutor` initializes and advances pass frames in `ControlLedgerStore`, evaluates `until` against validated current-pass `decisionResults`, and carries declared primitive ports. |
| Sequential child-Workflow `ForEach` | **Supported** | `ForEachExecutor` freezes collection bytes and SHA-256 at entry, executes items in order, records per-slot results, and exports the ordered `resultIndex` only after all items settle. |
| Typed result evaluation at settlement (`ResultOperator`) | **Supported** | `recordConnectedWorkflowTransition` evaluates `phase.resultContract` via `evaluateAttemptWithPrecedence` before routing (`cancel/pause -> fatal -> malformed -> invalid result -> decision -> retry -> terminal failure`). Raw process exit `0` never implies semantic success when a typed result is required. |
| Shared-quota coordination & availability wakeups | **Supported** | `QuotaPermitArbiter` coordinates permits across queues; `recordAvailabilityWakeup` and `createBackendAvailabilityWiring` persist observations and notify the scheduler without spawning directly. |
| Strict monetary cost enforcement (`strict-cost`) | **Refused unless verified** | Refused pre-admission with `category: 'unsupported-capability'` (`attemptsConsumed: 0`) when the target backend lacks verified live pricing telemetry. Fixture adapters never promote live provider qualification status (`FR-010`). |
| Durable artifact handover (`FR-R6-F08` seam) | **Qualified when SQLite active; refused otherwise** | Desktop SQLite cutover (`src/activation/sqlite-cutover-wiring.ts`) wires a SQLite-backed `DurableArtifactHandoverSeam` over `ArtifactLifecycleService`; without an active SQLite seam, `ProductionWorkflowComposition` defaults to `unavailable` and refuses with `category: 'unsupported-capability'`, `reasonCode: 'durable-handoff-not-qualified'` (`attemptsConsumed: 0`). |
| Phase handoff eligibility & materialization (`FR-R8-02` / `02-02`) | **Supported (SQLite-backed)** | `PhaseHandoffCoordinator` enforces strict eligibility before downstream prompt injection (`approved`/`accepted` only; pending/rejected/superseded/expired/stale revisions refuse fail-closed with zero silent fallback). |
| Isolated execution lane recovery (`FR-R8-01` / `01-07`) | **Supported (SQLite + Git worktree)** | `src/commands/execution-lane-recovery.ts` exposes `schegent.inspectExecutionLanes` (read-only, untrusted-safe) and `schegent.recoverExecutionLane` (trusted primary owner only) over `LaneService`, with explicit recovery/cleanup actions for orphaned, stale, or failed lanes without touching dirty main-checkout work. |
| Post-cutover SQLite (`F04`) & ACP (`F13`) authority guard | **Guarded seam** | Wired via `CutoverAuthorityGuard` (`FR-017`). Under `post-cutover-strict`, any runtime disconnect, retired CLI runner fallback, or Memento store fallback is refused with `0` attempts consumed. |

---

## 3. Visible Refusal Taxonomy (`FR-018`)

Every refusal produces a structured `WorkflowRefusalOutcome` with a bounded message (`<= 240` chars, metadata-only audit by default):

1. `missing-collaborator` — Required collaborator (`controlAdmission`, `repeatExecutor`, `forEachExecutor`, `candidateBlockExecutor`, `resultOperator`, `backendAvailability`) is absent (`attemptsConsumed: 0`).
2. `unsupported-capability` — Backend capability is `unsupported`, `unavailable`, `unknown-identity`, fixture-only when live qualification is required, or F08/F13 authority is unavailable (`attemptsConsumed: 0`).
3. `quota-deferred` — Shared quota permit is currently held by another attempt; execution waits for availability wakeup and scheduler pass (`attemptsConsumed: 0`).
4. `stale-fence` — Window primacy or queue execution lease fence was lost before the effect boundary; refused with zero new children routed (`FR-012`).
5. `corrupt-state` — Persisted workflow run or control ledger record is corrupt or carries an unknown future schema version; isolated and preserved without silent coercion or deletion (`FR-014`).
6. `policy-refusal` — Workspace Trust or execution policy denies admission (`attemptsConsumed: 0`).
7. `budget-exceeded` — Resource ceiling exceeded (`maxQueues = 5`, `MAX_LIVE_CONTROL_ROOTS = 20` live control-ledger active roots enforced at admission with terminal-root eviction; `PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows = 25` outer matrix ceiling, `maxActiveFramesPerRoot = 16`, `maxForEachItems = 256`, or `minSettlementReserveSlots < 1`) (`SC-008`, `FR-R8-01` 01-01).

---

## 4. Eight-Checkpoint Interruption Recovery (`FR-011`, `FR-019`, `FR-R8-01` 01-09)

- **Tested candidate revision**: `HEAD` on branch `333-workflow-ownership-and-recovery`
- **Verification command**: `npx vitest run tests/integration/workflow-checkpoint-crash-matrix.test.ts`

Recovery is verified with real `SIGKILL` worker interruptions against disposable WAL SQLite stores and deterministic fake provider child processes immediately before and immediately after each of the eight persisted checkpoints (`tests/integration/workflow-checkpoint-crash-matrix.test.ts` + `tests/integration/helpers/workflow-checkpoint-crash-worker.ts`, alongside unit/contract checks in `tests/integration/production-workflow-integration.test.ts`). Each of the 16 named cases runs two consecutive restarts after `SIGKILL` (asserting identical converged state across both restarts) and independently compares provider receipts, queue rows, quota permits, control-ledger attempts, and terminal/paused projections:

| # | Crash Case (`timing` + `checkpoint`) | Crash Boundary | Receipts | Post-Recovery Converged State (2 Restarts) |
|---|---|---|---|---|
| 1 | `before prepared-root` | Before `prepareRootLink` | `0` | No persisted root, run, queue row, or permit (`rootLinkState: null`, `connectedRunStatus: null`, `queueRowCount: 0`) |
| 2 | `after prepared-root` | After `prepareRootLink` | `0` | Orphaned unstarted root cleaned up (`rootLinkState: null`, `connectedRunStatus: null`, `queueRowCount: 0`) |
| 3 | `before linked-root` | Before `activateRootLink` | `0` | Orphaned unstarted root cleaned up (`rootLinkState: null`, `connectedRunStatus: null`, `queueRowCount: 0`) |
| 4 | `after linked-root` | After `activateRootLink` | `0` | Orphaned unstarted root cleaned up (`rootLinkState: null`, `connectedRunStatus: null`, `queueRowCount: 0`) |
| 5 | `before admitted-attempt` | After `prepareAttempt`, before `commitAttempt` | `0` | Orphaned unstarted root and uncommitted attempt cleaned up (`rootLinkState: null`, `queueRowCount: 0`, `activePermitCount: 0`) |
| 6 | `after admitted-attempt` | After `commitAttempt`, before atomic enqueue | `0` | Orphaned unstarted root and permit cleaned up (`rootLinkState: null`, `queueRowCount: 0`, `activePermitCount: 0`) |
| 7 | `before pending-dispatch` | Immediately before `admitComposableWorkflowLaunchAtomically` | `0` | Orphaned unstarted root and permit cleaned up (`rootLinkState: null`, `queueRowCount: 0`, `activePermitCount: 0`) |
| 8 | `after pending-dispatch` | Immediately after atomic run + queue + ledger commit | `0` | Durable `in-flight` root (`rootLinkState: 'active'`, `queueRowCount: 1`, `attemptStage: 'pending-dispatch'`) |
| 9 | `before spawn-intent` | Immediately before `recordSpawnIntent` | `0` | Durable `in-flight` root (`rootLinkState: 'active'`, `queueRowCount: 1`, `attemptStage: 'pending-dispatch'`) |
| 10 | `after spawn-intent` | After `recordSpawnIntent` + fake provider receipt write, before `recordAttemptStarted` | `1` (no replay) | Side-effecting attempt transitions to `paused` (`manualPauseCause: 'recovery-uncertain-effect'`), `uncertainPermitCount: 1`, `activePermitCount: 0` |
| 11 | `before acknowledged-process` | Provider receipt written, immediately before `recordAttemptStarted` | `1` (no replay) | Transitions to `paused` (`manualPauseCause: 'recovery-uncertain-effect'`), `uncertainPermitCount: 1`, `activePermitCount: 0` |
| 12 | `after acknowledged-process` | Immediately after `recordAttemptStarted` with provider receipt | `1` (no replay) | Transitions to `paused` (`manualPauseCause: 'recovery-uncertain-effect'`), `uncertainPermitCount: 1`, `activePermitCount: 0` |
| 13 | `before settled-attempt` | Durable terminal `WorkflowRun` + `queue.finish`, before `settleAttempt` | `1` (no replay) | Converges to terminal `completed` (`rootLinkState: 'terminal'`, `rootStatus: 'completed'`, `activePermitCount: 0`, `uncertainPermitCount: 0`) |
| 14 | `after settled-attempt` | Immediately after `settleAttempt`, before `completeComposableNodeAttempt` | `1` (no replay) | Converges to terminal `completed` (`rootLinkState: 'terminal'`, `rootStatus: 'completed'`, `activePermitCount: 0`, `uncertainPermitCount: 0`) |
| 15 | `before terminal-projection` | Terminal `ConnectedWorkflowRun` committed, before `markRootTerminal` | `1` (no replay) | Converges to terminal `completed` (`rootLinkState: 'terminal'`, `rootStatus: 'completed'`, `activePermitCount: 0`, `uncertainPermitCount: 0`) |
| 16 | `after terminal-projection` | Immediately after full `terminal-projection` + `markRootTerminal` | `1` (no replay) | Remains idempotently `completed` (`rootLinkState: 'terminal'`, `rootStatus: 'completed'`, `activePermitCount: 0`, `uncertainPermitCount: 0`) |

An interruption after `spawn-intent` (or with a provider receipt but missing host acknowledgement) transitions a side-effecting attempt to `paused` (`manualPauseCause: 'recovery-uncertain-effect'`) and holds its quota permit in `uncertain` (`held-uncertain`) state rather than blindly respawning a duplicate child.

