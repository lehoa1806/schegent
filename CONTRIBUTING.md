# Contributing to Schegent

Schegent accepts changes through pull requests targeting `develop`; the checked-in PR and CI workflows are configured for that base branch. No branch-protection or repository-ruleset file is present, so this repository can describe the checks GitHub is configured to run, but it cannot prove which status checks the remote repository requires for merge.
<!-- Source: .github/workflows/pr.yml -->
<!-- Source: .github/workflows/ci.yml -->

## Start with the governing context

Before changing code, read `../AGENTS.md`, the workspace-level source of truth for host-code invariants. Its rules are especially important for IPC mutations, audit and redaction behavior, workspace/window locks, forward-only state migration, process execution, catalog publication, and run-plan validation.

If a change alters host structure or IPC contracts, update the architecture documentation in the same pull request. If it adds text rendered to an operator, follow the English-only decision recorded in `docs/concepts/english-only-not-localizable.md`: keep the literal at its render site and do not add a localization boundary.
<!-- Source: ../AGENTS.md -->
<!-- Source: AGENTS.md -->

The Master Workspace and this execution repository may be separate Git repositories. When they are, keep their branches and recorded execution-repository hash synchronized as required by `../AGENTS.md`; do not reset, rebase, force-push, or discard either repository without explicit approval.
<!-- Source: ../AGENTS.md -->

## Prepare a checkout

Use Node `24.19.0` for the repository's pinned development runtime. Node `^22` and `^24` are declared compatible; CI additionally verifies the Node 22 floor.

For a normal local checkout:

```bash
nvm use
npm install
```

The root `postinstall` installs `webview-ui` dependencies. For an installation that mirrors GitHub Actions' reduced lifecycle-script exposure, use both explicit commands instead:

```bash
npm ci --ignore-scripts
npm --prefix webview-ui ci --ignore-scripts
```

See [Developer setup](docs/tutorials/developer-setup.md) for the complete build and Extension Development Host check.
<!-- Source: .nvmrc -->
<!-- Source: package.json -->
<!-- Source: .github/workflows/ci.yml -->

## Keep the change scoped

- Implement the smallest change that satisfies its issue, spec, or invariant. Avoid unrelated refactors, renames, and formatting churn.
- Preserve operator data and audit semantics. Never edit tests or generated artifacts merely to hide a policy failure.
- Do not add a built-in Phase, Pipeline, or Workflow to the extension binary. Shipped process examples live in `examples/` and enter a workspace catalog through import.
- Do not commit secrets, raw transcripts, diagnostic streams, tokens, environment values, or PII to a pull request.

<!-- Source: ../AGENTS.md -->
<!-- Source: .github/PULL_REQUEST_TEMPLATE.md -->
<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

## Follow the actual lint policy

Run the repository wrappers, not a bare ESLint CLI:

```bash
npm run lint
npm run lint:webview
```

The flat configuration is imported by `scripts/lint.mjs`; there is no root `eslint.config.*`. The runner enforces error-severity rules and compares warning counts with `tests/lint/eslint-baseline.json`. A reduction requires lowering the recorded count in the same change; an increase fails as a regression.

Important configured conventions include:

- floating promises, misused promises, and awaiting non-thenables are errors;
- unnecessary conditions and intentionally retained Svelte findings are warnings bounded by the baseline;
- an unused parameter may be prefixed with `_`;
- empty `catch` blocks are permitted by ESLint only because a separate lint test requires a comment declaring why the error is discarded;
- unused `eslint-disable` directives are errors.

There is no `format` script or checked-in Prettier configuration. Prettier is a development dependency, not evidence of a repository-wide formatting command; retain the surrounding file's style and let the supported lint and type gates arbitrate.
<!-- Source: scripts/lint-config.mjs -->
<!-- Source: scripts/lint.mjs -->
<!-- Source: tests/lint/eslint-baseline.json -->
<!-- Source: package.json -->

## Regenerate contracts when their sources change

If you change IPC, audit, settings, queue, state, or backend-runner contract sources, regenerate the checked-in schemas and TypeScript binding, then verify freshness:

```bash
npm run contracts:generate
npm run contracts:check
```

Review every generated difference. Do not hand-edit `src/contracts/generated/` to disagree with its source.
<!-- Source: package.json -->
<!-- Source: scripts/generate-contract-schemas.mjs -->

## Verify before opening a pull request

At minimum, run the checks relevant to the changed tree. The broad repository gates are:

The review preflight `npm run ci:fast` invokes these manifest targets in order: `typecheck:tests`, `lint`, `verify:all`, `test:evals`, `test:visual`, `test:perf`, `build:host`, and `package:smoke`. It therefore includes browser-backed visual testing and a VSIX package smoke build, not only typechecking and unit tests.

<!-- Source: package.json -->

```bash
npm run verify:all
npm run ci
```

`verify:all` covers contract freshness, documentation, secret scanning, pinned actions, production-license policy, all type checks, both lint passes, host tests, and covered webview tests. `ci` covers the broad build/test/package path but does not invoke `verify:all`; use both for a release-sized change. More focused commands and their exact scopes are documented in [Developer workflows](docs/how-to/developer-workflows.md).
<!-- Source: package.json -->

The pull-request workflows currently configured for `develop` run the following:

- `PR`: Node `24.19.0` on Ubuntu, macOS, and Windows; test typecheck, `verify:all`, evals, build, package smoke, and Linux visual regression.
- `CI`: the same three-OS base plus Linux host coverage, E2E and performance tests, package smoke, and Extension Development Host integration; a separate Ubuntu job runs `verify:all` on Node `22.23.2`.
- `Dependency review`: refuses newly introduced dependencies at `high` severity or above.
- `CodeQL`: analyzes JavaScript and TypeScript on pull requests, pushes to `develop`, and weekly, but its workflow explicitly says findings do not fail the build by default.

These are trigger definitions, not proof of remote merge protection.
<!-- Source: .github/workflows/pr.yml -->
<!-- Source: .github/workflows/ci.yml -->
<!-- Source: .github/workflows/dependency-review.yml -->
<!-- Source: .github/workflows/codeql.yml -->

The repository has no `.vscode/launch.json` or `.vscode/tasks.json`; do not claim an exact F5 workflow from the empty `.vscode/settings.json`. Use `npm run test:integration` for the checked-in automated Extension Development Host path.
<!-- Source: .vscode/settings.json -->
<!-- Source: package.json -->
<!-- Source: tests/integration/runTest.ts -->

## Write the pull request

Use `.github/PULL_REQUEST_TEMPLATE.md` and include:

- a concise summary of what changed and why;
- the exact validation you ran, leaving unchecked anything not run;
- the related issue, spec, plan, or backlog item;
- schema-compatibility and policy/security/privacy impact when applicable;
- nested-repository sync status when applicable;
- reviewer notes for known caveats or follow-up work.

The template's self-check calls out redaction, mutating IPC primacy, forbidden `vscode` imports in headless/telemetry code, lock semantics, append-only audit evidence, and Claude continuation argument construction. Treat a checked box as a prompt for a one-line justification.
<!-- Source: .github/PULL_REQUEST_TEMPLATE.md -->
<!-- Source: ../AGENTS.md -->

All paths route to `@lehoa1806` in the checked-in CODEOWNERS file, with explicit security-sensitive entries for logging/redaction, audit, headless, telemetry, the Claude runner, security docs, and security policies.
<!-- Source: .github/CODEOWNERS -->

No commit-message lint, DCO configuration, or general signing rule is checked in. Dependabot-generated dependency commits use `chore(deps-dev)`, but that prefix is scoped to Dependabot and is not a general contributor convention.
<!-- Source: .github/dependabot.yml -->
