# Backend operations

Schegent supports three local CLI adapters. Claude is the default backend. Claude and Agy run with approval prompts disabled and therefore act without asking; Codex is the only adapter with a Schegent-selected sandbox mode.

<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: package.json -->

## Capability table

| Runner | Executable setting | Invocation prefix | Permission posture | Continuation |
|---|---|---|---|---|
| `claude` *(default)* | `schegent.cli.path` (`claude`) | `--dangerously-skip-permissions [--resume <id> \| -c] -p [--model <model>] [--effort <effort>] --output-format stream-json --verbose [--debug-file <path>]` | CLI approval prompts are off; Schegent supplies no OS-enforced bound. | `--resume <id>` for a known session; `-c` only for continuation without an ID. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/config/cli-path-accessor.ts --> |
| `codex` | `schegent.codex.path` (`codex`) | `exec --json --sandbox workspace-write` | OS-enforced `--sandbox workspace-write`; the workspace is writable and `.git` remains read-only. | Request continuation fields are ignored. <!-- Source: src/runner/codex-cli.ts --><!-- Source: src/config/cli-path-accessor.ts --> |
| `agy` | `schegent.agy.path` (`agy`) | `--dangerously-skip-permissions [--conversation <id>] -p - [--model <model>] [--effort <effort>] --output-format stream-json` | CLI approval prompts are off; Schegent supplies no OS-enforced bound. | `--conversation <id>` when reuse/continuation has an ID; no flag-only fallback. <!-- Source: src/runner/agy-cli.ts --><!-- Source: src/config/cli-path-accessor.ts --> |

Model arguments are `--model <id>` for all three adapters. Claude and Agy use `--effort <level>`; Codex uses `--config model_reasoning_effort=<level>`. Agy rejects unsupported `xhigh` and `max` effort values before spawn.

<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

## Select and configure a runner

Set `schegent.backend.runner` to `claude`, `codex`, or `agy`. The default is `claude`. A blank, missing, or non-string value silently selects that default; an unknown nonblank string selects the default and emits a warning. The runner choice is cached when the workspace-bound Extension Host activates, so reload that host after changing it. Binary paths are read dynamically, so changing `schegent.cli.path`, `schegent.codex.path`, or `schegent.agy.path` does not require a reload.

<!-- Source: package.json -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/config/cli-path-accessor.ts -->
<!-- Source: src/extension.ts -->

There is no repository-declared supported-version band for any backend CLI and no runtime version rejection. Availability probing establishes only that the configured executable can complete `--help`; it is not compatibility certification.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: package.json -->

## Environment forwarding

`schegent.cli.environmentMode` defaults to `allowlist`. In that mode, the process receives required path/home/temp/locale bootstrap variables plus the names in `schegent.cli.environmentAllowlist`; values are read from the extension-host environment at spawn time and are not stored in settings. `minimal` sends only Schegent-controlled variables. `inherit` preserves the ambient extension-host environment. The legacy `schegent.cli.inheritEnvironment: false` forces `minimal`.

<!-- Source: package.json -->
<!-- Source: src/runner/spawn-env.ts -->

The effective environment policy is also cached during workspace-bound activation. Reload the Extension Host after changing `schegent.cli.environmentMode`, `schegent.cli.environmentAllowlist`, or `schegent.cli.inheritEnvironment`.

<!-- Source: src/extension.ts -->

Ordinary Phase invocations, probes, and pre-compaction calls receive an explicit environment policy. The credit watchdog currently supplies none, so `buildSpawnEnv` inherits the full extension-host environment for that internal `/status` call.

<!-- Source: src/controller/session-compactor.ts -->
<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: src/watchdog/credit-watchdog.ts -->
<!-- Source: src/runner/spawn-env.ts -->

## Availability and model discovery

Every availability probe runs the dynamically resolved executable with `--help`, `shell: false`, the canonical workspace root as `cwd`, hidden Windows process mode, a 64 KiB retained-output cap, and a normalized 1–30-second timeout that defaults to 5 seconds. Timeout cleanup sends TERM and escalates to KILL after 2 seconds.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: package.json -->

Claude and Codex report no discovered models because their adapters expose no listing command. Agy additionally runs `models` and parses its bounded stdout. The operator's `schegent.models` catalog is separate configuration, not probe output.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: package.json -->

Probe failure causes exposed to the host are `not-found`, `not-executable`, `non-zero-exit`, `timed-out`, and `unknown`. Configured paths, stderr, environment values, and raw errors do not enter the webview result.

<!-- Source: src/services/backend-capability-service.ts -->

## Contract every adapter must honor

1. One `invoke()` represents one non-interactive subprocess and resolves when it exits or is terminated.
2. The prompt travels over stdin; it is not appended to argv.
3. `shell: false` is mandatory, with `cwd` set to the workspace root and an explicitly built environment for ordinary Phase execution.
4. Stdout and stderr use bounded `ZippedStreamBuffer` instances with observable truncation.
5. The timeout is idle-based: output resets it unless sink backpressure has paused the stream.
6. Cancellation observes the request's abort signal. Timeout or cancellation sends SIGTERM and escalates to SIGKILL after 2 seconds.
7. Monitor events identify the Run and report start, chunks, and exit. Hook errors do not control the child.
8. Retry and rate-limit policy remain in the controller; adapters return raw invocation outcomes.
9. Adapters do not own operator-visible sanitization or structured audit writes; those occur at the Phase runner/logger boundary.

<!-- Source: src/contracts/backend-runner.ts -->
<!-- Source: src/runner/process-lifecycle-runner.ts -->
<!-- Source: src/runner/zipped-stream-buffer.ts -->
<!-- Source: src/controller/phase-runner.ts -->

## `sideEffects` and runner eligibility

The Phase `sideEffects` declaration does not restrict a child process. It drives the mutation plan, consent, and rollback checkpoint. A Phase declaring `sideEffects: git` is refused on Codex and must use a Git-capable runner because Codex's workspace-write sandbox keeps `.git` read-only.

<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

## Failure diagnostics

Use the Phase lifecycle audit fields (`exitCode`, `timedOut`, `killed`, and stream truncation metadata), then inspect the sanitized runtime log. Raw transcripts are local and unredacted. Claude alone currently writes adapter-specific verbose diagnostic artifacts when verbose logging is enabled.

<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/runner/claude-cli.ts -->
