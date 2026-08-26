# Course: Develop Schegent

This is the shortest path for a contributor who needs to understand enough of
Schegent to make one safe change. It is a routed course, not a request to read
every document. Follow the common spine through lesson 4, choose one change-area
branch in lesson 5, then verify and hand off.

<!-- Source: ../../CONTRIBUTING.md -->
<!-- Source: ../../ARCHITECTURE.md -->

## The path

| Lesson | Outcome |
|---|---|
| 1. Build the checkout | Both the extension host and webview compile. |
| 2. Load the governing rules | You know which invariants can constrain the change. |
| 3. Learn the product nouns | Phase, Pipeline, Task, Queue, and Run mean one thing. |
| 4. Trace one request | You can follow UI input to a backend process and evidence. |
| 5. Choose one code-area branch | You read only the references relevant to the change. |
| 6. Implement and verify | The narrow checks and repository gates support the result. |
| 7. Hand off the change | Reviewers can see scope, evidence, and policy impact. |

## 1. Build the checkout

Use Node.js `24.19.0`, the version pinned by `.nvmrc`; Node 22 and 24 satisfy
the package engine constraint. From a fresh clone:

```bash
git clone https://github.com/lehoa1806/schegent.git
cd schegent
nvm use
npm ci
npm --prefix webview-ui ci
npm run build
npm run test:integration
```

**The webview install is its own command.** `.npmrc` sets `ignore-scripts=true` in both trees
(`FR-R3-090`), so the root `postinstall` that used to install `webview-ui` does not run; without
the second install the build fails. This page previously said the root install also installed
`webview-ui`, which stopped being true when the hardening landed.

The build compiles the Svelte webviews and bundles the extension host. `test:integration` is the
repository-defined automated Extension Development Host path.

**There IS an interactive F5 launch configuration**: `.vscode/launch.json`, added by
`FR-R3-073`. This page previously denied it. What is genuinely absent is
`.vscode/tasks.json` — the launch configuration names a `preLaunchTask`, and VS Code satisfies
it from its auto-detected npm tasks rather than from a checked-in task file.

<!-- Source: ../../.nvmrc -->
<!-- Source: ../../package.json -->
<!-- Source: ../tutorials/developer-setup.md -->

If this is your first checkout, keep [Developer setup](../tutorials/developer-setup.md)
open until the integration host succeeds. After that, use this course as the
navigation spine.

## 2. Load the governing rules before editing

Read the execution repository's `AGENTS.md`, then its workspace-level
`../AGENTS.md`. The parent file is the source of truth for sensitive host-code
invariants, nested-repository synchronization, and the Spec Driven Development
workflow. If you cloned only this execution repository and `../AGENTS.md` is
absent, do not guess at a change involving IPC, audit/redaction, locks, state
migration, process execution, or catalog save gates; obtain the governing rules
from a maintainer first.

Before adding text rendered to an operator, read the
[English-only decision](../concepts/english-only-not-localizable.md). Schegent
keeps English literals at their render sites and does not add a localization
boundary.

<!-- Source: ../../AGENTS.md -->
<!-- Source: ../../../AGENTS.md -->
<!-- Source: ../concepts/english-only-not-localizable.md -->

Then read [Contributing](../../CONTRIBUTING.md). It defines the supported lint
wrappers, generated-contract workflow, pull-request base, verification gates,
and evidence expected in a review.

## 3. Learn only the shared product model

Read [Core concepts](../explanation/core-concepts.md), using the
[Glossary](../reference/glossary.md) only when a term is unclear. The minimum
model is:

- a **Phase** is one backend invocation contract;
- a **Pipeline** is an ordered, versioned list of Phases;
- a **Task** is queued operator intent;
- a **Queue** owns Task order and at most one in-flight Task;
- a **Run** is execution of a frozen Pipeline plan;
- a **Workflow** connects several Pipeline Runs as a graph.

<!-- Source: ../explanation/core-concepts.md -->
<!-- Source: ../reference/glossary.md -->
<!-- Source: ../../src/contracts/run-request.ts -->

Do not start with every feature or operations page. The product model plus the
runtime path below is enough to choose the next document deliberately.

## 4. Trace one request through the system

Read [Schegent Architecture](../../ARCHITECTURE.md), then trace this spine in
the source:

```text
src/extension.ts
  -> src/activation/                    composition and lifecycle
  -> src/ui/sidebar/ + src/contracts/   webview boundary and validation
  -> src/services/run-request/          effective definition and frozen plan
  -> src/services/guarded-run-service.ts
  -> src/queue/ + src/services/auto-drain-coordinator.ts
  -> src/controller/ + src/services/run-driver.ts
  -> src/runner/                        backend argv and child process
  -> src/state/ + src/audit/            persistence and evidence
  -> src/ui/sidebar/ projectors         immutable UI snapshot
```

Operator actions enter through contributed VS Code commands or Svelte
webviews. Host-side validators, Workspace Trust, and primary-window checks gate
mutation. Run-request validation resolves the Active definition and creates the
frozen plan that admission persists. Queue draining starts the controller,
which invokes a backend adapter and records state and evidence. Projectors turn
those sources back into the sidebar and dashboard snapshot.

<!-- Source: ../../src/extension.ts -->
<!-- Source: ../../src/activation/ui-wiring.ts -->
<!-- Source: ../../src/ui/sidebar/message-router.ts -->
<!-- Source: ../../src/contracts/runtime-validators.ts -->
<!-- Source: ../../src/services/run-request/run-request-validator.ts -->
<!-- Source: ../../src/services/guarded-run-service.ts -->
<!-- Source: ../../src/services/auto-drain-coordinator.ts -->
<!-- Source: ../../src/controller/workflow-controller.ts -->
<!-- Source: ../../src/services/run-driver.ts -->
<!-- Source: ../../src/runner/backend-runner-registry.ts -->
<!-- Source: ../../src/ui/sidebar/state-projector-runtime.ts -->

Use [Architecture explanation](../explanation/architecture.md) only when you
need the expanded topology or activation sequence; it is a deeper view of the
same system, not another prerequisite.

## 5. Choose one change-area branch

Pick the row that matches the intended change. Read that row's documents and
the nearby source; ignore the other branches until your scope reaches them.

| Change area | Read next | Start in |
|---|---|---|
| Webview UI or IPC | [API and CLI](../reference/api-and-cli.md), [Contract generation](../operations/contract-generation.md) | `webview-ui/src/`, `src/contracts/`, `src/ui/` |
| Phase, Pipeline, Workflow, or YAML | [Custom Phases](../features/custom-phases.md), [Process YAML](../operations/process-yaml.md), [Phase YAML exchange](../features/phase-yaml-exchange.md) | `src/catalog/`, `src/config/`, `src/services/process-yaml/` |
| Queue, scheduling, or concurrency | [Multi-queue concurrency](../operations/multi-queue-concurrency.md), [File layout](../reference/file-layout.md) | `src/queue/`, `src/services/auto-drain-coordinator.ts` |
| Run lifecycle, pause, retry, or recovery | [Product workflows](../how-to/product-workflows.md), [Sessions and logs](../concepts/sessions-and-logs.md) | `src/controller/`, `src/services/`, `src/state/` |
| Backend invocation or environment | [Backend operations](../operations/backends.md), [Settings](../reference/settings.md) | `src/runner/`, `src/config/` |
| Ownership, state, or migrations | [Workspace lock](../concepts/workspace-lock.md), [Workspace ownership fencing](../architecture/workspace-ownership-fencing.md), [File layout](../reference/file-layout.md) | `src/state/`, `src/queue/` |
| Audit, transcripts, logging, or security | [Audit events](../reference/audit-events.md), [Runtime log](../operations/runtime-log.md), [Threat model](../security/threat-model.md) | `src/audit/`, `src/lib/`, `src/parser/` |
| Packaging or release | [Release process](../../RELEASE.md), [VSIX allowlist derivation](../operations/vsix-allowlist-derivation.md) | `package.json`, `.github/workflows/`, `scripts/` |

If the change crosses several rows, write down why before widening the scope.
That reason tells reviewers which additional invariants and tests must follow.

## 6. Implement and verify

Keep the edit small and follow the existing module boundary. Add or update the
nearest deterministic test first, then run focused checks while iterating. If a
contract source changed, regenerate and verify the generated contracts:

```bash
npm run contracts:generate
npm run contracts:check
```

Before handoff, run the gates proportional to the change. The repository-wide
baseline is:

```bash
npm run verify:all
npm run ci
```

`verify:all` includes documentation, contract, security, license, type, lint,
host-test, and covered-webview gates. `ci` adds the broader build, evaluation,
visual, performance, E2E, package-smoke, and integration path. Use
[Developer workflows](../how-to/developer-workflows.md) to choose exact focused
commands or interpret a failure.

<!-- Source: ../../CONTRIBUTING.md -->
<!-- Source: ../../package.json -->
<!-- Source: ../how-to/developer-workflows.md -->

## 7. Hand off the change

Use `.github/PULL_REQUEST_TEMPLATE.md` and report:

- what changed and why;
- the exact checks run and their results;
- any contract, compatibility, privacy, or security effect;
- which governing invariant or architecture boundary was touched;
- any nested-repository synchronization required by the parent workspace.

Stop here when the change is verified. Release, security, and historical
decision documents are specialist paths, not the next chapter of every
contribution.

<!-- Source: ../../.github/PULL_REQUEST_TEMPLATE.md -->
<!-- Source: ../../CONTRIBUTING.md -->

Return to the [documentation path selector](../README.md) when your goal changes.
