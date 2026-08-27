# File layout

Schegent has no database, ORM, or remote persistence service. Durable product state is split between VS Code `workspaceState`, workspace-local files under `.schegent/`, and private recovery checkpoints in the extension's `globalStorage` directory. Generated build files and installed dependencies live elsewhere in the repository and are not runtime state.

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
    |-- catalog/
    |   |-- manifest.json
    |   |-- phases/<phaseId>/v<N>.json
    |   |-- pipelines/<pipelineId>/v<N>.json
    |   `-- workflows/<workflowId>/v<N>.json
    |-- cli-transport.log
    |-- cli-transport.log.1 ... .3
    |-- history/<runId>.txt
    |-- metrics-rollup.jsonl
    |-- ownership/<resource-records>
    |-- sessions/
    |   |-- raw-<runId>.log
    |   |-- .pending/raw-<runId>.log
    |   `-- <runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
    |       |-- debug.json
    |       |-- stream.jsonl
    |       |-- verbose.log
    |       `-- phase-message.env
    `-- syslog
```

The tree is demand-created. In particular, an absent `.schegent/catalog/manifest.json` is the healthy empty catalog, not corruption, and a fresh extension ships no Phase, Pipeline, or Workflow definitions.

<!-- Source: src/lib/catalog-fs-adapter.ts -->
<!-- Source: src/catalog/catalog-paths.ts -->
<!-- Source: src/catalog/catalog-manifest.ts -->
<!-- Source: src/config/pipeline-config.ts -->

| Path | Format and ownership | Purpose |
|---|---|---|
| `.schegent/.gitignore` | Text containing `*`; created with exclusive-write semantics and never overwrites an existing file | Keeps all local runtime artifacts out of Git even in a workspace whose repository ignore file knows nothing about Schegent. |
| `.schegent/catalog/manifest.json` | Catalog store format v1; the only mutable catalog file | Records version lists and draft/active pointers. |
| `.schegent/catalog/{phases,pipelines,workflows}/<id>/v<N>.json` | Immutable JSON version record | Stores one exact definition version. IDs and version names are validated before becoming path segments. |
| `.schegent/audit.log` | Newline-delimited structured audit entries, schema v3 | Primary metadata evidence. Rotation produces timestamped siblings; the writer defaults to 5 MiB and a 30-day rotation age. Host code appends. The log is tamper-**evident** but not tamper-proof: each entry carries the previous entry's digest (`src/audit/audit-chain.ts`), so an edit that does not recompute every later digest is detected by `npm run audit:verify`; an actor with write access to the same disk can recompute them. |
| `.schegent/sessions/raw-<runId>.log` | Unredacted text, mode `0600` on POSIX | Retained raw transcript for `always`, or the promoted result for a non-clean `errors-only` Run. |
| `.schegent/sessions/.pending/raw-<runId>.log` | Temporary unredacted text | Workspace-side pending location used by errors-only transcript handling. Raw capture also uses a private `0700` OS-temp spool while a process is active. |
| `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/stream.jsonl` | Unredacted JSONL | Per-iteration CLI stream capture. |
| The same `iter-<N>` directory's `debug.json`, `verbose.log`, and `phase-message.env` | Unredacted diagnostic and sidecar files | Backend debug stream, verbose output, and host-resolved Phase message sidecar. |
| `.schegent/history/<runId>.txt` | UTF-8 text, mode `0600` on POSIX | Full Task description used for byte-identical reruns; the Memento history row holds only a preview and relative reference. |
| `.schegent/metrics-rollup.jsonl` | Append-only newline-delimited JSON, schema v1 | One terminal summary per Run so cumulative totals survive audit rotation. |
| `.schegent/cli-transport.log` and `.1`–`.3` | Sanitized line records; 5 MiB per file | Bounded transport-level diagnostics, separate from the unredacted sinks. |
| `.schegent/ownership/` | Private JSON records, directory `0700` and files `0600` on POSIX | Authoritative fencing records for window primacy and per-Queue execution leases. |
| `.schegent/syslog` | Sanitized runtime log | Default runtime-log path. A configured path may instead resolve under an allowed canonical workspace, extension `globalStorage`, or OS temp root. The operator's home directory is deliberately excluded. |

<!-- Source: src/audit/schegent-gitignore.ts -->
<!-- Source: src/contracts/catalog-store.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/services/phase-log/phase-log-path.ts -->
<!-- Source: src/audit/verbose-diagnostic-path.ts -->
<!-- Source: src/controller/phase-sidecar-reader.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/metrics/metrics-rollup.ts -->
<!-- Source: src/metrics/metrics-rollup-writer.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->

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

## VS Code Memento state

`WorkspaceStateStore` writes keyed JSON-compatible values to `workspaceState`. Schema version 13 is forward-only. The principal partitions are the Queue registry and Queue states, active Runs keyed by Queue, terminal history keyed by Queue, connected-run aggregates, execution-lease mirrors, confirmation suppression, watchdog state, and migration/reset markers. The authoritative ownership records remain on disk; Memento copies are projections or compatibility state where the owning contract says so.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/lock.ts -->

There is no down-migration command or database migration directory. On read, sequential migrators advance old Memento shapes through schema 13; newer-than-supported state is quarantined rather than interpreted as current.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/workspace-state.ts -->

## Path safety and retention

Security-sensitive filesystem adapters generally perform a containment check appropriate to the operation before reading, writing, renaming, or removing a path. The shared canonical-path oracle distinguishes following a target from manipulating a directory entry; the catalog, transcript, ownership, history, checkpoint, and runtime-log adapters refuse when containment cannot be proved. The live audit append is included rather than excepted: `doWrite()` opens through the safe walk on every write instead of joining a path and appending, so a `.schegent` symlink planted in the workspace cannot redirect the append-only record. It re-walks per append rather than holding a descriptor, because rotation replaces the file underneath a retained handle. (An earlier revision of this page recorded that append as a residual symlink risk; FR-R3-053 closed it and the sentence outlived the code — found by the 2026-08-25 criterion-8 review, `docs/audits/criterion-8-review-2026-08-25.md` F1.) Lexical validation is additional defense for IDs and stored references, not a substitute for resolving filesystem links.

<!-- Source: src/lib/path-containment.ts -->
<!-- Source: src/lib/catalog-fs-adapter.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->

Retention differs by artifact: audit archives, unredacted session artifacts, private recovery checkpoints, runtime logs, CLI transport generations, and history descriptions each have their own owner and bound. Deleting one class does not imply deletion of the others. Use the owning settings or operation rather than deleting a broad `.schegent/` tree while Schegent is active.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
