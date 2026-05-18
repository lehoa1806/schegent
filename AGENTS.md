# AGENTS.md

This file orients autonomous coding agents working inside the execution
repository. The workspace-level `../CLAUDE.md` is the single source of truth
for hard rules when changing host code.

## What This Repo Is

Schegent is a VS Code extension that orchestrates local CLI backends through
the Speckit pipeline. Source code lives in `src/`, webview code in
`webview-ui/`, tests in `tests/`, and implementation docs in `docs/`.

## Verification

Run from this directory:

```bash
npm run typecheck
npm run typecheck:webview
npm run lint
npm run test
npm run build
npm run test:integration
npm run ci
```

## Rules

Consult `../CLAUDE.md` before changing host code, IPC contracts, audit
semantics, redaction, lock handling, state migrations, wake-up execution, or
runtime/logging sinks. Keep this file as a short summary so it cannot drift
into a parallel rule set.
