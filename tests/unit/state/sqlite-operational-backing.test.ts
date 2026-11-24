import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApplicationStore, createSwitchableCatalogFsAdapter } from '../../../src/services/sqlite-store';
import {
  CONNECTED_RUNS_CACHE_MAX,
  CONNECTED_RUNS_REFUSED_MAX_BYTES,
  CONNECTED_RUNS_REFUSED_MAX_COUNT,
  CONNECTED_RUNS_TERMINAL_RETENTION_MS,
  PostCutoverMementoWriteForbiddenError,
  SqliteCutoverMigrationIncompleteError,
  createSwitchableOperationalMemento,
  pruneConnectedRunsMap
} from '../../../src/state/sqlite-operational-backing';
import { buildOwnerResolver } from '../../../src/activation/sqlite-cutover-helpers';
import {
  KEYS,
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import {
  appendAttempt,
  createConnectedRun,
  createInvocationFrame,
  resolveBoundQueueId,
  setPendingHandoff,
  upsertInvocationFrame,
  type ConnectedWorkflowRun
} from '../../../src/state/connected-workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { CatalogFsPort } from '../../../src/catalog/ports';

const TEST_WORKFLOW_GRAPH: WorkflowDefinition = {
  workflowId: 'wf-main',
  name: 'Main Workflow',
  version: 1,
  nodes: [
    { nodeId: 'n1', pipelineId: 'p-main' },
    { nodeId: 'n2', pipelineId: 'p-main' }
  ],
  connections: [
    {
      from: { nodeId: 'n1', portId: 'out' },
      to: { nodeId: 'n2', portId: 'in' },
      isDefault: true
    }
  ],
  startNodeIds: ['n1']
};

const TEST_PIPELINES = {
  'p-main': { id: 'p-main', name: 'Main Pipeline', phases: [{ id: 'done', name: 'Done' }] }
};

function makeValidActiveConnectedRun(id: string, startedAt: number, pausedAt: number): ConnectedWorkflowRun {
  const base = createConnectedRun({
    connectedRunId: id,
    workflowId: 'wf-main',
    graph: TEST_WORKFLOW_GRAPH,
    pipelines: TEST_PIPELINES,
    startedAt
  });
  return setPendingHandoff(base, {
    invocationId: `${id}:root`,
    fromNodeId: 'n1',
    fromAttemptId: `${id}:att-1`,
    connectionIndex: 0,
    target: { kind: 'node', nodeId: 'n2' },
    prefilledInputsByPort: {},
    pausedAt
  });
}

function makeValidTerminalConnectedRun(
  id: string,
  startedAt: number,
  completedAt: number
): ConnectedWorkflowRun {
  const rootFrame = {
    ...createInvocationFrame({
      invocationId: 'root',
      rootRunId: id,
      parentInvocationId: null,
      parentCallNodeId: null,
      parentAttemptId: null,
      workflowId: 'wf-main',
      depth: 0,
      nodePath: '/n1',
      entryNodeId: 'n1',
      boundInputs: {},
      startedAt
    }),
    activeNodeId: null,
    status: 'completed' as const,
    completedAt
  };
  return createConnectedRun({
    connectedRunId: id,
    workflowId: 'wf-main',
    graph: TEST_WORKFLOW_GRAPH,
    pipelines: TEST_PIPELINES,
    startedAt,
    invocations: { root: rootFrame }
  });
}

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento & { writes: number } {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    writes: 0,
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      this.writes += 1;
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function createMemoryCatalogFs(files: Record<string, string>): CatalogFsPort & { writes: number } {
  const map = new Map<string, string>(Object.entries(files));
  return {
    writes: 0,
    async readFile(at) {
      const k = at.join('/');
      const v = map.get(k);
      return v === undefined ? { outcome: 'absent' } : { outcome: 'read', contents: v };
    },
    async writeFileAtomic(at, contents) {
      this.writes += 1;
      map.set(at.join('/'), contents);
      return { outcome: 'written' };
    },
    async writeFileIfAbsent(at, contents) {
      const k = at.join('/');
      if (map.has(k)) return { outcome: 'exists' };
      this.writes += 1;
      map.set(k, contents);
      return { outcome: 'written' };
    },
    async listDirectory(at) {
      const prefix = at.length === 0 ? '' : `${at.join('/')}/`;
      const out = new Set<string>();
      for (const k of map.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rem = k.slice(prefix.length);
        if (!rem) continue;
        const slash = rem.indexOf('/');
        out.add(slash === -1 ? rem : rem.slice(0, slash));
      }
      return [...out].sort();
    },
    async removeFile(at) {
      const existed = map.delete(at.join('/'));
      return { outcome: existed ? 'removed' : 'absent' };
    },
    async checkWritability() {
      return 'writable';
    }
  };
}

describe('SQLite operational & catalog cutover backing (FR-R6-F04 & FR-R6-F03)', () => {
  it('migrates legacy Memento once through retain-source, commits atomically to SQLite, and fences post-cutover Memento writes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-sqlite-backing-'));
    try {
      const dbPath = join(tempDir, 'schegent-state.db');
      const legacy = createMemoryMemento({
        [KEYS.schemaVersion]: 14,
        [KEYS.run]: {
          default: {
            id: 'run-legacy-1',
            featureId: 'feat-1',
            featureDir: 'specs/001-feat',
            status: 'paused',
            currentPhase: 'implement',
            currentIteration: 2,
            startedAt: 1_700_000_000_000,
            lastTransitionAt: 1_700_000_050_000,
            phasesCompleted: [],
            lastError: null
          }
        }
      });

      const switchable = createSwitchableOperationalMemento(legacy);
      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

      const backing = switchable.attachSqlite(sqliteStore, 'scope-alpha', () => 1_700_000_100_000);
      expect(backing.migrationOutcome?.completed).toBe(true);
      expect(sqliteStore.cutoverGuard.getSentinel('scope-alpha')?.authority).toBe('sqlite');
      expect(legacy.writes).toBe(0);

      // Imported state is readable from SQLite
      const importedRuns = switchable.get<Record<string, { id: string } | undefined>>(KEYS.run);
      expect(importedRuns?.default?.id).toBe('run-legacy-1');

      // Relational projection in `runs` table exists
      const sqlRun = sqliteStore.writerConnection.get<{ run_id: string; status: string }>(
        `SELECT run_id, status FROM runs WHERE run_id = ?`,
        'run-legacy-1'
      );
      expect(sqlRun).toEqual({ run_id: 'run-legacy-1', status: 'paused' });

      // Post-cutover write commits to SQLite without touching legacy Memento
      await switchable.update(KEYS.queueDefaultId, 'alpha');
      expect(legacy.writes).toBe(0);

      // If detached after cutover (e.g., lost primacy), legacy Memento writes are strictly refused
      switchable.detachSqlite();
      await expect(switchable.update(KEYS.queueDefaultId, 'beta')).rejects.toBeInstanceOf(
        PostCutoverMementoWriteForbiddenError
      );

      // Read-only snapshot inspection in an untrusted / non-primary window succeeds without mutating
      const follower = createSwitchableOperationalMemento(createMemoryMemento());
      expect(follower.attachReadOnlySnapshotIfPresent(dbPath, 'scope-alpha')).toBe(true);
      expect(follower.get<string>(KEYS.queueDefaultId)).toBe('alpha');
      await expect(follower.update(KEYS.queueDefaultId, 'beta')).rejects.toBeInstanceOf(
        PostCutoverMementoWriteForbiddenError
      );

      sqliteStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps legacy authority when the non-run copy fails, and a later attach imports every key (F04-FR-13/14/15)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-sqlite-backing-'));
    try {
      const dbPath = join(tempDir, 'schegent-state.db');
      const base = createMemoryMemento({
        [KEYS.run]: {
          default: {
            id: 'run-legacy-2',
            featureId: 'feat-2',
            featureDir: 'specs/002-feat',
            status: 'paused',
            currentPhase: 'plan',
            currentIteration: 1,
            startedAt: 1_700_000_000_000,
            lastTransitionAt: 1_700_000_050_000,
            phasesCompleted: [],
            lastError: null
          }
        },
        [KEYS.queueDefaultId]: 'alpha',
        [KEYS.history]: [{ id: 'h-1' }]
      });
      let failHistoryRead = true;
      const legacy: Memento & { writes: number } = {
        get writes() {
          return base.writes;
        },
        get<T>(key: string): T | undefined {
          if (failHistoryRead && key === KEYS.history) throw new Error('simulated host crash mid-copy');
          return base.get<T>(key);
        },
        update: (key, value) => base.update(key, value)
      };
      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

      const first = createSwitchableOperationalMemento(legacy);
      expect(() => first.attachSqlite(sqliteStore, 'scope-gamma', () => 1_700_000_100_000)).toThrow(
        SqliteCutoverMigrationIncompleteError
      );
      expect(sqliteStore.cutoverGuard.getSentinel('scope-gamma')?.authority).not.toBe('sqlite');
      expect(first.isSqliteAttached()).toBe(false);
      expect(first.get<string>(KEYS.queueDefaultId)).toBe('alpha');
      await first.update(KEYS.queueDefaultId, 'beta');
      expect(base.get<string>(KEYS.queueDefaultId)).toBe('beta');

      failHistoryRead = false;
      const second = createSwitchableOperationalMemento(legacy);
      const backing = second.attachSqlite(sqliteStore, 'scope-gamma', () => 1_700_000_200_000);
      expect(backing.migrationOutcome?.completed).toBe(true);
      expect(sqliteStore.cutoverGuard.getSentinel('scope-gamma')?.authority).toBe('sqlite');
      expect(second.get<string>(KEYS.queueDefaultId)).toBe('beta');
      expect(second.get<readonly { id: string }[]>(KEYS.history)).toEqual([{ id: 'h-1' }]);
      expect(second.get<Record<string, { id: string } | undefined>>(KEYS.run)?.default?.id).toBe('run-legacy-2');

      sqliteStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prunes terminal connectedRuns at CONNECTED_RUNS_CACHE_MAX (512) while preserving every non-terminal run (F03)', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const now = 1_800_000_000_000;
      switchable.attachSqlite(sqliteStore, 'scope-bounds', () => now);

      const connectedMap: Record<string, ConnectedWorkflowRun> = {};
      // 3 non-terminal valid runs (pendingHandoff set)
      for (let i = 0; i < 3; i += 1) {
        const id = `active-wf-${i}`;
        connectedMap[id] = makeValidActiveConnectedRun(id, now - 10_000, now - 5_000);
      }
      // 600 terminal valid runs
      for (let i = 0; i < 600; i += 1) {
        const id = `term-wf-${String(i).padStart(4, '0')}`;
        connectedMap[id] = makeValidTerminalConnectedRun(
          id,
          now - (600 - i) * 1_000,
          now - (600 - i) * 500
        );
      }

      await switchable.update(KEYS.connectedRuns, connectedMap);
      const stored = switchable.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns)!;
      const keys = Object.keys(stored);
      expect(keys.length).toBe(CONNECTED_RUNS_CACHE_MAX);
      expect(stored['active-wf-0']).toBeDefined();
      expect(stored['active-wf-1']).toBeDefined();
      expect(stored['active-wf-2']).toBeDefined();
      // Newest terminal run kept, oldest evicted
      expect(stored['term-wf-0599']).toBeDefined();
      expect(stored['term-wf-0000']).toBeUndefined();
    } finally {
      sqliteStore.close();
    }
  });

  it('imports legacy .schegent/catalog into SQLite once and syncs relational definitions/versions/heads', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const v1Json = JSON.stringify({
        schemaVersion: 1,
        kind: 'phase',
        id: 'specify',
        version: 'v1',
        createdAt: 1_700_000_000_000,
        digest: 'sha256:' + 'a'.repeat(64),
        body: { id: 'specify', name: 'Specify Phase' }
      });
      const manifestJson = JSON.stringify({
        schemaVersion: 1,
        entries: [{ kind: 'phase', id: 'specify', activeVersion: 'v1', draftVersion: null }]
      });
      const legacyCatalog = createMemoryCatalogFs({
        'phases/specify/v1.json': v1Json,
        'manifest.json': manifestJson
      });

      const switchableCatalog = createSwitchableCatalogFsAdapter(legacyCatalog);
      await switchableCatalog.attachSqlite(sqliteStore, 'scope-cat');

      expect(legacyCatalog.writes).toBe(0);
      const readBack = await switchableCatalog.readFile(['phases', 'specify', 'v1.json']);
      expect(readBack).toEqual({ outcome: 'read', contents: v1Json });

      const defRow = sqliteStore.writerConnection.get<{ slug: string; display_name: string }>(
        `SELECT slug, display_name FROM definitions WHERE layer = 'phase' AND slug = 'specify'`
      );
      expect(defRow).toEqual({ slug: 'specify', display_name: 'Specify Phase' });

      const headRow = sqliteStore.writerConnection.get<{ revision: number }>(
        `SELECT ch.revision FROM catalog_heads ch JOIN definitions d ON d.definition_id = ch.definition_id WHERE d.slug = 'specify'`
      );
      expect(headRow?.revision).toBe(1);
    } finally {
      sqliteStore.close();
    }
  });

  it('commits multiple keys atomically via updateBatch in one SQLite transaction and rolls back all keys on error (FR-R7-01)', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const now = 1_800_000_000_000;
      const backing = switchable.attachSqlite(sqliteStore, 'scope-batch', () => now);

      const runPayload = {
        default: {
          id: 'run-batch-1',
          featureId: 'feat-1',
          status: 'running',
          currentPhase: 'speckit-plan',
          startedAt: now,
          lastTransitionAt: now,
          pipeline: { id: 'default-pipeline', name: 'Default', phases: [] }
        }
      };
      const queuePayload = { default: { requests: [{ id: 'feat-1', status: 'in-flight' }], inFlightId: 'feat-1' } };

      await switchable.updateBatch([
        { key: KEYS.run, value: runPayload },
        { key: KEYS.queue, value: queuePayload }
      ]);

      expect(switchable.get<typeof runPayload>(KEYS.run)?.default.id).toBe('run-batch-1');
      expect(switchable.get<typeof queuePayload>(KEYS.queue)?.default.inFlightId).toBe('feat-1');
      const runRow = sqliteStore.writerConnection.get<{ run_id: string; status: string }>(
        `SELECT run_id, status FROM runs WHERE run_id = 'run-batch-1'`
      );
      expect(runRow).toEqual({ run_id: 'run-batch-1', status: 'running' });

      // Fault injection: throw on the queue-entity write after KEYS.run has already written
      // inside updateBatch; the whole transaction MUST roll back so neither key nor cache advances.
      const conn = sqliteStore.writerConnection;
      const originalRun = conn.run.bind(conn);
      conn.run = ((...args: Parameters<typeof conn.run>) => {
        const [sql] = args;
        if (sql.includes('INSERT INTO operational_queue_meta')) {
          throw new Error('injected-mid-batch-failure');
        }
        return originalRun(...args);
      }) as typeof conn.run;

      try {
        expect(() =>
          backing.updateBatch([
            {
              key: KEYS.run,
              value: {
                default: { ...runPayload.default, id: 'run-batch-2' }
              }
            },
            {
              key: KEYS.queue,
              value: { default: { requests: [{ id: 'feat-2', status: 'in-flight' }], inFlightId: 'feat-2' } }
            }
          ])
        ).toThrow('injected-mid-batch-failure');
      } finally {
        conn.run = originalRun;
      }

      // Both cache and SQLite must still reflect run-batch-1 / feat-1.
      expect(switchable.get<typeof runPayload>(KEYS.run)?.default.id).toBe('run-batch-1');
      expect(switchable.get<typeof queuePayload>(KEYS.queue)?.default.inFlightId).toBe('feat-1');
      const rolledBackRow = sqliteStore.writerConnection.get<{ run_id: string }>(
        `SELECT run_id FROM runs WHERE run_id = 'run-batch-2'`
      );
      expect(rolledBackRow).toBeUndefined();

      // Post-cutover detached updateBatch must still throw PostCutoverMementoWriteForbiddenError.
      switchable.detachSqlite();
      await expect(
        switchable.updateBatch([
          { key: KEYS.run, value: { default: { ...runPayload.default, id: 'run-batch-3' } } },
          { key: KEYS.queue, value: { default: { requests: [], inFlightId: null } } }
        ])
      ).rejects.toBeInstanceOf(PostCutoverMementoWriteForbiddenError);
    } finally {
      sqliteStore.close();
    }
  });

  it('rolls back already-written legacy Memento entries when pre-cutover SwitchableOperationalMemento.updateBatch fails mid-batch (FR-009)', async () => {
    const legacy = createMemoryMemento();
    const origUpdate = legacy.update.bind(legacy);
    legacy.update = (key: string, value: unknown): Thenable<void> => {
      if (key === KEYS.queue) {
        return Promise.reject(new Error('legacy-queue-write-failed'));
      }
      return origUpdate(key, value);
    };
    const switchable = createSwitchableOperationalMemento(legacy);

    await expect(
      switchable.updateBatch([
        { key: KEYS.run, value: { default: { id: 'run-pre-cutover', status: 'running' } } },
        { key: KEYS.queue, value: { default: { requests: [], inFlightId: 'feat-1' } } }
      ])
    ).rejects.toThrow('legacy-queue-write-failed');

    // Compensating rollback restored KEYS.run back to undefined.
    expect(legacy.get(KEYS.run)).toBeUndefined();
    expect(switchable.get(KEYS.run)).toBeUndefined();
  });

  it('refuses updateBatch with QueueMutationRejected(durable-store-unavailable) and 0 legacy writes when requireDurableBatch is active without SQLite (FR-R7-11)', async () => {
    const legacy = createMemoryMemento();
    const switchable = createSwitchableOperationalMemento(legacy, undefined, {
      requireDurableBatch: true
    });
    switchable.setDurableBatchUnavailableReason('sqlite-init-failed');

    let caught: unknown;
    try {
      await switchable.updateBatch([
        { key: KEYS.run, value: { default: { id: 'run-refused', status: 'running' } } },
        { key: KEYS.queue, value: { default: { requests: [], inFlightId: 'feat-1' } } }
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(QueueMutationRejected);
    expect((caught as QueueMutationRejected).reason).toBe('durable-store-unavailable');
    expect((caught as QueueMutationRejected).message).toContain('sqlite-init-failed');
    expect(legacy.writes).toBe(0);
    expect(legacy.get(KEYS.run)).toBeUndefined();
    expect(legacy.get(KEYS.queue)).toBeUndefined();

    // Switching on requireDurableBatch dynamically after construction also fails closed.
    const legacy2 = createMemoryMemento();
    const dynamicSwitchable = createSwitchableOperationalMemento(legacy2);
    dynamicSwitchable.requireDurableBatch('storage-relocation-failed');
    await expect(
      dynamicSwitchable.updateBatch([
        { key: KEYS.run, value: { default: { id: 'run-refused-2', status: 'running' } } },
        { key: KEYS.queue, value: { default: { requests: [], inFlightId: 'feat-2' } } }
      ])
    ).rejects.toMatchObject({ reason: 'durable-store-unavailable' });
    expect(legacy2.writes).toBe(0);

    // Attaching SQLite restores durable atomic updateBatch without touching legacy Memento.
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      switchable.attachSqlite(sqliteStore, 'scope-durable-ready', () => 1_800_000_000_000);
      await switchable.updateBatch([
        {
          key: KEYS.run,
          value: {
            default: {
              id: 'run-ready-1',
              featureId: 'feat-1',
              status: 'running',
              currentPhase: 'speckit-plan',
              startedAt: 1_800_000_000_000,
              lastTransitionAt: 1_800_000_000_000,
              pipeline: { id: 'default-pipeline', name: 'Default', phases: [] }
            }
          }
        },
        { key: KEYS.queue, value: { default: { requests: [{ id: 'feat-1', status: 'in-flight' }], inFlightId: 'feat-1' } } }
      ]);
      expect(legacy.writes).toBe(0);
      expect(switchable.get<Record<string, { id: string } | undefined>>(KEYS.run)?.default?.id).toBe('run-ready-1');
    } finally {
      sqliteStore.close();
    }
  });

  it('keeps default pre-cutover SwitchableOperationalMemento in-memory fallback functional when requireDurableBatch is false (FR-R7-11)', async () => {
    const legacy = createMemoryMemento();
    const switchable = createSwitchableOperationalMemento(legacy);
    await switchable.updateBatch([
      { key: KEYS.run, value: { default: { id: 'run-fallback', status: 'running' } } },
      { key: KEYS.queue, value: { default: { requests: [], inFlightId: 'feat-fallback' } } }
    ]);
    expect(legacy.writes).toBe(2);
    expect(switchable.get<Record<string, { id: string } | undefined>>(KEYS.run)?.default?.id).toBe('run-fallback');
  });

  it('isolates malformed, primitive/null, and future-version connected runs across cutover, healthy sibling writes, retention pruning, relational projection, and two real-SQLite reopens (FR-R8-01 / 01-08)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-sqlite-r8-0108-'));
    try {
      const dbPath = join(tempDir, 'schegent-state.db');
      const scopeId = 'scope-r8-isolation';
      const now = 1_850_000_000_000;

      // 1. Healthy active composable sibling with controlState v1
      const healthyActive = createConnectedRun({
        connectedRunId: 'cr-healthy-active',
        workflowId: 'wf-main',
        graph: TEST_WORKFLOW_GRAPH,
        pipelines: TEST_PIPELINES,
        startedAt: now - 20_000,
        queueId: DEFAULT_QUEUE_ID,
        controlState: { version: 1, ledgerRunId: 'ledger-healthy-1' },
        invocations: {
          root: createInvocationFrame({
            invocationId: 'root',
            rootRunId: 'cr-healthy-active',
            parentInvocationId: null,
            parentCallNodeId: null,
            parentAttemptId: null,
            workflowId: 'wf-main',
            depth: 0,
            nodePath: '/n1',
            entryNodeId: 'n1',
            boundInputs: {},
            startedAt: now - 20_000
          })
        }
      });

      // 2. Older-supported Feature 088 (v9) record: absent queueId, invocations, and controlState
      const olderV9 = appendAttempt(
        createConnectedRun({
          connectedRunId: 'cr-older-v9',
          workflowId: 'wf-main',
          graph: TEST_WORKFLOW_GRAPH,
          pipelines: TEST_PIPELINES,
          startedAt: now - 30_000
        }),
        'n1',
        { queueItemId: 'legacy-q-item-1', startedAt: now - 29_000 }
      );

      // 3. Recent terminal valid run (kept) and expired > 90-day terminal valid run (evicted by retention)
      const recentTerm = makeValidTerminalConnectedRun('cr-recent-term', now - 10_000, now - 5_000);
      const expiredTerm = makeValidTerminalConnectedRun(
        'cr-expired-term',
        now - CONNECTED_RUNS_TERMINAL_RETENTION_MS - 100_000,
        now - CONNECTED_RUNS_TERMINAL_RETENTION_MS - 50_000
      );

      // 4. Malformed nested, primitive/null/array, and future-version entries (must survive byte-for-byte!)
      const refusedEntries: Record<string, unknown> = {
        'cr-bad-graph': { ...JSON.parse(JSON.stringify(healthyActive)), connectedRunId: 'cr-bad-graph', graph: null },
        'cr-bad-invocations': {
          ...JSON.parse(JSON.stringify(healthyActive)),
          connectedRunId: 'cr-bad-invocations',
          invocations: null
        },
        'cr-bad-nodes': { ...JSON.parse(JSON.stringify(healthyActive)), connectedRunId: 'cr-bad-nodes', nodes: null },
        'cr-bad-decisions': {
          ...JSON.parse(JSON.stringify(healthyActive)),
          connectedRunId: 'cr-bad-decisions',
          decisions: null
        },
        'cr-bad-closure': {
          ...JSON.parse(JSON.stringify(healthyActive)),
          connectedRunId: 'cr-bad-closure',
          frozenClosure: null
        },
        'cr-bad-control': {
          ...JSON.parse(JSON.stringify(healthyActive)),
          connectedRunId: 'cr-bad-control',
          controlState: null
        },
        'cr-bad-operand': {
          ...JSON.parse(JSON.stringify(olderV9)),
          connectedRunId: 'cr-bad-operand',
          decisions: [
            {
              nodeId: 'n1',
              attemptIndex: 0,
              decidedAt: now - 28_000,
              operands: [{ source: 'node-output', nodeId: 'n1', resolved: true, compared: 12345 }],
              connections: [{ index: 0, matched: true, isDefault: true }],
              defaultApplied: true,
              eligible: [0]
            }
          ],
          secretMarker: 'SECRET_MALFORMED_OPERAND_PAYLOAD'
        },
        'cr-raw-null': null,
        'cr-raw-number': 12345,
        'cr-raw-string': 'SECRET_PRIMITIVE_STRING_PAYLOAD',
        'cr-raw-boolean': false,
        'cr-raw-array': ['SECRET_ARRAY_PAYLOAD', 1, null],
        'cr-future-control-v2': {
          ...JSON.parse(JSON.stringify(healthyActive)),
          connectedRunId: 'cr-future-control-v2',
          controlState: { version: 2, ledgerRunId: 'SECRET_FUTURE_LEDGER_V2' }
        },
        'cr-future-schema-v99': {
          schemaVersion: 99,
          connectedRunId: 'cr-future-schema-v99',
          opaqueFutureField: { nested: 'SECRET_FUTURE_SCHEMA_99' }
        }
      };

      const expectedRefusedBytes = new Map<string, string>(
        Object.entries(refusedEntries).map(([id, val]) => [id, JSON.stringify(val)])
      );

      // Seed legacy Memento before SQLite cutover (simulating real pre-cutover state)
      const legacy = createMemoryMemento({
        [KEYS.schemaVersion]: 15,
        [KEYS.connectedRuns]: {
          'cr-healthy-active': JSON.parse(JSON.stringify(healthyActive)),
          'cr-older-v9': JSON.parse(JSON.stringify(olderV9)),
          'cr-recent-term': JSON.parse(JSON.stringify(recentTerm)),
          'cr-expired-term': JSON.parse(JSON.stringify(expiredTerm)),
          ...JSON.parse(JSON.stringify(refusedEntries))
        }
      });

      const readRawConnectedRunsFromSqlite = (sqlite: SqliteApplicationStore): Record<string, unknown> => {
        const row = sqlite.writerConnection.get<{ payload_json: string }>(
          `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
          scopeId,
          KEYS.connectedRuns
        );
        expect(row).toBeDefined();
        return JSON.parse(row!.payload_json) as Record<string, unknown>;
      };

      const assertRefusedPreservedAndUnprojected = (sqlite: SqliteApplicationStore): void => {
        const rawDoc = readRawConnectedRunsFromSqlite(sqlite);
        for (const [id, expectedJson] of expectedRefusedBytes) {
          expect(Object.hasOwn(rawDoc, id), `refused entry ${id} must survive`).toBe(true);
          expect(JSON.stringify(rawDoc[id]), `refused entry ${id} bytes must match verbatim`).toBe(expectedJson);
        }
        const projectedRunIds = sqlite.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs`)
          .map((r) => r.run_id);
        for (const refusedId of expectedRefusedBytes.keys()) {
          expect(projectedRunIds, `refused entry ${refusedId} must never project into runs table`).not.toContain(
            refusedId
          );
        }
      };

      // --- Session 1: Cutover + healthy sibling writes ---
      const warn1 = vi.fn();
      const logger1 = {
        warn: warn1,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      } as unknown as ConstructorParameters<typeof WorkspaceStateStore>[1];

      const sqlite1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        const switchable1 = createSwitchableOperationalMemento(legacy);
        const backing1 = switchable1.attachSqlite(sqlite1, scopeId, () => now);
        expect(backing1.migrationOutcome?.completed).toBe(true);

        const store1 = new WorkspaceStateStore(switchable1, logger1);
        const loaded1 = store1.getConnectedRuns();
        // Valid runs loaded; expired >90d valid run evicted; refused entries isolated
        expect(Object.keys(loaded1).sort()).toEqual([
          'cr-healthy-active',
          'cr-older-v9',
          'cr-recent-term'
        ]);
        expect(resolveBoundQueueId(loaded1['cr-older-v9']!)).toBe(DEFAULT_QUEUE_ID);

        // Exactly 1 bounded warning per unchanged refused set, zero leaked payload bytes
        expect(warn1).toHaveBeenCalledTimes(1);
        const warnLine = String(warn1.mock.calls[0]?.[0]);
        expect(warnLine).toContain('cr-bad-graph (invariant-violation)');
        expect(warnLine).toContain('cr-raw-null (invariant-violation)');
        expect(warnLine).toContain('cr-future-control-v2 (unsupported-run-schema-version)');
        expect(warnLine).toContain('cr-future-schema-v99 (unsupported-run-schema-version)');
        for (const secret of [
          'SECRET_MALFORMED_OPERAND_PAYLOAD',
          'SECRET_PRIMITIVE_STRING_PAYLOAD',
          'SECRET_ARRAY_PAYLOAD',
          'SECRET_FUTURE_LEDGER_V2',
          'SECRET_FUTURE_SCHEMA_99'
        ]) {
          expect(warnLine).not.toContain(secret);
        }

        // Advance healthy active sibling via compareAndSetConnectedRun
        const advanced1 = upsertInvocationFrame(loaded1['cr-healthy-active']!, {
          ...loaded1['cr-healthy-active']!.invocations!.root!,
          activeNodeId: 'n2'
        });
        const cas1 = await store1.compareAndSetConnectedRun(advanced1, loaded1['cr-healthy-active']!.revision);
        expect(cas1.outcome).toBe('written');

        // Advance supported older v9 sibling too
        const advancedOlder = appendAttempt(loaded1['cr-older-v9']!, 'n2', {
          queueItemId: 'legacy-q-item-2',
          startedAt: now - 1_000
        });
        const casOlder = await store1.compareAndSetConnectedRun(advancedOlder, loaded1['cr-older-v9']!.revision);
        expect(casOlder.outcome).toBe('written');

        assertRefusedPreservedAndUnprojected(sqlite1);
        const projected1 = sqlite1.writerConnection
          .all<{ run_id: string }>(`SELECT run_id FROM runs`)
          .map((r) => r.run_id);
        expect(projected1).toContain('cr-healthy-active');
        expect(projected1).toContain('cr-older-v9');
      } finally {
        sqlite1.close();
      }

      // --- Session 2: First reopen + second healthy sibling advance ---
      const sqlite2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        const switchable2 = createSwitchableOperationalMemento(createMemoryMemento());
        switchable2.attachSqlite(sqlite2, scopeId, () => now + 10_000);
        const store2 = new WorkspaceStateStore(switchable2);

        const loaded2 = store2.getConnectedRuns();
        expect(Object.keys(loaded2).sort()).toEqual([
          'cr-healthy-active',
          'cr-older-v9',
          'cr-recent-term'
        ]);
        expect(loaded2['cr-healthy-active']!.revision).toBe(2);
        expect(loaded2['cr-healthy-active']!.invocations!.root!.activeNodeId).toBe('n2');
        expect(loaded2['cr-older-v9']!.nodes.n2!.attempts).toHaveLength(1);

        // Complete the healthy sibling on reopen #1
        const completed = upsertInvocationFrame(loaded2['cr-healthy-active']!, {
          ...loaded2['cr-healthy-active']!.invocations!.root!,
          activeNodeId: null,
          status: 'completed',
          completedAt: now + 9_000
        });
        expect((await store2.compareAndSetConnectedRun(completed, 2)).outcome).toBe('written');
        assertRefusedPreservedAndUnprojected(sqlite2);
      } finally {
        sqlite2.close();
      }

      // --- Session 3: Second reopen verification ---
      const sqlite3 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        const warn3 = vi.fn();
        const logger3 = {
          warn: warn3,
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          sanitize: (s: string) => s
        } as unknown as ConstructorParameters<typeof WorkspaceStateStore>[1];
        const switchable3 = createSwitchableOperationalMemento(createMemoryMemento());
        switchable3.attachSqlite(sqlite3, scopeId, () => now + 20_000);
        const store3 = new WorkspaceStateStore(switchable3, logger3);

        const loaded3 = store3.getConnectedRuns();
        expect(Object.keys(loaded3).sort()).toEqual([
          'cr-healthy-active',
          'cr-older-v9',
          'cr-recent-term'
        ]);
        expect(loaded3['cr-healthy-active']!.revision).toBe(3);
        expect(loaded3['cr-healthy-active']!.invocations!.root!.status).toBe('completed');
        expect(warn3).toHaveBeenCalledTimes(1);
        assertRefusedPreservedAndUnprojected(sqlite3);
      } finally {
        sqlite3.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces the 512-entry cap exclusively on valid runs while preserving refused, primitive, future, and __proto__ entries outside eviction (FR-R8-01 / 01-08)', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const now = 1_850_000_000_000;
      switchable.attachSqlite(sqliteStore, 'scope-cap-opaque', () => now);

      // Build map with prototype-safe __proto__ + refused entries + 3 active + 550 terminal valid runs
      const rawMap = JSON.parse(
        '{"__proto__":{"connectedRunId":"__proto__","schemaVersion":7}}'
      ) as Record<string, unknown>;
      rawMap['refused-null'] = null;
      rawMap['refused-str'] = 'opaque-string';
      rawMap['refused-bad-graph'] = { connectedRunId: 'refused-bad-graph', graph: null };
      rawMap['refused-future-v2'] = {
        ...JSON.parse(JSON.stringify(makeValidTerminalConnectedRun('refused-future-v2', now - 1_000, now - 500))),
        controlState: { version: 2, ledgerRunId: 'future-ledger' }
      };

      for (let i = 0; i < 3; i += 1) {
        const id = `active-${i}`;
        rawMap[id] = makeValidActiveConnectedRun(id, now - 10_000, now - 5_000);
      }
      for (let i = 0; i < 550; i += 1) {
        const id = `term-${String(i).padStart(4, '0')}`;
        rawMap[id] = makeValidTerminalConnectedRun(
          id,
          now - (550 - i) * 1_000,
          now - (550 - i) * 500
        );
      }

      // Direct pruneConnectedRunsMap check
      const prunedDirect = pruneConnectedRunsMap(rawMap, {}, now) as Record<string, unknown>;
      expect(Object.hasOwn(prunedDirect, '__proto__')).toBe(true);
      expect(prunedDirect['refused-null']).toBeNull();
      expect(prunedDirect['refused-str']).toBe('opaque-string');
      expect(prunedDirect['refused-bad-graph']).toEqual({ connectedRunId: 'refused-bad-graph', graph: null });
      expect(prunedDirect['refused-future-v2']).toEqual(rawMap['refused-future-v2']);
      // 512 valid runs + 5 refused entries = 517 total entries
      expect(Object.keys(prunedDirect)).toHaveLength(CONNECTED_RUNS_CACHE_MAX + 5);
      expect(prunedDirect['active-0']).toBeDefined();
      expect(prunedDirect['term-0549']).toBeDefined();
      expect(prunedDirect['term-0000']).toBeUndefined();

      // End-to-end through SQLite update + relational projection
      await switchable.update(KEYS.connectedRuns, rawMap);
      const stored = switchable.get<Record<string, unknown>>(KEYS.connectedRuns)!;
      expect(Object.keys(stored)).toHaveLength(CONNECTED_RUNS_CACHE_MAX + 5);
      expect(Object.hasOwn(stored, '__proto__')).toBe(true);
      expect(stored['refused-null']).toBeNull();
      expect(stored['refused-str']).toBe('opaque-string');
      expect(stored['refused-future-v2']).toEqual(rawMap['refused-future-v2']);

      const projectedIds = new Set(
        sqliteStore.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`).map((r) => r.run_id)
      );
      expect(projectedIds.has('__proto__')).toBe(false);
      expect(projectedIds.has('refused-null')).toBe(false);
      expect(projectedIds.has('refused-str')).toBe(false);
      expect(projectedIds.has('refused-bad-graph')).toBe(false);
      expect(projectedIds.has('refused-future-v2')).toBe(false);
      expect(projectedIds.has('active-0')).toBe(true);
      expect(projectedIds.has('term-0549')).toBe(true);
    } finally {
      sqliteStore.close();
    }
  });

  it('isolates an over-depth (>128) corrupted connectedRuns entry on SQLite reload and read-only reopen without wiping healthy siblings (FR-R8-01)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-sqlite-over-depth-'));
    try {
      const dbPath = join(tempDir, 'schegent-state.db');
      const scopeId = 'scope-over-depth';
      const now = 1_860_000_000_000;
      const healthy = makeValidActiveConnectedRun('cr-healthy-sibling', now - 5_000, now - 1_000);

      // Build a 140-level nested JSON payload exceeding MAX_OPERATIONAL_JSON_DEPTH (128).
      let deepPayload: Record<string, unknown> = { secret: 'SECRET_OVER_DEPTH_PAYLOAD' };
      for (let i = 0; i < 140; i += 1) {
        deepPayload = { nested: deepPayload };
      }
      const rawJson = JSON.stringify({
        'cr-healthy-sibling': healthy,
        'cr-over-depth': deepPayload
      });

      const sqlite1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        const warn = vi.fn();
        const logger = {
          warn,
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          sanitize: (s: string) => s
        } as unknown as Parameters<typeof createSwitchableOperationalMemento>[1];
        const switchable1 = createSwitchableOperationalMemento(createMemoryMemento(), logger);
        switchable1.attachSqlite(sqlite1, scopeId, () => now);

        // Inject corrupted raw JSON directly into SQLite operational_kv_documents
        sqlite1.writerConnection.run(
          `INSERT INTO operational_kv_documents (
            doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
          ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
          ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
            revision = operational_kv_documents.revision + 1,
            payload_json = excluded.payload_json,
            payload_bytes = excluded.payload_bytes,
            updated_at_ms = excluded.updated_at_ms`,
          scopeId,
          KEYS.connectedRuns,
          rawJson,
          Buffer.byteLength(rawJson, 'utf8'),
          now
        );

        switchable1.reloadSqliteCache();
        const reloaded = switchable1.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns);
        expect(reloaded).toBeDefined();
        expect(Object.keys(reloaded!)).toEqual(['cr-healthy-sibling']);
        expect(Object.isFrozen(reloaded!['cr-healthy-sibling'])).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          'quarantined unfreezable connectedRuns entries on reload',
          expect.objectContaining({ count: 1, keys: ['cr-over-depth'] })
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_OVER_DEPTH_PAYLOAD');

        // Read-only snapshot reopen also isolates the over-depth entry and keeps healthy sibling readable
        const follower = createSwitchableOperationalMemento(createMemoryMemento());
        expect(follower.attachReadOnlySnapshotIfPresent(dbPath, scopeId)).toBe(true);
        const followerRuns = follower.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns);
        expect(Object.keys(followerRuns ?? {})).toEqual(['cr-healthy-sibling']);

        // Subsequent writes to healthy siblings succeed cleanly
        const secondHealthy = makeValidActiveConnectedRun('cr-healthy-second', now, now);
        await switchable1.update(KEYS.connectedRuns, {
          ...reloaded!,
          'cr-healthy-second': secondHealthy
        });
        expect(Object.keys(switchable1.get<Record<string, unknown>>(KEYS.connectedRuns)!).sort()).toEqual([
          'cr-healthy-second',
          'cr-healthy-sibling'
        ]);
      } finally {
        sqlite1.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('quarantines cyclic, unserializable, over-depth, oversized, and excess-count refused entries without wedging healthy sibling writes (FR-R8-01)', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const warn = vi.fn();
      const logger = {
        warn,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      } as unknown as Parameters<typeof createSwitchableOperationalMemento>[1];
      const switchable = createSwitchableOperationalMemento(createMemoryMemento(), logger);
      const now = 1_860_000_000_000;
      switchable.attachSqlite(sqliteStore, 'scope-refused-bounds', () => now);

      const healthy = makeValidActiveConnectedRun('cr-healthy', now - 1_000, now - 500);
      const cyclic: Record<string, unknown> = { connectedRunId: 'cr-cyclic', secret: 'SECRET_CYCLIC' };
      cyclic.self = cyclic;

      let overDepth: Record<string, unknown> = { secret: 'SECRET_DEEP' };
      for (let i = 0; i < 140; i += 1) overDepth = { child: overDepth };

      const rawMap: Record<string, unknown> = {
        'cr-healthy': healthy,
        'cr-future-keep': { schemaVersion: 99, connectedRunId: 'cr-future-keep' },
        'cr-cyclic': cyclic,
        'cr-bigint': { connectedRunId: 'cr-bigint', amount: BigInt(42) },
        'cr-over-depth': overDepth,
        'cr-oversized': {
          schemaVersion: 99,
          blob: 'x'.repeat(CONNECTED_RUNS_REFUSED_MAX_BYTES + 1024)
        }
      };

      await switchable.update(KEYS.connectedRuns, rawMap);
      const stored = switchable.get<Record<string, unknown>>(KEYS.connectedRuns)!;
      expect(Object.keys(stored).sort()).toEqual(['cr-future-keep', 'cr-healthy']);
      expect(warn).toHaveBeenCalledWith(
        'quarantined refused connectedRuns entries during prune',
        expect.objectContaining({ unsafeCount: 3, budgetCount: 1 })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_CYCLIC');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_DEEP');

      // Refused count cap enforcement: > CONNECTED_RUNS_REFUSED_MAX_COUNT refused entries stay bounded
      const manyRefused: Record<string, unknown> = { 'cr-healthy': healthy };
      for (let i = 0; i < CONNECTED_RUNS_REFUSED_MAX_COUNT + 40; i += 1) {
        manyRefused[`refused-${i}`] = { schemaVersion: 99, index: i };
      }
      const prunedMany = pruneConnectedRunsMap(manyRefused, {}, now) as Record<string, unknown>;
      expect(Object.keys(prunedMany)).toHaveLength(CONNECTED_RUNS_REFUSED_MAX_COUNT + 1);
      expect(prunedMany['cr-healthy']).toBeDefined();

      // Prototype-safe owner resolver never treats Object.prototype keys as live connected runs
      const store = new WorkspaceStateStore(switchable);
      const resolveOwner = buildOwnerResolver(store);
      expect(resolveOwner('run', 'constructor')).toBe('settled');
      expect(resolveOwner('run', 'toString')).toBe('settled');
      expect(resolveOwner('run', 'cr-healthy')).toBe('live');
    } finally {
      sqliteStore.close();
    }
  });
});
