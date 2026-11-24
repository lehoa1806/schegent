# High-Coupling Ownership Boundaries & Headless Facade Inventory (`FR-R7-18` / `N08`)

**Measured**: 2026-11-24 · **Scope**: Host layer ownership for the remaining high-coupling hotspots named in `FR-R7-18` (`N08`), store-keyed lifecycle disposal boundaries, and a full AST-verified caller inventory of all 15 modules under `repo/src/headless/`.

This document records where each high-coupling dependency lives today, which layer owns it, how multi-store lifecycle isolation is enforced, and which `src/headless/` facades have live host callers versus test/compatibility callers. Per `FR-R7-18` (`N08`) and `AGENTS.md`, no speculative splits were performed outside the concrete lifecycle defect fixed in this cycle (`compositionCacheByStore` disposal on Stage 2 reset and cutover teardown).

<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/services/workflow-execution/production-workflow-composition.ts -->
<!-- Source: src/activation/sqlite-cutover-wiring.ts -->
<!-- Source: src/activation/sqlite-cutover-registry.ts -->
<!-- Source: tests/lint/architecture-layers.ts -->
<!-- Source: tests/integration/multi-store-isolation.test.ts -->

---

## 1. Prior Boundary Ownership (`FR-R7-07` and `FR-R7-14` / `14-21`)

Two Round 7 deliverables already set the structural guardrails that `N08` builds on without re-opening or speculatively refactoring them:

| Deliverable | Owned Scope | Guarding Mechanism / Artifact |
|---|---|---|
| **`FR-R7-07`** | Split `src/state/` into 9 focused key-family modules (`workspace-state.ts` + 8 `workspace-state-*.ts` siblings, each bounded by `STATE_MAX_FILE_LINES = 1,100`), kept `MementoWriteGate`, `OwnershipRegistry`, and the serialize chain map instantiated exclusively in `workspace-state.ts`, and eliminated all baseline `state/ → ACTING_LAYERS` value imports. | `tests/lint/architecture-layers.ts` (`LAYER_ALLOWED_VALUE_IMPORTS.state = ['state', 'contracts', 'lib', 'config', 'audit']`, empty `LAYER_IMPORT_ALLOWLIST`, `STATE_FORBIDDEN_TRANSITIVE_LAYERS = ['queue', 'parser', 'services', 'controller', 'ui']`) and `tests/lint/layer-dependency-direction.test.ts`. |
| **`FR-R7-14` (`14-21`)** | Defined the change-driven extraction posture for `src/queue/queue-manager.ts` and `webview-ui/src/components/PipelineBuilderEditors/workflow-catalog-state.ts` (1,712 raw lines): isolate only the scheduling, retry, clearing, Run, or editor responsibility touched by the next behavioral change rather than splitting speculatively. Replaced the four cutover `WeakMap`s with `SqliteCutoverStoreRegistry`, locked host/webview `MAX_WORKFLOW_NESTING_DEPTH = 8`, and inventoried legacy `Pipeline` compatibility callers. | `src/activation/sqlite-cutover-registry.ts`, `tests/unit/activation/sqlite-cutover-registry.test.ts`, `tests/lint/workflow-nesting-limit-parity.test.ts`, and [legacy-pipeline-caller-inventory.md](../operations/legacy-pipeline-caller-inventory.md). |

---

## 2. High-Coupling Core Hotspots & Layer Ownership

Measured on `2026-11-24` using `tests/lint/code-lines.ts` (`countFileCodeLines`) and raw line counts:

| Hotspot Module | Owning Layer | Size (raw / code lines) | Budget State (`source-loc-budget.test.ts`) | Owned Responsibilities & Collaborator Direction | Next-Change Rule (`N08`) |
|---|---|---|---|---|---|
| `src/queue/queue-manager.ts` | `queue/` | 2,469 / 1,477 | Waived (`highWaterMark` ratchet, `2026-05-22` decision) | Per-queue task lifecycle, pause/resume (`operator`/`cascade`/`retry-cap`), reorder/modify/remove, multi-queue CRUD, `clearCompleted`/`clearFailed`/`clearQueue`/`clearAll`, and drain/admission helpers (`peekNextPending`, `markInFlight`, `admitRun`, `finish`). Delegates pure rules to `task-transition-decision.ts`, `queue-lifecycle-refresh.ts`, `queue-reset-settle.ts`, `queue-registry.ts`, and persistence to `WorkspaceStateStore` (`state/`). | Owned by `FR-R7-14` (`14-21`) change-driven rule: extract only the single affected scheduling, retry, clearing, or Run responsibility when modifying it, and test through `QueueManager`'s existing public entry point. |
| `src/controller/phase-runner.ts` | `controller/` | 1,446 / 871 | Waived (`highWaterMark` ratchet, `2026-10-01` decision) | Single-phase CLI/ACP invocation lifecycle: pre-spawn runner policy, capability/consent/agent-config-ack gates, stdout/stream-json parsing, audit & raw-transcript evidence recording, session compaction, and native review collection. Already delegates leaf recorders (`phase-attempt-recorder.ts`, `backend-posture-recorder.ts`, `phase-sidecar-reader.ts`, `phase-retry-evaluator.ts`, `phase-outcome-mapper.ts`, `session-compactor.ts`, `native-review.ts`). | Keep evidence/policy decisions in single-purpose leaves; pass read-only ports from `services/` (`capability-refusal`, `backend-containment-policy`, `agent-config-ack-refusal`) rather than pulling store or UI state into `PhaseRunner`. |
| `src/services/run-driver.ts` | `services/` | 1,318 / 942 | Plain ceiling (`maxLines: 990` code lines) | Per-Run phase execution loop, cancellation `AbortController`, fence-loss abort, `PhaseSequencer` advancement, retry scheduling, checkpoint & mutation-ledger bracketing, and terminal transition funnel. | Keep terminal outcome handlers (`completed`, `failed`, probe-failure) as extraction targets when touched; avoid adding new `services/ → controller/` value imports (see Section 2.1). |
| `src/activation/sqlite-cutover-wiring.ts` | `activation/` | 1,144 / 1,039 | Plain ceiling (`maxLines: 1,075` code lines) | Composition root for SQLite cutover: folder-scoped DB path resolution, passive read-only snapshot attachment, relocation, primary service graph construction (`SqliteCutoverServices`), explicit store lifecycle via `SqliteCutoverStoreRegistry` (`14-21`), and store-keyed `ProductionWorkflowComposition` registration/eviction (`N08`). | Pure activation wiring only; keep policy, containment helpers, and resource disposal in `sqlite-cutover-helpers.ts` and `sqlite-cutover-registry.ts`. |

### 2.1 The `controller/` ↔ `services/` Bidirectional Boundary

The whole-tree file import graph is strictly acyclic (enforced by `tests/lint/import-graph-acyclic.test.ts`). At the directory-layer level, however, an AST scan of static relative value imports on `2026-11-24` measures a bidirectional boundary between `controller/` and `services/`:

- **`controller/ → services/` (36 static value edges)**:
  - `workflow-controller.ts` orchestrates 13 service modules (`auto-drain-coordinator`, `blocker-notice`, `execution-lease-release`, `failure-record/failure-record-service`, `history-recorder`, `mutation-plan`, `resume-admission-guard`, `retry-coordinator`, `run-driver`, `session-cleanup/session-cleanup-service`, `terminal-transition-coordinator`, `unattended-resume`, `workflow-run-factory`).
  - `phase-runner.ts`, `agent-config-ack-gate.ts`, `backend-posture-recorder.ts`, `capability-decision-recorder.ts`, `host-teardown-recorder.ts`, `start-failure-classification.ts`, and `uncontained-consent-gate.ts` import policy/refusal helpers from `services/`.
  - `incomplete-turn-resume.ts`, `native-review.ts`, `phase-control-service.ts`, `resume-pause-fields.ts`, `retry-handler.ts`, `workflow-leaf-end.ts`, and `workflow-lifecycle-auditor.ts` import focused service leaves.
- **`services/ → controller/` (11 static value edges)**:
  - `src/services/run-driver.ts` → `controller/phase-runner`, `controller/phase-sequencer`, `controller/incomplete-turn-resume` (3 edges — `RunDriver` was extracted from `WorkflowController` while keeping `PhaseRunner` and `PhaseSequencer` in `controller/`).
  - `src/services/retry-coordinator.ts` → `controller/retry-handler`.
  - `src/services/resume-admission-guard.ts` → `controller/run-admission`.
  - `src/services/backend-availability-service.ts` → `controller/rate-limit-backoff`.
  - `src/services/effective-limits.ts` → `controller/effective-phase-timeout`.
  - `src/services/failure-record/failed-phase-notice.ts` → `controller/phase-control-decision`.
  - `src/services/phase-context/attempt-result-publisher.ts` → `controller/phase-sidecar-reader`.
  - `src/services/run-planned-total.ts` → `controller/phase`.
  - `src/services/runtime-resource-budgets/resource-inventory.ts` → `controller/backend-posture-recorder`.

**Boundary decision**: Because `workflow-controller.ts` (`controller/`) owns top-level command orchestration and `run-driver.ts` (`services/`) drives `PhaseRunner`/`PhaseSequencer` (`controller/`), adding `controller` or `services` to `LAYER_ALLOWED_VALUE_IMPORTS` before resolving those 11 reverse edges would require an 11-entry allowlist. Rather than speculatively moving files in `N08`, future changes that touch any of those 11 modules should relocate pure decision/timeout/backoff helpers (`rate-limit-backoff`, `effective-phase-timeout`, `phase-control-decision`, `phase`, `run-admission`) down to `contracts/` or `lib/`, or invert execution callbacks through ports, before onboarding `controller/` and `services/` into `LAYER_ALLOWED_VALUE_IMPORTS`.

### 2.2 Large `src/services/workflow-execution/` Modules (10 Modules ≥ 990 Raw Lines)

Every module in `src/services/workflow-execution/` lives in the `services/` layer and participates in composable connected-workflow execution. Ten modules measure ≥ 990 raw lines on `2026-11-24`:

| Module (`src/services/workflow-execution/`) | Raw Lines | Code Lines | Ceiling (`source-loc-budget.test.ts`) | Owned Responsibility |
|---|---:|---:|---:|---|
| `candidate-block-executor.ts` | 1,921 | 1,752 | 1,840 | Multi-candidate block fan-out, scoring, selection, cancellation, and recovery settlement |
| `control-attempt-admission.ts` | 1,833 | 1,704 | 1,780 | Pre-admission authority, execution fence verification, and quota-permit admission gating |
| `quota-permit-arbiter.ts` | 1,780 | 1,587 | 1,670 | Per-backend concurrency/quota permit arbitration, contention queuing, and lease accounting |
| `connected-run-coordinator.ts` | 1,450 | 1,298 | 1,330 | Connected-workflow graph traversal, invocation-frame dispatch, and handoff advancement |
| `control-command-service.ts` | 1,326 | 1,231 | 1,295 | Operator control commands (`pause`, `resume`, `cancel`, `retry-phase`) over connected runs |
| `control-wakeup-planner.ts` | 1,273 | 1,124 | 1,185 | Cooldown and availability wakeup timer planning, reconciliation, and disposal |
| `workflow-control-service.ts` | 1,230 | 1,066 | 1,125 | Evidence-aware resume, leaf-phase control orchestration, and invocation-frame transitions |
| `control-usage-accounting.ts` | 1,167 | 1,019 | 1,075 | Composable workflow usage ledger rollups and control-ledger spend accounting |
| `workflow-recovery-service.ts` | 1,151 | 1,060 | 1,160 | Restart reconciliation, orphan cancellation, and recovery fence validation for connected runs |
| `production-workflow-composition.ts` | 1,018 | 929 | `< 1,000` entry condition | Composition factory wiring workflow-execution collaborators and the store-keyed `compositionCacheByStore` registry (`registerProductionWorkflowComposition`, `unregisterProductionWorkflowComposition`, `hasRegisteredProductionWorkflowComposition`, `getOrCreateProductionWorkflowComposition`) |

Three sibling modules sit just below 990 raw lines (`foreach-executor.ts` at 989 raw / 934 code, `repeat-executor.ts` at 989 raw / 916 code, `foreach-collection-reader.ts` at 976 raw / 930 code) and remain below the 1,000-code-line entry condition. Any growth above `1,000` code lines automatically triggers the entry-condition gate in `tests/lint/source-loc-budget.test.ts`.

---

## 3. Store-Keyed Lifecycle & Multi-Store Isolation (`14-21` + `N08`)

`FR-R7-14` (`14-21`) consolidated the four cutover `WeakMap`s in `sqlite-cutover-wiring.ts` into `SqliteCutoverStoreRegistry` (`operationalMemento` → `catalogFs` → `workspaceLock` → `coordinator`, with strict reverse-order teardown). One remaining store-keyed `WeakMap` — `compositionCacheByStore` in `src/services/workflow-execution/production-workflow-composition.ts` — had no explicit eviction path and could retain stale `ProductionWorkflowComposition` instances (along with their `ControlWakeupPlanner` timers, ledgers, and handoff bridges) across Stage 2 workspace-folder resets or store teardown.

`FR-R7-18` (`N08`) closed that gap without changing registration order or adding speculative abstractions:

1. `src/services/workflow-execution/production-workflow-composition.ts` exports `unregisterProductionWorkflowComposition(store: object): boolean` (evicts `store` from `compositionCacheByStore`, best-effort disposes the evicted composition's timers, and returns whether an entry existed) and `hasRegisteredProductionWorkflowComposition(store: object): boolean`.
2. `src/activation/sqlite-cutover-wiring.ts` invokes `unregisterProductionWorkflowComposition(store)` inside `resetCutoverStage2(store)` (`finally`), `disposeCutoverStore(store)` (`finally`), coordinator `close()`, and partial-initialization cleanup (`cleanupPartial`), so Stage 2 resets and store teardown never leak stale compositions across re-wiring.
3. `tests/integration/multi-store-isolation.test.ts` proves strict dual-store isolation across two independent `WorkspaceStateStore` instances (`storeA` and `storeB`) through public routes:
   - Cutover registration, primary SQLite activation, Stage 2 reset on `storeA` (evicting `storeA`'s composition while leaving `storeB`'s registration, coordinator, and composition intact and functional), Stage 2 re-wire on `storeA`, and full disposal of `storeA` (`CUTOVER_REGISTRATION_DISPOSED`) without affecting `storeB`.
   - Concurrent `QueueManager` enqueue, reorder, modify, pause/resume, secondary-queue creation, and removal across `storeA` and `storeB` with exact per-store ordering and zero cross-store leakage.
   - Concurrent `SchegentWorkflowController` / `RunDriver` / `PhaseRunner` / `HistoryStore` execution across `storeA` and `storeB` driven through deterministic deferred barriers, asserting isolated run state, persisted history chronology, and workspace audit logs.

---

## 4. Headless Facade Compatibility Caller Inventory (Dated `2026-11-24`)

Every module under `repo/src/headless/` is governed by `docs/hard-rules.md` rule 13 (zero `vscode` imports). An AST import scan on `2026-11-24` across all non-test production sources (`repo/src/`, `repo/webview-ui/src/`, `repo/scripts/`) and all test files (`repo/tests/`) classifies all **15** files in `repo/src/headless/` into three groups:

- **7 live production-wired facades** (imported by host activation, command handlers, or sidebar router types)
- **1 shared internal headless helper** (`process-api-validators.ts`, imported by 4 headless facades and 0 non-headless production files)
- **7 test-only / compatibility facades** (0 non-test production value or type imports across `src/`, `webview-ui/src/`, and `scripts/`)

### 4.1 Live Production-Wired Facades (7 Files)

| Module (`src/headless/`) | Raw Lines | Production Value Callers | Production Type-Only Callers | Internal `headless/` Callers | Test Files | Primary Role |
|---|---:|---|---|---|---:|---|
| `artifact-lifecycle-api.ts` | 135 | `src/activation/sqlite-cutover-wiring.ts` | *(none)* | *(none)* | 3 | Validated storage inventory/pressure, deletion/retention/archival previews, and `createStorageDetailsReader` |
| `backup-restore-api.ts` | 705 | `src/activation/sqlite-backup-commands-wiring.ts` | `src/commands/sqlite-backup-restore.ts` | *(none)* | 9 | Guarded SQLite online backup, listing, read-only verification, external dependency checks, and full-authority restore |
| `change-review-api.ts` | 117 | `src/activation/round6-visibility-wiring.ts` | `src/ui/sidebar/commands/router-types.ts` | *(none)* | 3 | Trust- and input-validated change-review list/detail/diff/open/close facade |
| `execution-visibility-api.ts` | 916 | `src/activation/round6-visibility-wiring.ts` | `src/ui/sidebar/commands/router-types.ts` | *(none)* | 2 | Bounded SQLite projections for attempt hierarchy, evidence availability, live log gaps, recovery handoff, and ACP posture |
| `phase-context-api.ts` | 101 | `src/activation/round6-visibility-wiring.ts`, `src/activation/sqlite-cutover-wiring.ts` | `src/ui/sidebar/commands/router-types.ts` | `src/headless/execution-visibility-api.ts` (type-only) | 6 | Metadata-only inspection and manual approval/edit facade for phase-to-phase context handoffs |
| `reporting-api.ts` | 123 | `src/activation/round6-visibility-wiring.ts` | `src/ui/sidebar/commands/router-types.ts` | *(none)* | 3 | Input- and trust-validated reporting query and export facade |
| `usage-accounting-api.ts` | 64 | `src/activation/sqlite-cutover-wiring.ts`, `src/ui/sidebar/commands/cmd-read-usage-accounting.ts` | *(none)* | *(none)* | 3 | Validated usage accounting query, coverage-gap, and provider-qualification reader (`createUsageAccountingReader`, `queryUsageAccounting`) |

### 4.2 Shared Internal Headless Helper (1 File)

| Module (`src/headless/`) | Raw Lines | Production Value Callers | Internal `headless/` Value Callers | Test Files | Primary Role |
|---|---:|---|---|---:|---|
| `process-api-validators.ts` | 148 | *(none outside `src/headless/`)* | `pipeline-run-api.ts`, `process-definition-api.ts`, `process-yaml-api.ts`, `workflow-run-api.ts` | 1 | Shared boundary argument validation delegating value bounds to `src/contracts/runtime-validators.ts` |

### 4.3 Test-Only & Compatibility Facades (7 Files)

All 7 files below have **0** production value imports, **0** production type-only imports, **0** `webview-ui/src/` imports, and **0** `scripts/` imports as of `2026-11-24`:

| Module (`src/headless/`) | Raw Lines | Prod Callers | Test Files | Compatibility / Qualification Role & Non-Import References |
|---|---:|---:|---:|---|
| `backend-qualification-api.ts` | 145 | 0 | 3 | Pure read-only headless inspection of backend bound qualification and spawn admission (`FR-R6-F09`). |
| `execution-lanes-api.ts` | 377 | 0 | 4 | Editor-independent execution-lanes port (`FR-R6-F10`) wrapping `LaneService` with input freezing and validation. |
| `pipeline-run-api.ts` | 79 | 0 | 4 | Legacy `Pipeline` headless run launcher delegating to `startPipelineRun()` (Feature 089); cross-listed as a path-named legacy `Pipeline` module in [legacy-pipeline-caller-inventory.md](../operations/legacy-pipeline-caller-inventory.md). |
| `process-definition-api.ts` | 173 | 0 | 2 | Headless definition validation adapter for `Phase`, `Pipeline`, and `Workflow` definitions (Feature 089). |
| `process-yaml-api.ts` | 458 | 0 | 5 | Headless byte-in/byte-out portable process-YAML preview/import/export facade (`docs/hard-rules.md` rule 48). Referenced only in comments in `src/services/process-yaml/types.ts` and `webview-ui/src/components/ProcessImport/process-import-state.ts` (zero runtime imports). |
| `telemetry-export-api.ts` | 30 | 0 | 1 | Editor-independent OpenTelemetry export entry point (`FR-R6-F14`) sharing host normalization, policy, and SQLite spool logic. |
| `workflow-run-api.ts` | 383 | 0 | 10 | Headless composable workflow launch, continuation, control-command, and recovery facade (Feature 089 / Round 5–6). Referenced as a string `modulePath` entry in `src/services/workflow-execution/entry-point-wiring-census.ts` (zero runtime imports). |

### 4.4 Cross-Reference to Legacy `Pipeline` Callers

Legacy `Pipeline` compatibility callers across the full host (`121` code-bearing files, `13` path-named files including `src/headless/pipeline-run-api.ts`) and webview (`35` code-bearing files, `44` path-named files including `PipelineBuilder.svelte` and `PipelineBuilderEditors/`) are cataloged separately in [legacy-pipeline-caller-inventory.md](../operations/legacy-pipeline-caller-inventory.md). Before retiring or relocating any of the 7 test-only headless facades above or any legacy `Pipeline` compatibility surface, confirm whether external headless parity contracts (Feature 089 / `entry-point-wiring-census.ts`) and persisted Run/history deserializers still depend on them.

---

## 5. Related Architecture & Operations Records

- [Composition Root Extraction (`FR-R3-119`)](composition-root-extraction.md) — records the shrink-only extraction history of `wireStage2()` and `src/extension.ts`.
- [Legacy `Pipeline` Compatibility Caller Inventory (`FR-R7-14` / `14-21`)](../operations/legacy-pipeline-caller-inventory.md) — dated inventory of all 156 host + webview legacy `Pipeline` callers and retirement prerequisites.
- [Durability Decision](durability-decision.md) and [Workspace Ownership Fencing](workspace-ownership-fencing.md) — storage, primacy, and commit-fencing boundaries that sit beneath the hotspots above.
