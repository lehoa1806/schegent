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
  SqliteApplicationStore,
  relocateLegacySqliteStore,
  resolveTrustedSqliteLocation,
  type RelocationStage
} from '../../../src/services/sqlite-store';

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
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
