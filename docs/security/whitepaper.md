# Schegent Security White-Paper

**Audience**: enterprise IT security reviewers and operators evaluating
Schegent for installation in a sensitive environment. Schegent
contributors should read [`threat-model.md`](./threat-model.md) instead;
this white-paper is the non-contributor projection of that document.

**Scope**: shipped behavior at the document's review SHA. The
white-paper is a thin projection over existing artifacts; every concrete
claim links to its backing artifact (code, test, or doc). The white-paper
is risk-reduction guidance, not a formal attestation. SOC 2, ISO 27001,
and FedRAMP language designed for hosted services does not apply —
Schegent is a local VS Code extension.

**Last reviewed**: 2026-05-20. See [Maintenance](#maintenance) for the
review cadence and the dependent-artifact manifest.

> **Reading time**: ~45 minutes end-to-end. A reviewer who only needs
> the trust ceiling can stop after [§1 Executive
> summary](#1-executive-summary); a reviewer who needs the worst-case
> scenarios can stop after [§5 Failure modes](#5-failure-modes).

---

## 1. Executive summary

**What Schegent is.** Schegent is a VS Code extension that drives the
Claude Code CLI as an autonomous backend through the Speckit
spec-driven development pipeline (`specify → clarify → plan → tasks →
analyze → implement → finalize`). The operator installs the CLI, links
it to an Anthropic account, opens a workspace, and explicitly trusts
that workspace before any phase runs. Every phase invocation spawns the
CLI subprocess, captures its stdout/stderr, writes a redacted structured
audit event, and updates per-workspace state in the VS Code memento.

**What Schegent is not.** Schegent is not a SaaS product, not a cloud
service, and not a compliance-attested platform. The extension host
makes zero outbound network calls; every API request is made by the
Claude CLI subprocess the operator configured. Schegent does not analyze
prompt content for adversarial inputs — operator-authored specs, plans,
and task files are the trust boundary on what the CLI ingests.

**Three boundary statements (each one sentence):**

- **Trust ceiling.** Schegent's capability surface is gated by VS Code's
  binary Workspace Trust, narrowed by three per-capability scopes
  (`schegent.trust.allowCustomPhases`,
  `schegent.trust.allowCustomRetryConditions`,
  `schegent.trust.allowPipelineOverrides`), and bound by 36 mutating IPC
  commands enforced primary-host-only.
- **Audit boundary.** Every phase invocation writes a redacted,
  append-only structured event to `.schegent/audit.log` through a single
  writer; paths and operator-controlled bytes are excluded from the
  structured payload (the paths-free audit discipline) so the log can be
  shipped off-machine without leaking workspace topology.
- **Network boundary.** The extension host makes no outbound network
  calls, the webview's Content Security Policy pins `connect-src 'none'`
  verbatim, and the Claude CLI subprocess is the only network egress
  point — operator-controlled at install time via `schegent.cli.path`.

---

## 2. What Schegent sees

Schegent reads from five surfaces and only those five.

**1. Workspace files.** Through the Claude CLI's tool calls (`Read`,
`Bash`, `Edit`, `Write`, …) inside a trusted workspace. The CLI's tool
surface is the operator's chosen capability set, not Schegent's;
Schegent does not narrow what the CLI reads beyond what VS Code's
Workspace Trust allows.

**2. Claude CLI process output.** Per-phase stdout, stderr, and exit
code. Stdout JSON lines are parsed for `assistant-message`, `tool-use`,
`tool-result`, and `audit` events; unknown event types are preserved
with a warning per the audit-event parser invariant (CLAUDE.md hard
rule: "Never drop unknown audit event types from the parser; warn and
preserve").

**3. The VS Code `workspaceState` memento.** Persistent per-workspace
state: the single queue, in-flight `WorkflowRun` records, pending
retry/manual-pause pairs, phase-breakpoint registrations, schema-version
markers, and the v6 forward-only-migration cursor.

**4. The `.schegent/` directory.** Under the workspace root: the
structured audit log (`audit.log` + rotated generations), raw
transcripts (`sessions/raw-<runId>.log`), per-iteration verbose
diagnostics under `sessions/<runId>/diagnostics/...` (when verbose is
on), the workspace lock file (`lock`), and the runtime log (`syslog`).
Schegent reads from this directory to populate the dashboard and the
phase-log IPC pipeline.

**5. Operator configuration.** The full `schegent.*` settings namespace
(workspace + user scope). Settings are read at phase boundaries — not
cached on long-lived runner objects — so an operator edit takes effect
on the next invocation. CLAUDE.md hard rules pin this discipline for
`schegent.logging.verbose`, `schegent.fatalSignatures`, and
`schegent.claude.autoCompactPctOverride`.

Outside these five sources, Schegent does **not** see:

- **CLI network traffic.** The host extension never inspects,
  intercepts, or replays the CLI's HTTPS calls to Anthropic's APIs. The
  CLI subprocess is opaque to Schegent at the network layer; the host
  reads only the CLI's stdout/stderr.
- **Other workspaces.** State is per-workspace. A run in workspace A
  cannot observe or affect workspace B. Multi-root workspaces are folded
  to first-folder canonical per spec 058 (see [§4(e)](#e-multi-root-canonicalization-spec-058)).
- **Other VS Code windows.** Two windows opened on the same workspace
  coordinate via the workspace lock plus the primary-host gate; the
  non-primary window is read-only by IPC convention. Mutating IPC
  commands from a non-primary window are rejected with `not-primary-host`.

For the contributor-facing enumeration of these surfaces and the lint
regressions that prevent them from drifting, see [`threat-model.md` §
What Schegent has access to](./threat-model.md#what-schegent-has-access-to)
and [`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the host /
webview / runner topology and the canonical workspace-folder rule.

---

## 3. What Schegent sends

Three write/transmit destinations exist.

**1. Claude CLI invocation.** Schegent spawns the CLI per phase with
argv (model, effort, optional `--continue` flag, system prompt argv),
stdin (the composed phase prompt), and an environment derived from VS
Code's environment plus the operator-configured settings. The OS-scheduled
wake-up runner restricts the environment to an allowlist
(`PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`) so workspace-specific
variables cannot bleed into invocations made outside the extension host.
The `-c` flag is appended only when `request.isContinue === true` is set
by the runner gate (CLAUDE.md hard rule).

**2. Local disk writes.** Three sinks, each with a documented redaction
posture:

- **Audit log** at `.schegent/audit.log`. Append-only, written via the
  single `appendAudit` boundary. Every operator-influenced string passes
  through the `SECRET_PATTERNS` redaction set in
  [`src/lib/logger.ts`](../../src/lib/logger.ts) before reaching the
  writer. Paths are excluded from structured payloads (the paths-free
  audit discipline; see [`threat-model.md` § The paths-free audit
  discipline](./threat-model.md#the-paths-free-audit-discipline)).
- **Raw transcript** at `.schegent/sessions/raw-<runId>.log`. Captures
  CLI stdout/stderr verbatim. Local-only; never referenced by path from
  the audit log. Used by operators when reconstructing a failed run.
- **Verbose diagnostic files** under
  `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`.
  Opt-in via `schegent.logging.verbose` (default off). Gitignored. Same
  paths-free audit discipline: the audit log records that verbose was
  on, not where the bytes landed. For the sink details and how to grep
  / tail the sanitized output channel, see
  [`operations/runtime-log.md`](../operations/runtime-log.md).

**3. No network.** The extension host makes no outbound network calls.
The webview's Content Security Policy pins `connect-src 'none'`
verbatim at [`src/ui/sidebar/csp.ts:20`](../../src/ui/sidebar/csp.ts#L20).
There is no telemetry collector, no remote logging endpoint, and no
crash reporter. The `telemetry-projection` feature is a local-only UI
surface, not an outbound channel; see
[`features/telemetry-projection.md`](../features/telemetry-projection.md).

The redaction surface is **centralized**: `SECRET_PATTERNS` is the
single source of truth for every disk-bound sink. CLAUDE.md hard rules
forbid forking the set or introducing parallel sanitizers; see
[`threat-model.md` § Sanitization is centralized](./threat-model.md#sanitization-is-centralized).
The set covers Anthropic and OpenAI API keys (`sk-`, `sk-ant-`,
`sk-proj-`, `sk-svcacct-`), GitHub personal access tokens (`ghp_`,
`github_pat_`), Slack tokens (`xox[baprs]-`), AWS IAM and STS access
keys (`AKIA`, `ASIA`), Google Cloud API keys (`AIza`), Google OAuth
tokens (`ya29.`), Stripe live/test secret keys, PEM private-key headers,
bearer / authorization headers, `api_key` / `x-api-key` patterns, JSON
Web Tokens, and generic env-style `SECRET=` / `TOKEN=` / `PASSWORD=`
strings.

---

## 4. Trust boundaries

Five layers compose Schegent's trust surface. Each layer adds a gate;
loosening a downstream layer cannot widen an upstream layer.

### (a) VS Code Workspace Trust — the binary platform gate

VS Code's built-in Workspace Trust is the first gate. Schegent registers
as an `untrusted-restricted` consumer. In an untrusted workspace:

- Every mutating IPC command rejects with `untrusted-workspace`.
- The sidebar shows a banner; no run is ever started.
- The wake-up scheduler does not install OS-scheduler entries.

Until the operator trusts the workspace, Schegent's capability surface
is zero. See [`threat-model.md` § Workspace-trust
gating](./threat-model.md#workspace-trust-gating).

### (b) The `MUTATING_COMMANDS` primary-host gate — 36 commands

Every mutating IPC command (queue mutation, run control, phase control,
save commands, breakpoints, wake-up actions) must be a member of the
`MUTATING_COMMAND_REASONS` registry in
[`src/contracts/sidebar-command-metadata.ts:41`](../../src/contracts/sidebar-command-metadata.ts#L41),
which is re-exported as the `MUTATING_COMMANDS` set in
[`src/ui/sidebar/message-router.ts:16`](../../src/ui/sidebar/message-router.ts#L16)
and enforced by `MessageRouter.dispatch()`. The set currently has
**36 entries**:

- 24 queue + run-control + phase-control commands (incl.
  `CMD_START_QUEUE` per BUG-002 and `CMD_CLEAR_ALL` per spec 063).
- 2 task-mutation commands (`CMD_MODIFY_TASK`, `CMD_REORDER_TASK`).
- 2 wake-up commands (`CMD_SAVE_WAKEUP_SETTINGS`, `CMD_WAKE_UP_NOW`).
- 4 catalog / save commands (`CMD_SAVE_GENERAL_SETTINGS`,
  `CMD_SAVE_MODELS`, `CMD_SAVE_PHASES`, `CMD_SAVE_PIPELINES`).
- 1 restart-canceled-task command (`CMD_RESTART_CANCELED_TASK`).
- 2 phase-breakpoint commands (`CMD_SET_PHASE_BREAKPOINT`,
  `CMD_CLEAR_PHASE_BREAKPOINT`).
- 1 confirmation-suppression preference command
  (`CMD_SET_CONFIRM_SUPPRESSION`, spec 063).

When the same workspace is open in multiple VS Code windows, only the
primary host accepts these commands; secondary windows receive
`not-primary-host` rejections. The set is also pinned by a
lint regression at `tests/lint/mutating-command-name-gate.test.ts`,
which fails the build if a mutating command is added without registry
membership. CLAUDE.md hard rule: "Never register a new mutating IPC
command without adding it to `MUTATING_COMMANDS`." See
[`threat-model.md` § T5](./threat-model.md#t5--concurrent-state-mutation-across-multiple-vs-code-windows)
and [`threat-model.md` § The mutating-commands
registry](./threat-model.md#the-mutating-commands-registry).

### (c) Sidecar containment — the canonical-path guard (spec 056, T21)

The Claude CLI streams stdout that includes audit events naming local
diagnostic file paths (`phase-message.env`). An attacker who can steer
the CLI's stdout — via prompt injection in spec/plan content, a
compromised CLI binary, or upstream model behavior — could try to name
a path outside the run's diagnostics tree and steer the host into
reading attacker-named files.

The mitigation is **canonical-path containment** in
`src/controller/phase-sidecar-reader.ts`: the host computes the
expected path from `(workspaceRoot, runId, pipelineId, phaseId,
iterationN)`; an audit-reported path is accepted only when it
canonicalizes byte-equal to the host's computed path, and ignored
entirely when the canonical file already exists. The CLI cannot
redirect the host into reading attacker-named files.

See [spec 056](../../../specs/056-principal-arch-hardening/spec.md) and
[`threat-model.md` §
T21](./threat-model.md#t21--untrusted-stdout-names-local-files).

### (d) Per-capability trust scopes (spec 059)

VS Code's Workspace Trust is binary; Schegent layers three
independently-configurable scopes on top, giving enterprise IT a
narrower gate than "trust everything or trust nothing":

- **`schegent.trust.allowCustomPhases`** — gates non-default phase
  prompts (the operator's `schegent.phases` overrides). When `false`,
  saving a custom phase emits a `trust.capability-denied` audit event
  and the save is rejected.
- **`schegent.trust.allowCustomRetryConditions`** — gates non-default
  retry-condition DSL expressions on phase rows. Default retry
  conditions remain available; only operator-authored expressions are
  gated.
- **`schegent.trust.allowPipelineOverrides`** — gates non-default
  entries in the pipeline catalog. The built-in Speckit pipeline
  remains available; only operator-authored pipeline catalog entries
  are gated.

Each setting is `boolean | null`, defaults to `null` (follow Workspace
Trust), and resolves against a four-step ladder: **workspace-trust
ceiling → workspace-scope → user-scope → default-allow**. The
Workspace Trust check runs first; a workspace that is not trusted
returns `false` for every capability regardless of any user- or
workspace-scope value. The ceiling is never widened. Per-capability
scopes can only *narrow* the trust surface.

Denied save attempts emit a `trust.capability-denied` audit event with
a closed-enum payload (capability, resolved scope, fixed reason
template) plus `workspaceBasename` (basename only, never the full
path). No operator-controlled string flows into the payload, so
redaction is unchanged.

See [`operations/trust-scopes.md`](../operations/trust-scopes.md) for
the operator-facing guide and 16-row truth table,
[spec 059](../../../specs/059-fine-grained-trust-scopes/spec.md) for
the implementation, and [`threat-model.md` § Per-capability trust
scopes](./threat-model.md#per-capability-trust-scopes).

### (e) Multi-root canonicalization (spec 058)

A VS Code multi-root workspace has multiple folder roots (a
`.code-workspace` file, or "Add Folder to Workspace" from a
single-folder window). Schegent's state model is per-workspace, not
per-root. Spec 058 shipped Option B (first-folder canonical): every
first-folder read routes through `getCanonicalWorkspaceRoot()` in
`repo/src/state/workspace-folder-picker.ts`; the CLAUDE.md hard rule
pins the discipline: "Never read `workspaceFolders[0]` or
`workspaceFolders?.[0]` outside `repo/src/state/workspace-folder-picker.ts`."

In a multi-root workspace, the dashboard shows a multi-root warning
chip naming the canonical folder. Adding or removing non-canonical
folders does not move the canonical anchor mid-run; the other roots
are visible to the operator's other extensions and workflows but do
not flow into Schegent's audit log, queue, or run state.

See [spec 058](../../../specs/058-multi-root-workspace/spec.md) and
the [workspace-isolation rationale](../../../docs/plans/workspace-isolation-strategy.md).

---

## 5. Failure modes

Seven scenarios. For each: **what happens**, **what mitigates it**, and
**what the operator sees**.

### 5.1 Malicious CLI output

**What happens.** The Claude CLI emits stdout the operator did not
author — because of prompt injection in workspace spec/plan/task files,
a compromised CLI binary, or upstream model behavior. The output may
contain (a) audit-event JSON naming a path outside the run's
diagnostics tree, (b) a secret in plaintext (e.g., an API key the CLI
surfaces from a tool call), or (c) prose attempting to steer Schegent
or the operator into further actions.

**What mitigates it.** The canonical-path containment guard rejects
audit-reported paths that do not byte-equal the host-computed expected
path
([`threat-model.md` § T21](./threat-model.md#t21--untrusted-stdout-names-local-files)).
The `SECRET_PATTERNS` redaction set strips API keys, tokens, and
credentials before the bytes reach any sink
([`threat-model.md` § T1](./threat-model.md#t1--secret-leakage-to-operator-visible-sinks)).
Prompt injection itself is upstream of the extension's threat model and
is named explicitly out-of-band
([`threat-model.md` § T8](./threat-model.md#t8--prompt-injection-via-specplantask-content));
the operator decides whether to ingest untrusted content.

**What the operator sees.** A redacted audit event with the unknown-path
entry dropped (silently if the canonical file exists; with a warning
otherwise), `[REDACTED]` markers in the audit log and phase log feed
wherever the redaction set fired, and the run proceeding to the next
phase boundary or stopping at the phase-message-empty failure check.

### 5.2 Secondary VS Code window attempts to mutate state

**What happens.** Two VS Code windows have the same workspace open. The
operator (or an extension running in either window) attempts a mutating
IPC command from the non-primary window.

**What mitigates it.** The `MUTATING_COMMANDS` primary-host gate rejects
every command in the registry from non-primary hosts with a
`not-primary-host` rejection. The workspace lock at `.schegent/lock`
prevents two runners from spawning concurrently even if the gate
misfired. See [`threat-model.md` §
T5](./threat-model.md#t5--concurrent-state-mutation-across-multiple-vs-code-windows).

**What the operator sees.** A rejection toast in the non-primary
window: "Schegent is the primary host in another window." The audit log
records the rejection cause. The primary window is unaffected.

### 5.3 Workspace opened in multi-root mode

**What happens.** The operator opens a workspace with two or more folder
roots — either a `.code-workspace` file or by adding a folder to an
existing single-folder window.

**What mitigates it.** Spec 058 ships first-folder canonicalization;
every read of the first folder goes through `getCanonicalWorkspaceRoot()`
and the CLAUDE.md hard rule pins this. State and audit logs anchor to
the canonical folder only; the non-canonical roots are visible to the
operator's other extensions but do not participate in Schegent.

**What the operator sees.** The dashboard shows a multi-root warning
chip naming the canonical folder. Operations targeting non-canonical
folders are surfaced as no-ops, not silently re-routed. Adding or
removing non-canonical folders mid-session does not change the canonical
anchor.

### 5.4 Audit log fills the disk

**What happens.** A long-running fleet workstation accumulates audit log
entries until the host's free disk space is exhausted.

**What mitigates it.** The audit log rotates by size; rotated
generations are preserved on rename, never erased in-line
([`threat-model.md` § T3](./threat-model.md#t3--audit-log-tampering-or-non-append-writes)).
The rotation policy is intentionally conservative — history is
preserved across rotations so the operator's evidence trail survives a
disk-full event. Operational mitigation is the operator's: monitor
`.schegent/audit.log*` size on fleet hosts, ship old generations to
cold storage, or apply a per-host retention policy. CLAUDE.md hard rule:
"Never implement task or phase deletion by erasing `.schegent/audit.log`."

**What the operator sees.** A best-effort warning if the writer
surfaces an `ENOSPC` error during a phase boundary. The run pauses; the
audit history is intact through the last successful rotation. See
[`operations/inspect-audit-logs.md`](../operations/inspect-audit-logs.md)
for the rotation layout and inspection workflow.

### 5.5 Operator pastes a secret into a setting

**What happens.** An operator pastes an API key, bearer token, or
password into a setting value (e.g., into a custom phase prompt, a
retry-condition DSL expression, or `schegent.cli.args`). The secret
reaches a sink (audit log, runtime log, phase log feed, wake-up session
log) through normal phase execution.

**What mitigates it.** `SECRET_PATTERNS` is the single redaction
source-of-truth. Every operator-influenced string passes through a
registered `LogSink` and is sanitized at the boundary; no sink has its
own private sanitizer. The lint regression
`tests/lint/no-direct-syslog-fs-writes.test.ts` pins the writer
allowlist. See
[`threat-model.md` § T1](./threat-model.md#t1--secret-leakage-to-operator-visible-sinks)
and [`threat-model.md` § Sanitization is
centralized](./threat-model.md#sanitization-is-centralized). New writes
land redacted; **historical** entries written before the operator
noticed must be cleaned manually via the rotation procedure (see
[§6.3](#63-rotate-a-secret-that-ended-up-in-the-audit-log)).

**What the operator sees.** `[REDACTED]` markers wherever the redaction
set fires on subsequent writes. The audit log, runtime log, Output
channel, phase log feed, and wake-up session log all show `[REDACTED]`
rather than the raw secret on subsequent writes. Historical entries are
unaffected; the operator must rotate the credential at the issuing
service and delete the historical entries manually.

### 5.6 Workspace and `repo/` diverge on the `Repo-head:` trailer

**What happens.** The workspace envelope and the implementation `repo/`
are independent git repositories treated as one logical state machine.
A workspace commit was made without the corresponding `repo/` HEAD
being recorded as a git commit trailer, or the recorded hash no longer
matches `repo/`'s actual HEAD because of a separate `repo/` operation.

**What mitigates it.** [`CLAUDE.md` § Nested Repository
Sync](../../../CLAUDE.md#nested-repository-sync) is the convention:
every workspace commit for implementation work records `repo/`'s HEAD
as a `Repo-head:` git commit trailer. The
[`scripts/sync-status.sh --verify`](../../../scripts/sync-status.sh)
command exits 1 when the trailer is missing or mismatched. This is
local transactional sync with compensating rollback — two git repos
cannot perform a true atomic two-phase commit, so the convention is:
detect drift early, surface it before push, and roll back the workspace
commit rather than force-pushing.

**What the operator sees.** `sync-status.sh --verify` prints the
recorded trailer vs. actual `repo/` HEAD and exits non-zero on
divergence. The `--pr-block` mode prints a PR-body block reviewers can
paste into PR descriptions to surface the sync state at review time.

### 5.7 CLI hangs (watchdog, cancellation)

**What happens.** The spawned Claude CLI subprocess stops emitting
stdout and stops exiting — because the upstream model is rate-limited
beyond the configured timeout, the network is partitioned, the binary
is wedged, or an in-flight tool call is itself hung.

**What mitigates it.** Each phase has a per-phase timeout
(`schegent.phases.*.timeoutMs` or the operator's phase override). The
runner watchdog kills the subprocess on timeout and records a
`phase-timeout` audit event. The operator can also cancel via the
sidebar (`schegent.cancel`); cancellation kills the subprocess after
state has been updated (aggressive-pause semantics) so a partial run
never leaves the queue in an unresumable state.

**What the operator sees.** A timeout toast or cancel acknowledgment;
the run in the dashboard moves to `failed` or `canceled`; the audit log
records the cause. See
[`features/aggressive-pause.md`](../features/aggressive-pause.md) for
the cancellation discipline and
[`features/rate-limit-handling.md`](../features/rate-limit-handling.md)
for how rate limits interact with the watchdog.

---

## 6. Escape hatches

Five operator actions, each with one concrete next-step.

### 6.1 Disable Schegent on a workspace

**What.** Leave the workspace untrusted. VS Code's Workspace Trust is
the binary platform gate; in an untrusted workspace, every mutating IPC
command rejects, no run starts, and the wake-up scheduler does not
install OS entries.

**How.** Open VS Code's command palette → `Workspaces: Manage Workspace
Trust` → mark the workspace as untrusted (or never trust it in the
first place). Schegent surfaces a banner in the sidebar; no further
configuration is required.

### 6.2 Disable a specific capability

**What.** Narrow Schegent's capability surface without revoking the
whole Workspace Trust gate. Per-capability scopes from spec 059 let the
operator deny one of three capabilities while leaving the rest of
Schegent operational.

**How.** Set the relevant `schegent.trust.*` key at workspace or user
scope (workspace scope takes precedence over user scope, which takes
precedence over default-allow; the workspace-trust ceiling is enforced
first):

- `"schegent.trust.allowCustomPhases": false` — denies non-default
  phase prompts.
- `"schegent.trust.allowCustomRetryConditions": false` — denies
  non-default retry-condition DSL expressions on phase rows.
- `"schegent.trust.allowPipelineOverrides": false` — denies non-default
  entries in the pipeline catalog.

For the full 16-row resolution truth table and the four worked
resolution examples, see
[`operations/trust-scopes.md`](../operations/trust-scopes.md).

### 6.3 Rotate a secret that ended up in the audit log

**What.** Remove historical entries containing a leaked secret. The
`SECRET_PATTERNS` set is defense-in-depth that guards new writes;
historical entries written before the rotation must be deleted manually
by the operator.

**How.** Stop any in-flight run (sidebar `Cancel`). Delete the
historical entries on disk:

- `.schegent/audit.log` and any rotated generations (`audit.log.1`,
  `audit.log.2`, …).
- `.schegent/sessions/raw-<runId>.log` for every affected run.
- `.schegent/sessions/<runId>/diagnostics/...` if verbose was on.
- The wake-up session log at `<globalStorageUri>/wakeup/session.log` if
  wake-up was used.

Then rotate the leaked credential at the issuing service — the
redaction set is a containment mechanism, not credential rotation. For
the audit log's structure and the recommended inspection workflow, see
[`operations/inspect-audit-logs.md`](../operations/inspect-audit-logs.md).

### 6.4 Verify the workspace ↔ `repo/` sync invariant

**What.** Confirm the workspace envelope's latest commit records
`repo/`'s HEAD as a `Repo-head:` trailer that matches `repo/`'s actual
HEAD.

**How.** Run `scripts/sync-status.sh --verify` from the workspace root:

```bash
scripts/sync-status.sh --verify
```

Exit codes: `0` matched, `1` missing or mismatched trailer, `2`
precondition failed (not a repo, `repo/` missing, etc.). The
`--pr-block` mode prints a PR-body block reviewers can paste into PR
descriptions. See [`CLAUDE.md` § Nested Repository
Sync](../../../CLAUDE.md#nested-repository-sync) for the convention and
[`scripts/sync-status.sh`](../../../scripts/sync-status.sh) for the
script.

### 6.5 Diagnose a workflow regression

**What.** Reproduce a failed run with full per-iteration diagnostic
capture (unredacted stream files, raw event log, verbose process log).

**How.** Enable verbose diagnostics, reproduce, attach:

- Set `"schegent.logging.verbose": true` at workspace scope. The
  setting is read at every phase boundary — not cached on long-lived
  runners — so it takes effect on the next phase.
- Reproduce the failure. Diagnostics land under
  `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`.
  Files are gitignored, opt-in, and never referenced by path in the
  structured audit log.
- Review the relevant `debug.json`, `stream.jsonl`, and `verbose.log`
  for secrets before sharing off-machine — these files are
  intentionally unredacted so operators can see the bytes the sanitizer
  would have masked.

See
[`operations/verbose-diagnostic-logging.md`](../operations/verbose-diagnostic-logging.md)
and [`features/verbose-diagnostics.md`](../features/verbose-diagnostics.md).

---

## 7. References

Every artifact this white-paper depends on:

- [`CLAUDE.md`](../../../CLAUDE.md) — workspace hard rules,
  documentation-language conventions, nested-repository-sync model.
- [`threat-model.md`](./threat-model.md) — contributor-facing threat
  catalog T1–T21 with mitigation-to-test anchors.
- [`src/lib/logger.ts`](../../src/lib/logger.ts) — `SECRET_PATTERNS`
  source-of-truth (substituted for the brief's planned `redaction.md`,
  which does not yet exist as a standalone file).
- [`src/ui/sidebar/csp.ts`](../../src/ui/sidebar/csp.ts) — webview CSP
  literal (`connect-src 'none'` at line 20).
- [`src/contracts/sidebar-command-metadata.ts`](../../src/contracts/sidebar-command-metadata.ts) —
  `MUTATING_COMMAND_REASONS` registry (36 entries; the source of truth
  re-exported as `MUTATING_COMMANDS` by
  [`src/ui/sidebar/message-router.ts:16`](../../src/ui/sidebar/message-router.ts#L16)).
- [`operations/runtime-log.md`](../operations/runtime-log.md) — the
  runtime-log file sink that mirrors the sanitized Output channel.
- [`operations/verbose-diagnostic-logging.md`](../operations/verbose-diagnostic-logging.md)
  — operator-facing verbose-diagnostic workflow.
- [`operations/inspect-audit-logs.md`](../operations/inspect-audit-logs.md)
  — audit log layout, rotation policy, and inspection workflow.
- [`operations/trust-scopes.md`](../operations/trust-scopes.md) —
  per-capability trust scopes operator guide and 16-row truth table.
- [`features/telemetry-projection.md`](../features/telemetry-projection.md)
  — the ephemeral PID / status display (local-only UI surface).
- [`features/verbose-diagnostics.md`](../features/verbose-diagnostics.md)
  — verbose-diagnostic feature reference.
- [`docs/plans/trust-model-strategy.md`](../../../docs/plans/trust-model-strategy.md)
  — trust-model rationale (Option A status-quo + Option B shipped in
  059).
- [`docs/plans/workspace-isolation-strategy.md`](../../../docs/plans/workspace-isolation-strategy.md)
  — workspace-isolation rationale (Option B first-folder canonical
  shipped in 058).
- [`docs/plans/backend-strategy.md`](../../../docs/plans/backend-strategy.md)
  — Claude-only-for-v1 backend rationale.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — host / webview / runner
  topology and IPC contracts.
- [`scripts/sync-status.sh`](../../../scripts/sync-status.sh) — sync
  invariant verification script.
- [spec 056](../../../specs/056-principal-arch-hardening/spec.md) —
  sidecar canonical-path containment (T21 mitigation).
- [spec 058](../../../specs/058-multi-root-workspace/spec.md) —
  first-folder canonicalization for multi-root workspaces.
- [spec 059](../../../specs/059-fine-grained-trust-scopes/spec.md) —
  per-capability trust scopes.

---

## Maintenance

**Review cadence.** Quarterly maintainer walk-through. The maintainer
opens every link in [§7 References](#7-references), confirms each
target resolves at `HEAD`, and updates this white-paper in the same PR
as any rename, removal, or signature change of a dependent artifact.

**PR-time edits required.** When a PR modifies `SECRET_PATTERNS`,
`MUTATING_COMMANDS`, the CSP literal at
[`src/ui/sidebar/csp.ts:20`](../../src/ui/sidebar/csp.ts#L20), the
audit-log writer, the workspace-trust posture, the per-capability
trust-scope ladder, the `getCanonicalWorkspaceRoot()` discipline, the
sync-status script, or any artifact listed in [§7
References](#7-references), the same PR updates this white-paper. The
maintainer enforces this in review.

**Dependent artifacts.** [§7 References](#7-references) is the
dependency manifest. A CI doc-drift lint that automatically resolves
every quoted path in this file and fails the build on a dead link is a
named future automated mitigation; it is out-of-scope for this revision.

**External-reader verification.** A non-Schegent-contributor reader
(an enterprise IT reviewer or operator not involved in extension
development) is invited to read this white-paper end-to-end and
confirm it answers "what does Schegent see, send, and risk?". That
verification is a post-merge follow-up; this revision lands on
maintainer review.
