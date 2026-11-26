# Historical Reporting 100,000-Attempt Query Performance Measurement (`FR-R6-F11` / `R7-17-02`)

**Measured**: 2026-11-25 · **Items**: `FR-R6-F11` (`NFR-002`, `NFR-004`, `NFR-005`), `FR-R7-17` (`R7-17-02`, `specs/331-feature-hardening-310-314/spec.md`)

This page records the reproducible performance measurement for historical reporting (`ReportingService`) against the 100,000-attempt reference fixture (`25,000` roots × `4` attempts, `200`-row pages) on an on-disk SQLite store, isolating warm-measured snapshot capture latency from total first-page latency and reporting explicit met/missed verdicts against the preserved specification targets.

<!-- Source: tests/perf/historical-report-query.test.ts -->
<!-- Source: tests/perf/budgets.json -->
<!-- Source: src/services/reporting/index.ts -->
<!-- Source: src/services/reporting/report-engine.ts -->
<!-- Source: src/services/reporting/snapshot-capture.ts -->

> **Single-platform qualification notice**: Every figure on this page was measured locally on one workstation (`darwin-arm64`, Apple M4 Max, local APFS, Node `v24.22.2`). These measurements provide single-platform risk reduction rather than a cross-platform guarantee; Linux and Windows hosts remain unobserved until measured on those platforms.

See [Historical Reports and Exports](historical-reporting.md) for the operator guide and bounds reference, and [Runtime Resource Budgets](runtime-resource-budgets.md) for the workspace-wide historical query limits.

---

## 1. Environment and Reference Fixture

| Field | Value |
|---|---|
| Date (UTC) | `2026-11-25` |
| Platform / architecture | `darwin-arm64` (`darwin` `27.0.0`) |
| CPU | Apple M4 Max (`16` cores) |
| Total memory | `65,536` MiB (`64` GiB) |
| Node.js runtime | `v24.22.2` |
| Fixture population | `25,000` roots × `4` attempts = `100,000` attempts (`2` steps per root, `30`-day window) |
| Fixture seed time | `1,776` ms (file-backed SQLite store in OS temp directory) |
| Page bound | `200` rows per page (`125` pages for `execution-summary`) |
| First-page & capture samples | `3` warm-up iterations, `20` warm-measured iterations (`sampleCount = 20`) |
| Later-page cursor samples | `20` warm-up iterations, `200` measured iterations (`F03` floor) |
| Reproduction command | `cd repo && npx vitest run --config vitest.perf.config.ts tests/perf/historical-report-query.test.ts` |

Warm-measured capture samples (`capture.sampleCount = 20`) are recorded strictly during the `20` measured `runReport` calls (`sample >= FIRST_PAGE_WARMUP`). Warm-up calls, the event-loop gap probe call (reported separately as `probedCaptureMs`), cancellation, `1 ms` deadline, and `attempt-detail` calls are excluded from `capture` percentiles so capture statistics are unpolluted. Event-loop probing (`probeGaps`) clears its pending `setImmediate` and snapshots its sample array on `stop()`, and `excludeSingleCaptureGap` drops only the single gap spanning the synchronous capture window (`slicedGaps.length === gaps.length - 1`) so any additional long event-loop stalls remain visible in `slicedP95Ms`.

---

## 2. Preserved Specification Targets, Enforced Ceilings, and Verdicts

| Requirement / Metric | Preserved Spec Target | Enforced CI Budget (`budgets.json`) | Measured Value | Spec Target Verdict | CI Budget Verdict |
|---|---|---|---|---|---|
| `NFR-002` First-page `execution-summary` (`p95`) | `<= 500 ms` (`SHOULD`) | `<= 1,000 ms` (`FIRST_PAGE_P95_BUDGET_MS`) | `306.03 ms` (`p50: 299.12 ms`, `max: 306.07 ms`) | **MET** (`firstPageShouldMet: true`, `-193.97 ms`) | **PASS** |
| Isolated warm snapshot capture (`20` samples) | Diagnostic separation | — | `p50: 202.43 ms`, `p95: 209.08 ms`, `max: 210.03 ms` (`probedCaptureMs: 205.32 ms`) | Diagnostic (~68% of first-page wall time) | — |
| `NFR-002` Later-page cursor read (`p95`) | `<= 500 ms` (`SHOULD`) | `<= 50 ms` (`LATER_PAGE_P95_BUDGET_MS`) | `0.1185 ms` (`p50: 0.0998 ms`, `p99: 0.1242 ms`, `max: 0.7038 ms`) | **MET** (`laterPageShouldMet: true`) | **PASS** |
| `NFR-005` Sliced host event-loop gap (`slicedP95Ms`) | `<= 10 ms` (`SHOULD`) | Informational (non-blocking) | `4.53 ms` (`count: 23` gaps; overall `p95: 5.01 ms`, `max: 211.45 ms`) | **MET** (`slicedGapShouldMet: true`, `-5.47 ms`) | Recorded |
| `NFR-004` Cancellation acknowledgement | `<= 1,000 ms` (`MUST`) | `<= 1,000 ms` (`CANCEL_ACK_BUDGET_MS`) | `4.28 ms` (`outcome: 'cancelled'`) | **MET** (`cancelAckMustMet: true`) | **PASS** |
| `NFR-004` Query deadline (`1 ms` probe vs `5,000 ms` default) | `limited / deadline-exceeded` | Asserted exact outcome | `{ ok: false, outcome: 'limited', limit: 'deadline-exceeded' }` | **MET** | **PASS** |
| Working-data cap on full-range `attempt-detail` | `limited / working-data` | Asserted exact outcome | `{ ok: false, outcome: 'limited', limit: 'working-data' }` | **MET** | **PASS** |

---

## 3. Detailed Breakdown and Resource Accounting

- **First-page `p95` (`306.03 ms`, down from `522.09 ms`) and sliced event-loop gap (`4.53 ms`, down from `16.22 ms`)**: Optimizing auxiliary ACP attribution capture to push null-filtering into SQL with a grouped `LEFT JOIN` (replacing a 100k-row correlated subquery scan), fast-pathing pre-sorted flat objects in `canonicalLine` with batched SHA-256 updates, sizing derived row arrays via `measureWorkingBytes`, reordering SQL-sorted `root-created-desc` groups in linear time, and sharing a `4 ms` engine slice budget across sequential `WorkSlicer.forEach` stages reduced warm capture to `p95: 209.08 ms` and post-capture JS work to `~97 ms` across `23` slices (`largestMs: [211.45, 5.01, 4.53, 4.08]`, `slicedP95Ms: 4.53 ms`).
- **Later-page cursor reads**: `maxBytes = 36,544` bytes per `200`-row page (well below the `1 MiB` page byte bound), `0` failures across `200` measured reads, `p95 = 0.1185 ms`.
- **Working-data memory (`execution-summary`)**: `22,120,000` bytes (`~21.10 MiB`) reserved during the live snapshot lease — within the `32 MiB` (`33,554,432` bytes) shared workspace budget. Full-range `attempt-detail` (`100,000` attempt rows on top of captured roots/attempts) exceeds `32 MiB` and returns the typed `limited / working-data` outcome rather than a silently shortened page.
- **Zero resource leaks**: After closing the live report and running the cancellation, deadline, and working-data probes, `service.resources()` verified `{ executing: 0, waiting: 0, reservedBytes: 0, liveReports: 0 }`.
