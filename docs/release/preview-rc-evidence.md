# Engineering Preview Release-Candidate Evidence (`FR-R8-03` / `03-08`)

**Date (UTC)**: 2026-11-24 · **Posture**: Private-to-author engineering preview (no Marketplace publish, no external GitHub Release, no external pilot; see `docs/architecture/release-posture-engineering-preview.md` in the planning envelope).

This record binds the exact Round 8 preview candidate artifact, verification posture, advisory state, and explicit unqualified gaps to observable commits and digests. Post-commit invalidation (`wrong-commit`, `dirty-tree`, `stale-version`, `recorded-dirty`, and `QUALIFICATION_PATHS` / `QUALIFICATION_BUILD_OUTPUTS` fingerprint checks) is verified by `tests/unit/build/gate-attestation.test.ts`, `tests/unit/build/backend-qualification.test.ts`, and `tests/unit/build/release-candidate.test.ts`.

<!-- Source: scripts/require-local-gate.mjs -->
<!-- Source: scripts/release-candidate.mjs -->
<!-- Source: scripts/release-advisory.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: docs/release/qualification-matrix.md -->
<!-- Source: docs/release/advisory-dispositions.json -->
<!-- Source: docs/release/accessibility-at-matrix.md -->

---

## 1. Host, Runtime, and Package Binding

| Field | Observed Value |
|---|---|
| Target tuple | Local macOS 27.0 (`darwin/arm64`, Apple M4 Max), Node `v24.22.2` (`.nvmrc` pins `24.19.0`; `engines.node` `^22 \|\| ^24`), VS Code floor `1.107.0` (`engines.vscode` `^1.107.0`) |
| Latest local `develop` base (`repo/` / workspace) | `repo/` `4732e3df` (archived gate record `059a6eeb` PASS) · workspace `294235a8` (updated to final FR-R8-03 gate commit at merge) |
| Clean VSIX smoke package (`npm run package:smoke`) | `68` files, **`1,941,227` compressed bytes** (`<= 2,097,152 B` / `2 MiB` ceiling), **`7,702,699` uncompressed bytes** (`<= 8,388,608 B` / `8 MiB` ceiling), pre-commit VSIX SHA-256 `2179b28d9864deaa1ca2be58664f8a1b4509aae658d896a5cc44926e4de055f3` (final committed release archive digest is recorded by `npm run release` / `scripts/release-candidate.mjs` into `.release/schegent-0.2.0.release.json`), allowlist + SBOM + notices policy **PASS** |
| SBOM & third-party notices (`npm run sbom`, `npm run notices`) | `schegent-sbom.cdx.json`: `706` components across 2 lockfiles and 2 module graphs; **`0` declared runtime dependencies**, `2` bundled webview packages (`svelte`, `esm-env`), `2` attributed Vite virtual modules (`vite/modulepreload-polyfill.js`, `vite/preload-helper.js`); `THIRD-PARTY-NOTICES.md`: `3` packages, `2` attributed virtual modules |
| Clean-build & non-hermetic container notes | Host (`esbuild.config.mjs`) and webview (`vite build`) produce clean locked-tree artifacts (`dist/extension.js`, `dist/acp-stdio-bridge.js`, `dist/webview/`). The optional Linux container leg (`scripts/linux-leg/Dockerfile`) uses `node:24.19.0-bookworm-slim` + live Debian `apt-get` and is explicitly documented as non-hermetic (`RELEASE.md` §2b). |

---

## 2. Dependency Advisory Posture (`03-05`)

- **Dual-tree live captures (2026-11-24)**: `7` normalized findings in `root` (`5 moderate`, `2 critical`) and `7` normalized findings in `webview-ui` (`5 moderate`, `2 critical`).
- **Runtime reachability**: **`0` `shipped` findings**; all `14` findings are **`build-only`** devDependencies (`@vitest/mocker`, `vitest`, `tinypool`, `glob`, `minimatch`) absent from `dist/module-graph/host.json`, `dist/module-graph/webview.json`, and the shipped SBOM runtime set.
- **Release gate enforcement**: `scripts/release-advisory.mjs` fails closed unconditionally (`advisory-shipped`, checked before `advisory-uncovered`) on any finding whose runtime reachability is not proven `build-only` (`usage === 'shipped'` or `usage === 'unknown'`, including unmapped virtual modules or missing module graphs) once module graphs are supplied, even if an `accepted` disposition exists, alongside `advisory-uncovered` for uncovered, expired, or `actionable` findings.
- **Dispositions**: All `14` builder-only findings are covered in [`advisory-dispositions.json`](advisory-dispositions.json) (`decidedOn: 2026-11-24`, `expiresOn: 2027-02-22`) with exposure, mitigation, and upgrade triggers (`vitest@5.x` / `@vscode/vsce@4.x` tracked in [`held-major-upgrades.md`](held-major-upgrades.md)).

---

## 3. Round 8 Feature Verification Summary

| Workstream | Representative Verification Suites | Observed Result |
|---|---|---|
| `FR-R8-01` Ownership, atomic admission, candidate fallback, lane recovery, 8-checkpoint `SIGKILL` recovery | `workflow-checkpoint-crash-matrix.test.ts` (16/16), `workflow-candidate-fallback-launch.test.ts`, `execution-lane-recovery.test.ts`, archived gate `107f5fbd` | **PASS** (merged at `repo/` `910ef6f4`) |
| `FR-R8-02` Process authority, ACP billable usage, phase handoffs, strict-USD & post-turn spend, contradictory exit, workflow composition | `acp-backed-runner.test.ts`, `phase-handoff-coordinator.test.ts`, `spend-bound-watcher.test.ts`, `control-usage-accounting.test.ts`, archived gate `059a6eeb` | **PASS** (merged at `repo/` `4732e3df`) |
| `FR-R8-03` Privacy & deletion drill (`03-01`), correlated metadata + OTLP + audit integrity (`03-02`), 1M-observation read-only worker (`03-03`), degraded op & restore drills (`03-04`), fail-closed `advisory-shipped` (`03-05`), setup rehearsal (`03-06`), small-viewport a11y (`03-07`) | `sensitive-run-retention-deletion-drill.test.ts` (3/3), `correlated-diagnostics-and-otlp.test.ts` (3/3), `accounting-query-worker.test.ts` (5/5), `usage-accounting-query.test.ts` (3/3; host blocking `1.46 ms p95` idle / `1.60 ms p95` concurrent-fsync contended `<= 50 ms`), `degraded-operation-and-restore-drill.test.ts` (6/6), `sqlite-large-restore-fencing.test.ts` (4/4), `release-advisory.test.ts` (54/54), `release-candidate.test.ts` (79/79), `npm run a11y` (19/19) | **PASS** (recorded by `npm run gate:record` at branch head before `develop` merge) |

---

## 4. Explicit Unqualified / Open Release Prerequisites

Nothing in this record claims readiness beyond private-to-author local macOS arm64 engineering preview:

1. **Live paid shipped-transport provider canary (`npm run canary`)**: **UNQUALIFIED** in this round (not executed against paid `claude`, `codex`, or `agy` live provider accounts during Round 8 autonomous execution). Release preparation (`npm run release`) refuses without fresh live `.backend-qualification.json` unless overridden via `SCHEGENT_RELEASE_UNQUALIFIED=1` and logged in [`backend-qualification-log.md`](backend-qualification-log.md).
2. **Human assistive-technology (AT) verification**: **UNTESTED / NOT OBSERVED** on all four rows (macOS VoiceOver, Windows NVDA, Windows Narrator, Linux Orca) in [`accessibility-at-matrix.md`](accessibility-at-matrix.md) (review date stands at `2026-11-27`). Automated Playwright axe scans are not WCAG conformance.
3. **Cross-platform & remote host matrix**: **UNOBSERVED** on macOS/Node 22, Linux desktop, Windows desktop, and Remote SSH / Dev Container / WSL hosts ([`qualification-matrix.md`](qualification-matrix.md)).
4. **External OpenTelemetry Collector interoperability**: **UNOBSERVED** beyond loopback HTTP fixture collectors ([`docs/operations/telemetry-export.md`](../operations/telemetry-export.md)).
5. **Independent third-party Criterion 8 architecture review**: **NOT MET** (`docs/architecture/release-posture-engineering-preview.md`).

