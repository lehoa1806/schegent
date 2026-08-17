# Backend Runners

Schegent drives every phase invocation through a single abstraction:
`BackendRunner` ([src/contracts/backend-runner.ts](../../src/contracts/backend-runner.ts)).
The controller, audit pipeline, monitor, telemetry sampler, and live-activity
projector are all backend-agnostic — they consume the `BackendRunner`
interface only. A lazy `BackendRunnerRegistry` constructs adapters on first
use and cancels every cached adapter during extension deactivation.

## Available backends

| `schegent.backend.runner` | Adapter | Notes |
|---|---|---|
| `claude` *(default)* | [src/runner/claude-cli.ts](../../src/runner/claude-cli.ts) | Spawns the Claude CLI with prompt-transport probing (`--prompt-file` → `--prompt-stdin` → `-p` fallback). Supports `-c` (continue) for context-preserving retries. |
| `codex` | [src/runner/codex-cli.ts](../../src/runner/codex-cli.ts) | Spawns `codex exec --json --sandbox workspace-write`. Prompt is piped over stdin (never appears in argv). Model uses `--model`; effort uses `--config model_reasoning_effort=<level>`. Session continuation is not supported. |
| `agy` | [src/runner/agy-cli.ts](../../src/runner/agy-cli.ts) | Spawns the Agy CLI via `--output-format stream-json`. Uses `--conversation` for context-preserving retries. Maps `xhigh`/`max` effort levels down to `high` (with a log warning). |

## Supported CLI versions

The blocking gate qualifies adapter argv, parsing, outcome precedence, session
ownership, truncation, and safety invariants against deterministic fixtures.
The installed CLI version is recorded separately so operators can compare a
failure report with the latest qualified band.

| Backend | Supported version band | Last qualified | Qualification baseline |
|---|---|---|---|
| Claude Code | `>=2.1.220 <2.2.0` | 2026-08-01 | Installed `2.1.220`; adapter/unit/eval/full-CI gate |
| Codex CLI | `>=0.142.5 <0.143.0` | 2026-08-01 | Installed `0.142.5`; adapter/unit/eval/full-CI gate |
| Agy CLI | `>=1.1.9 <1.2.0` | 2026-08-01 | Installed `1.1.9`; adapter/unit/eval/full-CI gate |

Schegent does not currently reject an unqualified version at runtime. Versions
outside these bands are best-effort: run `<cli> --version`, attach that output
to any report, and complete the deterministic adapter/evaluation gate before
expanding a supported band. Authenticated live-provider calls remain opt-in;
they are never part of a pull-request gate and must use isolated credentials.

Backend executable probes do not prove provider reachability. Cloud-backed
phase execution may still require network access, valid credentials, quota,
and working proxy/DNS/TLS configuration. Schegent is local-first rather than
an offline-execution promise; see
[Local-first does not mean offline execution](../concepts/local-first-not-offline.md)
for the queue-only degraded-mode boundary and future capability-discovery
requirements.

Switch backends from the VS Code settings UI (`Schegent: Backend: Runner`)
or by editing `package.json` / `.vscode/settings.json`:

```json
{
  "schegent.backend.runner": "codex",
  "schegent.codex.path": "/usr/local/bin/codex",
  "schegent.agy.path": "/usr/local/bin/agy"
}
```

The global backend selection takes effect at the next extension activation;
the three CLI path settings are read again for every probe and invocation.
`schegent.backend.probeTimeoutSeconds` bounds availability and model-discovery
commands to an integer from 1–30 seconds (default 5). Changing that setting or
any backend path triggers a new background capability scan without blocking
extension activation.
The factory at
[src/runner/backend-runner-factory.ts](../../src/runner/backend-runner-factory.ts)
resolves unknown values to `'claude'` and logs a `WARN` (`backend-runner-factory:
unknown schegent.backend.runner ...`) so a typo never breaks activation.

## Per-phase runner selection and probing

Since feature 074, runners can be selected dynamically **per-phase** using the `runner` field on the `PhaseDef` object in `pipeline-config.json` (or via the UI Pipeline Builder).

Precedence for runner selection per phase:

1. Per-phase `runner` explicitly defined
2. Global `schegent.backend.runner` setting
3. Fallback to `'claude'`

Five built-in phases are an intentional exception to inheritance.
`speckit-specify`, `specify-brainstorm`, and `superpowers-implement` invoke
mandatory branch/worktree creation; `finalize` and `superpowers-review-close`
commit or change branches.
They are pinned to `claude`. Codex runs under `workspace-write`, which protects
`.git` from modification. Overrides for these phase IDs must set `runner`
explicitly to `claude` or `agy`; the Pipeline Builder disables Codex/Inherit
and the host rejects incompatible configuration or legacy run snapshots before
invoking a CLI.

When a run starts, every inherited runner choice is resolved and persisted in
the immutable pipeline snapshot, together with the run's effective global
backend. Changing the global backend later affects new runs only. Partially
migrated snapshots use their persisted run-level backend; records old enough to
lack both phase and run-level runner data conservatively use Claude.

A session context reset occurs across runner transitions (e.g., if Phase 1
uses `claude` and Phase 2 uses `agy`, the conversation history is not shared
across the boundary). Legacy session records without an owning runner kind
fail closed and are not resumed.

Before the first phase, Schegent probes every effective backend kind used by
the pipeline with that backend's current CLI path. A failed
probe terminates the run, emits `runner-probe-failed`, updates queue/history
state, and surfaces the blocking error to the operator.

The host-only `BackendCapabilityService` owns these probes. It does not
construct invocation runners, preserving lazy runner creation. Every probe uses
`shell: false`, the same cwd/environment policy as phase invocations, a 64 KiB
capture cap, and TERM→KILL timeout cleanup. Overlapping refreshes use generation
tokens, so a late older scan cannot replace a newer result.

The sidebar snapshot projects live `availableBackends` and per-backend
`availableModels`. Unavailable backends always have an empty model list. Agy
models come from bounded `agy models` output, preserving first-seen CLI order,
deduplicating entries, rejecting identifiers over 128 characters, and limiting
the result to 200 models. Claude and Codex use code-resident fallback registries
because their qualified CLI surfaces do not expose an equivalent model-list
command.

## Operator Ping

The Settings view includes a **Backend Health** section with one Ping action
for Claude, Codex, and Agy. Ping is a local executable health check; it does not
prove provider authentication, quota, or network reachability. An active
workspace is required because each attempt is written to that workspace's
canonical structured audit log.

Only one Ping can run in an extension host at a time. Its timeout uses
`schegent.backend.probeTimeoutSeconds` (1–30 seconds, default 5). Results expose
only a generic status, timing/latency, and a numeric exit code when applicable.
Failure causes are `not-found`, `not-executable`, `non-zero-exit`, `timed-out`,
or `unknown`; configured paths, environment values, stdout/stderr, and stack
traces are never returned to the webview or written to the `backend-ping`
audit payload.

## Contract every backend MUST honor

A backend adapter MUST satisfy every clause in the
[BackendRunner contract](../../src/contracts/backend-runner.ts). The
controller assumes these invariants and will *not* tolerate divergence.

1. **Single-shot, non-interactive.** Each `invoke()` spawns the backend
   once, waits for termination, and resolves with a single
   `RawInvocationOutput`. No long-running daemons, no REPLs, no
   conversational state held outside the runner.
2. **No `shell: true`.** Every adapter MUST refuse `shell: true` in its
   `safeSpawn` guard. Shell expansion of a prompt body is a remote-code
   execution surface. The grep regression in `tests/lint/` enforces this
   for the existing adapters; new adapters MUST mirror the pattern.
3. **Output cap with truncation observability.** Stdout and stderr are
   each capped at the runner's buffer limit (currently 64 MiB).
   `stdoutTruncated` / `stderrTruncated` MUST flip `true` the first time
   the cumulative byte counter exceeds the cap and stay sticky for the
   remainder of the invocation (feature 042).
4. **Timeout discipline.** When `request.timeoutMs` elapses, the runner
   MUST terminate the subprocess via SIGTERM, escalate to SIGKILL after
   `SIGKILL_DELAY_MS` (2s today), and set `timedOut: true` on the result.
5. **Cancellation discipline.** When `request.cancellationSignal` fires,
   the runner MUST terminate the subprocess the same way and set
   `killed: true`. The signal is observed both at registration (in case it
   is already aborted) and via `addEventListener('abort', ...)`.
6. **Monitor sidecar.** The runner MUST emit `started` (with `pid`),
   `stdout-chunk` / `stderr-chunk` (one event per chunk), and `exited`
   (with `exitCode`, `signal`, `killed`, `timedOut`) to the
   `MonitorSidecarHook`. Hook errors MUST NOT propagate into runner
   control flow.
7. **No retry policy.** Retry, backoff, and rate-limit handling all live
   in the controller. The runner reports raw termination outcomes only.
8. **No sanitization, no audit writes.** The runner reports raw bytes.
   Sanitization happens at the
   [SanitizedLogger](../../src/lib/logger.ts) boundary in
   [PhaseRunner](../../src/controller/phase-runner.ts);
   audit writes happen via
   [AuditLogWriter](../../src/audit/audit-log-writer.ts). `SECRET_PATTERNS`
   stays the single source of truth (CLAUDE.md hard rule).
9. **Cleanup is best-effort.** Temp files (e.g., prompt files) MUST be
   removed in a `finally` block, but failures MUST NOT throw — the OS
   reaps `os.tmpdir()` eventually.

## Adding another backend

1. Implement `BackendRunner` in `src/runner/<your>-cli.ts`. Mirror the
   Claude or Codex adapter structure exactly (`safeSpawn` guard, byte
   accounting, terminate helper, monitor hook emission).
2. Add unit tests in `tests/unit/runner/<your>-cli.test.ts` covering at
   minimum: argv shape, prompt transport, stdout/stderr capture,
   truncation flag, timeout, cancellation, monitor events, and the
   `cancelActive()` toggle.
3. Extend the `BackendRunnerKind` union and `SUPPORTED_BACKENDS` tuple in
   [src/runner/backend-runner-factory.ts](../../src/runner/backend-runner-factory.ts),
   then add a `case` to `createBackendRunner`.
4. Add the new value to the `enum` of `schegent.backend.runner` in
   `package.json`. Update this doc.
5. Audit against [docs/security/threat-model.md](../security/threat-model.md):
   any new backend MUST honor the headless / append-only / sanitization
   invariants.
6. Extend per-phase validation and the Pipeline Builder runner enum, then run
   `npm run ci`.

## Diagnostics

When a phase fails on a non-default backend, capture:

- `schegent.backend.runner` value from the workspace settings JSON
- The `phase-end` audit entry's `exitCode`, `stdoutTruncated`,
  `stderrTruncated`, `timedOut`, `killed` fields
- The runtime log (`<workspaceRoot>/.schegent/syslog` by default) — every
  runner write is structured + sanitized
- The verbose diagnostic sink under `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/...`
  if `schegent.logging.verbose === true` (Claude adapter only today)
- For Codex specifically: the adapter does not honor
  `request.verboseDiagnostics`. The plan to add Codex equivalents is
  tracked in the next architecture refactoring pass.
