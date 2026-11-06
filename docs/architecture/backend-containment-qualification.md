# Backend containment qualification — what is actually available, per backend and per platform

**Qualified**: 2026-08-27 · **Item**: `FR-R3-125` (T1469) · **Spec**: `specs/161-contained-backend-execution`
**Status**: Accepted. Re-qualify on any backend CLI major version, or on gaining a second platform.

This record answers one question: for each backend × platform cell, what is the **strongest
OS-enforced boundary actually available**, and how was that determined? It exists because
`schegent.backend.uncontainedBackends` asks an operator to accept the absence of a boundary, and an
operator cannot weigh that without knowing what the alternative would have been.

**What "contained" means here, unchanged from `FR-R3-056`:** the **operating system**, not a prompt
and not the model's own harness, decides what the process can reach. A tool allowlist the model
applies to itself is not containment, however well it works.

<!-- Source: src/services/backend-containment-policy.ts -->
<!-- Source: docs/architecture/agent-capability-posture.md -->
<!-- Source: docs/operations/untrusted-repositories.md -->

## 1. The evidence, and its limit — read this before the matrix

Every cell below was determined by **invoking the installed CLI's own `--help`** on the cycle host
and reading what it declares about its own option surface, plus checking for the presence of the
platform's sandbox binary. No live model invocation was made: the audit of 2026-08-27 did not run the
live backend canary, and this cycle did not either.

That bounds what the matrix can claim, precisely:

- **A flag's existence is verified.** If this record says a CLI has a sandbox option, that was read
  from the CLI's own help at the stated version.
- **A flag's *enforcement* is not**, except where the CLI itself names the mechanism. `codex`'s help
  says its sandbox runs commands *"under seatbelt"*, which names macOS Seatbelt; that is the CLI
  declaring its own mechanism, and it is recorded as such. Nothing else here is an enforcement claim.
- **No cell is inferred from another platform.** Windows and Linux are unverified in every cell,
  because neither is available on the cycle host. This is the declaration
  [`FR-R3-115`](../../../docs/features/round_3/DONE_115_FR-R3-115_multi_platform_evidence_without_a_remote_gate.md)
  made rather than the inference it refused to make.

## 2. The cycle host

| | |
|---|---|
| Platform | Darwin arm64, macOS 26.6.2, 10 cores |
| `claude` | 2.1.247 (Claude Code) |
| `codex` | codex-cli 0.149.0 |
| `agy` | 1.1.22 |
| Platform sandbox binary | `/usr/bin/sandbox-exec` present |
| Execution repo | `2b1736d0` on `develop`, product version `0.2.0` |

**These versions are from 2026-08-27 and are not re-dated.** Sections 7 and 8 carry the versions captured
at `FR-R4-F06`'s implement, on 2026-10-31, by `scripts/capture-backend-help.mjs`: `claude` 2.1.316,
`codex-cli` 0.163.0 and `agy` 1.4.12, on Darwin arm64, macOS 27.0.1; `agy`'s rows were re-captured alone
on 2026-11-06 at 1.5.2, when `--mode` joined its flags (§4.2). The product's own list of
live-canary-qualified versions, `QUALIFIED_BACKEND_VERSIONS` (2.1.302, 0.159.2 and 1.4.2, dated
2026-10-19), is a different claim and is gated against `docs/release/backend-qualification-log.md`, not
against this record: a version appearing here says what was *captured*, not that it was *qualified*.

## 3. The matrix

`mechanism` values are the closed set in `src/services/backend-containment-policy.ts`, and
`tests/lint/containment-qualification-parity.test.ts` asserts this table and that code name the same
mechanism for every backend, failing in **both** directions.

| Backend | Platform | Strongest boundary Schegent requests | mechanism | Verified how |
|---|---|---|---|---|
| `codex` | darwin | `codex exec --sandbox workspace-write`, enforced by macOS Seatbelt | `codex-sandbox-workspace-write` | **Verified**: `codex exec --help` declares `-s/--sandbox` with `read-only \| workspace-write \| danger-full-access`; `codex sandbox --help` states its arguments run *"under seatbelt"*; `/usr/bin/sandbox-exec` is present. `backend-containment-policy.test.ts` reads the adapter's argv and confirms Schegent passes `workspace-write`. |
| `codex` | linux | Expected to be the same mode under Landlock/seccomp rather than Seatbelt | `codex-sandbox-workspace-write` | **Unverified.** Probe: run `codex exec --sandbox workspace-write` on a Linux host and attempt a write outside the workspace; the mode is qualified when the write is refused by the kernel. |
| `codex` | win32 | Unknown | `codex-sandbox-workspace-write` | **Unverified.** Probe: as above on Windows. Codex's own help names Seatbelt, which is macOS-only, so the Windows mechanism is not merely unverified but **unnamed** — the strongest statement available today is that Schegent passes the flag and does not know what enforces it. |
| `claude` | all | **None.** | `none` | **Verified that Schegent requests none; Claude's settings-based shell sandbox is unverified and not adopted.** `src/runner/claude-cli.ts` passes no sandbox flag or settings override, and `claude --help` offers `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--settings` and `--dangerously-skip-permissions`. Claude Code's settings-based `sandbox` configuration confines Bash/shell subcommands rather than built-in file tools, MCP servers, hooks or all network traffic, and is not qualified under Schegent's print/stream/resume invocation (see §4.1). |
| `agy` | all | **None requested by default.** `--sandbox` exists, and a Phase that withholds `process-spawn` gets it with `--mode accept-edits` (§7), unqualified and not counted here; see §4. A Phase that withholds `outside-workspace-write` gets `--mode accept-edits`, a tool restriction rather than OS isolation (§4.2). | `none` | **Verified that the flag exists; its enforcement is unverified.** See §4, which is the substantive part of this record. |

## 4. Agy's `--sandbox`: available, not requested by default, and why

**This contradicts the item that filed the work.** `FR-R3-125` §1 states *"Codex has
`workspace-write`; the default backend has nothing equivalent"*, and
`backend-containment-policy.ts` classified `agy` alongside `claude`. `agy 1.1.22`'s own help
declares:

    --sandbox    Run in a sandbox with terminal restrictions enabled

So one of the two backends this product calls uncontained **does** expose a native containment mode,
and Schegent does not request it by default. That is the finding; recording it is more important than
acting on it, and it is recorded here rather than folded into a code comment nobody would find.

The one case where it is requested is a Phase's own: when a Phase withholds `process-spawn`, the
capability planner passes `--sandbox`, together with `--mode accept-edits` so file tools can still write
inside the workspace (§4.2, §7). That is a restriction the Phase asked for, classed `tool-restriction`, with
the sandbox's scope unqualified (`sandbox-scope-unqualified`), not a containment claim, so the mechanism
above stays `none`.

**It is not requested by default, and the reasons are in descending order of weight.**

1. **Its enforcement is unverified, and the phrase points the wrong way.** "Terminal restrictions" is
   consistent with a restriction the agent applies to its own shell tool — which is exactly what
   `claude --disallowedTools` already is, and which this project has never counted as containment
   (§1). Codex's help names its mechanism; Agy's does not. Requesting a flag and recording a
   mechanism for it would be asserting a boundary from a sentence in a help text.
2. **It plausibly breaks the product.** Schegent's phases run Git-capable work through the backend's
   shell; `sideEffects: git` phases are the whole reason `codex`'s `workspace-write` mode is refused
   for them (it keeps `.git` read-only). A flag that restricts the terminal may refuse the same work
   on **every** Agy run, and this cycle cannot find out without a live invocation.
3. **Doing it anyway is the overclaim pattern.** Add a flag whose effect is unknown, record a
   mechanism for it, and the product now documents a boundary that may not be there. That is the
   class `FR-R3-116`, `122`, `123`, `126` and `124` have each closed one instance of. Committing it
   inside the item that found the gap would be a poor result.

### The probe that would qualify it

Run on a host where Agy is installed and authenticated, in a scratch repository:

1. `agy --sandbox -p 'write the text ok to /tmp/agy-sandbox-probe and report what happened'`
2. Then the same prompt targeting a path outside the workspace and outside `/tmp` — a file in the
   operator's home directory that the workspace has no business touching.
3. Repeat both **without** `--sandbox`.

**Qualified when**: the out-of-workspace write succeeds without the flag and is refused **with** it,
*and* the refusal is attributable to the operating system rather than to the agent declining — which
means the refusal appears as a syscall-level error (`EPERM`/`EACCES`) in the tool output, not as the
model saying it chose not to.

**Also required before requesting the flag**: one full Schegent pipeline through a `sideEffects: git`
phase on Agy with `--sandbox`, green. Reason 2 is not hypothetical, and a containment flag that
breaks every Git-capable Run is not an improvement.

### Entry condition for requesting it

All three:

1. The probe above qualifies the mode, with its output recorded in this file's §4.
2. A `sideEffects: git` pipeline completes on `agy --sandbox`.
3. A `BackendContainmentMechanism` value is added for it that names the enforcing mechanism — not
   `agy-sandbox`, which names a flag. If the mechanism cannot be named, condition 1 was not met.

Until then `agy` maps to `none` in the one table, is refused by default, and requires an explicit
per-backend grant. **A reader who disagrees with this decision has, above, everything needed to
overturn it.**

### 4.1 Claude's settings-based shell sandbox: shell-only scope and qualification criteria (`FR-R5-F16`)

Earlier revisions of §3 described `claude` as having a "verified absence" of any sandbox mechanism based on `claude --help` alone. That phrasing overstated what `--help` proves: what is verified from `src/runner/claude-cli.ts` is the narrower fact that **Schegent currently requests none** (`mechanism: 'none'`).

Claude Code exposes a settings-based shell sandbox (`sandbox` in settings files or passed via `--settings`). It is **not** adopted as whole-process `os-enforced` containment, and `claude` remains `mechanism: 'none'` under default-deny grant enforcement, for three reasons:

1. **Shell-only versus whole-process authority.** No shell-only sandbox may be labelled as confining built-in file tools (`Read`, `Edit`, `Write`, `NotebookEdit`), MCP servers, hooks, or all network traffic. Even when Bash subcommands run inside a shell sandbox, `--dangerously-skip-permissions` leaves built-in file tools, MCP servers, and hooks executing with the extension host's OS user authority.
2. **Adverse project/user configuration and list merging.** Settings-based configuration merges across user, project (`.claude/settings.json`), and local scopes. Excluded-command lists (`sandbox.excludedCommands`), network allowlists, or `allowUnsandboxedCommands` (`dangerouslyDisableSandbox`) in project or user settings can widen or bypass the shell boundary unless precedence and list-merging behavior are closed.
3. **Unverified print/stream/resume and fail-closed behavior.** Qualifying Claude's settings-based shell sandbox for any narrowed capability claim requires testing under the real `--print --output-format stream-json --verbose` and `--resume` invocation paths and adverse project/user configuration, checking:
   - missing sandbox dependencies (verifying the CLI fails closed rather than running unsandboxed);
   - attempted unsandboxed retry (`allowUnsandboxedCommands` / `dangerouslyDisableSandbox`);
   - excluded-command and list merging across user, project, and `--settings` scopes;
   - filesystem writes using disposable paths (workspace vs `/tmp` and a disposable path outside the workspace);
   - network egress against a controlled endpoint.

Until those checks are qualified and represented with accurate shell-only vs whole-process semantics, unverified integration leaves the current default-deny grant posture (`mechanism: 'none'`) intact.

### 4.2 Agy's `--mode accept-edits`: a tool restriction for `outside-workspace-write` (feature 279)

`agy --help` at 1.5.2 lists `--mode` ("Set the agent execution mode for this session (accept-edits, auto,
plan)"). A Phase that withholds `outside-workspace-write` on `agy` now runs with `--mode accept-edits`. It is
classed `tool-restriction`: agy's own tool layer decides, and nothing below it is claimed. `agy` keeps
`mechanism: 'none'` in §3.

Headless probes on 2026-11-06 at agy 1.5.2, on the host of §2, under the minimal policy's environment
allowlist with the operator's own home and agy settings, and a disposable workspace
(`specs/279-agy-accept-edits-mode/measurements.md`):

- Under `--mode accept-edits`, a file-tool write inside the workspace was written and a write outside it was
  not; agy reported it as an automatically denied `write_file`. Without `--mode`, the inside write was denied
  too, so the flag is what permits it.
- Under `--mode accept-edits`, both shell commands tried were denied (`command`): one writing outside the
  workspace and one writing inside it.
  A Phase that grants `process-spawn` and withholds `outside-workspace-write` therefore has its shell refused.
  That is a stricter side effect, disclosed as the `mode-refuses-shell` residual like Codex's
  `sandboxed-commands-run`, not something left open.
- `--sandbox --mode accept-edits` also refused the outside write.
- Every case ended on its own with exit code 0. None waited for a person, so principle I holds.
- The `init` event's `permission_mode` read `request-review` in every case and does not reflect `--mode`.

**Scope.** This holds while agy's own settings carry no `permissions.allow` rule for `write_file` or
`command`. Where they do, the shell can run and can write outside the workspace, which is why the
`mode-refuses-shell` clause is conditional on the backend's own permission settings. A `write_file` allow-rule
would likewise let the file tool write outside the workspace. No residual names that, which is the same
operator-configuration assumption the claude `--permission-mode acceptEdits` cell rests on. **Not observed:**
whether a settings file inside the workspace can add an allow-rule; outside paths reached through `..` or a symlink; a resumed `--conversation` turn; tools other than
`write_file` and `command`, MCP and browser tools included; and any of this on linux or win32.
`workspace-write` and `network` remain refused on `agy`: no flag in the planner's table expresses them.

**The `process-spawn` cell (feature 280).** A follow-up probe on 2026-11-06 (14:43:56Z to 14:44:46Z), the
same launch shape and settings, one fresh workspace per case
(`specs/280-agy-sandbox-accept-edits/measurements.md`):

- Case i, `--sandbox`: a file-tool write inside the workspace was not written; agy auto-denied `write_file`
  and reported "no output produced". Exit 0 after 16.5 s.
- Case j, `--sandbox --mode accept-edits`: the same write was written. Exit 0 after 19.4 s.
- Case k, `--sandbox`: a shell write inside the workspace was not written; agy auto-denied `command`. Exit 0
  after 11.8 s.

So a Phase that withheld only `process-spawn` and ran `--sandbox` alone could not edit a file, and exited 0
as if it had finished. That cell now runs `--sandbox --mode accept-edits`, classed `tool-restriction`. Case k
shows the shell refused by headless permissions, not by anything `--sandbox` was shown to do, so
`sandbox-scope-unqualified` stays. The mode also refuses a write outside the workspace (case d above, under
this exact argv), which the Phase granted: that is disclosed as `mode-refuses-outside-write`, a residual only
while `outside-workspace-write` is granted, and conditional on agy's own permission settings like
`mode-refuses-shell`. Case d does not show which layer refused it, because control f denied the same write
with no `--mode`. **Not observed** for this cell: a shell command under the exact `--sandbox --mode
accept-edits` argv (its refusal is inferred from case k and 279's case g, each with one of the two flags), and
whether a settings file the Phase now writes inside the workspace can add an allow-rule that a later launch
honours. Before this change the cell could write no file, so that second route is new to it.

## 5. What Schegent does with this

- The classification (`os-enforced` / `none`) drives the refusal at `createBackendRunner`. Unchanged
  by this record.
- The **mechanism** is recorded per Run in the `backend-posture-admitted` audit entry
  (`containmentMechanism`), so an operator reading evidence after the fact can see which boundary
  applied — including `none`, which is a value and not an absent field.
- The per-backend grant means accepting `agy`'s absence of a boundary does not accept `claude`'s.

### 5.1 Host confirmation authority and per-workspace reminder disposition (`FR-R5-F16`)

- **Host confirmation authority (`NS-03`, `S-02`).** Both the run-refusal consent requester (`src/activation/uncontained-consent.ts`) and the Settings grant handler (`CMD_SET_UNCONTAINED_BACKEND_GRANT` via `setUncontainedGrant` in `src/services/uncontained-grant-writer.ts` and `src/activation/sidebar-router-wiring.ts`) route `false -> true` transitions through a blocking host modal (`vscode.window.showWarningMessage(..., { modal: true })`) before writing `schegent.backend.uncontainedBackends` at `ConfigurationTarget.Global`. A direct or forged webview IPC message cannot persist a new grant without host modal approval; revoking a grant (`true -> false`) remains immediate and unconfirmed.
- **Disposition on per-workspace acknowledgement versus visible authority reminder.** Because `schegent.backend.uncontainedBackends` is `application`-scoped, a repository cannot grant uncontained execution to itself via `.vscode/settings.json` or `configurationDefaults`. Requiring repeated blocking modal prompts per workspace or per queued run is not adopted: Schegent's primary operating mode is autonomous multi-phase queue execution, where repeated prompts train reflexive click-through rather than stronger review. Instead, authority remains visible without modal fatigue through two mechanisms that already ship: every Run emits `backend-posture-admitted` to the tamper-evident audit log, and the launch surface projects the visible `uncontainedGrantNotice` authority reminder whenever an uncontained backend is active under an installation grant.

## 6. What this record does not claim

- It does not claim any sandbox is escape-proof. `workspace-write` permits writing the workspace,
  which is its purpose.
- It does not claim a contained backend is safe. It can act badly inside its boundary, and prompt
  injection remains out of the host's reach — the threat model's position, unchanged.
- It does not claim any enforcement was tested live. §1 states the evidence and its limit.
- It does not claim Windows or Linux behaviour. Every non-darwin cell is marked unverified with its
  probe.

## 7. Capability semantics (`FR-R4-F06`)

A Phase may withhold a capability: `workspace-write`, `outside-workspace-write`, `process-spawn` or
`network`. Whether the withholding *means* anything depends on what kind of thing enforces it, and four
different things get called "restricting a backend":

1. **Permission prompts.** The CLI asks a person before acting. Schegent spawns backends without a
   terminal, so a prompt would deadlock the run; no capability is ever enforced by asking.
2. **Tool restrictions.** The CLI is told not to offer some of its own tools (`--disallowedTools`) or to
   refuse a class of edits (`--permission-mode`). The CLI's tool layer applies it to itself. A shell the
   model is allowed to run can still do what the denied tool would have done, which is why a restriction
   that leaves the shell open records a residual.
3. **Git worktrees.** A separate checkout limits what a run can disturb in the main one. It is not a
   permission, and nothing in this table claims it.
4. **OS isolation.** The operating system decides what the process can reach. Only the vendor's own
   sandbox (`codex --sandbox`, `agy --sandbox`) is even *claimed by its vendor* to sit below the tool
   layer.

**This record qualifies the presence of a flag in the installed CLI's `--help`, and nothing more.** It does
not say a flag's values are accepted, that the flag enforces what its name suggests, or that the vendor's
claim about its sandbox is true: §1's limit applies to every row. A row is `observed` when the capture below
listed its flag at the stated version, `unsupported` when no flag expresses the capability (so the planner
refuses a Phase that withholds it), and `unobserved` otherwise. Cell status is read by
`tests/lint/containment-qualification-parity.test.ts` against `CONFIRMED_FLAGS` in
`src/services/capability-confirmed-flags.ts`, and the enforcement class and residuals against the planner.

The capture ran `scripts/capture-backend-help.mjs claude codex agy` on 2026-10-31 under the minimal policy's
shape (PATH and an isolated, empty home), with no account and no model call. Every command exited 0, and
every capability flag below was listed by the CLI's own `--help`. `agy`'s rows were re-captured alone on
2026-11-06 at agy 1.5.2 the same way, after the script gained `--mode`; that command exited 0 too and listed
`--dangerously-skip-permissions`, `--mode` and `--sandbox` (`specs/279-agy-accept-edits-mode/measurements.md`).

| Backend | Withheld capability | Flag | Enforcement class | Residuals | Evidence | Status | Version |
|---|---|---|---|---|---|---|---|
| `claude` | `workspace-write` | `--disallowedTools Edit,Write,NotebookEdit` | `tool-restriction` | `shell-workspace-write` (when process-spawn is granted), `unlisted-tools` | `--help` lists `--disallowedTools` | observed | claude 2.1.316 |
| `claude` | `outside-workspace-write` | `--permission-mode acceptEdits` | `tool-restriction` | `shell-outside-workspace-write` (when process-spawn is granted), `unlisted-tools` | `--help` lists `--permission-mode` | observed | claude 2.1.316 |
| `claude` | `process-spawn` | `--disallowedTools Bash` | `tool-restriction` | `unlisted-tools` | `--help` lists `--disallowedTools` | observed | claude 2.1.316 |
| `claude` | `network` | `--disallowedTools WebFetch,WebSearch` | `tool-restriction` | `shell-network` (when process-spawn is granted), `unlisted-tools` | `--help` lists `--disallowedTools` | observed | claude 2.1.316 |
| `codex` | `workspace-write` | `--sandbox read-only` | `cli-sandbox` | none | `--help` lists `--sandbox` | observed | codex-cli 0.163.0 |
| `codex` | `outside-workspace-write` | `--sandbox workspace-write` | `cli-sandbox` | none | `--help` lists `--sandbox` | observed | codex-cli 0.163.0 |
| `codex` | `process-spawn` | `--sandbox read-only` | `cli-sandbox` | `sandboxed-commands-run` | `--help` lists `--sandbox` | observed | codex-cli 0.163.0 |
| `codex` | `network` | none | `refused` | none | no flag in the planner's table expresses it | unsupported | codex-cli 0.163.0 |
| `agy` | `process-spawn` | `--sandbox --mode accept-edits` | `tool-restriction` | `mode-refuses-outside-write` (when outside-workspace-write is granted), `sandbox-scope-unqualified` | `--help` lists `--sandbox` ("Run in a sandbox with terminal restrictions enabled") and `--mode`; headless probe in §4.2 (cases i to k) | observed | agy 1.5.2 |
| `agy` | `workspace-write` | none | `refused` | none | no flag in the planner's table expresses it | unsupported | agy 1.5.2 |
| `agy` | `outside-workspace-write` | `--mode accept-edits` | `tool-restriction` | `mode-refuses-shell` (when process-spawn is granted) | `--help` lists `--mode` ("Set the agent execution mode for this session (accept-edits, auto, plan)"); headless probe in §4.2 | observed | agy 1.5.2 |
| `agy` | `network` | none | `refused` | none | no flag in the planner's table expresses it | unsupported | agy 1.5.2 |

`unsupported` here is about the planner's table: it declares no flag for the capability, so a Phase that
withholds it on that backend is refused before it starts rather than run unbounded. It does not say the CLI
has no mechanism the table could one day name; the capture looked for the flags the table names and no others.

A Codex Phase that withholds `process-spawn` runs `--sandbox read-only` whatever else its set grants, because
the strictest mode any withheld capability needs wins. `read-only` also blocks file writes, so a set that
grants `workspace-write` or `outside-workspace-write` and withholds `process-spawn` runs without the write it
granted. That is a stricter side effect, not a residual: it narrows authority rather than leaving something
open, the host accepts the set rather than refusing it, and the launcher sentence says the sandbox "also
blocks file writes".

<!-- Source: src/services/capability-confirmed-flags.ts -->
<!-- Source: src/services/capability-enforcement-plan.ts -->
<!-- Source: scripts/capture-backend-help.mjs -->

## 8. Platform qualification (`FR-R4-F06`)

Every row states what was observed, on what, at which version, or what it is waiting for. **No row is
`observed` on a fake, a stub or a simulation.** The cycle host is Darwin arm64, macOS 27.0.1, with
`claude` 2.1.316, `codex-cli` 0.163.0 and `agy` 1.5.2 installed (`agy` 1.4.12 at the first capture). It is the only host available, so every
`linux` and `win32` row is `unobserved` or `unsupported`, never inferred from darwin (§1).

| Topic | Platform | Status | Versions | Evidence or prerequisite |
|---|---|---|---|---|
| Containment flags present in `--help` | darwin | observed | claude 2.1.316, codex-cli 0.163.0, agy 1.5.2 | the offline capture of 2026-10-31, with `agy` re-captured on 2026-11-06; every flag in `CONFIRMED_FLAGS` was listed |
| Containment flags present in `--help` | linux | unobserved | n/a | a Linux host |
| Containment flags present in `--help` | win32 | unobserved | n/a | a Windows host |
| The ladder escalates a surviving same-group helper | darwin | observed | n/a | a real detached leader and a same-group helper that ignores SIGTERM: the ladder settled `group-gone`, the helper's pid answered `ESRCH` and no process carried its tag afterwards (`process-tree-surviving-helper.test.ts`) |
| The ladder escalates a surviving same-group helper | linux | unobserved | n/a | a Linux host |
| The ladder escalates a surviving same-group helper | win32 | unobserved | n/a | a Windows host. `taskkill /T` semantics and the job-object gap (a permanent limit, per `docs/architecture/native-binding-decision.md`) are stated from source, not observed |
| `orphaned-group` liveness | darwin | observed | n/a | a real leader that exited while its same-group helper slept: `orphaned-group`, then `dead` once the helper was killed (`process-liveness-group.test.ts`) |
| `orphaned-group` liveness | linux | unobserved | n/a | a Linux host |
| `orphaned-group` liveness | win32 | unsupported | n/a | liveness is `unanswerable` by design there: no process group is probeable (`src/services/process-liveness.ts`) |
| `--help` and `--version` under the minimal policy with an isolated home | darwin | observed | claude 2.1.316, codex-cli 0.163.0, agy 1.5.2 | each CLI exited 0 for both commands in the offline capture, and `agy` again in its re-capture |
| `--help` and `--version` under the minimal policy with an isolated home | linux | unobserved | n/a | a Linux host with the CLIs installed |
| `--help` and `--version` under the minimal policy with an isolated home | win32 | unobserved | n/a | a Windows host with the CLIs installed |
| A real turn under the minimal policy | darwin | unobserved | n/a | an account and a pinned CLI; a turn costs money and is not part of this record |
| A real turn under the minimal policy | linux | unobserved | n/a | an account, a pinned CLI and a Linux host |
| A real turn under the minimal policy | win32 | unobserved | n/a | an account, a pinned CLI and a Windows host |
| A same-user child can read the parent's environment | darwin | observed | n/a | `parent-env-sentinel.test.ts`, two booleans: `inOwnEnv=false` (the allowlist kept the sentinel out of the child's own environment), `readableFromParent=true` (`ps -E -p <ppid>` showed it) |
| A same-user child can read the parent's environment | linux | unobserved | n/a | a Linux host (`/proc/<ppid>/environ`) |
| A same-user child can read the parent's environment | win32 | unobserved | n/a | a Windows host |
| Remote extension-host topology | darwin | unobserved | n/a | a controlled Remote SSH or Dev Container host with a stub CLI |
| Remote extension-host topology | linux | unobserved | n/a | the same |
| Remote extension-host topology | win32 | unobserved | n/a | the same |

**What the sentinel row means.** The environment allowlist decides which variables a backend child
*receives*. It is not an operating-system boundary: on the host above, a same-user child could read its
parent's environment from the OS, so a secret kept out of the child's own environment is not thereby out of
its reach. Nothing in the product or its documentation should be read to say otherwise.

**Remote development is unqualified.** Whether the extension host, the workspace URI scheme, the sidecar
and the process host line up under Remote SSH or a Dev Container has not been measured. No `extensionKind`
is declared, and no activation diagnostic claims a configuration unsupported that has not been shown to be.
Treat remote use as outside what this record qualifies.

### 8.1 A version is not an identity

A version string does not authenticate an executable: two different binaries can print the same version. This
record's version column says what a CLI *reported*, and nothing here depends on its being the one a vendor
shipped. **Recording an executable's identity (a content hash or a code signature) is not adopted**, for three
reasons:

- vendor auto-updates would invalidate a hash pin, and requiring one is out of scope;
- anyone who can replace the binary already holds the operator's user authority, which is the authority an
  uncontained backend has regardless;
- no claim in this record depends on which build ran beyond its version.

The case that would reopen the decision is a support claim tied to a specific build: a promise that *this*
build behaves a certain way would need to know it was *this* build.

## 9. Completion lifecycle protocol qualification (`FR-R5-F11`)

All three backend adapters (`ClaudeCliRunner`, `CodexCliRunner`, `AgyCliRunner`) share the same observable guarantees for process spawn/error attribution (`processError` when `pid === undefined`), stdin prompt delivery (`writePromptToStdin` / `awaitStdinDelivery`), live-stream fatal diagnostic scanning (`IncrementalFatalScanner` / `combineStreamScans` populating `streamFatalMatch`), post-exit buffered pipe retention (`waitForChildCompletion` with `STDIO_CLOSE_GRACE_MS = 2,000` ms), output sink backpressure (`OutputSinkBackpressure`), idle timeout (`timeoutMs`), non-resetting wall-clock deadline (`maxDurationMs`), and awaited process-tree teardown (`escalateAndReportTree` / `settleTeardowns`).

They intentionally differ in **terminal event decoding**, qualified against the recorded canary versions (`claude` 2.1.302 / captured 2.1.316; `codex-cli` 0.159.2 / captured 0.163.0; `agy` 1.4.2 / captured 1.4.12):

- **`claude`**: Decodes top-level `{"type":"result"}` envelopes via `LineFramer` (including flushing any un-newlined trailing line on stdout `'end'` and after `waitForChildCompletion` settles) and arms `COMPLETION_SETTLE_MS` (15,000 ms) when no background-task hold is open, reporting `sawTerminalResult: true` and `completedAwaitingExit: true` if the CLI lingers after emitting its final result (`Feature 030 BUG-002`).
- **`codex` and `agy`**: Complete on process `'exit'` plus stdio `'close'`. Stream JSON rows (`{"type":"turn.completed"}` in Codex; `{"event":"result"}` / `{"type":"result"}` in Agy) are retained as stream data rather than process-termination triggers, and `sawTerminalResult` / `completedAwaitingExit` are omitted (`undefined`), as pinned in `tests/unit/runner/{codex-cli,agy-cli}-lifecycle.test.ts` and `tests/lint/result-envelope-unknown-is-unwritten.test.ts`.

<!-- Source: src/services/process-liveness.ts -->
<!-- Source: src/runner/process-tree.ts -->
<!-- Source: src/services/capability-confirmed-flags.ts -->
