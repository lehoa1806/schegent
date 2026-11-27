# Historical Reporting 100,000-Attempt Query Performance Measurement (`FR-R6-F11` / `R7-17-02`)

**Measured**: 2026-11-26 · **Items**: `FR-R6-F11` (`NFR-002`, `NFR-004`, `NFR-005`), `FR-R7-17` (`R7-17-02`, `specs/331-feature-hardening-310-314/spec.md`)

This page records the reproducible performance measurement for historical reporting (`ReportingService`) against the 100,000-attempt reference fixture (`25,000` roots × `4` attempts, `200`-row pages) on an on-disk SQLite store, isolating warm-measured snapshot capture latency from total first-page latency and reporting explicit met/missed verdicts against the preserved specification targets.

<!-- Source: tests/perf/historical-report-query.test.ts -->
<!-- Source: tests/perf/budgets.json -->
<!-- Source: src/services/reporting/index.ts -->
<!-- Source: src/services/reporting/report-engine.ts -->
<!-- Source: src/services/reporting/snapshot-capture.ts -->
<!-- Source: src/services/reporting/run-snapshot-worker.ts -->
<!-- Source: src/services/reporting/run-snapshot-worker-entry.ts -->

> **Single-platform qualification notice**: Every figure on this page was measured locally on one workstation (`darwin-arm64`, Apple M4 Max, local APFS, Node `v24.22.2`). These measurements provide single-platform risk reduction rather than a cross-platform guarantee; Linux and Windows hosts remain unobserved until measured on those platforms.

See [Historical Reports and Exports](historical-reporting.md) for the operator guide and bounds reference, and [Runtime Resource Budgets](runtime-resource-budgets.md) for the workspace-wide historical query limits.

---

## 1. Environment and Reference Fixture

| Field | Value |
|---|---|
| Date (UTC) | `2026-11-26` |
| Platform / architecture | `darwin-arm64` (`darwin` `27.0.0`) |
| CPU | Apple M4 Max (`16` cores) |
| Total memory | `65,536` MiB (`64` GiB) |
| Node.js runtime | `v24.22.2` |
| Fixture population | `25,000` roots × `4` attempts = `100,000` attempts (`2` steps per root, `30`-day window) |
| Fixture seed time | `1,759` ms (file-backed SQLite store in OS temp directory) |
| Page bound | `200` rows per page (`125` pages for `execution-summary`) |
| First-page & capture samples | `3` warm-up iterations, `20` warm-measured iterations (`sampleCount = 20`) |
| Later-page cursor samples | `20` warm-up iterations, `200` measured iterations (`F03` floor) |
| Reproduction command | `cd repo && npx vitest run --config vitest.perf.config.ts tests/perf/historical-report-query.test.ts` |

Warm-measured capture samples (`capture.sampleCount = 20`) are recorded strictly during the `20` measured `runReport` calls (`sample >= FIRST_PAGE_WARMUP`). Warm-up calls, the event-loop gap probe call (reported separately as `probedCaptureMs`), cancellation, `1 ms` deadline, and `attempt-detail` calls are excluded from `capture` percentiles so capture statistics are unpolluted. Event-loop probing (`probeGaps`) clears its pending `setImmediate` and snapshots its sample array on `stop()`, and `excludeSingleCaptureGap` drops only the single gap spanning the synchronous capture window (`slicedGaps.length === gaps.length - 1`) so any additional long event-loop stalls remain visible in `slicedP95Ms`.

---

## 2. Preserved Specification Targets, Enforced Ceilings, and Verdicts

| Requirement / Metric | Preserved Spec Target | Enforced CI Budget (`budgets.json`) | Measured Value | Spec Target Verdict | CI Budget Verdict |
|---|---|---|---|---|---|
| `NFR-002` First-page `execution-summary` (`p95`) | `<= 500 ms` (`SHOULD`) | `<= 1,000 ms` (`FIRST_PAGE_P95_BUDGET_MS`) | `292.88 ms` (`p50: 282.25 ms`, `max: 295.51 ms`) | **MET** (`firstPageShouldMet: true`, `-207.12 ms`) | **PASS** |
| Isolated warm snapshot capture (`20` samples) | Diagnostic separation | — | `p50: 190.69 ms`, `p95: 201.03 ms`, `max: 207.16 ms` (`probedCaptureMs: 189.66 ms`) | Diagnostic (~68% of first-page wall time) | — |
| `NFR-002` Later-page cursor read (`p95`) | `<= 500 ms` (`SHOULD`) | `<= 50 ms` (`LATER_PAGE_P95_BUDGET_MS`) | `0.1117 ms` (`p50: 0.0941 ms`, `p99: 0.1644 ms`, `max: 0.6771 ms`) | **MET** (`laterPageShouldMet: true`) | **PASS** |
| `NFR-005` Sliced host event-loop gap (`slicedP95Ms`) | `<= 10 ms` (`SHOULD`) | Informational (non-blocking) | `4.15 ms` (`count: 21` gaps; overall `p95: 4.48 ms`, `max: 195.30 ms`) | **MET** (`slicedGapShouldMet: true`, `-5.85 ms`) | Recorded |
| `NFR-004` Cancellation acknowledgement | `<= 1,000 ms` (`MUST`) | `<= 1,000 ms` (`CANCEL_ACK_BUDGET_MS`) | `4.59 ms` (`outcome: 'cancelled'`) | **MET** (`cancelAckMustMet: true`) | **PASS** |
| `NFR-004` Query deadline (`1 ms` probe vs `5,000 ms` default) | `limited / deadline-exceeded` | Asserted exact outcome | `{ ok: false, outcome: 'limited', limit: 'deadline-exceeded' }` | **MET** | **PASS** |
| Working-data cap on full-range `attempt-detail` | `limited / working-data` | Asserted exact outcome | `{ ok: false, outcome: 'limited', limit: 'working-data' }` | **MET** | **PASS** |

---

## 3. Detailed Breakdown and Resource Accounting

- **First-page `p95` (`292.88 ms`, down from `522.09 ms`) and sliced event-loop gap (`4.15 ms`, down from `16.22 ms`)**: Optimizing auxiliary ACP attribution capture with a transaction-scoped `acp_observation_ledger` empty-table fast path plus indexed per-attempt correlated subquery + SQL `IS NOT NULL` / `EXISTS` filtering when populated (avoiding both 100k-row empty probes and full-ledger `GROUP BY` scans on narrow windows), fast-pathing pre-sorted flat objects in `canonicalLine` with batched SHA-256 updates, sizing derived row arrays via `measureWorkingBytes`, reordering SQL-sorted `root-created-desc` groups in linear time, and sharing a `4 ms` engine slice budget across sequential `WorkSlicer.forEach` stages (with accurate non-double-counted slice accounting and external-gap reset) reduced warm capture to `p95: 201.03 ms` and post-capture JS work to `~92 ms` across `21` slices (`largestMs: [195.30, 4.48, 4.15, 4.08]`, `slicedP95Ms: 4.15 ms`).
- **Later-page cursor reads**: `maxBytes = 36,544` bytes per `200`-row page (well below the `1 MiB` page byte bound), `0` failures across `200` measured reads, `p95 = 0.1117 ms`.
- **Working-data memory (`execution-summary`)**: `22,120,000` bytes (`~21.10 MiB`) reserved during the live snapshot lease — within the `32 MiB` (`33,554,432` bytes) shared workspace budget. Full-range `attempt-detail` (`100,000` attempt rows on top of captured roots/attempts) exceeds `32 MiB` and returns the typed `limited / working-data` outcome rather than a silently shortened page.
- **Zero resource leaks**: After closing the live report and running the cancellation, deadline, and working-data probes, `service.resources()` verified `{ executing: 0, waiting: 0, reservedBytes: 0, liveReports: 0 }`.

---

## 4. Head-to-Head Synchronous vs Read-Only Worker Capture (2026-11-27)

To eliminate the `~200 ms` unfiltered extension-host event-loop stall during synchronous SQLite snapshot capture on file-backed stores (post-merge review Finding 5; refactored under F-09 to replace `eval: true` template strings with typed worker entry modules and explicit V8 `resourceLimits`), `ReportingService` defaults to a read-only `node:worker_threads` capture worker (`src/services/reporting/run-snapshot-worker.ts` dispatching the typed, erasable-TS entry module `src/services/reporting/run-snapshot-worker-entry.ts`, bundled by esbuild to `dist/run-snapshot.worker.js` for production VSIX packaging and run directly from `.ts` source via Node's built-in type stripping in Vitest) for file-backed SQLite databases (`useSnapshotWorker !== false`; `:memory:` fixtures and explicit `useSnapshotWorker: false` keep synchronous capture). The worker runs under explicit `resourceLimits` (`maxOldGenerationSizeMb: 256`, `maxYoungGenerationSizeMb: 32`, `stackSizeMb: 4`, mapping `ERR_WORKER_OUT_OF_MEMORY` cleanly to `limited / working-data`), opens the database read-only (`PRAGMA query_only = ON`, `PRAGMA busy_timeout = 2000`), executes the consistent `BEGIN DEFERRED ... ROLLBACK` snapshot read, releases the read transaction immediately before streaming, and streams chunks (`4,000` rows per chunk) back to the extension host with per-chunk `setImmediate` backpressure so the host event loop yields between chunks and honors mid-capture `AbortSignal` cancellation and query deadlines.

Measured head-to-head in a single invocation of `tests/perf/historical-report-query.test.ts` on `2026-11-27` (`darwin-arm64`, Apple M4 Max, Node `v24.22.2`, `25,000` roots × `4` attempts = `100,000` attempts) after migrating to the typed worker entry and explicit `resourceLimits`:

| Metric | Synchronous capture (`useSnapshotWorker: false`) | Default read-only chunked worker (`useSnapshotWorker: true`) |
|---|---|---|
| First-page `execution-summary` (`p50` / `p95` / `max`) | `295.36 ms` / `304.76 ms` / `325.21 ms` | `394.19 ms` / `488.89 ms` / `804.46 ms` (`<= 500 ms` spec target, `<= 1,000 ms` CI budget) |
| Unfiltered end-to-end host event-loop gap (including capture) | `199.00 ms` max (`4.13 ms` post-capture `slicedP95Ms`) | `0.25 ms` `p95` of `p95`, `10.70 ms` `p95` of max, `11.70 ms` worst max across `20` measured runs |
| Worker SQL read / total worker (`p95`) | `203.61 ms` (on host thread) | `236.15 ms` SQL read / `370.38 ms` total worker (off host thread) |
| Mid-capture cancellation acknowledgement (`20 ms` after start) | `4.69 ms` (only after synchronous capture completes) | `0.37 ms` (`outcome: 'cancelled'`) |
| Concurrent host settlement writes during full capture | Blocked during `~200 ms` synchronous capture | `23` writes committed (`0.67 ms` max write latency) |
| `PRAGMA wal_checkpoint(TRUNCATE)` immediately after capture | `busy: 0` | `busy: 0` (read transaction rolled back before chunk streaming) |
| Process RSS delta across `23` full captures (`3` warm-up + `20` measured) | Baseline | `+192.6 MiB` (`1,645.4 MiB` → `1,838.0 MiB` peak) |
| Query deadline (`1 ms` probe) & zero resource leaks | `limited / deadline-exceeded`; `0` active/reserved | `limited / deadline-exceeded`; `0` active/reserved |

Auxiliary snapshot tables (`evidenceRefs`, `acpAttributions`, `handoffSummaries`, `reviewSummaries`) in both synchronous and worker capture paths query `LIMIT cap + 1` and record a `{ what, reason: 'snapshot-rows-truncated' }` omission whenever rows exceed the configured capture ceiling, propagating that omission into `ReportPage.omissions`, `RootDrillDown.omissions`, and `ReportManifest.omissions`.
