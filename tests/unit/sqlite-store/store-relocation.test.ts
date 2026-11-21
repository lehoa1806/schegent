// FR-R7-10 — Unit and crash fault-injection suite for one-time SQLite store relocation into
// `<globalStorageUri>/sqlite/<scope>/schegent-state.db`.
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RelocationPrimacyLostError,
  RelocationWalFilesystemRefusedError,
  SqliteApplicationStore,
  createSwitchableCatalogFsAdapter,
  isValidPreservedConflictEntry,
  isValidRelocationJournal,
  isValidRelocationReceipt,
  relocateLegacySqliteStore,
  resolveTrustedSqliteLocation,
  type RelocationStage
} from '../../../src/services/sqlite-store';
import {
  openZeroMutationReadOnlySqliteSync,
  withZeroMutationReadOnlySqlite
} from '../../../src/lib/sqlite-readonly-inspect';
import {
  openReadOnlySqliteConnection,
  withZeroMutationReadOnlySqliteConnection
} from '../../../src/state/sqlite-operational-port';
import { removeTempRoot } from '../../temp-root-cleanup';

const SCOPE_ID = 'a1b2c3d4e5f60708';
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  await fsp.mkdir(path.join(dir, 'globalStorage', 'schegent.schegent'), { recursive: true, mode: 0o700 });
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    // Restore writable permissions on any read-only test directories before cleanup.
    await restoreWritableTree(dir).catch(() => undefined);
    await removeTempRoot(dir);
  }
});

async function restoreWritableTree(root: string): Promise<void> {
  const st = await fsp.lstat(root).catch(() => null);
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await fsp.chmod(root, 0o700).catch(() => undefined);
    const entries = await fsp.readdir(root).catch(() => []);
    for (const entry of entries) {
      await restoreWritableTree(path.join(root, entry));
    }
  } else if (st.isFile()) {
    await fsp.chmod(root, 0o600).catch(() => undefined);
  }
}

async function seedDatabase(
  storageRoot: string,
  scopeId: string,
  options: {
    readonly runIds?: readonly string[];
    readonly updatedAtMs?: number;
    readonly leaveWalUncheckpointed?: boolean;
    readonly extraWalRunId?: string;
    readonly minReaderVersionOverride?: number;
    readonly schemaVersionOverride?: number;
    readonly emptyShell?: boolean;
  } = {}
): Promise<string> {
  const dir = path.join(storageRoot, 'sqlite', scopeId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dir, 'schegent-state.db');

  const store = new SqliteApplicationStore({
    databasePath: dbPath,
    journalMode: 'wal',
    nowMs: () => options.updatedAtMs ?? 1_700_000_000_000
  });

  const ts = options.updatedAtMs ?? 1_700_000_000_000;
  if (!options.emptyShell) {
    store.writerConnection.run(
      `INSERT OR REPLACE INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
       VALUES (?, 'sqlite', 'publish-authority', 1, 'legacy-sha', 'sqlite-sha', ?)`,
      scopeId,
      ts
    );

    const runIds = options.runIds ?? ['run-1'];
    for (let i = 0; i < runIds.length; i += 1) {
      const runId = runIds[i]!;
      store.writerConnection.run(
        `INSERT OR REPLACE INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
         VALUES (?, ?, ?, 1, ?, 'completed', 'done', ?, ?, NULL, ?)`,
        scopeId,
        `queue-${i}`,
        runId,
        `feat-${i}`,
        ts,
        ts,
        JSON.stringify({ id: runId, secretNote: `SECRET_PAYLOAD_${runId}` })
      );
    }
  }

  if (options.minReaderVersionOverride !== undefined) {
    store.writerConnection.run(
      `INSERT OR REPLACE INTO schema_meta (meta_key, meta_value, updated_at_ms) VALUES ('min_reader_version', ?, ?)`,
      String(options.minReaderVersionOverride),
      ts
    );
  }
  if (options.schemaVersionOverride !== undefined) {
    store.writerConnection.run(
      `INSERT OR REPLACE INTO schema_meta (meta_key, meta_value, updated_at_ms) VALUES ('schema_version', ?, ?)`,
      String(options.schemaVersionOverride),
      ts
    );
  }

  if (options.leaveWalUncheckpointed && options.extraWalRunId) {
    // Hold a second connection with autocheckpoint disabled to keep a WAL frame uncheckpointed.
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA wal_autocheckpoint = 0');
    raw
      .prepare(
        `INSERT INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
         VALUES (?, 'queue-wal', ?, 1, 'feat-wal', 'completed', 'done', ?, ?, NULL, ?)`
      )
      .run(scopeId, options.extraWalRunId, ts + 50, ts + 50, JSON.stringify({ id: options.extraWalRunId }));
    // Keep a read handle open during close so SQLite does not auto-checkpoint WAL on writer close.
    const blocker = new DatabaseSync(dbPath, { readOnly: true });
    blocker.exec('BEGIN');
    blocker.prepare('SELECT COUNT(*) FROM operational_runs').get();
    raw.close();
    blocker.exec('COMMIT');
    blocker.close();
  } else {
    store.close();
  }

  return dbPath;
}

function readOperationalRunIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT run_id FROM operational_runs ORDER BY run_id ASC').all() as Array<{ run_id: string }>;
    return rows.map((r) => r.run_id);
  } finally {
    db.close();
  }
}

function sha256File(filePath: string): Promise<string> {
  return fsp.readFile(filePath).then((buf) => createHash('sha256').update(buf).digest('hex'));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('FR-R7-10 — relocateLegacySqliteStore', () => {
  it('returns noop when zero legacy databases and zero canonical databases exist', async () => {
    const root = await makeTempDir('fr-r7-10-zero-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('noop');
    if (res.outcome !== 'noop') throw new Error('expected noop');
    expect(res.activeDatabasePath).toBe(path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db'));
    expect(res.noticeRequired).toBe(false);
  });

  it('relocates a single populated legacy store including uncheckpointed WAL frames and enforces POSIX modes', async () => {
    const root = await makeTempDir('fr-r7-10-one-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');

    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, {
      runIds: ['run-base'],
      updatedAtMs: 1_700_000_001_000,
      leaveWalUncheckpointed: true,
      extraWalRunId: 'run-in-wal'
    });

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('relocated');
    if (res.outcome !== 'relocated') throw new Error('expected relocated');
    expect(res.relocatedFromPath).toBe(legacyDb);
    expect(res.activeDatabasePath).toBe(path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db'));
    expect(res.noticeRequired).toBe(false);

    expect(await exists(res.activeDatabasePath)).toBe(true);
    expect(await exists(legacyDb)).toBe(false);
    expect(readOperationalRunIds(res.activeDatabasePath)).toEqual(['run-base', 'run-in-wal']);

    if (process.platform !== 'win32') {
      const dirStat = await fsp.lstat(path.dirname(res.activeDatabasePath));
      const fileStat = await fsp.lstat(res.activeDatabasePath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    // Subsequent activation is an idempotent no-op.
    const second = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });
    expect(second.outcome).toBe('noop');
    if (second.outcome !== 'noop') throw new Error('expected noop');
    expect(second.activeDatabasePath).toBe(res.activeDatabasePath);
  });

  it('ignores an empty-shell legacy database without creating a false conflict', async () => {
    const root = await makeTempDir('fr-r7-10-empty-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyA = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyB = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    await seedDatabase(legacyA, SCOPE_ID, { emptyShell: true, updatedAtMs: 1_700_000_005_000 });
    await seedDatabase(legacyB, SCOPE_ID, { runIds: ['run-real'], updatedAtMs: 1_700_000_001_000 });

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyA,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('relocated');
    expect(res.noticeRequired).toBe(false);
    expect(readOperationalRunIds(path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db'))).toEqual(['run-real']);
  });

  it('resolves two populated legacy databases by last-write without merging, leaves loser untouched, and deduplicates notice', async () => {
    const root = await makeTempDir('fr-r7-10-two-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyOlder = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyNewer = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    const olderDb = await seedDatabase(legacyOlder, SCOPE_ID, {
      runIds: ['run-old-1', 'run-old-2'],
      updatedAtMs: 1_700_000_001_000
    });
    const newerDb = await seedDatabase(legacyNewer, SCOPE_ID, {
      runIds: ['run-new-1'],
      updatedAtMs: 1_700_000_009_000
    });
    const olderHashBefore = await sha256File(olderDb);

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyOlder,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('conflict_resolved');
    if (res.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(res.winnerSourcePath).toBe(newerDb);
    expect(res.preservedUnselectedPaths).toEqual([olderDb]);
    expect(res.newlyDiscoveredConflictPaths).toEqual([olderDb]);
    expect(res.noticeRequired).toBe(true);

    // Winner's rows only — zero silent merge from the older DB.
    expect(readOperationalRunIds(res.activeDatabasePath)).toEqual(['run-new-1']);
    // Unselected legacy DB left byte-for-byte untouched in place.
    expect(await exists(olderDb)).toBe(true);
    expect(await sha256File(olderDb)).toBe(olderHashBefore);
    expect(readOperationalRunIds(olderDb)).toEqual(['run-old-1', 'run-old-2']);

    // Repeat activation recognizes the receipt and does not repeat the conflict notice.
    const repeat = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyOlder,
      verifyPrimacy: async () => true
    });
    expect(repeat.outcome).toBe('noop');
    if (repeat.outcome !== 'noop') throw new Error('expected noop');
    expect(repeat.noticeRequired).toBe(false);
    expect(repeat.preservedUnselectedPaths).toEqual([olderDb]);
  });

  it('uses run count as tie-breaker when last-write timestamps are equal, and preserves losing canonical DB as 0400 sibling', async () => {
    const root = await makeTempDir('fr-r7-10-tie-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyMoreRuns = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    await seedDatabase(globalStorage, SCOPE_ID, {
      runIds: ['canon-1'],
      updatedAtMs: 1_700_000_005_000
    });
    const legacyDb = await seedDatabase(legacyMoreRuns, SCOPE_ID, {
      runIds: ['legacy-1', 'legacy-2', 'legacy-3'],
      updatedAtMs: 1_700_000_005_000
    });

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyMoreRuns,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('conflict_resolved');
    if (res.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(res.winnerSourcePath).toBe(legacyDb);
    expect(res.noticeRequired).toBe(true);
    expect(res.preservedUnselectedPaths).toHaveLength(1);
    const preservedCanonical = res.preservedUnselectedPaths[0]!;
    expect(path.basename(preservedCanonical)).toMatch(/^schegent-state\.unselected-[a-f0-9]{12}\.db$/);
    expect(readOperationalRunIds(res.activeDatabasePath)).toEqual(['legacy-1', 'legacy-2', 'legacy-3']);
    expect(readOperationalRunIds(preservedCanonical)).toEqual(['canon-1']);

    if (process.platform !== 'win32') {
      const preservedStat = await fsp.lstat(preservedCanonical);
      expect(preservedStat.mode & 0o777).toBe(0o400);
    }
  });

  it('prefers the canonical database when last-write and run count are tied, leaving legacy untouched', async () => {
    const root = await makeTempDir('fr-r7-10-canon-tie-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');

    const canonicalDb = await seedDatabase(globalStorage, SCOPE_ID, {
      runIds: ['canon-run'],
      updatedAtMs: 1_700_000_010_000
    });
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, {
      runIds: ['legacy-run'],
      updatedAtMs: 1_700_000_010_000
    });
    const legacyHash = await sha256File(legacyDb);

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('conflict_resolved');
    if (res.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(res.winnerSourcePath).toBe(canonicalDb);
    expect(res.preservedUnselectedPaths).toEqual([legacyDb]);
    expect(readOperationalRunIds(canonicalDb)).toEqual(['canon-run']);
    expect(await sha256File(legacyDb)).toBe(legacyHash);
  });

  const SINGLE_DB_CRASH_STAGES: readonly RelocationStage[] = [
    'after_stage_copy',
    'after_stage_verify',
    'after_write_journal',
    'after_atomic_publish',
    'after_retire_legacy',
    'after_write_receipt'
  ];

  for (const crashStage of SINGLE_DB_CRASH_STAGES) {
    it(`recovers cleanly after simulated crash at stage '${crashStage}' with exactly one authoritative database`, async () => {
      const root = await makeTempDir(`fr-r7-10-crash-${crashStage}-`);
      const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
      const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');

      const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, {
        runIds: ['run-crash-1', 'run-crash-2'],
        updatedAtMs: 1_700_000_020_000
      });
      const canonicalDb = path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db');

      await expect(
        relocateLegacySqliteStore({
          scopeId: SCOPE_ID,
          globalStorageUri: globalStorage,
          legacyStorageUri: legacyStorage,
          verifyPrimacy: async () => true,
          onStage: (stage) => {
            if (stage === crashStage) {
              throw new Error(`SIMULATED_CRASH:${stage}`);
            }
          }
        })
      ).rejects.toThrow(`SIMULATED_CRASH:${crashStage}`);

      // Immediately after crash: at least one complete, quick_check-ok database exists,
      // and canonicalDb (if present) is complete and never partial.
      const legacyPresent = await exists(legacyDb);
      const canonicalPresent = await exists(canonicalDb);
      expect(legacyPresent || canonicalPresent).toBe(true);
      if (canonicalPresent) {
        expect(readOperationalRunIds(canonicalDb)).toEqual(['run-crash-1', 'run-crash-2']);
      }
      if (legacyPresent) {
        expect(readOperationalRunIds(legacyDb)).toEqual(['run-crash-1', 'run-crash-2']);
      }

      // Restart recovery completes idempotently without triggering a false conflict.
      const recovered = await relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: globalStorage,
        legacyStorageUri: legacyStorage,
        verifyPrimacy: async () => true
      });
      expect(recovered.outcome === 'relocated' || recovered.outcome === 'noop').toBe(true);
      if (recovered.outcome !== 'relocated' && recovered.outcome !== 'noop') {
        throw new Error(`unexpected outcome: ${recovered.outcome}`);
      }
      expect(recovered.activeDatabasePath).toBe(canonicalDb);
      expect(recovered.noticeRequired).toBe(false);
      expect(await exists(canonicalDb)).toBe(true);
      expect(await exists(legacyDb)).toBe(false);
      expect(readOperationalRunIds(canonicalDb)).toEqual(['run-crash-1', 'run-crash-2']);
    });
  }

  it('recovers cleanly after simulated crash at stage after_preserve_losing_canonical', async () => {
    const root = await makeTempDir('fr-r7-10-crash-preserve-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    await seedDatabase(globalStorage, SCOPE_ID, {
      runIds: ['old-canon'],
      updatedAtMs: 1_700_000_001_000
    });
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, {
      runIds: ['newer-legacy'],
      updatedAtMs: 1_700_000_050_000
    });

    await expect(
      relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: globalStorage,
        legacyStorageUri: legacyStorage,
        verifyPrimacy: async () => true,
        onStage: (stage) => {
          if (stage === 'after_preserve_losing_canonical') {
            throw new Error('SIMULATED_CRASH:after_preserve_losing_canonical');
          }
        }
      })
    ).rejects.toThrow('SIMULATED_CRASH:after_preserve_losing_canonical');

    // Restart finishes cleanly and reuses the already-preserved 0400 canonical copy.
    const recovered = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });
    expect(recovered.outcome).toBe('conflict_resolved');
    if (recovered.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(recovered.winnerSourcePath).toBe(legacyDb);
    expect(readOperationalRunIds(recovered.activeDatabasePath)).toEqual(['newer-legacy']);
    expect(recovered.preservedUnselectedPaths).toHaveLength(1);
    expect(readOperationalRunIds(recovered.preservedUnselectedPaths[0]!)).toEqual(['old-canon']);
  });

  it('refuses relocation when ownership fence primacy is absent or lost before atomic publish', async () => {
    const root = await makeTempDir('fr-r7-10-fence-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, { runIds: ['run-fenced'] });
    const canonicalDb = path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db');

    await expect(
      relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: globalStorage,
        legacyStorageUri: legacyStorage,
        verifyPrimacy: async () => false
      })
    ).rejects.toBeInstanceOf(RelocationPrimacyLostError);
    expect(await exists(canonicalDb)).toBe(false);
    expect(await exists(legacyDb)).toBe(true);

    // Primacy lost mid-flight right before atomic publish.
    let checks = 0;
    await expect(
      relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: globalStorage,
        legacyStorageUri: legacyStorage,
        verifyPrimacy: async () => {
          checks += 1;
          return checks === 1;
        }
      })
    ).rejects.toBeInstanceOf(RelocationPrimacyLostError);
    expect(await exists(canonicalDb)).toBe(false);
    expect(await exists(legacyDb)).toBe(true);
  });

  it('enforces min_reader_version and future schema_version refusal (GC-09) without moving or modifying the legacy file', async () => {
    const root = await makeTempDir('fr-r7-10-gc09-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyMinReader = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyFutureSchema = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    const minReaderDb = await seedDatabase(legacyMinReader, SCOPE_ID, {
      runIds: ['future-run'],
      minReaderVersionOverride: 99
    });
    const minReaderHashBefore = await sha256File(minReaderDb);

    const res1 = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyMinReader,
      verifyPrimacy: async () => true
    });
    expect(res1.outcome).toBe('refused_newer_schema');
    if (res1.outcome !== 'refused_newer_schema') throw new Error('expected refused_newer_schema');
    expect(res1.reason).toBe('UNSUPPORTED_MIN_READER_VERSION');
    expect(res1.recordedVersion).toBe(99);
    expect(res1.offendingPath).toBe(minReaderDb);
    expect(await sha256File(minReaderDb)).toBe(minReaderHashBefore);
    expect(await exists(path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db'))).toBe(false);

    const futureSchemaDb = await seedDatabase(legacyFutureSchema, SCOPE_ID, {
      runIds: ['future-run-2'],
      schemaVersionOverride: 42
    });
    const futureHashBefore = await sha256File(futureSchemaDb);

    // Inspect only futureSchemaDb by placing it under its own isolated parent.
    const isolatedRoot = await makeTempDir('fr-r7-10-gc09-b-');
    const res2 = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: path.join(isolatedRoot, 'globalStorage', 'schegent.schegent'),
      legacyStorageUri: legacyFutureSchema,
      additionalLegacyStorageRoots: [],
      // Avoid sibling scan pulling legacyMinReader by using explicit root directly:
      verifyPrimacy: async () => true
    });
    // Because legacyMinReader is a sibling under `root/workspaceStorage`, either offending newer-schema DB triggers refusal.
    expect(res2.outcome).toBe('refused_newer_schema');
    expect(await sha256File(futureSchemaDb)).toBe(futureHashBefore);

    // Direct single-candidate check for UNSUPPORTED_FUTURE_SCHEMA_VERSION:
    const singleLegacy = path.join(isolatedRoot, 'custom-legacy');
    const singleFutureDb = await seedDatabase(singleLegacy, SCOPE_ID, {
      runIds: ['future-only'],
      schemaVersionOverride: 42
    });
    const res3 = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: path.join(isolatedRoot, 'globalStorage', 'schegent.schegent'),
      legacyStorageUri: singleLegacy,
      verifyPrimacy: async () => true
    });
    expect(res3.outcome).toBe('refused_newer_schema');
    if (res3.outcome !== 'refused_newer_schema') throw new Error('expected refused_newer_schema');
    expect(res3.reason).toBe('UNSUPPORTED_FUTURE_SCHEMA_VERSION');
    expect(res3.offendingPath).toBe(singleFutureDb);
  });

  it('falls back to the intact legacy database when canonical target is on a network filesystem or read-only', async () => {
    const root = await makeTempDir('fr-r7-10-fallback-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, { runIds: ['run-local'] });

    // Network filesystem WAL refusal
    const nfsRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      canonicalFilesystemType: 'nfs',
      requestedJournalMode: 'wal',
      verifyPrimacy: async () => true
    });
    expect(nfsRes.outcome).toBe('fallback_legacy_preserved');
    if (nfsRes.outcome !== 'fallback_legacy_preserved') throw new Error('expected fallback');
    expect(nfsRes.reason).toBe('network_share_wal_unsupported');
    expect(nfsRes.activeDatabasePath).toBe(legacyDb);
    expect(nfsRes.activeSourceKind).toBe('host_storage_uri');
    expect(await exists(path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db'))).toBe(false);
    expect(readOperationalRunIds(legacyDb)).toEqual(['run-local']);

    // Read-only canonical directory (POSIX only)
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      const roGlobal = path.join(root, 'ro-global');
      await fsp.mkdir(path.join(roGlobal, 'sqlite', SCOPE_ID), { recursive: true, mode: 0o700 });
      await fsp.chmod(path.join(roGlobal, 'sqlite', SCOPE_ID), 0o500);
      const roRes = await relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: roGlobal,
        legacyStorageUri: legacyStorage,
        verifyPrimacy: async () => true
      });
      expect(roRes.outcome).toBe('fallback_legacy_preserved');
      if (roRes.outcome !== 'fallback_legacy_preserved') throw new Error('expected fallback');
      expect(roRes.reason).toBe('canonical_target_unwritable');
      expect(roRes.activeDatabasePath).toBe(legacyDb);
      expect(readOperationalRunIds(legacyDb)).toEqual(['run-local']);
    }

    // Symlink planted at canonical sqlite/<scope>
    const symGlobal = path.join(root, 'sym-global');
    const outsideDir = path.join(root, 'outside');
    await fsp.mkdir(path.join(symGlobal, 'sqlite'), { recursive: true });
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.symlink(outsideDir, path.join(symGlobal, 'sqlite', SCOPE_ID));
    const symRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: symGlobal,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });
    expect(symRes.outcome).toBe('fallback_legacy_preserved');
    if (symRes.outcome !== 'fallback_legacy_preserved') throw new Error('expected fallback');
    expect(symRes.reason).toBe('symlink_or_containment_refused');
    expect(symRes.activeDatabasePath).toBe(legacyDb);
  });

  it('discards a malformed relocation journal and still relocates cleanly without touching outside paths', async () => {
    const root = await makeTempDir('fr-r7-10-bad-journal-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const outsideVictim = path.join(root, 'do-not-delete.txt');
    await fsp.writeFile(outsideVictim, 'keep-me', 'utf8');

    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, { runIds: ['run-clean'] });
    const canonicalDir = path.join(globalStorage, 'sqlite', SCOPE_ID);
    await fsp.mkdir(canonicalDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(canonicalDir, '.relocation-in-progress.json'),
      JSON.stringify({
        version: 1,
        scopeId: SCOPE_ID,
        stagedSha256: 'not-a-valid-sha',
        winnerDatabasePath: outsideVictim,
        winnerStorageRoot: root,
        preservedConflicts: []
      }),
      { mode: 0o600 }
    );

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('relocated');
    expect(await exists(outsideVictim)).toBe(true);
    expect(await exists(legacyDb)).toBe(false);
    expect(readOperationalRunIds(path.join(canonicalDir, 'schegent-state.db'))).toEqual(['run-clean']);
  });

  it('keeps explicit CLI --state-dir resolution untouched', async () => {
    const root = await makeTempDir('fr-r7-10-cli-');
    const cliDir = path.join(root, 'cli-state');
    await fsp.mkdir(cliDir, { recursive: true, mode: 0o700 });
    const resolved = await resolveTrustedSqliteLocation({
      trustedRootDir: cliDir,
      relativeSegments: ['sqlite', SCOPE_ID],
      databaseFileName: 'schegent-state.db',
      sourceKind: 'cli_state_dir'
    });
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('expected resolved');
    expect(resolved.databasePath).toBe(path.join(await fsp.realpath(cliDir), 'sqlite', SCOPE_ID, 'schegent-state.db'));
  });
});

async function seedCustomDatabase(
  storageRoot: string,
  scopeId: string,
  options: {
    readonly operationalRunIds?: readonly string[];
    readonly relationalRunIds?: readonly string[];
    readonly operationalUpdatedAtMs?: number;
    readonly metadataUpdatedAtMs?: number;
    readonly minReaderVersionOverride?: number;
    readonly leaveWalWithoutShm?: { readonly extraOperationalRunId: string; readonly tsMs: number };
    readonly catalogManifestJson?: string;
  }
): Promise<string> {
  const dir = path.join(storageRoot, 'sqlite', scopeId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dir, 'schegent-state.db');

  const metaTs = options.metadataUpdatedAtMs ?? 1_700_000_000_000;
  const opTs = options.operationalUpdatedAtMs ?? metaTs;
  const store = new SqliteApplicationStore({
    databasePath: dbPath,
    journalMode: 'wal',
    nowMs: () => metaTs
  });

  store.writerConnection.run(
    `INSERT OR REPLACE INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
     VALUES (?, 'sqlite', 'publish-authority', 1, 'legacy-sha', 'sqlite-sha', ?)`,
    scopeId,
    metaTs
  );
  store.writerConnection.run(
    `UPDATE schema_meta SET updated_at_ms = ?`,
    metaTs
  );
  store.writerConnection.run(
    `UPDATE schema_migrations SET applied_at_ms = ?`,
    metaTs
  );

  for (let i = 0; i < (options.operationalRunIds ?? []).length; i += 1) {
    const runId = options.operationalRunIds![i]!;
    store.writerConnection.run(
      `INSERT OR REPLACE INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
       VALUES (?, ?, ?, 1, ?, 'completed', 'done', ?, ?, NULL, ?)`,
      scopeId,
      `q-${i}`,
      runId,
      `feat-${i}`,
      opTs,
      opTs,
      JSON.stringify({ id: runId })
    );
  }

  for (let i = 0; i < (options.relationalRunIds ?? []).length; i += 1) {
    const runId = options.relationalRunIds![i]!;
    store.writerConnection.run(
      `INSERT OR REPLACE INTO runs (run_id, workspace_id, workflow_id, frozen_closure_id, status, revision, current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms, queue_id, invocation_count)
       VALUES (?, ?, 'wf-1', NULL, 'succeeded', 1, NULL, ?, ?, NULL, ?, ?, ?, 1)`,
      runId,
      scopeId,
      opTs,
      opTs,
      opTs,
      opTs,
      `rq-${i}`
    );
  }

  if (options.catalogManifestJson !== undefined) {
    store.writerConnection.run(
      `INSERT OR REPLACE INTO operational_kv_documents (doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms)
       VALUES (?, 'manifest.json', 1, 1, ?, ?, 0, ?)`,
      `catalog-fs:${scopeId}`,
      options.catalogManifestJson,
      Buffer.byteLength(options.catalogManifestJson, 'utf8'),
      opTs
    );
  }

  if (options.minReaderVersionOverride !== undefined) {
    store.writerConnection.run(
      `INSERT OR REPLACE INTO schema_meta (meta_key, meta_value, updated_at_ms) VALUES ('min_reader_version', ?, ?)`,
      String(options.minReaderVersionOverride),
      metaTs
    );
  }

  if (options.leaveWalWithoutShm !== undefined) {
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA wal_autocheckpoint = 0');
    raw
      .prepare(
        `INSERT INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
         VALUES (?, 'q-wal', ?, 1, 'feat-wal', 'completed', 'done', ?, ?, NULL, ?)`
      )
      .run(
        scopeId,
        options.leaveWalWithoutShm.extraOperationalRunId,
        options.leaveWalWithoutShm.tsMs,
        options.leaveWalWithoutShm.tsMs,
        JSON.stringify({ id: options.leaveWalWithoutShm.extraOperationalRunId })
      );
    const blocker = new DatabaseSync(dbPath, { readOnly: true });
    blocker.exec('BEGIN');
    blocker.prepare('SELECT COUNT(*) FROM operational_runs').get();
    raw.close();
    blocker.exec('COMMIT');
    blocker.close();
    // Remove `-shm` so the source directory has `.db` + `-wal` ONLY (uncheckpointed WAL without `-shm`).
    await fsp.rm(`${dbPath}-shm`, { force: true });
  } else {
    store.close();
  }

  return dbPath;
}

describe('FR-R7-11 (Tasks 16–19) — filesystem verdicts, exact winner rule, zero-mutation containment & recovery', () => {
  it('Task 16: falls back to confirmed-local legacy with zero canonical writes on network or unknown destination, and refuses network legacy', async () => {
    const root = await makeTempDir('fr-r7-11-task16-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, { runIds: ['run-local-1'] });
    const canonicalDir = path.join(globalStorage, 'sqlite');

    // (1) Detector reports 'network' for canonical and 'local' for legacy
    const netOutcome = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      detectFilesystemType: async (target) =>
        target.startsWith(path.resolve(globalStorage))
          ? { classification: 'network', filesystemType: 'smbfs' }
          : { classification: 'local', filesystemType: 'apfs' },
      verifyPrimacy: async () => true
    });
    expect(netOutcome.outcome).toBe('fallback_legacy_preserved');
    if (netOutcome.outcome !== 'fallback_legacy_preserved') throw new Error('expected fallback');
    expect(netOutcome.reason).toBe('network_share_wal_unsupported');
    expect(netOutcome.activeDatabasePath).toBe(legacyDb);
    expect(netOutcome.noticeRequired).toBe(true);
    expect(await exists(canonicalDir)).toBe(false);

    // (2) Detector reports 'unknown' for canonical while legacy is confirmed 'local'
    const unknownOutcome = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      detectFilesystemType: async (target) =>
        target.startsWith(path.resolve(globalStorage))
          ? { classification: 'unknown', filesystemType: 'unknown' }
          : { classification: 'local', filesystemType: 'ext4' },
      verifyPrimacy: async () => true
    });
    expect(unknownOutcome.outcome).toBe('fallback_legacy_preserved');
    if (unknownOutcome.outcome !== 'fallback_legacy_preserved') throw new Error('expected fallback');
    expect(unknownOutcome.reason).toBe('canonical_filesystem_unknown');
    expect(unknownOutcome.activeDatabasePath).toBe(legacyDb);
    expect(unknownOutcome.noticeRequired).toBe(true);
    expect(await exists(canonicalDir)).toBe(false);

    // (3) Legacy itself is on a network share while canonical is also WAL-ineligible -> refuses WAL instead of claiming legacy is local
    await expect(
      relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: globalStorage,
        legacyStorageUri: legacyStorage,
        detectFilesystemType: async () => ({ classification: 'network', filesystemType: 'nfs4' }),
        verifyPrimacy: async () => true
      })
    ).rejects.toBeInstanceOf(RelocationWalFilesystemRefusedError);
    expect(await exists(canonicalDir)).toBe(false);

    // (4) resolveTrustedSqliteLocation refuses explicit network classification and preserves unknown classification
    const netLoc = await resolveTrustedSqliteLocation({
      trustedRootDir: globalStorage,
      relativeSegments: ['sqlite', SCOPE_ID],
      sourceKind: 'host_global_storage_uri',
      filesystemClassification: 'network',
      requestedJournalMode: 'wal'
    });
    expect(netLoc.status).toBe('refused');
    if (netLoc.status === 'refused') expect(netLoc.reason).toBe('network_share_wal_unsupported');

    const unknownLocRoot = path.join(root, 'unknown-loc');
    await fsp.mkdir(unknownLocRoot, { recursive: true, mode: 0o700 });
    const unknownLoc = await resolveTrustedSqliteLocation({
      trustedRootDir: unknownLocRoot,
      relativeSegments: ['sqlite', SCOPE_ID],
      sourceKind: 'cli_state_dir',
      filesystemClassification: 'unknown',
      requestedJournalMode: 'wal'
    });
    expect(unknownLoc.status).toBe('resolved');
    if (unknownLoc.status === 'resolved') expect(unknownLoc.filesystemType).toBe('unknown');
  });

  it('Task 17: compares max persisted operational/schema timestamp across both sources, sums runs + operational_runs (3+3 > 5+0), and breaks ties by canonical then path', async () => {
    // (1) Newer schema/cutover metadata timestamp beats older operational timestamp
    const root1 = await makeTempDir('fr-r7-11-task17-ts-');
    const global1 = path.join(root1, 'globalStorage', 'schegent.schegent');
    const legA1 = path.join(root1, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legB1 = path.join(root1, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    const olderOpNewerMetaDb = await seedCustomDatabase(legA1, SCOPE_ID, {
      operationalRunIds: ['op-a'],
      operationalUpdatedAtMs: 1_700_000_001_000,
      metadataUpdatedAtMs: 1_700_000_050_000
    });
    await seedCustomDatabase(legB1, SCOPE_ID, {
      operationalRunIds: ['op-b'],
      operationalUpdatedAtMs: 1_700_000_010_000,
      metadataUpdatedAtMs: 1_700_000_010_000
    });

    const tsRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global1,
      legacyStorageUri: legA1,
      verifyPrimacy: async () => true
    });
    expect(tsRes.outcome).toBe('conflict_resolved');
    if (tsRes.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(tsRes.winnerSourcePath).toBe(olderOpNewerMetaDb);

    // (2) Tied timestamps: 3 relational + 3 operational (= 6) beats 5 relational + 0 operational (= 5)
    const root2 = await makeTempDir('fr-r7-11-task17-sum-');
    const global2 = path.join(root2, 'globalStorage', 'schegent.schegent');
    const leg5plus0 = path.join(root2, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const leg3plus3 = path.join(root2, 'workspaceStorage', '2222bbbb', 'schegent.schegent');

    await seedCustomDatabase(leg5plus0, SCOPE_ID, {
      relationalRunIds: ['r1', 'r2', 'r3', 'r4', 'r5'],
      operationalRunIds: [],
      operationalUpdatedAtMs: 1_700_000_020_000,
      metadataUpdatedAtMs: 1_700_000_020_000
    });
    const db3plus3 = await seedCustomDatabase(leg3plus3, SCOPE_ID, {
      relationalRunIds: ['s1', 's2', 's3'],
      operationalRunIds: ['o1', 'o2', 'o3'],
      operationalUpdatedAtMs: 1_700_000_020_000,
      metadataUpdatedAtMs: 1_700_000_020_000
    });

    const sumRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global2,
      legacyStorageUri: leg5plus0,
      verifyPrimacy: async () => true
    });
    expect(sumRes.outcome).toBe('conflict_resolved');
    if (sumRes.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(sumRes.winnerSourcePath).toBe(db3plus3);

    // (3) Tied timestamp & summed runCount across two legacy DBs: lexicographical path order wins
    const root3 = await makeTempDir('fr-r7-11-task17-path-');
    const global3 = path.join(root3, 'globalStorage', 'schegent.schegent');
    const legAlpha = path.join(root3, 'workspaceStorage', 'aaaa1111', 'schegent.schegent');
    const legBeta = path.join(root3, 'workspaceStorage', 'bbbb2222', 'schegent.schegent');

    const alphaDb = await seedCustomDatabase(legAlpha, SCOPE_ID, {
      operationalRunIds: ['a-1'],
      relationalRunIds: ['a-r1'],
      operationalUpdatedAtMs: 1_700_000_030_000,
      metadataUpdatedAtMs: 1_700_000_030_000
    });
    await seedCustomDatabase(legBeta, SCOPE_ID, {
      operationalRunIds: ['b-1'],
      relationalRunIds: ['b-r1'],
      operationalUpdatedAtMs: 1_700_000_030_000,
      metadataUpdatedAtMs: 1_700_000_030_000
    });

    const pathRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global3,
      legacyStorageUri: legBeta,
      verifyPrimacy: async () => true
    });
    expect(pathRes.outcome).toBe('conflict_resolved');
    if (pathRes.outcome !== 'conflict_resolved') throw new Error('expected conflict_resolved');
    expect(pathRes.winnerSourcePath).toBe(alphaDb);
  });

  it('Task 18: rejects in-root symlinks and inspects losing, schema-refused, WAL-present, and passive DBs with 0 sidecars created and byte-identical files', async () => {
    const root = await makeTempDir('fr-r7-11-task18-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');

    // (1) In-root symlink in candidate parent chain MUST be refused before opening
    const symLegacy = path.join(root, 'in-root-symlink-legacy');
    const realTargetDir = path.join(symLegacy, 'real-target');
    await fsp.mkdir(path.join(symLegacy, 'sqlite'), { recursive: true, mode: 0o700 });
    await fsp.mkdir(realTargetDir, { recursive: true, mode: 0o700 });
    await seedCustomDatabase(path.join(symLegacy, 'real-holder'), SCOPE_ID, { operationalRunIds: ['run-hidden'] });
    await fsp.symlink(
      path.join(symLegacy, 'real-holder', 'sqlite', SCOPE_ID),
      path.join(symLegacy, 'sqlite', SCOPE_ID)
    );

    const symProbe = await withZeroMutationReadOnlySqlite(symLegacy, ['sqlite', SCOPE_ID], 'schegent-state.db', () => true);
    expect(symProbe.outcome).toBe('refused');
    if (symProbe.outcome === 'refused') expect(symProbe.reason).toBe('symlink-component');

    const symSyncProbe = openZeroMutationReadOnlySqliteSync(symLegacy, ['sqlite', SCOPE_ID], 'schegent-state.db');
    expect(symSyncProbe.kind).toBe('refused');

    const symReloc = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: symLegacy,
      verifyPrimacy: async () => true
    });
    expect(symReloc.outcome).toBe('noop');
    expect(symReloc.noticeRequired).toBe(true);
    expect(symReloc.incompleteDiscovery).toBe(true);
    expect(symReloc.diagnostics).toContain('candidate-containment-refused:legacy:symlink-component');

    // (2) Losing WAL DB with zero pre-existing sidecars creates 0 -wal/-shm and stays byte-identical
    const losingLegacy = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const winningLegacy = path.join(root, 'workspaceStorage', '2222bbbb', 'schegent.schegent');
    const losingDb = await seedCustomDatabase(losingLegacy, SCOPE_ID, {
      operationalRunIds: ['loser-1'],
      operationalUpdatedAtMs: 1_700_000_001_000
    });
    await seedCustomDatabase(winningLegacy, SCOPE_ID, {
      operationalRunIds: ['winner-1'],
      operationalUpdatedAtMs: 1_700_000_010_000
    });
    const losingDir = path.dirname(losingDb);
    expect((await fsp.readdir(losingDir)).sort()).toEqual(['schegent-state.db']);
    const losingShaBefore = await sha256File(losingDb);

    const conflictRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: losingLegacy,
      verifyPrimacy: async () => true
    });
    expect(conflictRes.outcome).toBe('conflict_resolved');
    expect((await fsp.readdir(losingDir)).sort()).toEqual(['schegent-state.db']);
    expect(await sha256File(losingDb)).toBe(losingShaBefore);

    // (3) Schema-refused DB with zero pre-existing sidecars creates 0 -wal/-shm and stays byte-identical
    const futureRoot = path.join(root, 'future-only');
    const futureDb = await seedCustomDatabase(futureRoot, SCOPE_ID, {
      operationalRunIds: ['future-1'],
      minReaderVersionOverride: 99
    });
    const futureDir = path.dirname(futureDb);
    expect((await fsp.readdir(futureDir)).sort()).toEqual(['schegent-state.db']);
    const futureShaBefore = await sha256File(futureDb);

    const futureRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: path.join(root, 'globalStorage-future'),
      legacyStorageUri: futureRoot,
      verifyPrimacy: async () => true
    });
    expect(futureRes.outcome).toBe('refused_newer_schema');
    expect((await fsp.readdir(futureDir)).sort()).toEqual(['schegent-state.db']);
    expect(await sha256File(futureDb)).toBe(futureShaBefore);

    // (4) WAL-present candidate (with `-wal`, NO `-shm`) reads committed WAL frames accurately
    // while leaving `.db` and `-wal` 100% byte-identical and creating 0 `-shm` files!
    const walRoot = path.join(root, 'wal-staged-only');
    const walDb = await seedCustomDatabase(walRoot, SCOPE_ID, {
      operationalRunIds: ['base-run'],
      operationalUpdatedAtMs: 1_700_000_005_000,
      catalogManifestJson: JSON.stringify({ version: 1, entries: [] }),
      leaveWalWithoutShm: { extraOperationalRunId: 'uncheckpointed-wal-run', tsMs: 1_700_000_006_000 }
    });
    const walDir = path.dirname(walDb);
    expect((await fsp.readdir(walDir)).sort()).toEqual(['schegent-state.db', 'schegent-state.db-wal']);
    const walDbShaBefore = await sha256File(walDb);
    const walSidecarShaBefore = await sha256File(`${walDb}-wal`);

    const stagedRead = await withZeroMutationReadOnlySqliteConnection(
      walRoot,
      ['sqlite', SCOPE_ID],
      'schegent-state.db',
      (conn) => {
        const rows = conn.all<{ run_id: string }>('SELECT run_id FROM operational_runs ORDER BY run_id ASC');
        return rows.map((r) => r.run_id);
      }
    );
    expect(stagedRead.outcome).toBe('ok');
    if (stagedRead.outcome !== 'ok') throw new Error('expected ok');
    expect(stagedRead.value).toEqual(['base-run', 'uncheckpointed-wal-run']);
    expect((await fsp.readdir(walDir)).sort()).toEqual(['schegent-state.db', 'schegent-state.db-wal']);
    expect(await sha256File(walDb)).toBe(walDbShaBefore);
    expect(await sha256File(`${walDb}-wal`)).toBe(walSidecarShaBefore);

    // Passive catalog snapshot async read on WAL-present DB creates 0 `-shm` and mutates 0 bytes
    const catalogAdapter = createSwitchableCatalogFsAdapter({
      readFile: async () => ({ outcome: 'absent' }),
      writeFileAtomic: async () => ({ outcome: 'failed', errno: 'EROFS' }),
      writeFileIfAbsent: async () => ({ outcome: 'failed', errno: 'EROFS' }),
      listDirectory: async () => [],
      removeFile: async () => ({ outcome: 'absent' }),
      checkWritability: async () => 'not-writable'
    });
    expect(
      await catalogAdapter.attachReadOnlySnapshotIfPresentAsync(walRoot, ['sqlite', SCOPE_ID], 'schegent-state.db', SCOPE_ID)
    ).toBe(true);
    expect((await fsp.readdir(walDir)).sort()).toEqual(['schegent-state.db', 'schegent-state.db-wal']);
    expect(await sha256File(walDb)).toBe(walDbShaBefore);
    expect(await sha256File(`${walDb}-wal`)).toBe(walSidecarShaBefore);

    // Passive sync read on closed WAL DB (no `-wal`) uses immutable=1 -> 0 sidecars created
    const roConn = openReadOnlySqliteConnection(losingDb);
    try {
      const rows = roConn.all<{ run_id: string }>('SELECT run_id FROM operational_runs');
      expect(rows.map((r) => r.run_id)).toEqual(['loser-1']);
    } finally {
      roConn.close();
    }
    expect((await fsp.readdir(losingDir)).sort()).toEqual(['schegent-state.db']);
    expect(await sha256File(losingDb)).toBe(losingShaBefore);
  });

  it('Task 19: surfaces corrupt legacy DB, sorted-before-truncation & unreadable discovery, malformed receipt validation, and retryable retirement', async () => {
    // (1) Corrupt legacy DB produces diagnostics & noticeRequired: true (never silent noop)
    const root1 = await makeTempDir('fr-r7-11-task19-corrupt-');
    const global1 = path.join(root1, 'globalStorage', 'schegent.schegent');
    const corruptLegacy = path.join(root1, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const corruptDir = path.join(corruptLegacy, 'sqlite', SCOPE_ID);
    await fsp.mkdir(corruptDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(corruptDir, 'schegent-state.db'), 'NOT_A_VALID_SQLITE_FILE_BYTES', { mode: 0o600 });

    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const corruptRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global1,
      legacyStorageUri: corruptLegacy,
      logger: {
        warn: (message, context) =>
          warnings.push(context !== undefined ? { message, context } : { message })
      },
      verifyPrimacy: async () => true
    });
    expect(corruptRes.outcome).toBe('noop');
    expect(corruptRes.noticeRequired).toBe(true);
    expect(corruptRes.corruptCandidateCount).toBe(1);
    expect(corruptRes.diagnostics).toContain('candidate-corrupt:legacy');
    expect(warnings.length).toBeGreaterThan(0);

    // (2) Sibling discovery sorts BEFORE slicing and reports truncation diagnostics
    const root2 = await makeTempDir('fr-r7-11-task19-trunc-');
    const global2 = path.join(root2, 'globalStorage', 'schegent.schegent');
    const legZ = path.join(root2, 'workspaceStorage', 'zzzz', 'schegent.schegent');
    const legA = path.join(root2, 'workspaceStorage', 'aaaa', 'schegent.schegent');
    const legB = path.join(root2, 'workspaceStorage', 'bbbb', 'schegent.schegent');
    await fsp.mkdir(legZ, { recursive: true, mode: 0o700 });
    await fsp.mkdir(legB, { recursive: true, mode: 0o700 });
    const dbA = await seedDatabase(legA, SCOPE_ID, { runIds: ['run-from-aaaa'], updatedAtMs: 1_700_000_005_000 });

    const truncRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global2,
      legacyStorageUri: legZ,
      maxWorkspaceStorageEntries: 2,
      verifyPrimacy: async () => true
    });
    // Sorted entries are ['aaaa', 'bbbb', 'zzzz'] -> slice(0, 2) includes 'aaaa' (would be missed if unsorted!)
    expect(truncRes.outcome).toBe('relocated');
    if (truncRes.outcome !== 'relocated') throw new Error('expected relocated');
    expect(truncRes.relocatedFromPath).toBe(dbA);
    expect(truncRes.incompleteDiscovery).toBe(true);
    expect(truncRes.noticeRequired).toBe(true);
    expect(truncRes.diagnostics?.some((d) => d.startsWith('legacy-discovery-truncated:skipped=1:limit=2'))).toBe(true);

    // (3) Malformed relocation-receipt.json handled safely without crash + strict validators
    expect(isValidRelocationReceipt({ version: 1, scopeId: SCOPE_ID, relocatedAtMs: 1, winnerSourcePath: null, preservedConflicts: 'bad' }, SCOPE_ID)).toBe(false);
    expect(isValidRelocationJournal({ version: 1, scopeId: SCOPE_ID, stagedSha256: 'bad' }, SCOPE_ID)).toBe(false);
    expect(isValidPreservedConflictEntry({ databasePath: 'relative/path.db', origin: 'legacy_in_place' })).toBe(false);

    const root3 = await makeTempDir('fr-r7-11-task19-receipt-');
    const global3 = path.join(root3, 'globalStorage', 'schegent.schegent');
    await seedDatabase(global3, SCOPE_ID, { runIds: ['canon-ok'] });
    const receiptPath = path.join(global3, 'sqlite', SCOPE_ID, 'relocation-receipt.json');
    await fsp.writeFile(
      receiptPath,
      JSON.stringify({ version: 1, scopeId: SCOPE_ID, relocatedAtMs: 100, winnerSourcePath: null, preservedConflicts: 'corrupt-shape' }),
      { mode: 0o600 }
    );
    const badReceiptRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global3,
      verifyPrimacy: async () => true
    });
    expect(badReceiptRes.outcome).toBe('noop');
    expect(badReceiptRes.noticeRequired).toBe(true);
    expect(badReceiptRes.incompleteDiscovery).toBe(true);
    expect(badReceiptRes.diagnostics).toContain('relocation-receipt-malformed');

    // (4) Unreadable workspaceStorage parent (symlinked) reports incompleteDiscovery
    const root4 = await makeTempDir('fr-r7-11-task19-parent-');
    const global4 = path.join(root4, 'globalStorage', 'schegent.schegent');
    const realWsParent = path.join(root4, 'real-ws-storage');
    await fsp.mkdir(path.join(realWsParent, '1111aaaa', 'schegent.schegent'), { recursive: true, mode: 0o700 });
    await fsp.symlink(realWsParent, path.join(root4, 'workspaceStorage'));
    const parentRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global4,
      legacyStorageUri: path.join(root4, 'workspaceStorage', '1111aaaa', 'schegent.schegent'),
      verifyPrimacy: async () => true
    });
    expect(parentRes.outcome).toBe('noop');
    expect(parentRes.incompleteDiscovery).toBe(true);
    expect(parentRes.noticeRequired).toBe(true);
    expect(parentRes.diagnostics).toContain('legacy-parent-not-directory-or-symlink');

    // (5) Failed legacy retirement unlink retains `.relocation-in-progress.json` and retries cleanly on next activation
    const root5 = await makeTempDir('fr-r7-11-task19-retire-');
    const global5 = path.join(root5, 'globalStorage', 'schegent.schegent');
    const legacy5 = path.join(root5, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacy5Db = await seedDatabase(legacy5, SCOPE_ID, { runIds: ['run-retire-1'], updatedAtMs: 1_700_000_005_000 });
    const canonical5Db = path.join(global5, 'sqlite', SCOPE_ID, 'schegent-state.db');
    const journal5Path = path.join(global5, 'sqlite', SCOPE_ID, '.relocation-in-progress.json');

    const firstAttempt = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global5,
      legacyStorageUri: legacy5,
      unlinkLegacyFile: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      verifyPrimacy: async () => true
    });
    expect(firstAttempt.outcome).toBe('relocated');
    expect(firstAttempt.retirementPending).toBe(true);
    expect(firstAttempt.noticeRequired).toBe(true);
    expect(firstAttempt.diagnostics).toContain('legacy-retirement-pending');
    expect(await exists(canonical5Db)).toBe(true);
    expect(await exists(legacy5Db)).toBe(true);
    expect(await exists(journal5Path)).toBe(true);
    expect(readOperationalRunIds(canonical5Db)).toEqual(['run-retire-1']);

    // Simulate new writes to canonical DB between failed retirement and next primary activation
    const liveCanonical = new DatabaseSync(canonical5Db);
    liveCanonical
      .prepare(
        `INSERT INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
         VALUES (?, 'q-after', 'run-after-publish', 1, 'feat-after', 'completed', 'done', 1700000099000, 1700000099000, NULL, '{"id":"run-after-publish"}')`
      )
      .run(SCOPE_ID);
    liveCanonical.close();

    // Retry succeeds cleanly: retires legacy DB, removes journal, keeps canonical writes, zero false conflict!
    const retryAttempt = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: global5,
      legacyStorageUri: legacy5,
      verifyPrimacy: async () => true
    });
    expect(retryAttempt.outcome).toBe('relocated');
    expect(retryAttempt.retirementPending).toBeUndefined();
    expect(retryAttempt.noticeRequired).toBe(false);
    expect(await exists(legacy5Db)).toBe(false);
    expect(await exists(journal5Path)).toBe(false);
    expect(readOperationalRunIds(canonical5Db)).toEqual(['run-after-publish', 'run-retire-1']);
  });

  it('B-P1-2: relocates cleanly (publish, journal, and receipt rename) when globalStorageUri traverses a symlinked ancestor directory', async () => {
    const root = await makeTempDir('fr-r7-11-symlink-ancestor-');
    const realGlobal = path.join(root, 'real-global');
    const linkGlobal = path.join(root, 'link-global');
    await fsp.mkdir(realGlobal, { recursive: true, mode: 0o700 });
    await fsp.symlink(realGlobal, linkGlobal);

    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, {
      runIds: ['run-link-ancestor'],
      updatedAtMs: 1_700_000_010_000
    });

    const res = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: linkGlobal,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });

    expect(res.outcome).toBe('relocated');
    if (res.outcome !== 'relocated') throw new Error('expected relocated');
    expect(await exists(res.activeDatabasePath)).toBe(true);
    expect(await exists(path.join(realGlobal, 'sqlite', SCOPE_ID, 'schegent-state.db'))).toBe(true);
    expect(await exists(path.join(realGlobal, 'sqlite', SCOPE_ID, 'relocation-receipt.json'))).toBe(true);
    expect(await exists(path.join(realGlobal, 'sqlite', SCOPE_ID, '.relocation-in-progress.json'))).toBe(false);
    expect(await exists(legacyDb)).toBe(false);
    expect(readOperationalRunIds(res.activeDatabasePath)).toEqual(['run-link-ancestor']);
  });

  it('B-P1-3: preserves WAL sidecar when legacy .db unlink fails so retry succeeds cleanly even after canonical writes', async () => {
    const root = await makeTempDir('fr-r7-11-wal-retire-retry-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacyDb = await seedDatabase(legacyStorage, SCOPE_ID, {
      runIds: ['run-base'],
      updatedAtMs: 1_700_000_010_000,
      leaveWalUncheckpointed: true,
      extraWalRunId: 'run-wal-frame'
    });
    expect(await exists(`${legacyDb}-wal`)).toBe(true);
    const canonicalDb = path.join(globalStorage, 'sqlite', SCOPE_ID, 'schegent-state.db');

    const unlinkedPaths: string[] = [];
    const first = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      unlinkLegacyFile: async (resolvedPath) => {
        unlinkedPaths.push(resolvedPath);
        if (resolvedPath.endsWith('schegent-state.db')) {
          throw Object.assign(new Error('file locked'), { code: 'EBUSY' });
        }
        await fsp.unlink(resolvedPath);
      },
      verifyPrimacy: async () => true
    });

    expect(first.outcome).toBe('relocated');
    expect(first.retirementPending).toBe(true);
    // Because .db unlink failed first, -wal must NOT have been unlinked prematurely!
    expect(unlinkedPaths.some((p) => p.endsWith('-wal'))).toBe(false);
    expect(await exists(legacyDb)).toBe(true);
    expect(await exists(`${legacyDb}-wal`)).toBe(true);
    expect(readOperationalRunIds(canonicalDb)).toEqual(['run-base', 'run-wal-frame']);

    // New write mutates canonical DB SHA before retry.
    const liveCanonical = new DatabaseSync(canonicalDb);
    liveCanonical
      .prepare(
        `INSERT INTO operational_runs (scope_id, queue_id, run_id, revision, feature_id, status, current_phase, started_at_ms, last_transition_at_ms, failure_cause, payload_json)
         VALUES (?, 'q-new', 'run-post-publish', 1, 'feat-new', 'completed', 'done', 1700000099000, 1700000099000, NULL, '{"id":"run-post-publish"}')`
      )
      .run(SCOPE_ID);
    liveCanonical.close();

    // Retry retires legacy .db AND -wal cleanly with zero spurious conflict.
    const retry = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });
    expect(retry.outcome).toBe('relocated');
    expect(retry.retirementPending).toBeUndefined();
    expect(retry.noticeRequired).toBe(false);
    expect(await exists(legacyDb)).toBe(false);
    expect(await exists(`${legacyDb}-wal`)).toBe(false);
    expect(readOperationalRunIds(canonicalDb)).toEqual(['run-base', 'run-post-publish', 'run-wal-frame']);
  });

  it('Sec-H2 / B-P2-6: refuses intermediate sqlite symlink with zero out-of-root reads/unlinks and leaves network/unknown canonical dirs untouched', async () => {
    // (a) <globalStorageUri>/sqlite -> /outside symlink must never read or unlink files in /outside
    const root1 = await makeTempDir('fr-r7-11-sec-h2-symlink-');
    const symGlobal = path.join(root1, 'sym-global');
    const outsideDir = path.join(root1, 'outside');
    const outsideScope = path.join(outsideDir, SCOPE_ID);
    await fsp.mkdir(symGlobal, { recursive: true, mode: 0o700 });
    await fsp.mkdir(outsideScope, { recursive: true, mode: 0o700 });
    const outsideReceipt = path.join(outsideScope, 'relocation-receipt.json');
    const outsideJournal = path.join(outsideScope, '.relocation-in-progress.json');
    const outsideStaging = path.join(outsideScope, '.schegent-state.relocate.staging.db');
    await fsp.writeFile(outsideReceipt, '{"corrupt": true}', { mode: 0o600 });
    await fsp.writeFile(outsideJournal, '{malformed-json', { mode: 0o600 });
    await fsp.writeFile(outsideStaging, 'outside-staging-sentinel', { mode: 0o600 });
    await fsp.symlink(outsideDir, path.join(symGlobal, 'sqlite'));

    const legacy1 = path.join(root1, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const legacy1Db = await seedDatabase(legacy1, SCOPE_ID, { runIds: ['run-safe-legacy'] });

    const symRes = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: symGlobal,
      legacyStorageUri: legacy1,
      verifyPrimacy: async () => true
    });
    expect(symRes.outcome).toBe('fallback_legacy_preserved');
    if (symRes.outcome !== 'fallback_legacy_preserved') throw new Error('expected fallback');
    expect(symRes.reason).toBe('symlink_or_containment_refused');
    expect(symRes.activeDatabasePath).toBe(legacy1Db);
    // Out-of-root files must remain completely untouched (zero unlinks, zero receipt-malformed read).
    expect(await exists(outsideReceipt)).toBe(true);
    expect(await exists(outsideJournal)).toBe(true);
    expect(await exists(outsideStaging)).toBe(true);
    expect(symRes.diagnostics ?? []).not.toContain('relocation-receipt-malformed');

    // (b) Stale journal + staging inside WAL-refused network AND unknown-fallback canonical dirs: zero deletes/writes!
    for (const mode of ['network', 'unknown'] as const) {
      const root2 = await makeTempDir(`fr-r7-11-sec-h2-${mode}-`);
      const global2 = path.join(root2, 'globalStorage', 'schegent.schegent');
      const canonScope = path.join(global2, 'sqlite', SCOPE_ID);
      await fsp.mkdir(canonScope, { recursive: true, mode: 0o700 });
      const staleJournal = path.join(canonScope, '.relocation-in-progress.json');
      const staleStaging = path.join(canonScope, '.schegent-state.relocate.staging.db');
      await fsp.writeFile(staleJournal, '{stale-journal', { mode: 0o600 });
      await fsp.writeFile(staleStaging, 'stale-staging-bytes', { mode: 0o600 });
      const journalSha = await sha256File(staleJournal);
      const stagingSha = await sha256File(staleStaging);

      const legacy2 = path.join(root2, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
      await seedDatabase(legacy2, SCOPE_ID, { emptyShell: true });

      const probedPaths: string[] = [];
      const res = await relocateLegacySqliteStore({
        scopeId: SCOPE_ID,
        globalStorageUri: global2,
        legacyStorageUri: legacy2,
        detectFilesystemType: async (target) => {
          probedPaths.push(target);
          return target.startsWith(path.resolve(global2))
            ? mode === 'network'
              ? { classification: 'network', filesystemType: 'nfs4' }
              : { classification: 'unknown', filesystemType: 'unknown' }
            : { classification: 'local', filesystemType: 'apfs' };
        },
        verifyPrimacy: async () => true
      });
      expect(res.outcome).toBe('fallback_legacy_preserved');
      expect(await exists(staleJournal)).toBe(true);
      expect(await exists(staleStaging)).toBe(true);
      expect(await sha256File(staleJournal)).toBe(journalSha);
      expect(await sha256File(staleStaging)).toBe(stagingSha);
      // B-P3-9: legacy FS probe must inspect `<legacyRoot>/sqlite/<scopeId>`.
      expect(probedPaths).toContain(path.join(path.resolve(legacy2), 'sqlite', SCOPE_ID));
    }
  });

  it('Sec-M2: rejects tampered relocation journal targeting an unrelated file or canonicalRoot and leaves targets untouched', async () => {
    const root = await makeTempDir('fr-r7-11-sec-m2-journal-');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', '1111aaaa', 'schegent.schegent');
    const canonicalDb = await seedDatabase(globalStorage, SCOPE_ID, { runIds: ['canon-keep'] });
    const canonicalSha = await sha256File(canonicalDb);
    const victimFile = path.join(legacyStorage, 'unrelated-secret.txt');
    await fsp.mkdir(legacyStorage, { recursive: true, mode: 0o700 });
    await fsp.writeFile(victimFile, 'do-not-unlink', { mode: 0o600 });

    const baseTampered = {
      version: 1,
      scopeId: SCOPE_ID,
      stagedSha256: canonicalSha,
      winnerFingerprint: { sizeBytes: 12, mtimeMs: 1_700_000_000_000, walSizeBytes: 0, walMtimeMs: 0 },
      preservedConflicts: [],
      startedAtMs: 1_700_000_000_000
    };

    const tamperedUnrelated = {
      ...baseTampered,
      winnerStorageRoot: legacyStorage,
      winnerDatabasePath: victimFile
    };
    expect(isValidRelocationJournal(tamperedUnrelated, SCOPE_ID, globalStorage)).toBe(false);

    const tamperedCanonical = {
      ...baseTampered,
      winnerStorageRoot: globalStorage,
      winnerDatabasePath: canonicalDb
    };
    expect(isValidRelocationJournal(tamperedCanonical, SCOPE_ID, globalStorage)).toBe(false);

    // Plant tampered journal targeting unrelated victim file -> discarded, victim untouched.
    const journalPath = path.join(globalStorage, 'sqlite', SCOPE_ID, '.relocation-in-progress.json');
    await fsp.writeFile(journalPath, JSON.stringify(tamperedUnrelated), { mode: 0o600 });
    const res1 = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });
    expect(res1.outcome).toBe('noop');
    expect(await exists(victimFile)).toBe(true);
    expect(await exists(journalPath)).toBe(false);
    expect(await exists(canonicalDb)).toBe(true);

    // Plant tampered journal targeting canonicalRoot -> discarded, canonical DB untouched.
    await fsp.writeFile(journalPath, JSON.stringify(tamperedCanonical), { mode: 0o600 });
    const res2 = await relocateLegacySqliteStore({
      scopeId: SCOPE_ID,
      globalStorageUri: globalStorage,
      legacyStorageUri: legacyStorage,
      verifyPrimacy: async () => true
    });
    expect(res2.outcome).toBe('noop');
    expect(await exists(canonicalDb)).toBe(true);
    expect(readOperationalRunIds(canonicalDb)).toEqual(['canon-keep']);
  });

  it('B-P3-9: resolveTrustedSqliteLocation validates relativeSegments before probing filesystem on leaf directory', async () => {
    const root = await makeTempDir('fr-r7-11-bp3-9-');
    const probed: string[] = [];
    const bad = await resolveTrustedSqliteLocation({
      trustedRootDir: root,
      relativeSegments: ['..', 'escape'],
      sourceKind: 'cli_state_dir',
      detectFilesystemType: async (target) => {
        probed.push(target);
        return { classification: 'local', filesystemType: 'apfs' };
      }
    });
    expect(bad.status).toBe('refused');
    if (bad.status === 'refused') expect(bad.reason).toBe('escapes_trusted_root');
    expect(probed).toEqual([]);

    const ok = await resolveTrustedSqliteLocation({
      trustedRootDir: root,
      relativeSegments: ['sqlite', SCOPE_ID],
      sourceKind: 'cli_state_dir',
      detectFilesystemType: async (target) => {
        probed.push(target);
        return { classification: 'local', filesystemType: 'apfs' };
      }
    });
    expect(ok.status).toBe('resolved');
    expect(probed).toEqual([path.join(root, 'sqlite', SCOPE_ID)]);
  });
});
