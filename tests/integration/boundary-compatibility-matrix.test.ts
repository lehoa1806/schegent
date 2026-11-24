/**
 * FR-R8-04 (`04-04`) — Boundary compatibility verification across IPC,
 * revisioned snapshots, legacy frozen `Pipeline` persisted records, and
 * mixed-version SQLite reopen (`min_reader_version`).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { CMD_START, SIDEBAR_IPC_SCHEMA_VERSION } from '../../src/contracts/sidebar-ipc';
import { SNAPSHOT_RESYNC_REQUEST } from '../../src/contracts/snapshot-bounds';
import {
  SQLITE_MIN_READER_VERSION,
  SQLITE_SCHEMA_CURRENT_VERSION
} from '../../src/contracts/sqlite-store/schema-types';
import { SCHEMA_VERSION, type WorkflowSnapshot } from '../../src/contracts/generated/snapshot-types';
import {
  SqliteApplicationStore,
  SqliteUnsupportedSchemaError
} from '../../src/services/sqlite-store';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager, type Scheduler } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { SnapshotTransport } from '../../src/ui/sidebar/snapshot-transport';
import { removeTempRoot } from '../temp-root-cleanup';

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

function makeSnapshot(overrides?: Partial<WorkflowSnapshot>): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    isPrimary: true,
    queues: Object.freeze([]),
    queue: Object.freeze({
      orderedItems: Object.freeze([]),
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([
      { id: 'a1', event: 'run-started', at: '2026-11-25T00:00:00.000Z' }
    ] as unknown as WorkflowSnapshot['auditTail']),
    monitor: null,
    history: Object.freeze([
      {
        runId: 'hist-legacy-1',
        featureId: 'feat-legacy-1',
        featureLabel: 'Legacy Pipeline Run',
        pipelineId: 'legacy-default-pipeline',
        status: 'completed',
        startedAt: 1_000,
        completedAt: 2_000,
        durationMs: 1_000,
        phaseCount: 2,
        completedPhases: 2,
        queueId: 'default'
      }
    ] as unknown as WorkflowSnapshot['history']),
    producedAt: '2026-11-25T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze([]),
    generalSettings: {} as WorkflowSnapshot['generalSettings'],
    ...overrides
  }) as WorkflowSnapshot;
}

describe('FR-R8-04 (04-04) — API, snapshot, legacy Pipeline, and SQLite boundary compatibility matrix', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root !== undefined) await removeTempRoot(root);
    }
  });

  it('accepts an old supported IPC request omitting schemaVersion and refuses an incompatible schemaVersion', () => {
    const legacyRes = validateInboundMessage({
      type: CMD_START,
      correlationId: 'corr-legacy-01',
      payload: {
        description: 'Run legacy compatible command',
        queueId: 'default'
      }
    });
    expect(legacyRes.ok).toBe(true);

    const currentRes = validateInboundMessage({
      schemaVersion: SIDEBAR_IPC_SCHEMA_VERSION,
      type: CMD_START,
      correlationId: 'corr-current-02',
      payload: {
        description: 'Run versioned command',
        queueId: 'default'
      }
    });
    expect(currentRes.ok).toBe(true);

    const incompatibleRes = validateInboundMessage({
      schemaVersion: SIDEBAR_IPC_SCHEMA_VERSION + 1,
      type: CMD_START,
      correlationId: 'corr-future-03',
      payload: {
        description: 'Should be refused'
      }
    });
    expect(incompatibleRes.ok).toBe(false);
    if (!incompatibleRes.ok) {
      expect(incompatibleRes.reason).toBe('unsupported-ipc-schema-version');
      expect(incompatibleRes.code).toBe('unsupported-ipc-schema-version');
    }
  });

  it('reconciles full + routine delta snapshots, preserves unchanged slices, drops stale revisions, requests full resync on gap, and rejects unknown snapshot versions', async () => {
    const { reconcileSnapshotMessage } = await import('../../webview-ui/src/lib/snapshot-merge.js');
    const transport = new SnapshotTransport();

    const snap1 = makeSnapshot({ producedAt: '2026-11-25T00:00:01.000Z' });
    const post1 = transport.preparePost(snap1);
    expect(post1.sync.mode).toBe('full');
    expect(post1.sync.revision).toBe(1);

    const rec1 = reconcileSnapshotMessage(null, null, post1.message.payload as never, post1.sync);
    expect(rec1.outcome).toBe('applied');
    if (rec1.outcome !== 'applied') return;
    expect(rec1.revision).toBe(1);
    const applied1 = rec1.snapshot;

    const snap2 = makeSnapshot({ producedAt: '2026-11-25T00:00:02.000Z' });
    const post2 = transport.preparePost(snap2);
    expect(post2.sync.mode).toBe('routine');
    expect(post2.sync.revision).toBe(2);
    expect(post2.sync.baseRevision).toBe(1);
    expect(post2.sync.omittedSlices).toContain('history');
    expect('history' in (post2.message.payload as unknown as Record<string, unknown>)).toBe(false);

    const rec2 = reconcileSnapshotMessage(applied1, rec1.revision, post2.message.payload as never, post2.sync);
    expect(rec2.outcome).toBe('applied');
    if (rec2.outcome !== 'applied') return;
    expect(rec2.revision).toBe(2);
    expect(rec2.snapshot.history).toBe(applied1.history);

    const stale = reconcileSnapshotMessage(rec2.snapshot, rec2.revision, post1.message.payload as never, post1.sync);
    expect(stale).toEqual({ outcome: 'ignore-stale', receivedRevision: 1 });

    const snap3 = makeSnapshot({ producedAt: '2026-11-25T00:00:03.000Z' });
    transport.preparePost(snap3);
    const snap4 = makeSnapshot({ producedAt: '2026-11-25T00:00:04.000Z' });
    const post4 = transport.preparePost(snap4);
    expect(post4.sync.mode).toBe('routine');
    expect(post4.sync.revision).toBe(4);
    expect(post4.sync.baseRevision).toBe(3);

    const gap = reconcileSnapshotMessage(rec2.snapshot, rec2.revision, post4.message.payload as never, post4.sync);
    expect(gap).toEqual({
      outcome: 'resync-needed',
      request: { type: SNAPSHOT_RESYNC_REQUEST, lastRevision: 2 }
    });

    transport.forceFullResync();
    const post5 = transport.preparePost(snap4);
    expect(post5.sync.mode).toBe('full');
    expect(post5.sync.revision).toBe(5);
    const recovered = reconcileSnapshotMessage(rec2.snapshot, rec2.revision, post5.message.payload as never, post5.sync);
    expect(recovered.outcome).toBe('applied');
    if (recovered.outcome === 'applied') {
      expect(recovered.revision).toBe(5);
      expect(recovered.snapshot.producedAt).toBe('2026-11-25T00:00:04.000Z');
    }

    const badSchema = reconcileSnapshotMessage(
      rec2.snapshot,
      5,
      { ...snap4, schemaVersion: SCHEMA_VERSION + 10 } as never,
      { mode: 'full', revision: 6 }
    );
    expect(badSchema).toEqual({ outcome: 'unknown-schema', schemaVersion: SCHEMA_VERSION + 10 });
  });

  it('preserves prior frozen Pipeline run and history data across ordinary sibling writes and SQLite reopen', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0404-legacy-'));
    tempRoots.push(tmpRoot);
    const workspaceRoot = path.join(tmpRoot, 'ws');
    const dbPath = path.join(tmpRoot, 'global', 'schegent-state.db');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
    const scopeId = 'scope-0404-legacy';

    const sqlite1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const memento1 = createSwitchableOperationalMemento(createMemoryMemento());
    memento1.attachSqlite(sqlite1, scopeId);
    const store1 = new WorkspaceStateStore(memento1);
    store1.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }), ownershipDir);
    await store1.initialize();
    const lock1 = new WorkspaceLockManager(store1, 'win-primary', { now: () => Date.now() }, noopScheduler);
    const acquired1 = await lock1.tryAcquire();
    expect(acquired1.acquired).toBe(true);
    store1.bindPrimacyClaimSource(lock1);
    const siblingQueueId = '11111111-1111-4111-8111-111111111111';
    await store1.updateQueueRegistry((reg) => ({
      registry: {
        entries: [
          ...reg.entries,
          {
            id: siblingQueueId,
            name: 'Sibling Queue',
            position: reg.entries.length,
            schedule: null,
            createdAt: 1_000,
            updatedAt: 1_000
          }
        ],
        updatedAt: 1_000
      },
      result: undefined
    }));
    const lease1 = new ExecutionLeaseManager(store1, 'win-primary', { now: () => Date.now() }, noopScheduler);
    store1.bindRunClaimSource(lease1);
    expect((await lease1.tryAcquire('default')).acquired).toBe(true);
    expect((await lease1.tryAcquire(siblingQueueId)).acquired).toBe(true);
    const defaultClaim = store1.runClaimFor('default')!;
    const queue2Claim = store1.runClaimFor(siblingQueueId)!;

    const legacyPipelineRun: WorkflowRun = {
      id: 'run-legacy-pipeline-1',
      featureId: 'feat-legacy-1',
      featureDir: 'specs/feat-legacy-1',
      status: 'completed',
      currentPhase: 'implement',
      currentIteration: 1,
      startedAt: 1_000,
      lastTransitionAt: 2_000,
      phasesCompleted: [
        {
          phase: 'specify',
          iteration: 1,
          startedAt: 1_000,
          endedAt: 1_400,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        },
        {
          phase: 'implement',
          iteration: 1,
          startedAt: 1_400,
          endedAt: 2_000,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        }
      ],
      lastError: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      creditPause: null,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseOverrides: [],
      phaseBreakpoints: [],
      resumeTargetPhaseId: null,
      pipeline: {
        id: 'legacy-sdd-pipeline',
        name: 'Legacy SDD Pipeline',
        version: 1,
        runner: 'claude',
        phases: [
          { id: 'specify', name: 'Specify', instruction: 'Write spec', maxIterations: 1, runner: 'claude' },
          { id: 'implement', name: 'Implement', instruction: 'Write code', maxIterations: 1, runner: 'claude' }
        ]
      } as unknown as NonNullable<WorkflowRun['pipeline']>
    };

    await store1.setRun('default', legacyPipelineRun, defaultClaim);
    await store1.appendHistory('default', {
      runId: legacyPipelineRun.id,
      featureId: legacyPipelineRun.featureId,
      featureDescription: 'Legacy pipeline feature',
      pipelineId: 'legacy-sdd-pipeline',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 1_000,
      phasesCompleted: ['specify', 'implement'],
      queueId: 'default'
    });

    const siblingRun: WorkflowRun = {
      ...legacyPipelineRun,
      id: 'run-sibling-new-2',
      featureId: 'feat-sibling-2',
      featureDir: 'specs/feat-sibling-2',
      startedAt: 3_000,
      lastTransitionAt: 3_500
    };
    await store1.setRun(siblingQueueId, siblingRun, queue2Claim);

    await lease1.releaseAll();
    await lock1.release();
    memento1.detachSqlite();
    sqlite1.close();

    const sqlite2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const memento2 = createSwitchableOperationalMemento(createMemoryMemento());
    memento2.attachSqlite(sqlite2, scopeId);
    const store2 = new WorkspaceStateStore(memento2);
    store2.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }), ownershipDir);
    await store2.initialize();

    const reloadedLegacy = store2.getRun('default');
    expect(reloadedLegacy?.id).toBe('run-legacy-pipeline-1');
    expect(reloadedLegacy?.pipeline?.id).toBe('legacy-sdd-pipeline');
    expect(reloadedLegacy?.pipeline?.phases).toHaveLength(2);
    expect(store2.getRun(siblingQueueId)?.id).toBe('run-sibling-new-2');
    const history = store2.getHistory() as readonly { readonly runId?: string; readonly pipelineId?: string }[];
    expect(history.some((h) => h.runId === 'run-legacy-pipeline-1' && h.pipelineId === 'legacy-sdd-pipeline')).toBe(true);

    memento2.detachSqlite();
    sqlite2.close();
  });

  it('reopens supported SQLite schema v9 cleanly and refuses future min_reader_version > 9 with zero database byte mutations', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0404-sqlite-'));
    tempRoots.push(tmpRoot);
    const dbPath = path.join(tmpRoot, 'schegent-state.db');

    const store1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'delete' });
    expect(store1.schemaVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION);
    const metaRow = store1.writerConnection.get<{ meta_value: string }>(
      "SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'"
    );
    expect(Number(metaRow?.meta_value)).toBe(SQLITE_MIN_READER_VERSION);
    store1.close();

    const store2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'delete' });
    expect(store2.schemaVersion).toBe(9);
    store2.close();

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec("UPDATE schema_meta SET meta_value = '10' WHERE meta_key = 'min_reader_version'");
    rawDb.close();

    const digestBefore = createHash('sha256').update(await fs.readFile(dbPath)).digest('hex');

    let caught: unknown = null;
    try {
      new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'delete' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SqliteUnsupportedSchemaError);
    expect((caught as SqliteUnsupportedSchemaError).code).toBe('UNSUPPORTED_MIN_READER_VERSION');

    const digestAfter = createHash('sha256').update(await fs.readFile(dbPath)).digest('hex');
    expect(digestAfter).toBe(digestBefore);
  });
});
