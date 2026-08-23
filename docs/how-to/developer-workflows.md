# Developer workflows

Run every command in this guide from the repository root unless the command says otherwise. The root `postinstall` installs the nested `webview-ui` dependencies, so a single `npm install` prepares both package trees.
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
| Performance budgets | `npm run test:perf` | `tests/perf/**/*.test.ts`, single-threaded |
| Sustained evidence path | `npm run test:soak` | `tests/perf/sustained-evidence-path.test.ts` with verbose output |
| Deterministic CLI E2E | `npm run test:e2e` | `tests/e2e/**/*.test.ts`, including real child processes against the fake CLI fixture |
| Evaluation fixtures | `npm run test:evals` | `tests/evals/**/*.test.ts` with verbose output |
| Visual regression | `npm run test:visual` | Webview build, then serial Chromium Playwright specs in `tests/visual/` |
| VS Code host integration | `npm run test:integration` | Full build, integration TypeScript emit, then a downloaded VS Code Extension Development Host |

The root coverage floors are 80% statements, 75% branches, 80% functions, and 80% lines. The webview floors are 79%, 74%, 76%, and 79%, respectively; its command also checks that those floors retain the configured headroom.
<!-- Source: package.json -->
<!-- Source: vitest.config.ts -->
<!-- Source: vitest.e2e.config.ts -->
<!-- Source: vitest.evals.config.ts -->
<!-- Source: vitest.perf.config.ts -->
<!-- Source: playwright.config.ts -->
<!-- Source: tests/integration/runTest.ts -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/vitest.config.ts -->

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

They check required documentation and local Markdown links, scan tracked content for configured secret patterns, require immutable commit pins for executable GitHub Actions, and validate production dependency licenses.
<!-- Source: package.json -->
<!-- Source: scripts/check-docs.mjs -->
<!-- Source: scripts/check-doc-links.mjs -->
<!-- Source: scripts/scan-secrets.mjs -->
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

- There is no database or ORM dependency, database schema directory, migration directory, or migration npm script. Schegent persists state through VS Code workspace state and purpose-built files under `.schegent/`; there is no database migration workflow to run. The extension does have forward-only VS Code state migrations through schema version `13`, but activation invokes them automatically and no developer migration command is exposed.
- There is no `format` npm script or checked-in formatter command. Prettier is installed as a development dependency, but contributors should not invent a repository-wide write command from that dependency alone.
- There is no Dockerfile or Makefile. Use the npm targets above.

<!-- Source: package.json -->
<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/workspace-state.ts -->
