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
| `schegent.cli.environmentMode` | enum (`inherit`, `minimal`, `allowlist`) | Defaults to `allowlist`: required bootstrap variables (`PATH`, `HOME`, `TMPDIR`, locale, Windows runtime) plus the names in `environmentAllowlist`. `inherit` forwards the whole extension-host environment; `minimal` passes only Schegent variables and forwards no `PATH`. The legacy boolean `false` always forces `minimal`. Changed from `inherit` in feature 098. |
| `schegent.cli.environmentAllowlist` | string[] | Names only; used in `allowlist` mode. Never store `NAME=value` or a secret value here. |
| `schegent.backend.runner` | enum (`claude`, `codex`, `agy`) | Selects the default `BackendRunner` adapter. Default `claude`; a phase-level runner override wins. See [Backend Runners](backends.md). |
| `schegent.backend.probeTimeoutSeconds` | integer (`1..30`) | Bounds backend availability/model discovery; default 5 seconds. Path or timeout changes trigger a background rescan. |
| `schegent.codex.path` | string | Path to the `codex` CLI binary. |
| `schegent.agy.path` | string | Path to the `agy` CLI binary. |
| `schegent.logging.verbose` | boolean | Captures unredacted per-iteration diagnostics under `.schegent/sessions/`. |
| `schegent.logging.runtimeLogMaxBytes` | number (default `5_242_880` / 5 MiB) | Size threshold at which the runtime log rotates `<path> → <path>.1 → … → <path>.<maxGens>`. Read uncached on every emit. See [docs/operations/runtime-log.md](runtime-log.md). |
| `schegent.logging.runtimeLogMaxGenerations` | number (0–10, default `3`) | Number of rotated generations to keep on disk. `0` disables rotation (truncate-in-place). Worst-case disk = active file + `maxGens × maxBytes`. |
| `schegent.loop.maxIterations` | number (1–50) | Maximum recursive iterations per loopable phase. |
| `schegent.retry.forceContinueOnCap` | boolean (default `false`) | Workspace default for advancing past an exhausted `retryCondition` cap instead of halting `cap_exhausted`. A phase's own `forceContinueOnRetryCap` overrides it. Applies to cap exhaustion only — never to a `failed` or `timeout` outcome. See [Custom Retry Conditions](custom-retry-conditions.md). |
| `schegent.invocation.timeoutSeconds` | number (minimum 30) | Maximum wall-clock duration per CLI call. |
| `schegent.watchdog.pollIntervalMinutes` | number (minimum 1) | Watchdog re-check cadence during a paused run. |
| `schegent.audit.rotation.sizeMB` | number (minimum 1) | Audit log size threshold for rotation. |
| `schegent.audit.rotation.maxAgeDays` | number (minimum 1) | Retention for rotated audit log files. |
| `schegent.defaultPipelineId` | string | Pipeline used when `/speckit.auto` runs without an explicit selection. Ships empty; a launch that falls through to an empty value is refused rather than defaulted. |
| `schegent.fatalSignatures` | string[] | Operator-additive fatal-signature substrings; managed via the **Settings → Fatal Signatures** sub-tab. |

The default backend does not override Git capability requirements. A Phase that
declares `sideEffects: git` is pinned to a Git-capable runner: its overrides
must explicitly select `claude` or `agy`, because Codex's `workspace-write`
sandbox cannot update `.git`. The rule reads the declaration, not the id — the
list of five pinned built-in ids it replaced is gone, along with the built-in
layer that held them, and has no successor. See
[Backends](backends.md#per-phase-runner-selection-and-probing).

The withdrawn key `schegent.rules.injectPerPhase` is ignored if it remains in
an operator-owned settings file. Schegent does not rewrite external settings
files merely to remove stale keys.

### Phases / Pipelines / Models

These are not settings at all. Phase, Pipeline, and Workflow definitions
live in the **versioned catalog store** under
`<workspaceRoot>/.schegent/catalog/`, and the Model Catalog is
configuration but not a scalar key. All four reach the host through their
own dedicated IPC commands (`CMD_SAVE_PHASES`, `CMD_SAVE_PIPELINES`,
`CMD_SAVE_WORKFLOWS`, `CMD_SAVE_MODELS`) and are edited from:

- **Phases** → Pipeline Builder, top section.
- **Pipelines** → Pipeline Builder, below the Phases editor.
- **Models** → Operations view, collapsible "Model Catalog" section near
  the bottom.

### Per-phase Effort + Model (feature 026)

Each row in the Pipeline Builder's Phases editor has dedicated **Effort**
and **Model** dropdowns alongside the existing per-phase fields. Both
fields default to **Inherit** (no override). There is one row per phase id,
because the catalog holds one definition per id: a row is either
**effective** or **invalid**, and an invalid one stays visible with its
field errors rather than being replaced by something behind it.

**Effort** accepts one of `low`, `medium`, `high`, `xhigh`, `max`.
**Model** accepts any identifier from the model catalog, which is itself
imported — `examples/model-catalog.yaml` is the document that ships with the
extension. The two fields are
orthogonal — clearing one back to Inherit does NOT clear the other.

When a run starts, the effective per-phase Effort + Model are captured
in the **immutable `WorkflowRun.pipeline` snapshot** (FR-007) and
emitted on the `phase-start` audit event as optional payload fields
(absent fields are omitted, not emitted as empty strings or `null`).
Settings changes mid-run never retarget the in-flight snapshot;
overrides only take effect on the **next** enqueue.

### Phase saves and stale recovery

There is no target scope to pick. Every save sends the complete catalog,
its authoritative revision, and exactly one mutation intent (`create`,
`edit`, `duplicate`, `remove`, `reset`, or `import-package`). The host
re-reads the catalog, validates the whole proposal, and writes once: a new
**immutable version record** per changed definition, then the manifest
entry pointing at it. Saving unchanged content writes nothing — the body is
hashed, and an identical hash is a no-op. A `stale-catalog` rejection means
another window won the race: refresh the catalog, review the authoritative
row, and reapply the draft.

Removing a definition always asks for confirmation. Removal is blocked when
it would eliminate a definition an effective pipeline still references; the
error lists the dependent pipeline ids. Reset clears the catalog for that
kind. Nothing is ever copied into `settings.json`.

### Pipeline saves and contracts (feature 082)

A Pipeline definition is not just `{ id, name, phases }`. It declares a
full contract:

| Field | Meaning |
|---|---|
| `pipelineId` | Portable kebab-case id, ≤ 64 chars. Immutable once saved — rename the `name`, not the id. |
| `name`, `description` | Display fields. |
| `version` | Integer, monotonic. The host derives the next version on save; it never decreases. Distinct from the store's own `versionId`, which counts every save. |
| `phaseIds` | Ordered Phase references, 1–50 entries. The same Phase may appear more than once. |
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
- **There is no scope to choose.** Every save sends the complete catalog, its
  authoritative revision, and exactly one mutation intent, and the host writes
  once. A `stale-catalog` rejection means another window won the race — it
  returns the row as the host holds it plus the legal next actions (`refresh`,
  then `reapply`).
- **Removal is blocked while anything still references the Pipeline.** The
  error lists the consumers. Two different things count as a consumer, and both
  are checked (feature 083): a **queued Workflow Run** that still resolves its
  `pipelineId` from the catalog, and a stored **Workflow definition** whose node
  names the Pipeline. For definitions this counts *every stored row*, including
  invalid ones — an invalid Workflow goes live the moment its defect is
  repaired, so removing the Pipeline first would break it. Runs that have
  already started are not consumers: their Pipeline contract is frozen in the
  Run.
- **Advisory conditions never block a save**: exceeding 20 effective Pipelines
  or 50 Phases in one Pipeline warns without truncating anything, and a
  `recommendedNext` id with no effective definition is a warning too.
- **An invalid row stays visible** with its field errors, and costs only
  itself. With one definition per id there is nothing behind it to fall back
  to, so repairing it is the only way it becomes effective again — and its
  previous version is still in the definition's history to compare against.

### Workflow graphs and saves (feature 083)

Workflows are the third definition catalog, alongside Phases and Pipelines,
stored under `<workspaceRoot>/.schegent/catalog/workflows/`. A **Workflow
definition** is a saved acyclic graph whose nodes are Pipelines — a document
describing how one Pipeline's output may guide an explicit follow-up run.

Two things share the name. The queue and audit log have always used "workflow"
for a run in flight; that sense is unchanged and is written **Workflow Run**
where the distinction matters. This section is about the definition sense. See
[Glossary](../reference/glossary.md) if a surface is ambiguous.

Saving a Workflow starts nothing. The full field reference is in
[Settings › Workflow definition](../reference/settings.md). The rules you will
meet while editing:

- **A node is an occurrence, not a Pipeline.** Each node carries its own
  `nodeId` and names exactly one `pipelineId`. Two nodes may run the same
  Pipeline; only the `nodeId` distinguishes them, and the Builder shows which
  Pipeline a node runs rather than hiding it.
- **Connections address nodes by id, never by position.** This is the opposite
  of Pipeline bindings, which are index-keyed. Reordering, inserting, or
  removing a node leaves every connection intact — there is no remap step to
  get wrong.
- **Everything is validated against the effective Pipeline catalog.** A node
  naming a Pipeline the catalog does not resolve is an error, as is a port that
  the node's Pipeline does not declare, or an output type the receiving input
  type does not accept. Compatibility is a fixed table, so a Workflow you export
  behaves the same on a colleague's machine.
- **A collection output into a single-valued input needs a `selection` rule**
  (`first`, `last`, or `exactlyOne`). "Which one of these" is a decision the
  graph has to state rather than imply.
- **Conditions are structured data, not expressions.** A guard is
  `{ left, operator, right }` over a closed operand set, compared field-wise.
  There is no expression language, so nothing is parsed or evaluated. This is a
  different mechanism from a phase `retryCondition`, which is a sandboxed DSL.
  A condition may only read a node that is an **ancestor** of the connection it
  guards — you cannot branch on a result that has not been produced yet.
- **Cycles and unreachable nodes block the save.** The graph must be acyclic,
  and every node must be reachable from `startNodeIds`, which must be non-empty.
- **Every defect is reported at once.** Validation does not stop at the first
  error, so a graph is repaired in one pass rather than one error per save.
- **A Workflow declares no ports of its own.** Its inputs and outputs are
  derived from the unbound ports of its node Pipelines and recomputed on read,
  so they cannot drift when a node's Pipeline changes shape.
- **Saves work exactly as they do for Pipelines.** Every save sends the
  complete catalog, its authoritative revision, and exactly one mutation
  intent, and writes one immutable version. A `stale-catalog` rejection means
  another window won the race and returns the legal next actions (`refresh`,
  then `reapply`).
- **Editing is gated by Workspace Trust and nothing further.** The capability
  that once gated it, `allowWorkflowOverrides`, was retired in feature 099
  along with `allowPipelineOverrides` — both named a layer tier that no longer
  exists. An untrusted workspace activates no catalog at all, which is the
  gate. See [Trust Scopes](trust-scopes.md).
- **No valid Pipeline means no Workflow.** If the effective Pipeline catalog
  resolves nothing, the Builder still opens and existing rows stay readable, but
  saving is disabled and the reason is stated on screen — add or restore a valid
  Pipeline first. The Builder recovers as soon as one resolves; no reload needed.

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
