# Backend Runners

Schegent drives every phase invocation through a single abstraction:
`BackendRunner` ([src/contracts/backend-runner.ts](../../src/contracts/backend-runner.ts)).
The controller, audit pipeline, monitor, telemetry sampler, and live-activity
projector are all backend-agnostic — they consume the `BackendRunner`
interface only. Feature 034 Item 050 added a factory + a second adapter so
the abstraction is provably reusable.

## Available backends

| `schegent.backend.runner` | Adapter | Notes |
|---|---|---|
| `claude` *(default)* | [src/runner/claude-cli.ts](../../src/runner/claude-cli.ts) | Spawns the Claude CLI with prompt-transport probing (`--prompt-file` → `--prompt-stdin` → `-p` fallback). Supports `-c` (continue) for context-preserving retries. |
| `codex` | [src/runner/codex-cli.ts](../../src/runner/codex-cli.ts) | Spawns `codex exec --no-stream`. Prompt is piped over stdin (never appears in argv). `-c` (continue) is **not** supported yet — retries reuse the existing fresh-context dispatch. |
| `agy` | [src/runner/agy-cli.ts](../../src/runner/agy-cli.ts) | Spawns the Agy CLI via `--output-format stream-json`. Uses `--conversation` for context-preserving retries. Maps `xhigh`/`max` effort levels down to `high` (with a log warning). |

Switch backends from the VS Code settings UI (`Schegent: Backend: Runner`)
or by editing `package.json` / `.vscode/settings.json`:

```json
{
  "schegent.backend.runner": "codex",
  "schegent.agy.path": "/usr/local/bin/agy"
}
```

Changes take effect at the next extension activation. The factory at
[src/runner/backend-runner-factory.ts](../../src/runner/backend-runner-factory.ts)
resolves unknown values to `'claude'` and logs a `WARN` (`backend-runner-factory:
unknown schegent.backend.runner ...`) so a typo never breaks activation.

## Per-phase runner selection and probing

Since feature 074, runners can be selected dynamically **per-phase** using the `runner` field on the `PhaseDef` object in `pipeline-config.json` (or via the UI Pipeline Builder).

Precedence for runner selection per phase:
1. Per-phase `runner` explicitly defined
2. Global `schegent.backend.runner` setting
3. Fallback to `'claude'`

A session context reset occurs across runner transitions (e.g., if Phase 1 uses `claude` and Phase 2 uses `agy`, the conversation history is NOT shared across the boundary).

**CLI Probing**: Schegent implements fast-fail behavior by actively probing the availability of all required CLI binaries _before_ starting the first phase in a pipeline. If a runner fails this probe, a `runner-probe-failed` audit event is emitted and the pipeline aborts immediately.

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
   each capped at the runner's buffer limit (currently 4 MiB).
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

## Adding a third backend

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
6. Run `npm run ci`. The factory, controller, monitor, telemetry, and
   audit pipeline should all remain untouched — *that is the point of the
   abstraction*.

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
