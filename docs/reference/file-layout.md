# File layout

Schegent has no ORM, Schegent HTTP server, or remote persistence service. After a one-time cutover in a trusted primary window, structured operational state (Runs, Queue entries, catalog definitions, the usage ledger and related records) is held in an embedded SQLite database, `schegent-state.db`, described in [the SQLite store section](#sqlite-operational-store) below. Before cutover, and for evidence, state is split between VS Code `workspaceState`, workspace-local files under `.schegent/`, and private recovery checkpoints in the extension's `globalStorage` directory. Generated build files and installed dependencies live elsewhere in the repository and are not runtime state.

<!-- Source: src/extension.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->
<!-- Source: package.json -->

## Workspace-local runtime tree

```text
<workspaceRoot>/
`-- .schegent/
    |-- .gitignore
    |-- audit.log
    |-- audit.log.<timestamp>
    |-- audit-generation.json
    |-- catalog/
    |   |-- manifest.json
    |   |-- phases/<phaseId>/v<N>.json
    |   |-- pipelines/<pipelineId>/v<N>.json
    |   `-- workflows/<workflowId>/v<N>.json
    |-- cli-transport.log            (legacy; no longer written)
    |-- cli-transport.log.1 ... .3   (legacy; no longer written)
    |-- failure-records/<stamp>_<suffix>_<runId>_<taskId>.json
    |-- history/<runId>.txt
    |-- metrics-rollup.jsonl
    |-- ownership/<resource-records>
    |-- sessions/
    |   |-- raw-<runId>.log
    |   |-- .pending/raw-<runId>.log
    |   `-- <runId>/
    |       |-- transport.log
    |       `-- diagnostics/<pipelineId>/<phaseId>/iter-<N>/
    |           |-- debug.json
    |           |-- stream.jsonl
    |           |-- verbose.log
    |           `-- phase-message.env
    `-- syslog
```

The tree is demand-created. In particular, an absent `.schegent/catalog/manifest.json` is the healthy empty catalog, not corruption, and a fresh extension ships no Phase or Workflow definitions.

<!-- Source: src/host-services/catalog-fs-adapter.ts -->
<!-- Source: src/catalog/catalog-paths.ts -->
<!-- Source: src/catalog/catalog-manifest.ts -->
<!-- Source: src/config/pipeline-config.ts -->

| Path | Format and ownership | Purpose |
|---|---|---|
| `.schegent/.gitignore` | Text containing `*`; created with exclusive-write semantics and never overwrites an existing file | Keeps all local runtime artifacts out of Git even in a workspace whose repository ignore file knows nothing about Schegent. |
| `.schegent/catalog/manifest.json` | Catalog store format v1; the only mutable catalog file | Records version lists and draft/active pointers. |
| `.schegent/catalog/{phases,pipelines,workflows}/<id>/v<N>.json` | Immutable JSON version record | Stores one exact definition version. IDs and version names are validated before becoming path segments. |
| `.schegent/audit.log` | Newline-delimited structured audit entries, schema v3; mode `0600` on POSIX, archives included | Primary metadata evidence. Rotation produces timestamped siblings; the writer defaults to 5 MiB and a 30-day rotation age. Host code appends. The log is tamper-**evident** but not tamper-proof: each entry carries the previous entry's digest (`src/audit/audit-chain.ts`), so an edit that does not recompute every later digest is detected by `npm run audit:verify`; an actor with write access to the same disk can recompute them. A head checkpoint kept outside the workspace (below) lets verification report a history that is shorter than it was, or missing. |
| `.schegent/audit.log.cuts` | Newline-delimited JSON cut records, version 2 (version 1 records are still read); mode `0600` on POSIX | One record per retention prune, naming the removed range's boundary digests. Version 2 adds how many chained and legacy rows left and the digest of the last legacy row removed, so a prune of the legacy-to-chain transition still verifies. Not itself chained; verification reads it first. |
| `<extension global storage>/audit-checkpoints/<key>.json` | One small JSON file per workspace location, mode `0600` in a `0700` directory, **outside the workspace**; `<key>` is a SHA-256 of the real workspace path, so no path appears in it | The audit head checkpoint: the digest and position of the newest landed row, with an origin and times. Never pruned; retired only by `Schegent: Reset Audit History Checkpoint`. A moved folder leaves its old file behind. |
| `.schegent/sessions/raw-<runId>.log` | Unredacted text, mode `0600` on POSIX | Retained raw transcript for `always`, or the promoted result for a non-clean `errors-only` Run. |
| `.schegent/sessions/.pending/raw-<runId>.log` | Temporary unredacted text | Workspace-side pending location used by errors-only transcript handling. Raw capture also uses a private `0700` OS-temp spool while a process is active. |
| `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/stream.jsonl` | Unredacted JSONL, mode `0600` on POSIX, in directories `0700` from `.schegent/` down | Per-iteration CLI stream capture. |
| The same `iter-<N>` directory's `debug.json`, `verbose.log`, and `phase-message.env` | Unredacted diagnostic and sidecar files. `verbose.log` is `0600` on POSIX; the backend writes the other two under its own umask, and the `0700` directories above them keep them private | Backend debug stream, verbose output, and host-resolved Phase message sidecar. |
| `.schegent/failure-records/<stamp>_<suffix>_<runId>_<taskId>.json` | UTF-8 JSON, at most 32 KiB, mode `0600` on POSIX in a `0700` directory | One redacted, path-free record per failed Run: the cause, the phase context, up to 20 bounded issue summaries and up to 16 metrics. Survives Remove; aged out by the session age setting and capped at the newest 200. |
| `.schegent/history/<runId>.txt` | UTF-8 text, mode `0600` on POSIX | Full Task description used for byte-identical reruns; the Memento history row holds only a preview and relative reference. |
| `.schegent/metrics-rollup.jsonl` | Append-only newline-delimited JSON, schema v2; v1 records are still read | One terminal summary per Run so cumulative totals survive audit rotation. A failed Run's record carries its `failureCause`. |
| `.schegent/sessions/<runId>/transport.log` | Line records, best-effort secret-pattern redacted; otherwise raw CLI content: one tab-separated record per CLI stream line; at most 5 MiB per Run; mode `0600` on POSIX in a `0700` directory | The Run's CLI transport, written when the transport capture mode keeps it (the transport capture mode setting in the Settings tab: `inherit`, `off`, `errors-only` or `on`). Redacted for secret patterns, otherwise CLI content as sent. Bounded by the workspace total and the session retention age; see the retention disclosure for each bound. |
| The transport stage, `<OS temp>/schegent-transport-<workspace key>/<runId>.log` | Same records, outside the workspace; `0600` in a `0700` directory | Where an `errors-only` Run's transport waits while the Run is active: promoted to its Run file if the Run failed or was canceled, removed if it completed. Not counted in the workspace total. |
| `.schegent/cli-transport.log` and `.1`–`.3` | Line records, best-effort secret-pattern redacted; otherwise raw CLI content, from an earlier release; mode `0600` on POSIX | Legacy: no longer written. Each file expires whole by its newest record at the session retention age and counts toward the workspace transport total. Delete Run Evidence leaves it, and says when it ages out. |
| `.schegent/audit-generation.json` | Small JSON record; mode `0600` on POSIX | When the live audit generation was first observed, kept so a generation whose rows carry no usable time can still be aged. Keyed by the generation, so a rotation starts a fresh record. |
| `.schegent/ownership/` | Private JSON records, directory `0700` and files `0600` on POSIX | Authoritative fencing records for window primacy and per-Queue execution leases. |
| `.schegent/syslog` | Runtime log, best-effort secret-pattern redacted; mode `0600` on POSIX, generations included | Default runtime-log path. A configured path may instead resolve under an allowed canonical workspace, extension `globalStorage`, or OS temp root. The operator's home directory is deliberately excluded. |

<!-- Source: src/audit/schegent-gitignore.ts -->
<!-- Source: src/contracts/catalog-store.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/audit-checkpoint-store.ts -->
<!-- Source: src/audit/audit-chain.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/services/phase-log/phase-log-path.ts -->
<!-- Source: src/audit/verbose-diagnostic-path.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/controller/phase-sidecar-reader.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/services/failure-record/failure-record-store.ts -->
<!-- Source: src/contracts/failure-record.ts -->
<!-- Source: src/metrics/metrics-rollup.ts -->
<!-- Source: src/metrics/metrics-rollup-writer.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/monitor/transport/transport-policy.ts -->
<!-- Source: src/audit/audit-generation-sidecar.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->

## Extension-private storage

Immediately before a Git-capable Phase, `RunCheckpointService` may write recovery files below:

```text
<globalStorage>/
`-- checkpoints/
    `-- <safeRunId>/
        |-- <timestamp>-<safePhaseId>.patch
        |-- <timestamp>-<safePhaseId>.json
        `-- <timestamp>-<safePhaseId>.declined.json
```

These checkpoints are outside the workspace so a repository cleanup cannot erase them along with the work they recover. A `.patch` can contain an unredacted binary Git diff and a `.json` file records the base commit and attribution decision; directories use mode `0700` and files use `0600` where supported. They are recovery material, not a second catalog or Run-state store. A separate fixed retention sweep applies a 14-day age limit and 256 MiB total limit, while protecting the ten most recent Run directories from the size limit. Session-retention settings do not govern checkpoints.

<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->

## SQLite operational store

Node's built-in `node:sqlite` (`DatabaseSync`) backs the operational store. The database is outside the workspace, in host storage:

```text
<storage>/
`-- sqlite/
    `-- <scope>/
        |-- schegent-state.db
        |-- schegent-state.db-wal
        `-- schegent-state.db-shm
```

`<storage>` is the extension's per-workspace `storageUri` directory, or `globalStorageUri` when the window has no workspace storage. `<scope>` is the first 16 hex characters of a SHA-256 of the workspace root path. The path is resolved only from those host-trusted roots; a webview, workspace setting or environment override is refused. Directories use mode `0700` and the database file `0600` where supported. WAL mode is refused on network filesystems. The schema is versioned and forward-only; a database written by a newer schema is refused. Writes are serialized through one writer. After cutover the store, not the Memento keys or the legacy JSON files, is authoritative for the 16 of 20 state surfaces that the census (`STRUCTURED_STATE_CENSUS`) marks `sqlite-authoritative`; the audit log, content-addressed blobs and log segment bytes, and UI layout preferences are not in that set. The contract, pragma profile, write limits and migration rules are in [SQLite application store](../operations/sqlite-application-store.md). The data-at-rest consequences are in [the threat model](../security/threat-model.md).

<!-- Source: src/services/sqlite-store/storage-location-resolver.ts -->
<!-- Source: src/activation/sqlite-cutover-wiring.ts -->
<!-- Source: src/contracts/sqlite-store/state-census.ts -->

## VS Code Memento state

`WorkspaceStateStore` writes keyed JSON-compatible values to `workspaceState`. The schema is forward-only; its current version is the `STATE_SCHEMA_VERSION` constant, stated and checked in [the Schema Versions table of `ARCHITECTURE.md`](../../ARCHITECTURE.md#schema-versions). The principal partitions are the Queue registry and Queue states, active Runs keyed by Queue, terminal history keyed by Queue, connected-run aggregates, execution-lease mirrors, confirmation suppression, watchdog state, and migration/reset markers. The authoritative ownership records remain on disk; Memento copies are projections or compatibility state where the owning contract says so.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/lock.ts -->

There is no down-migration command. On read, sequential migrators advance old Memento shapes up to the current `STATE_SCHEMA_VERSION` (see [the Schema Versions table of `ARCHITECTURE.md`](../../ARCHITECTURE.md#schema-versions)). Two different things happen to state that cannot be used as it stands. A persisted version newer than the running extension supports is **refused**: the error ends "Update the extension before opening this workspace.", and nothing is read. Separately, an individual malformed record is **quarantined**, kept aside rather than interpreted as current or discarded, and the rest of the state is read.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/workspace-state.ts -->

## Path safety and retention

Security-sensitive filesystem adapters generally perform a containment check appropriate to the operation before reading, writing, renaming, or removing a path. The shared canonical-path oracle distinguishes following a target from manipulating a directory entry; the catalog, transcript, ownership, history, checkpoint, and runtime-log adapters refuse when containment cannot be proved. The live audit append is included rather than excepted: `doWrite()` opens through the safe walk on every write instead of joining a path and appending, so a `.schegent` symlink planted in the workspace cannot redirect the append-only record. It re-walks per append rather than holding a descriptor, because rotation replaces the file underneath a retained handle. (An earlier revision of this page recorded that append as a residual symlink risk; FR-R3-053 closed it and the sentence outlived the code — found by the 2026-08-25 criterion-8 review, `docs/audits/criterion-8-review-2026-08-25.md` F1.) Lexical validation is additional defense for IDs and stored references, not a substitute for resolving filesystem links.

<!-- Source: src/lib/path-containment.ts -->
<!-- Source: src/host-services/catalog-fs-adapter.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->

Retention differs by artifact: audit archives, unredacted session artifacts, failure records, private recovery checkpoints, runtime logs, CLI transport generations, and history descriptions each have their own owner and bound. Deleting one class does not imply deletion of the others. Use the owning settings or operation rather than deleting a broad `.schegent/` tree while Schegent is active.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/services/history/history-description-store.ts -->

## Scheduled entries left by earlier releases

Releases 014, 024 and 031 shipped a Wake up scheduler that installed a real entry in the operating
system's scheduler so a wake-up could fire while VS Code was closed. Commit `f702c0b2` (2026-08-12)
deleted that feature **and** the cleanup machinery that used to remove those entries, so the current
release cannot uninstall what an earlier one installed. A machine that enabled Wake up before that
date still has the entry, and removing it is a manual step.

What the orphan does is fire on its schedule and fail. The entry invokes an absolute path to a
runner bundle that no longer exists, so each firing is a process that exits immediately; output was
already redirected to `/dev/null` at install time. It consumes no Claude allocation and reaches no
workspace. It is stale scheduler state, not a live capability — but it is state that nothing will
clean up on your behalf, and it will outlive the extension itself if you uninstall Schegent.

Only one of these was installed, chosen by platform at install time. Check the ones listed for your
platform; a command that finds nothing means that mechanism was not the one used.

**macOS — launchd.** The entry is the label `com.schegent.wakeup`:

```text
launchctl list | grep com.schegent.wakeup
launchctl unload ~/Library/LaunchAgents/com.schegent.wakeup.plist
rm ~/Library/LaunchAgents/com.schegent.wakeup.plist
```

**macOS and Linux — cron.** The entry is a single crontab line carrying the trailing marker
`# schegent-wakeup`. Remove that one line and leave the rest of the crontab alone:

```text
crontab -l | grep schegent-wakeup
crontab -l | grep -v '# schegent-wakeup' | crontab -
```

**Linux — systemd user units.** The entry is a timer and its service, under
`$XDG_CONFIG_HOME/systemd/user` or `~/.config/systemd/user`:

```text
systemctl --user list-timers schegent-wakeup.timer
systemctl --user disable --now schegent-wakeup.timer
rm -f ~/.config/systemd/user/schegent-wakeup.timer ~/.config/systemd/user/schegent-wakeup.service
systemctl --user daemon-reload
```

**Windows — Task Scheduler.** The entry is the task `Schegent\WakeUp`:

```text
schtasks /Query /TN "Schegent\WakeUp"
schtasks /Delete /TN "Schegent\WakeUp" /F
```

Removing the scheduled entry does not remove what it wrote. Wake up kept its own records under
`<globalStorage>/wakeup/` — `invocations.log` with its numbered rotations, and the session log the
runner appended captured CLI output to. Nothing reads those files any more and no retention sweep
covers them, because the code that owned both was deleted with the feature. They are inert and safe
to delete; they are listed here so the deletion is a decision rather than a discovery.

This page is the whole of the documented removal procedure. There is no command, setting, or
migration in the current release that performs it, and none is planned — the feature is withdrawn,
not deprecated.

<!-- Source: src/wakeup/platforms/launchd.ts (deleted in f702c0b2) -->
<!-- Source: src/wakeup/platforms/cron.ts (deleted in f702c0b2) -->
<!-- Source: src/wakeup/platforms/systemd-user.ts (deleted in f702c0b2) -->
<!-- Source: src/wakeup/platforms/task-scheduler.ts (deleted in f702c0b2) -->
<!-- Source: src/wakeup/invocation-log.ts (deleted in f702c0b2) -->
<!-- Source: src/cleanup/wakeup-cleanup.ts (deleted in f702c0b2) -->
