# AGENTS.md

This file orients autonomous coding agents working inside the execution
repository. The workspace-level `../AGENTS.md` orients you above this directory
and points at `../docs/hard-rules.md`, which is the single source of truth for
the hard rules when changing host code.

## What This Repo Is

Schegent is a VS Code extension that orchestrates local CLI backends through
the Spec Driven Development workflow. Source code lives in `src/`, webview code in
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

Consult `../docs/hard-rules.md` before changing host code, IPC contracts, audit
semantics, redaction, lock handling, state migrations,
runtime/logging sinks, or the Phase / Pipeline / Workflow definition catalogs
and their save gates. It opens with an index that routes by subsystem — read
the rows your change touches. Keep this file as a short summary so it cannot
drift into a parallel rule set.

Before adding a user-facing string anywhere — a command title, a setting
description, a dialog message, a webview label — read
[`docs/concepts/english-only-not-localizable.md`](docs/concepts/english-only-not-localizable.md).
Schegent is English-only by decision, not by omission: write the literal where it
renders and do not introduce a localization boundary.
