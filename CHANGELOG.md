# Changelog

All notable changes to **Schegent** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry groups changes under the standard headings (`Added`,
`Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) followed by a
short note describing the user-visible impact. Internal refactors with
no operator-visible effect are intentionally omitted.

---

## [Unreleased]

Changes that have landed on the default branch but have not yet shipped
in a tagged release. This section is empty between releases; entries
land here first and graduate into a version section at release time.

---

## [0.2.0] — 2026-06-07

### Added

- Enqueue/start separation: a start-mode chooser, scheduled starts, and an
  `idle-pending` queue lifecycle so newly enqueued work waits for an explicit
  start (065).
- Persistent **System** tab with structured metadata and a CLI command block
  (068).
- Live Mode auto-follow of the active run (067).
- **Clean All** with a universal confirmation gate (063).
- Dual-release host abstraction, shared contract-schema generation, and a Rust
  desktop-prototype shell (064, 066, 068).
- Tabbed Active Queue / Recent Runs layout; click a task card to select it in
  the Activity Feed.
- `claude-opus-4-8` in the model registries.

### Changed

- The per-phase CLI invocation timeout is an idle timeout (resets on output)
  rather than a wall-clock cap.

### Fixed

- A phase whose CLI completed successfully but did not exit is no longer
  reported as a timeout failure: the runner detects result-envelope completion
  and grace-terminates the lingering process, and the phase runner reclassifies
  a timed-out-but-complete invocation as success, so the queue advances to the
  next task (030 BUG-002).
- Rate-limit responses are rejected on a successful CLI exit; out-of-credits
  backoff is guarded against past reset timestamps (065 BUG-008, 066).
- Unified queue rendering and reorder semantics (065 BUG-007/009).

---

## [0.1.0] — 2026-05-18

Initial public release of the Schegent extension.

### Added

#### Core orchestration

- Single-queue, single-in-flight execution model with an operator-visible
  pending list, paused list, and history. Exactly one workspace lock
  per workspace folder; paused runs retain the lock until resumed or
  cancelled.
- Two built-in pipelines shipped in-tree:
  - `speckit-new-feature` — seven phases: `speckit-specify`,
    `speckit-clarify`, `speckit-plan`, `speckit-tasks`,
    `speckit-analyze`, `speckit-implement`, `finalize`.
  - `speckit-bugfix` — five phases: `bugfix-report`, `bugfix-patch`,
    `bugfix-verify-pre`, `bugfix-implement`, `bugfix-verify-post`.
    Verify failures pause the run via `phase-paused`; resume re-invokes
    the same verify phase rather than silently advancing.
- Frozen pipeline snapshot — settings changes mid-run apply to the
  next enqueued task; the in-flight run is never retargeted.
- Multi-window safety — only the primary host (first VS Code window
  to activate against a workspace) mutates state. Secondary windows
  are read-only and surface mutation attempts as `not-primary-host`
  rejections.
- Workspace-trust gating — the extension is inert in untrusted
  workspaces and refuses to spawn any subprocess.

#### Backends

- `BackendRunner` abstraction with two in-tree adapters:
  - `claude` (default) — spawns the Claude CLI; supports
    context-preserving retries via `-c` / `--continue`.
  - `codex` — spawns the Codex CLI in single-shot
    `exec --no-stream` mode; prompt is piped over stdin.
- Backend selection via `schegent.backend.runner` (application scope).
  See [`docs/operations/backends.md`](docs/operations/backends.md) for
  the contract any backend must honor.

#### Phase customization

- Per-phase **Effort** and **Model** dropdowns on every row of the
  Pipeline Builder. Both default to **Inherit**. Workspace-layer
  overrides shadow user-layer values for the effective run-time
  choice but do not block a user-layer save; an inline
  "shadowed by workspace" badge surfaces the relationship.
- Per-field merge across four precedence layers
  (built-in → user → workspace → per-run overrides) so an override on
  one field never clobbers untouched fields from a lower layer.
- Custom phases via `schegent.phases` and custom pipelines via
  `schegent.pipelines` — they run through the same audit path as the
  built-ins.
- Operator-defined retry-condition expressions (`retryCondition`)
  evaluated by a sandboxed DSL. The grammar admits identifiers,
  signed numerics, comparison operators (`>`, `>=`, `<`, `<=`,
  `==`, `!=`), boolean combinators (`and`/`&&`, `or`/`||`,
  `not`/`!`), and parentheses. Arithmetic, function calls, member
  access, and I/O are rejected at parse time.
- Phase breakpoints — pause a run before a named phase to review and
  intervene. Breakpoints are consumed on fire (single-shot per
  occurrence); multiple distinct breakpoints are supported.

#### Reliability and recovery

- Aggressive pause — clicking **Pause** records the
  `queue-pause-requested` event, transitions the run state, and only
  then issues SIGTERM with a 2s SIGKILL escalation. The audit record
  is updated before the kill so it never lies about what was running.
- Rate-limit handling — parses Anthropic reset hints from the CLI
  output and schedules a dynamic backoff bounded by a 5-attempt cap
  and a 60-minute fallback wait. Successful recoveries record
  `retry-recovered`; manual overrides record `retry-manual`.
- Operator-paused queue overrides cascade-paused — when both a
  cascade pause and an operator pause are in effect, the operator
  intent wins on resume.
- Fatal signatures — a two-layer registry:
  - **Code-resident floor** (immutable) of known-unrecoverable
    signatures.
  - **Operator-additive** entries via `schegent.fatalSignatures`.
  - Scan order is built-ins-first; the `fatal-signature-matched`
    audit event records the matched substring, the `source`
    (`built-in` or `operator-defined`), and the `where` (`stdout`
    or `stderr`).

#### Observability

- Structured audit log at `<workspaceRoot>/.schegent/audit.log`
  (JSONL). Append-only, sanitized, paths-free for sensitive
  locations, and rotated by both size
  (`schegent.audit.rotation.sizeMB`, default 5 MB) and age
  (`schegent.audit.rotation.maxAgeDays`, default 30 days). Rotations
  and retention events are themselves audit events.
- Raw transcript at `<workspaceRoot>/.schegent/sessions/raw-<runId>.log`
  — local-only, unredacted; written but never read back by the host
  or webview.
- Verbose diagnostics (opt-in via `schegent.logging.verbose`) — per
  invocation, the host adds `--debug-file`, `--output-format
  stream-json`, and `--verbose` and tees the resulting streams to
  `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`:
  `debug.json`, `stream.jsonl`, `verbose.log`. Mid-run toggling
  applies to the next phase boundary; the in-flight phase is not
  retroactively re-captured.
- Runtime debug log mirrors the Output channel to disk for tail and
  grep. Configurable level (`schegent.logging.runtimeLogLevel`),
  path (`schegent.logging.runtimeLogFilePath`), rotation size
  (`schegent.logging.runtimeLogMaxBytes`, 64 KiB–1 GiB), and
  generation count (`schegent.logging.runtimeLogMaxGenerations`,
  0–20). Suppression on I/O failure with operator-visible
  recovery: re-save the runtime-log settings (even with the same
  values) to clear the suppression map.

#### Wake-up scheduler

- Per-user OS-native scheduler entry to keep the Claude rolling
  allocation warm during unattended runs.
  - macOS: launchd `LaunchAgent`.
  - Linux: systemd-user timer with cron fallback.
  - Windows: Task Scheduler entry under `\Schegent\Wakeup`.
- Two cadence modes:
  - `chronological` — fixed `HH:MM` 24-hour local time
    (`schegent.wakeUp.chronologicalTime`, default `04:00`).
  - `periodic` — `Every Nm` or `Every Nh`
    (`schegent.wakeUp.periodicInterval`, default `Every 4h`).
- Environment scrubbing at runner invocation — only an allowlist
  reaches the subprocess: `PATH`, `HOME`, `LANG`, `LC_*`, `USER`,
  `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`.
- Sandbox cwd — the wake-up runner aborts if its temp working
  directory resolves under any recorded workspace root, preventing
  accidental writes to operator code paths.
- 60-second subprocess timeout to bound the cost of a stuck runner.

#### Productivity

- Auto-compact override — `schegent.claude.autoCompactPctOverride`
  (integer 1–100, or `null` to clear) is exported as
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for every Claude CLI subprocess.
  Read on every `PhaseRunner.run()` entry; mid-run toggles apply to
  the next invocation.
- Context-preserving retries — Claude-backend retries can pass
  `-c` / `--continue` so Claude resumes the prior context rather
  than starting fresh. Not yet supported on the Codex backend.

#### Operator UI

- VS Code sidebar with: CLI status header, in-flight card, pending
  queue with drag-to-reorder, paused list, history, and the live
  phase log feed (one phase at a time, with tool-call and message
  rendering).
- Dashboard webview with three peer routes:
  - **Operations** — live queue, monitor pill, history, and the
    collapsible **Model Catalog**.
  - **Pipeline Builder** — phases editor and pipelines composition.
  - **Settings** — `General` and `Fatal Signatures` sub-tabs.
- All `schegent.*` scalar saves route through a single shared helper
  (`save-general-settings.ts`) backed by a host-validated batched
  IPC. The host validates the entire batch before writing anything
  and uses compensating rollback to restore earlier workspace-scope
  values if a later `config.update()` call fails. Concurrent saves
  are correlated by UUIDv4 and never cross-resolve.
- Seventeen commands contributed to the VS Code command palette;
  see [`docs/reference/commands.md`](docs/reference/commands.md).

### Security

- Single sanitization surface — every operator-visible sink (audit
  log, runtime log, Output channel, phase log feed, wake-up session
  log) passes through the same redaction set defined once in the
  codebase. A secret stripped from one sink is stripped from all of
  them.
- Metadata-only audit by default — the structured audit log records
  counts, IDs, and selection tuples rather than file paths or raw
  payloads. The list of workspace roots appears only as `rootCount`;
  the phase log feed selection appears as a tuple, not as a path.
- TTL-bound context fragments — verbose diagnostics and raw
  transcripts are workspace-scoped and tied to the run that produced
  them. The optional task-deletion flow removes the per-run session
  tree on demand. The structured audit log is never modified by
  task deletion; `task-removed` is itself an audit event.
- Defense-in-depth re-sanitization on read for the wake-up session
  log.
- No internal MCP boundary tool — operator interaction is mediated
  exclusively by VS Code commands and the sidebar UI; no internal
  state is exposed through an MCP boundary.

### Known limitations

- Codex backend does not yet support context-preserving retries
  (`-c` / `--continue`). Retries on the Codex backend start a fresh
  context.
- The wake-up scheduler is per-user; multi-user machines need a
  separate entry per user account.
- The audit log is intentionally paths-free for sensitive locations.
  When investigating an issue tied to a specific path, correlate
  through the runId and read the local raw transcript.
- Verbose diagnostics do not rotate — they accumulate per run. Use
  the task-deletion flow to clean them up or remove the per-run
  directory manually.

---

[Unreleased]: https://github.com/lehoa1806/schegent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lehoa1806/schegent/releases/tag/v0.1.0
