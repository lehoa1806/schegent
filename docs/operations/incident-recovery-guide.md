# Operator Incident Recovery Guide (`FR-R7-18` / `N03`)

**Declared**: 2026-11-24 (`specs/332-recovery-verification-gaps/spec.md`)

Use this guide when Schegent stops admitting work, refuses to open the operational SQLite database, or leaves an execution lane wedged after a crash, timeout, or extension version change. Jump straight to the symptom you observe. Every diagnostic string, recovery step, and surviving-file boundary below is exercised end-to-end in disposable workspaces by [`tests/integration/operator-incident-guide-rehearsal.test.ts`](../../tests/integration/operator-incident-guide-rehearsal.test.ts).

<!-- Source: ../../src/services/sqlite-store/schema-bootstrap.ts -->
<!-- Source: ../../src/services/sqlite-store/store-relocation.ts -->
<!-- Source: ../../src/services/sqlite-store/backup-restore-service.ts -->
<!-- Source: ../../src/services/sqlite-store/backup-dependency-collector.ts -->
<!-- Source: ../../src/activation/sqlite-cutover-wiring.ts -->
<!-- Source: ../../src/state/memento-write-gate.ts -->
<!-- Source: ../../src/services/enqueue-failure.ts -->
<!-- Source: ../../src/commands/reset.ts -->
<!-- Source: ../../src/services/execution-lanes/lane-reconciler.ts -->
<!-- Source: ../../src/services/execution-lanes/lane-cleanup.ts -->
<!-- Source: ../../src/services/execution-lanes/landing.ts -->
<!-- Source: ../../src/headless/execution-lanes-api.ts -->

## Symptom triage

| What you observe | Jump to | Safest first action |
|---|---|---|
| Extension refuses to open or relocate the operational SQLite store (`UNSUPPORTED_MIN_READER_VERSION` or `UNSUPPORTED_FUTURE_SCHEMA_VERSION`) | [Symptom 1](#symptom-1-future-schema-or-minimum-reader-version-refusal) | Upgrade Schegent to a build supporting schema `N` (zero data loss); roll back to schema 8 only with a verified pre-upgrade backup |
| State writes fail with `storage-write-timeout`, `storage-write-quarantined`, or `queue-state-unavailable` | [Symptom 2](#symptom-2-quarantined-workspace-state-writer-gc-04) | Wait briefly for GC-04 late-settle auto-recovery; if it does not settle, run **Developer: Reload Window**; use `schegent.reset` only as a last resort |
| Lane provisioning refuses `lane-bound-reached`, integration refuses `integration-busy`/`lane-busy`, or a lane/request stays in `preparing`, `verifying`, `landing`, `uncertain`, or `root-missing` | [Symptom 3](#symptom-3-stuck-execution-lane) | Reload/activate the primary window (runs `reconcile()` automatically), settle `uncertain`/`blocked` requests, then run `completeLane` → `releaseLane({ disposition: 'eligible' })` → `cleanupLanes` |

For related deep dives, see [SQLite rollback runbook](sqlite-rollback-runbook.md), [SQLite application store](sqlite-application-store.md), [Recovery from an interrupted run](recovery-checkpoints.md), [Execution lanes](execution-lanes.md), and [Inspect the runtime log](runtime-log.md).

---

## Symptom 1: Future schema or minimum-reader-version refusal

### Exact diagnostics

When an older Schegent build tries to inspect, relocate, or open a SQLite operational database upgraded by a newer build (for example, a schema-8 build opening a schema-9 database where `min_reader_version = 9`), Schegent fails closed and leaves the live database file untouched:

- **Activation warning toast** (`src/activation/sqlite-cutover-wiring.ts`):
  ```text
  Schegent refused to open or relocate the operational SQLite database (<reason>). Update Schegent before opening this workspace.
  ```
  where `<reason>` is `UNSUPPORTED_MIN_READER_VERSION` or `UNSUPPORTED_FUTURE_SCHEMA_VERSION`, accompanied by runtime warning `sqlite cutover: refused relocation for newer schema` and durable-batch unavailable reason `refused-newer-schema`.
- **Bootstrap error messages** (`SqliteUnsupportedSchemaError` in `src/services/sqlite-store/schema-bootstrap.ts`):
  - Reader floor exceeded:
    `UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema <N> or later; this build reads up to <M>`
  - Unreadable reader floor:
    `UNSUPPORTED_MIN_READER_VERSION: database records an unreadable reader floor`
  - Future schema version:
    `UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=<N> exceeds supported max=<M>`
  - Unreadable schema version:
    `UNSUPPORTED_FUTURE_SCHEMA_VERSION: database records an unreadable schema_version`
  - Future applied migration row:
    `UNSUPPORTED_FUTURE_SCHEMA_VERSION: applied migration version=<N> exceeds supported max=<M>`
- **Relocation preflight diagnostics** (`src/services/sqlite-store/store-relocation.ts`):
  - `UNSUPPORTED_MIN_READER_VERSION: database min_reader_version=<N> exceeds supported max=<M>`
  - `UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=<N> exceeds supported max=<M>`

### Safest recovery actions

1. **Preferred path (zero data loss): upgrade Schegent.**
   Install the newer Schegent VSIX build that supports schema `<N>` (for example, schema 9) and reload the workspace window. Because the older build refused fail-closed before mutating the database, all operational tables, Runs, Tasks, history, and catalog entries open cleanly with zero data loss.
2. **Supported downgrade path (schema 9 → schema 8): offline rollback from a verified pre-upgrade backup.**
   Only take this path if you must return to a schema-8 build and you hold a verified pre-upgrade schema-8 backup. Follow [SQLite rollback runbook §5](sqlite-rollback-runbook.md#5-cross-version-downgrade-rollback-schema-n--schema-n-1) step by step:
   - Close every VS Code window for the workspace and stop any headless reader/writer using the same store.
   - Verify `<backupId>.db` against `<backupId>.db.manifest.json` (SHA-256, exact `databaseBytes`, `schemaVersion <= 8`, no `-wal`/`-shm`/`-journal` sidecars beside the backup).
   - Archive the live schema-9 database (`schegent-state.db`) to a private owner-only forensic copy (such as `schegent-state.db.failed-v9`).
   - Delete stale live sidecars (`schegent-state.db-wal`, `schegent-state.db-shm`, `schegent-state.db-journal`).
   - Copy `<backupId>.db` to `<storageRoot>/sqlite/<scopeId>/schegent-state.db` and enforce `chmod 0600`.
   - Install the schema-8 VSIX and reopen the workspace.

### Schema-8 rollback prerequisites (hard boundary)

All prerequisites below are mandatory for a schema-8 rollback:

- A verified pre-upgrade backup image (`<backupId>.db`) with `schemaVersion <= 8` and `min_reader_version <= 8`.
- Its companion manifest `<backupId>.db.manifest.json` with matching `databaseSha256` and exact `databaseBytes`.
- Zero SQLite sidecars (`-wal`, `-shm`, `-journal`) beside the backup image.
- All writers and readers closed across every VS Code window and headless process touching `<storageRoot>/sqlite/<scopeId>/schegent-state.db`.
- All stale live sidecars (`schegent-state.db-wal`, `schegent-state.db-shm`, `schegent-state.db-journal`) deleted before opening the swapped file.
- Owner-only permissions (`chmod 0600`) applied to the restored `schegent-state.db`.
- A schema-8 Schegent VSIX installed before reopening the workspace.

**Without a verified pre-upgrade schema-8 backup, in-place downgrade from schema 9 to schema 8 is impossible.** Schema migrations are strictly forward-only (`min_reader_version = 9`); do not edit `schema_meta` manually or delete `operational_*` tables to try to force an older build to open a schema-9 file.

### Missing external artifact bytes: online verify/restore vs offline swap

Schegent separates intentionally deleted artifact tombstones from genuinely missing live external dependencies (`FR-R7-14`, `src/services/sqlite-store/backup-dependency-collector.ts`):

- **Lifecycle-deleted tombstones pass without bytes on disk**: artifacts whose `artifact_lifecycle.availability` is `deleted` or `expired` (or fallback `artifact_availability.state = 'evicted'` when no `artifact_lifecycle` row exists) are classified as `tombstoned-deleted`. Their SQLite metadata tombstones survive backup creation, online verification (`schegent.verifyStoreBackup`), and online restore (`schegent.restoreStoreBackup`) cleanly even though their external bytes are gone.
- **Missing or corrupt *live* external bytes refuse online verify/restore pre-commit**: artifacts in any live or unresolved state (`present`, `pending`, `unverified`, `missing`, `corrupt`, or untracked without lifecycle/availability rows) are classified as `required-live`. If a live external file is missing, truncated, or SHA-256-mismatched on disk, `verifyBackup` / `validateAndRestoreBackup` refuses pre-commit with `EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT`, leaving the live target SQLite database completely untouched. Restore the missing workspace/CAS file (or verify why it disappeared) before retrying online restore.
- **Offline schema-8 file swap bypasses external-byte verification**: copying `<backupId>.db` over `schegent-state.db` offline does not run the external-dependency inspector. If live external files referenced by the schema-8 backup were deleted or modified after the backup was taken, the rolled-back database will open with **dangling live locators** until those external files are restored on disk or reconciled on startup (`ArtifactLifecycleService.reconcileAfterRestart`).

### Surviving files and service-resumption checks

- **Surviving files**: `.schegent/audit.log` and its rotated archives, per-run raw session transcripts, workspace source files and Git history, archived forensic database copies (`schegent-state.db.failed-v9`), and backups under `<storageRoot>/sqlite/<scopeId>/backups/`. (During a rollback, operational SQLite state recorded *after* the pre-upgrade backup is permanently lost from the live store.)
- **Verify service resumed**:
  1. Reopen the workspace in the primary window and confirm the dashboard header shows **Workspace Connected** with no `UNSUPPORTED_MIN_READER_VERSION` or `UNSUPPORTED_FUTURE_SCHEMA_VERSION` warning toast.
  2. Confirm expected queues, Tasks, and Runs load cleanly (and a test queue/store mutation succeeds).
  3. Run **Schegent: Verify Audit Chain** (`schegent.verifyAuditChain`) and confirm the external hash chain verifies cleanly.

---

## Symptom 2: Quarantined workspace-state writer (GC-04)

### Exact diagnostics

Every serialized write in `WorkspaceStateStore` passes through `MementoWriteGate` (`src/state/memento-write-gate.ts`) with a fixed `MEMENTO_WRITE_DEADLINE_MS = 5000` (5 seconds). If the backing write hangs past 5 seconds, the gate quarantines the writer so later writes fail fast instead of piling up behind a hung storage call:

- **Runtime log WARN on initial timeout**:
  `workspace state write timed out; quarantining state writer` (logged with `{ key, deadlineMs: 5000 }`)
- **Typed error (`StorageWriteQuarantinedError`)**:
  - Triggering hung write: `reason: 'storage-write-timeout'` (`Workspace state write timed out after 5000ms for <key>; state writer is now quarantined`)
  - Subsequent writes while quarantined: `reason: 'storage-write-quarantined'` (`Workspace state write refused for <key>: storage writer is quarantined...`)
- **Enqueue / operator-facing failure classification** (`src/services/enqueue-failure.ts`):
  - Enqueue failure reason code: `queue-state-unavailable`
  - Command Palette toast: `Schegent: the queue could not be read or saved. Check the queue before trying again.`
- **GC-04 automatic recovery WARN when the hung write settles late**:
  `workspace state write settled after its deadline; state writer resumed` (logged with `{ key, outcome }`)

### Safest recovery ladder

Work down this ladder in order — do not jump straight to a destructive reset:

1. **Step 1 — Wait briefly for GC-04 non-destructive auto-recovery (zero data loss).**
   Under review gap `GC-04`, writer quarantine is **not** permanent. As soon as the hung write settles (whether it succeeded or failed), `MementoWriteGate` automatically lifts the quarantine and logs `workspace state write settled after its deadline; state writer resumed`. Each quarantine carries a unique identity token so a stale late settle from an earlier quarantine can never lift a newer quarantine. Check **System Log** (see [Inspect the runtime log](runtime-log.md)) for the resumed entry, then retry your action.
2. **Step 2 — Reload Window (non-destructive) if the hung write never settles.**
   If the backing host storage call stays wedged and never settles, run **Developer: Reload Window** from the VS Code Command Palette. Reloading disposes the stuck extension-host process and opens a fresh `WorkspaceStateStore` and `MementoWriteGate` without clearing durable operational state. Your SQLite database (`schegent-state.db`), `.schegent/audit.log`, archives, and raw transcripts survive intact.
3. **Step 3 — Last resort: `schegent.reset` (destructive to operational state, preserves evidence).**
   Only if reloading fails to restore a working store or workspace operational state is genuinely inconsistent, run **Schegent: Reset Workspace State** (`schegent.reset`) from the Command Palette.
   - `schegent.reset` executes a coordinated 6-phase transaction (`quiesce → stop-producers → mark → clear → commit → reload`, `src/commands/reset.ts`), lifting any active write-gate quarantine (`writeGate.lift()`), clearing operational workspace state keys, reloading Stage 2, and recording a `workspace-state-reset` entry in `.schegent/audit.log`.
   - If a runner subprocess is still active, reset refuses safely before clearing any state with:
     `Schegent: reset refused — a phase is still running. Cancel it, wait for it to stop, then try again.`
     Cancel the active phase, confirm the subprocess stopped, and only then decide whether reset is still necessary.

### Surviving files and service-resumption checks

- **Surviving files**:
  - Under Step 1 (auto-recovery) and Step 2 (**Reload Window**): the operational SQLite database (`schegent-state.db`), `.schegent/audit.log`, rotated audit archives, raw per-run transcripts, checkpoints, backups, and workspace Git files all survive.
  - Under Step 3 (`schegent.reset`): operational state (queues, runs, history, leases, schedules, and saved prompt choices) is cleared, while `.schegent/audit.log`, rotated audit archives, per-run session transcripts, and workspace source/Git files are **preserved** (and the reset itself is recorded as `workspace-state-reset`).
- **Verify service resumed**:
  1. Confirm the dashboard shows **Workspace Connected** and no new `storage-write-timeout`, `storage-write-quarantined`, or `queue-state-unavailable` errors appear in **System Log**.
  2. Perform a small queue mutation (for example, enqueueing or updating a task) and confirm it persists cleanly.
  3. If Step 3 (`schegent.reset`) was used, confirm `workspace-state-reset` appears in `.schegent/audit.log` and **Schegent: Verify Audit Chain** passes.

---

## Symptom 3: Stuck execution lane

### Exact diagnostics

When a host crashes, loses primacy, or encounters a Git failure while managing isolated worktree lanes (`schegent.lanes.enabled = true`), operators observe one or more of these refusal or reconciliation codes (`src/contracts/execution-lanes.ts`, `src/services/execution-lanes/lane-reconciler.ts`, `src/services/execution-lanes/lane-cleanup.ts`, `src/services/execution-lanes/landing.ts`):

- **Admission & lock refusals**:
  - `lane-bound-reached`: live lanes (`preparing`, `active`, `paused`) have reached `schegent.lanes.liveCap`.
  - `integration-busy`: another integration request in this repository is still recorded as `verifying` or `landing`.
  - `lane-busy`: another operation in this window holds the lane (or a request on that lane is `verifying` / `landing`).
- **Reconciliation transitions & observations**:
  - `preparing` lane from an earlier host → transitioned to `preparation-failed` with state reason `provisioning-interrupted` (immediately frees its live-lane cap slot).
  - Interrupted `pending` cleanup operation:
    - If worktree is already absent and unregistered → deletes leftover `base` ref (or records `base-ref-kept`) and converges cleanly to `removed`.
    - If worktree is still present or registered → ends the pending cleanup op `failed` with `cleanup-interrupted` and leaves the lane in `cleanup-eligible`, preserving user work.
    - If pinned or holding an open integration request → ends the pending cleanup op `kept` (`lane-pinned` or `integration-request-open`) without deleting `base`.
  - `verifying` request left behind → returned to `queued` (releases the repository-wide `integration-busy` lock).
  - `landing` request left behind → classified from Git's actual target branch tip **without ever replaying the landing**:
    - Tip still at expected target commit → `blocked` (`landing-not-applied`).
    - Tip equals candidate commit (and checked-out target is clean) → `landed`.
    - Tip advanced past candidate with candidate in its history → `landed` (`target-advanced-beyond`).
    - Tip diverged, branch deleted, candidate commit GC'd, or checked-out target files dirty at candidate tip → `uncertain`, reporting the commit triple (`expectedTarget` / `expectedTargetCommit` as `commits.expected`, `candidate` / `candidateCommit` as `commits.candidate`, and `observedTip` as `commits.observed` and in `lane_integration_journal`).
  - Missing lane root directory on a rooted lane (`active`, `paused`, `completed`, `retained`, `cleanup-eligible`) → preserved in its current state and reported `root-missing` (never auto-recreated or deleted).
  - Escaping symlink or invalid path containment on a lane root → preserved and reported `containment-refused`.
- **Cleanup keep reasons (`cleanupLanes`)**:
  - `lane-pinned`, `lane-live`, `lane-state-invalid`, `request-open`, `not-contained`, `registry-mismatch`, `worktree-locked`, `status-buffer-exceeded`, `status-timeout`, `lane-dirty`, `lane-busy`, `lane-not-found`.

### Safest recovery sequence

Mutating sidebar/dashboard UI controls for lane approval, landing, and cleanup remain deferred (see [Execution lanes](execution-lanes.md#cutover-status-and-what-remains-deferred-16-23)). Perform post-reconcile manual operations through the headless `src/headless/execution-lanes-api.ts` operations (never with forced Git commands such as `git reset --hard`, `git clean -fd`, or `git worktree remove --force`):

1. **Run reconciliation first (automatic on reload/primary activation).**
   Reload or activate the primary VS Code window (`src/activation/sqlite-cutover-wiring.ts` invokes `laneService.reconcile()` automatically on primary activation), or invoke headless `reconcile(service)`.
   - Interrupted `preparing` lanes move to `preparation-failed` (`provisioning-interrupted`), freeing the live-lane cap.
   - Interrupted `verifying` requests return to `queued`, clearing `integration-busy`.
   - Interrupted `landing` requests settle honestly to `blocked` (`landing-not-applied`), `landed`, or `uncertain` without replaying Git writes.
   - `root-missing` and `containment-refused` lanes are reported without deleting records or touching Git.
2. **Inspect and explicitly settle `uncertain` or `blocked` requests.**
   List open requests (`listRequests({ states: ['queued', 'awaiting-review', 'blocked', 'uncertain'] })`):
   - For **`uncertain`**: inspect the target branch in Git (`git log`, `git status`) comparing `expectedTarget` (`expectedTargetCommit`), `candidate` (`candidateCommit`), and `observedTip` (`commits.observed` / `lane_integration_journal.observed_tip`). Once you have verified the repository state, explicitly call `cancelRequest({ requestId })` (which transitions the request to `canceled` and journals `acknowledged-uncertain`), or freeze a fresh candidate after resolving the branch state.
   - For **`blocked`** (e.g., `landing-not-applied`, `target-advanced`, `verification-failed`): either call `cancelRequest({ requestId })` if abandoning that request, or make needed edits in the lane and call `freezeCandidate({ laneId })` before creating a fresh integration request.
   - For **`queued`** (returned from interrupted `verifying`): either retry `verifyRequest({ requestId })` or `cancelRequest({ requestId })`.
3. **Complete, release, and cleanly remove unneeded lanes (never forced).**
   - For `active` or `paused` lanes you are done with: call `completeLane({ laneId })`. (Skip this step for `preparation-failed` lanes — they release directly to `cleanup-eligible`.)
   - Call `releaseLane({ laneId, disposition: 'eligible' })` (or `disposition: 'retain'` if you want to keep the worktree out of cleanup).
   - Call `cleanupLanes({})` (or pass specific `laneIds`). Cleanup runs `git worktree remove` **without `--force`** and only removes a lane when it is unpinned, `cleanup-eligible`, has zero open requests, is contained and registered, is unlocked, and has a clean working tree whose `HEAD` matches `sourceCommit` or the frozen candidate. If cleanup keeps a lane (for example `lane-dirty`, `lane-pinned`, `worktree-locked`, or `request-open`), resolve that specific condition before retrying.

### Surviving files and service-resumption checks

- **Surviving files**:
  - Primary workspace checkout and `.git` directory (never altered by `reconcile` or `cleanupLanes`).
  - `refs/schegent/lanes/<laneId>/candidate` (intentionally preserved across cleanup and retention so every frozen candidate remains recoverable by ref; only `refs/schegent/lanes/<laneId>/base` is deleted on clean removal).
  - Unowned Git worktrees created outside Schegent (counted in `unknownWorktrees`, never touched).
  - Dirty (`lane-dirty`), pinned (`lane-pinned`), locked (`worktree-locked`), `root-missing`, `containment-refused`, and open-request (`request-open`) lanes.
  - SQLite lane candidates, review receipts, and `lane_integration_journal` records.
  - `.schegent/audit.log` and workspace evidence.
  - **Important caveat**: **ignored files** (such as build output inside a lane worktree) are **not** protected by Git during `git worktree remove` unless the lane is pinned (`setLanePinned({ laneId, pinned: true })`).
- **Verify service resumed**:
  1. Run `reconcile(service)` a second time and confirm `{ lanes: [], requests: [] }` (idempotent settlement, with any unowned worktrees still counted cleanly in `unknownWorktrees`).
  2. Confirm `listLanes({ states: ['preparing', 'active', 'paused'] })` is below `schegent.lanes.liveCap` and `listRequests({ states: ['verifying', 'landing'] })` is empty.
  3. Confirm a fresh `provisionLane(...)` succeeds without `lane-bound-reached` and new integration/verification operations do not fail with `integration-busy` or `lane-busy`.

---

## Automated rehearsal reference

All three incident symptoms and their verbatim diagnostics are exercised in disposable workspaces by [`tests/integration/operator-incident-guide-rehearsal.test.ts`](../../tests/integration/operator-incident-guide-rehearsal.test.ts), alongside the dedicated schema-8 → schema-9 rollback rehearsal in [`tests/integration/sqlite-rollback-runbook-rehearsal.test.ts`](../../tests/integration/sqlite-rollback-runbook-rehearsal.test.ts).
