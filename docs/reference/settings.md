# Settings Reference

Every setting Schegent contributes lives under the `schegent.*` namespace in your VS Code `settings.json`. This page documents every key, its type, default, scope, and validation.

This is a reference, not a tutorial. If you are looking for guided configuration walkthroughs, start in [Installation](../getting-started/installation.md) and follow the per-feature pages in [features/](../README.md#features).

## Scope quick-reference

Each setting carries a `scope`:

| Scope | Meaning |
|---|---|
| `application` | Settings that apply across every VS Code window. Stored in user-global `settings.json`. |
| `resource` | Settings that can be overridden per workspace folder. Stored in user or workspace `settings.json`. |
| `window` (default) | Settings tied to the VS Code window; rarely used by Schegent. |

A `resource`-scoped value in your workspace overrides the same key in your user settings. An `application`-scoped value cannot be overridden per workspace.

## CLI and backend

### `schegent.cli.path`

- **Type:** `string`
- **Default:** `"claude"`
- **Scope:** `application`

Path to the Claude CLI binary. The default `"claude"` works if the binary is on your shell's `PATH`. If your CLI lives elsewhere, set an absolute path:

```jsonc
{ "schegent.cli.path": "/opt/anthropic/bin/claude" }
```

### `schegent.cli.inheritEnvironment`

- **Type:** `boolean`
- **Default:** `true`
- **Scope:** `application`

When enabled, Schegent backend CLI processes inherit the VS Code extension-host environment and then overlay Schegent-controlled variables such as `SCHEGENT_PHASE`, `SCHEGENT_ITERATION`, and optional Claude auto-compact overrides. Set to `false` in hardened environments to spawn the backend with only Schegent-controlled variables.

Disabling inheritance can break CLIs that rely on ambient variables such as `PATH`, proxy configuration, language runtimes, or vendor authentication tokens. Use an absolute `schegent.cli.path` and configure required authentication through the backend CLI's own supported mechanism before disabling this setting.

### `schegent.backend.runner`

- **Type:** `string`
- **Default:** `"claude"`
- **Scope:** `application`
- **Enum:** `claude` | `codex`

Backend runner used to drive each phase invocation. `claude` (default) spawns the Claude CLI at `schegent.cli.path`. `codex` spawns the Codex CLI in single-shot `exec --no-stream` mode and pipes the prompt over stdin. Both backends honor the same audit, redaction, and transcript contract.

## Workflow tuning

### `schegent.loop.maxIterations`

- **Type:** `number`
- **Default:** `10`
- **Scope:** `resource`
- **Range:** `1` to `50`

Maximum iterations for the Clarify and Analyze loop phases (and any custom loop phase) before force-advancing.

### `schegent.invocation.timeoutSeconds`

- **Type:** `number`
- **Default:** `1800` (30 minutes)
- **Scope:** `resource`
- **Minimum:** `30`

Per-phase CLI invocation timeout in seconds. A phase that exceeds this without emitting output is killed and the run is failed (or retried, depending on the failure classification).

### `schegent.watchdog.pollIntervalMinutes`

- **Type:** `number`
- **Default:** `30`
- **Scope:** `resource`
- **Minimum:** `1`

Credit watchdog poll interval in minutes. The watchdog periodically samples the CLI's reported credit balance to surface upcoming rate-limit conditions before they fire.

## Audit log

### `schegent.audit.rotation.sizeMB`

- **Type:** `number`
- **Default:** `5`
- **Scope:** `resource`
- **Minimum:** `1`

Audit log size threshold (megabytes) before rotation. When `.schegent/audit.log` exceeds this size, it rotates to `.schegent/audit.log.<YYYYMMDD-HHMMSS>` and a fresh active file is opened.

### `schegent.audit.rotation.maxAgeDays`

- **Type:** `number`
- **Default:** `30`
- **Scope:** `resource`
- **Minimum:** `1`

Audit log age threshold (days) before rotation. Independent of `sizeMB`; either trigger causes a rotation.

Rotated archives are retained per a built-in 7-day archive-age floor plus a count cap (operator-tunable retention surface is not exposed today).

## Pipeline and phase customization

### `schegent.defaultPipelineId`

- **Type:** `string`
- **Default:** `"speckit-new-feature"`
- **Scope:** `resource`
- **Pattern:** `^[a-z][a-z0-9-]{0,63}$`

Pipeline id used when a feature is enqueued without an explicit selection. Set this to a custom pipeline id if you want every Enqueue Feature click to default to your variant.

### `schegent.phases`

- **Type:** `array of objects`
- **Default:** `[]`
- **Scope:** `resource`

Custom phase definitions. Each entry is a reusable named Claude CLI invocation step. A user-defined phase whose `id` matches a built-in id **shadows** the built-in.

Each phase object accepts:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Kebab-case identifier, ≤64 chars (`^[a-z][a-z0-9-]{0,63}$`). Reserved built-ins: `speckit-specify`, `speckit-clarify`, `speckit-plan`, `speckit-tasks`, `speckit-analyze`, `speckit-implement`, `finalize`, `done`. |
| `name` | string | yes | Display name (1–80 chars) shown in sidebar tiles, audit logs, and pipeline picker. |
| `instruction` | string | yes | Phase-specific directive injected into the Claude CLI prompt. 1–8192 chars. Empty string is accepted when *shadowing* a built-in (the built-in instruction is preserved). |
| `model` | string | no | Claude model id passed as `--model <id>` for this phase only. |
| `effort` | string | no | Reasoning effort. Enum: `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `timeoutSeconds` | integer | no | Per-phase timeout override (1–3600). |
| `loopable` | boolean | yes | When `true`, the phase re-runs until stdout signals `[SCHEGENT_STATUS: CLEAR]`. |
| `retryCondition` | string | no | Retry-condition DSL expression evaluated against the audit-entry's `metrics` map. See [Custom Phases](../features/custom-phases.md#retry-condition-dsl). |

Example:

```jsonc
{
  "schegent.phases": [
    {
      "id": "speckit-implement",
      "name": "Spec-kit Implement (Opus)",
      "instruction": "",
      "model": "claude-opus-4-7",
      "effort": "high",
      "loopable": false
    }
  ]
}
```

For more on shadowing and overrides, see [Phase Overrides](../features/phase-overrides.md).

### `schegent.pipelines`

- **Type:** `array of objects`
- **Default:** `[]`
- **Scope:** `resource`

Custom pipeline definitions. A pipeline is an ordered chain of phase ids.

Each pipeline accepts:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique pipeline id, kebab-case, ≤64 chars. The id `speckit-new-feature` is reserved for the built-in. |
| `name` | string | yes | Display name (1–80 chars) shown in the QuickPick picker and sidebar header. |
| `phases` | array of strings | yes | Ordered list of phase ids. 1–50 entries. Each must match a built-in id or one of your `schegent.phases[].id`. |

Example:

```jsonc
{
  "schegent.pipelines": [
    {
      "id": "quick-spec",
      "name": "Quick Spec",
      "phases": ["speckit-specify", "speckit-plan", "speckit-implement", "done"]
    }
  ]
}
```

### `schegent.models`

- **Type:** `array of strings`
- **Default:** `[]`
- **Scope:** `resource`

List of custom model identifiers (e.g., `claude-3-7-sonnet-20250219`, `sonnet`, `opus`) available in the Pipeline Builder QuickPick. Surface-only — does not validate the ids against an authoritative list.

### `schegent.rules.injectPerPhase`

- **Type:** `boolean`
- **Default:** `false`
- **Scope:** `resource`

Reserved legacy toggle. The current runner wiring reads the setting but does
not write or inject `.claude/rules/<phase>.md`; keep this disabled until a
future feature reintroduces rule-file injection with explicit trust-boundary
coverage.

## Retry and queue

### `schegent.retry.maxAttempts`

- **Type:** `integer`
- **Default:** `5`
- **Scope:** `resource`
- **Range:** `1` to `5`

Maximum delayed-retry attempts per run before pausing the queue. When a phase encounters a transient error or rate limit, it schedules a delayed retry. After this many consecutive failures without a clean recovery, the run and queue are paused.

The advertised maximum was reduced from `20` to `5` in feature 056 to match the implementation cap.

### `schegent.queue.globalConcurrencyCap`

- **Type:** `integer`
- **Default:** `1`
- **Scope:** `resource`
- **Range:** `1` to `1`

Maximum number of workflow runs that may be in-flight at the same time. v1 supports exactly one active run; this knob is pinned at `1` for forward-compatibility. Values greater than `1` saved by older versions are clamped on read.

## Logging and diagnostics

### `schegent.logging.runtimeLogLevel`

- **Type:** `string`
- **Default:** `"INFO"`
- **Scope:** `resource`
- **Enum:** `DEBUG` | `INFO` | `WARN` | `ERROR`

Runtime debug log severity filter. Records at or above the configured level are appended to the runtime log file; lower-severity records are dropped. Independent of `schegent.logging.verbose` (which controls the unredacted diagnostic sink). Re-read on every emit — mid-run changes apply at the next event boundary.

### `schegent.logging.runtimeLogFilePath`

- **Type:** `string`
- **Default:** `""`
- **Scope:** `resource`

Runtime debug log file path. Empty string resolves to `<workspaceRoot>/.schegent/syslog`. Accepts an absolute path (POSIX or Windows) or a workspace-relative path. Relative paths containing `..` are rejected. The parent directory is auto-created on first write; the file is created with mode `0644` on POSIX.

### `schegent.logging.runtimeLogMaxBytes`

- **Type:** `integer`
- **Default:** `5242880` (5 MiB)
- **Scope:** `resource`
- **Range:** `65536` (64 KiB) to `1073741824` (1 GiB)

Maximum size of the active runtime log file before rotation. On a write that would push the file past this size, the active file is rotated to `<path>.1`; existing generations shift by one. Setting changes are read on every log emit, so no reload is required.

### `schegent.logging.runtimeLogMaxGenerations`

- **Type:** `integer`
- **Default:** `3`
- **Scope:** `resource`
- **Range:** `0` to `20`

Number of rotated runtime log generations to keep (`<path>.1` through `<path>.N`). Older generations are deleted on the next rotation.

### `schegent.logging.verbose`

- **Type:** `boolean`
- **Default:** `false`
- **Scope:** `resource`

When enabled, every Claude CLI invocation is spawned with `--debug-file`, `--output-format stream-json`, and `--verbose`. CLI streams are captured under `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/` as `debug.json`, `stream.jsonl`, and `verbose.log`. **The captured files are unredacted.** Toggle off to return to standard headless mode. The setting is re-read at the entry of every phase invocation — mid-run toggling applies on the *next* phase.

See [Verbose Diagnostics](../features/verbose-diagnostics.md).

## Fatal signatures

### `schegent.fatalSignatures`

- **Type:** `array of non-empty strings`
- **Default:** `[]`
- **Scope:** `resource`

Operator-additive supplement to the code-resident Fatal Signature Registry. Each element is a verbatim substring; when present in CLI stdout or stderr, the active phase fails fast on the current invocation. Code-resident signatures cannot be removed or modified here — they are managed via PR review. A malformed value falls back to `[]` without blocking extension activation.

The setting is re-read at every phase invocation entry.

See [Fatal Signatures](../features/fatal-signatures.md).

## Advanced CLI behavior

### `schegent.claude.autoCompactPctOverride`

- **Type:** `integer` or `null`
- **Default:** `null`
- **Scope:** `resource`
- **Range:** `1` to `100` (percent)

When set to an integer in `[1, 100]`, the value is exported as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to the Claude CLI subprocess, overriding the CLI's built-in auto-compaction threshold. `null` or an out-of-range value leaves the env var unset (CLI default applies). Re-read at every phase invocation entry.

See [Auto-compact Override](../features/auto-compact-override.md).

## Wake-up scheduler

### `schegent.wakeUp.enabled`

- **Type:** `boolean`
- **Default:** `false`
- **Scope:** `application`

Enable the Wake-up background scheduler. When enabled, a per-user OS-native scheduled task (launchd on macOS, Task Scheduler on Windows, cron/systemd-user units on Linux) periodically invokes a 1-token Claude CLI command in a sandboxed temporary directory to keep the 5-hour rolling allocation window warm.

The OS entry is installed only on the **primary** VS Code host.

### `schegent.wakeUp.schedulerType`

- **Type:** `string`
- **Default:** `"chronological"`
- **Scope:** `application`
- **Enum:** `chronological` | `periodic`

Wake-up trigger style. `chronological` fires once per day at a fixed local time (see `chronologicalTime`). `periodic` fires at a fixed interval (see `periodicInterval`).

### `schegent.wakeUp.chronologicalTime`

- **Type:** `string`
- **Default:** `"04:00"`
- **Scope:** `application`
- **Pattern:** `^([01]\d|2[0-3]):[0-5]\d$` (24-hour `HH:MM`)

Daily fire time for chronological mode in 24-hour `HH:MM` form (local time). Used only when `schedulerType` is `chronological`.

### `schegent.wakeUp.periodicInterval`

- **Type:** `string`
- **Default:** `"Every 4h"`
- **Scope:** `application`
- **Pattern:** `^Every (\d+)(m|h)$`

Periodic fire interval in `Every Nm` or `Every Nh` form. Minimum granularity is 1 minute (`Every 1m`). Intervals below 5 hours surface a non-blocking advisory in the Settings UI (they may waste tokens within an unreset rolling window). Used only when `schedulerType` is `periodic`.

For full Wake-up behavior, see [Wake-up Scheduler](../features/wake-up-scheduler.md).

## Multi-root workspaces

### `schegent.multiRoot.suppressWarning`

- **Type:** `boolean`
- **Default:** `false`
- **Scope:** `window`

Suppress the one-shot informational toast that Schegent surfaces at activation when the active workspace contains more than one folder. The toast names the **canonical workspace folder** — the first folder in the `.code-workspace` file, under which Schegent creates `.schegent/`, the audit log, and the per-run session tree.

When `true`, both the toast and the corresponding `multi-root.warning-shown` audit event are suppressed. The canonical-folder selection itself is unaffected — the setting is purely cosmetic.

The setting is `window`-scoped so it only applies to the specific `.code-workspace` file you save it under. See [The Workspace Lock → Multi-root workspaces](../concepts/workspace-lock.md#multi-root-workspaces) for the underlying semantics.

## All-keys index

For quick lookup, the full list of keys:

| Key | Scope | Default |
|---|---|---|
| `schegent.cli.path` | application | `"claude"` |
| `schegent.backend.runner` | application | `"claude"` |
| `schegent.loop.maxIterations` | resource | `10` |
| `schegent.invocation.timeoutSeconds` | resource | `1800` |
| `schegent.watchdog.pollIntervalMinutes` | resource | `30` |
| `schegent.audit.rotation.sizeMB` | resource | `5` |
| `schegent.audit.rotation.maxAgeDays` | resource | `30` |
| `schegent.defaultPipelineId` | resource | `"speckit-new-feature"` |
| `schegent.phases` | resource | `[]` |
| `schegent.pipelines` | resource | `[]` |
| `schegent.models` | resource | `[]` |
| `schegent.rules.injectPerPhase` | resource | `false` |
| `schegent.retry.maxAttempts` | resource | `5` |
| `schegent.queue.globalConcurrencyCap` | resource | `1` |
| `schegent.logging.runtimeLogLevel` | resource | `"INFO"` |
| `schegent.logging.runtimeLogFilePath` | resource | `""` |
| `schegent.logging.runtimeLogMaxBytes` | resource | `5242880` |
| `schegent.logging.runtimeLogMaxGenerations` | resource | `3` |
| `schegent.logging.verbose` | resource | `false` |
| `schegent.fatalSignatures` | resource | `[]` |
| `schegent.claude.autoCompactPctOverride` | resource | `null` |
| `schegent.wakeUp.enabled` | application | `false` |
| `schegent.wakeUp.schedulerType` | application | `"chronological"` |
| `schegent.wakeUp.chronologicalTime` | application | `"04:00"` |
| `schegent.wakeUp.periodicInterval` | application | `"Every 4h"` |
| `schegent.multiRoot.suppressWarning` | window | `false` |

## Editing settings

You have three ways to change a setting:

1. **VS Code Settings UI** — `Cmd/Ctrl + ,`, search for `schegent`. The UI surfaces descriptions and validation inline.
2. **Direct `settings.json` edit** — `Cmd/Ctrl + Shift + P` → "Preferences: Open User Settings (JSON)". Type-safe; the JSON schema validates as you type.
3. **The Schegent sidebar settings panel** — for the subset of settings exposed there (CLI path, models, phase overrides, logging, retries, fatal signatures, wake-up).

All three write to the same underlying `settings.json`. Schegent re-reads every relevant setting at the next phase invocation, so changes apply without a reload unless the setting explicitly documents otherwise.

## What does *not* live here

- **Workspace state** — runs, queue, pause records. Stored in `workspaceState` (VS Code's per-workspace storage), not in `settings.json`. Reset with `schegent.reset`.
- **OS-native scheduler entries** — written by the host to launchd / Task Scheduler / cron-or-systemd. Managed via the wake-up settings, not edited by hand.
- **Audit and runtime log files** — local artefacts under `.schegent/`. See [File Layout](file-layout.md).

The next reference page is [Commands](commands.md).
