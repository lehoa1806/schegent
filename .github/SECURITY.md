# Schegent Security Policy

Schegent is a VS Code extension that orchestrates the Claude Code CLI headlessly on the operator's behalf. This document is the project's vulnerability disclosure policy. It tells you how to report a vulnerability privately, what the project considers in scope, and what response you can expect from the maintainers.

## Reporting a Vulnerability

The primary disclosure channel is **private GitHub Security Advisories**. From the repository, open the Security tab and click [Report a vulnerability](/security/advisories/new) to submit a private advisory that only the maintainers can read. Use this channel by default — it gives the maintainers a private workspace for the fix and assigns a CVE if one is warranted.

If you do not have a GitHub account, or your situation prevents you from using GitHub Security Advisories, you may instead email the maintainer alias at [hoalee1806@gmail.com](mailto:hoalee1806@gmail.com). Include the same information you would put in a private advisory: a description of the vulnerability, reproduction steps, and the affected version or commit. Email is the only sanctioned non-GitHub channel; please do not use it for non-security questions.

**Please do not file a public issue, public discussion, or public pull request for a suspected vulnerability.** Public disclosure before a fix is available exposes every operator running Schegent on their workstation. Use the two channels above and nothing else.

## What Is In Scope

Schegent runs the upstream `claude` CLI with the `--dangerously-skip-permissions` flag on the operator's behalf, which means the extension's safety posture depends on a small number of code-resident defenses. The threat catalog in [docs/security/threat-model.md](../docs/security/threat-model.md) enumerates each threat (T1–T22) in detail; this policy summarizes the four in-scope surfaces that the maintainers triage as Schegent vulnerabilities.

- **Secret leakage** — the `SECRET_PATTERNS` redaction set in `src/lib/logger.ts` and every downstream sink (audit log, runtime log, phase-log IPC, wake-up session log). A finding that bypasses redaction at any sink is in scope. See [docs/security/threat-model.md](../docs/security/threat-model.md).
- **Audit-log tampering** — the append-only `<workspaceRoot>/.schegent/audit.log` write path and its parser. A finding that mutates, truncates, or corrupts the log without the append-only invariant being honored is in scope. See [docs/security/threat-model.md](../docs/security/threat-model.md).
- **IPC bypass** — the `MUTATING_COMMANDS` primary-host gate in `src/ui/sidebar/message-router.ts` and every webview command surface. A finding that lets a secondary VS Code host (or any non-primary surface) execute a mutating command is in scope. See [docs/security/threat-model.md](../docs/security/threat-model.md).
- **Wake-up isolation** — the headless `src/headless/wakeup-runner.ts` entry, its `cwdInsideWorkspace` defense against the workspace-roots snapshot, and its env scrubbing allowlist. A finding that escapes the isolation (workspace traversal, env leak, vscode-namespace import) is in scope. See [docs/security/threat-model.md](../docs/security/threat-model.md).

## What Is Out of Scope

The behavior of the upstream `claude` CLI itself is **out of scope** for this project. Schegent is a thin orchestrator on top of Anthropic's CLI; vulnerabilities in the CLI's own argument parsing, prompt handling, model interaction, or filesystem access are not Schegent vulnerabilities. If you find such an issue, please report it to Anthropic through their disclosure channels rather than here.

Other out-of-scope categories include bugs in the underlying VS Code platform itself, third-party VS Code extensions that happen to be installed alongside Schegent, and social-engineering attacks against maintainers. Reports about these will be politely redirected rather than silently closed.

## Response Commitments

The maintainers commit to the following response targets, measured in calendar days from the time a valid private advisory is received:

- **Acknowledgement within 7 calendar days.** You will get a first response confirming the report has landed and naming the maintainer who is triaging it. A "we are investigating" reply still counts as acknowledgement.
- **Resolution within 90 calendar days as a default target.** "Resolution" here means a patch shipped to `main`, a documented mitigation that does not require a code change, or an explicit close-as-won't-fix with rationale. The 90-day clock is a default target, not an absolute deadline: for findings that genuinely require more time (complex fixes, upstream dependency changes, multi-party coordinated disclosure), the maintainers will agree on an extended timeline with the reporter before the 90-day mark.

For reports that fall under "What Is Out of Scope", expect a redirect to the appropriate upstream channel rather than a 90-day fix commitment. Such reports are not closed silently.

## Further Reading

- [docs/security/threat-model.md](../docs/security/threat-model.md) — the authoritative threat catalog (T1–T22) that this policy summarizes.
