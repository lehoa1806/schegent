# Security Policy

This document explains how to report security issues in Schegent,
which versions receive fixes, and the security posture the extension
assumes when it runs on an operator's workstation.

The full operator threat model — including the threat catalog,
mitigations, and explicit non-defenses — lives at
[`docs/security/threat-model.md`](docs/security/threat-model.md).
This file is the public reporting channel and the high-level
overview.

---

## Table of contents

1. [Reporting a vulnerability](#reporting-a-vulnerability)
2. [What to include in a report](#what-to-include-in-a-report)
3. [What we will do](#what-we-will-do)
4. [Disclosure timeline](#disclosure-timeline)
5. [Supported versions](#supported-versions)
6. [Scope](#scope)
7. [Security posture summary](#security-posture-summary)
8. [Safe harbor](#safe-harbor)
9. [Out of scope](#out-of-scope)

---

## Reporting a vulnerability

**Do not file security-sensitive reports on the public issue
tracker.** Public disclosure before a fix is available puts
operators at risk.

Use one of these channels instead:

1. **GitHub private vulnerability reporting** — open a private
   advisory at
   <https://github.com/lehoa1806/schegent/security/advisories/new>.
   This is the preferred channel; it is end-to-end with the
   maintainers and produces a CVE ID if one is warranted.

2. **Email** — for reporters who cannot use the GitHub flow, contact
   the maintainers privately through the contact listed on the
   repository profile at <https://github.com/lehoa1806>. State up
   front that the report is security-sensitive so the message can be
   routed appropriately.

Please do not include exploit code or live secrets in the initial
message. We will reply with a secure channel for follow-up artifacts
if the report warrants them.

## What to include in a report

A useful report contains:

1. **Affected component** — extension host, webview, sidebar UI,
   backend runner, IPC contract, audit pipeline, or another
   subsystem. If unsure, describe what you observed and we
   will route it.
2. **Affected versions** — the Schegent version that exhibits the
   issue, plus Claude CLI / Codex CLI versions if relevant.
3. **Environment** — operating system, VS Code version, whether the
   workspace was trusted, primary vs. secondary host status,
   workspace-scope vs. user-scope settings that are relevant.
4. **Reproduction** — the smallest sequence of operator actions or
   inputs that triggers the issue. A repro is the single most useful
   thing to include.
5. **Observed behavior** — what happened.
6. **Expected behavior** — what should have happened.
7. **Impact assessment** — your view of the worst-case outcome
   (e.g., information disclosure, local code execution, denial of
   service). We will reassess independently.
8. **Suggested mitigation** — optional. If you already have one in
   mind, please share it.

If you have screenshots, log excerpts, or a proof-of-concept
artifact, hold them until we have replied with a secure intake
channel.

## What we will do

When a report arrives, we will:

1. **Acknowledge receipt** within five business days.
2. **Triage** — confirm the issue, classify severity, and identify
   the affected versions.
3. **Coordinate a fix** — assign an owner, prepare a patch in a
   private branch, and prepare release notes.
4. **Notify you** when a fix is available and ready for release.
5. **Credit you** in the security advisory unless you prefer to
   remain anonymous.

We will keep the reporter in the loop with regular status updates.
If we determine that the report does not describe a security issue
(for example, a behavior that is documented and intentional), we
will explain our reasoning and, where appropriate, redirect to a
public issue.

## Disclosure timeline

Default targets:

| Severity | First response | Fix released | Public disclosure |
|---|---|---|---|
| Critical | within 5 business days | within 30 days | when the fix ships |
| High | within 5 business days | within 60 days | when the fix ships |
| Medium / Low | within 5 business days | next regular release | when the fix ships |

Severity is assessed using CVSS v3.1 plus operator-impact judgement.
If a fix is going to take materially longer than the targets above,
we will share the reason and a revised target with the reporter.

We coordinate public disclosure with the reporter. Please give us a
reasonable opportunity to ship a fix before publishing details.

## Supported versions

We support the most recent minor release line of Schegent for
security fixes. Older versions may receive a fix on a case-by-case
basis if the issue is severe and the upgrade path for affected
operators is non-trivial.

The current version is recorded in [`CHANGELOG.md`](CHANGELOG.md)
and in `package.json`. Treat the latest tagged release as the
supported baseline.

## Scope

In scope:

- The Schegent extension host and webview UI shipped from this
  repository.
- The IPC contract between host and webview.
- The audit-log pipeline, runtime-log writer, and the central
  sanitization surface.
- Backend runners shipped from this repository (`claude`, `codex`)
  and the `BackendRunner` contract.
- Documentation that misrepresents security-relevant behavior.

Out of scope (please report upstream):

- The Claude Code CLI itself — report at
  <https://docs.claude.com/claude-code> or via Anthropic's
  responsible-disclosure channel.
- The Codex CLI itself — report via that project's disclosure
  channel.
- Visual Studio Code itself — report at
  <https://github.com/microsoft/vscode>.
- Anthropic's API, model behavior, or any service-side concern.
- Operator workstation compromises that pre-date or operate
  independently of the extension (e.g., malware that already has
  shell access on the workstation can already read anything the
  operator can read; Schegent does not defend against this and
  does not claim to).

## Security posture summary

Schegent assumes a **trusted local operator on a trusted
workstation**. The mitigations below reduce risk; none of them are
absolute guarantees. The threat model page
([`docs/security/threat-model.md`](docs/security/threat-model.md))
catalogs the threats and the mitigations for each one.

**The backend runs with its approval prompts disabled.** This is the most
consequential capability fact about the product and it belongs at the top of
this section rather than inside a mitigation list. The `claude` backend — the
default — and the `agy` backend are spawned with
`--dangerously-skip-permissions`, unconditionally; there is no setting that
restores the prompts. Inside a trusted workspace the spawned CLI will write
files, run shell commands, commit, install packages, and make network requests
without asking. The `codex` backend is the only one with an OS-enforced bound
(`--sandbox workspace-write`, which keeps `.git` read-only), and it is not the
default.

A phase's `sideEffects` declaration does not change any of that: it selects a
consent prompt and a rollback checkpoint, and it refuses a Git-writing phase on
the sandboxed runner. It is consent bookkeeping, not a sandbox. The decision,
the full per-runner table, and the condition that would reopen it are in
[`docs/concepts/unprompted-agent-not-contained.md`](docs/concepts/unprompted-agent-not-contained.md).

The practical consequence: point Schegent at a repository you can restore.

- **Workspace-trust gating** — the extension is inert in untrusted
  workspaces and refuses to spawn any subprocess.
- **Primary-host gating** — only the first VS Code window opened
  against a workspace mutates state. Secondary windows are
  read-only; mutation attempts are rejected as `not-primary-host`.
- **Single sanitization surface** — every operator-visible sink
  (audit log, runtime log, Output channel, phase log feed) routes
  through a single redaction set defined once
  in the codebase. A secret stripped from one sink is stripped
  from all of them.
- **Metadata-only audit by default** — the structured audit log
  records counts, IDs, and selection tuples rather than file paths
  or raw payloads. The list of workspace roots appears only as
  `rootCount`; the phase log feed selection appears as a tuple,
  not as a path.
- **TTL-bound context fragments** — verbose diagnostics and raw
  transcripts are workspace-scoped and tied to the run that
  produced them. The optional task-deletion flow removes the
  per-run session tree on demand. The structured audit log is
  never modified by task deletion; `task-removed` is itself an
  audit event.
- **Sandboxed retry-condition DSL** — operator-supplied retry
  expressions are evaluated by a restricted parser that accepts
  identifiers, signed numerics, comparison operators, and boolean
  combinators. Arithmetic, function calls, member access, and I/O
  are rejected at parse time.
- **Local transactional sync** — operations that span multiple
  files use compensating rollback so a partial failure restores
  the prior state.
- **No MCP boundary tool** — Schegent does not expose its internal
  state through an MCP boundary tool. All operator interaction is
  mediated by VS Code commands and the sidebar UI.

### Local diagnostic sinks — design and trade-offs

Schegent intentionally writes two unredacted local sinks:

1. The **raw transcript** (always written, local-only, gitignored).
2. The **verbose diagnostic files** (opt-in via
   `schegent.logging.verbose`, local-only, gitignored).

Both are unredacted by design.
Architectural mitigations — never serializing local artifact paths
into audit events and gitignoring workspace-local sinks — keep these
artifacts from accidentally leaving the operator's machine.

If the trade-off does not match your environment, you can:

- Leave `schegent.logging.verbose` at its default (`false`).
- Add `.schegent/sessions/raw-*.log` to your workspace `.gitignore`
  (Schegent writes a best-effort `.schegent/.gitignore` on first
  use; layering a project-wide rule is good defense in depth).
- Treat the entire `.schegent/` directory as you would your shell
  history — useful, locally sensitive, not for sharing.

For the full trade-off discussion see
[`docs/concepts/sessions-and-logs.md`](docs/concepts/sessions-and-logs.md)
and [`docs/security/threat-model.md`](docs/security/threat-model.md).

## Safe harbor

We will not pursue legal action against, or ask law enforcement to
investigate, security researchers who:

- Act in good faith to identify and report vulnerabilities through
  one of the channels above.
- Make a reasonable effort to avoid privacy violations, service
  degradation, and destruction of data during their research.
- Give us a reasonable opportunity to fix the issue before public
  disclosure.
- Do not exploit the vulnerability beyond the minimum required to
  demonstrate it.

If your research follows these principles, you can treat this
statement as authorization for the testing described.

## Out of scope

The following report categories are **not** security issues for
Schegent:

- The extension does not prevent an operator who already has shell
  access on the workstation from reading workspace files, audit
  logs, or session artifacts. Schegent inherits the workstation's
  trust boundary.
- The extension does not prevent the Claude or Codex CLI from
  taking any action that the operator could take in a terminal.
  Workspace-trust gating is a coarse permission check; it is not a
  sandbox.
- The audit log is intentionally paths-free for sensitive
  locations. Reports that the audit log "does not record enough
  detail" should be filed as feature requests, not security
  issues — the absence is by design.
- The raw transcript and verbose diagnostics are unredacted by
  design. Reports that they "contain sensitive content" should be
  treated as a reminder to gitignore them and not share them
  publicly, not as a vulnerability.

When in doubt, open a private advisory. We will route it
appropriately.

---

Thank you for helping keep Schegent and its operators safe.
