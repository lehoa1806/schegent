# Stage 2 Startup and 5 MiB Audit Chain Verification Measurement (`FR-R7-18` / `N05`)

**Measured**: 2026-11-24 · **Item**: `FR-R7-18` (`N05`, `FR-005`, `SC-005`, `specs/332-recovery-verification-gaps/spec.md`) · **Decision Gate Outcomes**:
- **Stage 2 Activation While Sidebar Opens**: **`DEFER`** — end-to-end Stage 2 time to first live sidebar `STATE_SNAPSHOT` measured `36.989–43.855 ms` p50 (`38.381–50.905 ms` p95/max), ~10× below the `500 ms` threshold; no Stage 2 restructuring applied.
- **On-Demand Whole-File Audit Verification (`5 MiB` Rotation Boundary)**: **`OPTIMIZE`** — baseline synchronous verification on a 4-file / `20.00 MiB` retained chain stalled the extension host event loop for `65.241 ms` p50 / `73.335 ms` p95 (`monitorEventLoopDelay` max) and `69.750 ms` p50 / `77.660 ms` p95 (`setImmediate` gap), breaching the `> 50 ms` threshold; bounded async chunked yielding (`DEFAULT_VERIFY_CHUNK_LINES = 512`) shipped in `verifyChainAsync` / `verifyAuditChainAtAsync` / `verifyAuditChainThrough` / `runVerifyAuditChain` (preserving synchronous `verifyAuditChainAt` for CLI callers), dropping worst-case event-loop stall on the same 4-file chain to `5.439 ms` p50 / `6.349 ms` p95 (`monitorEventLoopDelay` max) and `4.853 ms` p50 / `5.750 ms` p95 (`setImmediate` gap).

This page records the repeatable host-thread characterization for (1) actual Stage 2 activation sub-stages while `SidebarViewProvider.resolveWebviewView` opens from `PlaceholderProjector` to the first live `STATE_SNAPSHOT`, and (2) on-demand whole-file audit chain verification at the `5 MiB` (`5,242,880 B`) rotation boundary across both a single active log and a multi-archive retained chain.

<!-- Source: src/activation/stage2-producers.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->
<!-- Source: src/activation/evidence-wiring.ts -->
<!-- Source: src/activation/live-picture-wiring.ts -->
<!-- Source: src/ui/sidebar/sidebar-view-provider.ts -->
<!-- Source: src/audit/audit-chain.ts -->
<!-- Source: src/commands/verify-audit-chain.ts -->
<!-- Source: tests/perf/startup-and-audit-verification.test.ts -->
<!-- Source: tests/unit/commands/verify-audit-chain.test.ts -->

> **Single-platform qualification notice**: Every figure on this page was measured locally on one machine (`darwin/arm64`, Apple M4 Max, local APFS, Node `v24.22.2`). These figures provide single-platform risk reduction rather than a cross-platform guarantee; Linux (`ext4`/`xfs`) and Windows (`NTFS`) hosts remain unobserved until measured on those platforms.

---

## 1. Pre-Measurement Decision Gate Thresholds and Related Cost Records (`FR-005`)

Declared in `specs/332-recovery-verification-gaps/spec.md` (`Clarifications` and `FR-005`) before executing the baseline measurements:

| Measured Path | Decision Metric | Gate Ceiling | Outcome Rule |
|---|---|---|---|
| Stage 2 activation while sidebar opens | Elapsed time from Stage 2 start through `createStage2Producers.run()` and `SidebarViewProvider.setProjector(projector)` live `STATE_SNAPSHOT` delivery | `<= 500 ms` | Defer non-critical Stage 2 work only if `> 500 ms`; otherwise publish an explicit measured deferral verdict |
| On-demand whole-file audit verification (`5 MiB` rotation boundary) | Extension-host event-loop stall (`monitorEventLoopDelay` max and concurrent `setImmediate` max gap) across single `5 MiB` live log and retained multi-archive chain | `<= 50 ms` | Apply bounded async chunked event-loop yielding in `src/audit/audit-chain.ts` and `src/commands/verify-audit-chain.ts` (keeping synchronous `verifyAuditChainAt` for CLI) if `> 50 ms`; otherwise defer |

**Separate cost records referenced by `N05` (not re-measured here)**:
- **SQLite operational commit and read latency**: [`sqlite-operational-commit-latency-measurement.md`](sqlite-operational-commit-latency-measurement.md) (`FR-R7-02`, Schema 9 per-entity rows over `WAL` + `PRAGMA synchronous = FULL`, worst p95 `2.380 ms` on `documented-max-capacity`).
- **Webview snapshot projection, serialization, and slice-equality cost**: [`webview-snapshot-cost-measurement.md`](webview-snapshot-cost-measurement.md) (`FR-R4-F08` and `FR-R7-09` §9; per-slice revision deferral record in the planning envelope at `docs/features/round_7/DONE_09_FR-R7-09_snapshot_slice_revisions.md`).
- **Standalone session-artifact retention sweep scaling**: `tests/perf/activation-retention-sweep.test.ts` (`FR-R3-114` row 6; `10.8 ms` over `300` files / `18.8 MiB`, `0.57 ms/MiB`).

---

## 2. Measurement Environment and Datasets

### 2.1 Reference Host Metadata

| Field | Baseline Capture (Pre-Optimization) | Post-Optimization Capture (Chunked Async Verifier) |
|---|---|---|
| Date (UTC) | 2026-11-24 | 2026-11-24 |
| Hardware / machine class | Apple M4 Max (16 cores, 64.0 GiB RAM) | Apple M4 Max (16 cores, 64.0 GiB RAM) |
| OS / architecture | macOS 27.0 (`darwin` 27.0.0, `arm64`) | macOS 27.0 (`darwin` 27.0.0, `arm64`) |
| Filesystem | Local APFS (journaled) | Local APFS (journaled) |
| Node.js runtime | `v24.22.2` | `v24.22.2` |
| Host load average (`1m / 5m / 15m`) | `6.64 / 4.26 / 4.31` (Stage 2) · `6.91 / 4.35 / 4.35` (Audit) | `3.70 / 3.96 / 4.19` (Stage 2 & Audit, quiet solo run) |
| Base commits | Master `0f4eed74`, `repo/` `3efdb44f` + `N05` harness | Master `0f4eed74`, `repo/` `3efdb44f` + `N05` chunked async verifier |
| Sample plan | `2` warm-up + `7` measured isolated runs per suite | `2` warm-up + `7` measured isolated runs per suite |
| Reproduction command (from `repo/`) | `SCHEGENT_PRINT_N05_REPORT=1 npx vitest run --config vitest.perf.config.ts tests/perf/startup-and-audit-verification.test.ts --reporter=verbose` | Same command |

### 2.2 Populated Workspace Dataset (Stage 2 Activation Suite)

Each iteration seeds a fresh disposable workspace and `<globalStorageRoot>/sqlite/<scope>/schegent-state.db` schema-9 SQLite store cold on disk before Stage 1 opens `SidebarViewProvider.resolveWebviewView` with `PlaceholderProjector` and Stage 2 activates:

| Component | Seeded Scale | Exercised Stage 2 Code Path |
|---|---|---|
| Operational SQLite store (Schema 9, WAL + `FULL`) | `5` queues, `100` tasks (`20`/queue), `250` history entries (`50`/queue) | `store.initialize()`, `sqliteCutover.probePassiveSnapshots()`, `sqliteCutover.activatePrimary()`, `StateProjector` |
| Terminal transition journal | `1` pending `TerminalTransitionIntent` on default queue (`in-flight` → `completed`) | `runSafety.replayTerminalTransitions` → `terminalTransitions.replay(lock.id)` + history + rollup + `pauseQueuesOnStartup` |
| Recovery state | `1` future `scheduledStartAt` queue (`idle-pending`), `1` delayed-retry paused run (`pendingRetryAt`), `1` credit-paused run | `scheduledStartCoordinator.reArm()`, `watchdog.reattachOnActivation()`, `controller.resumeExistingFromActivation()` |
| SQLite-backed catalog definitions | `12` published Phases, `4` published Pipelines, `2` published Workflows | `openWorkspaceSession` (`CatalogSession.open`) + `refreshCatalog()` |
| Session artifacts (`.schegent/sessions/`) | `20` run directories, `60` files (`16 KiB` each), `983,040 B` (`0.94 MiB`) | `replayEvidenceBacklog()` → `sessionRetention.sweep()` + `sweepHistoryDescriptions()` |
| Audit files (`.schegent/audit.log*`) | `4` hash-chained files (`3` rotated archives + `1` active log), `140` entries, `62,555 B` | `auditWriter.runArchiveMaintenance()` |
| External CLI probe (`backendCapabilities.scan`) | Stubbed to no-op promise | Fire-and-forget (`void backendCapabilities.scan()` in `stage2-producers.ts`); never awaited by Stage 2 and excluded from hermetic host timings |

### 2.3 Audit Chain Datasets (`5 MiB` Rotation Boundary Suite)

`AuditLogWriter` defaults to `AUDIT_ROTATION_DEFAULT_SIZE_BYTES = 5 MiB` (`5,242,880 B`) and retains up to `AUDIT_ARCHIVE_DEFAULT_MAX_COUNT = 10` rotated archives alongside the active `audit.log` (up to `55 MiB` retained under default settings). Both datasets below use realistic schema-3 hash-chained JSONL entries (~`449 B`/line) plus an active head checkpoint matching the tail digest and position:

| Workload ID | File Count | Files Walked (Oldest → Newest) | Total Bytes | Total Chained Entries |
|---|---|---|---|---|
| `single-5mib-live` | `1` | `audit.log` (`5,243,037 B`, `11,676` entries) | `5,243,037 B` (`5.00 MiB`) | `11,676` |
| `multi-archive-20mib-4files` | `4` | `audit.log.20261121-100000` (`5,243,037 B`, `11,676`), `audit.log.20261122-100000` (`5,242,950 B`, `11,651`), `audit.log.20261123-100000` (`5,242,950 B`, `11,651`), `audit.log` (`5,242,950 B`, `11,651`) | `20,971,887 B` (`20.00 MiB`) | `46,629` |

---

## 3. Stage 2 Activation While Sidebar Opens — Measurements and Deferral Verdict

All values are in milliseconds (`ms`) over `7` measured runs after `2` warm-up runs. Both captures exercised the identical Stage 2 code path (no Stage 2 code changed between captures); the second run reflects lower ambient load (`loadAvg1m 3.70` vs `6.64`).

| Stage 2 Sub-Stage / Responsiveness Metric | Baseline Run (`load 6.64`) p50 / p95 / max (ms) | Quiet Run (`load 3.70`) p50 / p95 / max (ms) | Share of Total (Quiet p50) |
|---|---|---|---|
| Pre-producer Stage 2 wiring (`initialize`, session, evidence, backend, phase, scheduled, live picture) | `5.422` / `6.086` / `6.086` | `4.414` / `5.632` / `5.632` | `11.9%` |
| 1. Lock election (`lock.tryAcquire`) | `1.583` / `2.458` / `2.458` | `1.157` / `1.461` / `1.461` | `3.1%` |
| 2. Operator attribution (`operatorAttribution.ensureStored`) | `0.027` / `0.037` / `0.037` | `0.025` / `0.032` / `0.032` | `0.1%` |
| 3. Replay & SQLite primary cutover (`replayTerminalTransitions` + `sqliteCutover.activatePrimary` + startup pause) | `25.786` / `31.139` / `31.139` | `22.568` / `23.595` / `23.595` | `61.0%` |
| 4. Evidence backlog replay (`replayEvidenceBacklog`: migrations, `.schegent/sessions` sweep, history descriptions) | `8.389` / `9.490` / `9.490` | `6.436` / `7.381` / `7.381` | `17.4%` |
| 5. Catalog refresh (`refreshCatalog`: SQLite read + Phase/Pipeline/Workflow resolution) | `0.855` / `1.145` / `1.145` | `0.824` / `0.950` / `0.950` | `2.2%` |
| 6. Audit archive maintenance (`auditWriter.runArchiveMaintenance`) | `0.969` / `1.096` / `1.096` | `0.721` / `1.480` / `1.480` | `1.9%` |
| 7a. Recovery — scheduled-start re-arm (`scheduledStartCoordinator.reArm`) | `0.064` / `0.079` / `0.079` | `0.064` / `0.095` / `0.095` | `0.2%` |
| 7b. Recovery — watchdog reattach (`watchdog.reattachOnActivation`) | `0.005` / `0.005` / `0.005` | `0.004` / `0.006` / `0.006` | `<0.1%` |
| 7c. Recovery — delayed-retry re-arm (`controller.resumeExistingFromActivation`) | `0.012` / `0.014` / `0.014` | `0.009` / `0.013` / `0.013` | `<0.1%` |
| 7. Recovery producers subtotal (`7a + 7b + 7c`) | `0.078` / `0.096` / `0.096` | `0.080` / `0.113` / `0.113` | `0.2%` |
| **Total `createStage2Producers.run()`** | `38.197` / `44.777` / `44.777` | `32.216` / `33.072` / `33.072` | `87.1%` |
| Sidebar handoff (`setProjector(projector)` → live `STATE_SNAPSHOT` posted) | `0.019` / `0.022` / `0.022` | `0.017` / `0.030` / `0.030` | `<0.1%` |
| **Total Stage 2 elapsed to live sidebar `STATE_SNAPSHOT`** | **`43.855` / `50.905` / `50.905`** | **`36.989` / `38.381` / `38.381`** | **`100%`** |
| Host `monitorEventLoopDelay` (`p50` / `p95` / `max` across measured runs, median) | `1.003` / `2.322` / `4.940` (worst max `5.456`) | `1.003` / `2.232` / `4.370` (worst max `5.362`) | — |
| Concurrent `setImmediate` max gap (p50 / p95 / max) | `4.603` / `4.879` / `4.879` | `3.924` / `4.952` / `4.952` | — |

**Decision Gate Verdict — Stage 2 Activation (`DEFER`)**:
- Against the `500 ms` sidebar live-snapshot delay threshold (`FR-005`), actual end-to-end Stage 2 startup measured `36.989 ms` p50 / `38.381 ms` p95 on the quiet run (`43.855 ms` p50 / `50.905 ms` p95 under `loadAvg 6.64`), leaving **~10×–13× headroom** below the `500 ms` gate.
- Event-loop responsiveness remained smooth throughout (`monitorEventLoopDelay` worst max `5.456 ms`, `setImmediate` max gap `4.952 ms`), because Stage 2 yields naturally across async I/O boundaries (`lock.tryAcquire`, SQLite initialization, filesystem sweeps, catalog read).
- **Primary contributor identified for future reference**: `replayTerminalTransitions` (specifically `sqliteCutover.activatePrimary()` opening the WAL SQLite store and reconciling domain services + replaying the terminal intent) accounts for ~`61%` (`22.6–25.8 ms`) of Stage 2 time, followed by `replayEvidenceBacklog` at ~`17%` (`6.4–8.4 ms`). Neither threatens responsiveness today; Stage 2 refactoring is **explicitly deferred** with a `500 ms` p95 regression guard in `tests/perf/startup-and-audit-verification.test.ts`.

---

## 4. On-Demand Whole-File Audit Verification (`5 MiB` Boundary) — Measurements and Chunked Async Optimization

### 4.1 Baseline Measurements (Before Optimization)

Before `T014`, `runVerifyAuditChain` (`src/commands/verify-audit-chain.ts`) invoked synchronous `verifyAuditChainAt` (`src/audit/audit-chain.ts`), which performed `readFileSync`, `splitChainBytes`, `Buffer.toString('utf8')`, `JSON.parse`, and `SHA-256` hashing over every retained audit file inside a single uninterrupted event-loop turn (`immediateTicks === 1` on every run):

| Workload | Entry Point (Before) | Wall Time p50 / p95 / max (ms) | `monitorEventLoopDelay` p50 / p95 / max (ms, median of runs / worst max) | `setImmediate` Max Gap p50 / p95 / max (ms) | Interleaved `setImmediate` Ticks (p50) | `50 ms` Stall Gate |
|---|---|---|---|---|---|---|
| `single-5mib-live` (`5.00 MiB`, `11,676` entries, `1` file) | `verifyAuditChainAt` (sync) | `15.612` / `16.570` / `16.570` | `1.273` / `15.663` / `15.663` (worst `19.268`) | `15.856` / `18.098` / `18.098` | `1` | Pass (`< 50 ms`, single turn) |
| `single-5mib-live` (`5.00 MiB`, `11,676` entries, `1` file) | `runVerifyAuditChain` (sync) | `15.410` / `15.726` / `15.726` | `1.275` / `15.376` / `15.376` (worst `15.778`) | `17.970` / `18.463` / `18.463` | `1` | Pass (`< 50 ms`, single turn) |
| `multi-archive-20mib-4files` (`20.00 MiB`, `46,629` entries, `4` files) | `verifyAuditChainAt` (sync) | `66.000` / `67.710` / `67.710` | `1.273` / `66.060` / `66.060` (worst `67.764`) | `67.653` / `70.678` / `70.678` | `1` | **BREACHED (`> 50 ms`)** |
| `multi-archive-20mib-4files` (`20.00 MiB`, `46,629` entries, `4` files) | `runVerifyAuditChain` (sync) | `69.724` / `77.624` / `77.624` | `1.274` / `65.241` / `65.241` (worst **`73.335`**) | **`69.750` / `77.660` / `77.660`** | `1` | **BREACHED (`> 50 ms`)** |

**Threshold A Verdict (`OPTIMIZE`)**:
- At `4` retained `5 MiB` files (`20 MiB` — well inside the default `10`-archive / `55 MiB` retention ceiling), synchronous verification blocked the extension host thread for **`65.241–73.335 ms`** (`monitorEventLoopDelay` max) and **`69.750–77.660 ms`** (`setImmediate` gap), breaching the `> 50 ms` gate and scaling linearly toward `~180–210 ms` at the default 10-archive cap.

### 4.2 Bounded Async Chunked-Yielding Implementation

Implemented with minimal surface area and zero duplicated verification logic:
1. **`src/audit/audit-chain.ts`** (keeping zero relative imports so `node --experimental-strip-types scripts/verify-audit-chain.ts` continues running unmodified):
   - Factored the per-line chain walk state machine into shared internal helpers (`createChainWalkState`, `stepChainLine`, `finalizeChainWalk`) used by both synchronous `verifyChain` and new async `verifyChainAsync` (`DEFAULT_VERIFY_CHUNK_LINES = 512`).
   - Added `lstat`-guarded async directory enumeration (`collectChainFilesAsync` refusing symlinks and non-directories before `node:fs/promises.readdir`), `O_NOFOLLOW | O_NONBLOCK` regular-file readers (`readContainedRegularFileAsync` and symmetric `readContainedRegularFileSync`), chunked UTF-8 line decoding (`decodeChainLinesAsync`), and chunked hash verification yielding via `setImmediate` strictly between chunks (`512` lines per chunk ≈ `0.7–1.5 ms` of CPU work per turn).
   - Exported `verifyAuditChainAtAsync(auditDir, options)` and upgraded `verifyAuditChainThrough(auditDir, readFile, options)` to use the chunked async path as well.
   - Preserved synchronous `verifyChain` and `verifyAuditChainAt` for CLI (`scripts/verify-audit-chain.ts`) and synchronous callers while closing leaf-symlink and non-regular-file reads identically across sync and async paths.
2. **`src/commands/verify-audit-chain.ts`**:
   - Wired `runVerifyAuditChain` to `await verifyAuditChainThrough(auditDir, readContainedChainFile, ...)` using `openWithinRoot(ctx.workspaceRoot, ['.schegent', name], { flags: 'r' })` (which enforces `O_NOFOLLOW | O_NONBLOCK`, root containment, and regular-file `fstat`) while keeping read-error handling (`CHAIN_UNREADABLE_TOAST`), checkpoint loss classification, `onBreak`/`onLoss`/`onVerified` callbacks, and zero-write semantics unchanged.

### 4.3 Post-Optimization Before/After Comparison

| Workload | Path | Wall Time p50 / p95 (ms) | `monitorEventLoopDelay` max p50 / p95 (ms) | `setImmediate` Max Gap p50 / p95 (ms) | Interleaved `setImmediate` Ticks (p50) | `50 ms` Stall Gate |
|---|---|---|---|---|---|---|
| `single-5mib-live` (`5.00 MiB`, `11,676` entries) | **Before**: `runVerifyAuditChain` (sync) | `15.410` / `15.726` | `15.376` / `15.778` | `17.970` / `18.463` | `1` | Pass (`1` turn) |
| `single-5mib-live` (`5.00 MiB`, `11,676` entries) | **After**: `runVerifyAuditChain` (chunked async, `512` lines) | `16.611` / `18.636` (+`1.2 ms`) | **`1.852` / `3.701`** (**4.3× lower p95**) | **`0.765` / `2.847`** (**6.5× lower p95**) | **`91`** | **PASS** (`13.5×` headroom) |
| `single-5mib-live` (`5.00 MiB`, `11,676` entries) | CLI oracle: `verifyAuditChainAt` (sync, same run) | `15.939` / `20.147` | `15.598` / `20.201` | `15.979` / `20.182` | `1` | CLI-only (out-of-host) |
| `multi-archive-20mib-4files` (`20.00 MiB`, `46,629` entries) | **Before**: `runVerifyAuditChain` (sync) | `69.724` / `77.624` | `65.241` / `73.335` | `69.750` / `77.660` | `1` | **BREACHED (`> 50 ms`)** |
| `multi-archive-20mib-4files` (`20.00 MiB`, `46,629` entries) | **After**: `runVerifyAuditChain` (chunked async, `512` lines) | `72.252` / `74.455` (+`2.5 ms`) | **`5.439` / `6.349`** (**11.6× lower p95**) | **`4.853` / `5.750`** (**13.5× lower p95**) | **`343`** | **PASS** (`7.9×` headroom) |
| `multi-archive-20mib-4files` (`20.00 MiB`, `46,629` entries) | CLI oracle: `verifyAuditChainAt` (sync, same run) | `66.255` / `77.051` | `65.012` / `77.136` | `70.382` / `77.087` | `1` | CLI-only (out-of-host) |

Chunked yielding adds only `~1.2–2.5 ms` (`~3.6%`) of total wall-clock time while cutting worst-case extension-host event-loop stalls on `20 MiB` retained chains by **>11×** (`73.335 ms` → `6.349 ms` `monitorEventLoopDelay` max; `77.660 ms` → `5.750 ms` `setImmediate` gap) and permitting `343` concurrent event-loop turns to service UI IPC, cancellations, and timers while verification runs.

---

## 5. Verification Coverage and Scope Boundaries

- **Perf regression gate**: `tests/perf/startup-and-audit-verification.test.ts` runs in `npm run test:perf` (single-threaded `vitest.perf.config.ts`) and enforces:
  - Stage 2 live-snapshot delay `p95 <= 500 ms` (`STAGE2_LIVE_SNAPSHOT_P95_CEILING_MS = 500`),
  - `runVerifyAuditChain` `monitorEventLoopDelay` max `p95 <= 50 ms` and `setImmediate` max gap `p95 <= 50 ms` (`AUDIT_CMD_EVENT_LOOP_STALL_P95_CEILING_MS = 50`) on both single `5 MiB` and `20 MiB` multi-archive chains, with `>= 10` interleaved `setImmediate` ticks proving yielding occurred.
- **Behavioral parity & CLI compatibility**:
  - `tests/unit/commands/verify-audit-chain.test.ts` asserts byte-for-byte `ChainCheck` / `ChainVerdict` equality between synchronous `verifyAuditChainAt`, `verifyAuditChainAtAsync`, and `verifyAuditChainThrough` across absent directories, legacy-prefix form-B transitions with version-2 cut records, multi-archive rotation seams with `probeDigest`, mid-chain tampering (`broken-link`), truncated final lines (`malformed`), and diagnosed torn-tail damage, plus interleaved `setImmediate` yielding.
  - All `39` audit and command unit test files (`503` tests) and standalone CLI invocation (`node --experimental-strip-types scripts/verify-audit-chain.ts`) pass with zero regressions.
- **Scope boundaries and re-measurement triggers**:
  - Stage 2 figures isolate host-side wiring, SQLite primary cutover, replay, retention sweep, catalog refresh, archive maintenance, recovery producers, and `SidebarViewProvider.setProjector` `postMessage` delivery; they exclude VS Code renderer HTML paint time and unawaited fire-and-forget CLI `--help` probes.
  - Re-run this harness if new awaited work is added to `wireStage2` or `createStage2Producers`, if `AUDIT_ROTATION_DEFAULT_SIZE_BYTES` / `AUDIT_ARCHIVE_DEFAULT_MAX_COUNT` increase, or when qualifying Linux or Windows desktop hosts.

### Repeated verification capture (`FR-R8-03` / `03-04`, 2026-11-24)

Re-run standalone on 2026-11-24 (`darwin/arm64`, Apple M4 Max, Node `v24.22.2`, `loadAvg1m 3.25`, `SCHEGENT_PRINT_N05_REPORT=1 npx vitest run --config vitest.perf.config.ts tests/perf/startup-and-audit-verification.test.ts --reporter=verbose`, 2 warm-up + 7 measured):

- **Stage 2 total to live sidebar snapshot**: `p50 35.587 ms`, `p95 37.077 ms`, `max 37.077 ms` (`monitorEventLoopDelay` max `p50 4.264 ms` / `p95 4.760 ms`, `setImmediate` max gap `p50 3.915 ms` / `p95 4.365 ms`; `DEFER` verdict stands with >13× headroom under `500 ms`).
- **On-demand `runVerifyAuditChain` (`single-5mib-live`, `5.00 MiB`, `11,676` entries)**: wall `p50 16.304 ms` / `p95 16.885 ms`, `monitorEventLoopDelay` max `p50 1.580 ms` / `p95 1.836 ms`, `setImmediate` max gap `p50 0.695 ms` / `p95 0.829 ms`, `89` interleaved ticks (p50).
- **On-demand `runVerifyAuditChain` (`multi-archive-20mib-4files`, `20.00 MiB`, `46,629` entries)**: wall `p50 74.196 ms` / `p95 74.407 ms`, `monitorEventLoopDelay` max `p50 5.304 ms` / `p95 5.853 ms`, `setImmediate` max gap `p50 5.028 ms` / `p95 5.866 ms`, `339` interleaved ticks (p50; >8× headroom under `50 ms`).
