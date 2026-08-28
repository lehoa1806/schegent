# Contributing to Schegent

Schegent accepts changes through pull requests targeting `develop`. Nothing checks them on the remote: hosted CI was retired 2026-08-26 by operator decision (`FR-R3-099`), which deleted `.github/workflows/`, and no branch-protection or repository-ruleset file is present. Verification is local and the whole of it — run `npm run gate` before you open a pull request, because no second enforcement point will catch what you skip. The current state of every release control is generated into [current release controls](docs/release/current-release-controls.md).
<!-- Source: docs/release/actions-terminal-record.md -->

## Read these ten, in this order — then stop

**`FR-R3-121`, 2026-08-27.** This repository carries **16.6 MB of Markdown across 1,377 files**
and **151 lint gates** against a 99k-line implementation. Almost all of it is reference, and
nothing said so. A contributor who tried to read their way in had no way to know where the
bottom was, which is a real entry cost and the mechanical half of the single-reviewer problem
recorded in [`SECURITY.md`](SECURITY.md).

This is the bounded list. **Everything not on it is reference — reach for it when a task sends
you there, not before.**

| # | Read | Why it is on a ten-item list |
|---|---|---|
| 1 | [`README.md`](README.md) | what the product is, and what it deliberately is not |
| 2 | this file, to the end | how to get a checkout that builds, and what a PR is expected to carry |
| 3 | [`../AGENTS.md`](../AGENTS.md) — the **index** at the head of its hard-rules section, then only the subsystems your change touches | the authority on host-code invariants. It is 872 lines and you are not expected to read all of them; the index exists to route you |
| 4 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | the module boundaries a change is judged against, including which directory is the composition root |
| 5 | [`docs/security/threat-model.md`](docs/security/threat-model.md) | what this product claims to prevent and what it explicitly does not. Read before touching audit, logging, IPC or process execution |
| 6 | [`docs/development/lint-gate-census.md`](docs/development/lint-gate-census.md) | one line per gate. You will trip one; this is how you find out what it wanted without reading 151 files |
| 7 | [`docs/features/custom-phases.md`](docs/features/custom-phases.md) | the Phase model, which most feature work touches |
| 8 | [`RELEASE.md`](RELEASE.md) | what a release is here — entirely local, three binding refusals — so you do not assume a pipeline that does not exist |
| 9 | [`SECURITY.md`](SECURITY.md) | how to report a vulnerability, and who reviews security-sensitive paths |
| 10 | [`docs/development/gate-integrity-measurements.md`](docs/development/gate-integrity-measurements.md) | why the gates are shaped the way they are. Read it when a gate seems excessive — it usually records the incident that produced it |

**Ten, counted honestly.** There is no optional eleventh: a list of eleven with one marked
optional is a list of eleven, and the point of a bound is that it binds.

**What is deliberately not here**: `specs/` (1,145 files — Spec-Driven Development output, kept as
provenance, read only when tracing a decision), the rest of `docs/` (reference), and the 151 gate
files themselves (item 6 is the index into them). None of that is waste; it is simply not an
entry path.

## Start with the governing context

Before changing code, read `../AGENTS.md`, the workspace-level source of truth for host-code invariants. Its rules are especially important for IPC mutations, audit and redaction behavior, workspace/window locks, forward-only state migration, process execution, catalog publication, and run-plan validation.

If a change alters host structure or IPC contracts, update the architecture documentation in the same pull request. If it adds text rendered to an operator, follow the English-only decision recorded in `docs/concepts/english-only-not-localizable.md`: keep the literal at its render site and do not add a localization boundary.
<!-- Source: ../AGENTS.md -->
<!-- Source: AGENTS.md -->

The Master Workspace and this execution repository may be separate Git repositories. When they are, keep their branches and recorded execution-repository hash synchronized as required by `../AGENTS.md`; do not reset, rebase, force-push, or discard either repository without explicit approval.
<!-- Source: ../AGENTS.md -->

## Prepare a checkout

Use Node `24.19.0` for the repository's pinned development runtime. Node `^22` and `^24` are declared compatible in `package.json`, and that declaration is the whole of the floor: the job that used to exercise Node 22 was retired with the workflows on 2026-08-26 (`FR-R3-099`), `.npmrc` does not set `engine-strict`, and no check reads `engines`. A change that breaks Node 22 will not be caught here.

For a local checkout:

```bash
nvm use
npm ci
npm --prefix webview-ui ci
```

**Two commands, and the second one is the point (FR-R3-090).** `.npmrc` in both trees sets
`ignore-scripts=true`, so a plain `npm ci` does not run third-party lifecycle scripts. That disables
the root `postinstall` which used to install `webview-ui`, which is why the second command exists —
without it the first build fails, and it fails somewhere that does not mention installing.

Since **2026-08-26 this is the only authority on how the repository installs.** The hardening used to
live in the workflow files as `npm ci --ignore-scripts`, so the tree CI scanned was installed
differently from the tree a contributor ran — the contributor's being the less hardened of the two, on
the machine that runs an uncontained agent CLI. `FR-R3-099` retired Actions by operator decision and
deleted those files, so the dual authority is gone rather than reconciled.

**When you change the install policy, run the self-test:**

```bash
npm run selftest:install    # a real npm ci into a temporary clone; needs a network, takes minutes
```

It is not in `npm run gate` and never was: a network install inside the hermetic unit tier is what
`FR-R3-033` forbids. Its previous home was a `full-gate.yml` job, which no longer exists, so running
it is now a judgement call rather than a schedule — make it whenever `.npmrc`, the `postinstall`, or
any documented setup sequence changes.

**The one lifecycle script this repository needs, named rather than hidden.** `package.json` declares:

```json
"postinstall": "npm --prefix webview-ui install --no-audit --no-fund"
```

Its only job is to populate `webview-ui/node_modules`. With scripts off it no longer runs, so the
second command above replaces it — as a **declared step**, per the FR-R3-065 rule that a prerequisite
hidden inside a gate is not the same as a declared one. That is not a workaround: every CI job has
always done exactly this, running `npm --prefix webview-ui ci --ignore-scripts` explicitly.

**No third-party postinstall is required by either tree.** If a future dependency needs one, name it
here with what it does and why, and run it as its own declared step. Do not re-enable scripts globally
to accommodate one package, and do not auto-install anything inside a gate — `FR-R3-065` declined that
for the reason `FR-R3-045` declined putting the Electron download in `ci:fast`.

`tests/lint/install-flag-parity.test.ts` reads the two `.npmrc` files and the documents that teach
the install sequence. It used to check them against the install flags in the workflow files; those
were deleted when Actions were retired on 2026-08-26 (`FR-R3-099`), so the dual authority is gone
rather than reconciled, and what the gate now adds is that no workflow directory has reappeared to
become a second one.

The visual regression suite needs a Chromium build that `npm ci` does not fetch. Install it once:

```bash
npx playwright install chromium
```

Without it, `npm run test:visual` — and therefore `npm run ci:fast` — fails its preflight with one message naming this command. **Re-run it after any Playwright version bump**: the browser is pinned to a revision the installed Playwright resolves, so a bump moves the target and a cache that worked yesterday stops satisfying it. That is a stale cache, not a broken test, and the preflight says which. The recorded fail/install/pass sequence and what the preflight does not cover are in [Visual gate preflight observations](docs/operations/visual-gate-preflight-observations.md).

See [Developer setup](docs/tutorials/developer-setup.md) for the complete build and Extension Development Host check.
<!-- Source: .nvmrc -->
<!-- Source: package.json -->
<!-- Source: .npmrc -->
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: scripts/check-playwright-browser.mjs -->

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

**Three tiers, cheapest first** (`FR-R3-132`) — full detail, and what each one does *not* establish,
in [Verification tiers](docs/development/verification-tiers.md):

```bash
npm run verify:edit      # typechecks + both unit suites — after a small change
npm run verify:push      # + lint, contracts, docs, security, licences — before you push
npm run verify:release   # everything, including the browser-backed suites — releases and CI
```

Each tier runs everything the tier below it runs; `repo/tests/lint/verification-tiers.test.ts` proves
that as a set relation, so a cheap tier is never a shortcut. No tier reuses a build artifact: a
ratchet that reads source cannot go stale, and a reused `dist/` can.

There is deliberately **no devcontainer**: parity comes from `.nvmrc` plus the two lockfiles, and the
reasoning and reopening conditions are recorded in
[the devcontainer declination](docs/development/devcontainer-declination.md) rather than left as a gap.

At minimum, run the checks relevant to the changed tree. The broad repository gates are:

`npm run ci:fast` is **not** one of the tiers, despite the name — see the tier document. The review
preflight `npm run ci:fast` invokes these manifest targets in order: `typecheck:tests`, `lint`, `verify:all`, `test:evals`, `test:visual`, `test:perf`, `build:host`, and `package:smoke`. It therefore includes browser-backed visual testing and a VSIX package smoke build, not only typechecking and unit tests. The visual step needs the Chromium build declared under [Prepare a checkout](#prepare-a-checkout) — `npx playwright install chromium`, re-run after a Playwright version bump. A missing or stale browser fails the preflight with a single setup message rather than a wall of red specs.

<!-- Source: package.json -->

```bash
npm run verify:all
npm run ci
```

`verify:all` covers contract freshness, documentation, secret scanning, pinned actions, production-license policy, all type checks, both lint passes, host tests, and covered webview tests.

**If `test:host` dies with `Segmentation fault: 11` and zero test failures, it is not your change.** Diagnosed 2026-08-24 from two macOS crash reports (2026-08-23 05:56 and 2026-08-24 18:31, both during `test:host`, Node `24.19.0` arm64): `EXC_BAD_ACCESS`, `KERN_INVALID_ADDRESS at 0x1`, on a `V8Worker` platform thread inside V8's concurrent Sparkplug JIT — `ConcurrentBaselineCompiler::JobDispatcher::Run` → `BaselineCompilerTask::Compile` → `BaselineCompiler::GenerateCode` → `AssemblerBase::AddEmbeddedObject`. No JavaScript frame appears in the faulting stack, so no test is implicated; the `npm` wrapper then kills itself propagating the child's signal, which is the line the shell prints. Confirm your own case the same way: `ls -lt ~/Library/Logs/DiagnosticReports/node-*.ips` and read the faulting thread. Re-running is the correct response, and the crash is not currently worked around: `--concurrent-sparkplug` is on by default and is rejected by both `NODE_OPTIONS` and worker `execArgv`, so disabling it would mean replacing `vitest run` with a raw `node` invocation permanently — a standing cost against a rare upstream fault. If it starts recurring in CI rather than locally, that trade is worth revisiting. Several of its checks decided their rules by measurement rather than by choosing a number, and each records how — among them the [duplicate-authority threshold](docs/operations/duplicate-authority-threshold-measurement.md), the [counts the round-3 documents assert](docs/operations/asserted-counts-sweep.md), the [lazy-route wait budget](docs/operations/lazy-route-wait-budget.md) and the [webview coverage floors](docs/development/coverage-measurements.md). `ci` covers the broad build/test/package path but does not invoke `verify:all`; use both for a release-sized change. More focused commands and their exact scopes are documented in [Developer workflows](docs/how-to/developer-workflows.md).
<!-- Source: package.json -->

Nothing runs on a pull request. Four workflows were configured for `develop` until they were retired
on 2026-08-26 (`FR-R3-099`) — `PR` and `CI` across three operating systems, a dependency review that
refused new `high`-severity dependencies, and a CodeQL scan whose findings never failed the build.
What each one did, and what did and did not replace it, is the subject of
[the terminal record](docs/release/actions-terminal-record.md) and
[withdrawn CI controls](docs/release/withdrawn-ci-controls.md).

The practical consequence for a contributor: the three-OS matrix is gone and single-platform is a
stated permanent limit, so a Windows-only or macOS-only regression will reach `develop`. Run
`npm run gate` locally; it is the only gate there is.
<!-- Source: docs/release/actions-terminal-record.md -->

**`.vscode/launch.json` exists** — `FR-R3-073` added it, and this sentence denied it until
2026-08-26 (`FR-R3-101`). Its single `Run Extension` configuration is the interactive F5 path,
and its `outFiles` names `dist/**` because that is where `esbuild.config.mjs` bundles the host;
it named `out/**` until the same date, which is the integration-test compile target, so F5
breakpoints bound against the wrong artifact and never hit.

**`.vscode/tasks.json` genuinely does not exist**, and the launch configuration names a
`preLaunchTask` of `npm: build` anyway. That works because VS Code auto-detects npm scripts as
tasks; it is not a checked-in task definition, so a contributor who disables npm task
auto-detection will see the launch fail to build first. One honest sentence rather than either
claiming a task file or denying the launch file.

`npm run test:integration` remains the checked-in automated Extension Development Host path,
and it is the one CI-equivalent route — F5 is a person at a keyboard.
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
