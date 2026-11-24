# Asynchronous Test Flakiness Remediation and Isolated-vs-Loaded Measurement (`FR-R7-18` / `N06`)

**Measured**: 2026-11-24 · **Item**: `FR-R7-18` (`N06`, `FR-006`, `SC-006`, `specs/332-recovery-verification-gaps/spec.md`) · **Decision**: Keep `testTimeout: 30_000` and `hookTimeout: 30_000` in `vitest.config.ts` after eliminating avoidable fixed condition sleeps across unit, integration, visual, and webview suites, splitting multi-invariant mega-tests (`26 → 56` tests, `213 → 261` `expect()` calls, zero assertion weakening), upgrading real-host poll helpers with starvation diagnostics, and closing sleep-wrapper, step-sum-loop, and integration-tier blind spots in `tests/lint/waits-are-bounded-by-time.test.ts`.

This page records the before-and-after sleep-wait census outside `tests/perf/`, the multi-invariant test splits (`T015`), the deterministic wait replacements (`T016`), the wait-lint gate expansions (`T017`), and the repeated isolated (`3` runs) versus CPU-loaded (`1` run) verification comparison.

<!-- Source: vitest.config.ts -->
<!-- Source: tests/lint/waits-are-bounded-by-time.test.ts -->
<!-- Source: tests/wait-for-condition.ts -->
<!-- Source: tests/integration/wait-diagnosis.ts -->
<!-- Source: tests/unit/services/quota-permit-arbiter.test.ts -->
<!-- Source: tests/integration/control-quota-contention.test.ts -->
<!-- Source: tests/unit/services/candidate-block-executor.test.ts -->
<!-- Source: tests/integration/candidate-block-recovery.test.ts -->
<!-- Source: tests/unit/services/backend-availability-service.test.ts -->
<!-- Source: tests/integration/activation-eager.host.test.ts -->
<!-- Source: tests/integration/multi-root.host.test.ts -->
<!-- Source: tests/integration/trust-leg-support.ts -->
<!-- Source: tests/integration/trust-untrusted-workspace.host.test.ts -->
<!-- Source: docs/verification/workflow-control-acceptance.md -->

> **Single-platform qualification notice**: Every timing figure on this page was measured locally on one machine (`darwin/arm64`, Apple M4 Max, local APFS, Node `v24.22.2`). These results provide single-platform risk reduction rather than a cross-platform guarantee; Linux (`ext4`/`xfs`) and Windows (`NTFS`) hosts remain unobserved until measured on those platforms.

---

## 1. Measurement Environment and Scope

| Field | Captured Value |
|---|---|
| Date (UTC) | 2026-11-24 (`05:46:32Z`) |
| Hardware / machine class | Apple M4 Max (`16` logical cores, `64.0 GiB` RAM) |
| OS / architecture | macOS 27.0 (`darwin` 27.0.0, build `26A428`, `arm64`) |
| Filesystem | Local APFS (journaled) |
| Node.js runtime | `v24.22.2` |
| Vitest configuration | `vitest.config.ts` (`pool: 'threads'`, `maxWorkers: '50%'` = `8` workers, `testTimeout: 30_000`, `hookTimeout: 30_000`) |
| Base commits | Master `0f4eed74`, `repo/` `3efdb44f` + `FR-R7-18` `N06` (`T015`, `T016`, `T017`) |
| Scanned census scope | `1,686` host test/helper files under `tests/` (excluding `tests/perf/` and `waits-are-bounded-by-time.test.ts`) + `241` test files under `webview-ui/src/` |

---

## 2. Before-and-After Sleep-Wait Census (Outside `tests/perf/`)

The November 12 static review counted `198` sleep-style wait lines outside `tests/perf/`; the pre-`N06` `HEAD` (`3efdb44f`) live scan found `183` non-comment `setTimeout(` calls (excluding `test.setTimeout`), `6` named sleep-wrapper awaits (`waitMs`, `sleep`), `2` Playwright `.waitForTimeout` calls, and `1` step-sum deadline loop (`for (let waited = 0; ...; waited += 25)`), totaling **`89` direct real-clock sleep awaits** (`85` host + `4` webview).

| Test Tier (Outside `tests/perf/`) | Real-Clock Sleep Awaits (Before → After) | Named Wrapper Awaits (`waitMs`/`sleep`/`delay`) | Playwright `.waitForTimeout` | Step-Sum Deadline Loops | All Non-Comment `setTimeout(` Lines (Before → After) | Remaining Sites Summary |
|---|---|---|---|---|---|---|
| `tests/unit/` | `52 → 22` (**−30**, −57.7%) | `3 → 0` | `0 → 0` | `0 → 0` | `123 → 93` (−30) | `8` allowlisted `>= 100 ms` elapsed-time/child-lifetime sleeps, `1` durability stub param, `13` short yields (`0–50 ms`); `2` local real-child wrappers (`process-tree.test.ts`, `child-stdin-line-channel.test.ts`) now explicitly allowlisted |
| `tests/integration/` (Vitest, non-host) | `26 → 12` (**−14**, −53.8%) | `3 → 0` | `0 → 0` | `1 → 0` | `34 → 26` (−8 net; −13 in `N06`, +5 `520 ms` held-mutation barriers in `N01` `sidebar-cancel-behind-slow-mutation.test.ts`) | **Zero** `>= 100 ms` fixed sleeps; `8` zero-ms macrotask yields, `3` short `8–10 ms` yields, `1` `Date.now()`-bounded `waitFor` poll step (`artifact-lifecycle-acceptance.test.ts`) |
| `tests/integration/` real VS Code host (`*.host.test.ts`, `trust-leg-support.ts`) | `4 → 4` (`0` removed; `3` upgraded, `1` documented) | `0 → 0` | `0 → 0` | `0 → 0` | `4 → 4` | `3` `Date.now()`-bounded `100 ms` poll loops upgraded with `rounds`, `elapsedMs`, and `diagnoseWait()`; `1` documented `3,000 ms` negative-observation grace window (`trust-untrusted-workspace.host.test.ts`) |
| `tests/visual/` | `2 → 0` (**−2**, −100%) | `0 → 0` | `2 → 0` | `0 → 0` | `3 → 3` | Zero `.waitForTimeout` calls remain; `webview.visual.spec.ts` waits on observable DOM state |
| `tests/wait-for-condition.ts` (shared helper) | `1 → 1` | `0 → 0` | `0 → 0` | `0 → 0` | `1 → 1` | `POLL_INTERVAL_MS = 5 ms` inside the shared `Date.now()`-bounded poller |
| `tests/a11y/`, `tests/fixtures/`, other `tests/` | `0 → 0` | `0 → 0` | `0 → 0` | `0 → 0` | `9 → 9` | Fixture process scripts and a11y harness timers (zero fixed sleep awaits) |
| `webview-ui/src/` (`__tests__`, `*.test.ts`) | `4 → 3` (**−1**, −25.0%) | `0 → 0` | `0 → 0` | `0 → 0` | `9 → 4` (**−5**, −55.6%) | Only `3` zero-ms macrotask yields remain (`WorkflowTriggerForm.test.ts`, `App.route-loading.test.ts`); `SettingsSurface.test.ts`, `no-surface-validation.test.ts`, and `settings-refusals.test.ts` converted to fake timers / microtask flush |
| **Combined Total** | **`89 → 42` (−47, −52.8%)** | **`6 → 0` (−100%)** | **`2 → 0` (−100%)** | **`1 → 0` (−100%)** | **`183 → 140` (−43 net; −48 gross in `N06`)** | Zero unexempted `>= 100 ms` sleeps across `tests/unit/` and `tests/integration/` |

---

## 3. Multi-Invariant Test Splits (`T015`)

Five suites with multi-invariant mega-tests were split into single-invariant `it(...)` cases so any failure isolates one contract rather than hiding later assertions behind an earlier failure. Zero assertions were weakened or dropped, and cited test titles in [`docs/verification/workflow-control-acceptance.md`](../verification/workflow-control-acceptance.md) were synchronized in the same pass:

| Test File | Test Cases (Before → After) | `expect()` Calls (Before → After) | Key Split Invariants & Determinism Fixes |
|---|---|---|---|
| `tests/unit/services/quota-permit-arbiter.test.ts` | `9 → 21` (+12) | `56 → 64` (+8) | Split FIFO tie-breaking, queue-head isolation, pause/resume sequence retention, reverse-order deadlock prevention, atomic permit commit/release, and uncertain-permit retention into dedicated single-invariant cases |
| `tests/integration/control-quota-contention.test.ts` | `4 → 8` (+4) | `45 → 49` (+4) | Split 20-queue contention, paused-waiter skip, independent-quota non-starvation, atomic capacity refusal, resumed sequence-1 reclamation, and restart/fake-clock uncertain-permit retention (`AC-26`, `AC-28`, `AC-33`, `AC-34`) |
| `tests/unit/services/candidate-block-executor.test.ts` | `6 → 13` (+7) | `43 → 44` (+1) | Split UUID/priority ordering, `wait-for-selected` / `stop-on-unavailability` / `first-ready` policies, non-preemption of in-flight/retry-delayed slots, single `returnCommitId` settlement, duplicate-settlement idempotency, invalid final-attempt intervention precedence, and 8-hour `monitoring-expired` expiry |
| `tests/integration/candidate-block-recovery.test.ts` | `2 → 5` (+3) | `19 → 36` (+17) | Split primary cooldown fallback switch, `waiting-availability` zero-attempt entry, polling recovery + single return commit, and full end-to-end handoff preservation |
| `tests/unit/services/backend-availability-service.test.ts` | `5 → 9` (+4) | `50 → 68` (+18) | Split unknown-quota isolation, 3-check concurrency cap & ordering, 10 s hung-check abort, in-flight deduplication, 60 s re-check rate limiting, D6 check sponsorship, and cooldown floors; replaced `2` real `setTimeout` sleeps with controllable deferred barriers |
| **Total (`T015`)** | **`26 → 56` (+30)** | **`213 → 261` (+48)** | **Zero assertions weakened; 100% traceability parity with `workflow-control-acceptance.md`** |

---

## 4. Avoidable Fixed Sleep Replacements (`T016`)

Across `32` files outside `tests/perf/`, `T016` replaced avoidable fixed sleeps with controllable clocks, `vi.useFakeTimers()`, `fs.utimes()` mtime backdating, deferred promise barriers, or `waitForCondition` (`tests/wait-for-condition.ts`):

- **Unit tier (`14` files)**: `audit-end-to-end.test.ts` (removed `waitMs` wrapper + `150 + FLUSH_PAD_MS` sleeps via controllable timers), `phase-log-tail-registry.test.ts`, `retry-phase-now.test.ts`, `audit-checkpoint-lifecycle.test.ts`, `audit-archive-maintenance.test.ts`, `audit-chain-end-to-end.test.ts`, `audit-chain-legacy-real-writer.test.ts`, `retention.test.ts` (replaced `120 ms` sleep and mtime-spacing sleeps with fake `Date` + `fs.utimes()`, allowing removal of its old `ELAPSED_TIME_SLEEPS` exemption), `mount-probe-does-not-gate-activation.test.ts`, `write-chain.test.ts`, `codex-cli.test.ts`, `repo-agent-config-scanner.test.ts`, `session-artifact-retention-service.test.ts`, and `cmd-start-queue.test.ts`.
- **Integration tier (`10` files)**: `breakpoint-end-to-end.test.ts` (replaced polling sleeps with deterministic `planStarted`/`planGate` barriers and `waitForCondition`), `shutdown-teardown-order.test.ts` (removed `sleep` wrapper and `for (let waited = 0; waited < 3_000 && !existsSync(ready); waited += 25)` step-sum loop in favor of `waitForCondition`), `audit-tail-coldstart.test.ts`, `cascaded-pause.test.ts`, `delayed-retry.integration.test.ts`, `sqlite-large-restore-fencing.test.ts`, `workflow-restart-multi-phase.test.ts`, `webview-to-cli-end-to-end.test.ts`, `trust-scopes-webview-projection.test.ts`, and `phase-log-end-to-end.test.ts`.
- **Visual tier (`1` file)**: `tests/visual/webview.visual.spec.ts` (removed both Playwright `.waitForTimeout` calls).
- **Webview unit tier (`3` files)**: `SettingsSurface.test.ts`, `no-surface-validation.test.ts`, and `settings-refusals.test.ts`.
- **Real VS Code host tier (`4` files)**: `activation-eager.host.test.ts`, `multi-root.host.test.ts`, and `trust-leg-support.ts` now track `rounds` and `elapsedMs` and format timeout failures with `diagnoseWait({ elapsedMs, rounds, floorMs: POLL_INTERVAL_MS })` (`tests/integration/wait-diagnosis.ts`) to distinguish CPU starvation from stalled host code; `trust-untrusted-workspace.host.test.ts` documents its `3,000 ms` `SPAWN_GRACE_MS` negative-observation grace window explicitly.

---

## 5. Wait Lint-Gate Hardening (`T017`)

`tests/lint/waits-are-bounded-by-time.test.ts` was tightened to close the three blind spots exposed by the `N06` audit while preserving all `gate-integrity` controls (`coverage-split`, `zero-offender-census`, `mutation-controls`):

1. **Stale exemption removed**: deleted the obsolete `{ file: 'tests/unit/audit/retention.test.ts', ms: 120 }` entry from `ELAPSED_TIME_SLEEPS` after `T016` eliminated that sleep.
2. **Sleep-wrapper helper bypasses closed**: extended fixed-sleep detection (`>= 100 ms`) beyond bare `await new Promise((r) => setTimeout(r, N))` to also match generic `Promise<void>` / block-body forms, named wrappers (`waitMs`, `sleep`, `sleepMs`, `delay`, `delayMs`, `pauseMs`), arbitrary file-local wrappers wrapping `new Promise(...setTimeout...)` (such as `pause` or `settle`), unique file-local numeric `const` bindings (`LADDER_SETTLE_MS`, `FAULT_SETTLE_MS`, `SPAWN_GRACE_MS`, `POLL_INTERVAL_MS`), and purely additive duration expressions (`150 + FLUSH_PAD_MS`).
3. **Step-sum deadline loops forbidden across `src/` and `tests/`**: added `stepSumWaits` catching both `for (let waited = 0; waited < ...; waited += STEP)` and `while (waited < ...) { ... waited += STEP }` loops that yield via `setTimeout`, `setImmediate`, named wrappers, or file-local sleep wrappers instead of checking `Date.now()` / `performance.now()`, while sparing fake-clock stepping loops (e.g., `workload.clock.advance(STEP_MS); await settle();`) and chunk-iteration loops.
4. **Integration tier coverage added**: expanded fixed-sleep scanning from `tests/unit/` alone to both `tests/unit/` and `tests/integration/`. Every non-host Vitest integration suite passes with **zero** exemptions; `ELAPSED_TIME_SLEEPS` holds `17` per-site entries (`13` unit real-child/durability/barrier entries + `4` real VS Code host entries), every one verified live by `lists no exemption for a sleep that is no longer there` so the allowlist can only shrink.

---

## 6. Repeated Isolated Runs vs Recorded Loaded Run (`SC-006`)

### 6.1 Representative 19-File Async and Contention Suite (`147` Tests)

All four runs executed the exact same `19` files (`147` tests, zero assertions weakened) using production `vitest.config.ts` settings:
- **Split multi-invariant suites (`5`)**: `quota-permit-arbiter.test.ts`, `control-quota-contention.test.ts`, `candidate-block-executor.test.ts`, `candidate-block-recovery.test.ts`, `backend-availability-service.test.ts`.
- **Historical contention suites cited in `vitest.config.ts` (`2`)**: `concurrent-run-execution.test.ts`, `concurrency-cap.test.ts`.
- **Refactored integration wait suites (`10`)**: `breakpoint-end-to-end.test.ts`, `shutdown-teardown-order.test.ts`, `audit-tail-coldstart.test.ts`, `cascaded-pause.test.ts`, `delayed-retry.integration.test.ts`, `sqlite-large-restore-fencing.test.ts`, `workflow-restart-multi-phase.test.ts`, `webview-to-cli-end-to-end.test.ts`, `trust-scopes-webview-projection.test.ts`, `phase-log-end-to-end.test.ts`.
- **Wait-lint and slow-mutation concurrency suites (`2`)**: `waits-are-bounded-by-time.test.ts`, `sidebar-cancel-behind-slow-mutation.test.ts`.

### 6.2 Run-Level Comparison (`3` Isolated Runs vs `1` Loaded Run)

For the loaded run, `16` Node `worker_threads` (`os.cpus().length` = `16`, tight integer-math loops with a `180 s` self-destruct guard and `finally` termination) ran alongside Vitest's `8` worker threads (`maxWorkers: '50%'`) and child processes after a `3 s` warm-up so CPU contention was live throughout execution.

| Run | Condition | Wall Duration | Files Passed | Tests Passed / Failed / Timeouts | `os.loadavg()` Start (`1m / 5m / 15m`) | `1m` Load Peak / Mean | `os.loadavg()` End (`1m / 5m / 15m`) | Slowest Single Test (`ms`) |
|---|---|---|---|---|---|---|---|---|
| `isolated-1` | Quiet host (solo) | `6.51 s` (`6,509.5 ms`) | `19 / 19` | `147 / 0 / 0` | `2.01 / 2.64 / 3.50` | `2.33` / `2.13` | `2.33 / 2.70 / 3.52` | `3,137.5 ms` (`shutdown-teardown-order.test.ts`) |
| `isolated-2` | Quiet host (solo) | `6.53 s` (`6,525.7 ms`) | `19 / 19` | `147 / 0 / 0` | `2.33 / 2.70 / 3.52` | `2.62` / `2.47` | `2.62 / 2.75 / 3.53` | `2,901.0 ms` (`shutdown-teardown-order.test.ts`) |
| `isolated-3` | Quiet host (solo) | `6.55 s` (`6,546.4 ms`) | `19 / 19` | `147 / 0 / 0` | `2.62 / 2.75 / 3.53` | `4.01` / `3.66` | `4.01 / 3.04 / 3.63` | `2,892.9 ms` (`shutdown-teardown-order.test.ts`) |
| **Isolated Summary** | `3` sequential runs | `6.53 s` median (`36.9 ms` / `0.57%` spread) | `19 / 19` (all 3) | **`441 / 0 / 0` cumulative** | `2.01–2.62` (`1m`) | `2.33–4.01` | `2.33–4.01` (`1m`) | `2,892.9–3,137.5 ms` |
| **`loaded-16cpu`** | **`16` CPU workers saturated** | **`16.87 s` (`16,866.5 ms`, `2.58×` isolated median)** | **`19 / 19`** | **`147 / 0 / 0`** | `5.37 / 3.33 / 3.73` | **`12.95` / `9.78`** | `12.95 / 5.11 / 4.35` | **`2,909.0 ms`** (`shutdown-teardown-order.test.ts`); next `1,037.1 ms` (`concurrency-cap.test.ts`) |

### 6.3 Top File Durations Under Contention

| Test File | Tests | Isolated Mean (`3` Runs) | Loaded Run (`16` CPU Workers) | Contention Ratio | Dominant Cost Driver |
|---|---|---|---|---|---|
| `tests/integration/concurrent-run-execution.test.ts` | `23` | `4.79 s` (`4.75 / 4.80 / 4.82 s`) | `13.14 s` | `2.74×` | Multi-queue real filesystem/IPC execution (`drainUntil` deadline-bounded; slowest case `931.7 ms` under load) |
| `tests/integration/concurrency-cap.test.ts` | `5` | `1.55 s` (`1.54 / 1.57 / 1.55 s`) | `3.29 s` | `2.12×` | Concurrent real-queue slot contention (slowest case `1,037.1 ms` under load) |
| `tests/integration/shutdown-teardown-order.test.ts` | `3` | `2.98 s` (`3.14 / 2.91 / 2.90 s`) | `2.91 s` | `0.98×` | Real child process `SIGTERM → SIGKILL` teardown ladder (wall-clock bound; unaffected by CPU contention after replacing step-sum loop with `waitForCondition`) |
| `tests/integration/sidebar-cancel-behind-slow-mutation.test.ts` | `8` | `2.69 s` (`2.69 / 2.69 / 2.70 s`) | `2.77 s` | `1.03×` | Five intentional `520 ms` held-mutation barriers (`FR-R7-18` `N01`) |
| `tests/lint/waits-are-bounded-by-time.test.ts` | `11` | `0.85 s` (`0.86 / 0.85 / 0.86 s`) | `1.28 s` | `1.50×` | Full `src/` + `tests/` static scan across `> 1,600` `.ts` files |
| `tests/integration/sqlite-large-restore-fencing.test.ts` | `4` | `0.63 s` (`0.62 / 0.63 / 0.63 s`) | `1.00 s` | `1.60×` | Real SQLite restore and fencing I/O |
| `tests/integration/delayed-retry.integration.test.ts` | `8` | `0.22 s` (`0.21 / 0.22 / 0.22 s`) | `0.28 s` | `1.28×` | Controllable-clock delayed-retry scheduling |
| `tests/integration/workflow-restart-multi-phase.test.ts` | `10` | `0.15 s` (`0.15 / 0.15 / 0.15 s`) | `0.25 s` | `1.61×` | Multi-phase restart and recovery persistence |

---

## 7. `vitest.config.ts` Timeout Decision (`testTimeout: 30_000`)

- **Decision**: Retain `testTimeout: 30_000` and `hookTimeout: 30_000` in `vitest.config.ts` (updated with the 2026-11-24 `FR-R7-18` / `N06` measurements).
- **Evidence**:
  1. Isolated runs of the refactored 19-file async/contention suite now complete deterministically in `6.51–6.55 s` (`0.57%` variance, `0` failures, `0` timeouts).
  2. Even with avoidable sleeps removed, CPU-saturated real-process suites still stretch `2.12×–2.74×` (`concurrent-run-execution.test.ts` `4.79 s → 13.14 s`; overall wall time `6.53 s → 16.87 s`), and `shutdown-teardown-order.test.ts` legitimately takes `~2.9–3.1 s` for a single real `SIGTERM → SIGKILL` test case.
  3. Under a full `npm run test:coverage` run (`1,500+` files competing with V8 coverage instrumentation and disk I/O), lowering `testTimeout` back toward Vitest's `5_000 ms` default would re-introduce false machine-load timeouts with zero correctness benefit, whereas `30_000 ms` maintains `~9.6×` headroom over the slowest real-process test while still failing true deadlocks and costing green runs `0 ms`.

---

## 8. Reproduction Commands

Run `3` isolated passes from `repo/`:

```bash
cd repo
FILES=(
  tests/unit/services/quota-permit-arbiter.test.ts
  tests/integration/control-quota-contention.test.ts
  tests/unit/services/candidate-block-executor.test.ts
  tests/integration/candidate-block-recovery.test.ts
  tests/unit/services/backend-availability-service.test.ts
  tests/integration/concurrent-run-execution.test.ts
  tests/integration/concurrency-cap.test.ts
  tests/integration/breakpoint-end-to-end.test.ts
  tests/integration/shutdown-teardown-order.test.ts
  tests/integration/audit-tail-coldstart.test.ts
  tests/integration/cascaded-pause.test.ts
  tests/integration/delayed-retry.integration.test.ts
  tests/integration/sqlite-large-restore-fencing.test.ts
  tests/integration/workflow-restart-multi-phase.test.ts
  tests/integration/webview-to-cli-end-to-end.test.ts
  tests/integration/trust-scopes-webview-projection.test.ts
  tests/integration/phase-log-end-to-end.test.ts
  tests/lint/waits-are-bounded-by-time.test.ts
  tests/integration/sidebar-cancel-behind-slow-mutation.test.ts
)
for i in 1 2 3; do
  npx vitest run "${FILES[@]}"
done
```

Run a bounded CPU-loaded pass (automatically terminates every CPU worker on exit via `finally`):

```bash
cd repo
node -e '
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const { Worker } = require("node:worker_threads");
const code = "const end=Date.now()+180000;let a=0;while(Date.now()<end){for(let i=0;i<1e6;i++)a=(a+Math.imul(i,2654435761))|0;}";
const workers = Array.from({ length: os.cpus().length }, () => new Worker(code, { eval: true }));
setTimeout(async () => {
  try {
    const res = spawnSync("npx", ["vitest", "run", ...process.argv.slice(1)], { stdio: "inherit" });
    process.exitCode = res.status ?? 1;
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}, 3000);
' "${FILES[@]}"
```
