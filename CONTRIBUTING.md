# Contributing to Schegent (implementation tree)

This guide covers code contributions inside `repo/`. The spec-driven
workflow (Speckit `/speckit-*` slash commands, `.specify/`, BRDs under
`specs/`) lives in the **workspace root** one directory up — see the
root-level [../CONTRIBUTING.md](../CONTRIBUTING.md) for that lifecycle.

Schegent is a VS Code extension that orchestrates the
[Claude Code CLI](https://docs.anthropic.com/claude/claude-code) as a
headless backend. Non-trivial features start as a spec at the workspace
level; once a plan and tasks exist, implementation lands here.

## The Constitution and hard rules

The Constitution lives in the workspace root under `.specify/memory/`.
The full set of hard-rule invariants — audit pipeline, sanitization,
primary-host gate, lock-release semantics, `vscode`-import bans, the
single `-c` continuation append site, etc. — is indexed in
[CLAUDE.md](CLAUDE.md). **CLAUDE.md is the single source of truth.**
When a change touches a hard-rule surface, link to the CLAUDE.md anchor
in the PR body. Do not restate or duplicate the rule text.

The threat model that motivates each rule is
[docs/security/threat-model.md](docs/security/threat-model.md).

## Opening a PR

The PR template at [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)
auto-populates the PR body. Reviewers look for:

- A 1–3-bullet Summary stating *what changed and why* (the diff explains
  *how*).
- A Test plan checklist showing which of `npm run typecheck`,
  `typecheck:webview`, `lint`, `test`, `build`, and `ci` ran locally.
- The Hard-rule self-check — tick the rules you intentionally touched
  and add a one-line justification per ticked item.
- CODEOWNERS routing — security-sensitive paths route to the security
  team per [.github/CODEOWNERS](.github/CODEOWNERS).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`,
`chore`, `style`, `revert`. Keep commits atomic — one type, one concern.
Never commit directly to `main`.

## Reporting issues

Three issue templates live under [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/):

- **Bug report** ([bug.yml](.github/ISSUE_TEMPLATE/bug.yml)) — defects.
  Do **not** paste raw logs, tokens, or environment variables; use the
  redacted-by-design exporter at
  [docs/operations/inspect-raw-transcripts.md](docs/operations/inspect-raw-transcripts.md).
- **Feature request** ([feature.yml](.github/ISSUE_TEMPLATE/feature.yml))
  — new capabilities. The form asks "Impact on hard-rule surfaces" so
  reporters surface CLAUDE.md-relevant changes early.
- **Security issue (redirect)** ([security.yml](.github/ISSUE_TEMPLATE/security.yml))
  — informational redirect only. **Do not file vulnerabilities in
  public issues.** Use the private advisory channel per
  [SECURITY.md](SECURITY.md).

Blank issues are disabled. Security disclosures go through the private
GitHub Security Advisory channel; see [SECURITY.md](SECURITY.md) for the
full policy.

## Verifying locally

The full pre-merge gate is one command:

```bash
npm run ci
```

It runs the individual gates the PR template's Test plan lists:

```bash
npm run typecheck          # tsc --noEmit on the host
npm run typecheck:webview  # tsc --noEmit on the Svelte app
npm run lint               # eslint --ext .ts src tests
npm run test               # vitest run + webview-ui test
npm run build              # esbuild host + Vite webview
```

For host integration smoke tests:

```bash
npm run test:integration   # @vscode/test-electron host smoke tests
```

See the canonical command index in [README.md](README.md) under
"Verification" and the scripts in [package.json](package.json).

## CI gate model

The PR gate is intentionally fast: `pr.yml` runs typecheck + lint + unit
+ build across an ubuntu/macos/windows matrix and is the only blocker for
merge. Heavier coverage (E2E, integration smoke, perf, npm audit) lives
in `ci.yml` (push to `main`), `full-gate.yml` (weekly + manual), and
`security-audit.yml` (weekly). A green PR is therefore not the same as a
green release — see [RELEASE.md](RELEASE.md) for the pre-release checklist
and the never-`npm audit fix --force` posture.

## Where else to look

- [ARCHITECTURE.md](ARCHITECTURE.md) — the system map. Read before
  changing host structure or IPC contracts.
- [docs/operations/](docs/operations/) — operational playbooks (start a
  feature, recover after restart, debug stuck runs, handle rate limits,
  custom retry conditions, wakeup troubleshooting, etc.).
- [docs/security/threat-model.md](docs/security/threat-model.md) — the
  threat model behind every hard rule.
- [docs/reference/](docs/reference/) — settings, commands, audit events,
  file-layout tables.
- [../docs/features/](../docs/features/) — workspace-level feature briefs
  and roadmaps (the BRDs that drove each implementation slice).

For the workspace-level spec → ship lifecycle, open
[../CONTRIBUTING.md](../CONTRIBUTING.md). Thanks for contributing to
Schegent.
