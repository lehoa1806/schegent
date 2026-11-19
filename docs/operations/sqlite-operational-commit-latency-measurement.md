# SQLite Operational State Commit Latency Measurement and Migration 9 Decision (`FR-R7-02`)

**Measured**: 2026-11-19 · **Item**: `FR-R7-02` (`specs/316-sqlite-per-entity-rows/spec.md`) · **Decision Gate Outcome**: **`PROCEED` (`proceed-migration-9`)** — Migration 9 shipped and post-migration verification passed within budget.

This page records the repeatable host-thread latency measurement for `SqliteOperationalBacking` over a real on-disk `WAL` + `PRAGMA synchronous = FULL` SQLite store, evaluates the pre-declared Round 6 event-loop budget decision gate, and reports the before/after distributions following Migration 9 (`009_fr_r7_02_operational_per_entity_rows`).

<!-- Source: tests/perf/sqlite-operational-commit-latency.test.ts -->
<!-- Source: tests/perf/helpers/sqlite-operational-latency-harness.ts -->
<!-- Source: src/state/sqlite-operational-backing.ts -->
<!-- Source: src/services/sqlite-store/operational-entity-schema.ts -->
<!-- Source: src/services/sqlite-store/schema-bootstrap.ts -->
<!-- Source: src/services/sqlite-store/backup-restore-service.ts -->

> **Single-platform qualification notice**: Every figure on this page was measured locally on one machine (`darwin/arm64`, Apple M4 Max, local APFS, Node `v24.22.2`, SQLite `3.53.4`). These figures provide single-platform risk reduction rather than a cross-platform guarantee; Linux (`ext4`/`xfs`) and Windows (`NTFS`) hosts remain unobserved until measured on those platforms.

---

## 1. Pre-Measurement Decision Gate Threshold (`FR-003`)

Declared in `specs/316-sqlite-per-entity-rows/spec.md` before executing the baseline benchmark, aligned to the Round 6 event-loop responsiveness budget in [`docs/operations/runtime-resource-budgets.md`](runtime-resource-budgets.md) §3 (`SC-003`):

| Gate Metric | Aggregation Rule | Budget Ceiling | Outcome Rule |
|---|---|---|---|
| Write-commit latency (`update` / `updateBatch`) | Maximum `p95` and maximum `p99` across all 3 isolated runs for every documented workload tier | `p95 <= 20 ms` **AND** `p99 <= 100 ms` | **Proceed with Migration 9** if any tier exceeds `p95 > 20 ms` OR `p99 > 100 ms`; otherwise **defer** |
| Commit-induced event-loop delay (`monitorEventLoopDelay`) | Maximum `p95` and maximum `p99` across all 3 isolated runs for every documented workload tier | `p95 <= 20 ms` **AND** `p99 <= 100 ms` | **Proceed with Migration 9** if any tier exceeds `p95 > 20 ms` OR `p99 > 100 ms`; otherwise **defer** |
| Read-clone (`get`) and `pruneConnectedRunsMap` | Reported separately for all 3 isolated runs per tier | Diagnostic separation (`FR-002`) | Exposes read/prune cost independently so fixes target the real bottleneck |

**Non-negotiable durability constraint**: Every run verifies via pragma read-back that `journal_mode = wal`, `synchronous = 2` (`FULL`), `foreign_keys = 1`, and `busy_timeout = 250` remain unchanged. Durability is never weakened to meet the budget.

**Sample sufficiency floor (`SC-002`)**: Every workload tier runs `3` isolated database directories on disk, each executing `20` warm-up samples followed by `200` steady-state measured samples (`220` raw samples per run), verified via `checkSampleSufficiency`.

---

## 2. Environment and Workload Tiers

### 2.1 Reference Host Metadata

| Field | Schema 8 Baseline Capture | Schema 9 Post-Migration Capture |
|---|---|---|
| Date (UTC) | 2026-11-19 | 2026-11-19 |
| Hardware / machine class | Apple M4 Max (16 cores, 64.0 GiB RAM) | Apple M4 Max (16 cores, 64.0 GiB RAM) |
| OS / architecture | macOS 27.0 (`darwin` 27.0.0, build `26A428`, `arm64`) | macOS 27.0 (`darwin` 27.0.0, build `26A428`, `arm64`) |
| Filesystem | Local APFS (journaled) | Local APFS (journaled) |
| Node.js runtime | `v24.22.2` | `v24.22.2` |
| SQLite engine (`node:sqlite`) | `3.53.4` (`WAL`, `synchronous = FULL`) | `3.53.4` (`WAL`, `synchronous = FULL`) |
| Host load average (`1m / 5m / 15m`) | `2.52 / 4.56 / 4.99` (isolated perf runner) | `1.75 / 3.74 / 4.11` (isolated perf runner) |
| Base commits | Master `ae19d6ac`, `repo/` `7fe86a18` + benchmark harness | Master `ae19d6ac`, `repo/` `7fe86a18` + Migration 9 tree |
| Reproduction command | `SCHEGENT_PRINT_R7_02_REPORT=1 npx vitest run --config vitest.perf.config.ts tests/perf/sqlite-operational-commit-latency.test.ts --reporter=verbose` | Same command |

### 2.2 Four Deterministic Workload Tiers (`FR-001`)

| Tier ID | Queues | Tasks / Queue (Total) | Live Runs | History Partitions × Entries (Total) | Connected Runs | Payload Bytes (`queue` / `run` / `history` / `connectedRuns`) |
|---|---|---|---|---|---|---|
| `baseline-small` | 1 | 10 (10) | 1 | 1 × 10 (10) | 5 | `4,495` / `1,890` / `2,937` / `10,109` B |
| `scenario-1-queue-500` | 1 | 500 (100 pending + 400 terminal) | 1 | 1 × 50 (50) | 32 | `244,597` / `1,892` / `14,765` / `64,926` B |
| `documented-max-capacity` | 20 | 100 (2,000 total) | 20 | 40 × 50 (2,000 total) | 512 | `867,838` / `37,878` / `630,560` / `1,041,430` B |
| `admission-atomic-batch` | 20 | 100 (2,000 total) | 20 | 40 × 50 (2,000 total) | 512 | `867,838` / `37,878` / `630,560` / `1,041,430` B |

---

## 3. Pre-Migration Baseline Measurements (Schema 8)

All values are in milliseconds (`ms`), showing the **maximum across all 3 isolated runs** (`20` warm-up + `200` steady-state samples per run) alongside the per-run `p95 / p99` range.

### 3.1 Schema 8 Write-Commit Distributions (ms)

| Tier ID | `writeQueue` worst p50 / p95 / p99 / max | `writeRun` worst p50 / p95 / p99 / max | `writeHistory` worst p50 / p95 / p99 / max | `writeConnectedRuns` worst p50 / p95 / p99 / max | `writeAdmissionBatch` worst p50 / p95 / p99 / max |
|---|---|---|---|---|---|
| `baseline-small` | 0.133 / 0.150 / 0.201 / 1.919 | 0.077 / 0.090 / 0.105 / 0.120 | 0.111 / 0.138 / 0.158 / 0.996 | 0.204 / 0.239 / 0.293 / 1.509 | — |
| `scenario-1-queue-500` | 0.900 / 1.038 / 1.601 / 3.166 | 0.074 / 0.105 / 0.134 / 0.275 | 0.113 / 0.134 / 0.161 / 1.185 | 0.974 / 1.088 / 2.624 / 4.588 | — |
| `documented-max-capacity` | 2.583 / 2.710 / 4.054 / 4.717 | 0.511 / 0.568 / 0.829 / 1.004 | 2.229 / 3.838 / 4.091 / 7.800 | 15.068 / **21.393** / 21.799 / 22.965 | — |
| `admission-atomic-batch` | 2.633 / 2.879 / 4.043 / 4.927 | 0.512 / 0.569 / 0.641 / 0.882 | 2.338 / 3.901 / 4.295 / 8.136 | 15.089 / **21.490** / 22.314 / 24.793 | 3.152 / 3.407 / 5.157 / 6.800 |

Per-run `writeConnectedRuns` p95 on the two maximum-capacity tiers (all 6 isolated runs exceeded `20 ms`):
- `documented-max-capacity`: run 1 = `21.069 ms`, run 2 = `21.346 ms`, run 3 = `21.393 ms`
- `admission-atomic-batch`: run 1 = `21.490 ms`, run 2 = `21.222 ms`, run 3 = `20.982 ms`

### 3.2 Schema 8 Read-Clone (`structuredClone`), Prune, and Event-Loop Delay (ms)

| Tier ID | `readQueueClone` worst p95 / p99 | `readRunClone` worst p95 / p99 | `readHistoryClone` worst p95 / p99 | `readConnectedRunsClone` worst p95 / p99 | `pruneConnectedRunsOnly` worst p95 / p99 | `eventLoopDelay` worst p50 / p95 / p99 / max |
|---|---|---|---|---|---|---|
| `baseline-small` | 0.010 / 0.017 | 0.007 / 0.010 | 0.034 / 0.040 | 0.056 / 0.064 | 0.020 / 0.026 | 1.294 / 1.334 / 1.383 / 2.537 |
| `scenario-1-queue-500` | 0.551 / 0.656 | 0.009 / 0.017 | 0.038 / 0.043 | 0.343 / 0.381 | 0.106 / 0.115 | 2.384 / 2.564 / 2.789 / 3.367 |
| `documented-max-capacity` | 1.649 / 2.188 | 0.164 / 0.231 | 1.360 / 1.623 | 5.440 / 6.275 | 1.595 / 1.854 | 3.813 / 4.127 / 8.180 / 12.009 |
| `admission-atomic-batch` | 1.598 / 1.796 | 0.139 / 0.156 | 1.405 / 1.760 | 5.395 / 6.335 | 1.580 / 1.701 | 4.289 / 4.661 / 4.981 / 5.902 |

---

## 4. Decision Gate Evaluation (`FR-003`)

- **Worst observed Schema 8 write-commit `p95`**: **`21.490 ms`** (`admission-atomic-batch/write_connected_runs_commit_ms`; `21.393 ms` on `documented-max-capacity/write_connected_runs_commit_ms`) — **exceeds the `20 ms` budget ceiling**.
- **Worst observed Schema 8 write-commit `p99`**: **`22.314 ms`** (`<= 100 ms`).
- **Worst observed Schema 8 commit-induced event-loop delay**: `p95 = 4.661 ms`, `p99 = 8.180 ms` (paced on `KEYS.queue` / `updateBatch([KEYS.run, KEYS.queue])`).
- **Root-cause decomposition exposed by the separated metrics**:
  1. Whole-document `operational_kv_documents` commits for `KEYS.queue` (868 KiB) and `updateBatch([KEYS.run, KEYS.queue])` took `2.879–3.407 ms` p95 / `4.054–5.157 ms` p99, of which `structuredClone` into cache alone consumed `~1.6 ms` and read-side `structuredClone` consumed another `1.65 ms` per call.
  2. Whole-map `KEYS.connectedRuns` writes (1.04 MiB, 512 entries) crossed the `20 ms` p95 budget (`21.490 ms`) because every single update combined (a) 512 `JSON.stringify` calls in `pruneConnectedRunsMap` (`1.6 ms`), (b) 512 unconditional `INSERT INTO runs ... ON CONFLICT DO UPDATE` upserts in `projectRelationalStateInTx` (`~10–14 ms`), and (c) a 1.04 MiB `structuredClone` into cache (`~5.0 ms`) plus `5.44 ms` per read.
- **Gate Verdict**: **`proceed-migration-9`** — FR-004 through FR-009 executed in full:
  - Migration 9 (`009_fr_r7_02_operational_per_entity_rows`, `SQLITE_SCHEMA_CURRENT_VERSION = 9`, `SQLITE_MIN_READER_VERSION = 9`) creating `STRICT` tables `operational_queue_meta`, `operational_tasks`, and `operational_runs` with transactional backfill and canonical SHA-256 digest verification.
  - Incremental entity-diff writes in `SqliteOperationalBacking` for Tasks, queue metadata, Runs, and relational `runs` projections (including diffed `KEYS.connectedRuns` projections and cached frozen byte lengths in `pruneConnectedRunsMap`).
  - Deep-frozen structurally-shared snapshot views returning in O(1) from `get()` with zero per-read `structuredClone`.
  - Full operational table coverage in `BackupRestoreService` and 18 real child-process `SIGKILL` crash-boundary tests.

---

## 5. Post-Migration Measurements (Schema 9) and Before/After Comparison (`SC-003`)

### 5.1 Schema 9 Write-Commit Distributions (ms — worst across 3 isolated runs)

| Tier ID | `writeQueue` worst p50 / p95 / p99 / max | `writeRun` worst p50 / p95 / p99 / max | `writeHistory` worst p50 / p95 / p99 / max | `writeConnectedRuns` worst p50 / p95 / p99 / max | `writeAdmissionBatch` worst p50 / p95 / p99 / max |
|---|---|---|---|---|---|
| `baseline-small` | 0.136 / 0.255 / 1.758 / 1.982 | 0.075 / 0.093 / 0.123 / 0.137 | 0.085 / 0.106 / 0.235 / 1.391 | 0.095 / 0.125 / 0.182 / 1.354 | — |
| `scenario-1-queue-500` | 0.187 / 0.226 / **0.438** / 2.382 | 0.070 / 0.093 / 0.121 / 0.663 | 0.079 / 0.095 / 0.109 / 0.479 | 0.179 / 0.226 / 0.497 / 2.009 | — |
| `documented-max-capacity` | 0.091 / 0.131 / **0.231** / 1.707 | 0.076 / 0.107 / 0.256 / 3.225 | 0.962 / **2.380** / 2.504 / 6.244 | 1.833 / 2.347 / 3.010 / 5.599 | — |
| `admission-atomic-batch` | 0.079 / 0.104 / **0.141** / 0.213 | 0.074 / 0.108 / 0.222 / 0.344 | 0.965 / 2.361 / 2.567 / 5.396 | 1.885 / 2.337 / 2.996 / 4.928 | 0.138 / 0.189 / **0.544** / 1.227 |

### 5.2 Schema 9 Read-View (`get`), Prune, and Event-Loop Delay (ms — worst across 3 isolated runs)

| Tier ID | `readQueueClone` worst p95 / p99 | `readRunClone` worst p95 / p99 | `readHistoryClone` worst p95 / p99 | `readConnectedRunsClone` worst p95 / p99 | `pruneConnectedRunsOnly` worst p95 / p99 | `eventLoopDelay` worst p50 / p95 / p99 / max |
|---|---|---|---|---|---|---|
| `baseline-small` | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | 0.004 / 0.010 | 1.296 / 1.339 / 1.391 / 1.479 |
| `scenario-1-queue-500` | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | 0.008 / 0.015 | 1.397 / 1.483 / 1.611 / 2.601 |
| `documented-max-capacity` | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | 0.189 / 0.319 | 1.311 / 1.377 / 1.498 / 1.797 |
| `admission-atomic-batch` | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | <0.001 / <0.001 | 0.205 / 0.326 | 1.356 / 1.478 / 1.700 / 2.022 |

Exact unrounded worst read-view latency across all 4 tiers and all 4 keys on schema 9: `p95 = 0.000208 ms`, `p99 = 0.000291 ms` (O(1) frozen reference return).

### 5.3 Before vs. After Summary (Schema 8 → Schema 9)

| Operation & Tier | Schema 8 Baseline (worst across 3 runs) | Schema 9 After (worst across 3 runs) | Reduction | Round 6 Budget (`p95 <= 20 ms`, `p99 <= 100 ms`) |
|---|---|---|---|---|
| **Overall worst write commit** | `p95 = 21.490 ms`, `p99 = 22.314 ms` (`writeConnectedRuns`) | **`p95 = 2.380 ms`, `p99 = 3.010 ms`** (`writeHistory` / `writeConnectedRuns`) | **9.0× lower p95**, **7.4× lower p99** | **Within budget** (8.4× headroom at p95) |
| **Single-Task write (`documented-max-capacity`, 2,000 Tasks)** (`SC-003`) | `p50 = 2.583 ms`, `p95 = 2.710 ms`, **`p99 = 4.054 ms`** | `p50 = 0.091 ms`, `p95 = 0.131 ms`, **`p99 = 0.231 ms`** | **17.5× lower p99** | **Within budget** |
| **Single-Task write (`scenario-1-queue-500`, 500 Tasks)** (`SC-003`) | `p50 = 0.900 ms`, `p95 = 1.038 ms`, **`p99 = 1.601 ms`** | `p50 = 0.187 ms`, `p95 = 0.226 ms`, **`p99 = 0.438 ms`** | **3.7× lower p99** | **Within budget** |
| **Atomic admission batch (`admission-atomic-batch`, 20 Runs + 2,000 Tasks)** | `p50 = 3.152 ms`, `p95 = 3.407 ms`, **`p99 = 5.157 ms`** | `p50 = 0.138 ms`, `p95 = 0.189 ms`, **`p99 = 0.544 ms`** | **9.5× lower p99** | **Within budget** |
| **Connected-runs write (`documented-max-capacity`, 512 entries)** | `p50 = 15.089 ms`, `p95 = 21.490 ms`, `p99 = 22.314 ms` | `p50 = 1.885 ms`, `p95 = 2.347 ms`, `p99 = 3.010 ms` | **9.2× lower p95**, **7.4× lower p99** | **Within budget** |
| **Worst read (`get()`) across all keys & tiers** | `p95 = 5.440 ms`, `p99 = 6.335 ms` (`structuredClone`) | **`p95 = 0.0002 ms`, `p99 = 0.0003 ms`** (frozen CoW view) | **>25,000× lower** | Zero whole-document clone |
| **`pruneConnectedRunsMap` (512 entries)** | `p95 = 1.595 ms`, `p99 = 1.854 ms` | **`p95 = 0.205 ms`, `p99 = 0.326 ms`** | **7.8× lower p95** | Cached frozen byte sizes |
| **Event-loop delay (`monitorEventLoopDelay`)** | `p95 = 4.661 ms`, `p99 = 8.180 ms` | **`p95 = 1.483 ms`, `p99 = 1.700 ms`** | **3.1× lower p95**, **4.8× lower p99** | **Within budget** |
| **Total perf-suite wall clock** | `53.75 s` | **`9.83 s`** | **5.5× faster** | — |

---

## 6. Residual Scope and Open Follow-Ups

- **Platform scope**: All measurements above are local single-platform observations (`darwin/arm64`, Apple M4 Max, local APFS). Linux and Windows hosts with slower fsync or rotating/networked storage may show higher absolute write latency and remain unobserved until captured there.
- **Durability preserved**: `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = FULL` remain enforced via read-back without relaxation. A dedicated worker-thread SQLite writer remains out of scope because post-migration `p95` (`2.380 ms`) and `p99` (`3.010 ms`) sit well inside the Round 6 host-thread budget.
- **Non-entity operational keys**: `KEYS.history` (631 KiB at 2,000 entries, `2.380 ms` p95) and `KEYS.connectedRuns` (1.04 MiB at 512 entries, `2.347 ms` p95) remain in `operational_kv_documents` while using frozen structurally-shared cache views and diffed relational `runs` projection. If future workload caps raise history or connected-run payloads significantly, those keys can be evaluated against the same benchmark harness.

