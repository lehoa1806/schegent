# Schegent Architecture

The execution-repository architecture map. Source code lives under `src/`, the
Svelte webview under `webview-ui/`, and operator-facing docs under `docs/`.
This document is normative for module boundaries and trust gates; CLAUDE.md
remains the authoritative source for code-change hard rules.

## Purpose

Schegent is a local-first VS Code extension that drives autonomous Speckit
workflows through CLI backends (Claude Code, Codex, and Agy). The extension host owns
orchestration, workspace state, audit evidence, runtime logging, IPC
validation, and queue control. The Svelte webview is a presentation layer
that renders host-projected snapshots and dispatches typed commands; the host
is the single source of truth.

## System Boundaries

```text
┌──────────────────────────────────────────────────────────────────┐
│ Operator Workstation (trusted)                                   │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ VS Code Extension Host (Node 20, TypeScript 5.x)             │ │
│ │   • workspace state, IPC validation, audit, runtime log      │ │
│ │   • controller, queue, scheduler, backend-runner factory     │ │
│ └──┬────────────────────────────┬───────────────────┬──────────┘ │
│    │ host-projected snapshots   │ subprocess        │ scheduler  │
│    │ + typed IPC commands       │ (shell: false)    │ entry      │
│    ▼                            ▼                   ▼            │
│ ┌──────────────┐    ┌────────────────────────┐  ┌────────────┐   │
│ │ Svelte       │    │ Claude/Codex/Agy CLI │  │ launchd /  │   │
│ │ Webview      │    │ subprocess             │  │ systemd /  │   │
│ │ (sidebar +   │    │ • stdin prompt         │  │ Task       │   │
│ │  dashboard)  │    │ • stream-json stdout   │  │ Scheduler  │   │
│ └──────────────┘    └────────────────────────┘  └─────┬──────┘   │
│                                                       │ detached │
│                                                       ▼ exec     │
│                                              ┌────────────────┐  │
│                                              │ wake-up runner │  │
│                                              │ (headless,     │  │
│                                              │  no vscode)    │  │
│                                              └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**External boundaries:**

- VS Code APIs are usable in extension-host code and forbidden in `src/headless/`, `src/wakeup/`, and `src/telemetry/`. Lint regressions under `tests/lint/` enforce this.
- CLI backends run as subprocesses with `shell: false`, bounded stdout/stderr
  buffers, timeout/cancellation handling, and one centrally resolved
  environment policy. The compatibility default inherits; hardened `minimal`
  and names-only `allowlist` modes apply identically to probes, phase calls,
  and pre-compaction calls.
- Workspace files at `<workspaceRoot>/.schegent/` hold per-workspace runtime artifacts: structured audit log, raw transcripts, opt-in verbose diagnostics, runtime log.
- `vscode.ExtensionContext.workspaceState` (memento) stores serialized run, queue, and history records. Forward-only migrators upgrade old records.
- `vscode.ExtensionContext.globalStorageUri` stores wake-up scheduler state and session logs.

## Module Layout

```text
src/
├── activation/   extension-host composition helpers; no workflow policy
├── audit/        evidence sinks — structured audit, raw transcript, verbose diagnostics, gitignore
├── commands/     extension command palette and command handlers
├── config/       settings schema (single source of truth), pipeline catalog, precedence, validation
├── contracts/    IPC, audit, monitor, queue-snapshot, state-schema, runner contracts
├── controller/   workflow state machine, phase runner, sequencer, retry handler, continue gate
├── engine/       shared engine boundary taxonomy, parity fixtures, current extension adapter
├── headless/     non-extension-host entrypoints (wake-up runner) — must not import vscode
├── host-services/ neutral host-service interfaces and VS Code adapter for future desktop host parity
├── lib/          shared pure helpers, SanitizedLogger, runtime-log sink, retry-condition DSL
├── monitor/      subprocess progress, stall detection, monitor events
├── parser/       stdout/audit-block/usage/rate-limit/credit-error parsers
├── queue/        single-active-run queue registry and scheduling primitives
├── runner/       Claude/Codex/Agy adapters, lazy registry, factory, prompt builder
├── services/     auto-drain, guarded-run, history-recorder, phase-log, session-cleanup
├── state/        memento-backed run/queue/history state and forward-only migrators
├── telemetry/    local process-resource sampling — must not import vscode
├── ui/           VS Code-facing UI surfaces (sidebar provider, dashboard panel, output channel, status bar)
├── wakeup/       OS scheduler integration (launchd, systemd-user, Task Scheduler, cron)
└── watchdog/     credit/rate-limit polling for delayed retry recovery

webview-ui/
├── src/
│   ├── App.svelte                  sidebar root
│   ├── main.ts                     sidebar entry
│   ├── components/                 sidebar Svelte components
│   ├── dashboard/                  dashboard Svelte components + entry
│   └── lib/                        IPC helper modules and pure projectors
└── __tests__/                      vitest suite
```

## Module Ownership

| Module | Owned responsibility | Must not own |
|---|---|---|
| `src/activation/backend-wiring.ts` | Stage-1 runtime/evidence sink composition and the names-only unrestricted-environment warning | Workflow transitions, IPC, or backend invocation |
| `src/activation/ui-wiring.ts` | Stage-2 dashboard bridge plus VS Code operator-command registration/disposal | Workflow mutation policy, persistence, or IPC validation |
| `src/controller/phase-control-service.ts` | Operator pause/resume/restart/skip/enable/disable/remove and breakpoint mutation policy | Activation wiring, queue ownership, or audit serialization |
| `src/controller/workflow-lifecycle-auditor.ts` | Workflow/phase audit taxonomy, envelope construction, and best-effort append handling | Workflow state mutation, dispatch, or UI projection |
| `src/services/evidence-health/` | Workspace-scoped sink health, bounded causes, and continuation policies | Raw exception text, filesystem paths, or UI rendering |
| `src/services/session-retention/` | Age/byte pruning for inactive `.schegent/sessions` run groups | Structured audit retention or active-run deletion |
| `src/services/session-dispatch-policy.ts` | Pure backend-session ownership and continuation/reuse dispatch policy | Persisting session IDs or composing backend argv |
| `src/runner/spawn-env.ts` | One subprocess environment policy for probes, phases, and compaction | Backend-specific argument construction |
| `src/contracts/validators/` | Shared IPC validation primitives plus phase-log, wake-up, and metrics domain validators | Command dispatch coverage or downstream business invariants |
| `src/contracts/sidebar-ipc/` | Focused phase-log, wake-up, metrics, trust, and host-message IPC type families | Command literals, runtime guards, or routing behavior |
| `src/ui/sidebar/activity-timing.ts` | Pure elapsed-time and live-activity calculations | Store subscriptions, audit hydration, or snapshot publication |
| `src/ui/sidebar/audit-tail-state.ts` | Bounded live audit cache, cold-start dedupe/merge, seeding, and snapshot copies | Store subscriptions, workflow timing, or UI publication |
| `src/ui/sidebar/state-projector.ts` | Snapshot orchestration and projection lifecycle | Sink I/O or elapsed-time algorithms |

`src/host-services/` makes VS Code-owned platform behavior explicit before a
Rust desktop host exists. Its `types.ts` contract is `vscode`-free and covers
workspace root/trust, configuration, memento persistence, global storage,
notifications, command dispatch, file reveal, scheduler, and lifecycle
disposal. `vscode-host-services.ts` is the current adapter and delegates
canonical root selection through `src/state/workspace-folder-picker.ts`.

`src/engine/` defines the shared workflow control boundary that both the VS
Code extension and future desktop release will target. It enumerates queue,
workflow, phase, settings, log, wake-up, cancellation, event-stream,
host-dependency, and storage responsibilities, plus parity fixtures for
cross-host certification. `CurrentExtensionEngineAdapter` wraps current
TypeScript handlers with typed acknowledgements and rejects unwired commands
as `engine-command-unavailable`; this is not yet the default controller path.

## Primary Flow

```text
operator action / IPC      ┌─────────────────────────────────────┐
   │                       │ src/ui/sidebar/message-router.ts    │
   ▼                       │   workspace-trust gate (closed-fail)│
┌───────────────┐          │   primary-host gate (MUTATING_*)    │
│ src/commands/ │──────────▶│   ipc-validator.ts (typed payload)  │
└───────────────┘          └─────────────┬───────────────────────┘
                                         │ accepted command
                                         ▼
                          ┌──────────────────────────────────┐
                          │ src/services/guarded-run-service │
                          │   + queue/queue-manager          │
                          └─────────────┬────────────────────┘
                                        │ promote pending → active
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/controller/workflow-controller│
                          │   acquires workspace lock         │
                          │   drives phases via phase-runner  │
                          └─────────────┬────────────────────┘
                                        │ per-phase invocation
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/controller/phase-runner       │
                          │   phase-start audit emit          │
                          │   raw-transcript bracket          │
                          │   build prompt, invoke runner     │
                          │   parse stdout, classify outcome  │
                          │   phase-end audit emit            │
                          └─────────────┬────────────────────┘
                                        │ outcome
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/runner/{claude,codex,agy}-cli │
                          │   subprocess: shell:false         │
                          │   bounded buffers, env scrubbed   │
                          └─────────────┬────────────────────┘
                                        │ stdout/stderr/exit
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/parser/*                      │
                          │   precedence: fatal → rate-limit  │
                          │   → non-zero exit → contract      │
                          │   blocks → remaining issues       │
                          └─────────────┬────────────────────┘
                                        │
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/state/workspace-state         │
                          │   serialize run/queue/history     │
                          │   forward-only migration          │
                          └─────────────┬────────────────────┘
                                        │ snapshot
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/ui/sidebar/* projectors       │
                          │   pure snapshot → webview shape   │
                          └─────────────┬────────────────────┘
                                        │ postMessage
                                        ▼
                                Svelte webview render
```

## Subsystems

### Controller (`src/controller/`)

[workflow-controller.ts](src/controller/workflow-controller.ts) owns the run
state machine, lock acquisition, and the phase-by-phase execution loop. It
delegates per-phase work to:

- [phase-runner.ts](src/controller/phase-runner.ts) — boundary between
  orchestration and CLI execution. Owns `phase-start` / `phase-end` audit
  emission, raw-transcript bracketing, fatal-signature classification,
  rate-limit classification, phase-message sidecar parsing (with the
  canonical-path containment guard from spec 056 Track 2), retry-condition
  evaluation (sandboxed DSL), and timeout/cancel mapping.
- [phase-sequencer.ts](src/controller/phase-sequencer.ts) — iteration
  sequencing primitives extracted in feature 047.
- [retry-handler.ts](src/controller/retry-handler.ts) — retry orchestration,
  clamped by `DELAYED_RETRY_CAP = 5` (in [retry-constants.ts](src/controller/retry-constants.ts)).
- [is-continue-gate.ts](src/controller/is-continue-gate.ts) — single
  source-of-truth for whether `--continue` may be passed to Claude on the
  next phase invocation. `request.isContinue === true` is the only path that
  inserts the `-c` flag.
- [rate-limit-backoff.ts](src/controller/rate-limit-backoff.ts),
  [schedule-watchdog.ts](src/controller/schedule-watchdog.ts), and
  [breakpoint-accessor.ts](src/controller/breakpoint-accessor.ts) — supporting
  collaborators.

Feature 057 will further decompose `phase-runner.ts` into sidecar reader,
prompt assembler, and continue-gate coordinator; see
[specs/057-phase-runner-decomposition/plan.md](../../specs/057-phase-runner-decomposition/plan.md).

### Runner (`src/runner/`)

[backend-runner-registry.ts](src/runner/backend-runner-registry.ts) lazily
constructs and caches a concrete `BackendRunner` per kind through
[backend-runner-factory.ts](src/runner/backend-runner-factory.ts).
`PhaseRunner` resolves the effective kind once per invocation from the phase
override and global default, and `RunDriver` clears backend-owned session
state before a runner transition.

- [claude-cli.ts](src/runner/claude-cli.ts) — invokes Claude with `shell: false`,
  bounded stdout and stderr for parsing, a backpressured disk tee for the
  verbatim raw transcript, timeout/cancellation handling, optional safer
  prompt transports, optional verbose-diagnostic flags, and a strict
  `request.isContinue === true` gate for `-c`.
- [codex-cli.ts](src/runner/codex-cli.ts) — same `BackendRunner` contract;
  uses stdin transport and `codex exec --json --sandbox workspace-write`.
  Does not invent
  Claude-specific continuation or verbose-diagnostic behavior.
- [agy-cli.ts](src/runner/agy-cli.ts) — uses stdin transport and
  `--output-format stream-json`, continues with `--conversation <id>`, and
  caps unsupported `xhigh`/`max` effort values to `high` with a warning.
- [prompt-builder.ts](src/runner/prompt-builder.ts) — composes the phase
  prompt template, previous-iteration sidecar context, and per-phase
  metadata. Pure module.

### Parsers (`src/parser/`)

Each parser is hot-path-aware and avoids broad JSON parsing:

- [stdout-parser.ts](src/parser/stdout-parser.ts) — classifies output
  precedence: fatal signature → rate limit → non-zero exit → contract blocks
  → remaining issues.
- [audit-log-parser.ts](src/parser/audit-log-parser.ts) — parses the
  model-authored constitution audit block. Unknown event types and future
  schema versions are preserved by readers instead of dropped (CLAUDE.md
  hard rule).
- [rate-limit-reset-extractor.ts](src/parser/rate-limit-reset-extractor.ts) —
  extracts dynamic reset timestamps from plain and stream-json output
  without parsing common allow events on the hot path.
- [invocation-usage.ts](src/parser/invocation-usage.ts) — extracts numeric
  fields from stream-json `result` rows. Only finite non-negative numbers
  and integers are accepted; the host-owned `durationMs` remains canonical,
  CLI-reported duration recorded separately as `cliDurationMs`.
- [credit-error-detector.ts](src/parser/credit-error-detector.ts) — detects
  credit-exhaustion patterns for the watchdog polling layer.

### Audit and Logging (`src/audit/`, `src/lib/`)

Three distinct sinks with different sanitization postures:

| Sink | Path | Sanitized? | Read back via IPC? |
|---|---|---|---|
| Structured audit log | `<workspaceRoot>/.schegent/audit.log` | Yes (single point) | Yes (audit-tail projector) |
| Raw transcript | `<workspaceRoot>/.schegent/sessions/raw-<runId>.log` | No (intentional) | Never |
| Verbose diagnostics | `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-N/` | No (intentional, opt-in via `schegent.logging.verbose`) | Never |
| Runtime log | `<workspaceRoot>/.schegent/syslog` (configurable) | Yes (single point) | No (operator opens file) |
| Wake-up session log | `<globalStorageUri>/wakeup/sessions/<id>.log` | Sanitized at write AND read | Read-only via dedicated IPC |

Raw transcripts and verbose-diagnostic trees share one retention owner. It
groups artifacts by run, protects running and paused runs, and prunes only
complete inactive-run groups by age and total-byte budget. Sweeps run at
activation, after terminal runs, and after policy changes. The structured
audit log is outside the managed root and is never pruned by this service.

`EvidenceHealthMonitor` is the workspace-scoped owner for sink availability.
It projects normalized, paths-free health for structured audit, raw transcript,
and runtime log. Structured-audit failure is a run-control boundary: the phase
runner throws `RequiredEvidenceUnavailableError`, the run driver persists a
sanitized terminal failure, and auto-drain remains stopped. Raw-transcript and
runtime-log failures are availability-preserving but visibly degraded. Health
stays sticky until workspace wiring is recreated because a later successful
write cannot reconstruct missing evidence.

- [audit-log-writer.ts](src/audit/audit-log-writer.ts) — structured
  append-only writer. Every audit record passes through `SanitizedLogger`
  before reaching disk. Rotation/archive preserves history; existing
  records are never rewritten.
- [raw-transcript-writer.ts](src/audit/raw-transcript-writer.ts) —
  verbatim prompts, stdout, stderr, and exit status. Best-effort,
  intentionally unredacted, never surfaced through webview IPC. Subprocess
  chunks are backpressured into mode-`0600` stdout/stderr spools under the
  OS-managed temporary directory, streamed into the append-only transcript at
  invocation end, and removed; abandoned spools are scavenged by owner PID;
  the transcript therefore remains complete even when parser buffers truncate.
- [verbose-diagnostic-writer.ts](src/audit/verbose-diagnostic-writer.ts) —
  opt-in diagnostic payloads. Diagnostic write failures fold into phase
  warnings; they never fail a run.
- [schegent-gitignore.ts](src/audit/schegent-gitignore.ts) — writes a
  best-effort `.schegent/.gitignore` (containing `*`) the first time the
  runtime writers create `.schegent/`. Operator-managed ignore files are
  never overwritten.
- [verbose-diagnostic-path.ts](src/audit/verbose-diagnostic-path.ts) —
  pure path composer; also used by the canonical sidecar-path
  computation in `phase-runner.ts`.

Sanitization is centralized in [src/lib/logger.ts](src/lib/logger.ts).
`SECRET_PATTERNS` is the **single source of truth** redaction set;
pre-compiled case-sensitive and case-insensitive unions hot-path the
sanitize call. The set currently covers Anthropic / OpenAI keys
(`sk-`, `sk-ant-`, `sk-proj-`, `sk-svcacct-`), GitHub PATs (`ghp_`,
`github_pat_`), Slack tokens (`xox[baprs]-`), AWS long-lived keys
(`AKIA…`) and STS session keys (`ASIA…`), Google API keys (`AIza…`),
Google OAuth tokens (`ya29.…`), Stripe live/test/restricted keys
(`[rs]k_(live|test)_…`), GCP service-account JSON snippets, standalone
PEM private-key headers (RSA / DSA / EC / OPENSSH / PGP / ENCRYPTED),
`Bearer` and `Authorization` headers, `api_key` / `apikey` / `api-key`,
`x-api-key` / `X-API-Key`, JWTs (`eyJ…`), and generic
`SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY=value` env-style assignments.

[src/lib/runtime-log/](src/lib/runtime-log/) is the sanitized runtime log
sink. It registers on `SanitizedLogger`, re-reads runtime-log settings on
every emit (never cached on long-lived objects), and rotates by configured
size/generation policy (`schegent.logging.runtimeLogMaxBytes`,
`schegent.logging.runtimeLogMaxGenerations`).

### State (`src/state/`)

[workspace-state.ts](src/state/workspace-state.ts) is the memento-backed
serialization layer. The numeric schema version `STATE_SCHEMA_VERSION = 6`
lives in [src/contracts/state-schema.ts](src/contracts/state-schema.ts);
forward-only migrators handle 1→2 (feature 011), 2→3
([queue-state-migrator.ts](src/state/queue-state-migrator.ts)),
and 5→6 (feature 030). `setRun()` enforces paired invariants for manual
pause and retry state so the scheduler cannot persist one-sided
resumption data.

[history-store.ts](src/state/history-store.ts) and
[history-entry.ts](src/state/history-entry.ts) own the rolling history
window; [lock.ts](src/state/lock.ts) provides the workspace lock
acquisition wrapper.

[workspace-folder-picker.ts](src/state/workspace-folder-picker.ts) is the
single source of truth for the canonical workspace folder in multi-root
workspaces (feature 058). It memoizes `vscode.workspace.workspaceFolders[0]`
and lazily subscribes to `onDidChangeWorkspaceFolders` for cache
invalidation. All host code routes through `getCanonicalWorkspaceRoot()`;
direct `workspaceFolders[0]` reads are forbidden outside this module and
guarded by the lint regression at
[tests/lint/no-direct-first-workspace-folder.test.ts](tests/lint/no-direct-first-workspace-folder.test.ts).
[multi-root-warning.ts](src/state/multi-root-warning.ts) consumes the picker
and emits a one-shot activation-time toast plus a `multi-root.warning-shown`
audit event (payload: `folderCount`, `canonicalFolderName` — name only,
never `fsPath`). Suppressible per-workspace via
`schegent.multiRoot.suppressWarning` (`window`-scoped boolean).

[capability-trust-resolver.ts](src/state/capability-trust-resolver.ts) is
the host-only resolver for the three per-capability trust scopes
introduced in feature 059 (`schegent.trust.allowCustomPhases`,
`schegent.trust.allowCustomRetryConditions`,
`schegent.trust.allowPipelineOverrides`). Each call re-reads
`vscode.workspace.isTrusted` and the relevant setting via
`getConfiguration().inspect(key)` — no value is cached across
configuration or workspace-trust changes. Resolution follows a four-step
ladder: **workspace-trust ceiling → workspace-scope → user-scope →
default-allow**. The ceiling is never widened; user-scope cannot
override workspace-scope. The resolver subscribes to
`onDidGrantWorkspaceTrust` and `onDidChangeConfiguration` and kicks the
state projector so the webview reflects projection changes immediately.
Save handlers consult the resolver before mutating the catalog and emit
a `trust.capability-denied` audit event on denial (payload bounded to
closed enums + workspace basename).

### Queue (`src/queue/`)

Single active run for v1 (feature 029 + 030). The public registry in
[queue-registry.ts](src/queue/queue-registry.ts) stays compatible with
historical records, but the active scheduler in
[queue-manager.ts](src/queue/queue-manager.ts) uses one queue and one
in-flight run. `MAX_QUEUES = 1`. Legacy multi-queue helpers are
deprecated; reintroducing multi-queue requires a new state migration and
controller redesign (CLAUDE.md hard rule).

### Config (`src/config/`)

[settings-schema.ts](src/config/settings-schema.ts) is the typed
single-source-of-truth description of every Schegent setting (added by
spec 056 Track 3). [settings-schema-validator.ts](src/config/settings-schema-validator.ts)
validates host writes against the schema and is reused by parity tests
against `package.json contributions.configuration` and webview defaults.

[general-settings.ts](src/config/general-settings.ts) performs full-batch
validation before any write; partial-write failures attempt compensating
rollback of already-touched keys and return a rollback-specific failure
when rollback itself fails. [phase-precedence.ts](src/config/phase-precedence.ts)
is pure and UI-only — it computes projection metadata that is never
persisted or logged. [pipeline-config.ts](src/config/pipeline-config.ts)
and [pipeline-config-loader.ts](src/config/pipeline-config-loader.ts) own
the host-owned pipeline catalog.

### IPC and Webview (`src/contracts/`, `src/ui/sidebar/`, `src/ui/dashboard/`)

[contracts/sidebar-ipc.ts](src/contracts/sidebar-ipc.ts) defines every
host↔webview message shape. [ipc-validator.ts](src/ui/sidebar/ipc-validator.ts)
provides hand-rolled type guards for each payload.

[message-router.ts](src/ui/sidebar/message-router.ts) is the host IPC
router with a two-tier gate:

1. **Workspace-trust gate** — closed-fail; missing trust information is
   treated as untrusted.
2. **Primary-host gate** — `MUTATING_COMMANDS` is the pinned list of IPC
   commands that may mutate workspace state. Commands not on the list
   are read-only and may execute from secondary VS Code windows.

`MUTATING_COMMANDS` is pinned by
[tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts](tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts);
adding a mutating command without updating both lists is a hard rule
violation (CLAUDE.md). The four config-save commands
(`saveGeneralSettings`, `saveModels`, `savePhases`, `savePipelines`)
were added to the gate in spec 056 Track 1.

Individual command handlers live under
[src/ui/sidebar/commands/](src/ui/sidebar/commands/) (~45 files).
[sidebar-view-provider.ts](src/ui/sidebar/sidebar-view-provider.ts)
mounts the webview. [csp.ts](src/ui/sidebar/csp.ts) and
[html.ts](src/ui/sidebar/html.ts) generate the strict CSP HTML scaffold
(no `unsafe-inline`, no `unsafe-eval`, nonce-based scripts).

The dashboard panel is the operator-facing detail surface
([src/ui/dashboard/](src/ui/dashboard/)). Bridge, HTML scaffold, and
panel lifecycle are split into three files.

Webview projectors are pure — they consume already-snapshotted host
state and produce display-shaped output:
[state-projector.ts](src/ui/sidebar/state-projector.ts),
[queue-projector.ts](src/ui/sidebar/queue-projector.ts),
[phase-projector.ts](src/ui/sidebar/phase-projector.ts),
[history-projector.ts](src/ui/sidebar/history-projector.ts),
[monitor-projector.ts](src/ui/sidebar/monitor-projector.ts),
[audit-tail-projector.ts](src/ui/sidebar/audit-tail-projector.ts), and
[run-projector.ts](src/ui/sidebar/run-projector.ts).
[projector-memo.ts](src/ui/sidebar/projector-memo.ts) and
[projector-handle.ts](src/ui/sidebar/projector-handle.ts) provide
memoization plumbing.

### Wake-Up Scheduler and Headless (`src/wakeup/`, `src/headless/`)

[src/wakeup/](src/wakeup/) manages OS scheduler integration via four
platform installers under [src/wakeup/platforms/](src/wakeup/platforms/):
launchd (macOS), systemd-user (Linux), Task Scheduler (Windows), and a
generic cron fallback. [installer-registry.ts](src/wakeup/platforms/installer-registry.ts)
dispatches to the correct platform; [platform-detect.ts](src/wakeup/platform-detect.ts)
chooses it. [node-resolver.ts](src/wakeup/platforms/node-resolver.ts)
finds the Node binary at install time so detached invocations can
re-exec without depending on `PATH`.

[src/headless/wakeup-runner.ts](src/headless/wakeup-runner.ts) is the
non-extension-host entrypoint executed by the OS scheduler. It uses
allowlist env scrubbing (`PATH`, `HOME`, `LANG`, `LC_*`, `USER`,
`LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`), a closed `WAKEUP_SUPPORTED_MODELS`
registry, and a workspace-root contamination check that aborts if its
temp working directory resolves under any recorded workspace root.
Audit payloads from this path are paths-free.

`src/headless/` and `src/wakeup/` MUST NOT import `vscode`; the lint
regression `tests/lint/no-vscode-in-headless.test.ts` enforces this.

### Monitor, Telemetry, Watchdog

- [src/monitor/](src/monitor/) tracks subprocess progress, stdout/stderr
  lines, stalls, rate limits, cancellation, completion, and failure.
  Monitor failures never become workflow failures.
- [src/metrics/](src/metrics/) derives read-only dashboard metrics (task
  records, phase records, phase-type aggregates, cost timeline) from
  `.schegent/audit.log` on each `CMD_READ_METRICS` call. No new
  persistent storage; see spec 073.
- [src/telemetry/](src/telemetry/) samples local process resource usage
  for operator display. Must remain vscode-free; sensitive telemetry is
  not persisted. Platform shims live in [src/telemetry/platform/](src/telemetry/platform/).
- [src/watchdog/credit-watchdog.ts](src/watchdog/credit-watchdog.ts)
  polls credit/rate-limit state for delayed retry recovery, bounded by
  configured caps and dynamic reset timestamps. The dynamic reset
  backoff is never capped below the CLI-reported reset timestamp plus
  buffer (CLAUDE.md hard rule).

## Trust Boundaries

```text
        untrusted             trusted host                   trusted host
      ┌─────────────┐       ┌─────────────────┐            ┌──────────────┐
      │ webview IPC │──IPC─▶│ message-router  │──audit────▶│ audit writer │
      └─────────────┘       │ (gate + valid.) │            └──────────────┘
                            └────────┬────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
       attacker-influenced  │ phase-runner     │
       CLI stdout ────────▶│ sidecar reader   │── canonical path check
                            │ (canonical-path  │   path-outside-run-dir
                            │  containment)    │── missing-canonical-sidecar
                            └──────────────────┘
```

**Gates:**

- Workspace-trust gate at the IPC router boundary. Closed-fail on
  missing trust information.
- Primary-host gate via `MUTATING_COMMANDS` for state-mutating IPC.
- Webview CSP is nonce-based with no `unsafe-inline` or `unsafe-eval`.
- Phase-message sidecar canonical containment (spec 056 Track 2)
  rejects audit-reported paths that do not canonicalize to the
  host-computed canonical path under `<workspaceRoot>/.schegent/
  sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
  phase-message.env`. Rejection reasons: `path-outside-run-dir`,
  `missing-canonical-sidecar`.
- Operator-authored `retryCondition` expressions are parsed by a
  sandboxed DSL evaluator that accepts identifiers, signed numerics,
  comparison operators, and boolean combinators. Arithmetic, function
  calls, member access, and I/O are rejected at parse time.
- Subprocesses are spawned with `shell: false` and bounded buffers.
- Wake-up runner subprocesses receive only the allowlisted environment
  variables enumerated above.

For the full operator threat model see
[docs/security/threat-model.md](docs/security/threat-model.md).

## Schema Versions

| Schema | Constant | Current | Migrators |
|---|---|---|---|
| Workspace state | `STATE_SCHEMA_VERSION` ([state-schema.ts](src/contracts/state-schema.ts)) | `6` | 1→2 (011), 2→3 ([queue-state-migrator](src/state/queue-state-migrator.ts)), 3→4, 4→5, 5→6 (030) |
| Audit event envelope | `AUDIT_SCHEMA_VERSION` ([audit-events.ts](src/contracts/audit-events.ts)) | `2` | Additive event types do not bump the version (per the comment policy) |

State migrators are forward-only and tolerate old records. Versions
exceeding the runtime version raise an explicit "Update the extension"
error rather than silently overwriting. CLAUDE.md hard rule:
"Never bypass the v2 → v3 state migration or any later forward-only
migration."

## Extension Points

| Surface | Update |
|---|---|
| New backend runner | Implement [`BackendRunner`](src/contracts/backend-runner.ts); register in [`backend-runner-factory.ts`](src/runner/backend-runner-factory.ts); controller semantics unchanged. |
| New mutating IPC command | Add to `MUTATING_COMMANDS` in [`message-router.ts`](src/ui/sidebar/message-router.ts); add a payload validator in [`ipc-validator.ts`](src/ui/sidebar/ipc-validator.ts); update the pinned-list test; add a webview helper or button. |
| New phase tunable | Add to settings schema, package contributions, host catalog/precedence projection, IPC contract, and operations docs in one change. |
| New runtime sink | Use `SanitizedLogger` unless the threat model declares the sink intentionally unredacted and local-only. |
| New persisted state field | Add a forward-only migrator; ensure parser tolerance for old records; bump `STATE_SCHEMA_VERSION` if shape changes; update docs. |
| New audit event type | Define in [`audit-events.ts`](src/contracts/audit-events.ts); readers preserve unknown types (CLAUDE.md hard rule). |
| New secret pattern | Add to `SECRET_PATTERNS` in [`logger.ts`](src/lib/logger.ts) — adding to the array auto-extends the precompiled union. Do not fork the redaction set. |

## Reliability Invariants

- Workspace locks are released through the lock manager; retained locks are intentional pause exits only.
- Phase timeout, cancellation, fatal signatures, rate limits, and parser failures map to explicit outcomes.
- A clean token from truncated parser buffers fails closed as a terminal failure because fatal evidence may exist in the discarded middle.
- Runtime artifact writes are best-effort unless the artifact is the structured audit record required for evidence.
- The controller owns `WorkflowRun` mutation. Webview and services request transitions through host commands or controller methods.
- Settings writes are validated before mutation and attempt rollback on partial failure.
- Queue removal is not rolled back by session-cleanup I/O failure.
- The audit log is append-only across every code path; task and phase deletion never erase `.schegent/audit.log`.

## Performance Notes

- Hot parsers avoid broad JSON parsing. `rate-limit-reset-extractor` filters common allow events before parse; `invocation-usage` parses only short lines containing both `"type"` and `"result"`.
- Runner parsing buffers are bounded head/tail windows so malformed or noisy CLI output cannot grow memory without limit; the independent raw-transcript tee applies disk-stream backpressure.
- The sanitization hot path uses two precompiled regex unions (case-sensitive and case-insensitive) — each `SanitizedLogger.sanitize()` call costs two regex passes, not N (where N is the number of patterns).
- Snapshot projection and phase-log display projection are pure and testable. The UI consumes already-projected state rather than walking disk state or live controller structures.
- Performance budgets are pinned in `tests/perf/budgets.json` (feature 049).

## Verification Surface

The pre-merge gate is `npm run ci` from `repo/`. It runs host and webview
typechecks, lint, host unit/integration tests, webview tests,
deterministic E2E tests, production builds, and VS Code integration
smoke tests. Targeted tests (`npx vitest run <pattern>`) are useful while
iterating, but the full gate is the release-level signal.

`.github/workflows/`:

- `pr.yml` — fast PR gate: typecheck + lint + unit + build.
- `ci.yml` — full gate on a different trigger.
- `codeql.yml` — security scanning.
- `full-gate.yml` (added by spec 056 Track 6) — scheduled / manual; runs
  the deterministic E2E suite and the extension-host integration suite
  before release-tag merges. `RELEASE.md` documents the release gate.

Doc-drift lint regressions under `tests/lint/` enforce that operations
docs do not reference removed symbols and that documented defaults
match package contributions.
