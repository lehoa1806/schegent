/**
 * FR-R8-03 (03-04) — Degraded operation and restore rehearsal on disposable stores and Git repos.
 *
 * Rehearses all six operator-facing failure modes:
 *   1. Disk-full (`ENOSPC`) write failure
 *   2. Provider disconnect after effect
 *   3. Stale ownership handoff
 *   4. Newer-reader schema version refusal (`min_reader_version > 9`)
 *   5. Dirty Git state
 *   6. Restore commit followed by failed refresh (`committed_refresh_failed`)
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../src/contracts/sqlite-store/schema-types';
import { createStoreBackupRestoreApi } from '../../src/headless/backup-restore-api';
import { createExecFileGitRunner, LaneService } from '../../src/services/execution-lanes';
import { LaneStore } from '../../src/services/execution-lanes/lane-store';
import { EvidenceHealthMonitor } from '../../src/services/evidence-health/evidence-health-monitor';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { createProductionWorkflowComposition } from '../../src/services/workflow-execution/production-workflow-composition';
import {
  STALENESS_THRESHOLD_MS,
  WorkspaceLockManager,
  type Clock,
  type Scheduler
} from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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

function insertKvDoc(
  store: SqliteApplicationStore,
  docNamespace: string,
  docKey: string,
  payloadJson: string,
  revision = 1,
  updatedAtMs = 1_763_985_600_000
): void {
  store.writerConnection.run(
    `INSERT INTO operational_kv_documents (
      doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
    ) VALUES (?, ?, ?, 9, ?, ?, 0, ?)`,
    docNamespace,
    docKey,
    revision,
    payloadJson,
    Buffer.byteLength(payloadJson, 'utf8'),
    updatedAtMs
  );
}

function initDisposableGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'drill@example.test'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Schegent Drill'], { cwd: repoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'clean baseline\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial baseline'], { cwd: repoDir, stdio: 'pipe' });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FR-R8-03 (03-04) degraded operation and restore rehearsal', () => {
  it('1. Disk-full (ENOSPC) write failure surfaces explicit degraded health while preserving SQLite and unrelated records on reopen', () => {
    const dir = makeTempDir('schegent-enospc-0304-');
    const dbPath = path.join(dir, 'schegent-state.db');
    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

    try {
      insertKvDoc(store, 'ws-1', 'unrelated-state', '{"keep":"intact"}');

      const monitor = new EvidenceHealthMonitor();
      const shouldWarn = monitor.reportFailure('audit', 'ENOSPC');
      expect(shouldWarn).toBe(true);
      const snapshot = monitor.getSnapshot();
      expect(snapshot.audit.status).toBe('unavailable');
      expect(snapshot.audit.continuationPolicy).toBe('fail-closed');
      expect(snapshot.audit.cause).toBe('disk-full');
      expect(snapshot.overall).toBe('unavailable');
    } finally {
      store.close();
    }

    // Reopen SQLite store: unrelated work is completely intact and healthy
    const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const row = reopened.writerConnection.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = 'ws-1' AND doc_key = 'unrelated-state'`
      );
      expect(row?.payload_json).toBe('{"keep":"intact"}');
      expect(reopened.writerConnection.runQuickCheck()).toEqual(['ok']);
    } finally {
      reopened.close();
    }
  });

  it('2. Provider disconnect after external effect reconciles as uncertain-effect pause without replaying and preserves unrelated work', async () => {
    const dir = makeTempDir('schegent-disconnect-0304-');
    const dbPath = path.join(dir, 'schegent-state.db');
    const receiptPath = path.join(dir, 'provider-effect-receipt.txt');
    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

    const composition = createProductionWorkflowComposition({
      workspaceRoot: dir,
      isWorkspaceTrusted: () => true,
      verifyLiveFence: () => true
    });

    try {
      // Unrelated persisted record in SQLite
      insertKvDoc(store, 'ws-1', 'unrelated-queue-item', '{"task":"untouched"}');

      // Prepare + activate control root, commit attempt, record spawn-intent, then simulate provider disconnect AFTER external effect
      const ledgerRunId = `run-${randomUUID()}`;
      const connectedRunId = `conn-${randomUUID()}`;
      const fence1 = {
        primacyClaim: 'primacy-claim-1',
        queueClaim: 'queue-claim-1',
        rootGeneration: 1
      } as const;
      const preparedRoot = await composition.controlAdmission.prepareRootLink({
        ledgerRunId,
        connectedRunId,
        rootWorkflowId: 'wf-drill',
        queueId: 'default',
        fence: fence1
      });
      expect(preparedRoot.ok).toBe(true);

      const activated = await composition.controlAdmission.activateRootLink({
        ledgerRunId,
        connectedRunId,
        fence: fence1
      });
      expect(activated.ok).toBe(true);

      const attemptId = `att-${randomUUID()}`;
      const preparedAttempt = await composition.controlAdmission.prepareAttempt({
        ledgerRunId,
        connectedRunId,
        queueId: 'default',
        fence: fence1,
        attemptId,
        frameKey: 'root',
        workflowId: 'wf-drill',
        invocationId: `${connectedRunId}:root`,
        nodeId: 'step-1',
        backend: 'claude'
      });
      expect(preparedAttempt.ok).toBe(true);
      if (!preparedAttempt.ok) return;

      const committed = await composition.controlAdmission.commitAttempt(preparedAttempt.token);
      expect(committed.ok).toBe(true);

      const spawnIntent = await composition.controlAdmission.recordSpawnIntent({
        ledgerRunId,
        attemptId,
        fence: fence1
      });
      expect(spawnIntent.ok).toBe(true);

      // External effect occurs before host/provider disconnect (no terminal ack recorded)
      fs.writeFileSync(receiptPath, `effect-written:${attemptId}\n`, 'utf8');

      // Reconcile after disconnect on next epoch: must pause as recovery-uncertain-effect without replaying
      const fence2 = {
        primacyClaim: 'primacy-claim-2',
        queueClaim: 'queue-claim-2',
        rootGeneration: 2
      } as const;
      const reconciled = await composition.controlAdmission.reconcileControlRoot({
        ledgerRunId,
        connectedRun: null,
        newFence: fence2,
        processEvidencePort: {
          inspectAttempt: () => ({ processState: 'not-found' })
        }
      });
      expect(reconciled.ok).toBe(true);
      if (reconciled.ok) {
        expect(reconciled.disposition).toBe('paused-uncertain-effect');
        expect(reconciled.pauseCause).toBe('recovery-uncertain-effect');
        expect(reconciled.affectedAttemptIds).toContain(attemptId);
      }

      // External effect receipt was NEVER replayed (single write intact)
      expect(fs.readFileSync(receiptPath, 'utf8')).toBe(`effect-written:${attemptId}\n`);

      // Operator executes reachable safe next step (explicit cancel/terminal transition)
      const canceled = await composition.controlAdmission.markRootTerminal({
        ledgerRunId,
        connectedRunId,
        status: 'canceled',
        completedAt: Date.now(),
        fence: fence2
      });
      expect(canceled).toBe(true);
    } finally {
      composition.dispose();
      store.close();
    }

    const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const unrelated = reopened.writerConnection.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = 'ws-1' AND doc_key = 'unrelated-queue-item'`
      );
      expect(unrelated?.payload_json).toBe('{"task":"untouched"}');
    } finally {
      reopened.close();
    }
  });

  it('3. Stale ownership refuses both restore and workflow mutation before disk writes while preserving live data', async () => {
    const dir = makeTempDir('schegent-stale-owner-0304-');
    const workspaceRoot = path.join(dir, 'workspace');
    const storageRoot = path.join(dir, 'storage');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(storageRoot, { recursive: true });

    const scopeId = 'ws-stale';
    const baseTime = 1_763_985_600_000;
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

    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dbDir, 'schegent-state.db');
    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => baseTime });

    try {
      expect((await lockA.tryAcquire()).acquired).toBe(true);
      expect(await lockA.hasPrimacy()).toBe(true);

      insertKvDoc(store, scopeId, 'live-key', '{"v":"backup-value"}', 1, baseTime);

      const apiA = createStoreBackupRestoreApi({
        getSqliteStore: () => store,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: () => lockA.hasPrimacy(),
        hasInFlightRun: () => false,
        reloadAfterRestore: () => undefined,
        nowMs: () => baseTime
      });

      const created = await apiA.createBackup({ backupId: 'bkp-stale-0304' });
      expect(created.status).toBe('created');

      // Live store advances after backup
      store.writerConnection.run(
        `UPDATE operational_kv_documents SET payload_json = '{"v":"newer-live-value"}', revision = 2 WHERE doc_namespace = ? AND doc_key = 'live-key'`,
        scopeId
      );

      // Lease goes stale and Window B takes over ownership
      clockB.advance(STALENESS_THRESHOLD_MS + 1_000);
      expect((await lockB.tryAcquire()).acquired).toBe(true);
      expect(await lockB.hasPrimacy()).toBe(true);
      expect(await lockA.hasPrimacy()).toBe(false);

      // Stale Window A restore attempt refuses pre-commit without modifying disk
      const restored = await apiA.restoreBackup('bkp-stale-0304');
      expect(restored).toMatchObject({
        status: 'refused',
        outcome: 'refused_pre_commit',
        reasonCode: 'NOT_WORKSPACE_OWNER'
      });

      // Stale Window A workflow admission fence also refuses cleanly
      const composition = createProductionWorkflowComposition({
        workspaceRoot,
        isWorkspaceTrusted: () => true
      });
      try {
        const verdict = composition.verifyPreAdmission({
          entryPointId: 'ui.launchWorkflow',
          rootExecutionId: 'root-stale',
          invocationId: 'inv-1',
          isFenceValid: await lockA.hasPrimacy()
        });
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) {
          expect(verdict.refusal.category).toBe('stale-fence');
        }
      } finally {
        composition.dispose();
      }
    } finally {
      await lockB.release();
      store.close();
    }

    // Reopen confirms live store remained untouched
    const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const row = reopened.writerConnection.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = 'live-key'`,
        scopeId
      );
      expect(row?.payload_json).toBe('{"v":"newer-live-value"}');
    } finally {
      reopened.close();
    }
  });

  it('4. Newer-reader schema version (min_reader_version > 9) refuses open without modifying database bytes', () => {
    const dir = makeTempDir('schegent-newer-schema-0304-');
    const dbPath = path.join(dir, 'schegent-state.db');
    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    store.close();

    // Stamp a future min_reader_version directly on the disposable DB and checkpoint WAL cleanly
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(
      `UPDATE schema_meta SET meta_value = '${String(SQLITE_SCHEMA_CURRENT_VERSION + 1)}' WHERE meta_key IN ('schema_version', 'min_reader_version')`
    );
    rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    rawDb.close();

    const digestBefore = sha256File(dbPath);
    expect(() => new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' })).toThrow(/min_reader_version|incompatible|newer/i);
    const digestAfter = sha256File(dbPath);
    expect(digestAfter).toBe(digestBefore);
  });

  it('5. Dirty Git state blocks landing onto dirty checked-out target (target-worktree-dirty) while preserving lane candidate and uncommitted work', async () => {
    const dir = fs.realpathSync(makeTempDir('schegent-dirty-git-0304-'));
    const repoDir = path.join(dir, 'repo');
    const storageDir = path.join(dir, 'lane-storage');
    const isolatedHome = path.join(dir, 'home');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(isolatedHome, { recursive: true });
    initDisposableGitRepo(repoDir);

    const dbPath = path.join(dir, 'schegent-state.db');
    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const laneStore = new LaneStore(store.writerConnection);
    let randSeq = 1;
    const git = createExecFileGitRunner({
      baseEnv: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        GIT_CEILING_DIRECTORIES: dir,
        GIT_CONFIG_NOSYSTEM: '1'
      }
    });
    const laneService = LaneService.open({
      connection: store.writerConnection,
      git,
      workspaceRoot: repoDir,
      workspaceId: 'ws-dirty',
      storageDir,
      clock: () => 1_763_985_600_000,
      random: (size) => Buffer.alloc(size, (randSeq += 1) & 0xff),
      authorizeApproval: () => true
    });

    try {
      // Provision a real isolated lane, commit a lane change, freeze a candidate, request + verify + approve integration onto main
      const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const provisioned = await laneService.provisionLane({
        rootExecutionId: 'root-dirty-0304',
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;

      const laneRecord = laneStore.getLane('ws-dirty', provisioned.value.laneId);
      expect(laneRecord).not.toBeNull();
      if (laneRecord === null) return;
      const laneRoot = await laneService.resolveLaneRoot(laneRecord.rootRef);
      expect(laneRoot).not.toBeNull();
      if (laneRoot === null) return;
      fs.writeFileSync(path.join(laneRoot, 'lane-change.txt'), 'candidate output\n', 'utf8');

      const frozen = await laneService.freezeCandidate({ laneId: provisioned.value.laneId });
      expect(frozen.ok).toBe(true);
      if (!frozen.ok) return;

      const req = await laneService.requestIntegration({
        laneId: provisioned.value.laneId,
        targetBranch: 'main',
        profile: {
          profileId: 'dirty-drill',
          revision: 1,
          checks: [{ name: 'pass', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
        }
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      const verified = await laneService.verifyRequest({ requestId: req.value.requestId });
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.state).toBe('awaiting-review');

      const approved = laneService.approveRequest({
        requestId: req.value.requestId,
        candidateCommit: frozen.value.commit,
        targetCommit: verified.value.expectedTargetCommit,
        profileRevision: verified.value.profile.revision,
        profileDigest: verified.value.profile.digest
      });
      expect(approved.ok).toBe(true);

      // Dirty the checked-out main worktree with both a tracked edit and an untracked operator file
      const trackedPath = path.join(repoDir, 'tracked.txt');
      const untrackedPath = path.join(repoDir, 'operator-notes.txt');
      fs.writeFileSync(trackedPath, 'operator uncommitted work\n', 'utf8');
      fs.writeFileSync(untrackedPath, 'do not delete\n', 'utf8');

      // Landing must refuse with `target-worktree-dirty`, keeping main at baseHead and preserving all operator edits
      const landed = await laneService.landRequest({ requestId: req.value.requestId });
      expect(landed.ok).toBe(false);
      if (!landed.ok) {
        expect(landed.refusal.reason).toBe('target-worktree-dirty');
        expect(landed.refusal.commits?.candidate).toBe(frozen.value.commit);
        expect(landed.refusal.commits?.expected).toBe(baseHead);
      }

      // Main branch was not moved and unrelated operator work remains byte-identical
      const headAfterRefusal = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      expect(headAfterRefusal).toBe(baseHead);
      expect(fs.readFileSync(trackedPath, 'utf8')).toBe('operator uncommitted work\n');
      expect(fs.readFileSync(untrackedPath, 'utf8')).toBe('do not delete\n');

      // Reopen-visible request state stays inspectable (`blocked`) with safe next step (`cancelRequest` or clean-then-reland)
      const afterReq = laneService.getRequest({ requestId: req.value.requestId });
      expect(afterReq.ok).toBe(true);
      if (afterReq.ok) {
        expect(afterReq.value.state).toBe('blocked');
        expect(afterReq.value.candidateCommit).toBe(frozen.value.commit);
      }
      const canceled = laneService.cancelRequest({ requestId: req.value.requestId });
      expect(canceled.ok).toBe(true);
      if (canceled.ok) expect(canceled.value.state).toBe('canceled');
    } finally {
      store.close();
    }
  });

  it('6. Restore commit followed by failed refresh reports committed_refresh_failed truthfully and reopened store holds restored state', async () => {
    const dir = makeTempDir('schegent-refresh-fail-0304-');
    const storageRoot = path.join(dir, 'storage');
    const scopeId = 'ws-refresh-fail';
    const baseTime = 1_763_985_600_000;
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dbDir, 'schegent-state.db');
    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => baseTime });

    try {
      insertKvDoc(store, scopeId, 'state-marker', '{"epoch":"restored-from-backup"}', 1, baseTime);

      const api = createStoreBackupRestoreApi({
        getSqliteStore: () => store,
        trustedRootDir: storageRoot,
        scopeId,
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        reloadAfterRestore: async () => {
          throw new Error('simulated host projection refresh failure');
        },
        nowMs: () => baseTime
      });

      const created = await api.createBackup({ backupId: 'bkp-refresh-0304' });
      expect(created.status).toBe('created');

      store.writerConnection.run(
        `UPDATE operational_kv_documents SET payload_json = '{"epoch":"pre-restore-live"}', revision = 2 WHERE doc_namespace = ? AND doc_key = 'state-marker'`,
        scopeId
      );

      const outcome = await api.restoreBackup('bkp-refresh-0304');
      expect(outcome).toMatchObject({
        status: 'committed_refresh_failed',
        outcome: 'committed_refresh_failed',
        errorCode: 'POST_COMMIT_REFRESH_FAILED'
      });
    } finally {
      store.close();
    }

    // Reopen confirms the restore DID commit on disk (so instructing window reload is truthful)
    const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const row = reopened.writerConnection.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = 'state-marker'`,
        scopeId
      );
      expect(row?.payload_json).toBe('{"epoch":"restored-from-backup"}');
      expect(reopened.writerConnection.runQuickCheck()).toEqual(['ok']);
    } finally {
      reopened.close();
    }
  });
});
