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
| Candidate recovery blocks (`candidate-block`) | **Supported** | `CandidateBlockExecutor` selects candidates in `(priority, authoredOrder)` order, enforces per-candidate and block attempt caps, and commits `returnCommitId` once. |
| Scoped child-Workflow `Repeat` | **Supported** | `RepeatExecutor` initializes and advances pass frames in `ControlLedgerStore`, evaluates `until` against validated current-pass `decisionResults`, and carries declared primitive ports. |
| Sequential child-Workflow `ForEach` | **Supported** | `ForEachExecutor` freezes collection bytes and SHA-256 at entry, executes items in order, records per-slot results, and exports the ordered `resultIndex` only after all items settle. |
| Typed result evaluation at settlement (`ResultOperator`) | **Supported** | `recordConnectedWorkflowTransition` evaluates `phase.resultContract` via `evaluateAttemptWithPrecedence` before routing (`cancel/pause -> fatal -> malformed -> invalid result -> decision -> retry -> terminal failure`). Raw process exit `0` never implies semantic success when a typed result is required. |
| Shared-quota coordination & availability wakeups | **Supported** | `QuotaPermitArbiter` coordinates permits across queues; `recordAvailabilityWakeup` and `createBackendAvailabilityWiring` persist observations and notify the scheduler without spawning directly. |
| Strict monetary cost enforcement (`strict-cost`) | **Refused unless verified** | Refused pre-admission with `category: 'unsupported-capability'` (`attemptsConsumed: 0`) when the target backend lacks verified live pricing telemetry. Fixture adapters never promote live provider qualification status (`FR-010`). |
| Durable artifact handover (`FR-R6-F08` seam) | **Refused (`unavailable`)** | Wired via `DurableArtifactHandoverSeam` and returns `category: 'unsupported-capability'`, `reasonCode: 'durable-handoff-not-qualified'` (`attemptsConsumed: 0`) until qualified by `FR-R6-F08` (`FR-020`). |
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
7. `budget-exceeded` — Resource ceiling exceeded (`maxQueues = 5`, `maxActiveRootWorkflows = 25`, `maxActiveFramesPerRoot = 16`, `maxForEachItems = 256`, or `minSettlementReserveSlots < 1`) (`SC-008`).

---

## 4. Eight-Checkpoint Interruption Recovery (`FR-011`, `FR-019`)

Recovery is verified immediately before and immediately after each of the eight persisted checkpoints (`tests/integration/production-workflow-integration.test.ts`):

1. `prepared-root`
2. `linked-root`
3. `admitted-attempt`
4. `pending-dispatch`
5. `spawn-intent`
6. `acknowledged-process`
7. `settled-attempt`
8. `terminal-projection`

An interruption after `spawn-intent` without an acknowledged child process transitions a side-effecting attempt to `paused` (`manualPauseCause: 'recovery-uncertain-effect'`) and holds its quota permit in `uncertain` state rather than blindly respawning a duplicate child.

