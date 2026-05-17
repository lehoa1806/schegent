# Contributing to Schegent

Schegent is a VS Code extension that orchestrates the [Claude Code CLI](https://docs.anthropic.com/claude/claude-code) as a headless backend to autonomously drive the [Speckit](https://github.com/github/spec-kit) spec-driven development pipeline. The codebase is managed **spec-first**: non-trivial changes start as a `specs/<NNN-feature>/spec.md`, get clarified, planned, broken into tasks, then implemented — the slash commands below own that lifecycle. This guide is a pointer-only index; the canonical authorities (constitution, hard rules, threat model) live elsewhere and must not be duplicated here.

## The Speckit workflow

The eight `/speckit-*` slash commands drive every spec → ship cycle. Open the corresponding `SKILL.md` for full input/output contracts and pre-execution hooks.

| Slash command | Skill | Purpose |
|---|---|---|
| `/speckit-constitution` | [.claude/skills/speckit-constitution/SKILL.md](.claude/skills/speckit-constitution/SKILL.md) | Fill in [.specify/memory/constitution.md](.specify/memory/constitution.md) with the project's governance principles. |
| `/speckit-specify` | [.claude/skills/speckit-specify/SKILL.md](.claude/skills/speckit-specify/SKILL.md) | Turn a feature description into `specs/<NNN-name>/spec.md`. Auto-creates a feature branch via the `speckit-git-feature` hook. |
| `/speckit-clarify` | [.claude/skills/speckit-clarify/SKILL.md](.claude/skills/speckit-clarify/SKILL.md) | Resolve `[NEEDS CLARIFICATION]` markers in the spec. |
| `/speckit-plan` | [.claude/skills/speckit-plan/SKILL.md](.claude/skills/speckit-plan/SKILL.md) | Produce the implementation plan and design artifacts. |
| `/speckit-tasks` | [.claude/skills/speckit-tasks/SKILL.md](.claude/skills/speckit-tasks/SKILL.md) | Break the plan into independently testable tasks. |
| `/speckit-checklist` | [.claude/skills/speckit-checklist/SKILL.md](.claude/skills/speckit-checklist/SKILL.md) | Generate a requirements-quality checklist for the reviewer. |
| `/speckit-analyze` | [.claude/skills/speckit-analyze/SKILL.md](.claude/skills/speckit-analyze/SKILL.md) | Cross-validate spec, plan, and tasks for drift before implementing. |
| `/speckit-implement` | [.claude/skills/speckit-implement/SKILL.md](.claude/skills/speckit-implement/SKILL.md) | Execute the task list. |

A fully autonomous wrapper, [/speckit-auto](.claude/skills/speckit-auto/SKILL.md), runs the full lifecycle end-to-end against a one-line description or a roadmap document.

Hooks fire automatically per [.specify/extensions.yml](.specify/extensions.yml): `before_specify` auto-branches via `/speckit-git-feature`; `before_constitution` ran once during `/speckit-git-initialize`; optional `/speckit-git-commit` prompts surface after each phase.

## The Constitution

[.specify/memory/constitution.md](.specify/memory/constitution.md) is the authority on how headless agent runs make decisions inside the spec-driven pipeline. Each `/speckit-plan` run performs a Constitution Check before producing a plan; do not bypass that check. The constitution governs **runs**, not this contributing guide — keep the principle text in its single source of truth.

## Hard rules

[CLAUDE.md](CLAUDE.md) holds the canonical index of hard rules — the high-stakes invariants that protect the audit pipeline, sanitization SoT, primary-host gate, lock-release semantics, `vscode`-import bans, and the `-c` continuation single-append-site. The threat model that motivates each rule lives at [docs/security/threat-model.md](docs/security/threat-model.md).

When you propose a change that touches a hard-rule surface, **link to the CLAUDE.md anchor — do not duplicate the rule text here or in the spec.** Duplicated rule text drifts; the single CLAUDE.md index does not.

The pull-request template at [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) lists the six highest-stakes rules as a reviewer-facing self-check. Unchecked boxes do not block merge — they are a triage signal.

## Opening a PR

The PR template at [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) auto-populates the PR body. Reviewers look for:

- A 1–3-bullet Summary stating *what changed and why* (the diff explains *how*).
- A Test plan checklist showing which of `npm run typecheck`, `typecheck:webview`, `lint`, `test`, `build`, and `ci` you ran locally.
- The Hard-rule self-check — tick the rules you intentionally touched and add a one-line justification per ticked item.
- CODEOWNERS routing — security-sensitive paths route to the security team per [.github/CODEOWNERS](.github/CODEOWNERS).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`. Keep commits atomic — one type, one concern.

Auto-commit hooks are off by default; honor the operator's choice rather than committing unprompted.

## Reporting issues

Three issue templates live under [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/):

- **Bug report** ([bug.yml](.github/ISSUE_TEMPLATE/bug.yml)) — defects in the extension. Do **not** paste raw logs, tokens, or environment variables; use the redacted-by-design exporter at [docs/operations/inspect-raw-transcripts.md](docs/operations/inspect-raw-transcripts.md).
- **Feature request** ([feature.yml](.github/ISSUE_TEMPLATE/feature.yml)) — new capabilities. The form asks "Impact on hard-rule surfaces" so reporters surface CLAUDE.md-relevant changes before a spec is drafted.
- **Security issue (redirect)** ([security.yml](.github/ISSUE_TEMPLATE/security.yml)) — informational redirect only. **Do not file vulnerabilities in public issues.** Use the private advisory channel per [SECURITY.md](SECURITY.md).

Blank issues are disabled. Security disclosures go through the private GitHub Security Advisory channel; see [SECURITY.md](SECURITY.md) for the full policy.

## Verifying locally

The full pre-merge gate is one command:

```bash
npm run ci
```

It runs the individual gates that the PR template's Test plan lists:

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

See the canonical command index in [README.md](README.md) under "Verification" and the scripts in [package.json](package.json).

## CI gate model

The PR gate is intentionally fast: `pr.yml` runs typecheck + lint + unit + build across an ubuntu/macos/windows matrix and is the only blocker for merge. Heavier coverage (E2E, integration smoke, perf, npm audit) lives in `ci.yml` (push to `main`), `full-gate.yml` (weekly + manual), and `security-audit.yml` (weekly). A green PR is therefore not the same as a green release — see [RELEASE.md](RELEASE.md) for the pre-release checklist and the never-`npm audit fix --force` posture.

## Where else to look

- [ARCHITECTURE.md](ARCHITECTURE.md) — the system map. Read it before changing host structure or IPC contracts.
- [docs/operations/](docs/operations/) — operational playbooks (start a feature, recover after restart, debug stuck runs, handle rate limits, custom retry conditions, wakeup troubleshooting, etc.).
- [docs/security/threat-model.md](docs/security/threat-model.md) — the threat model behind every hard rule.
- [docs/features/](docs/features/) — feature briefs and roadmaps, including the long-range [034-architecture-refactoring-and-hardening-plan.md](docs/features/034-architecture-refactoring-and-hardening-plan.md).

Thanks for contributing to Schegent — open a draft PR early and lean on the spec-first workflow for anything non-trivial.
