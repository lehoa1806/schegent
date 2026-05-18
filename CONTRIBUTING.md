# Contributing to Schegent

Thank you for taking the time to contribute. This document covers the
practical mechanics of filing bugs, suggesting improvements, and
sending patches to the Schegent extension.

The fastest path to a good outcome is a clear, reproducible report
plus the diagnostic artifacts described below. Most issues are
resolved within a single round-trip once the right context is on
hand.

---

## Table of contents

1. [Code of conduct](#code-of-conduct)
2. [Ways to contribute](#ways-to-contribute)
3. [Filing a bug report](#filing-a-bug-report)
4. [Requesting a feature](#requesting-a-feature)
5. [Asking a question](#asking-a-question)
6. [Reporting a security issue](#reporting-a-security-issue)
7. [Development setup](#development-setup)
8. [Commit and PR conventions](#commit-and-pr-conventions)
9. [Testing](#testing)
10. [Documentation changes](#documentation-changes)
11. [License of contributions](#license-of-contributions)

---

## Code of conduct

Be civil, be specific, and assume the other party is acting in good
faith. Personal attacks, harassment, and off-topic political content
are out of scope for this project.

If a thread is going off the rails, escalate to the maintainers by
mentioning them on the issue or PR rather than continuing the
exchange in public.

## Ways to contribute

- **Bug reports** — concrete, reproducible failures with logs and a
  minimal repro. See [Filing a bug report](#filing-a-bug-report).
- **Feature requests** — proposals for new operator-visible behavior.
  See [Requesting a feature](#requesting-a-feature).
- **Documentation fixes** — corrections, clarifications, missing
  cross-links, broken anchors. Open a PR directly against the
  affected file under [`docs/`](docs/).
- **Code patches** — fixes and improvements. Discuss the approach in
  an issue first if the change is non-trivial; small, atomic patches
  are easier to land than large refactors.

## Filing a bug report

File at <https://github.com/lehoa1806/schegent/issues> using the
**Bug** template if available. Include:

1. **Environment**
   - Operating system and version.
   - VS Code version.
   - Claude CLI version (`claude --version`). Codex CLI version if
     applicable.
   - Schegent version (Extensions view, or `package.json` if built
     from source).

2. **Configuration**
   - The `schegent.*` keys you have set (workspace and user scope).
     Either paste the relevant subset from `settings.json`, or
     export it from **Dashboard → Settings → General**.
   - Active backend (`schegent.backend.runner`).

3. **Reproduction**
   - The smallest sequence of operator actions that triggers the
     issue.
   - Expected behavior vs. observed behavior.
   - Frequency: every time, intermittent, once.

4. **Diagnostics — what to attach**

   | File | Safe to attach? | Notes |
   |---|---|---|
   | `<workspaceRoot>/.schegent/audit.log` (recent slice) | yes | Sanitized and paths-free. The single most useful artifact. |
   | `<workspaceRoot>/.schegent/syslog` (recent slice) | yes | Sanitized runtime log. |
   | `settings.json` excerpt for `schegent.*` keys | yes | Redact non-Schegent keys if the file has unrelated secrets. |
   | `<workspaceRoot>/.schegent/sessions/raw-<runId>.log` | **only if asked** | Unredacted. May contain sensitive context. |
   | `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/` | **only if asked** | Unredacted. Opt-in capture. |

   When the maintainers ask for raw or verbose artifacts, they will
   typically also ask you to redact anything you would not want to
   ship off-machine. You always have the final call on what to
   share.

5. **Minimal repro** — if the failure depends on a specific
   `schegent.phases` / `schegent.pipelines` entry, or on a specific
   model/effort combination, include the smallest configuration that
   triggers it.

Use [`docs/operations/troubleshooting.md`](docs/operations/troubleshooting.md)
before filing — many common failure modes (CLI not found, stuck
queue, retry storm, suppressed runtime log, etc.) have documented
fixes you can try first.

## Requesting a feature

Feature requests should describe an **operator-visible** problem and
the smallest behavior change that would solve it.

A useful feature request answers:

- **Who is affected?** What kind of operator workflow runs into
  this?
- **What does today look like?** Concrete description of the
  current friction.
- **What would the world look like?** The smallest plausible
  behavior change, not a full design.
- **Workarounds?** What you do today to live with the current
  behavior.

Avoid:

- Speculative abstractions ("we should add a plugin system").
- Internal-implementation prescriptions ("rewrite the runner in
  language X"). Describe outcomes, not internals.

The maintainers will respond with one of: accepted, accepted with
modifications, declined, or held for discussion.

## Asking a question

For usage questions that the manual does not answer, open a
**Question** issue rather than a Bug. Include the same environment
context as a bug report. If the question reveals a documentation
gap, the resolution is often a `docs/` patch.

## Reporting a security issue

Do **not** file security-sensitive reports on the public issue
tracker. Follow the disclosure process in
[SECURITY.md](SECURITY.md).

## Development setup

### Prerequisites

- Node.js `>= 20` (the repo includes a `.nvmrc`).
- VS Code `^1.85.0` for the integration suite.
- Claude CLI installed and authenticated (for backend smoke tests).
- Optional: Codex CLI for backend-parity coverage.

### Clone and install

```bash
git clone https://github.com/lehoa1806/schegent.git
cd schegent
npm install        # also installs webview-ui dependencies via postinstall
```

### Layout at a glance

```text
.
├── src/             # Extension host code
├── webview-ui/      # Svelte UI for sidebar + dashboard
├── tests/           # Unit, integration, e2e, lint, perf suites
├── docs/            # Operator manual
├── resources/       # Static assets
├── esbuild.config.mjs
├── tsconfig*.json
├── vitest.config.ts
└── package.json
```

### Common scripts

| Script | Purpose |
|---|---|
| `npm run build` | Build host + webview bundles. |
| `npm run typecheck` / `npm run typecheck:webview` | TypeScript no-emit. |
| `npm run lint` / `npm run lint:webview` | ESLint. |
| `npm run test` | Vitest unit suites (host + webview). |
| `npm run test:host` | Host suite only. |
| `npm run test:webview` | Webview suite only. |
| `npm run test:coverage` | Unit suites with coverage. |
| `npm run test:e2e` | End-to-end suite (Vitest). |
| `npm run test:perf` | Performance suite. |
| `npm run test:integration` | Boots a real VS Code instance. |
| `npm run ci:fast` | Quick local pre-flight: typecheck + lint + unit. |
| `npm run ci` | Full pre-merge gate. |
| `npm run package` | Package a `.vsix` artifact. |

The `package` target uses `vsce package --no-dependencies` and
produces `schegent-<version>.vsix` at the repo root.

### Running the extension locally

1. Open the repository in VS Code.
2. Press `F5` (Run Extension) to launch an **Extension Development
   Host** window with Schegent loaded.
3. Open a trusted workspace folder in the dev host window.
4. The sidebar header reports CLI status; ensure it shows **CLI
   ready** before exercising flows.

## Commit and PR conventions

### Branches

Branch from the project's default branch. Use short, descriptive
names (`fix/cli-detection-windows`, `feat/codex-continue-flag`,
`docs/wakeup-troubleshooting`).

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional-scope>): <imperative summary>

<optional body>
```

Common types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`,
`build`, `ci`, `chore`, `style`, `revert`.

Keep each commit atomic — one type and one concern per commit. Avoid
drive-by reformatting, dependency bumps, or renames outside the
patch's scope.

### Pull requests

A PR description should answer:

- **What problem does this solve?** Link the issue if there is one.
- **What changed?** Surface-level summary; reviewers can read the
  diff for detail.
- **How was it tested?** Tests added, suites run locally, manual
  verification steps.
- **Risk and compatibility** — does this change `schegent.*` schema,
  audit-event payloads, or operator-visible defaults? If yes,
  describe migration impact.
- **Documentation** — list updated pages under `docs/`. If a
  user-visible behavior changed, the matching doc page should land
  in the same PR.

Small, focused PRs land faster than large, mixed ones. If a PR
exceeds ~400 lines of substantive change, consider splitting it.

### What we expect before requesting review

- `npm run ci:fast` passes.
- New behavior is covered by tests (unit at minimum; integration or
  e2e where the change crosses the host/CLI boundary).
- Operator-visible changes update the matching `docs/` page.
- No emojis in code or commit messages.
- No new dependencies without justification — what it solves, size,
  maintenance status, license.
- No lockfile changes outside the requested task.

### Style notes

- Match the existing formatter and linter configuration; do not
  introduce new ones unprompted.
- Prefer the standard library and existing project dependencies
  over new ones.
- Handle errors at ownership boundaries. Inner layers throw typed
  errors; the boundary catches once, logs sanitized fields only
  (e.g. `errorCode`, `traceId`, `operation`), and returns a
  structured response. Never log raw `error` or `context` objects.
- All operator-visible strings that may contain secrets pass
  through the central sanitizer. Do not add a second redaction set.
- Validate operator input at system boundaries.

## Testing

Schegent has five test suites; pick the smallest one that exercises
your change:

| Suite | When to use |
|---|---|
| **Unit** (`tests/unit`, webview unit) | Pure logic, schema validation, classifiers, sanitizer rules. Default home for new tests. |
| **Lint** (`tests/lint`) | Repo-wide invariants (e.g. single call site for `CMD_SAVE_GENERAL_SETTINGS`). |
| **Integration** (`tests/integration`) | Code that depends on the VS Code API surface (configuration, commands, secrets). |
| **End-to-end** (`tests/e2e`) | Operator flows across host + webview + CLI. |
| **Performance** (`tests/perf`) | Latency- or throughput-sensitive paths. |

Behavior changes follow TDD: write the failing test first, then
implement. For refactors, migrations, and urgent fixes, add tests
around changed behavior where practical.

Run the appropriate suite locally before pushing. The full gate
(`npm run ci`) is also enforced in CI.

## Documentation changes

User-facing changes land with a doc update in the same PR. Conventions:

- File paths use the project-relative form,
  e.g. `<workspaceRoot>/.schegent/audit.log`.
- Settings are written as their full key
  (e.g. `schegent.wakeUp.enabled`).
- Commands are written with the palette title in **bold** and the
  raw id in `code` (e.g. **Schegent: Open Dashboard** /
  `schegent.openDashboard`).
- Prefer the language conventions documented in `docs/README.md` —
  "risk reduction" over "guarantee", "metadata-only audit by
  default" over "no data is stored", and so on.

A PR that adds or changes a setting, command, or audit event should
also update the matching reference table under
[`docs/reference/`](docs/reference/).

## License of contributions

By submitting a contribution, you agree that your work is licensed
under the [MIT License](LICENSE.md), the same terms as the rest of
the project. If you cannot accept those terms, please do not submit
a contribution.

---

Thanks again. The maintainers triage issues and PRs on a best-effort
basis; clear reports with diagnostic artifacts are the fastest path
to a resolution.
