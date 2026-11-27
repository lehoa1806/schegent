/**
 * FR-R7-14 (14-03) — Large restore execution, event-loop/heartbeat continuity,
 * real two-window ownership contention (`WorkspaceLockManager` over disk ownership store),
 * pre-commit refusal vs `committed_refresh_failed` distinction, and over-ceiling refusal.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import {
  runRestoreStoreBackup,
  type BackupPickerItem,
  type BackupRestoreCommandUi
} from '../../src/commands/sqlite-backup-restore';
import {
  createStoreBackupRestoreApi,
  createWorkspaceExternalDependencyInspector
} from '../../src/headless/backup-restore-api';
import { SanitizedLogger } from '../../src/lib/logger';
import { AUTHORITATIVE_RESTORE_TABLES } from '../../src/services/sqlite-store/authoritative-restore-tables';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import {
  HEARTBEAT_INTERVAL_MS,
  STALENESS_THRESHOLD_MS,
  WorkspaceLockManager,
  type Clock,
  type Scheduler
} from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';
import { waitForCondition } from '../wait-for-condition';

function createMemoryMemento(): Memento {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    }
  };
}

class ManualClock implements Clock {
  public current: number;
  public constructor(initial: number) {
    this.current = initial;
  }
  public now(): number {
    return this.current;
  }
  public advance(ms: number): void {
    this.current += ms;
  }
}

const noopScheduler: Scheduler = {
  setInterval: () => ({ clear: () => undefined })
};

function createStubUi(): {
  readonly ui: BackupRestoreCommandUi;
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    ui: {
      async pickBackup(items: readonly BackupPickerItem[]) {
        return items[0];
      },
      async confirmModal() {
        return true;
      },
      info(message: string) {
        infos.push(message);
      },
      warn(message: string) {
        warns.push(message);
      },
      error(message: string) {
        errors.push(message);
      }
    }
  };
}

function populateMultiMbStore(
  store: SqliteApplicationStore,
  scopeId: string,
  now: number,
  targetMiB: number
): { readonly handoffId: string; readonly kvRows: number; readonly runRows: number } {
  const conn = store.writerConnection;
  const payloadChunk = 'p'.repeat(4000);
  const kvRows = Math.max(200, Math.floor((targetMiB * 1024 * 1024) / 4250));
  const runRows = Math.min(500, Math.max(20, Math.floor(kvRows / 20)));
  const handoffId = 'a'.repeat(64);

  conn.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < runRows; i += 1) {
      conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, current_step_id,
          started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'wf-large', 'succeeded', 1, ?, ?, ?, 'ok', ?, ?)`,
        `run-${i}`,
        scopeId,
        `step-${i}`,
        now + i,
        now + i + 100,
        now + i,
        now + i + 100
      );
      conn.run(
        `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, updated_at_ms)
         VALUES (?, ?, 0, 'implement', 'succeeded', 1, ?)`,
        `step-${i}`,
        `run-${i}`,
        now + i
      );
      conn.run(
        `INSERT INTO attempts (attempt_id, run_id, step_id, attempt_number, status, exit_code, started_at_ms, completed_at_ms)
         VALUES (?, ?, ?, 1, 'succeeded', 0, ?, ?)`,
        `att-${i}`,
        `run-${i}`,
        `step-${i}`,
        now + i,
        now + i + 50
      );
    }

    for (let i = 0; i < kvRows; i += 1) {
      const payload = `{"idx":${i},"data":"${payloadChunk}"}`;
      conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, ?, 1, 9, ?, ?, 0, ?)`,
        `large:${scopeId}`,
        `kv-${String(i).padStart(6, '0')}`,
        payload,
        Buffer.byteLength(payload, 'utf8'),
        now + i
      );
    }

    // Include an issued recovery_handoff_revisions row to verify immutability trigger preservation
    conn.run(
      `INSERT INTO recovery_handoffs (
        handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
        state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
        legacy_provenance, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'run-0', 'inv-0', 'att-0', 'ready', 0, NULL, 1, 'pending-handoff', NULL, NULL, ?, ?)`,
      handoffId,
      scopeId,
      now,
      now
    );
    conn.run(
      `INSERT INTO recovery_handoff_revisions (
        handoff_id, revision_no, status, cutoff_key, execution_revision, usage_revision,
        fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
        issued_at_ms, superseded_at_ms
      ) VALUES (?, 1, 'issued', ?, 'exec-1', 1, ?, 1, '{"v":1}', ?, 'safe', 'complete', ?, NULL)`,
      handoffId,
      'b'.repeat(64),
      now,
      'b'.repeat(64),
      now
    );

    // Include AUTOINCREMENT outbox entry to verify sqlite_sequence fidelity
    conn.run(
      `INSERT INTO state_change_outbox (
        commit_unit, scope_kind, scope_id, revision, payload_json, created_at_ms, delivered_at_ms
      ) VALUES ('Admission', 'workspace', ?, 7, '{"ok":true}', ?, NULL)`,
      scopeId,
      now
    );

    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }

  return { handoffId, kvRows, runRows };
}

describe('FR-R7-14 (14-03) Large restore execution, ownership fencing & two-window contention', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempRoot(dir);
    }
  });

  it('restores a representative multi-MB (~16 MiB) schema-9 store via SQLite-native ATTACH copy with row fidelity, trigger preservation, bounded RSS, and heartbeat/logger continuity', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-large-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-large-st-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-large-16m';
    const now = 1_763_960_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });

    const sourceStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'source-16m.db'),
      journalMode: 'wal',
      nowMs: () => now
    });
    const targetStore = new SqliteApplicationStore({
      databasePath: path.join(dbDir, 'schegent-state.db'),
      journalMode: 'wal',
      nowMs: () => now
    });

    try {
      const seeded = populateMultiMbStore(sourceStore, scopeId, now, 16);
      const backup = await sourceStore.backupRestore.createOnlineBackup({
        backupId: 'bkp-large-16m',
        scopeId,
        trustedRootDir: storageRoot,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });
      expect(backup.manifest.databaseBytes).toBeGreaterThan(12 * 1024 * 1024);

      // Seed conflicting rows on targetStore before restoring
      targetStore.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-stale-target', ?, 'wf-stale', 'succeeded', 9, ?, ?)`,
        scopeId,
        now + 999,
        now + 999
      );

      let reloads = 0;
      const loggerLines: string[] = [];
      const logger = new SanitizedLogger([{ appendLine: (line: string) => loggerLines.push(line) }]);
      const api = createStoreBackupRestoreApi({
        getSqliteStore: () => targetStore,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        reloadAfterRestore: () => {
          reloads += 1;
        },
        inspectExternalDependency: createWorkspaceExternalDependencyInspector(workspaceRoot),
        logger,
        nowMs: () => now
      });

      // Measure event-loop delay, rapid timer heartbeat continuity, logger latency, and per-isolate V8 heap delta
      const eld = monitorEventLoopDelay({ resolution: 1 });
      eld.enable();
      let heartbeatTicks = 0;
      let maxHeartbeatGapMs = 0;
      let maxLogLatencyMs = 0;
      let lastTick = performance.now();
      // Measure per-thread V8 heapUsed rather than process-wide RSS because Vitest `pool: 'threads'`
      // shares one OS RSS across concurrent worker threads parsing unrelated test files.
      const heapBefore = process.memoryUsage().heapUsed;
      let peakHeap = heapBefore;

      const probeTimer = setInterval(() => {
        const tickNow = performance.now();
        const gap = tickNow - lastTick;
        if (gap > maxHeartbeatGapMs) maxHeartbeatGapMs = gap;
        lastTick = tickNow;
        heartbeatTicks += 1;
        const logStart = performance.now();
        logger.info('restore-heartbeat-probe', { tick: heartbeatTicks });
        const logDur = performance.now() - logStart;
        if (logDur > maxLogLatencyMs) maxLogLatencyMs = logDur;
        const heapNow = process.memoryUsage().heapUsed;
        if (heapNow > peakHeap) peakHeap = heapNow;
      }, 25);

      let restored: Awaited<ReturnType<typeof api.restoreBackup>>;
      let wallMs: number;
      try {
        const startMs = performance.now();
        restored = await api.restoreBackup('bkp-large-16m');
        wallMs = performance.now() - startMs;
        // Wait for at least one post-restore heartbeat probe tick so monitorEventLoopDelay
        // captures the full transaction stall without relying on a blind fixed sleep.
        const ticksAtRestoreEnd = heartbeatTicks;
        await waitForCondition(() => heartbeatTicks > ticksAtRestoreEnd, {
          timeoutMs: 2_000,
          label: 'post-restore heartbeat probe tick'
        });
      } finally {
        clearInterval(probeTimer);
        eld.disable();
      }

      const eldMaxMs = eld.max / 1e6;
      const heapDeltaMiB =
        (Math.max(peakHeap, process.memoryUsage().heapUsed) - heapBefore) / (1024 * 1024);

      expect(restored.status).toBe('restored');
      if (restored.status === 'restored') {
        expect(restored.outcome).toBe('restored');
        expect(restored.restoredTableCount).toBe(AUTHORITATIVE_RESTORE_TABLES.length);
        expect(restored.restoredRunCount).toBe(seeded.runRows);
        expect(restored.restoredRowCount).toBeGreaterThanOrEqual(seeded.kvRows + seeded.runRows * 3);
      }
      expect(reloads).toBe(1);

      // Event-loop stall and heartbeat gap stay below WorkspaceLockManager's 5 s heartbeat interval
      expect(eldMaxMs).toBeLessThan(HEARTBEAT_INTERVAL_MS);
      expect(maxHeartbeatGapMs).toBeLessThan(HEARTBEAT_INTERVAL_MS);
      expect(wallMs).toBeLessThan(HEARTBEAT_INTERVAL_MS);
      expect(loggerLines.length).toBeGreaterThan(0);
      expect(maxLogLatencyMs).toBeLessThan(500);
      // SQLite-native ATTACH copy avoids O(rows) JS row materialization on this V8 isolate
      expect(heapDeltaMiB).toBeLessThan(64);

      // Verify row-count parity, exact sample rows, trigger enforcement, and sqlite_sequence fidelity
      expect(
        targetStore.writerConnection.scalar<number>(`SELECT COUNT(*) FROM operational_kv_documents`)
      ).toBe(seeded.kvRows);
      expect(
        targetStore.writerConnection.get<{ run_id: string }>(
          `SELECT run_id FROM runs WHERE run_id = 'run-stale-target'`
        )
      ).toBeUndefined();
      expect(
        targetStore.writerConnection.get<{ seq: number }>(
          `SELECT seq FROM sqlite_sequence WHERE name = 'state_change_outbox'`
        )
      ).toEqual({ seq: 1 });
      expect(() =>
        targetStore.writerConnection.run(
          `DELETE FROM recovery_handoff_revisions WHERE handoff_id = ?`,
          seeded.handoffId
        )
      ).toThrow(/issued|immutable|abort/i);
      expect(targetStore.writerConnection.runQuickCheck()).toEqual(['ok']);
      expect(targetStore.writerConnection.runForeignKeyCheck()).toEqual([]);
    } finally {
      sourceStore.close();
      targetStore.close();
    }
  });

  it('enforces real two-window WorkspaceLockManager contention during async validation and immediately before COMMIT with zero target mutation and zero non-owner audit writes', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-2win-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-2win-st-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-2win';
    const baseTime = 1_763_970_000_000;
    const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
    const diskFs = createDiskOwnershipFs({ workspaceRoot, ownershipDir });

    const clockA = new ManualClock(baseTime);
    const clockB = new ManualClock(baseTime);

    const wsStoreA = new WorkspaceStateStore(createMemoryMemento());
    await wsStoreA.initialize();
    wsStoreA.useOwnershipStorage(diskFs, ownershipDir);
    const lockA = new WorkspaceLockManager(wsStoreA, 'window-a', clockA, noopScheduler);

    const wsStoreB = new WorkspaceStateStore(createMemoryMemento());
    await wsStoreB.initialize();
    wsStoreB.useOwnershipStorage(diskFs, ownershipDir);
    const lockB = new WorkspaceLockManager(wsStoreB, 'window-b', clockB, noopScheduler);

    // Window A acquires workspace primacy
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    expect(await lockA.hasPrimacy()).toBe(true);
    expect((await lockB.tryAcquire()).acquired).toBe(false);

    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dbDir, 'schegent-state.db');
    let sqliteStore = new SqliteApplicationStore({
      databasePath: dbPath,
      journalMode: 'wal',
      nowMs: () => baseTime
    });
    const auditWriter = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger([]));
    const warnSpy = vi.fn();

    try {
      // Seed one external dependency so async validation runs through inspectExternalDependency
      const depRel = 'reports/dep-2win.txt';
      const depBytes = Buffer.from('two-window-live-dependency');
      await fs.mkdir(path.join(workspaceRoot, 'reports'), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, depRel), depBytes);
      sqliteStore.artifacts.registerArtifact({
        artifactId: 'art-2win',
        contentSha256: createHash('sha256').update(depBytes).digest('hex'),
        byteLength: depBytes.byteLength,
        mediaType: 'text/plain',
        kind: 'report',
        location: { locationId: 'loc-2win', storageTier: 'workspace_file', uriOrRelpath: depRel }
      });
      sqliteStore.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-backup-state', ?, 'wf-1', 'succeeded', 1, ?, ?)`,
        scopeId,
        baseTime,
        baseTime
      );

      const baseInspector = createWorkspaceExternalDependencyInspector(workspaceRoot);
      let stealDuringValidation = false;
      let stealPromise: Promise<void> | null = null;
      let inFlight = false;
      let reloads = 0;

      const apiA = createStoreBackupRestoreApi({
        getSqliteStore: () => sqliteStore,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: async () => {
          if (stealPromise !== null) {
            await stealPromise;
            stealPromise = null;
          }
          return lockA.hasPrimacy();
        },
        hasInFlightRun: () => inFlight,
        reloadAfterRestore: () => {
          reloads += 1;
        },
        inspectExternalDependency: (relPath, opts) => {
          if (stealDuringValidation) {
            stealDuringValidation = false;
            // Window B reclaims stale lease while Window A is validating backup image
            clockB.advance(STALENESS_THRESHOLD_MS + 1_000);
            stealPromise = lockB.tryAcquire().then((res) => {
              expect(res.acquired).toBe(true);
            });
          }
          return baseInspector(relPath, opts);
        },
        auditWriter,
        logger: { warn: warnSpy },
        nowMs: () => baseTime
      });

      const created = await apiA.createBackup({ backupId: 'bkp-2win' });
      expect(created.status).toBe('created');

      // Mutate live store after backup
      sqliteStore.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-live-must-survive', ?, 'wf-live', 'succeeded', 2, ?, ?)`,
        scopeId,
        baseTime + 50,
        baseTime + 50
      );

      const auditLogPath = path.join(workspaceRoot, '.schegent', 'audit.log');
      const auditCountBefore = (await fs.readFile(auditLogPath, 'utf8')).trim().split('\n').length;

      // Sub-case 1: Window B steals primacy DURING Window A's async validation
      stealDuringValidation = true;
      const lostDuringVal = await apiA.restoreBackup('bkp-2win');
      expect(lostDuringVal).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_OWNERSHIP_LOST'
      });
      expect(reloads).toBe(0);
      expect(await lockB.hasPrimacy()).toBe(true);
      expect(await lockA.hasPrimacy()).toBe(false);
      // Zero non-owner audit writes and sanitized warning logged
      expect((await fs.readFile(auditLogPath, 'utf8')).trim().split('\n')).toHaveLength(
        auditCountBefore
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'store operation refused: workspace ownership lost before restore commit',
        expect.objectContaining({
          operation: 'restore',
          backupId: 'bkp-2win',
          errorCode: 'RESTORE_OWNERSHIP_LOST'
        })
      );

      // Re-establish Window A primacy for Sub-case 2 (steal IMMEDIATELY BEFORE COMMIT!)
      clockA.current = clockB.current + STALENESS_THRESHOLD_MS + 1_000;
      expect((await lockA.tryAcquire()).acquired).toBe(true);
      expect(await lockA.hasPrimacy()).toBe(true);

      const lostAtCommit = await apiA.restoreBackup('bkp-2win', {
        beforeCommitFence: async () => {
          // Inside BEGIN IMMEDIATE after all tables were copied, Window B takes ownership!
          clockB.current = clockA.current + STALENESS_THRESHOLD_MS + 1_000;
          const takeover = await lockB.tryAcquire();
          expect(takeover.acquired).toBe(true);
          return lockA.hasPrimacy();
        }
      });
      expect(lostAtCommit).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_OWNERSHIP_LOST'
      });
      expect(reloads).toBe(0);
      expect((await fs.readFile(auditLogPath, 'utf8')).trim().split('\n')).toHaveLength(
        auditCountBefore
      );

      // Reopen SQLite from disk to prove ROLLBACK left the live database 100% untouched!
      sqliteStore.close();
      sqliteStore = new SqliteApplicationStore({
        databasePath: dbPath,
        journalMode: 'wal',
        nowMs: () => baseTime + 200
      });
      expect(
        sqliteStore.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id)
      ).toEqual(['run-backup-state', 'run-live-must-survive']);

      // Sub-case 3: Re-establish primacy on A, then a Run starts mid-validation -> RESTORE_BUSY rollback
      clockA.current = clockB.current + STALENESS_THRESHOLD_MS + 1_000;
      expect((await lockA.tryAcquire()).acquired).toBe(true);
      let flipBusy = true;
      const busyApi = createStoreBackupRestoreApi({
        getSqliteStore: () => sqliteStore,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: () => lockA.hasPrimacy(),
        hasInFlightRun: () => inFlight,
        reloadAfterRestore: () => {
          reloads += 1;
        },
        inspectExternalDependency: (relPath, opts) => {
          if (flipBusy) {
            flipBusy = false;
            inFlight = true;
          }
          return baseInspector(relPath, opts);
        },
        auditWriter,
        nowMs: () => baseTime
      });
      const busyRes = await busyApi.restoreBackup('bkp-2win');
      expect(busyRes).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_BUSY'
      });
      expect(
        sqliteStore.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id)
      ).toEqual(['run-backup-state', 'run-live-must-survive']);
      expect(reloads).toBe(0);
    } finally {
      await lockA.release();
      await lockB.release();
      sqliteStore.close();
    }
  });

  it('cleanly distinguishes pre-commit refusal, over-ceiling image refusal, and post-commit committed_refresh_failed', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-outcome-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-outcome-st-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-outcomes';
    const now = 1_763_980_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });
    const store = new SqliteApplicationStore({
      databasePath: path.join(dbDir, 'schegent-state.db'),
      journalMode: 'wal',
      nowMs: () => now
    });

    try {
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-v1', ?, 'wf-1', 'succeeded', 1, ?, ?)`,
        scopeId,
        now,
        now
      );

      let failReload = false;
      const api = createStoreBackupRestoreApi({
        getSqliteStore: () => store,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        reloadAfterRestore: async () => {
          if (failReload) throw new Error('post-commit cache refresh error');
        },
        nowMs: () => now
      });

      const created = await api.createBackup({ backupId: 'bkp-outcomes' });
      expect(created.status).toBe('created');
      if (created.status !== 'created') throw new Error('expected backup');

      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-v2-live', ?, 'wf-2', 'succeeded', 2, ?, ?)`,
        scopeId,
        now + 50,
        now + 50
      );

      // 1. Over-ceiling image refusal -> refused_pre_commit, live store untouched
      const overCeilingUi = createStubUi();
      const overCeiling = await runRestoreStoreBackup(
        { api, ui: overCeilingUi.ui },
        { backupId: 'bkp-outcomes', maxDatabaseBytes: created.manifest.databaseBytes - 1 }
      );
      expect(overCeiling).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED'
      });
      expect(overCeilingUi.warns[0]).toContain('RESTORE_IMAGE_BOUND_EXCEEDED');
      expect(overCeilingUi.warns[0]).toContain('Live store was not modified');
      expect(
        store.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id)
      ).toEqual(['run-v1', 'run-v2-live']);

      // 2. Pre-commit fence refusal -> refused_pre_commit, live store untouched
      const preCommitUi = createStubUi();
      const preCommit = await runRestoreStoreBackup(
        { api, ui: preCommitUi.ui },
        { backupId: 'bkp-outcomes', beforeCommitFence: async () => false }
      );
      expect(preCommit).toMatchObject({
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: 'RESTORE_OWNERSHIP_LOST'
      });
      expect(preCommitUi.warns[0]).toContain('RESTORE_OWNERSHIP_LOST');
      expect(preCommitUi.warns[0]).toContain('Live store was not modified');
      expect(
        store.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id)
      ).toEqual(['run-v1', 'run-v2-live']);

      // 3. Post-commit refresh throw -> committed_refresh_failed, live store ON DISK IS restored!
      failReload = true;
      const refreshFailUi = createStubUi();
      const refreshFail = await runRestoreStoreBackup(
        { api, ui: refreshFailUi.ui },
        { backupId: 'bkp-outcomes', maxDatabaseBytes: created.manifest.databaseBytes }
      );
      expect(refreshFail).toMatchObject({
        status: 'committed_refresh_failed',
        outcome: 'committed_refresh_failed',
        errorCode: 'POST_COMMIT_REFRESH_FAILED'
      });
      expect(refreshFailUi.errors[0]).toContain('committed on disk');
      expect(refreshFailUi.errors[0]).toMatch(/reload/i);
      expect(refreshFailUi.errors[0]).not.toMatch(/not modified/i);
      expect(
        store.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id ASC`)
          .map((r) => r.run_id)
      ).toEqual(['run-v1']);
    } finally {
      store.close();
    }
  });

  it('restores an online backup captured while a Run was active onto an idle store without false RESTORE_BUSY from uncommitted rows', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-active-bkp-ws-'));
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-active-bkp-st-'));
    tempDirs.push(workspaceRoot, storageRoot);

    const scopeId = 'scope-active-backup';
    const now = 1_763_962_000_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    await fs.mkdir(dbDir, { recursive: true, mode: 0o700 });

    const store = new SqliteApplicationStore({
      databasePath: path.join(dbDir, 'schegent-state.db'),
      journalMode: 'wal',
      nowMs: () => now
    });
    try {
      // Capture an online WAL backup while a Run row is still 'running'.
      store.writerConnection.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
        ) VALUES ('run-in-progress-at-backup', ?, 'wf-1', 'running', 1, ?, ?)`,
        scopeId,
        now,
        now
      );
      await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-while-running',
        scopeId,
        trustedRootDir: storageRoot,
        relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
      });

      // Transition the live workspace store to idle ('succeeded').
      store.writerConnection.run(
        `UPDATE runs SET status = 'succeeded', revision = 2, updated_at_ms = ? WHERE run_id = 'run-in-progress-at-backup'`,
        now + 100
      );

      // Simulate production `hasInFlightSqliteRun()` reading committed state via `readPool`.
      const hasCommittedInFlightRun = (): boolean =>
        store.readPool.withReadConnection(store.writerConnection, (conn) => {
          const count = Number(
            conn.scalar(
              `SELECT COUNT(*) FROM runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'aborted')`
            ) ?? 0
          );
          return count > 0;
        });

      const api = createStoreBackupRestoreApi({
        getSqliteStore: () => store,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: hasCommittedInFlightRun,
        reloadAfterRestore: () => undefined,
        inspectExternalDependency: createWorkspaceExternalDependencyInspector(workspaceRoot),
        nowMs: () => now
      });

      const restored = await api.restoreBackup('bkp-while-running');
      expect(restored.status).toBe('restored');
      const restoredStatus = store.writerConnection.scalar(
        `SELECT status FROM runs WHERE run_id = 'run-in-progress-at-backup'`
      );
      expect(restoredStatus).toBe('running');
    } finally {
      store.close();
    }
  });
});
