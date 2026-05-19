# Schegent Configuration Reference

This doc is the operator-facing index of `schegent.*` workspace settings.
The Dashboard's **Settings → General** tab provides per-key edit controls
backed by VS Code's configuration store. Workspace-scope edits override
user-scope, which override defaults. Edits are saved through the
host-validated `CMD_SAVE_GENERAL_SETTINGS` IPC: the host validates the
entire batch before writing anything, then uses compensating rollback to
restore earlier workspace-scope values if a later `config.update()` call
fails. Saved values round-trip back through the snapshot, so dirty fields
display per-key accept / reject status.

## Top-level Dashboard navigation

After feature 012, the Dashboard exposes three peer routes:

| Route | What it hosts |
|---|---|
| **Operations** | Live queue, phase progression, monitor pill, history, and the **Model Catalog** (collapsible, near the bottom). |
| **Pipeline Builder** | Phases editor (top section) and Pipelines composition area (below). |
| **Settings** | Two sub-tabs only: **General** and **Fatal Signatures**. |

Phases / Pipelines / Models editors are no longer found under Settings —
they live where operators actually use them.

## Workspace settings

### `schegent.claude.autoCompactPctOverride` (feature 012)

| Aspect | Value |
|---|---|
| **Type** | integer or `null` (clear) |
| **Range** | 1–100 (inclusive) |
| **Default** | unset (use the Claude CLI's own auto-compaction default) |
| **Location** | Dashboard → Settings → General → "Claude auto-compaction threshold (%)" |
| **Effect when set** | Exported as the environment variable `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for every Claude CLI subprocess spawned by Schegent. |
| **Effect when unset** | The env var is not exported. The CLI uses its built-in default. |
| **Re-validation** | Host re-validates on every save. Out-of-range values reject with `out-of-range:claude.autoCompactPctOverride`; non-integer values reject with `type-mismatch:claude.autoCompactPctOverride`. |
| **Mid-run apply** | Reads via `AutoCompactOverrideAccessor` at the top of every `PhaseRunner.run()` — toggling mid-run applies to the next invocation. Never cached on the runner. |

**Clearing the override**: post `null` from the UI (the empty-input handler in
`GeneralSettingsTab.svelte` translates an empty input to `null`); the host
translates `null` to `config.update(key, undefined)` so VS Code removes the
key entirely.

### Other settings

Most scalar keys below are reachable from the same tab and are authoritative
against `src/config/general-settings.ts` (`ALLOWED_KEYS` allowlist +
`KEY_SPECS` validator). Application-scoped CLI/backend keys are contributed
through VS Code settings and read at activation.

| Key | Type | Notes |
|---|---|---|
| `schegent.cli.path` | string | Path to the `claude` CLI binary. |
| `schegent.cli.inheritEnvironment` | boolean | Defaults to `true`. Set to `false` to spawn backend CLIs with only Schegent-controlled environment variables; use absolute CLI paths and backend-native auth first. |
| `schegent.backend.runner` | enum (`claude`, `codex`) | Selects the concrete `BackendRunner` adapter. Default `claude`. See [docs/operations/backends.md](backends.md). |
| `schegent.logging.verbose` | boolean | Captures unredacted per-iteration diagnostics under `.schegent/sessions/`. |
| `schegent.logging.runtimeLogMaxBytes` | number (default `5_242_880` / 5 MiB) | Size threshold at which the runtime log rotates `<path> → <path>.1 → … → <path>.<maxGens>`. Read uncached on every emit. See [docs/operations/runtime-log.md](runtime-log.md). |
| `schegent.logging.runtimeLogMaxGenerations` | number (0–10, default `3`) | Number of rotated generations to keep on disk. `0` disables rotation (truncate-in-place). Worst-case disk = active file + `maxGens × maxBytes`. |
| `schegent.loop.maxIterations` | number (1–50) | Maximum recursive iterations per loopable phase. |
| `schegent.invocation.timeoutSeconds` | number (minimum 30) | Maximum wall-clock duration per CLI call. |
| `schegent.watchdog.pollIntervalMinutes` | number (minimum 1) | Watchdog re-check cadence during a paused run. |
| `schegent.audit.rotation.sizeMB` | number (minimum 1) | Audit log size threshold for rotation. |
| `schegent.audit.rotation.maxAgeDays` | number (minimum 1) | Retention for rotated audit log files. |
| `schegent.rules.injectPerPhase` | boolean | Reserved legacy toggle; current runner wiring does not inject per-phase rule files. |
| `schegent.defaultPipelineId` | string | Pipeline used when `/speckit.auto` runs without an explicit selection. |
| `schegent.fatalSignatures` | string[] | Operator-additive fatal-signature substrings; managed via the **Settings → Fatal Signatures** sub-tab. |

### Phases / Pipelines / Models

These are not scalar workspace settings — they live in their own
dedicated IPC commands (`CMD_SAVE_PHASES`, `CMD_SAVE_PIPELINES`,
`CMD_SAVE_MODELS`) and are edited from:

- **Phases** → Pipeline Builder, top section.
- **Pipelines** → Pipeline Builder, below the Phases editor.
- **Models** → Operations view, collapsible "Model Catalog" section near
  the bottom.

### Per-phase Effort + Model (feature 026)

Each row in the Pipeline Builder's Phases editor has dedicated **Effort**
and **Model** dropdowns alongside the existing per-phase fields. Both
fields default to **Inherit** (no override); choosing a concrete value
applies that override at the **user catalog layer** (`schegent.phases`
in user settings). A workspace-layer override
(`.vscode/settings.json` `schegent.phases`) shadows the user-layer
value for the *effective* run-time choice but does NOT block a
user-layer save — the workspace shadow is surfaced by an inline
**"shadowed by workspace"** badge on the row, and the user-layer save
is still accepted and persisted (FR-021).

**Effort** accepts one of `low`, `medium`, `high`, `xhigh`, `max`.
**Model** accepts any identifier from the merged model catalog (built-in
permitted models plus operator-defined entries). The two fields are
orthogonal — clearing one back to Inherit does NOT clear the other.

When a run starts, the effective per-phase Effort + Model are captured
in the **immutable `WorkflowRun.pipeline` snapshot** (FR-007) and
emitted on the `phase-start` audit event as optional payload fields
(absent fields are omitted, not emitted as empty strings or `null`).
Settings changes mid-run never retarget the in-flight snapshot;
overrides only take effect on the **next** enqueue.

### Built-in pipeline: `speckit-bugfix` (feature 026)

A second built-in pipeline ships alongside `speckit-new-feature`:

| Phase | Purpose |
|---|---|
| `bugfix-report` | Investigate the bug; produce a structured report. |
| `bugfix-patch` | Author a patch against the affected feature spec. |
| `bugfix-verify-pre` | Verify the patch reproduces the bug pre-fix. |
| `bugfix-implement` | Apply the implementation. |
| `bugfix-verify-post` | Verify the bug is gone post-fix. |

Pipeline id: `speckit-bugfix`. Choose it from the Dashboard's new-task
pipeline selector. The default selection remains `speckit-new-feature`.
A `bugfix-verify-pre` or `bugfix-verify-post` failure pauses the run
via the existing `phase-paused` cause (FR-016) — resume re-invokes the
same failed verify phase rather than silently advancing.

## How saves work

All `schegent.*` scalar saves route through the shared helper
[`webview-ui/src/lib/save-general-settings.ts`](../../webview-ui/src/lib/save-general-settings.ts).
It is the single call site for `CMD_SAVE_GENERAL_SETTINGS` (FR-031),
enforced by a repo-grep regression test
([`tests/lint/no-inline-save-general-settings.test.ts`](../../tests/lint/no-inline-save-general-settings.test.ts)).
The helper:

1. Generates a UUIDv4 correlation id.
2. Posts the envelope through the standard `postCommand` path.
3. Awaits the matching `CMD_ACK` (5-second timeout → `{ status:
   'rejected', reason: 'timeout' }`).
4. Concurrent saves are correlated by id and never cross-resolve.

## See also

- [`docs/operations/dashboard-ui.md`](dashboard-ui.md) — visual anatomy.
- [`docs/operations/fail-fast-on-fatal-cli-errors.md`](fail-fast-on-fatal-cli-errors.md) — Fatal Signatures workflow.
- [`docs/operations/delayed-retry-and-manual-override.md`](delayed-retry-and-manual-override.md) — Delayed-retry semantics.
