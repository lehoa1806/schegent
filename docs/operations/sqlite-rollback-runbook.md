# SQLite Application Store Rollback Runbook (`FR-R7-03`)

**Declared**: 2026-11-19 (`specs/317-sqlite-backup-restore/spec.md`)

Schema migrations in Schegent's embedded SQLite application store are **forward-only**. When a migration raises `schema_meta.min_reader_version` (for example, Migration 9 / `FR-R7-02` raises `schema_version = 9` and `min_reader_version = 9`), older builds refuse to open the upgraded database file fail-closed with `UNSUPPORTED_MIN_READER_VERSION` rather than risking partial reads or silent data corruption.

Because an older build cannot downgrade an upgraded database in place, **a verified pre-upgrade backup is the only supported path to roll back from schema `N` to schema `N-1`**.

For store internals, pragmas, and storage location rules, see [`sqlite-application-store.md`](sqlite-application-store.md).

---

## 1. Security Sensitivity & File Permissions

A backup image (`<backupId>.db`) contains the **same authoritative operational data as the live SQLite store**, including Run states, Task payloads, queue metadata, usage records, catalog definitions, and recovery handoff metadata.

- Backups are written inside the extension's trusted host storage directory at `<storageRoot>/sqlite/<scopeId>/backups/` (where `<storageRoot>` is VS Code's `storageUri`, or `globalStorageUri` when unavailable, and `<scopeId>` is the 16-hex SHA-256 prefix of the workspace root).
- On POSIX systems, Schegent enforces owner-only permissions: `0700` on the backup directory and `0600` on both `<backupId>.db` and its companion `<backupId>.db.manifest.json`.
- If you copy a backup to another local directory for safekeeping, preserve `0600` permissions and never commit backup files into a Git repository or place them on an untrusted shared filesystem.
- Structured audit log rows (`store-backup` and `store-restore` in `.schegent/audit.log`) are metadata-only by default and never record raw workspace or backup filesystem paths.

---

## 2. What State Is Lost on Rollback

Restoring a backup replaces **every authoritative SQLite table** (`128` tables across core execution, operational per-entity queues/Tasks/Runs, operational KV documents, history partitions, usage accounting, artifact lifecycle, live log indices, recovery handoffs, execution lanes, saved reports, telemetry ledger, and catalog/policy definitions).

- **Lost**: Any Run, Task, queue mutation, history entry, usage observation, catalog edit, or lane operation recorded **after the backup was taken** is permanently lost from the SQLite store.
- **Not erased**: `.schegent/audit.log` is an independent append-only hash-chained evidence log outside SQLite and is never truncated or rewritten by a store restore. External workspace repository files and Git commits outside the store are likewise untouched.

---

## 3. Pre-Upgrade Preparation (Before Upgrading Schegent)

1. Wait for any in-flight Runs to reach a terminal state (`completed`, `failed`, or `canceled`), or cancel them cleanly.
2. In the workspace owner window (trusted workspace holding the workspace ownership lock), open the Command Palette and run **Schegent: Back Up Store** (`schegent.backupStore`).
3. Confirm the modal prompt. Note the reported backup identifier (`<backupId>`), schema version, byte size, and backup file path.
4. Run **Schegent: Verify Store Backup** (`schegent.verifyStoreBackup`) and select `<backupId>` to confirm:
   - File-byte SHA-256 digest and byte length match `<backupId>.db.manifest.json`.
   - `PRAGMA quick_check` returns `ok` and `PRAGMA foreign_key_check` returns zero violations.
   - Schema version, `min_reader_version`, and bounded external dependencies verify cleanly.

---

## 4. Same-Version Recovery (Online Restore at Schema `N`)

Use this procedure when the installed extension build can still open the database (same schema version `N`, or restoring a compatible older backup onto schema `N` with automatic operational backfill) and you want to revert to a known-good backup:

1. Ensure no Run is in flight on the workspace. If any Run is active or paused, let it settle or run **Schegent: Cancel In-Flight Workflow** (`schegent.cancel`) first (`schegent.restoreStoreBackup` refuses closed with `RUN_IN_FLIGHT` while any Run is non-terminal).
2. Ensure you are in the trusted owner window holding the workspace ownership lock (secondary or untrusted windows refuse closed before touching the store).
3. Run **Schegent: Verify Store Backup** (`schegent.verifyStoreBackup`) on the target backup to confirm it passes integrity and digest checks.
4. Run **Schegent: Restore Store Backup** (`schegent.restoreStoreBackup`), pick the verified backup, read the confirmation modal stating what authoritative state will be replaced and lost, and confirm **Restore Store**.
5. Confirm the completion notification reports the restored table/row/Run counts and cache reload. If validation fails (for example `DATABASE_DIGEST_MISMATCH`, `QUICK_CHECK_FAILED`, `FOREIGN_KEY_CHECK_FAILED`, `UNSUPPORTED_SCHEMA_VERSION`, `EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT`, `EXTERNAL_DEPENDENCY_BOUND_EXCEEDED`, or `BACKUP_OPEN_FAILED`), the live store remains unchanged.

---

## 5. Cross-Version Downgrade Rollback (Schema `N` → Schema `N-1`)

Use this procedure after a failed migration or an undesirable upgrade where schema `N` raised `min_reader_version` (for example, rolling back from schema `9` to schema `8`):

1. **Confirm downgrade refusal symptom (if you already downgraded first)**:
   An older schema-`(N-1)` build opening a schema-`N` database fails closed at open with `UNSUPPORTED_MIN_READER_VERSION` (`database min_reader_version=N exceeds this build's maxSupportedVersion=N-1`) and leaves the database file untouched.
2. **Stop all Runs and close all VS Code windows for this workspace**:
   Close every VS Code window that has this workspace open (and stop any headless reader/writer process using the same `--state-dir`) so no SQLite writer or read-pool handle remains open on `schegent-state.db`.
3. **Locate the store directory and pre-upgrade backup**:
   - Live database: `<storageRoot>/sqlite/<scopeId>/schegent-state.db`
   - Verified pre-upgrade backup: `<storageRoot>/sqlite/<scopeId>/backups/<backupId>.db`
   - Companion manifest: `<storageRoot>/sqlite/<scopeId>/backups/<backupId>.db.manifest.json`
4. **Verify the pre-upgrade backup before swapping files**:
   - Confirm `<backupId>.db` has **no** `-wal`, `-shm`, or `-journal` sidecars next to it.
   - Recompute the SHA-256 of `<backupId>.db` (`shasum -a 256 <backupId>.db` on macOS/Linux) and verify it matches `databaseSha256` and exact byte size `databaseBytes` in `<backupId>.db.manifest.json`.
   - Confirm `schemaVersion` in the manifest is `<= N-1` (supported by the target older build).
   - If you have not already verified the backup with **Schegent: Verify Store Backup**, do not proceed with an unverified image.
5. **Preserve the failed/upgraded database for diagnostics (optional but recommended)**:
   Move `schegent-state.db` (and any `-wal`/`-shm` sidecars) to a private owner-only archive folder outside the live path (for example `schegent-state.db.failed-vN`).
6. **Remove stale SQLite sidecars at the live path**:
   Delete any remaining `schegent-state.db-wal`, `schegent-state.db-shm`, and `schegent-state.db-journal` files in `<storageRoot>/sqlite/<scopeId>/`. Leaving an old `-wal` file next to the restored schema-`(N-1)` database causes SQLite to replay incompatible WAL frames or fail integrity checks.
7. **Copy the verified backup into place and enforce `0600` permissions**:
   ```sh
   cp "<storageRoot>/sqlite/<scopeId>/backups/<backupId>.db" \
      "<storageRoot>/sqlite/<scopeId>/schegent-state.db"
   chmod 0600 "<storageRoot>/sqlite/<scopeId>/schegent-state.db"
   ```
8. **Install the schema-`(N-1)` extension build and reopen the workspace**:
   - Install/pin the previous Schegent VSIX version (schema `N-1`).
   - Reopen the workspace in VS Code.
   - Confirm Schegent activates without `UNSUPPORTED_MIN_READER_VERSION` or repair prompts, and verify Runs, Tasks, queues, and history match the pre-upgrade backup.
   - Confirm **Schegent: Verify Audit Chain** (`schegent.verifyAuditChain`) still reports a healthy external audit chain.

---

## 6. Rehearsal Reference

This runbook is exercised end-to-end against a fixture schema-8 → schema-9 upgrade in [`tests/integration/sqlite-rollback-runbook-rehearsal.test.ts`](../../tests/integration/sqlite-rollback-runbook-rehearsal.test.ts), verifying:
- Pre-upgrade schema-8 backup creation and manifest digest/integrity verification.
- Upgrade to schema 9 (`min_reader_version = 9`) and post-upgrade state divergence.
- Fail-closed `UNSUPPORTED_MIN_READER_VERSION` refusal when a schema-8 reader attempts to open the schema-9 file.
- Offline pre-open sidecar removal, verified backup file swap with `0600` permissions, and clean reopen on a schema-8 reader with exact pre-upgrade entity parity.
