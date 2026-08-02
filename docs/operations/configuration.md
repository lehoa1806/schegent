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
| `schegent.cli.environmentMode` | enum (`inherit`, `minimal`, `allowlist`) | Compatibility default is `inherit`. `minimal` passes only Schegent variables; `allowlist` adds required bootstrap variables and approved names. The legacy boolean `false` always forces `minimal`. |
| `schegent.cli.environmentAllowlist` | string[] | Names only; used in `allowlist` mode. Never store `NAME=value` or a secret value here. |
| `schegent.backend.runner` | enum (`claude`, `codex`, `agy`) | Selects the default `BackendRunner` adapter. Default `claude`; a phase-level runner override wins. See [Backend Runners](backends.md). |
| `schegent.backend.probeTimeoutSeconds` | integer (`1..30`) | Bounds backend availability/model discovery; default 5 seconds. Path or timeout changes trigger a background rescan. |
| `schegent.codex.path` | string | Path to the `codex` CLI binary. |
| `schegent.agy.path` | string | Path to the `agy` CLI binary. |
| `schegent.logging.verbose` | boolean | Captures unredacted per-iteration diagnostics under `.schegent/sessions/`. |
| `schegent.logging.runtimeLogMaxBytes` | number (default `5_242_880` / 5 MiB) | Size threshold at which the runtime log rotates `<path> → <path>.1 → … → <path>.<maxGens>`. Read uncached on every emit. See [docs/operations/runtime-log.md](runtime-log.md). |
| `schegent.logging.runtimeLogMaxGenerations` | number (0–10, default `3`) | Number of rotated generations to keep on disk. `0` disables rotation (truncate-in-place). Worst-case disk = active file + `maxGens × maxBytes`. |
| `schegent.loop.maxIterations` | number (1–50) | Maximum recursive iterations per loopable phase. |
| `schegent.invocation.timeoutSeconds` | number (minimum 30) | Maximum wall-clock duration per CLI call. |
| `schegent.watchdog.pollIntervalMinutes` | number (minimum 1) | Watchdog re-check cadence during a paused run. |
| `schegent.audit.rotation.sizeMB` | number (minimum 1) | Audit log size threshold for rotation. |
| `schegent.audit.rotation.maxAgeDays` | number (minimum 1) | Retention for rotated audit log files. |
| `schegent.defaultPipelineId` | string | Pipeline used when `/speckit.auto` runs without an explicit selection. |
| `schegent.fatalSignatures` | string[] | Operator-additive fatal-signature substrings; managed via the **Settings → Fatal Signatures** sub-tab. |

The default backend does not override Git capability requirements. The
`speckit-specify`, `specify-brainstorm`, `superpowers-implement`, `finalize`,
and `superpowers-review-close` built-ins are pinned to Claude, and
their phase overrides must explicitly select `claude` or `agy`; Codex's
`workspace-write` sandbox cannot update `.git`.

The withdrawn key `schegent.rules.injectPerPhase` is ignored if it remains in
an operator-owned settings file. Schegent does not rewrite external settings
files merely to remove stale keys.

### Phases / Pipelines / Models

These are not scalar workspace settings — they live in their own
dedicated IPC commands (`CMD_SAVE_PHASES`, `CMD_SAVE_PIPELINES`,
`CMD_SAVE_MODELS`) and are edited from:

- **Phases** → Pipeline Builder, top section.
- **Pipelines** → Pipeline Builder, below the Phases editor.
- **Models** → Operations view, collapsible "Model Catalog" section near
  the bottom.

### Per-phase Effort + Model (feature 026)

Each source row in the Pipeline Builder's Phases editor has dedicated **Effort**
and **Model** dropdowns alongside the existing per-phase fields. Both
fields default to **Inherit** (no override). Each row identifies its user,
workspace, or built-in source. Workspace wins over user, which wins over
built-in, but invalid higher rows are quarantined and the next valid source
becomes effective. User-layer rows remain independently editable while
shadowed.

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

### Scoped Phase saves and stale recovery

Phase create and duplicate flows require a target scope. Every save sends the
complete selected layer, its authoritative revision, and exactly one mutation
intent. The host re-reads the layer, validates the whole proposal, derives
versions, and writes once to Global or Workspace configuration. A
`stale-catalog` rejection means another window or settings edit won the race:
refresh the catalog, review the authoritative row, and reapply the draft.

Removing a custom row always asks for confirmation. Removal is blocked when it
would eliminate the final valid definition referenced by an effective
pipeline; the error lists the dependent pipeline ids. Reset clears only the
selected writable layer. Built-ins are never copied into settings or deleted.

### Scoped Pipeline saves and contracts (feature 082)

`schegent.pipelines` rows are no longer just `{ id, name, phases }`. A row may
now declare a full contract:

| Field | Meaning |
|---|---|
| `pipelineId` | Portable kebab-case id, ≤ 64 chars (`id` still accepted). Immutable once saved — rename the `name`, not the id. |
| `name`, `description` | Display fields. |
| `version` | Integer, monotonic. The host derives the next version on save; it never decreases. |
| `phases` | Ordered Phase references, 1–50 entries. The same Phase may appear more than once. |
| `inputs` | Declared session inputs: `{ portId, label, type, required?, description? }`. `type` is one of `text`, `source`, `source-list`, `local-file`, `local-folder`, `web-url`, `pipeline-output`, `repository-context`. |
| `outputs` | Declared artifacts: `{ portId, label, type, description? }`, `type` one of `markdown`, `file`, `file-set`, `structured-data`, `run-request`, `external-reference`. |
| `bindings` | Wiring between ports and Phase steps. Addressed by **position** (`phaseIndex`), not by `phaseId`, because a Phase may repeat. |
| `executionDefaults` | Advisory Run-creation defaults (`runner`, `model`, `effort`, `timeoutSeconds`). Host-owned runtime policy is not authorable here. |
| `recommendedNext` | Advisory follow-on Pipeline ids. |

Editing rules that will show up in the UI:

- **Bindings resolve only against the effective Phase catalog.** An input that
  reads from a later Phase (`binding-forward-reference`) is a validation error
  naming the binding and the port, and blocks the save. Reordering a Phase
  remaps every binding automatically before revalidation.
- **A Phase output feeding a later Phase input** requires the receiving input
  port to be declared with type `pipeline-output`.
- **Scope is explicit.** Create and duplicate ask for a target scope; every save
  sends the complete selected layer, its authoritative revision, and exactly one
  mutation intent, and the host writes once. A `stale-catalog` rejection means
  another window won the race — it returns the row as the host holds it plus the
  legal next actions (`refresh`, then `reapply`).
- **Removal is blocked while a queued Workflow still references the Pipeline**
  and no other layer would supply it. The error lists the consuming Workflows.
  Define the same `pipelineId` at a lower scope and the removal is permitted —
  the lower definition becomes effective. Workflows that have already started
  are not consumers: their Pipeline contract is frozen in the Run.
- **Built-ins are read-only** — duplicate them into a writable scope instead.
- **Advisory conditions never block a save**: exceeding 20 effective Pipelines
  or 50 Phases in one Pipeline warns without truncating anything, and a
  `recommendedNext` id with no effective definition is a warning too.
- **An invalid row stays visible** with its field errors while the next valid
  scope for that id becomes effective, so a broken workspace row never hides the
  user or built-in definition behind it.

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
