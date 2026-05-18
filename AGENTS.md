# AGENTS.md (implementation tree)

This file guides autonomous coding agents (Codex, Cursor, Claude Code)
working inside `repo/` — the implementation tree.

The spec-driven workflow (Speckit, slash commands, `.specify/`, `specs/`,
roadmap and BRDs) lives in the **workspace root** one directory up. Agents
operating at the planning / spec layer should read the root-level
[../AGENTS.md](../AGENTS.md) instead. This file covers code work only.

## What this tree is

`repo/` is the Schegent VS Code extension. The host process lives under
[src/](src/); the Svelte sidebar under [webview-ui/](webview-ui/); tests
under [tests/](tests/) (unit, integration, lint regressions). The
architectural map is [ARCHITECTURE.md](ARCHITECTURE.md). The full set of
hard rules — the load-bearing invariants protecting the audit pipeline,
sanitization, primary-host gate, lock-release semantics, etc. — is
[CLAUDE.md](CLAUDE.md). **CLAUDE.md is the single source of truth for
hard rules; do not duplicate that text here or in PR descriptions.**

## Verification commands

Real, runnable, CI-ready:

```bash
npm run typecheck          # tsc --noEmit on the host
npm run typecheck:webview  # tsc --noEmit on the Svelte app
npm run lint               # eslint --ext .ts src tests
npm run test               # vitest run + webview-ui test
npm run build              # esbuild host + Vite webview
npm run test:integration   # @vscode/test-electron host smoke tests
npm run ci                 # the full pre-merge gate
```

Run `npm run ci` before opening a PR.

## What you'll be doing here

Most work in this tree is feature-level: bug fixes, new commands, UI
polish, performance tuning, and adding new backends behind the runner
contract in [src/contracts/](src/contracts/). Every change must:

1. Stay within the requested scope — no drive-by refactors.
2. Preserve the [CLAUDE.md](CLAUDE.md) hard rules. When a change touches
   a hard-rule surface, link to the CLAUDE.md anchor in the PR body
   rather than restating the rule.
3. Pass `npm run ci` locally before commit.
4. Update [ARCHITECTURE.md](ARCHITECTURE.md) and the operator playbooks in
   [docs/operations/](docs/operations/) when host structure, persistence
   shape, or operator-facing behavior changes.

## Conventions

- **Conventional Commits**: `feat`, `fix`, `refactor`, `perf`, `docs`,
  `test`, `build`, `ci`, `chore`, `style`, `revert`. One type, one
  concern per commit. Never commit directly to `main`.
- **No emojis** in code or commits.
- **Security**: never hardcode keys, tokens, or PII. Logs and error
  messages must be scrubbed via the central `SanitizedLogger` — the
  `SECRET_PATTERNS` set in [src/lib/logger.ts](src/lib/logger.ts) is the
  single source of truth.
- **Error handling**: inner layers throw typed/domain errors. Boundaries
  catch once, log sanitized fields only, and translate.
- **TDD for behavior changes**; pragmatic coverage for refactors and
  migrations. Mock external services; never mock the runtime audit log.

## Where to look next

- [ARCHITECTURE.md](ARCHITECTURE.md) — the system map. Read before
  changing host structure or IPC contracts.
- [CLAUDE.md](CLAUDE.md) — hard rules and the canonical command index.
- [docs/operations/](docs/operations/) — operator playbooks (start a
  feature, recover after restart, debug stuck runs, handle rate limits,
  custom retry conditions, wakeup troubleshooting, etc.).
- [docs/security/threat-model.md](docs/security/threat-model.md) — the
  threat model behind every hard rule.
- [docs/reference/](docs/reference/) — settings, commands, audit events,
  file-layout tables.
- [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) —
  the PR template with the hard-rule self-check.

For the spec-first lifecycle (`/speckit-*` slash commands, feature
branching, plan/tasks/analyze/implement), drop back to the workspace root
and read [../AGENTS.md](../AGENTS.md) and [../CLAUDE.md](../CLAUDE.md).
