# What Schegent keeps on this machine

**Audience**: any operator running Schegent. **Status**: derived — see below.

Schegent writes its own evidence to your workstation and makes no network call of its own, apart from
the optional OTLP telemetry export, which is off by default (`schegent.telemetry.export.enabled: false`)
and sends metadata only. That does **not** mean your content stays on this machine: the backend CLIs
that Schegent drives (`claude`, `codex`, and `agy`) transmit prompts, repository content they read, and
any opted-in phase-context handoff blocks or artifacts to the model vendor, whatever the capture settings
below say, and no local retention setting changes that (see
[local-first, not offline](../concepts/local-first-not-offline.md)). This page is the single retention
and egress inventory: what Schegent writes, where it lives, whether it is redacted, when confirmation
applies, what can leave the machine, and who owns deletion for every copy. It exists because `PRIV-01`
and `FR-R7-14` (`14-14`) require one honest account across local stores, provider CLIs, and remote
collectors.

## Derived, not written

**Every bound in the table below is read from the constant that enforces it**, by
`repo/src/services/retention-disclosure.ts`. There is no second number to keep in step, and
`repo/tests/lint/retention-disclosure-parity.test.ts` fails if this document and those constants
disagree.

That mechanism is the point. This class of defect recurred three times in this round — operator-facing
text asserting a property nothing checks — and each previous fix was an edit, after which the text
drifted again.

## What is kept

| Store | Location | Content | Bounds | Swept by | Live protection | On delete | On export | Derived from |
|---|---|---|---|---|---|---|---|---|
| Structured audit log | `.schegent/audit.log`, `.schegent/audit.log.<stamp>` | metadata, redacted | rotates at 5 MiB or 30 days (age measured from the generation's oldest usable row), whichever comes first; at most 10 archives are kept, each at most 90 days; each payload is truncated above 32 KiB | rotation, activation | the live log is never pruned; only rotated archives are, and each prune is recorded as a cut | kept | included whole (shared) | `AUDIT_ROTATION_DEFAULT_SIZE_BYTES / AUDIT_ROTATION_DEFAULT_AGE_MS / AUDIT_ARCHIVE_DEFAULT_MAX_COUNT / AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS in src/audit/audit-log-writer.ts; AUDIT_PAYLOAD_MAX_BYTES in src/audit/audit-payload.ts` |
| Audit cuts | `.schegent/audit.log.cuts` | metadata, redacted | one small record appended each time an archive is pruned, so the chain verifier can tell a prune from a deletion; no bound of its own | none | append-only; the writer never rewrites it | kept | included whole (shared) | `AUDIT_CUTS_BASENAME in src/audit/audit-chain.ts` |
| Audit head checkpoint | `<globalStorage>/audit-checkpoints/<key>.json` | metadata, redacted | one small file per workspace location, holding a digest, a position and times only; never pruned, and retired only by the reset command; a moved folder leaves its old file behind | none | replaced in place by the window that owns the workspace | kept | n/a | `checkpointKey in src/audit/audit-checkpoint.ts; the store in src/audit/audit-checkpoint-store.ts` |
| Audit generation sidecar | `.schegent/audit-generation.json` | state, redacted | one small file recording when the live audit generation was first observed, used to age a generation whose rows carry no usable time; no bound of its own | rotation | keyed by the live generation, so a rotation starts a fresh record | kept | n/a | `AUDIT_GENERATION_SIDECAR_NAME in src/audit/audit-generation-sidecar.ts` |
| Raw session transcript (retained) | `.schegent/sessions/raw-<runId>.log` | unredacted content, **not redacted** | kept for `always`, or promoted for a non-clean Run under `errors-only` (removed if that same Run is later resumed to `completed`); removed by the session retention settings (default 30 days and 512 MiB), whichever removes it first | run-end, activation, settings-change, periodic | a Run that is executing or paused is never selected | removed | included | `src/audit/raw-transcript-writer.ts; schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes` |
| Raw session transcript (pending) | `.schegent/sessions/.pending/raw-<runId>.log` | unredacted content, **not redacted** | holds an `errors-only` Run's transcript until it ends: promoted to the retained name if the Run failed, was canceled or paused, removed (along with any earlier promoted leg for the same Run) if it completed; otherwise swept by the session retention settings (default 30 days and 512 MiB), whichever removes it first | run-end, activation, settings-change, periodic | a Run that is executing or paused is never selected | removed | omitted | `src/audit/raw-transcript-writer.ts; schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes` |
| Raw transcript spool | `<temp>/schegent-raw-spool-<pid>-<suffix>/stdout`, `<temp>/schegent-raw-spool-<pid>-<suffix>/stderr` | unredacted content, **not redacted** | the backend's output while one invocation runs, in the operating system's temporary area and outside the workspace; removed when the invocation ends, and a spool left by a process that has died is removed by the next writer's scavenge | run-end | a spool is named for the process that made it, so a live process's spool is not reaped | n/a | n/a | `RAW_SPOOL_PREFIX in src/audit/raw-transcript-writer.ts (not exported; checked by tests/unit/services/retention-inventory.test.ts)` |
| Run diagnostics trees | `.schegent/sessions/<runId>/diagnostics/<pipeline>/<phase>/<iteration>/<file>` | unredacted content, **not redacted** | the verbose diagnostic files (`stream.jsonl`, `debug.json`, `verbose.log`) of one phase iteration; by the session retention settings (default 30 days and 512 MiB), whichever removes it first | run-end, activation, settings-change, periodic | a Run that is executing or paused is never selected | removed | included | `schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes` |
| Run transport (CLI stream lines) | `.schegent/sessions/<runId>/transport.log` | redacted content, redacted | kept when the transport mode keeps it (removed under `errors-only` if the same Run is later resumed to `completed`); at most 5 MiB per Run and 20 MiB across all Run files and legacy generations, with records older than the session retention age removed; secret patterns redacted, otherwise CLI content as sent | append, run-end, periodic | the pass does not age an active Run's file, and the total is enforced without removing it | removed | included | `TRANSPORT_FILE_MAX_BYTES / TRANSPORT_WORKSPACE_MAX_BYTES in src/monitor/transport/transport-policy.ts; schegent.logging.transportCaptureMode` |
| Transport stage (errors-only, while a Run is active) | `<temp>/schegent-transport-<key>/<runId>.log` | redacted content, redacted | holds an `errors-only` Run's transport until it ends (remaining staged while `paused`): promoted to its Run file if the Run failed or was canceled, removed if it completed; at most 5 MiB per Run, outside the workspace and outside the total | run-end, periodic | a stage is promoted or removed only when its Run is known to have ended; while the Run runs it is only aged by the retention age | n/a | n/a | `TRANSPORT_FILE_MAX_BYTES / TRANSPORT_SPOOL_PREFIX in src/monitor/transport/transport-policy.ts` |
| Legacy transport generations | `.schegent/cli-transport.log`, `.schegent/cli-transport.log.<n>` | redacted content, redacted | no longer written (at most 3 numbered generations from an earlier release); each file expires whole by its newest record at the session retention age, and counts toward the Run-transport total | run-end, periodic | no Run writes it, so there is nothing to protect | kept | omitted | `CLI_TRANSPORT_FILE_NAME / CLI_TRANSPORT_MAX_GENERATIONS in src/monitor/cli-transport-sink.ts` |
| Failure records | `.schegent/failure-records/<record>` | redacted content, redacted | one record per failed Run, at most 32 KiB each; at most the newest 200 are kept, each for the session retention age (default 30 days) | run-end, activation, settings-change, periodic | a record is written once and never rewritten | removed | included | `FAILURE_RECORD_RETAINED_MAX / FAILURE_RECORD_MAX_BYTES in src/contracts/failure-record.ts; schegent.logging.sessionRetentionMaxAgeDays` |
| Run history descriptions | `.schegent/history/<description>` | redacted content, redacted | the operator's description of a Run; a description no history entry refers to is removed once it is 24 hours old, at most 200 per activation | activation | a description newer than 24 hours may still be mid-write and is kept | kept (Run history) | included | `HISTORY_ORPHAN_GRACE_MS / HISTORY_SWEEP_MAX_REMOVALS in src/services/history/history-description-store.ts` |
| Metrics rollup | `.schegent/metrics-rollup.jsonl` | metadata, redacted | one record per terminal Run; trimmed to the newest 5,000 records when it passes 8 MiB; totals carried forward | append | appended once per Run id, at the terminal transition | kept | n/a | `TRIM_THRESHOLD_BYTES / RETAINED_RECORDS_AFTER_TRIM in src/metrics/metrics-rollup-writer.ts` |
| Runtime log | `.schegent/syslog`, `.schegent/syslog.<n>` | redacted content, redacted | sanitized host diagnostics; rotates at 5 MiB and keeps 3 generations by default (the two `schegent.logging.runtimeLog*` settings); no age bound, by decision: its path can be configured outside the workspace, where an age sweep would delete files in a place you chose; default location | rotation | the live file is rotated, never deleted by a sweep | kept | n/a | `schegent.logging.runtimeLogMaxBytes / schegent.logging.runtimeLogMaxGenerations in src/config/settings-schema.ts` |
| Ownership records | `.schegent/ownership/<record>` | state, redacted | small records of which window holds the workspace; each is replaced in place by the window that owns it and removed when it is released; they hold no evidence content | none | a record is changed only by its owner | kept | n/a | `src/state/ownership-fs.ts` |
| Process catalog | `.schegent/catalog/<entry>` | state, redacted | the saved process definitions; at most 50 versions are kept, and a version a Run or history entry refers to is not pruned | append | the active and draft versions and any version a Run refers to are exempt | kept | n/a | `CATALOG_RETENTION_BOUND in src/contracts/catalog-store.ts` |
| Evidence .gitignore | `.schegent/.gitignore` | state, redacted | one small file that keeps this directory out of commits; created beside the first evidence written, and replaced when an existing one no longer ignores every path | none | not applicable | kept | n/a | `src/audit/schegent-gitignore.ts` |
| Private recovery checkpoints | `<globalStorage>/checkpoints/<runId>/<file>` | recovery material, **not redacted** | 14 days and 256 MiB total, with the 10 most recent Run directories protected from the size limit; deliberately outside the workspace | activation | active and paused Runs are pinned against both limits; the 10 most recent Run directories are protected from the size limit | removed | n/a | `CHECKPOINT_MAX_AGE_MS / CHECKPOINT_MAX_TOTAL_BYTES / CHECKPOINT_RECENT_RUN_FLOOR in src/services/run-checkpoint-retention.ts` |
| Workspace memento state | `<workspaceState>/schegent.*` | state, redacted | the Run map, queues and history that survive a reload; history is capped at 50 entries per queue, the oldest dropped first | append | the cap applies to history entries only | kept | n/a | `HISTORY_CAP_PER_QUEUE in src/state/workspace-state.ts` |
| Operator pseudonym | `<workspaceState>/schegent.operatorPseudonym` | state, redacted | one random label of the form `pseudonym-` and 16 hex digits, made on first use and written into audit rows in place of an account name; replaced only by the reset command, which records the reset first | none | not applicable | kept | n/a | `schegent.operatorPseudonym in src/state/workspace-state.ts; src/lib/operator-attribution.ts` |
| Export, audit-export and bundle destinations | `<destination>/<export>` | redacted content, redacted | a directory or file you choose (run evidence exports create a fresh owner-only child directory per invocation); each artifact is carried up to 16 MiB and anything larger is omitted with the reason in the manifest; owner-only permissions; Schegent never removes or ages what it exported | none | not applicable: outside the workspace once written | n/a | n/a | `MAX_ARTIFACT_BYTES in src/services/evidence-export.ts` |
| SQLite application store | `<globalStorage>/sqlite/<scope>/schegent-state.db`, `<globalStorage>/sqlite/<scope>/schegent-state.db-wal`, `<globalStorage>/sqlite/<scope>/schegent-state.db-shm` | unredacted content, **not redacted** | folder-keyed operational store (schema 9, min reader 9) holding queues, Runs, catalog versions, usage accounting ledgers, artifact metadata/tombstones, telemetry ledgers, and opted-in phase-context handoff records (up to 64 KiB manifest / 32 KiB rendered context each); no automatic age bound; lives outside the workspace and survives workspace deletion | none | single-writer SQLite WAL owned by the primary trusted window; protected against agent writes and Run evidence deletion | kept | n/a | `SQLITE_SCHEMA_CURRENT_VERSION / SQLITE_MIN_READER_VERSION in src/contracts/sqlite-store/schema-types.ts; src/services/sqlite-store/storage-location-resolver.ts` |
| SQLite store backups | `<globalStorage>/sqlite/<scope>/backups/<backupId>.db`, `<globalStorage>/sqlite/<scope>/backups/<backupId>.db.manifest.json` | recovery material, **not redacted** | operator-created online snapshots via `Schegent: Back Up Store`; bounded at 512 MiB database image, 16 MiB manifest, 10,000 external dependencies, and 512 MiB external dependency bytes; no automatic age sweep; lives outside the workspace and survives workspace deletion | none | read-only snapshot image and manifest; never pruned automatically and never modified by Delete Run Evidence | kept | n/a | `MAX_BACKUP_DATABASE_BYTES / MAX_BACKUP_MANIFEST_BYTES in src/services/sqlite-store/backup-manifest-store.ts; MAX_BACKUP_EXTERNAL_DEPENDENCIES / MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES in src/contracts/sqlite-store/schema-types.ts` |
| External artifact and live-log bytes | `.schegent/transcripts/<artifact>`, `.schegent/diagnostics/<artifact>`, `.schegent/reports/<artifact>` | unredacted content, **not redacted** | artifact-lifecycle-managed external blobs, reports, and live-log segments indexed in SQLite (`artifacts`, `artifact_locations`, `live_log_segments`); aged only under an adopted F05 retention policy revision from terminal settlement, while deletion tombstones remain in SQLite | activation, run-end | artifacts pinned by active or paused Runs or active handoff owner references are exempt until terminal settlement commits | kept | omitted | `buildScanRoots in src/activation/sqlite-cutover-helpers.ts; src/services/artifact-lifecycle/retention-policy.ts` |
| Phase-context handoff publications and materialized copies | `.schegent/results/<rootAlias>/<attemptAlias>/<file>`, `.schegent/immutable-results/<attemptAlias>/<file>`, `.schegent/handoff-materialized/<attemptAlias>/<file>`, `.schegent/foreach-results/<file>` | unredacted content, **not redacted** | created when a workflow connection opts in via `contextPolicy` (or stages attempt outputs); staged JSON capped at 256 KiB, cross-root materialized copies capped at 64 files / 16 MiB per file / 64 MiB total; registered and pinned in F05 until terminal workflow settlement commits | run-end, activation | F05 owner-reference pins hold captured and materialized handoff files until the workflow terminal revision commits | kept | omitted | `PHASE_CONTEXT_LIMITS in src/contracts/phase-context/context-policy.ts; src/services/phase-context/attempt-result-publisher.ts; src/services/phase-context/handoff-materializer.ts` |
| Opt-in OTLP telemetry spool | `<globalStorage>/telemetry-spool/<batch>` | metadata, redacted | off by default (`schegent.telemetry.export.enabled: false`); when opted in, spools metadata-only OTLP metric batches up to 32 MiB total and 24 hours per batch, indexed in SQLite `telemetry_spool_batches`; remote collector copies are owned and deleted outside Schegent | append, activation, settings-change | reconciled on startup and settings change; oldest batches drop when the spool cap or expiry is exceeded | kept | n/a | `TELEMETRY_EXPORT_BOUNDS in src/contracts/telemetry-export.ts; schegent.telemetry.export.enabled; src/services/telemetry-host/telemetry-durable-store.ts` |

The 90-second stall threshold is a constant (`MONITOR_STALL_THRESHOLD_MS`), not a setting: a Run that has been silent that long is reported as stalled, and no setting changes it.

Run-owned runtime messages include structured `runId` and `phase` context, including backend invocation,
teardown and monitor audit failures. Diagnostics bundles use that context to select the requested Run's
lines. Window-wide messages remain unattributed; older lines without context cannot be assigned to a Run.

## Older audit rows, and when a sweep runs

**Older audit generations can hold content.** Before this release the audit log could carry stream content
in some rows. Those generations are not rewritten or erased selectively: they are listed in an export's
manifest, and they leave the workspace only the way every audit generation does, whole, in a normal
retention cut that the chain verifier can still follow. Deleting a Run's evidence never touches the audit
log.

**Older rows can name an operating-system user.** New rows carry a random pseudonym of the form
`pseudonym-` and 16 hex digits, stored in the extension's private workspace storage and never derived from
your account name. Rows written before that, and any override you stored, may hold your OS username, and
they are not rewritten. A pseudonym is still linkable metadata: it ties every row from one editor user in
one workspace together, and `Schegent: Reset Operator Pseudonym` changes only the rows written after it.

**An age bound and the time a sweep runs are different things.** An age says when evidence becomes eligible
for removal. Removal itself happens when something looks, and what looks differs by store: the "Swept by"
column above names it. The host looks when it starts, when a Run ends, when a retention setting changes,
and once an hour in an idle window that owns the workspace, but the hourly look reaches only the session
groups (raw transcripts and diagnostic trees), the failure records and the CLI transport. The rotated
audit archives (also pruned when the log rotates), the private recovery checkpoints and the history
descriptions are looked at when the host starts, and not again while it stays open. Evidence the hourly
look reaches can therefore outlive its age by up to an hour in an open window; the rest, for as long as
the host stays open; and all of it, for as long as the host stays closed.
Audit files, current and archived, are owner-only (`0600`).

## Artifacts that are deliberately unredacted

Multiple local stores hold unredacted content by design — not only raw session transcripts. Each is
classified as **not redacted** in the derived table above:

- `.schegent/sessions/raw-<runId>.log` (and its `.pending/` staging file and `<temp>/schegent-raw-spool-*/`
  invocation capture) holds the backend's prompts and output **verbatim** — deliberately unredacted as a
  developer-debug artefact, comparable to terminal scrollback, never read back into control decisions,
  never shipped to a webview, and gitignored.
- `.schegent/sessions/<runId>/diagnostics/` holds verbose diagnostic dumps (`stream.jsonl`, `debug.json`,
  `verbose.log`).
- `<globalStorage>/checkpoints/<runId>/` holds unredacted Git recovery diffs outside the workspace.
- `<globalStorage>/sqlite/<scope>/schegent-state.db` (and its WAL/SHM files) holds operational workflow
  state, prompts, and opted-in `phase_handoff_records` verbatim outside the workspace.
- `<globalStorage>/sqlite/<scope>/backups/<backupId>.db` (and its manifest) holds a full point-in-time
  copy of the operational SQLite store, including opted-in `phase_handoff_records`.
- `.schegent/transcripts/`, `.schegent/diagnostics/`, `.schegent/reports/`, `.schegent/results/`,
  `.schegent/immutable-results/`, `.schegent/handoff-materialized/`, and `.schegent/foreach-results/`
  hold F05-managed external artifact bytes and F15-B staged/immutable/materialized phase-context
  handoff and ForEach result-index files verbatim.

If your prompts, diffs, or repository contain secrets, any of these unredacted local stores can contain
them too. That is the reason this inventory exists rather than a reason it does not.

**The export is the exception, and deliberately so.** An export crosses a trust boundary that a local
file does not — someone else receives it — so every exported artifact is redacted on the way out,
including raw transcripts. Redacting more than the product's own set is fine; redacting less is not.

## Unified 8-copy retention and egress inventory

Deleting a workspace directory or running `Schegent: Delete Run Evidence` does **not** erase every copy
produced by running Schegent. The table below unifies all eight local, provider, and collector copy
categories, what can leave the machine, when confirmation applies, and who can delete each copy:

| # | Copy category | Location / destination | Leaves machine? | Confirmation gate | Deletion owner |
|---|---|---|---|---|---|
| 1 | Folder-scoped SQLite store | `<globalStorage>/sqlite/<scope>/schegent-state.db` (`-wal`, `-shm`) | No (local disk outside workspace) | Workspace Trust required for writes | Operator manually deletes `<globalStorage>/sqlite/<scope>/` (survives workspace deletion and `Schegent: Delete Run Evidence`) |
| 2 | Separate SQLite backups | `<globalStorage>/sqlite/<scope>/backups/<backupId>.db` + `.db.manifest.json` | No (local disk outside workspace) | Explicit `Schegent: Back Up Store` command | Operator manually removes backup files (never pruned automatically; survives workspace deletion and `Delete Run Evidence`) |
| 3 | External artifact & handoff bytes | F05 blobs/live logs (`.schegent/transcripts/`, `.schegent/diagnostics/`, `.schegent/reports/`) and F15-B `.schegent/results/`, `.schegent/immutable-results/`, `.schegent/handoff-materialized/`, `.schegent/foreach-results/` | Only if selected by an opted-in handoff route or read by a backend CLI | Opt-in `connection.contextPolicy` (`manual` or `automatic` approval) for handoff delivery | F05 lifecycle retention (after terminal workflow settlement commits and pins release) or operator deleting `.schegent/`; `Delete Run Evidence` does not remove attempt-keyed F05/F15-B directories |
| 4 | Raw unredacted staging & retained transcripts | `<temp>/schegent-raw-spool-<pid>-<suffix>/`, `.schegent/sessions/.pending/raw-<runId>.log`, `.schegent/sessions/raw-<runId>.log`, `.schegent/sessions/<runId>/diagnostics/` | No (local disk/temp; exported copies are redacted first) | Default `errors-only` keeps failed/paused/canceled Runs until aged or deleted; `Delete Run Evidence` prompts with a modal confirmation | `Schegent: Delete Run Evidence` (when Run is not active), automatic session retention sweep (30 days / 512 MiB), or operator deleting `.schegent/` |
| 5 | Shared audit chain & external head checkpoint | `.schegent/audit.log`, `.schegent/audit.log.<stamp>`, `.schegent/audit.log.cuts`, `.schegent/audit-generation.json`, `<globalStorage>/audit-checkpoints/<key>.json` | No (metadata-only local chain; `Schegent: Export Metadata-Only Audit` writes local file) | `Schegent: Reset Audit History Checkpoint` confirms retiring the external checkpoint | Workspace log rotates/prunes by settings; `Delete Run Evidence` never erases audit history; external checkpoint survives workspace deletion until retired by `Schegent: Reset Audit History Checkpoint` or manual `<globalStorage>` cleanup |
| 6 | Per-provider CLI histories | `<home>/.claude/`, `<home>/.codex/`, `<home>/.gemini/antigravity/` | Vendor CLI sync/retention policies apply outside Schegent | `schegent.backend.uncontainedBackends` opt-in for uncontained backends (`claude`, `agy`, or unqualified `codex`) | Vendor CLI / operator outside Schegent — never touched by Schegent privacy profiles, sweeps, or `Delete Run Evidence` |
| 7 | Opt-in metadata-only OTLP spool & remote collector | Local spool `<globalStorage>/telemetry-spool/` + SQLite `telemetry_spool_batches` (32 MiB / 24 h cap) → configured HTTPS/loopback OTLP collector | **Yes (metadata-only metrics)**, only when `schegent.telemetry.export.enabled` is `true` | User-scoped application setting (`schegent.telemetry.export.enabled`, default `false`) plus trusted workspace | Local spool ages/drops automatically (32 MiB / 24 h) or when disabled/reconfigured; remote OTLP collector data is owned and deleted solely by the collector operator outside Schegent |
| 8 | Phase-context handoff data & model-vendor egress | SQLite `phase_handoff_records` + `acpPromptBlocks` sent over ACP `session/prompt` to `claude`, `codex`, or `agy` → model vendor APIs | **Yes (prompts, repository context, and opted-in rendered handoff context / embedded ≤8 KiB text / resource-linked or materialized artifacts)** | Transition requires explicit `connection.contextPolicy` opt-in (`approvalMode: 'manual'` pauses for explicit revision approval before dispatch; `'automatic'` dispatches once ready); backend launch requires trust and containment allowance | Local SQLite record/files are owned by the operator; content transmitted to Anthropic (Claude), OpenAI (Codex), or Google (Agy) is governed by the provider's retention and deletion controls outside Schegent. See [phase-context-handoff.md](phase-context-handoff.md) for the full disabled vs opted-in transition trace. |

### Historical report exports (outside managed retention)

Historical reports exported from the sidebar Historical Reports panel or headless `ReportingApi` (`<file>.csv` or `<file>.json` plus `<file>.manifest.json`, written with owner-only `0600` permissions to a local path chosen outside `.schegent/`) carry **metadata only** (`privacyProfile: "metadata-only"` — no prompts, transcripts, logs, or artifact contents). Completed exported report files live **outside managed retention** (`retention: "outside-managed-retention"`): no automatic retention sweep, privacy-profile switch, `Schegent: Delete Run Evidence`, or deleting a saved report ever removes or edits a previously exported file on disk — deletion is owned solely by the operator. While an export is actively running, `ReportingService.activeExportRootIds()` pins the live report's root IDs in `querySqliteProtectedRunIds` so session retention sweeps spare referenced Run evidence until the export completes, cancels, or fails; abandoned staging partials (`<file>.<exportId>.{data,manifest}.partial`) from a host crash are cleaned up by `reconcileExports` after 2 minutes without touching unrelated files. See [Historical Reports and Exports](historical-reporting.md).

## Errors-only remains the default, and is evaluated at the Run level

This page describes what is **retained**. It does not change what is **captured**: the default session
retention is `errors-only`, and nothing in `FR-R3-085` alters it.

**Run-level `errors-only` across pause and resume (`FR-R5-F17`).** Under `errors-only`, `RawTranscriptWriter.finalizeRun` promotes `.schegent/sessions/.pending/raw-<runId>.log` to `.schegent/sessions/raw-<runId>.log` when a Run pauses, fails, or is canceled, and `TransportRouter.finalizeRun` promotes `<temp>/schegent-transport-<key>/<runId>.log` to `.schegent/sessions/<runId>/transport.log` when a Run fails or is canceled (holding the stage in `<temp>` while a Run is `paused`). If that same Run is later resumed (`resumeExisting` reuses `run.id`) and eventually reaches `completed`, both `RawTranscriptWriter.finalizeRun` and `TransportRouter.finalizeRun` delete the Run's pending/staged and promoted files. An operator who wants the earlier failed or paused leg's transcript or transport preserved even after a later resumed leg succeeds should export the Run's evidence before resuming or switch `rawTranscriptMode` / `transportCaptureMode` to `always` / `on`.

## What the backend CLIs keep in your home directory (`FR-R5-F17`)

The table in "What is kept" inventories the files **Schegent** writes and sweeps. Each backend CLI also writes its own session history under your home directory so it can resume conversations across turns, retries, and host restarts. **Schegent's privacy profiles (`ephemeral`, `diagnostic`, `forensic`), session-retention sweeps, `Schegent: Export Run Evidence`, and `Schegent: Delete Run Evidence` do not control, redact, export, or delete vendor-owned backend stores.**

| Backend store | Location pattern | Content | Vendor no-persistence switch | Requested by Schegent? | Schegent control | Derived from |
|---|---|---|---|---|---|---|
| `claude` (Claude Code CLI session store) | `<home>/.claude/projects/<project-slug>/<sessionId>.jsonl`, `<home>/.claude/` | unredacted prompts, tool calls, model output and session state (vendor-owned; exact file modes and vendor retention duration are controlled by Claude Code) | `--no-session-persistence` (observed in `claude --help` at 2.1.316; disables session persistence and prevents `--resume`) | not passed — Schegent relies on backend session ids for same-session retry, phase continuation, pre-phase compaction and manual resume | none — Schegent privacy profiles, session-retention sweeps, Export Run Evidence and Delete Run Evidence do not delete, export, redact or age files under `<home>/.claude/` | `src/runner/claude-cli.ts; docs/architecture/backend-containment-qualification.md` |
| `codex` (Codex CLI session store) | `<home>/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<sessionId>.jsonl`, `<home>/.codex/` | unredacted prompts, rollout events, tool output and session state (vendor-owned; exact file modes and vendor retention duration are controlled by Codex CLI) | `exec --ephemeral` (observed in `codex exec --help` at 0.163.0; suppresses rollout session files and prevents `exec resume`) | not passed — Schegent relies on persisted rollout sessions for same-session retry, phase continuation and manual resume | none — Schegent privacy profiles, session-retention sweeps, Export Run Evidence and Delete Run Evidence do not delete, export, redact or age files under `<home>/.codex/` | `src/runner/codex-cli.ts; docs/architecture/backend-containment-qualification.md` |
| `agy` (Antigravity CLI session store) | `<home>/.gemini/antigravity/` | unredacted conversation history and agent state (vendor-owned; exact store layout, file modes and vendor retention duration are unverified from `agy --help` at 1.4.12) | none observed in `agy --help` at 1.4.12 | not applicable — no no-persistence flag is exposed in `agy --help`, and conversation resume depends on backend-owned state | none — Schegent privacy profiles, session-retention sweeps, Export Run Evidence and Delete Run Evidence do not delete, export, redact or age files under `<home>/.gemini/antigravity/` | `src/runner/agy-cli.ts; docs/architecture/backend-containment-qualification.md` |

**Why Schegent does not pass `--no-session-persistence` or `exec --ephemeral` when `ephemeral` is selected.** Passing either switch suppresses the backend session file that `--resume` / `exec resume` reads, which breaks same-session retry, multi-turn phase continuation, pre-phase session compaction, and manual pause/resume after a host restart (and `agy --help` offers no equivalent switch at all). Selecting `ephemeral` therefore turns off Schegent's own raw transcript and transport capture without disabling the backend CLI's own session store.

## What you can do about it

| Want to | Command |
|---|---|
| See what is held for a Run | `Schegent: Export Run Evidence` — writes an archive plus a manifest of exactly what it contains and what it deliberately omits |
| Remove what is held for a Run | `Schegent: Delete Run Evidence` — reports what it removed **and** what it could not, and refuses rather than racing a live writer |

## What this page does not claim

- **On-disk evidence is not tamper-proof.** These are files under your own account's authority. The
  audit log carries a hash chain, and the extension keeps a small checkpoint outside the workspace; they
  reduce undetected loss and make an edit evident, and they prove nothing against the same OS user, who
  can edit both. The export carries a chain too, because its recipient is a different party — that is
  where a chain means something most.
- **Nothing here is encrypted at rest.** `FR-R3-085` stage 1 declined optional encryption for a
  stated reason: this product has no key store, and inventing one is a larger change than that item.
  `FR-R3-127` turned that into a record with a reversal trigger —
  [the evidence-encryption declination](../architecture/evidence-encryption-declination.md) — so the
  question is answered rather than re-asked. The short version: encryption's hard part is the key
  lifecycle, and the actor it would stop is one that already has the authority to read the key.
- **Which posture you are in is a choice with a name.** `FR-R3-127` publishes three privacy profiles
  — `ephemeral`, `diagnostic` (these defaults) and `forensic` — each stating what it keeps, who it is
  for, and what it does **not** change. See [the settings reference](../reference/settings.md).
  The decline is recorded with its reason rather than omitted.
