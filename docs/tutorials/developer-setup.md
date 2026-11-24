# Developer setup tutorial

This tutorial takes a fresh clone to a compiled Schegent extension and then runs it in the repository's automated VS Code Extension Development Host. Schegent has separate host and Svelte webview builds, both driven from the root npm package.
<!-- Source: package.json -->
<!-- Source: tests/integration/runTest.ts -->

## 1. Check the prerequisites

Install these tools before cloning:

- Node.js 22 or 24. The checked-in `.nvmrc` selects `24.19.0`.
- VS Code 1.107.0 or newer within the 1.x release line — the floor the manifest's
  `engines.vscode` (`^1.107.0`) declares, which is what this line is checked against.
- npm, which is the only package runner used by the checked-in build scripts.

<!-- Source: package.json -->
<!-- Source: .nvmrc -->

No application container, Docker Compose file, or `Makefile` is required for normal local development; the supported development path is the npm script surface in `package.json`. (`scripts/linux-leg/Dockerfile` exists only for the optional release-tier local Linux container unit leg, `npm run verify:linux`, which requires a running Docker or OrbStack daemon.)
<!-- Source: package.json -->
<!-- Source: scripts/linux-leg/Dockerfile -->

To execute real Workflow Phases after setup, make one supported backend CLI available on `PATH`, or configure its path in VS Code. The default runner is `claude`; `codex` and `agy` are also accepted runner kinds, with default executable names `codex` and `agy`.
<!-- Source: package.json -->

## 2. Clone the repository

The package manifest identifies the canonical execution-repository URL:

```bash
git clone https://github.com/lehoa1806/schegent.git
cd schegent
```

A **standalone execution clone** builds, tests, and passes `npm run gate` self-contained, but does not include the parent planning envelope's `docs/hard-rules.md` or workspace `scripts/hooks/`. In a **nested workspace**, this checkout sits at `<workspace>/repo/` inside the parent planning envelope; obtain the planning envelope before editing any hard-rule surface rather than guessing at a rule.
<!-- Source: package.json -->

## 3. Select the checked-in Node.js version

If you use nvm, let it read the repository's version file:

```bash
nvm install
nvm use
node --version
```

The final command should report `v24.19.0` when nvm has honored `.nvmrc`. Node 22 also satisfies the package engine constraint, but it is not the version pinned by this checkout.
<!-- Source: .nvmrc -->
<!-- Source: package.json -->

## 4. Install both package trees

From the repository root, run:

```bash
nvm use
npm ci
npm --prefix webview-ui ci
```

**Two commands, and the second one is the point.** Both installs use the checked-in lockfiles.
`.npmrc` sets `ignore-scripts=true` in both trees (`FR-R3-090`), a deliberate hardening, so the
root `postinstall` that used to install the private `webview-ui` package **does not run** — a
separate webview install is required, not optional. Without the second command, `npm run build`
stops immediately at `scripts/check-webview-install.mjs` with a message naming `npm --prefix webview-ui ci`
(rehearsed in [Contributor setup rehearsal](../development/contributor-setup-rehearsal.md)). See
`CONTRIBUTING.md`, which is the authority for the sequence.

Neither install fetches the Chromium build the visual regression suite launches. Install it once:

```bash
npx playwright install chromium
```

**Re-run it after any Playwright version bump** — the browser is pinned to a revision the installed Playwright resolves, so a bump moves the target and a previously working cache stops satisfying it. Without it, `npm run test:visual` and `npm run ci:fast` stop at a preflight that names this command; see [Visual gate preflight observations](../operations/visual-gate-preflight-observations.md).

### Activate local Git hooks

Hooks are local and opt-in; nothing installs them during `npm ci`. Inside this execution repository (`repo/`), activate the pre-commit secret scan (`scripts/hooks/pre-commit`):

```bash
git config core.hooksPath scripts/hooks
```

In a nested workspace, also activate the parent workspace hooks from the workspace root (`git config core.hooksPath scripts/hooks` for `prepare-commit-msg` and `pre-push`) and confirm both repositories with `bash scripts/hooks-preflight.sh` (run from the workspace root). Passing `--no-verify` bypasses these local checks — `git commit --no-verify` skips the staged secret scan in `repo/` and omits the `Repo-head:` trailer in the workspace, while `git push --no-verify` skips the workspace nested-sync (`scripts/sync-status.sh --verify`) and merge-record (`scripts/merge-record-status.sh`) checks; see [Contributing](../../CONTRIBUTING.md#activate-local-git-hooks) for manual recovery commands.
<!-- Source: package-lock.json -->
<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: scripts/check-playwright-browser.mjs -->
<!-- Source: scripts/hooks/pre-commit -->

## 5. Build the extension

Run the aggregate build:

```bash
npm run build
```

This invokes `build:webview` first and `build:host` second. The webview package runs Vite; the host build bundles `src/extension.ts` as CommonJS at `dist/extension.js` with VS Code kept external.
<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: esbuild.config.mjs -->

## 6. Run the local extension host

Use the repository-defined integration command:

```bash
npm run test:integration
```

The command rebuilds both bundles, compiles the integration harness, acquires a VS Code test executable, and starts it with this checkout as `extensionDevelopmentPath`. The harness opens the repository as a folder, temporarily creates `.specify/` when needed to exercise the manifest activation event, and runs the live-host test modules.
<!-- Source: package.json -->
<!-- Source: tests/integration/runTest.ts -->
<!-- Source: tests/integration/index.ts -->

A successful run ends with output in this form:

```text
Integration host completed <executed> test modules.
```

The numeric count is discovered at runtime; the harness refuses an empty selection and fails if any host-test module fails.
<!-- Source: tests/integration/runTest.ts -->
<!-- Source: tests/integration/index.ts -->

## 7. Confirm the activation boundary

Schegent registers its sidebar before checking for an open workspace. Workspace-bound services are wired only when VS Code has a workspace folder, and the package also declares activation when a workspace contains `.specify/` or `.schegent/`.
<!-- Source: src/extension.ts -->
<!-- Source: package.json -->

The repository provides `.vscode/launch.json` with a **Run Extension** extension-host
configuration, so the interactive session in [User quickstart](user-quickstart.md) — F5 → **Run
Extension** — is the local Extension Development Host workflow this checkout defines.
`npm run test:integration` remains the automated gate: it runs the suites and exits, leaving no
window to click through. A second configuration, **Debug Current Host Test File**, runs the host
test file open in the editor under the debugger with the root vitest config; tests under
`webview-ui/` have their own config and are not covered by it.

**Nested-workspace VS Code folder caveat:** `.vscode/launch.json` lives at `repo/.vscode/launch.json`.
VS Code discovers **Run Extension** and **Debug Current Host Test File** only when `repo/` itself
is opened as a VS Code workspace folder (directly or inside a multi-root workspace); opening the
parent planning-envelope directory alone will not expose either launch configuration.

To run a single test file from the terminal (inside `repo/`):

```bash
npm run test:host -- tests/unit/<area>/<file>.test.ts          # single host test (or: npx vitest run <path>)
npm --prefix webview-ui run test -- src/<area>/<file>.test.ts  # single webview test
```
<!-- Source: .vscode/launch.json -->
<!-- Source: package.json -->

## Optional: rebuild only the webview while editing

```bash
npm run dev:webview
```

This runs Vite in build-watch mode for `webview-ui`. It does not start or watch the extension host.
<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
