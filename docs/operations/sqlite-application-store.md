# SQLite Application Store and Structured-State Migration (`FR-R6-F04`)

**Declared**: 2026-11-09 (`specs/303-sqlite-application-store/spec.md`)

This reference documents the embedded SQLite application store (`F04-A`), the versioned Round 6 domain store adapters (`F04-B` covering `F05`, `F06`, `F07`, `F08`, `F10`, `F11`, `F13`, `F14`, `F15`), and the catalog, policy, model catalog, and frozen execution closure store (`F04-C`).

Implemented in:
- [`src/contracts/sqlite-store/schema-types.ts`](../../src/contracts/sqlite-store/schema-types.ts)
- [`src/contracts/sqlite-store/domain-adapter-types.ts`](../../src/contracts/sqlite-store/domain-adapter-types.ts)
- [`src/contracts/sqlite-store/state-census.ts`](../../src/contracts/sqlite-store/state-census.ts)
- [`src/services/sqlite-store/sqlite-driver.ts`](../../src/services/sqlite-store/sqlite-driver.ts)
- [`src/services/sqlite-store/storage-location-resolver.ts`](../../src/services/sqlite-store/storage-location-resolver.ts)
- [`src/services/sqlite-store/schema-bootstrap.ts`](../../src/services/sqlite-store/schema-bootstrap.ts)
- [`src/services/sqlite-store/writer-coordinator.ts`](../../src/services/sqlite-store/writer-coordinator.ts)
- [`src/services/sqlite-store/transaction-units.ts`](../../src/services/sqlite-store/transaction-units.ts)
- [`src/services/sqlite-store/migration-coordinator.ts`](../../src/services/sqlite-store/migration-coordinator.ts)
- [`src/services/sqlite-store/backup-restore-service.ts`](../../src/services/sqlite-store/backup-restore-service.ts)
- [`src/services/sqlite-store/catalog-config-store.ts`](../../src/services/sqlite-store/catalog-config-store.ts)
- [`src/services/sqlite-store/engine-qualification.ts`](../../src/services/sqlite-store/engine-qualification.ts)
- [`src/services/sqlite-store/index.ts`](../../src/services/sqlite-store/index.ts)

For shared identity, authority, and retention contracts, see [`docs/operations/shared-memory-storage-contracts.md`](shared-memory-storage-contracts.md). For runtime queue and query budgets, see [`docs/operations/runtime-resource-budgets.md`](runtime-resource-budgets.md).

---

## 1. Engine Qualification & Mandatory Pragma Profile (`F04-A`)

Schegent qualifies Node's built-in `node:sqlite` (`DatabaseSync`, verified at `sqlite_version() = 3.53.4` on Node 24, exceeding the `3.51.3` WAL-reset fix floor). Every operational connection applies and verifies via read-back:

| Pragma | Applied Setting | Required Read-Back | Purpose |
|---|---|---|---|
| `journal_mode` | `WAL` (or `MEMORY` in `:memory:` tests) | `'wal'` / `'memory'` | Concurrent readers alongside a single serialized writer |
| `synchronous` | `FULL` (`2`) | `2` | Crash and power-loss durability for authoritative state |
| `foreign_keys` | `ON` (`1`) | `1` | Per-connection enforcement of all relational foreign keys |
| `busy_timeout` | `250` | `250` | Bounded `250 ms` lock wait ceiling |
| `trusted_schema` | `OFF` (`0`) | `0` | Hardens against untrusted SQL functions/triggers in schema objects |
| `temp_store` | `MEMORY` (`2`) | `2` | Keeps transient sort/index scratch space in memory |
| `query_only` | `ON` (`1`) on read pool | `1` (readers) / `0` (writer) | Prevents accidental mutations on read connections (`max 2`) |

If any pragma read-back does not match its required value, `NodeSqliteConnection` closes the descriptor and throws `SqlitePragmaVerificationError`.

---

## 2. Trusted Storage Location & Network-Share WAL Refusal

`resolveTrustedSqliteLocation` (`src/services/sqlite-store/storage-location-resolver.ts`) enforces:
1. **Trusted Source Origin**: Only `host_storage_uri`, `host_global_storage_uri`, or explicit `cli_state_dir` roots are accepted. Paths supplied by webviews, workspace settings, or untrusted environment variables are refused (`untrusted_source`).
2. **Containment & POSIX Permissions**: Directory chains and the database leaf file are created via `ensureAnchorWithinRoot` and `openWithinRoot` (`src/lib/safe-open.ts`) with `0700` directory mode and `0600` file mode (Hard Rule 69).
3. **Network-Share WAL Refusal**: Opening in `WAL` mode on `nfs`, `smb`, `cifs`, `afp`, `webdav`, `fuse.sshfs`, `smbfs`, or `ncpfs` is refused (`network_share_wal_unsupported`) with an instruction to configure a local `--state-dir`.

---

## 3. Bounded Writer Queue, Settlement Reserve & WAL Checkpoint Policy

`WriterCoordinator` (`src/services/sqlite-store/writer-coordinator.ts`) enforces the F03/F04 queue and WAL bounds:
- **Total Queue Capacity**: `64` requests or `16 MiB` (`16,777,216` bytes).
- **Reserved Settlement Headroom**: `16` slots or `4 MiB` (`4,194,304` bytes) reserved exclusively for the `settlement` lane (`Terminal acceptance`, lock renewal/release, and durability flushes). Normal and background writes are capped at `48` requests or `12 MiB` and rejected with `QUEUE_SATURATED` above that threshold.
- **WAL Checkpoint Escalation**:
  - `PASSIVE`: Triggered at `1,000` accumulated WAL pages or `30,000 ms` since the last checkpoint.
  - `TRUNCATE` / `RESTART`: Triggered when WAL size reaches `64 MiB` and read connections are idle.
  - `WAL_BACKGROUND_PAUSED`: Triggered when WAL size reaches `128 MiB`, pausing `background` priority writes while keeping `settlement` and `standard` lanes operational.

---

## 4. Seven Atomic Transaction Units (`BEGIN IMMEDIATE`)

All authoritative multi-table state changes execute inside `AtomicTransactionUnitsService` (`src/services/sqlite-store/transaction-units.ts`):

| Commit Unit | Lane | Primary Tables Mutated |
|---|---|---|
| `Admission` | `standard` | `runs`, `run_inputs`, `queue_entries`, `steps`, `attempts`, `execution_summary_revisions`, `aggregate_revisions`, `state_change_outbox`, `operation_receipts` |
| `Terminal acceptance` | `settlement` | `runs`, `queue_entries`, `steps`, `attempts`, `execution_summary_revisions`, `aggregate_revisions`, `state_change_outbox`, `operation_receipts` |
| `Handoff acceptance` | `standard` | `runs`, `accepted_results`, `result_values`, `handoffs`, `handoff_sources`, `input_envelopes`, `input_bindings`, `artifact_pins`, `state_change_outbox`, `operation_receipts` |
| `Review acceptance` | `standard` | `review_loops`, `review_reports`, `findings`, `finding_dispositions`, `fix_claims`, `gates`, `execution_summary_revisions`, `state_change_outbox`, `operation_receipts` |
| `Usage/correction` | `standard` | `usage_observations`, `usage_corrections`, `usage_accounting_applications`, `attempt_usage_revisions`, `execution_summary_revisions`, `aggregate_revisions`, `state_change_outbox`, `operation_receipts` |
| `Catalog publication` | `standard` | `definitions`, `definition_versions`, `definition_dependencies`, `catalog_heads`, `catalog_revisions`, `state_change_outbox`, `operation_receipts` |
| `Retention` | `background` | `report_leases`, `state_change_outbox`, `artifact_pins`, `artifact_availability`, `operation_receipts` |

---

## 5. Seven-Stage Migration Pipeline, Quarantine & Online Backup/Restore

1. **Migration Stages (`MigrationCoordinator`)**:
   - `prepare-copy → import → quiesce/reconcile → validate → publish-authority → retain-source → retire-source`.
   - Any interruption prior to `publish-authority` leaves `cutover_sentinel.authority = 'legacy'` and resumes idempotently on restart.
   - Corrupt JSON or unknown-future-version (`schemaVersion > maxSupported`) records are preserved in `migration_quarantine` with full raw payload and diagnostic JSON (`0` silent drops). `retire-source` is blocked until all quarantine rows are resolved.
   - Once `publish-authority` completes, `CutoverAuthorityGuard.checkLegacyAccessAllowed` refuses legacy Memento/JSON access (`SQLITE_AUTHORITY_ACTIVE`).
2. **Online Backup & Validated Restore (`BackupRestoreService`)**:
   - `createOnlineBackup` uses `VACUUM INTO` to snapshot the live WAL database and builds a `BackupDependencyManifest` listing external content-addressed blobs (`F05`), bounded log segments (`F07`), and `AuditLogger` files with SHA-256 digests and byte lengths.
   - `validateAndRestoreBackup` opens the backup in an isolated read-only connection, verifies `PRAGMA quick_check` (`ok`), `PRAGMA foreign_key_check` (`0` rows), schema version compatibility, and every external file digest before modifying the active store.
   - Both functions are library code. No host command, activation module or UI calls them, so there is no operator-facing way to back up or restore the database today.
