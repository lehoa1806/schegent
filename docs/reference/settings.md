# Settings reference

Schegent contributes the settings below to VS Code under the `schegent.*` namespace. Application settings follow the user across workspaces, resource settings belong to a workspace, and window settings apply to the current VS Code window. The typed host schema and the manifest are held in bidirectional parity by a test; this page reports the manifest defaults and bounds rather than inventing another configuration contract.

<!-- Source: package.json -->
<!-- Source: src/config/settings-schema.ts -->
<!-- Source: tests/unit/config/settings-schema-parity.test.ts -->

## Backend and process environment

| Setting | Type and accepted values | Default | Scope | Purpose |
|---|---|---|---|---|
| `schegent.cli.path` | string | `claude` | application | Claude executable path. |
| `schegent.cli.inheritEnvironment` | boolean | `true` | application | Legacy compatibility switch. `false` forces the effective environment mode to `minimal`. |
| `schegent.cli.environmentMode` | `inherit`, `minimal`, or `allowlist` | `allowlist` | application | Selects how much of the extension-host environment reaches backend processes. |
| `schegent.cli.environmentAllowlist` | array of names matching `^[A-Za-z_][A-Za-z0-9_]*$` | `[]` | application | Adds environment-variable names to the bootstrap set in `allowlist` mode; values are read at spawn time. |
| `schegent.backend.runner` | `claude`, `codex`, or `agy` | `claude` | application | Selects the default backend. Claude is the default and, like Agy, runs with approval prompts off and acts without asking via `--dangerously-skip-permissions`; Codex uses `exec --json --sandbox workspace-write`. |
| `schegent.backend.probeTimeoutSeconds` | integer, `1`–`30` | `5` | application | Bounds availability and model-discovery probes. |
| `schegent.codex.path` | string | `codex` | application | Codex executable path. |
| `schegent.agy.path` | string | `agy` | application | Agy executable path. |
| `schegent.models` | object keyed by `claude`, `codex`, and `agy` | `{ "claude": [], "codex": [], "agy": [] }` | resource | Adds operator-supplied model identifiers to the Model Catalog. |

<!-- Source: package.json -->
<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/activation/backend-wiring.ts -->

The default backend and process-environment policy are resolved during workspace-bound activation. Reload the VS Code Extension Host after changing `schegent.backend.runner`, `schegent.cli.environmentMode`, `schegent.cli.environmentAllowlist`, or `schegent.cli.inheritEnvironment`. In contrast, the three CLI executable-path settings are read for each invocation and can take effect without a reload.

<!-- Source: src/extension.ts -->
<!-- Source: src/config/cli-path-accessor.ts -->

The backend choice is a privilege choice, not a cosmetic preference. A Phase's `sideEffects` declaration selects its mutation plan, consent, and rollback behavior; a Phase declaring `sideEffects: git` is refused unless its runner is Git-capable. It does not constrain what a spawned subprocess can access. See [Backend operations](../operations/backends.md) and [Unprompted agent, not contained agent](../concepts/unprompted-agent-not-contained.md).

<!-- Source: src/config/phase-runner-policy.ts -->
<!-- Source: src/activation/git-approval.ts -->

## Execution, queues, and retry

| Setting | Type and accepted values | Default | Scope | Purpose |
|---|---|---|---|---|
| `schegent.loop.maxIterations` | number, `1`–`50` | `10` | resource | Maximum loop iterations before force-advance behavior. |
| `schegent.watchdog.pollIntervalMinutes` | number, minimum `1` | `30` | resource | Credit-watchdog polling interval in minutes. |
| `schegent.invocation.idleTimeoutSeconds` | number, minimum `30` | `5400` | resource | Idle window for one Phase invocation: terminated after this long with no output. Renamed from `schegent.invocation.timeoutSeconds`, which is still read as a fallback while unset. |
| `schegent.invocation.maxDurationSeconds` | number, minimum `60` | `21600` | resource | Absolute wall-clock bound on one Phase invocation, armed at spawn and never reset — bounds a chatty child the idle window cannot. Default is 4x the idle default and ~1.7x the longest legitimately long phase observed (3.6 h). |
| `schegent.spend.maxUsdPerRun` | number (minimum `0.01`) or `null` | `null` | resource | Per-run spend bound in US dollars. `null` means **no bound**: the mechanism ships unset so no existing run changes behaviour on upgrade. Crossing it **pauses** the run through the ordinary operator-resumable pause (cause `spend-bound-reached`) — never a failure, never a cancellation. Applies to backends that report a cost; see `docs/operations/autonomy-bounds-disclosure.md`. A Phase may override it with `spendBoundUsd`. |
| `schegent.spend.maxTokensPerRun` | number (minimum `1`) or `null` | `null` | resource | Per-run spend bound in tokens, for backends that report tokens and no cost (`codex`, `agy`). `null` means **no bound**. Behaves identically to the dollar bound, including the pause. A Phase may override it with `spendBoundTokens`. |
| `schegent.defaultPipelineId` | empty string or `^[a-z][a-z0-9-]{0,63}$` | empty string | resource | Pipeline used when enqueueing omits one. Empty means no default; Schegent ships no definitions. |
| `schegent.retry.maxAttempts` | integer, `1`–`5` | `5` | resource | Maximum delayed-retry attempts before the Run and Queue pause. |
| `schegent.retry.forceContinueOnCap` | boolean | `false` | resource | When a `retryCondition` remains truthy at its final allowed iteration, allows advancement and records a forced-continue runtime event. Failed and timed-out outcomes remain terminal. |

**The workspace-wide concurrency cap is not on this page, because it is not a
`settings.json` key.** The maximum number of Runs that may execute at once — still
defaulting to `1`, still accepted only in `[1, 20]`, still refused rather than clamped
when out of range — is workspace state, set in the **Queue configuration** surface and
saved through `CMD_SAVE_QUEUE_SETTINGS`. The key schegent.queue.globalConcurrencyCap is
written here without backticks deliberately, on the same rule as the removed
`allowUncontainedBackends` boolean below: a backticked setting key on a reference page is
a control an operator can reach in their settings, and this one is genuinely gone from the
manifest. It was declared there and read by nothing on any scheduling path, so a value
left behind in `settings.json` changes nothing and never did — it is not migrated, and a
workspace that never opened the Queue configuration keeps the cap of `1` it already ran
at. See [Multi-queue concurrency](../operations/multi-queue-concurrency.md) for the
operator guidance and
[the parallelism ratification](../architecture/local-queue-parallelism-ratification.md)
for why the memento is the one authority.

<!-- Source: package.json -->
<!-- Source: src/config/settings-schema.ts -->
<!-- Source: src/config/general-settings.ts -->
<!-- Source: src/controller/retry-handler.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/contracts/sidebar-ipc/queue.ts -->

## Audit, transcripts, and runtime logging

| Setting | Type and accepted values | Default | Scope | Purpose |
|---|---|---|---|---|
| `schegent.audit.rotation.sizeMB` | number, minimum `1` | `5` | resource | Audit-log rotation threshold in MiB. |
| `schegent.audit.rotation.maxAgeDays` | number, minimum `1` | `30` | resource | Maximum age of rotated audit logs. |
| `schegent.logging.verbose` | boolean | `false` | resource | For Claude, additionally writes unredacted debug, stream, and verbose artifacts. Codex and Agy currently ignore this setting. Changes apply to the next invocation. |
| `schegent.logging.rawTranscriptMode` | `always`, `errors-only`, or `off` | `errors-only` | resource | Raw-transcript policy frozen when a Run begins. Structured audit remains enabled in every mode. |
| `schegent.logging.sessionRetentionMaxAgeDays` | integer, `1`–`3650` | `30` | resource | Age limit for complete, inactive, unredacted session artifacts. |
| `schegent.logging.sessionRetentionMaxBytes` | integer, `1048576`–`10737418240` | `536870912` | resource | Total byte budget for complete, inactive, unredacted session artifacts. |
| `schegent.logging.runtimeLogLevel` | `DEBUG`, `INFO`, `WARN`, or `ERROR` | `INFO` | resource | Minimum severity appended to the runtime log; read on each emit. |
| `schegent.logging.runtimeLogFilePath` | string | empty string | resource | Empty resolves to `.schegent/syslog`. Workspace-relative paths are accepted. Absolute paths are accepted only inside the canonical workspace, extension `globalStorage`, or OS temp roots; the home directory is deliberately excluded. Relative traversal is rejected. |
| `schegent.logging.runtimeLogMaxBytes` | integer, `65536`–`1073741824` | `5242880` | resource | Active runtime-log size before rotation. |
| `schegent.logging.runtimeLogMaxGenerations` | integer, `0`–`20` | `3` | resource | Number of numbered runtime-log generations retained. |
| `schegent.fatalSignatures` | array of strings | `[]` | resource | Operator-additive stdout/stderr substrings that fail an invocation immediately; code-resident signatures cannot be removed here. |

<!-- Source: package.json -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: src/lib/fatal-signature-registry.ts -->

Unredacted transcripts and verbose diagnostics can contain prompts, source code, and model output. The two session-retention settings prune only complete inactive-run artifacts; they do not prune the active Run or the structured audit log.

<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

## UI, trust, and Claude-specific behavior

| Setting | Type and accepted values | Default | Scope | Purpose |
|---|---|---|---|---|
| `schegent.claude.autoCompactPctOverride` | integer `1`–`100`, or `null` | `null` | resource | When non-null, exports `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for Claude. |
| `schegent.multiRoot.suppressWarning` | boolean | `false` | window | Suppresses the activation warning that the first folder is Schegent's canonical workspace. |
| `schegent.ui.confirmations.enable` | boolean | `true` | window | Globally enables the sidebar's destructive-action confirmations; which actions those are is declared by the `ActionKey` union in `webview-ui/src/lib/action-copy.ts`. Reset Workspace is confirmed host-side by its Command Palette command, outside this setting's reach. |
| `schegent.trust.allowCustomPhases` | boolean or `null` | `null` | window | Capability gate for saving custom Phase definitions; Workspace Trust is an upper bound. |
| `schegent.trust.allowCustomRetryConditions` | boolean or `null` | `null` | window | Capability gate for non-default retry-condition expressions; Workspace Trust is an upper bound. |

<!-- Source: package.json -->
<!-- Source: src/lib/auto-compact-override.ts -->
<!-- Source: src/state/multi-root-warning.ts -->
<!-- Source: src/state/confirmations-config.ts -->
<!-- Source: webview-ui/src/lib/action-copy.ts -->
<!-- Source: src/state/capability-trust-resolver.ts -->

## Evidence privacy profiles

`FR-R3-127`. The evidence store's posture is four settings — `schegent.logging.verbose`,
`schegent.logging.rawTranscriptMode`, `schegent.logging.sessionRetentionMaxAgeDays` and
`schegent.logging.sessionRetentionMaxBytes`. Deriving a safe combination from them one at a time is
the problem the repository audit of 2026-08-27 named, so they are also published as **three named
profiles** in `src/contracts/privacy-profiles.ts`. The Settings tab shows which profile the current
values are, or `custom` with the fields that differ, and applies one in a single action.

| Profile | verbose | rawTranscriptMode | retention age | retention bytes | Who it is for |
|---|---|---|---|---|---|
| `ephemeral` | `false` | `off` | 1 day | 1 MiB | A shared account, a managed endpoint, or a home directory that is backed up or synchronized off the machine. Keeps the least unredacted evidence this product can keep. |
| `diagnostic` | *the shipped default* | *the shipped default* | *the shipped default* | *the shipped default* | A single informed local operator debugging their own Runs on a machine they control. **These are the defaults**, named so that keeping them is a decision rather than an absence of one. |
| `forensic` | `true` | `always` | 365 days | 4 GiB | An incident you expect to investigate later, on a machine whose disk you are willing to treat as holding the material. |

**`diagnostic`'s values are not written here on purpose.** They are read from the shipped defaults, so
a moved default moves the profile rather than leaving a second copy behind — the drift this project has
closed repeatedly. Look them up in the two retention rows above and in
[the retention disclosure](../operations/evidence-retention-disclosure.md), which derives every bound
from the constant that enforces it.

### What a profile does not change

Every profile carries these residuals, and they are stated on the profile rather than once here,
because an operator reads the profile they are choosing:

- **Recovery checkpoints keep unredacted binary Git diffs for 14 days and 256 MiB.** That bound is a
  constant, not a setting, and **no profile changes it** — `FR-R3-012` decided that deliberately,
  because a wrong value is silent data loss in a directory an operator never opens. To reduce it, run
  `Schegent: Delete Run Evidence`.
- **The structured audit log is retained, and is redacted.** A profile decides how much *unredacted*
  evidence is kept; it does not turn evidence off.
- **`.gitignore` keeps evidence out of commits and does nothing about backup, sync, or
  endpoint-management tooling** copying it off the machine. That is the reason to pick `ephemeral` at
  all.
- **A profile is not a permission boundary.** An uncontained backend runs under your local authority
  and can read the evidence store whatever profile is selected (`FR-R3-125`).

`ephemeral` also gives up the thing `diagnostic` exists for: with raw capture `off`, a failed Run
leaves no transcript to diagnose from.

Nothing here is encrypted at rest, and that is a recorded decision rather than an omission — see
[the evidence-encryption declination](../architecture/evidence-encryption-declination.md).

## The trust-capability ladder

`schegent.trust.allowCustomPhases` and `schegent.trust.allowCustomRetryConditions` are three-state:
`true`, `false`, or `null` (the declared default, meaning *follow Workspace Trust*). They resolve
against `vscode.workspace.isTrusted` through a four-step ladder, and the rule is **any deny wins** —
an explicit `false` at either scope decides before any `true` is consulted (`FR-R3-108`).

<!-- executable-example: trust-deny-precedence -->

```
| isTrusted | workspace | user      | allowed |
|-----------|-----------|-----------|---------|
| false     | true      | true      | no      |
| true      | (unset)   | (unset)   | yes     |
| true      | false     | true      | no      |
| true      | true      | false     | no      |
| true      | true      | (unset)   | yes     |
| true      | (unset)   | true      | yes     |
| true      | false     | (unset)   | no      |
| true      | (unset)   | false     | no      |
| true      | null      | null      | yes     |
```

These rows are read by `tests/lint/documented-defaults-are-executable.test.ts` and fed through
`resolveCapabilityDecision` in `src/state/capability-trust-decision.ts`. Rows 3 and 4 are the ones
`FR-R3-108` changed: before it, the ladder consulted the workspace scope first, so a repository's
checked-in `true` defeated an operator's explicit `false`. Row 1 is the ceiling — an untrusted
workspace denies regardless of overrides.

## The capability posture setting

`schegent.backend.uncontainedBackends` — array of backend ids, default **`[]`**, `application` scope.

The backends you allow to run with **no OS-enforced bound** on what they can reach, **named one at a
time**. `claude` and `agy` are spawned with `--dangerously-skip-permissions`; `codex` carries a
`workspace-write` sandbox, is already contained, and is unaffected by this setting.

Because `schegent.backend.runner` defaults to `claude`, **a fresh install refuses its first run**
until `claude` is named here or a sandboxed backend is selected (FR-R3-056). Naming a backend is an
explicit acceptance of that authority **for that backend only** — allowing `agy` does not allow
`claude` (FR-R3-125).

Entries are validated rather than filtered, and neither case throws: an id that is not a backend
names the ids that are, and an id naming an already-contained backend says it grants nothing because
that backend was never refused. Anything that is not a list of strings grants nothing.

`application`-scoped on purpose: a workspace must not be able to grant itself the right to run an
unbounded agent, and the grant therefore applies to **every workspace you open in this
installation**, not only the one you granted it from. It is also deliberately **not** writable
through the workspace-scoped general-settings IPC surface, for the same reason.

**Replaces the removed boolean schegent.backend.allowUncontainedBackends, and the migration fails
closed on purpose.** That old key is written here without backticks deliberately: a backticked
setting key on a reference page is a control an operator can reach, and
`reference-doc-claims.test.ts` refuses one that the manifest does not declare — which is correct, and
this key is genuinely gone. It is read by nothing, so a stale `true` grants nothing:
name the backends you actually want. Reading both keys was considered and rejected — two keys
answering one safety question is the duplicate-authority defect this project has removed repeatedly,
and the fallback branch that mishandles the old boolean is the one that fails *open*.

See [Agent capability posture](../architecture/agent-capability-posture.md),
[Backend containment qualification](../architecture/backend-containment-qualification.md) for what
containment is actually available per backend and platform, and
[Running Schegent on a repository you do not trust](../operations/untrusted-repositories.md) for when
naming a backend here is and is not acceptable.

## Run request budgets (not configurable)

FR-R3-057. A run request is bounded at validation, **before** it is persisted, frozen, built into a
prompt, or written to stdin. These are fixed constants in
`src/contracts/validators/run-request-budgets.ts`, not settings: they exist so that one local input
cannot amplify into memory, persisted state, stdin volume, tokens and provider cost, and an operator
who could raise them could re-create exactly that.

Every budget counts **UTF-8 bytes**, not characters. A character budget under-counts by up to 4x on
non-ASCII input, which is the wrong direction for a resource bound.

| budget | limit | error code |
|---|---|---|
| one contract input's value | 1 MiB | `input-value-too-large` |
| one supplemental text or instruction item | 1 MiB | `supplemental-value-too-large` |
| one supplemental path | 4096 B (`PATH_MAX`) | `supplemental-value-too-large` |
| one supplemental URL | 2048 B | `supplemental-value-too-large` |
| one output target | 4096 B | `output-target-too-long` |
| number of inputs | 64 | `inputs-count-exceeded` |
| number of supplemental items | 256 | `supplemental-count-exceeded` |
| number of outputs | 64 | `outputs-count-exceeded` |
| **the whole request, summed** | **4 MiB** | `request-bytes-exceeded` |

The aggregate is the one that matters most, because per-field budgets do not compose: 256
supplemental items of 1 MiB each is 256 MiB with every individual field inside its limit.

A violation is reported as a typed `RunRequestFieldError` carrying `limit` and `actual`, alongside
every other failing field — an operator who pasted three oversized inputs learns all three at once.
A rejected request mutates nothing. The same budgets also refuse the payload at the transport
predicate, so a request this large does not reach the code that would report on it.

**Measured ceiling.** A request at exactly the 4 MiB aggregate produces 4,195,498 bytes of prompt
(1.0003x) — the prompt is the request text plus bounded framing. That number is the input to the
per-host memory arithmetic in FR-R3-052.

`schegent.*` settings have their own separate limits, listed above. The one overlap is
`instructions`, which additionally carries the pre-existing character-based
`instructions-too-long` limit shared with queue item descriptions; the aggregate above counts its
bytes regardless.

## Where writes go

The General Settings webview does not accept arbitrary keys. Its host allowlist covers only the scalar settings represented by `KEY_SPECS`; the host validates the entire update batch before writing any accepted value to VS Code's workspace target and rolls back earlier writes if a later write fails. Backend selection, model entries, environment-policy controls, trust gates, and other settings use their owning surfaces instead of that general-settings payload.

<!-- Source: src/config/general-settings.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-save-general-settings.ts -->

Values may also be edited through VS Code's normal Settings UI or workspace JSON according to their declared scope. The supported environment-variable surface is documented separately in [System configuration](system-config.md); Schegent does not read a repository `.env` file.

<!-- Source: package.json -->
<!-- Source: src/config/settings-schema.ts -->
