# Node and VS Code runtime floors

The source toolchain supports Node `^22.22.3 || ^24.15.0`. The development pin is 24.19.0. The installed extension requires VS Code 1.125.0 or newer. The minimums account for the operational store’s SQLite 3.51.3 WAL fix and the transaction-state API used by recovery.

## Runtime verification on 27 November 2026

Node 22.13.0 passed both engine-strict installs and the build. Its full host run at `8306c78f` failed 352 tests, passed 23,921 and skipped 14. Transaction state and read-only SQLite URI handling affected recovery and relocation. Node 22.22.3 and 24.15.0 both bundle SQLite 3.51.3. The official macOS arm64 archives were verified against the published SHA-256 manifests. [Node 22.22.3 release](https://nodejs.org/en/blog/release/v22.22.3) · [Node 24.15.0 release](https://nodejs.org/en/blog/release/v24.15.0)

The VS Code 1.107.0 binary bundles SQLite 3.50.4. The macOS arm64 VS Code 1.125.0 binary reports Electron 42.2.0, Node 24.15.0 and SQLite 3.51.3, source ID `737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618`. This editor also has matching published TypeScript API definitions. The extension-host integration test checked the actual engine version and observed transaction state before, during and after a WAL commit. All 22 modules passed across the single-folder, multi-root, trust-untrusted and trust-granted launches.

A normal `npm ci` on Node 22.16.0 refused the root and webview packages with `EBADENGINE`. On Node 22.22.3 with npm 10.9.8, both offline clean installs, the production build and SBOM generation passed in a paired checkout. The full host suite passed 24,273 tests and skipped 14. It includes restart recovery, relocation, and rejecting a stored log reference containing a NUL byte before any file lookup.

Node 24.15.0 with npm 11.12.1 passed the same clean installs, build and SBOM generation. Its first host run exited 139. The macOS crash report placed the fault in SQLite during a worker-thread write. Two complete reruns each passed 24,273 tests with 14 skipped. The cause of the first crash is unresolved.

## The historical 22.23.2 run

- **Date**: 2026-11-06, from 17:41:52Z to 17:45:35Z.
- **Runtime**: Node v22.23.2 with npm 10.9.8, installed and selected by `fnm`.
- **Commit**: `repo/` at `f73e2226`, with the uncommitted work of `FR-R5-F21` in place. That work
  changed `scripts/`, `tests/`, `docs/`, `CONTRIBUTING.md` and the `scripts` block of
  `package.json`. It changed no file under `src/` or `webview-ui/`, and no dependency or lockfile.
- **Platform**: macOS on arm64.
- **Load**: 53.00 when it started, from other sessions on the machine; no other test tier ran from
  this one.

| Command | Exit | Result | Duration |
|---|---|---|---|
| `fnm exec --using=22.23.2 -- node --version` | 0 | `v22.23.2` | 0 s |
| `fnm exec --using=22.23.2 -- npm --version` | 0 | `10.9.8` | 1 s |
| `fnm exec --using=22.23.2 -- npm run test:host` | 1 | test files: 11 failed, 1207 passed, 3 skipped (1221); tests: 32 failed, 18115 passed, 9 skipped (18156) | 212 s |
| `fnm exec --using=22.23.2 -- npm run build` | 0 | the webview (`vite build`) then the host (`esbuild`, `dist/extension.js`) | 9 s |
| `fnm exec --using=22.23.2 -- npm run sbom` | 0 | 692 components from 2 lockfiles and 2 module graphs | 1 s |

## Failures specific to Node 22

None. The 11 failing files were re-run under the pinned Node 24.19.0 in one invocation, and the same
32 tests failed in the same 11 files. No follow-up filing was needed.

## Failures that are not about the floor

The 32 failures were already failing at develop. They were recorded with the same files and counts
by the verify runs of features 278 and 280 in the planning workspace, and none of them is about
Node 22. They are listed here so the next floor run can be compared against them:

| Test file | Failed |
|---|---|
| `tests/lint/evidence-sink-mode-census.test.ts` | 18 |
| `tests/integration/workflow-control-leaf-end.test.ts` | 3 |
| `tests/integration/retry-identity-host.test.ts` | 2 |
| `tests/lint/compiler-strictness-ratchet.test.ts` | 2 |
| `tests/contract/history-does-not-change-run-path.test.ts` | 1 |
| `tests/contract/launch-workflow.test.ts` | 1 |
| `tests/lint/credential-wording.test.ts` | 1 |
| `tests/lint/destructive-fs-requires-containment.test.ts` | 1 |
| `tests/lint/doc-duplicate-authority.test.ts` | 1 |
| `tests/lint/webview-host-import-direction.test.ts` | 1 |
| `tests/parity/visual-fixture-schema-parity.test.ts` | 1 |

Both counts of the strictness ratchet read 5 higher during this run than they read at develop. The
same 5 diagnostics raised both counts. They came from `FR-R5-F21`'s own work in progress, and that
feature removed them before it was committed. The count of failed tests is the same either way.

## What this run does not show

- **One `node_modules`.** The run used the dependency tree installed under Node 24. Nothing was
  reinstalled under Node 22, so an install-time difference (a native build, a postinstall step, an
  engine check during `npm ci`) is not covered.
- **The plain-Node toolchain only.** The run covers the host test tier, the production build and
  the bill of materials. It does not cover the webview test tier, the typecheck or lint gates,
  `npm run gate`, or the extension-host integration tier.
- **Not the editor's runtime.** The extension runs inside the editor's own bundled Node, whatever
  version that editor ships. This run says nothing about that runtime; the separate observation
  below does, for the declared VS Code floor only.
- **macOS only.** Linux and Windows are not covered.
- **Not a qualification cell.** Each cell of the [qualification matrix](qualification-matrix.md) is
  an `npm run gate` observation recorded through `npm run gate:record`. This run is neither, so the
  macOS / Node 22 cell stays `unobserved`.

## Historical editor observation on 12 November 2026

Added 2026-11-12 (review gap GC-19). The SQLite store runs on the `node:sqlite` built into the
extension host's Node, which is Electron's and not the Node in `.nvmrc`, and nothing had recorded
which Node the declared VS Code floor ships. This is a separate observation from the run above and is
not replaced with it.

- **Date**: 2026-11-12, from 11:09:32Z to 11:10:16Z.
- **Command**: `fnm exec --using=24.19.0 -- npm run test:integration`, exit 0. The harness completed
  21 test modules across 4 launches (single-folder 18, multi-root 1, trust-untrusted 1,
  trust-granted 1), against the VS Code version `engines.vscode` declares.
- **Commit**: `repo/` at `fafb67f6`, with `tests/integration/runtime-floor.host.test.ts`
  uncommitted; it is committed with this section.
- **Platform**: macOS on arm64. No other test tier ran.

`runtime-floor.host.test.ts` runs inside the extension host and printed:

```text
runtime-floor: vscode=1.107.0 electron=39.2.3 node=22.21.1
runtime-floor: node:sqlite DatabaseSync opened a WAL file database, wrote and read in the extension host
```

The 1.107.0 observation established a successful file-backed WAL write under Node 22.21.1. It did not measure the SQLite version. The November 27 observation above supersedes it for release qualification.

What it does not show:

- **The floor build only.** A newer VS Code ships another Electron and another Node; none was observed.
- **A lower patch than the plain-Node run.** The editor's 22.21.1 is older than the 22.23.2 the run
  above used, so that run is no proxy for the editor's Node.
- **One table, not the store.** The module exercises `node:sqlite` directly; it does not run the
  store's schema or migrations.
- **macOS only**, as above.

## When to run it again

At each held-major review, and before each release. The commands are in
[CONTRIBUTING.md](../../CONTRIBUTING.md), under the Node floor paragraph. Run them one after
another, never alongside another test tier. Then replace this record, and compare the failures
against the tables above.
