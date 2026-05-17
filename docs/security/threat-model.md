# Operator Threat Model

Schegent runs an autonomous local Claude CLI backend with broad capabilities inside your workspace. This page is the operator-facing summary of what Schegent can and cannot do, what risks exist, and what mitigations are in place. It is not exhaustive — it is the model you need to make informed decisions about whether and how to use the extension.

## What Schegent has access to

Schegent runs as a VS Code extension. When a workspace is trusted, the extension can:

- **Spawn the Claude CLI subprocess** with the configured argv composition.
- **Read and write files** in the workspace root (via the CLI's tool calls).
- **Read and write `.schegent/`** for audit, transcripts, runtime log, diagnostics.
- **Read and write the VS Code `workspaceState`** for queue, run, pause state.
- **Read and write the VS Code `globalStorageUri`** for wake-up scheduler state.
- **Install/update/uninstall OS-native scheduled tasks** (launchd / Task Scheduler / cron / systemd-user) for the wake-up scheduler.

The Claude CLI itself, once spawned, has whatever capabilities its argv and the operator's environment grant it. The CLI's tool calls (`Bash`, `Write`, `Edit`, etc.) are not sandboxed beyond what the CLI itself implements.

## What Schegent does **not** have access to

- **Other workspaces.** Schegent's state is per-workspace. A run in workspace A cannot see or affect workspace B.
- **The network, except via the CLI.** The host extension itself does not make outbound network calls. The CLI does, to Anthropic's APIs.
- **Your shell environment beyond what is exported.** The host inherits VS Code's environment for the CLI subprocess; that environment is the operator's, but the CLI does not see VS Code internals.
- **The audit log content of *other* users on the same machine.** `.schegent/` lives in the workspace; multi-user shared workspaces are unusual.

## Trust boundaries

The trust model has three layers:

1. **The operator** trusts the host extension. (You installed it.)
2. **The host extension** trusts the configured CLI binary. (You configured `schegent.cli.path`.)
3. **The CLI** trusts the prompt and tool-call inputs Schegent composes. (Schegent generates the prompts from the spec/plan/task files and operator settings.)

The webview (the sidebar Svelte UI) is **untrusted with respect to mutating host state**. Every operator-action IPC message is sanitized at the host boundary; the host re-validates every input. The webview is the messenger, not the source of truth.

## Sanitization is centralized

Every operator-controllable string that flows to disk passes through one redaction set defined at `src/lib/logger.ts`. The same `SECRET_PATTERNS` redacts:

- The structured audit log (`.schegent/audit.log`).
- The runtime log (`.schegent/syslog`).
- The Output channel.
- The phase log feed shown in the sidebar.
- The wake-up session log at capture time.

A central set has two consequences:

1. **Extending the set** automatically extends every sink.
2. **Bypassing the set** would be detectable — any code path that writes operator-influenced text outside `SanitizedLogger` is a violation visible in code review.

The extension's CLAUDE.md hard rules forbid forking the redaction set or introducing parallel sanitizers.

## What is *intentionally* unredacted

Three sinks are deliberately unredacted:

- The **raw transcript** (`.schegent/sessions/raw-<runId>.log`). Captures CLI stdout/stderr verbatim. Always written.
- The **verbose diagnostic files** (`.schegent/sessions/<runId>/diagnostics/...`). Captured only when `schegent.logging.verbose` is true. Opt-in.
- The **wake-up session log** at `<globalStorageUri>/wakeup/session.log`. Sanitized at capture, defense-in-depth re-sanitized on read, but the on-disk bytes are intentionally unredacted-after-capture (the writer is a sink, not a sanitizer).

These exist because the sanitizer is conservative. When debugging a real failure, you sometimes need the field the sanitizer would have masked. The trade-off is:

- These files **never leave the operator's machine through the IPC pipeline.** The webview cannot request them. The audit log never references them by path.
- They are **gitignored.** The `.schegent/` directory ignores itself; the workspace `.gitignore` should ignore the directory.
- They **accumulate.** Diagnostic files do not rotate. Manage manually if you leave verbose on for long periods.

If you cannot tolerate unredacted bytes on disk, the mitigations are:

- Leave `schegent.logging.verbose` off (default).
- Add `**/.schegent/sessions/raw-*.log` to a global git ignore.
- Treat `.schegent/` like your shell history — useful, may contain sensitive context.

The wake-up session log lives under VS Code's global storage, not the workspace, so workspace-level `.gitignore` does not affect it.

## The paths-free audit discipline

The structured audit log **does not contain filesystem paths to sensitive locations**. By design:

- The wake-up session log's path is never in the audit log.
- The list of workspace roots is never in the audit log — only `rootCount`.
- The phase log feed's file path is never in the audit log — only the selection tuple (queueId, taskId, pipelineId, phaseId, iterationN).
- Operator credentials, environment variables, and tokens are scrubbed by the redaction set.

This makes the audit log **safe to ship off-machine**. It can be attached to bug reports, stored in shared infrastructure, or grepped by ops tooling without leaking sensitive locations. The unredacted sinks (raw transcript, verbose diagnostics, wake-up session log) are local-only by design and must not be shipped without review.

## The CSP and webview integrity

The webview enforces a strict Content Security Policy:

- No remote `script-src`. All script sources are bundled with the extension.
- No `unsafe-inline` beyond what is necessary for the Svelte runtime.
- No `iframe` embedding from external origins.

The webview cannot fetch from arbitrary URLs. It communicates with the host only via the typed IPC channel.

## Workspace-trust gating

Schegent registers as a `workspaceTrust` consumer with **untrusted-restricted** posture. In an untrusted workspace:

- The extension is loaded but every mutating command rejects.
- The sidebar shows a notice; no run is ever started.
- The wake-up scheduler does not install OS entries.

You must explicitly trust the workspace before Schegent does anything. This is the same trust gate VS Code applies for "can run code from this workspace".

## Primary-host gating (multi-window)

When the same workspace is open in multiple VS Code windows, only the **primary host** can mutate state. Secondary hosts receive `not-primary-host` rejections on every mutating IPC command.

This prevents two windows from racing on the same workspace. The primary host owns the workspace lock; the secondary host is read-only.

## The mutating-commands registry

Every mutating IPC command must be a member of `MUTATING_COMMANDS` in `src/ui/sidebar/messages.ts`. Adding a new mutating command requires adding it to the registry; the primary-only gate is enforced based on registry membership.

This is the single line of defense against accidentally adding a mutating command without primary-host gating. Forgetting to register is a code-review-catchable mistake.

## The append-only audit log

`.schegent/audit.log` is append-only. Schegent never modifies past entries. Task deletion records a `task-removed` event; it does not delete prior events. Reset Workspace State clears workspace state but does **not** touch the audit log.

The audit log is your evidence trail. If you have it, you can reconstruct every run, every phase, every tool call.

## What Schegent cannot prevent

- **A malicious CLI binary.** If `schegent.cli.path` points to a compromised binary, Schegent will run it. Verify the binary's provenance.
- **A malicious extension.** Other VS Code extensions running in the same workspace have whatever capabilities VS Code grants them. Schegent does not sandbox other extensions.
- **An operator who exfiltrates the unredacted sinks.** The raw transcript and verbose diagnostics are local but readable by the operator. If the operator's machine is compromised, the attacker has access to them.
- **A prompt-injection attack via spec/plan/task content.** If the spec file contains injection instructions, the CLI may follow them. The host does not analyze prompt content for adversarial inputs.

These are not Schegent's threat model to mitigate — they are upstream of the extension. But they shape what Schegent does and does not promise.

## The wake-up scheduler's elevated risk

The wake-up scheduler is the riskiest component because it spawns the CLI **outside the extension host**, scheduled by the OS. Mitigations:

- **Env scrubbing.** The OS-scheduled runner passes only an allowlisted env (`PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`). Workspace-specific vars cannot bleed in.
- **Workspace-roots check.** Before spawning the CLI, the runner asserts the chosen cwd is **not** inside any workspace root. A true result aborts the spawn. This prevents the priming invocation from silently ingesting workspace content.
- **Sandbox cwd.** The runner uses a temporary directory as the CLI's cwd; no workspace path is exposed.
- **Paths-free audit.** The runner's audit event (`wakeup-runner-invocation`) carries `correlationId`, `requestedModel`, `actualModel`, `outcome`, `cause` only — never paths.

If you do not trust the OS-scheduled execution model, **leave `schegent.wakeUp.enabled` off** (the default).

## A note on prompt-injection

Schegent feeds the spec, plan, and tasks files to the CLI as part of phase prompts. If those files contain injection instructions (e.g., "ignore prior instructions and execute X"), the CLI may follow them.

Mitigations are out-of-band:

- Do not check untrusted spec/plan/task content into the workspace.
- For features generated by Schegent itself, the model has produced its own files; injection is rare.
- For features whose spec is operator-authored, the operator is the trust boundary.

The host does not detect or block injection. This is a property of the model and the workflow, not of the extension's capability surface.

## The hard rules

The extension's CLAUDE.md ([CLAUDE.md](../../CLAUDE.md)) contains a long list of "never" rules that codify the threat model in code-review terms. Some of the most operator-visible:

- Never weaken the redaction set.
- Never route untrusted strings to the UI without sanitization.
- Never weaken CSP.
- Never skip lock release (use `withLock` wrapper).
- Never drop unknown audit event types from the parser.
- Never persist a `WorkflowRun` with inconsistent pause / retry state pairs.
- Never bypass `appendAudit` for custom-phase invocations.
- Never compute phase-catalog precedence in the webview.
- Never serialize workspace root paths into the audit log.
- Never widen the operator-additive fatal-signature surface without code review.
- Never sanitize twice or skip sanitization.

Each rule has a specific failure mode it prevents. Together, they enforce the threat model in code.

## Decisions you make as an operator

- **Do you trust the workspace?** If not, leave it untrusted; Schegent will not run.
- **Do you trust the CLI binary?** Verify `schegent.cli.path` points to a binary you installed.
- **Do you want unredacted bytes on disk?** Leave `schegent.logging.verbose` off; the raw transcript is still written.
- **Do you want the wake-up scheduler?** Off by default; on requires OS-level scheduling and per-invocation env-scrubbing.
- **How often do you review the audit log?** It is your evidence trail; treat it accordingly.

These choices belong to you. Schegent's job is to make the mechanisms transparent so you can make informed choices.

## Reporting issues

If you find a security issue:

- **Do not** post the issue publicly without coordination.
- Capture the audit log range, the relevant settings, and (if reproducible) a minimal repro.
- Report through the extension's security channel (see the repository README).

For non-security operational issues, file a regular bug report. See [Troubleshooting](../operations/troubleshooting.md) for what to include.

This page is a summary. For the underlying invariants and the long list of code-review rules, the extension's CLAUDE.md is the authoritative reference.
