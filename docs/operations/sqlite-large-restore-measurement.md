# SQLite Large Restore Measurement, Maintenance Envelope & Ownership Fencing (`FR-R7-14` / `14-03`)

**Measured**: 2026-11-23 · **Item**: `FR-R7-14` (`14-03`) · **Calibrated Maintenance Ceiling**: **`512 MiB`** (`MAX_BACKUP_DATABASE_BYTES = MAX_RESTORE_IMAGE_BYTES = 536,870,912` bytes), enforced symmetrically at backup creation, verification, and restore.

This record documents the repeatable host-thread restore measurements for Schegent's SQLite application store (`WAL`, `PRAGMA synchronous = FULL`, `PRAGMA foreign_keys = ON`, `PRAGMA trusted_schema = OFF`), compares the pre-`14-03` synchronous JS-materialized restore against the `14-03` async chunked SHA-256 + SQLite-native `ATTACH DATABASE` / `INSERT INTO ... SELECT` executor, calibrates the supported restore maintenance envelope against `WorkspaceLockManager`'s `5,000 ms` heartbeat and `15,000 ms` staleness window, and summarizes the two-window ownership-contention rehearsal.

<!-- Source: src/services/sqlite-store/backup-restore-executor.ts -->
<!-- Source: src/services/sqlite-store/backup-restore-service.ts -->
<!-- Source: src/services/sqlite-store/backup-manifest-store.ts -->
<!-- Source: src/headless/backup-restore-api.ts -->
<!-- Source: src/commands/sqlite-backup-restore.ts -->
<!-- Source: tests/integration/sqlite-large-restore-fencing.test.ts -->

> **Single-platform qualification notice**: Every figure on this page was measured locally on one machine (`darwin/arm64`, Apple M4 Max, local APFS SSD, Node `v24.22.2`, SQLite `3.53.4`). These measurements provide single-platform risk reduction rather than a cross-platform guarantee; slower spinning disks, network mounts, Linux (`ext4`/`xfs`), and Windows (`NTFS`) hosts remain unobserved until measured on those platforms.

---

## 1. Execution Path Changes (`14-03`)

Prior to `14-03`, `validateAndRestoreBackup` performed two synchronous full-file SHA-256 passes on the extension host thread, materialized all rows from all 128 authoritative tables into V8 JavaScript objects (`SELECT * FROM "T"`), and reinserted rows one by one via per-row `db.prepare(...).run(...)`.

`14-03` replaces that execution path in `backup-restore-executor.ts` and `backup-restore-service.ts` with:

1. **Single-pass async chunked SHA-256 (`computeFileDigestAsync`)**: Opens the backup image read-only via `openWithinRoot` / `openWithinRootByPath` (`O_NOFOLLOW`), hashes `256 KiB` chunks asynchronously, yields to the Node.js event loop (`setImmediate`) every `1 MiB` hashed, and captures a nanosecond `BigInt` stat identity fingerprint `(dev, ino, size, mtimeNs, ctimeNs)` so post-validation TOCTOU verification runs in `O(1)` without a redundant second full-file hash.
2. **Yielding external-dependency & integrity verification (`validateBackupImageReadOnlyAsync`)**: Yields across external dependency checks and read-only SQLite `PRAGMA quick_check` / `PRAGMA foreign_key_check` / schema verification without materializing table rows into V8 memory.
3. **SQLite-native atomic copy (`executeAttachedRestoreAsync`)**: Attaches the verified backup via parameterized `ATTACH DATABASE ? AS backup_src`, opens `BEGIN IMMEDIATE`, preserves triggers transactionally, deletes stale target rows, copies every authoritative table natively inside SQLite (`INSERT INTO main."T" (<cols>) SELECT <cols> FROM backup_src."T"`), restores `main.sqlite_sequence`, runs schema-8 operational backfill when restoring a schema-8 snapshot onto schema 9, re-creates triggers, runs `PRAGMA main.foreign_key_check`, and detaches `backup_src` in `finally`.
4. **Three-stage ownership & idle fencing**:
   - **Pre-restore**: `hasPrimacy()` (`NOT_WORKSPACE_OWNER`) and `!hasInFlightRun()` (`RUN_IN_FLIGHT`).
   - **Post-validation (pre-`ATTACH`)**: re-verifies `hasPrimacy()` (`RESTORE_OWNERSHIP_LOST`) and `!hasInFlightRun()` (`RESTORE_BUSY`) before opening the write transaction.
   - **Immediate pre-`COMMIT` (inside `BEGIN IMMEDIATE`)**: re-verifies `hasPrimacy()`, `!hasInFlightRun()`, and optional `beforeCommitFence()` immediately before `COMMIT`; any loss or busy condition executes `ROLLBACK`, leaves the live store untouched (`outcome: 'refused_pre_commit'`), and writes zero rows to `.schegent/audit.log` when ownership was lost.
   - **Post-commit refresh separation**: if `reloadAfterRestore()` throws after SQLite `COMMIT`, the API returns `status: 'committed_refresh_failed'`, `outcome: 'committed_refresh_failed'`, `errorCode: 'POST_COMMIT_REFRESH_FAILED'`, and the operator notice instructs window reload without claiming the live store was untouched.

---

## 2. Reference Host & Measurement Methodology

| Field | Measured Environment |
|---|---|
| Date (UTC) | 2026-11-23 |
| Hardware / machine class | Apple M4 Max (16 logical cores, 64.0 GiB RAM) |
| OS / architecture | macOS 27.0 (`darwin` arm64, build `26A428`) |
| Storage / filesystem | Local APFS SSD (journaled, solid state) |
| Node.js runtime | `v24.22.2` |
| SQLite engine (`node:sqlite`) | `3.53.4` (`WAL`, `synchronous = FULL`, `foreign_keys = ON`, `trusted_schema = OFF`, `temp_store = MEMORY`) |
| Host load average (`1m / 5m / 15m`) | `2.24 / 3.50 / 3.60` |
| Process isolation | One fresh isolated Node.js process per mode and size tier |
| Synthetic workload shape | Populated schema-9 store (all 128 authoritative tables present; `runs`, `steps`, `attempts`, `operational_kv_documents` with ~4 KiB JSON payloads, issued `recovery_handoff_revisions` with `BEFORE DELETE` immutability trigger, `state_change_outbox` `AUTOINCREMENT`, plus pre-existing live target rows) |
| Concurrent probes during restore | `monitorEventLoopDelay({ resolution: 1 })`, `50 ms` timer gap & `SanitizedLogger` write-latency probe, real disk-backed `WorkspaceLockManager` (`500 ms` accelerated heartbeat check against `5,000 ms` production interval / `15,000 ms` staleness threshold) |
| Automated regression & contention suite | `npx vitest run tests/integration/sqlite-large-restore-fencing.test.ts` |

---

## 3. Measured Restore Envelope (Apple M4 Max, Local APFS)

### 3.1 Pre-`14-03` Legacy Path (Sync Double-Hash + JS Row Materialization + Per-Row `prepare()`)

| Tier | Actual Image Size | Restored Rows | Wall Time | `eventLoopDelay` p99 / max | Max `50 ms` Timer Gap | Logger Max Latency | Pre-Restore RSS | Peak RSS (`+Δ`) | Peak V8 Heap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Small (`~2 MiB`) | `2.07 MiB` (`2,166,784 B`) | `216` | `13.1 ms` | `3.09` / `14.48 ms` | `49.8 ms` | `1.708 ms` | `66.3 MiB` | `71.7 MiB` (`+5.4 MiB`) | `8.8 MiB` |
| Medium (`~16 MiB`) | `16.61 MiB` (`17,420,288 B`) | `3,809` | `113.8 ms` | `3.05` / `115.21 ms` | `113.9 ms` | `1.661 ms` | `67.7 MiB` | `134.3 MiB` (`+66.6 MiB`) | `24.9 MiB` |
| Large (`~64 MiB`) | `64.02 MiB` (`67,133,440 B`) | `15,652` | `443.1 ms` | `3.16` / `444.60 ms` | `446.0 ms` | `1.702 ms` | `71.9 MiB` | `341.8 MiB` (`+269.9 MiB`) | `71.4 MiB` |
| XL (`~128 MiB`) | `127.26 MiB` (`133,439,488 B`) | `31,442` | `732.3 ms` | `3.21` / `738.72 ms` | `738.4 ms` | `1.749 ms` | `76.6 MiB` | `480.8 MiB` (`+404.2 MiB`) | `44.4 MiB` |

The legacy path amplified process RSS by **3.2×–4.2×** the on-disk database image (`+404.2 MiB` RSS for a `127.26 MiB` store) and blocked the event loop continuously for the entire wall duration because every step ran synchronously.

### 3.2 `14-03` Production Path (Async Chunked SHA-256 + SQLite-Native `ATTACH` / `INSERT ... SELECT`)

| Tier | Actual Image Size | Restored Rows | Wall Time | `eventLoopDelay` p99 / max | Max `50 ms` Timer Gap | Logger Max Latency | Pre-Restore RSS | Peak RSS (`+Δ`) | Peak V8 Heap | Heartbeat Continuity (`< 5,000 ms`) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Small (`~2 MiB`) | `2.07 MiB` (`2,166,784 B`) | `216` | `33.2 ms` | `4.46` / `19.43 ms` | `50.0 ms` | `1.721 ms` | `66.3 MiB` | `76.7 MiB` (`+10.4 MiB`) | `9.3 MiB` | Pass (`primacyHeld = true`) |
| Medium (`~16 MiB`) | `16.61 MiB` (`17,420,288 B`) | `3,809` | `97.4 ms` | `30.39` / `31.56 ms` | `66.6 ms` | `1.740 ms` | `67.9 MiB` | `76.7 MiB` (`+8.8 MiB`) | `9.1 MiB` | Pass (`primacyHeld = true`) |
| Large (`~64 MiB`) | `64.02 MiB` (`67,133,440 B`) | `15,652` | `292.2 ms` | `110.89` / `118.03 ms` | `120.3 ms` | `1.627 ms` | `71.9 MiB` | `77.2 MiB` (`+5.3 MiB`) | `9.3 MiB` | Pass (`primacyHeld = true`) |
| XL (`~128 MiB`) | `127.26 MiB` (`133,439,488 B`) | `31,442` | `474.4 ms` | `40.80` / `211.16 ms` | `213.4 ms` | `1.802 ms` | `76.6 MiB` | `82.8 MiB` (`+6.2 MiB`) | `11.2 MiB` | Pass (`primacyHeld = true`, 1 beat) |
| Heavy (`~256 MiB`) | `253.62 MiB` (`265,936,896 B`) | `62,273` | `816.7 ms` | `64.75` / `330.56 ms` | `332.9 ms` | `1.709 ms` | `77.1 MiB` | `83.6 MiB` (`+6.5 MiB`) | `12.0 MiB` | Pass (`primacyHeld = true`, 1 beat) |
| **Ceiling (`~500 MiB`)** | **`497.80 MiB` (`521,981,952 B`)** | **`116,905`** | **`1,850.7 ms`** | **`3.22` / `842.01 ms`** | **`842.3 ms`** | **`1.810 ms`** | **`78.8 MiB`** | **`88.6 MiB` (`+9.8 MiB`)** | **`15.5 MiB`** | **Pass (`primacyHeld = true`, 2 beats)** |

**Key findings at the `512 MiB` ceiling (`497.80 MiB`, `116,905` rows)**:

- **Memory amplification eliminated**: Peak RSS rose by only **`+9.8 MiB`** (`78.8 → 88.6 MiB`) at `497.80 MiB` — compared to **`+404.2 MiB`** (`76.6 → 480.8 MiB`) for just `127.26 MiB` on the legacy path. V8 heap stayed at `15.5 MiB`.
- **Heartbeat & staleness margin**: The longest synchronous span (`eldMaxMs = 842.01 ms`, `maxProbeGapMs = 842.3 ms`, during the atomic SQLite `INSERT ... SELECT` + `COMMIT`) stayed **`5.9×` below** `WorkspaceLockManager`'s `5,000 ms` heartbeat interval and **`17.8×` below** the `15,000 ms` staleness reclaim threshold. Event-loop `p99` stayed at `3.22 ms` because the chunked async SHA-256 phase yielded every `1 MiB`.
- **Logger responsiveness**: Maximum `SanitizedLogger.info` write latency during the `497.80 MiB` restore was `1.810 ms`.
- **Source backup immutability**: SHA-256 of the backup image remained identical after `ATTACH`/`DETACH`, with zero `-wal`/`-shm`/`-journal` sidecars created beside the backup file.
- **Over-ceiling refusal verified live**: An oversized `571.7 MiB` (`599,486,464 B`) image was rejected with `RESTORE_IMAGE_BOUND_EXCEEDED` during `createOnlineBackup`, and tightened-bound boundary tests (`actualBytes - 1`, `actualBytes`) in `sqlite-large-restore-fencing.test.ts` and `backup-restore-service.test.ts` confirm symmetric pre-mutation refusal on creation, verify, and restore.

---

## 4. Calibrated Maintenance Envelope

Based on the measured bounds above, the supported maintenance envelope enforced symmetrically across `createOnlineBackup`, `verifyBackup`, `verifyBackupAsync`, `validateAndRestoreBackup`, and `validateAndRestoreBackupAsync` is:

| Bound Constant | Enforced Ceiling | Rejection / Failure Code | Tightened-Only Override Supported |
|---|---:|---|---|
| `MAX_BACKUP_DATABASE_BYTES` / `MAX_RESTORE_IMAGE_BYTES` | `512 MiB` (`536,870,912 B`) | `RESTORE_IMAGE_BOUND_EXCEEDED` | Yes (`maxDatabaseBytes` / `bounds.maxRestoreDatabaseBytes`) |
| `MAX_BACKUP_MANIFEST_BYTES` | `16 MiB` (`16,777,216 B`) | `BACKUP_MANIFEST_BOUND_EXCEEDED` | Yes (`maxManifestBytes` / `bounds.maxManifestBytes`) |
| `MAX_BACKUP_EXTERNAL_DEPENDENCIES` | `10,000` entries | `EXTERNAL_DEPENDENCY_BOUND_EXCEEDED` | Yes (`maxExternalDependencies`) |
| `MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES` | `512 MiB` (`536,870,912 B`) | `EXTERNAL_DEPENDENCY_BOUND_EXCEEDED` | Yes (`maxExternalDependencyBytes`) |

Callers may tighten any bound for testing or policy enforcement, but `resolveBackupBounds` clamps all requests so callers can never raise the published ceilings.

---

## 5. Two-Window Contention & Outcome Classification Rehearsal

Verified automatically in `repo/tests/integration/sqlite-large-restore-fencing.test.ts` using two real `WorkspaceLockManager` instances contending over a shared disk ownership directory (`createDiskOwnershipFs`):

| Rehearsed Scenario | Observed API Outcome | Live SQLite State on Disk | Shared `.schegent/audit.log` | Operator UI Notice |
|---|---|---|---|---|
| Window B reclaims primacy **during Window A's async validation** | `{ status: 'rejected', outcome: 'refused_pre_commit', reasonCode: 'RESTORE_OWNERSHIP_LOST' }` | Unchanged | Untouched (zero non-owner writes; sanitized warning logged) | Warning naming `RESTORE_OWNERSHIP_LOST` + `Live store was not modified.` |
| Window B reclaims primacy **immediately before `COMMIT`** (inside `BEGIN IMMEDIATE` after table copy) | `{ status: 'rejected', outcome: 'refused_pre_commit', reasonCode: 'RESTORE_OWNERSHIP_LOST' }` | Rolled back cleanly; unchanged on reopen | Untouched (zero non-owner writes; sanitized warning logged) | Warning naming `RESTORE_OWNERSHIP_LOST` + `Live store was not modified.` |
| An in-flight Run starts **during validation or pre-commit** | `{ status: 'rejected', outcome: 'refused_pre_commit', reasonCode: 'RESTORE_BUSY' }` | Rolled back cleanly; unchanged | Sanitized rejection recorded | Warning naming `RESTORE_BUSY` + `Live store was not modified.` |
| Backup image exceeds calibrated `maxDatabaseBytes` | `{ status: 'rejected', outcome: 'refused_pre_commit', reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED' }` | Unchanged | Sanitized rejection recorded | Warning naming `RESTORE_IMAGE_BOUND_EXCEEDED` + `Live store was not modified.` |
| `reloadAfterRestore()` throws **after SQLite `COMMIT`** | `{ status: 'committed_refresh_failed', outcome: 'committed_refresh_failed', errorCode: 'POST_COMMIT_REFRESH_FAILED' }` | Committed to restored backup state | Sanitized failure recorded with `POST_COMMIT_REFRESH_FAILED` | Error explicitly stating backup **was committed on disk** and instructing window reload (never claims unmodified) |

---

## 6. Re-Measurement Triggers & `FR-R8-03` (`03-04`) Degraded Operation Rehearsal (2026-11-24)

**Repeated measurement and six-mode degraded-operation rehearsal (`2026-11-24`, `darwin/arm64`, Apple M4 Max, Node `v24.22.2`):**

- `npx vitest run tests/integration/sqlite-large-restore-fencing.test.ts` — **4/4 passed** (`~16 MiB` SQLite-native `ATTACH` restore completed in `307 ms` with row fidelity, trigger preservation, bounded heap, and continuous heartbeat/logger responsiveness; two-window ownership loss during validation and immediately pre-commit refused with `RESTORE_OWNERSHIP_LOST` and zero live changes; `committed_refresh_failed` distinguished from pre-commit refusal; over-ceiling `512 MiB` bound refused pre-mutation).
- `npx vitest run tests/integration/degraded-operation-and-restore-drill.test.ts` — **6/6 passed**, rehearsing all six operator failure modes on disposable WAL SQLite stores and Git repositories:
  1. **Disk-full (`ENOSPC`) write failure**: `EvidenceHealthMonitor` surfaces fail-closed `audit.status = 'unavailable'`, `cause = 'disk-full'`, while SQLite records reopen intact (`PRAGMA quick_check = ok`).
  2. **Provider disconnect after external effect**: control reconciliation marks the in-flight `spawn-intent` attempt `paused-uncertain-effect` (`recovery-uncertain-effect`) without replaying the external receipt; operator cancel succeeds and preserves unrelated records.
  3. **Stale ownership handoff**: Window B reclaims stale ownership after `STALENESS_THRESHOLD_MS`; stale Window A restore (`NOT_WORKSPACE_OWNER`, `refused_pre_commit`) and workflow admission (`stale-fence`) both refuse before mutating disk.
  4. **Newer-reader schema version (`min_reader_version > 9`)**: refuses open while leaving database bytes SHA-256 identical.
  5. **Dirty Git state**: provisioning an isolated lane, freezing a candidate, approving integration onto `main`, and attempting `LaneService.landRequest` while the checked-out `main` worktree carries uncommitted tracked edits and untracked operator files refuses with `target-worktree-dirty`, keeping `main` at its prior commit, preserving the lane candidate and operator files byte-identically, and leaving the blocked request inspectable/cancelable.
  6. **Restore commit followed by failed refresh**: returns `{ status: 'committed_refresh_failed', outcome: 'committed_refresh_failed', errorCode: 'POST_COMMIT_REFRESH_FAILED' }` truthfully while reopened SQLite contains the restored state.
- **Slower / contended local storage responsiveness (`512 MiB` ceiling & lease continuity)**: Under concurrent async `fsync` local-storage contention (`256 KiB` continuous write+sync loop during the 1M-observation WAL worker benchmark in `tests/perf/usage-accounting-query.test.ts`), warm read `p95` shifted from `522.46 ms` to `534.33 ms` while host event-loop blocking stayed at `1.60 ms p95` (`max 1.83 ms`). For `512 MiB` restores on slower spinning disks or contended storage, `WorkspaceLockManager`'s `5,000 ms` heartbeat / `15,000 ms` staleness window remains the governing constraint because the atomic `BEGIN IMMEDIATE` `INSERT ... SELECT` + `COMMIT` span (`842 ms` on local APFS SSD) scales with disk write throughput; slower or network-mounted disks remain unobserved and require re-measurement before relying on the `512 MiB` ceiling.

Re-run this measurement matrix before relying on the `512 MiB` ceiling if any of the following change:

1. Raising `MAX_BACKUP_DATABASE_BYTES` / `MAX_RESTORE_IMAGE_BYTES` above `512 MiB` or raising external dependency ceilings.
2. Qualifying Linux (`ext4`/`xfs`), Windows (`NTFS`), encrypted/slow removable disks, or non-SSD storage classes.
3. Shortening `WorkspaceLockManager`'s `HEARTBEAT_INTERVAL_MS` (`5,000 ms`) or `STALENESS_THRESHOLD_MS` (`15,000 ms`).
4. Adding row-by-row JavaScript transformation or extra post-copy scans inside the `BEGIN IMMEDIATE` restore transaction.
