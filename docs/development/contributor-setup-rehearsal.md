# Contributor setup rehearsal (`FR-R8-03` / `03-06`)

**Rehearsed**: 2026-11-24 · **Environment**: `darwin/arm64` (Apple M4 Max, macOS 27.0), Node `v24.22.2` (`.nvmrc` pins `24.19.0`; `engines.node` declares `^22 || ^24`).

This record captures an end-to-end verification of the contributor onboarding instructions in [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`README.md`](../../README.md), and [`docs/tutorials/developer-setup.md`](../tutorials/developer-setup.md) across both supported checkout layouts. The authoritative two-command install sequence remains in [`CONTRIBUTING.md#prepare-a-checkout`](../../CONTRIBUTING.md#prepare-a-checkout).

## 1. Missing `webview-ui/node_modules` fail-fast diagnostic

With `.npmrc` setting `ignore-scripts=true` in both trees, running only the root install leaves `webview-ui/node_modules/` absent. Rehearsing `node scripts/check-webview-install.mjs` in a clean temporary checkout containing `scripts/check-webview-install.mjs`, `scripts/invoked-as-script.mjs`, and `webview-ui/package.json` without `webview-ui/node_modules/` exited `1` immediately with:

```text
The webview dependencies are not installed (webview-ui/node_modules/vite/package.json is missing). The root postinstall that would install them does not run, because .npmrc sets ignore-scripts=true. Run: npm --prefix webview-ui ci
```

## 2. Paired nested workspace vs. standalone `repo/` clone

| Capability / Check | Paired Nested Workspace (`<workspace>/` + `<workspace>/repo/`) | Standalone `repo/` Clone |
|---|---|---|
| Two-command locked install (`CONTRIBUTING.md#prepare-a-checkout`) | Supported (`ignore-scripts=true` in both `.npmrc` files) | Supported identically |
| `npm run build`, `npm run sbom`, `npm run notices`, `npm run package:smoke` | Pass (`dist/extension.js`, `dist/acp-stdio-bridge.js`, `dist/webview/`, `schegent-sbom.cdx.json`, `THIRD-PARTY-NOTICES.md`) | Pass identically |
| `npm run gate` (23 checks) | Full check set including parent-envelope corpus checks; `scripts/gate-observation.mjs` records `envelope: true` | Passes self-contained; `scripts/gate-observation.mjs` records `envelope: false`; `basename-line-references` and `doc-references-outside-markdown` narrow to `repo/` alone |
| VS Code `.vscode/launch.json` (**Run Extension**, **Debug Current Host Test File**) | Discovered only when `<workspace>/repo/` is opened as a VS Code workspace folder (not when opening `<workspace>/` alone) | Discovered immediately at clone root |
| Parent hard rules (`../docs/hard-rules.md`) & nested sync hooks (`../scripts/hooks/`) | Present; activate with `git config core.hooksPath scripts/hooks` in both repos and verify with `bash scripts/hooks-preflight.sh` | **Absent** — obtain the planning envelope before editing hard-rule surfaces; workspace sync (`scripts/sync-status.sh`, `scripts/merge-record-status.sh`, `scripts/posture-status.sh`) requires the parent envelope |

## 3. Documentation inaccuracies fixed during rehearsal (`2026-11-24`)

1. **`README.md` Get Started**: Previously opened with "Install a tagged-release VSIX when one is available", implying a published GitHub Release distribution channel. Corrected to state the current private-to-author engineering-preview posture and local packaging path (`npm run release` / `npm run package`).
2. **`README.md` Development**: Previously stated that omitting the second install command fails "somewhere that does not mention installing" (outdated pre-`check-webview-install.mjs` prose). Updated to match `CONTRIBUTING.md` and the rehearsed fail-fast diagnostic above.
3. **`docs/operations/production-workflow-integration-matrix.md`**: Added explicit rows for Phase Handoff eligibility (`FR-R8-02` `02-02`) and Isolated Execution Lane recovery (`FR-R8-01` `01-07`, `src/commands/execution-lane-recovery.ts`) so the support matrix matches the shipped code and tests.

<!-- Source: scripts/check-webview-install.mjs -->
<!-- Source: scripts/gate-observation.mjs -->
<!-- Source: CONTRIBUTING.md -->
<!-- Source: README.md -->
<!-- Source: docs/tutorials/developer-setup.md -->

