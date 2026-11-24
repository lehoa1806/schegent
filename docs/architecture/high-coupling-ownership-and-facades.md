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
| `src/activation/sqlite-cutover-wiring.ts` | `activation/` | 1,095 / 1,006 | Plain ceiling (`maxLines: 1,075` code lines) | Composition root for SQLite cutover: folder-scoped DB path resolution, passive read-only snapshot attachment, relocation, primary service graph construction (`SqliteCutoverServices`), explicit store lifecycle via `SqliteCutoverStoreRegistry` (`14-21`), and store-keyed `ProductionWorkflowComposition` registration/eviction (`N08`). | Pure activation wiring only; keep policy, containment helpers, and resource disposal in `sqlite-cutover-helpers.ts` and `sqlite-cutover-registry.ts`. |

### 2.1 The `controller/` ↔ `services/` Bidirectional Boundary & Candidate Graph Counts (`FR-R8-04` `04-03`)

The whole-tree first-party import graph (`src/` + `webview-ui/src/`, AST-parsed across `.ts`, `.tsx`, `.cts`, `.mts`, and `.svelte` `<script>` blocks with `.js`/`.jsx`/`.cjs`/`.mjs` → TypeScript specifier resolution in `tests/lint/import-graph-acyclic.test.ts`) measures on `2026-11-25`:

- **1,358** production modules (`src/` + `webview-ui/src/`, excluding tests and `.d.ts`)
- **3,822** resolved static runtime value edges (**0 cycles**, including **28** emitted `.js` → `.ts` value edges)
- **2,641** distinguished type-only edges (excluded from runtime cycle checks)
- **7** distinguished dynamic lazy `import()` edges (deferred route chunks, excluded from static cycle checks)

At the directory-layer level, `FR-R8-04` (`04-03`) enrolled `services/` into `LAYER_ALLOWED_VALUE_IMPORTS` (`tests/lint/architecture-layers.ts`, enforced by `tests/lint/layer-dependency-direction.test.ts`) so **any new unowned reverse value import from `services/` into `controller/`, `commands/`, `ui/`, `activation/`, `headless/`, or `root` fails the gate immediately**. The existing **11** `services/ → controller/` edges plus **2** `services/ → commands|ui` edges are reconciled under an exact-target, owner-attributed, shrink-only allowlist (`LAYER_IMPORT_ALLOWLIST`):

- **`controller/ → services/` (37 static value edges)**: allowed top-down orchestration (`workflow-controller.ts`, `phase-runner.ts`, gates, and recorders delegating to application services).
- **`services/ → controller/` (11 reconciled shrink-only edges, each owned in `LAYER_IMPORT_ALLOWLIST`)**:
  1. `src/services/run-driver.ts` → `src/controller/phase-runner.ts` (owner: `workflow-runtime`; invert via `PhaseExecutionPort` on next touch).
  2. `src/services/run-driver.ts` → `src/controller/phase-sequencer.ts` (owner: `workflow-runtime`; relocate pure sequencer or pass port).
  3. `src/services/run-driver.ts` → `src/controller/incomplete-turn-resume.ts` (owner: `workflow-runtime`; move pure classification helper to `contracts/` or `lib/`).
  4. `src/services/retry-coordinator.ts` → `src/controller/retry-handler.ts` (owner: `workflow-runtime`; move pure backoff math to `lib/`).
  5. `src/services/resume-admission-guard.ts` → `src/controller/run-admission.ts` (owner: `workflow-runtime`; relocate pure admission predicate to `contracts/`).
  6. `src/services/backend-availability-service.ts` → `src/controller/rate-limit-backoff.ts` (owner: `quota-and-availability`; relocate pure backoff math to `lib/`).
  7. `src/services/effective-limits.ts` → `src/controller/effective-phase-timeout.ts` (owner: `workflow-runtime`; relocate pure timeout resolver to `config/` or `contracts/`).
  8. `src/services/failure-record/failed-phase-notice.ts` → `src/controller/phase-control-decision.ts` (owner: `operator-evidence`; relocate pure `decidePhaseControl` to `contracts/`).
  9. `src/services/phase-context/attempt-result-publisher.ts` → `src/controller/phase-sidecar-reader.ts` (owner: `phase-handoff`; move pure sidecar reader to `services/phase-log/` or `lib/`).
  10. `src/services/run-planned-total.ts` → `src/controller/phase.ts` (owner: `workflow-runtime`; move pure phase ordering constants to `contracts/`).
  11. `src/services/runtime-resource-budgets/resource-inventory.ts` → `src/controller/backend-posture-recorder.ts` (owner: `resource-budgets`; move posture cache bound constant to `contracts/`).
- **`services/ → commands|ui` (2 reconciled shrink-only edges, owned in `LAYER_IMPORT_ALLOWLIST`)**:
  12. `src/services/diagnostics-bundle/bundle-collect.ts` → `src/commands/export-audit.ts` (owner: `operator-evidence`; extract shared counts-only audit sanitizer into `audit/`).
  13. `src/services/workflow-execution/workflow-control-projector.ts` → `src/ui/sidebar/phase-projector.ts` (owner: `workflow-runtime`; relocate pure phase-tile helper to `contracts/`).

**Boundary decision**: Every existing reverse edge is pinned by exact `(from, fromLayer, intoLayer, target)` in `LAYER_IMPORT_ALLOWLIST`, stale entries fail automatically as edges are retired, and any new unowned `services/` reverse import fails `tests/lint/layer-dependency-direction.test.ts` (verified by a seeded synthetic fixture). `src/state/` remains zero-exception (`0` allowlist entries) with transitive isolation from `queue/`, `parser/`, `services/`, `controller/`, and `ui/`.

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
| `production-workflow-composition.ts` | 1,084 | 986 | `< 1,000` entry condition | Composition factory wiring workflow-execution collaborators and the store-keyed `compositionCacheByStore` registry (`registerProductionWorkflowComposition`, `unregisterProductionWorkflowComposition`, `hasRegisteredProductionWorkflowComposition`, `getOrCreateProductionWorkflowComposition`, `createDesktopWorkflowComposition`) |

Three sibling modules sit near 990 raw lines (`foreach-executor.ts` at 995 raw / 941 code, `repeat-executor.ts` at 989 raw / 916 code, `foreach-collection-reader.ts` at 976 raw / 930 code) and remain below the 1,000-code-line entry condition. Any growth above `1,000` code lines automatically triggers the entry-condition gate in `tests/lint/source-loc-budget.test.ts`.

---

## 3. Store-Keyed Lifecycle & Multi-Store Isolation (`14-21` + `N08`)

`FR-R7-14` (`14-21`) consolidated the four cutover `WeakMap`s in `sqlite-cutover-wiring.ts` into `SqliteCutoverStoreRegistry` (`operationalMemento` → `catalogFs` → `workspaceLock` → `coordinator`, with strict reverse-order teardown). One remaining store-keyed `WeakMap` — `compositionCacheByStore` in `src/services/workflow-execution/production-workflow-composition.ts` — had no explicit eviction path and could retain stale `ProductionWorkflowComposition` instances (along with their `ControlWakeupPlanner` timers, ledgers, and handoff bridges) across Stage 2 workspace-folder resets or store teardown.

`FR-R7-18` (`N08`) closed that gap without changing registration order or adding speculative abstractions:

1. `src/services/workflow-execution/production-workflow-composition.ts` exports `unregisterProductionWorkflowComposition(store: object, expected?: ProductionWorkflowComposition): boolean` (evicts `store` from `compositionCacheByStore` when `expected` matches or is omitted, best-effort disposes the evicted composition's timers, and returns whether an entry was evicted) and `hasRegisteredProductionWorkflowComposition(store: object): boolean`.
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

### 4.3 Test-Only & Compatibility Facades (7 Files) + `COMMAND_GUARDS` (`FR-R8-04` `04-04`)

All 7 source-only headless facades below and the discriminator-only `COMMAND_GUARDS` registry (`src/contracts/sidebar-ipc.ts`) have **0** production runtime imports across `src/`, `webview-ui/src/`, and `scripts/` as of `2026-11-25`. None of them is an installed VSIX action (see [API and command reference](../reference/api-and-cli.md#source-only-headless-adapters-and-test-only-registries-fr-r8-04-04-04) for the installed-vs-source distinction):

| Module / Surface | Raw Lines | Supported Audience | Owner | Callers (Prod / Tests) | Verification or Retirement Condition |
|---|---:|---|---|---|---|
| `src/headless/backend-qualification-api.ts` | 145 | Source-level containment & qualification parity tests | Containment & qualification | 0 prod / 3 test files | Verified by qualification suites (`FR-R6-F09`); retire only if qualification inspection moves exclusively to installed commands/snapshots. |
| `src/headless/execution-lanes-api.ts` | 378 | Source-level execution-lane port parity tests (operator recovery uses installed `schegent.inspectExecutionLanes` / `schegent.recoverExecutionLane`) | Execution lanes | 0 prod / 4 test files | Verified by lane integration suites (`FR-R6-F10`); runbooks no longer require it (`01-07`). Retire after one release cycle if no external embedder adopts it. |
| `src/headless/pipeline-run-api.ts` | 79 | Legacy `Pipeline` launch compatibility tests | Legacy compatibility & migration | 0 prod / 4 test files | Cross-listed in [legacy-pipeline-caller-inventory.md](../operations/legacy-pipeline-caller-inventory.md); retire only after persisted Run/history deserializers no longer require `startPipelineRun` parity. |
| `src/headless/process-definition-api.ts` | 173 | Source-level definition validation parity tests | Catalog & process definitions | 0 prod / 2 test files | Verified against `Phase`/`Workflow` validators; retain while Feature 089 headless validation parity holds. |
| `src/headless/process-yaml-api.ts` | 458 | Source-level portable YAML byte-in/byte-out parity tests (installed UI uses `CMD_PREFLIGHT_PROCESS_YAML` / `CMD_EXPORT_PROCESS_YAML`) | Process-YAML exchange | 0 prod / 5 test files | Governed by `docs/hard-rules.md` portable YAML rules; retain as zero-`vscode` parity harness unless replaced by direct service tests. |
| `src/headless/telemetry-export-api.ts` | 30 | Source-level OTLP exporter parity tests | Telemetry & observability | 0 prod / 1 test file | Verified by telemetry unit suite (`FR-R6-F14`); retire if non-editor OTLP embedding is explicitly declined. |
| `src/headless/workflow-run-api.ts` | 385 | Source-level composable workflow parity & acceptance tests (installed UI uses `CMD_LAUNCH_WORKFLOW` / `CMD_CONTINUE_WORKFLOW`) | Workflow runtime | 0 prod runtime (`entry-point-wiring-census.ts` string metadata only) / 11 test files | Continuously verified by `production-workflow-integration.test.ts` and `workflow-capability-effects.test.ts`; retain as zero-`vscode` workflow parity seam. |
| `COMMAND_GUARDS` (`src/contracts/sidebar-ipc.ts`) | — | Host IPC contract exhaustiveness tests (production ingress is `validateInboundMessage`) | Sidebar IPC & contracts | 0 prod / 3 test files (`sidebar-ipc-drift.test.ts`, `catalog-version-not-accepted.test.ts`, `command-authority-routing.test.ts`) | Compile-time exhaustiveness witness over all 71 `COMMAND_TYPES`; retire only when descriptor-generated `validateInboundMessage` replaces every discriminator test without losing coverage. |

### 4.4 Cross-Reference to Legacy `Pipeline` Callers

Legacy `Pipeline` compatibility callers across the full host (`123` code-bearing files, `13` path-named files including `src/headless/pipeline-run-api.ts`) and webview (`35` code-bearing files, `44` path-named files including `PipelineBuilder.svelte` and `PipelineBuilderEditors/`) are cataloged separately in [legacy-pipeline-caller-inventory.md](../operations/legacy-pipeline-caller-inventory.md) (refreshed `2026-11-25`) and exercised against persisted records in `tests/integration/boundary-compatibility-matrix.test.ts`. Before retiring or relocating any of the 7 test-only headless facades above or any legacy `Pipeline` compatibility surface, confirm whether external headless parity contracts (Feature 089 / `entry-point-wiring-census.ts`) and persisted Run/history deserializers still depend on them.

---

## 5. Related Architecture & Operations Records

- [Composition Root Extraction (`FR-R3-119`)](composition-root-extraction.md) — records the shrink-only extraction history of `wireStage2()` and `src/extension.ts`.
- [Legacy `Pipeline` Compatibility Caller Inventory (`FR-R7-14` / `14-21`)](../operations/legacy-pipeline-caller-inventory.md) — dated inventory of all 158 host + webview legacy `Pipeline` callers and retirement prerequisites.
- [Durability Decision](durability-decision.md) and [Workspace Ownership Fencing](workspace-ownership-fencing.md) — storage, primacy, and commit-fencing boundaries that sit beneath the hotspots above.
