# Developer workflows

Run every command in this guide from the repository root unless the command says otherwise.

**Installing takes two commands, not one.** `.npmrc` sets `ignore-scripts=true` in both trees
(`FR-R3-090`), so the root `postinstall` that used to install the nested `webview-ui`
dependencies does not run: `npm ci && npm --prefix webview-ui ci`. This guide previously said a
single install prepared both trees, which stopped being true when the hardening landed. See
`CONTRIBUTING.md` for the authority on the sequence.
<!-- Source: package.json -->

## Check a host-code change

Use this loop for changes under `src/`, `tests/`, or `scripts/`:

```bash
npm run typecheck
npm run lint
npm run test:host
npm run build:host
```

`typecheck` checks the host program without emitting files. `lint` is the repository's supported ESLint entry point for host source, tests, scripts, and root tooling. `test:host` runs the default Vitest selection: unit, non-host integration, parity, lint-policy, and contract tests. `build:host` bundles `src/extension.ts` as CommonJS in `dist/extension.js` and leaves the `vscode` module external.
<!-- Source: package.json -->
<!-- Source: scripts/lint.mjs -->
<!-- Source: vitest.config.ts -->
<!-- Source: esbuild.config.mjs -->

Do not substitute a bare `eslint` invocation. The supported runner applies both the flat configuration and the warning-count baseline. To investigate baselined warnings without changing the gate, use its diagnostic modes:

```bash
node scripts/lint.mjs host --sites
node scripts/lint.mjs host --census
```

`--sites` expands the locations of baselined findings. `--census` reports counts and deliberately does not fail. Replace `host` with `webview` to inspect that tree.
<!-- Source: scripts/lint.mjs -->
<!-- Source: scripts/lint-config.mjs -->

## Check a webview change

Use the webview-specific gates for changes under `webview-ui/`:

```bash
npm run typecheck:webview
npm run lint:webview
npm run test:webview
npm run build:webview
```

The type checker is `svelte-check`; the tests run in jsdom and first verify generated queue-projection mocks; the build is a Vite production build. For a continuously rebuilt bundle while editing, run:

```bash
npm run dev:webview
```

Despite its name, `dev:webview` is `vite build --watch`; the repository does not define a Vite development-server command.
<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/vitest.config.ts -->

## Run the appropriate test suite

| Goal | Exact command | What it runs |
| --- | --- | --- |
| Default host and webview tests | `npm test` | Root Vitest selection, then the webview mock check and Vitest suite |
| Host selection only | `npm run test:host` | Root Vitest selection from `vitest.config.ts` |
| Host coverage | `npm run test:coverage` | Root selection with V8 coverage |
| Webview tests only | `npm run test:webview` | Mock consistency check, then jsdom Vitest tests |
| Webview coverage | `npm run test:webview:coverage` | Webview tests with V8 coverage, then the coverage-headroom ratchet |
| Performance budgets | `npm run test:perf` | `tests/perf/**/*.test.ts`: wall-clock budgets, single-worker, no retries |
| Sustained evidence path | `npm run test:soak` | `tests/perf/sustained-evidence-path.test.ts` with verbose output |
| Deterministic CLI E2E | `npm run test:e2e` | `tests/e2e/**/*.test.ts`, including real child processes against the fake CLI fixture |
| Evaluation fixtures | `npm run test:evals` | `tests/evals/**/*.test.ts` with verbose output |
| Visual regression | `npm run test:visual` | Browser preflight, webview build, then serial Chromium Playwright specs in `tests/visual/`. **Prerequisite:** `npx playwright install chromium`, re-run after a Playwright version bump — the preflight fails with one setup message if the build is absent or stale. A local run reuses a server already on port 4173 only when it is this checkout's fixture server; any other stops the run with one message naming the port |
| VS Code host integration | `npm run test:integration` | Full build, integration TypeScript emit, then a downloaded VS Code Extension Development Host |

The root coverage floors in `vitest.config.ts` are 84% statements, 81% branches, 88% functions, and 84% lines (`npm run coverage:headroom` checks host headroom). The webview floors in `webview-ui/vitest.config.ts` are 88% statements, 75% branches, 83% functions, and 88% lines; `npm run test:webview:coverage` also checks that those floors retain the configured headroom.

To run or debug a single test file without running a full suite:

```bash
npm run test:host -- tests/unit/<area>/<file>.test.ts          # single host test (or: npx vitest run <path>)
npm --prefix webview-ui run test -- src/<area>/<file>.test.ts  # single webview test
```

For interactive F5 host-test debugging, use **Debug Current Host Test File** in `.vscode/launch.json` — in a nested workspace, open `repo/` itself as a VS Code workspace folder so VS Code discovers `repo/.vscode/launch.json`.

**Run heavy suites and tiers sequentially.** Do not run `test:host`, `test:coverage`, `test:perf`, `test:soak`, `test:visual`, `a11y`, `test:e2e`, `test:integration`, or `verify:linux` concurrently in parallel terminals; contention across worker pools, single-threaded perf budgets, shared fixture port `4173`, and VS Code Electron launches causes false failures. See [Verification tiers](../development/verification-tiers.md#run-heavy-tiers-sequentially-avoid-contention).
<!-- Source: package.json -->
<!-- Source: vitest.config.ts -->
<!-- Source: vitest.e2e.config.ts -->
<!-- Source: vitest.evals.config.ts -->
<!-- Source: vitest.perf.config.ts -->
<!-- Source: playwright.config.ts -->
<!-- Source: tests/visual/fixture-server-identity.mjs -->
<!-- Source: scripts/check-playwright-browser.mjs -->
<!-- Source: tests/integration/runTest.ts -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/vitest.config.ts -->

## Change a shipped example

The importable examples are the `.workflow.yaml` packages in `examples/`, listed in [the examples README](../../examples/README.md). A package defines a root Workflow and includes every Phase and child Workflow definition it references, so one file is one import, and no `kind: Pipeline` document is shipped there. The examples are documentation: the catalog ships empty, and these files reach a catalog only through the process-YAML import path.

Adding or removing a file is a decision, not a silent change, because `tests/integration/examples-import.test.ts` pins the set. After editing an example, run the suites that sweep the directory:

```bash
npm run test:host -- tests/integration/examples-import.test.ts tests/integration/process-yaml/shipped-examples-compatibility.test.ts tests/integration/process-yaml/examples-round-trip.test.ts
```

Other suites read individual examples, so finish with the full `npm run test:host` from the loop above.
<!-- Source: examples/README.md -->
<!-- Source: package.json -->
<!-- Source: tests/integration/examples-import.test.ts -->
<!-- Source: tests/integration/process-yaml/shipped-examples-compatibility.test.ts -->
<!-- Source: tests/integration/process-yaml/examples-round-trip.test.ts -->

## Change an IPC or JSON-schema contract

After editing a contract source, regenerate the checked-in boundary artifacts:

```bash
npm run contracts:generate
```

Review the generated diff. To verify that checked-in artifacts already match their sources without rewriting them, run:

```bash
npm run contracts:check
```

The generator reads contract sources including `src/config/settings-schema.ts`, then writes or checks `src/contracts/generated/schemas/*.schema.json`, `src/contracts/generated/schemas/contract-families.json`, and `src/contracts/generated/boundary-contracts.ts`. Contract edits are also subject to the workspace-level rules in `../AGENTS.md`.
<!-- Source: package.json -->
<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: ../AGENTS.md -->

## Check documentation, secrets, workflows, and licenses

These independent repository gates all have checked-in implementations:

```bash
npm run docs:check
npm run security:secrets
npm run security:actions
npm run license:check
```

They check required documentation, that every local Markdown link names a file that exists, and, in
live documents, that a section a link or `§` marker names in another file exists. What that section
check reads, and the count it was built on, is
[recorded as a decision](../development/section-reference-check.md). They also scan tracked content
for configured secret patterns, require immutable commit pins for executable GitHub Actions, and
check three structural license facts: `LICENSE.md` exists, the license operations record exists, and
the manifest's `license` field is set. The license check reads no dependency and no lockfile, so it is
not a review of dependency licenses.

The pin check has three outcomes and names each. With no workflow directory, or an empty one, it
reports *"no workflows present, nothing to pin"* and exits 0: a named no-subject outcome, not a pass.
With workflows that are all pinned to a full 40-character commit it passes and says how many. With an
action pinned by tag, or a directory it cannot read, it refuses. Since the workflows were retired
(`FR-R3-099`) the no-subject outcome is the one a run reports. The check is kept rather than deleted
precisely so a workflow file reappearing is pinned from its first commit rather than from the day
somebody notices.
The secret scan has a second mode that reads what a commit would carry from the Git index, not the working
tree, so a secret staged and then edited out of the working copy is still found. Run it by hand, or activate
the tracked commit hook once, inside `repo/`, so that `git commit` runs it:

```bash
npm run security:secrets:staged
git config core.hooksPath scripts/hooks
```

The hook is local and opt-in, and `git commit --no-verify` bypasses it. To check whether both repositories' hooks are active,
run `bash scripts/hooks-preflight.sh` from the planning workspace root, not from `repo/`. It is a
workspace script that reads both repositories, writes nothing, and exits 1 while any expected hook is inactive. Git does not run the pre-commit hook for a
conflict-free merge, and there is no server-side check, so the tree-mode gate above remains the check that
covers what was merged. [The security notes](../../SECURITY.md) list what the scan detects and what it does not.

In a nested planning workspace, the parent repository also tracks opt-in `scripts/hooks/prepare-commit-msg` and `scripts/hooks/pre-push` (activate from the workspace root with `git config core.hooksPath scripts/hooks`). Bypassing them with `--no-verify` has concrete effects:

- `git commit --no-verify` in the workspace root skips `prepare-commit-msg`, omitting the `Repo-head:` trailer and breaking nested-sync verification until repaired.
- `git push --no-verify` in the workspace root skips `pre-push`, bypassing `scripts/sync-status.sh --verify` (nested-repo sync invariant), `scripts/merge-record-status.sh` (archived gate-record check for `repo/` `develop` merges), and the other workspace push gates.

Run these manual verification/recovery commands from the workspace root after any bypass:

```bash
bash scripts/hooks-preflight.sh
scripts/sync-status.sh --verify
scripts/sync-status.sh --pr-block
scripts/merge-record-status.sh --verify <remote_sha> <local_sha>
```
<!-- Source: package.json -->
<!-- Source: scripts/check-docs.mjs -->
<!-- Source: scripts/check-doc-links.mjs -->
<!-- Source: scripts/scan-secrets.mjs -->
<!-- Source: scripts/hooks/pre-commit -->
<!-- Source: scripts/check-workflow-pins.mjs -->
<!-- Source: scripts/check-licenses.mjs -->

## Choose an aggregate gate

Use `verify:all` for the contract, documentation, security, license, type, lint, and main test gates:

```bash
npm run verify:all
```

Use the repository's broad local CI chain when the change is ready for final verification:

```bash
npm run ci
```

`ci` runs all three type checks, both lint passes, the webview build, host and covered webview tests, evals, visual tests, performance tests, deterministic CLI E2E, the full build, VSIX smoke packaging, and VS Code host integration. Its literal script does not call `verify:all`, so run `verify:all` as a separate gate when contract freshness, docs, secret scanning, action pins, and licenses are in scope.

`npm run ci:fast` is a differently composed gate, not simply `ci` with fewer tests: it invokes `verify:all`, then evals, visual and performance tests, a host build, and package smoke verification.
<!-- Source: package.json -->

## Package without publishing

To create a VSIX with the local VSCE dependency:

```bash
npm run package
```

To build a temporary VSIX and inspect its freshness and packaged contents:

```bash
npm run package:smoke
```

Neither command publishes an extension.
<!-- Source: package.json -->
<!-- Source: scripts/package-vsix-smoke.mjs -->

## Workflows that do not exist

- **No external database server, ORM, or developer migration CLI**: Schegent persists operational state in an embedded local `node:sqlite` database at `<globalStorageUri>/sqlite/<scope>/schegent-state.db` (SQLite schema `9`, `min_reader_version = 9`) and purpose-built files under `.schegent/`.
  VS Code workspace state uses forward-only migrations through `STATE_SCHEMA_VERSION = 15`. There is no ORM dependency, external database service, or standalone developer migration npm script — activation runs forward-only SQLite and workspace-state migrations automatically. For operator store backups and rollback procedures, see [SQLite application store](../operations/sqlite-application-store.md) and [SQLite rollback runbook](../operations/sqlite-rollback-runbook.md).
- **No `format` npm script or checked-in Prettier configuration**: `prettier` is installed in `devDependencies` for tooling only (no `.prettierrc*` config and no `format` script); contributors should not run an ad-hoc repository-wide formatting write pass from that dependency alone.
- **No application dev container or `Makefile`**: There is no Docker Compose file, `Makefile`, or application development container; normal local development uses the npm targets above. (`scripts/linux-leg/Dockerfile` exists solely for the optional release-tier local Linux container unit leg, `npm run verify:linux`.)

<!-- Source: package.json -->
<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/contracts/sqlite-store/schema-types.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: scripts/linux-leg/Dockerfile -->
