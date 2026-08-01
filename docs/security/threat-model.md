# Operator Threat Model

Schegent runs an autonomous local CLI backend (Claude, Codex, or Agy) with broad capabilities inside your workspace. This page is the operator-facing summary of what Schegent can and cannot do, what risks exist, and what mitigations are in place. It is not exhaustive — it is the model you need to make informed decisions about whether and how to use the extension.

> For a non-contributor-facing projection of this threat model — trust ceiling, audit boundary, network boundary, seven failure modes, and five escape hatches in ≤15 pages — see [Security White-Paper](whitepaper.md).

## Threat catalog (T1–T20)

The catalog below enumerates each in-scope threat, the primary mitigation, and the prose section that elaborates. CLAUDE.md hard rules and `SECURITY.md` cite these identifiers directly; every cited `Tn` resolves to an anchor here. The `tests/lint/threat-id-anchor-parity.test.ts` regression fails the build on any drift.

| Id | Threat | Primary mitigation | Elaborated under |
|---|---|---|---|
| [T1](#t1--secret-leakage-to-operator-visible-sinks) | Secret leakage to operator-visible sinks (audit log, runtime log, Output channel, phase-log IPC, wake-up session log). | Single `SECRET_PATTERNS` redaction set in [src/lib/logger.ts](../../src/lib/logger.ts) feeds every `SanitizedLogger` sink. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T2](#t2--untrusted-webview-mutating-host-state) | The untrusted webview (Svelte sidebar) mutating host state via crafted IPC payloads. | Strict CSP + `MUTATING_COMMANDS` primary-host gate + host-side re-validation of every command payload. | [The CSP and webview integrity](#the-csp-and-webview-integrity), [The mutating-commands registry](#the-mutating-commands-registry) |
| [T3](#t3--audit-log-tampering-or-non-append-writes) | Audit log tampering, truncation, or non-append writes that destroy operator evidence. | `appendAudit` is the single writer; deletion paths never erase `.schegent/audit.log`; rotation preserves history. | [The append-only audit log](#the-append-only-audit-log) |
| [T4](#t4--workspace-path-leakage-into-the-structured-audit-log) | Workspace path leakage into the structured audit log (e.g. wake-up session-log path, workspace roots, phase-log file paths). | Paths-free audit discipline — count and selection-tuple fields only, never raw paths. | [The paths-free audit discipline](#the-paths-free-audit-discipline) |
| [T5](#t5--concurrent-state-mutation-across-multiple-vs-code-windows) | Concurrent state mutation across two VS Code windows opened on the same workspace. | Primary-host gating + `WorkspaceLockManager.withLock` + lock-file stale recovery. | [Primary-host gating (multi-window)](#primary-host-gating-multi-window) |
| [T6](#t6--workspace-lock-leak-fail-deadly) | Workspace lock leak (fail-deadly): a code path acquires the lock and never releases it, deadlocking subsequent runs. | All entry points wrap the body in `withLock`; pause paths must call `session.retain()`; forgotten retain is fail-safe (lock releases) not fail-deadly. | [The hard rules](#the-hard-rules) |
| [T7](#t7--untrusted-workspace-executing-extension-capabilities) | An untrusted workspace causing Schegent to spawn the CLI, install OS-scheduler entries, or write audit data. | `workspaceTrust: untrusted-restricted` posture; every mutating command rejects in an untrusted workspace. | [Workspace-trust gating](#workspace-trust-gating) |
| [T8](#t8--prompt-injection-via-specplantask-content) | Prompt-injection via spec / plan / task / phase-instruction content the operator (or an upstream model) authored. | Out-of-band trust boundary; the host does not analyze prompt content. Operator decides whether to ingest untrusted text. | [A note on prompt-injection](#a-note-on-prompt-injection) |
| [T9](#t9--custom-phase-bypassing-audit-or-redaction) | A custom-phase (`schegent.phases`) invocation bypassing the audit + redaction + raw-transcript path that built-ins flow through. | `appendAudit` + raw transcript writer is the single, mandatory invocation path. Custom-phase audit payloads carry `pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs`. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T10](#t10--verbose-diagnostic-unredacted-leak) | The verbose-diagnostic sink (`debug.json`, `stream.jsonl`, `verbose.log`) leaking unredacted bytes off-machine. | Operator-opt-in via `schegent.logging.verbose` (default off); gitignored; paths-free audit; intentionally local-only. | [What requires local-only handling](#what-requires-local-only-handling) |
| [T11](#t11--retrycondition-dsl-escape) | The operator-authored `retryCondition` DSL expression escaping the sandboxed evaluator. | Evaluator at `src/lib/retry-condition.ts` is the sole entry point: no arbitrary code, no function calls, no member access, no I/O. | [The hard rules](#the-hard-rules) |
| [T12](#t12--fatal-signature-floor-weakening) | Operator workspace settings weakening or re-ordering the code-resident fatal-signature floor. | `FATAL_SIGNATURES` in [src/lib/fatal-signature-registry.ts](../../src/lib/fatal-signature-registry.ts) is immutable at runtime; operator-additive surface extends but never removes built-ins; built-ins-first scan order preserved. | [The hard rules](#the-hard-rules) |
| [T13](#t13--state-schema-invariant-violation) | Persisting a `WorkflowRun` with a one-sided pair (`pendingRetryAt`/`pendingRetryCause` or `manualPauseAt`/`manualPauseCause`) that leaves the scheduler in an unresumable state. | `WorkspaceStateStore.setRun()` rejects mismatched pairs; forward-only migrators backfill legacy records. | [The hard rules](#the-hard-rules) |
| [T14](#t14--multi-queue-reintroduction) | Re-introducing the multi-queue registry shape (removed in v6) and bypassing the single-queue invariants. | `MAX_QUEUES === 1` in `src/queue/queue-registry.ts`; lint regression `tests/lint/no-multi-queue-commands.test.ts`; v5→v6 forward-only migrator. | [The hard rules](#the-hard-rules) |
| [T15](#t15--phase-message-env-injection) | A `phase-message.env` value reaching the UI or audit projection without passing through the sanitizer used at prompt composition time. | Phase-message values pass through `SanitizedLogger.sanitize` before downstream consumption; audit + UI surface metadata only, never raw env values. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T16](#t16--operator-additive-fatal-signatures-stale-cache) | A cached `schegent.fatalSignatures` value masking an operator update mid-run. | `FatalSignaturesAccessor` is read at the top of every `PhaseRunner.run()`; never cached on the runner. | [The hard rules](#the-hard-rules) |
| [T17](#t17--wake-up-runner-workspace-contamination) | The OS-scheduled wake-up runner spawning the CLI inside a workspace root, or with workspace-specific environment variables leaking through. | Env scrubbing allowlist (`PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`); `cwdInsideWorkspace` defense against the workspace-roots snapshot; paths-free `wakeup-runner-invocation` audit. | [The wake-up scheduler's elevated risk](#the-wake-up-schedulers-elevated-risk) |
| [T18](#t18--vs-code-namespace-leakage-into-headless-or-telemetry-code) | A `vscode` import reaching `src/headless/`, `src/wakeup/`, or `src/telemetry/` and either blowing up the spawn or re-enabling a capability surface those trees must not have. | Lint regressions in `tests/lint/no-vscode-import-in-{headless,wakeup,telemetry}.test.ts` fail the build on drift. | [The wake-up scheduler's elevated risk](#the-wake-up-schedulers-elevated-risk) |
| [T19](#t19--runtime-log-sink-forking-the-redaction-set) | The runtime log sink forking or doubling the redaction set, breaking the "single SECRET_PATTERNS source of truth" guarantee. | Sink at `src/lib/runtime-log/runtime-log-sink.ts` is a `LogSink` registered on `SanitizedLogger`; no second sanitizer; `tests/lint/no-direct-syslog-fs-writes.test.ts` pins the writer allowlist. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T20](#t20--phase-log-ipc-double-or-skipped-sanitization) | The phase-log IPC pipeline (manifest read + live tail) double-sanitizing, skipping sanitization, or routing operator-influenced strings to the webview via `{@html}` interpolation. | Fixed order project → truncate → sanitize at the IPC boundary; one injected `SanitizedLogger.sanitize`; webview never re-sanitizes; `tests/lint/no-html-interpolation-in-activity-feed.test.ts` pins the rule. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T21](#t21--untrusted-stdout-names-local-files) | A CLI audit-event JSON line names a `phase-message.env` path outside the run's diagnostics tree (attacker-influenced absolute path or `..`-traversal), and the host reads through the steered path. | Canonical-path containment in `src/controller/phase-sidecar-reader.ts`: the host computes the expected path from `(workspaceRoot, runId, pipelineId, phaseId, iterationN)`; audit-reported paths are accepted only when they canonicalize byte-equal, and ignored entirely when the canonical file exists. | [T21 anchor](#t21--untrusted-stdout-names-local-files) |

## What Schegent has access to

Schegent runs as a VS Code extension. When a workspace is trusted, the extension can:

- **Spawn the CLI subprocess** (Claude, Codex, or Agy) with the configured argv composition.
- **Read and write files** in the workspace root (via the CLI's tool calls).
- **Read and write `.schegent/`** for audit, transcripts, runtime log, diagnostics.
- **Read and write the VS Code `workspaceState`** for queue, run, pause state.
- **Read and write the VS Code `globalStorageUri`** for wake-up scheduler state.
- **Install/update/uninstall OS-native scheduled tasks** (launchd / Task Scheduler / cron / systemd-user) for the wake-up scheduler.

The CLI itself, once spawned, has whatever capabilities its argv and the operator's environment grant it. The CLI's tool calls (`Bash`, `Write`, `Edit`, etc.) are not sandboxed beyond what the CLI itself implements. All backend runners (Claude, Codex, Agy) use the identical `shell: false`, monitor sidecar, and output-cap truncation patterns, meaning switching backends introduces no new trust boundaries.

## What Schegent does **not** have access to

- **Other workspaces.** Schegent's state is per-workspace. A run in workspace A cannot see or affect workspace B.
- **The network, except via the CLI.** The host extension itself does not make outbound network calls. The CLI does, to Anthropic's APIs.
- **Your shell environment beyond the selected policy.** The compatibility
  default forwards the VS Code extension-host environment. Hardened operators
  can select `minimal` or a names-only `allowlist`; the policy applies to
  backend probes, phase calls, and pre-compaction calls. Allowlist values are
  read only at spawn time and never stored in Schegent settings.
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

## What requires local-only handling

Three local diagnostic sinks require special handling:

- The **raw transcript** (`.schegent/sessions/raw-<runId>.log`). Captures CLI
  stdout/stderr verbatim. Always written through mode-`0600`, backpressured
  OS-temporary spools that are removed after finalization; abandoned spools
  are scavenged after their owner process is no longer alive.
- The **verbose diagnostic files** (`.schegent/sessions/<runId>/diagnostics/...`). Captured only when `schegent.logging.verbose` is true. Opt-in.
- The **wake-up session log** at `<globalStorageUri>/wakeup/session.log`. Sanitized before write, defense-in-depth re-sanitized on read, and kept outside the workspace in VS Code global storage. The writer itself is a sink and does not carry a second sanitizer.

The raw transcript and verbose diagnostic files exist because the sanitizer is conservative; when debugging a real failure, operators sometimes need the bytes the sanitizer would have masked. The wake-up session log is sanitized, but it still captures local execution context and lives outside workspace-level `.gitignore` coverage. The trade-off is:

- These files **never leave the operator's machine through the IPC pipeline.** The webview cannot request them. The audit log never references them by path.
- They are **gitignored.** Schegent writes a best-effort `.schegent/.gitignore`
  on first runtime-directory use, and project repositories should also ignore
  `.schegent/` at the workspace root.
- They **have bounded retention.** Diagnostic files do not rotate individually,
  but complete inactive-run groups are pruned to the configured session-artifact
  age and byte limits. Running and paused runs are protected.

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
- The Metrics dashboard's `metrics-view-opened` event (feature 073) carries only a reused `sessionId` — no task descriptions, phase names, cost figures, or paths.
- Operator credentials, environment variables, and tokens are scrubbed by the redaction set.

This makes the audit log **safe to ship off-machine**. It can be attached to bug reports, stored in shared infrastructure, or grepped by ops tooling without leaking sensitive locations. The local diagnostic sinks (raw transcript, verbose diagnostics, wake-up session log) are local-only by design and must not be shipped without review.

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

## Per-capability trust scopes

VS Code's Workspace Trust is binary; Schegent layers three
independently-configurable trust scopes on top to give enterprise IT a
narrower gate than "trust everything or trust nothing":

- `schegent.trust.allowCustomPhases` — gates non-default phase prompts.
- `schegent.trust.allowCustomRetryConditions` — gates non-default retry-condition DSL expressions on phase rows.
- `schegent.trust.allowPipelineOverrides` — gates non-default entries in the pipeline catalog.

Each setting is `boolean | null`, defaults to `null` (follow Workspace
Trust), and is resolved against a four-step ladder:
**workspace-trust ceiling → workspace-scope → user-scope → default-allow**.

The Workspace Trust check runs first. A workspace that is not trusted
returns `false` for every capability regardless of any user- or
workspace-scope value — the **ceiling is never widened**. This is the
core invariant: per-capability scopes can only *narrow* the trust
surface, never broaden it past what VS Code's workspace-trust gate
allows.

Denied save attempts emit a `trust.capability-denied` audit event whose
payload is bounded to a closed enum (capability, resolved scope, fixed
reason template) plus `workspaceBasename` (basename only, never the
full path). No operator-controlled string flows into the payload, so
`SECRET_PATTERNS` redaction is unchanged.

See [operations/trust-scopes.md](../operations/trust-scopes.md) for the
operator-facing guide, the full 16-row truth table, and the four worked
resolution examples.

## Primary-host gating (multi-window)

When the same workspace is open in multiple VS Code windows, only the **primary host** can mutate state. Secondary hosts receive `not-primary-host` rejections on every mutating IPC command.

This prevents two windows from racing on the same workspace. The primary host owns the workspace lock; the secondary host is read-only.

## The mutating-commands registry

Every mutating IPC command must be a member of `MUTATING_COMMANDS` in `src/ui/sidebar/message-router.ts`. Adding a new mutating command requires adding it to the registry; the primary-only gate is enforced based on registry membership.

This is the single line of defense against accidentally adding a mutating command without primary-host gating. Forgetting to register is a code-review-catchable mistake.

Read-only IPC commands are intentionally excluded from this registry — e.g. `CMD_READ_PHASE_LOG` (020), the wake-up session-log reads (031), and `CMD_READ_METRICS` (073). None of these write workspace state, so the primary-only gate does not apply and secondary VS Code hosts may dispatch them too. `CMD_READ_METRICS` derives its response entirely from the existing (already paths-free, already redacted) audit log and writes nothing new except the one-shot `metrics-view-opened` adoption event described above — no new trust boundary is introduced.

## The append-only audit log

`.schegent/audit.log` is append-only. Schegent never modifies past entries. Task deletion records a `task-removed` event; it does not delete prior events. Reset Workspace State clears workspace state but does **not** touch the audit log.

The audit log is your evidence trail. If you have it, you can reconstruct every run, every phase, every tool call.

Audit durability is also an execution gate. A durable append failure projects
`evidence unavailable`, fails the active run with the sanitized
`audit-evidence-unavailable` code, and suppresses automatic queue drain. Raw
transcript and runtime-log failures instead project `evidence degraded` and
permit execution to continue. Health payloads contain normalized causes only;
they never contain exception messages, paths, prompts, or environment values.
See [Execution Evidence Health](../operations/evidence-health.md).

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

## Threat anchors

The headings below are the canonical anchor targets for the [Threat catalog (T1–T20)](#threat-catalog-t1t20) table. Each entry restates the threat, names the load-bearing defenses, and points to the elaborating prose.

### T1 — Secret leakage to operator-visible sinks

API keys, bearer tokens, JWTs, AWS access key ids, GitHub tokens, Slack tokens, GCP service-account material, and any matching env-style `KEY=VALUE` strings that reach an operator-visible sink. Mitigated by the single `SECRET_PATTERNS` set in [src/lib/logger.ts](../../src/lib/logger.ts); every `SanitizedLogger` sink (audit, runtime log, Output channel, phase-log IPC, wake-up session log) re-uses the same regex set. See [Sanitization is centralized](#sanitization-is-centralized).

### T2 — Untrusted webview mutating host state

The Svelte sidebar is the messenger, not the source of truth. A crafted IPC message that bypasses primary-host gating, registry validation, or host-side re-validation would let a non-primary VS Code host mutate workspace state. Mitigated by the strict CSP, the `MUTATING_COMMANDS` registry, and host-side re-validation of every command payload. See [The CSP and webview integrity](#the-csp-and-webview-integrity) and [The mutating-commands registry](#the-mutating-commands-registry).

### T3 — Audit log tampering or non-append writes

The structured audit log at `<workspaceRoot>/.schegent/audit.log` is the operator's evidence trail. Any code path that truncates, overwrites, or deletes prior entries would destroy that evidence. Mitigated by the append-only invariant — `appendAudit` is the single writer; task deletion records `task-removed` and never erases history; rotation preserves the rotated generations. See [The append-only audit log](#the-append-only-audit-log).

### T4 — Workspace path leakage into the structured audit log

A workspace path serialized into an audit payload would leak the operator's directory structure when the audit log is shipped off-machine (e.g. attached to a bug report). Mitigated by the paths-free audit discipline — counts and selection tuples only, never `path`, `filePath`, `workspaceRoot`, `roots`, `paths`, or `workspaces`. See [The paths-free audit discipline](#the-paths-free-audit-discipline).

### T5 — Concurrent state mutation across multiple VS Code windows

Opening the same workspace in two VS Code windows would otherwise race on shared mutable state (queue, run, pause). Mitigated by primary-host gating — only the primary host accepts mutating commands; secondary hosts receive `not-primary-host` rejections. The `MUTATING_COMMANDS` registry is the single source of truth for which commands are gated. See [Primary-host gating (multi-window)](#primary-host-gating-multi-window).

### T6 — Workspace lock leak (fail-deadly)

A code path that acquires the workspace lock and never releases it would deadlock subsequent runs (fail-deadly). Mitigated by `WorkspaceLockManager.withLock` — the wrapper acquires (idempotent for the same owner), runs the body, and releases the lock in `finally` on both normal and exceptional exit. Pause paths that intentionally retain the lock past the scope call `session.retain()`; a forgotten `retain` is fail-safe (the lock releases) rather than fail-deadly (the lock leaks).

### T7 — Untrusted workspace executing extension capabilities

A workspace the operator has not explicitly trusted must not cause Schegent to spawn the CLI, install OS-scheduler entries, or persist state. Mitigated by Schegent registering as a `workspaceTrust` consumer with `untrusted-restricted` posture; every mutating command rejects until the workspace is trusted. See [Workspace-trust gating](#workspace-trust-gating).

### T8 — Prompt-injection via spec / plan / task content

If the spec / plan / task / phase-instruction text contains injection instructions (e.g. "ignore prior instructions and exec X"), the CLI may follow them. The host does not analyze prompt content for adversarial inputs — this is upstream of the extension's threat model. Mitigations are out-of-band: do not check untrusted content into the workspace; operator-authored content is the trust boundary. See [A note on prompt-injection](#a-note-on-prompt-injection).

### T9 — Custom-phase bypassing audit or redaction

A custom phase declared in `schegent.phases` could in principle skip the audit + redaction + raw-transcript path that built-in phases flow through. Mitigated by routing every phase invocation — built-in and custom — through the same `appendAudit` + raw transcript writer. Custom-phase audit payloads carry `pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs` / `runner`. Feature 072 task-execution lifecycle events (`task-execution-started`, `task-execution-ended`, etc.) flow through this identical `appendAudit` → `SanitizedLogger` path, introducing no new trust boundary.

### T10 — Verbose-diagnostic unredacted leak

The verbose-diagnostic files (`debug.json`, `stream.jsonl`, `verbose.log` under `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`) are intentionally unredacted. The risk is that an operator ships them off-machine. Mitigated by making the sink operator-opt-in (`schegent.logging.verbose`, default off), gitignored, and excluded from the structured audit log. See [What requires local-only handling](#what-requires-local-only-handling).

### T11 — retryCondition DSL escape

The operator-authored `retryCondition` DSL must not execute arbitrary code, perform I/O, or access object members. Mitigated by sandboxing the evaluator in `src/lib/retry-condition.ts`: identifiers + numeric literals + comparison/boolean operators + parentheses only. Any new evaluator must preserve those invariants.

### T12 — Fatal-signature floor weakening

The code-resident `FATAL_SIGNATURES` floor in [src/lib/fatal-signature-registry.ts](../../src/lib/fatal-signature-registry.ts) classifies CLI exit signatures that always escalate to operator intervention. The risk is that operator workspace settings (`schegent.fatalSignatures`) remove, re-order, or shadow built-ins. Mitigated by making the operator-additive surface strictly extension-only — operator entries can extend the registry but cannot remove, modify, or re-order built-ins; the built-ins-first scan order is preserved so a built-in that matches the same text wins attribution. The `fatal-signature-matched` audit event carries `source: 'built-in' | 'operator-defined'`.

### T13 — State schema invariant violation

`WorkflowRun.pendingRetryAt` / `pendingRetryCause` and `WorkflowRun.manualPauseAt` / `manualPauseCause` are both-null-or-both-non-null pairs. A persisted run with a one-sided pair would leave the scheduler in an unresumable state. Mitigated by rejection in `WorkspaceStateStore.setRun()`; forward-only migrators backfill legacy records on activation.

### T14 — Multi-queue reintroduction

The v6 `QueueRegistry` is constrained to exactly one entry with `id === 'default'`. Re-introducing multi-queue support would reopen the registry race surface and the orphan-task pathways the v5→v6 migration retired. Mitigated by `MAX_QUEUES === 1` in `src/queue/queue-registry.ts`, the lint regression `tests/lint/no-multi-queue-commands.test.ts`, and the forward-only v5→v6 migrator.

### T15 — Phase-message env injection

A `phase-message.env` value could otherwise reach the UI or audit projection without passing through the sanitizer used at prompt composition time. Mitigated by routing phase-message values through `SanitizedLogger.sanitize` before downstream consumption; the audit + UI surfaces expose metadata only, never raw env values.

### T16 — Operator-additive fatal-signatures stale cache

Caching the `schegent.fatalSignatures` value on the runner would mask an operator update mid-run. Mitigated by reading the `FatalSignaturesAccessor` at the top of every `PhaseRunner.run()` (mirrors the `VerboseDiagnosticsAccessor` and `AutoCompactOverrideAccessor` patterns) so a toggle applies to the next phase boundary.

### T17 — Wake-up runner workspace contamination

The OS-scheduled wake-up runner is detached from the VS Code host and runs with direct UID access to the operator's filesystem. The risk is that it spawns the CLI inside a workspace root, or with workspace-specific environment variables leaking through. Mitigated by (a) env scrubbing — only `PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR` pass to `child_process.spawn`; (b) the `cwdInsideWorkspace` defense against the workspace-roots snapshot at `<globalStorageUri>/wakeup/workspace-roots.json`, which aborts the spawn if the chosen cwd is a descendant of any root; (c) paths-free `wakeup-runner-invocation` audit payload. See [The wake-up scheduler's elevated risk](#the-wake-up-schedulers-elevated-risk).

### T18 — VS Code namespace leakage into headless or telemetry code

Any `vscode` import reaching `src/headless/`, `src/wakeup/`, or `src/telemetry/` would either blow up the spawn at runtime (`Cannot find module 'vscode'`) or re-enable a capability surface those trees must not have. Mitigated by the lint regressions `tests/lint/no-vscode-import-in-{headless,wakeup,telemetry}.test.ts`.

### T19 — Runtime log sink forking the redaction set

A second sanitizer in the runtime log sink would break the "single `SECRET_PATTERNS` source of truth" guarantee — extending the set in one place would no longer extend every sink. Mitigated by registering the runtime log sink as a `LogSink` on `SanitizedLogger`, which writes lines that have already been sanitized once. Direct `fs.appendFile` calls against a path containing `syslog` are blocked by the `tests/lint/no-direct-syslog-fs-writes.test.ts` regression.

### T20 — Phase-log IPC double or skipped sanitization

The phase-log IPC pipeline (manifest read + live tail) must sanitize exactly once at the host → webview boundary, in the fixed order project → truncate → sanitize. The risks are (a) double-sanitization corrupting the projected JSON, (b) skipping sanitization on a new field, or (c) the webview re-stringifying / re-sanitizing a host-sanitized field via `{@html …}` interpolation. Mitigated by a single injected `SanitizedLogger.sanitize` at the IPC boundary in `src/services/phase-log/phase-log-reader.ts` (manifest reads) and `src/services/phase-log/phase-log-tail-session.ts` (live tail pushes); the webview consumes the field as a typed JSON value only; `tests/lint/no-html-interpolation-in-activity-feed.test.ts` pins the rule.

### T21 — Untrusted stdout names local files

**Source**: Claude / Codex CLI stdout, operator-influenced phase prompts, repo files.
**Vector**: A CLI audit-event JSON line includes a `phaseMessagePath` field. A malicious phase prompt could induce the CLI to emit an audit entry naming `/etc/passwd` (or any operator-readable file) so the next phase reads its contents as prompt context. The 4 KiB byte cap limits exfiltration via the next prompt but does not prevent reading sensitive small files.
**Pre-feature mitigation**: basename filter (`path.basename === 'phase-message.env'`). Defeated by any attacker-named symlink or any operator-influenced file already named `phase-message.env`.
**Post-feature mitigation (feature 056, T1-T20 floor preserved)**: canonical-path containment in [src/controller/phase-sidecar-reader.ts](../../src/controller/phase-sidecar-reader.ts) `parsePhaseMessage()`. The host computes the expected sidecar path from `(workspaceRoot, runId, pipelineId, phaseId, iterationN)`. When the canonical file exists, the audit-reported path is IGNORED entirely; when it does not, audit-reported paths are accepted only if they canonicalize byte-equal to the canonical path (via `fs.realpathSync.native`). Otherwise the runner emits `phase-message-invalid` with `reason: 'path-outside-run-dir'` or `'missing-canonical-sidecar'` and proceeds with `sidecar: null, suspicious: true`.
**Residual risk**: If the operator places a malicious symlink AT the canonical path before the run starts, the host reads through it. This is operator-on-operator (the symlink had to be authored by the operator) and outside the trust boundary.
