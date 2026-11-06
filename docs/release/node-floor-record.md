# Node 22 floor record

**What ran on the declared Node 22 floor, and what that does not show.** `package.json` declares
Node `^22 || ^24`, and the repository pins 24.19.0 in `.nvmrc`. The hosted workflows that ran the
floor were retired on 2026-08-26 (`FR-R3-099`). This page records the run that exercised the floor
again (`FR-R5-F21`, FR-019). The next run replaces this record.

## The run

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
  version that editor ships. This run says nothing about that runtime.
- **macOS only.** Linux and Windows are not covered.
- **Not a qualification cell.** Each cell of the [qualification matrix](qualification-matrix.md) is
  an `npm run gate` observation recorded through `npm run gate:record`. This run is neither, so the
  macOS / Node 22 cell stays `unobserved`.

## When to run it again

At each held-major review, and before each release. The commands are in
[CONTRIBUTING.md](../../CONTRIBUTING.md), under the Node floor paragraph. Run them one after
another, never alongside another test tier. Then replace this record, and compare the failures
against the tables above.
