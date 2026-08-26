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

No `Dockerfile`, Docker Compose file, or `Makefile` exists in this repository. The supported development path is the npm script surface in `package.json`.
<!-- Absence verified: repository tree contains no Dockerfile, Docker Compose file, or Makefile. -->
<!-- Source: package.json -->

To execute real workflow phases after setup, make one supported backend CLI available on `PATH`, or configure its path in VS Code. The default runner is `claude`; `codex` and `agy` are also accepted runner kinds, with default executable names `codex` and `agy`.
<!-- Source: package.json -->

## 2. Clone the repository

The package manifest identifies the canonical repository URL:

```bash
git clone https://github.com/lehoa1806/schegent.git
cd schegent
```

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
separate webview install is required, not optional. This paragraph previously said the opposite;
the hardening is not reverted to make a document true. See `CONTRIBUTING.md`, which is the
authority for the sequence.

Neither install fetches the Chromium build the visual regression suite launches. Install it once:

```bash
npx playwright install chromium
```

**Re-run it after any Playwright version bump** — the browser is pinned to a revision the installed Playwright resolves, so a bump moves the target and a previously working cache stops satisfying it. Without it, `npm run test:visual` and `npm run ci:fast` stop at a preflight that names this command; see [Visual gate preflight observations](../operations/visual-gate-preflight-observations.md).
<!-- Source: package-lock.json -->
<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: scripts/check-playwright-browser.mjs -->

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
window to click through.
<!-- Source: .vscode/launch.json -->
<!-- Source: package.json -->

## Optional: rebuild only the webview while editing

```bash
npm run dev:webview
```

This runs Vite in build-watch mode for `webview-ui`. It does not start or watch the extension host.
<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
