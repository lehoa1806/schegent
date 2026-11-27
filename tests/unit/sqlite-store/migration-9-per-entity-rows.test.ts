/**
 * FR-R7-02 (FR-004..FR-007, US2, SC-004, SC-005) — Migration 9 per-entity operational
 * tables (`operational_queue_meta`, `operational_tasks`, `operational_runs`), lossless
 * backfill + SHA-256 digest verification, older-reader `UNSUPPORTED_MIN_READER_VERSION`
 * refusal, incremental-only Task/Run SQL writes, frozen/CoW reads, and existing-fixture
 * lossless round-trip verification.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SQLITE_MIN_READER_VERSION,
  SQLITE_SCHEMA_CURRENT_VERSION
} from '../../../src/contracts/sqlite-store/schema-types';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  FR_R7_02_OPERATIONAL_ENTITY_MIGRATION_NAME,
  FR_R7_02_OPERATIONAL_ENTITY_MIGRATION_VERSION,
  FR_R7_02_OPERATIONAL_ENTITY_TABLE_NAMES,
  MAX_OPERATIONAL_JSON_DEPTH,
  NodeSqliteConnection,
  SchemaBootstrapService,
  SqliteApplicationStore,
  canonicalJsonStringify,
  computeCanonicalSha256,
  deepFreezeValue,
  freezeSnapshotWithStructuralSharing,
  isDeepEqualJsonValue,
  isOperationalQueueMap,
  isOperationalRunMap,
  readOperationalQueueMapFromDb,
  readOperationalRunMapFromDb
} from '../../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import { KEYS, SCHEMA_VERSION, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { FeatureRequest, QueueState } from '../../../src/queue/feature-request';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_763_600_000_000;
const MIGRATIONS_UP_TO_8 = BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8);

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function makeTask(queueId: string, idx: number, overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    id: `${queueId}-task-${String(idx).padStart(4, '0')}`,
    description: `Task #${idx} on ${queueId}`,
    enqueuedAt: NOW + idx * 10,
    createdAt: NOW + idx * 10,
    startedAt: null,
    updatedAt: NOW + idx * 10 + 5,
    completedAt: null,
    status: 'pending',
    queueId,
    position: idx,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: 'wf-sdd-0',
    ...overrides
  };
}

function makeQueue(tasks: FeatureRequest[], overrides: Partial<QueueState> = {}): QueueState {
  return {
    requests: tasks,
    inFlightId: tasks.find((t) => t.status === 'in-flight')?.id ?? null,
    updatedAt: NOW + 1_000,
    queueLifecycle: tasks.some((t) => t.status === 'in-flight') ? 'running' : 'idle-pending',
    pauseSource: null,
    pausedReason: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...overrides
  };
}

function makeRun(queueId: string, taskId: string, runId: string): WorkflowRun {
  return {
    id: runId,
    featureId: taskId,
    featureDir: `specs/316-${queueId}`,
    status: 'running',
    currentPhase: 'implement',
    currentIteration: 2,
    startedAt: NOW + 100,
    lastTransitionAt: NOW + 500,
    phasesCompleted: [
      {
        phase: 'specify',
        iteration: 1,
        startedAt: NOW + 100,
        endedAt: NOW + 200,
        result: 'clean',
        terminationReason: 'token',
        exitCode: 0,
        stdoutSummary: 'ok',
        stderrSummary: '',
        auditEntryId: `aud-${runId}-1`
      }
    ],
    lastError: null,
    pipeline: {
      id: 'wf-sdd-0',
      name: 'SDD',
      version: 3,
      phases: [
        { id: 'specify', name: 'Specify', instruction: '/speckit-specify', loopable: false },
        { id: 'implement', name: 'Implement', instruction: '/speckit-implement', loopable: true }
      ]
    },
    liveness: { lastActivityAt: NOW + 490, stdoutLines: 120, stderrLines: 1 },
    plannedTotal: { phaseCount: 2, iterationCap: 5, maxPhaseInvocations: 6 },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [{ phaseId: 'implement', action: 'skipped', setAt: NOW + 300, actor: 'operator' }],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [{ phaseId: 'implement', setAt: NOW + 310, actor: 'operator' }],
    resumeTargetPhaseId: null,
    writtenAtFence: 7
  };
}

function seedSchema8KvDoc(
  conn: NodeSqliteConnection,
  scopeId: string,
  docKey: string,
  payloadJson: string
): void {
  conn.run(
    `INSERT INTO operational_kv_documents (
      doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
    ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
    scopeId,
    docKey,
    payloadJson,
    Buffer.byteLength(payloadJson, 'utf8'),
    NOW
  );
}

describe('FR-R7-02 — Migration 9 per-entity operational rows, incremental writes & CoW reads', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates schema 8 operational documents atomically once with verified counts/digests, preserves every field, and is idempotent (FR-004, FR-005, SC-004)', () => {
    expect(SQLITE_SCHEMA_CURRENT_VERSION).toBe(9);
    expect(SQLITE_MIN_READER_VERSION).toBe(9);
    expect(FR_R7_02_OPERATIONAL_ENTITY_MIGRATION_VERSION).toBe(9);
    expect(FR_R7_02_OPERATIONAL_ENTITY_MIGRATION_NAME).toBe('009_fr_r7_02_operational_per_entity_rows');

    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const v8 = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, MIGRATIONS_UP_TO_8);
      expect(v8.schemaVersion).toBe(8);

      const scopeAQueues = {
        default: {
          ...makeQueue([
            makeTask('default', 0, { status: 'in-flight', runId: 'run-a-1', startedAt: NOW + 20 }),
            makeTask('default', 1, { status: 'completed', completedAt: NOW + 90, phaseProgress: { settled: 2, total: 2 } })
          ], { failurePolicy: 'continue', migrationNotice: 'pending' }),
          extraUnknownQueueField: { marker: 'preserved-in-remainder' }
        },
        'queue-02': makeQueue([makeTask('queue-02', 0)])
      };
      const scopeARuns = {
        default: {
          ...makeRun('default', 'default-task-0000', 'run-a-1'),
          futureAdditiveField: { retained: true }
        }
      };
      const scopeBQueues = {
        default: makeQueue([makeTask('default', 0)])
      };

      const expectedQueueDigestA = computeCanonicalSha256(scopeAQueues);
      const expectedRunDigestA = computeCanonicalSha256(scopeARuns);
      const expectedQueueDigestB = computeCanonicalSha256(scopeBQueues);

      seedSchema8KvDoc(conn, 'scope-a', KEYS.queue, JSON.stringify(scopeAQueues));
      seedSchema8KvDoc(conn, 'scope-a', KEYS.run, JSON.stringify(scopeARuns));
      seedSchema8KvDoc(conn, 'scope-a', KEYS.history, JSON.stringify({ default: [{ runId: 'hist-1' }] }));
      seedSchema8KvDoc(conn, 'scope-b', KEYS.queue, JSON.stringify(scopeBQueues));

      // Upgrade schema 8 -> schema 9
      const upgraded = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1_000);
      expect(upgraded.schemaVersion).toBe(9);
      expect(upgraded.appliedMigrations).toEqual([9]);

      // All three new tables are STRICT
      for (const tableName of FR_R7_02_OPERATIONAL_ENTITY_TABLE_NAMES) {
        const sqlRow = conn.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
          tableName
        );
        expect(sqlRow?.sql).toMatch(/\)\s*STRICT$/);
      }

      // min_reader_version raised to 9
      const minReader = conn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
      );
      expect(minReader?.meta_value).toBe('9');

      // Row counts & reconstructed digests match identically across both scopes
      const reconQueuesA = readOperationalQueueMapFromDb(conn, 'scope-a');
      expect(reconQueuesA.present).toBe(true);
      expect(computeCanonicalSha256(reconQueuesA.map)).toBe(expectedQueueDigestA);
      expect(reconQueuesA.map.default).toEqual(scopeAQueues.default);

      const reconRunsA = readOperationalRunMapFromDb(conn, 'scope-a');
      expect(reconRunsA.present).toBe(true);
      expect(computeCanonicalSha256(reconRunsA.map)).toBe(expectedRunDigestA);
      expect(reconRunsA.map.default).toEqual(scopeARuns.default);

      const reconQueuesB = readOperationalQueueMapFromDb(conn, 'scope-b');
      expect(reconQueuesB.present).toBe(true);
      expect(computeCanonicalSha256(reconQueuesB.map)).toBe(expectedQueueDigestB);

      // Migrated queue/run KV rows removed while non-entity KV keys remain untouched
      const remainingKv = conn.all<{ doc_namespace: string; doc_key: string }>(
        `SELECT doc_namespace, doc_key FROM operational_kv_documents ORDER BY doc_namespace, doc_key`
      );
      expect(remainingKv).toEqual([{ doc_namespace: 'scope-a', doc_key: KEYS.history }]);

      // Re-running bootstrapAndMigrate is strictly idempotent
      const second = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 2_000);
      expect(second.appliedMigrations).toEqual([]);
      expect(second.schemaVersion).toBe(9);
      expect(computeCanonicalSha256(readOperationalQueueMapFromDb(conn, 'scope-a').map)).toBe(
        expectedQueueDigestA
      );
    } finally {
      conn.close();
    }
  });

  it('rolls back Migration 9 cleanly and leaves schema 8 source untouched on digest mismatch or corrupt JSON (FR-005, SC-004)', () => {
    // 1. Corrupt source JSON fails closed
    const corruptConn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(corruptConn, () => NOW, MIGRATIONS_UP_TO_8);
      seedSchema8KvDoc(corruptConn, 'scope-corrupt', KEYS.queue, '{not-valid-json');

      expect(() => SchemaBootstrapService.bootstrapAndMigrate(corruptConn, () => NOW + 1)).toThrow(
        /MIGRATION_9_INVALID_SOURCE_JSON/
      );

      expect(
        corruptConn.get<{ meta_value: string }>(
          `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
        )?.meta_value
      ).toBe('8');
      expect(
        corruptConn.get<{ payload_json: string }>(
          `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = 'scope-corrupt' AND doc_key = ?`,
          KEYS.queue
        )?.payload_json
      ).toBe('{not-valid-json');
      expect(
        corruptConn.get<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_tasks'`
        )
      ).toBeUndefined();
    } finally {
      corruptConn.close();
    }

    // 2. Digest mismatch during backfill fails closed and rolls back completely
    const tamperConn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(tamperConn, () => NOW, MIGRATIONS_UP_TO_8);
      const originalQueueDoc = JSON.stringify({
        default: makeQueue([makeTask('default', 0)])
      });
      seedSchema8KvDoc(tamperConn, 'scope-tamper', KEYS.queue, originalQueueDoc);

      const originalRun = tamperConn.run.bind(tamperConn);
      tamperConn.run = ((...args: Parameters<typeof tamperConn.run>) => {
        const [sql, ...params] = args;
        if (sql.includes('INSERT INTO operational_tasks')) {
          // Corrupt the last parameter (`payload_json`) so read-back digest disagrees with source
          const tampered = [...params];
          const lastIdx = tampered.length - 1;
          tampered[lastIdx] = JSON.stringify({ ...makeTask('default', 0), description: 'TAMPERED' });
          return originalRun(sql, ...tampered);
        }
        return originalRun(...args);
      }) as typeof tamperConn.run;

      try {
        expect(() => SchemaBootstrapService.bootstrapAndMigrate(tamperConn, () => NOW + 1)).toThrow(
          /MIGRATION_9_DIGEST_MISMATCH/
        );
      } finally {
        tamperConn.run = originalRun;
      }

      // Database rolled back cleanly to schema 8 with source untouched
      expect(
        tamperConn.get<{ meta_value: string }>(
          `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
        )?.meta_value
      ).toBe('8');
      expect(
        tamperConn.get<{ meta_value: string }>(
          `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
        )?.meta_value
      ).toBe('1');
      expect(
        tamperConn.get<{ payload_json: string }>(
          `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = 'scope-tamper' AND doc_key = ?`,
          KEYS.queue
        )?.payload_json
      ).toBe(originalQueueDoc);
    } finally {
      tamperConn.close();
    }
  });

  it.each([
    { key: KEYS.queue, value: { default: { requests: [{ id: 'duplicate' }, { id: 'duplicate' }] } } },
    { key: KEYS.run, value: { default: { status: 'failed' } } }
  ])('rolls back the full Migration 9 backfill for a malformed $key map', ({ key, value }) => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, MIGRATIONS_UP_TO_8);
      const valid = JSON.stringify({ default: makeQueue([makeTask('default', 0)]) });
      const invalid = JSON.stringify(value);
      seedSchema8KvDoc(conn, 'a-valid', KEYS.queue, valid);
      seedSchema8KvDoc(conn, 'z-invalid', key, invalid);

      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1)).toThrow(
        /MIGRATION_9_INVALID_SOURCE_SHAPE/
      );
      expect(conn.scalar("SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'")).toBe('8');
      expect(conn.all('SELECT payload_json FROM operational_kv_documents ORDER BY doc_namespace')).toEqual([
        { payload_json: valid }, { payload_json: invalid }
      ]);
    } finally {
      conn.close();
    }
  });

  it('preserves recognized pre-map and absent state for the workspace-state migration', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, MIGRATIONS_UP_TO_8);
      const queue = JSON.stringify(makeQueue([makeTask('default', 0)]));
      const run = JSON.stringify(makeRun('default', 'default-task-0000', 'legacy-run'));
      seedSchema8KvDoc(conn, 'legacy', KEYS.queue, queue);
      seedSchema8KvDoc(conn, 'legacy', KEYS.run, run);
      seedSchema8KvDoc(conn, 'legacy-absent', KEYS.run, 'null');

      expect(SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1).schemaVersion).toBe(9);
      expect(conn.all('SELECT payload_json FROM operational_kv_documents ORDER BY doc_namespace, doc_key')).toEqual([
        { payload_json: queue }, { payload_json: run }, { payload_json: 'null' }
      ]);
    } finally {
      conn.close();
    }
  });

  it('refuses an older schema-8 reader on a schema-9 database without modifying the database file (US2 AC-2, SC-005)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-m9-oldreader-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');

    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'delete' });
    store.close();

    const bytesBefore = await fs.readFile(dbPath);
    const shaBefore = createHash('sha256').update(bytesBefore).digest('hex');

    const oldConn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'delete' });
    try {
      expect(() =>
        SchemaBootstrapService.bootstrapAndMigrate(oldConn, () => NOW, MIGRATIONS_UP_TO_8)
      ).toThrow(
        'UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema 9 or later; this build reads up to 8'
      );
    } finally {
      oldConn.close();
    }

    const bytesAfter = await fs.readFile(dbPath);
    const shaAfter = createHash('sha256').update(bytesAfter).digest('hex');
    expect(shaAfter).toBe(shaBefore);
  });

  it('writes only the changed Task and Run rows on steady-state mutations without rewriting 499 sibling Tasks (FR-006, US2 AC-3)', () => {
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => NOW });
    try {
      const tasks500 = Array.from({ length: 500 }, (_, i) =>
        makeTask('default', i, i === 400 ? { status: 'in-flight', runId: 'run-default-1' } : {})
      );
      const siblingTasks = Array.from({ length: 25 }, (_, i) => makeTask('queue-02', i));
      const initialQueues: Record<string, QueueState> = {
        default: makeQueue(tasks500),
        'queue-02': makeQueue(siblingTasks)
      };
      const initialRuns: Record<string, WorkflowRun> = {
        default: makeRun('default', 'default-task-0400', 'run-default-1'),
        'queue-02': makeRun('queue-02', 'queue-02-task-0000', 'run-q2-1')
      };

      const switchable = createSwitchableOperationalMemento(
        createMemoryMemento({
          [KEYS.schemaVersion]: 15,
          [KEYS.queue]: initialQueues,
          [KEYS.run]: initialRuns
        })
      );
      const backing = switchable.attachSqlite(store, 'scope-inc', () => NOW + 10);

      // Spy on SQL writes during a single-Task + single-Run updateBatch
      const sqlWrites: string[] = [];
      const conn = store.writerConnection;
      const origRun = conn.run.bind(conn);
      conn.run = ((...args: Parameters<typeof conn.run>) => {
        sqlWrites.push(args[0]);
        return origRun(...args);
      }) as typeof conn.run;

      try {
        const prevQueues = backing.get<Record<string, QueueState>>(KEYS.queue)!;
        const prevRuns = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;

        const nextRequests = prevQueues.default!.requests.slice();
        nextRequests[400] = {
          ...nextRequests[400]!,
          status: 'completed',
          completedAt: NOW + 999,
          updatedAt: NOW + 999
        };
        const nextQueues: Record<string, QueueState> = {
          ...prevQueues,
          default: {
            ...prevQueues.default!,
            inFlightId: null,
            queueLifecycle: 'idle-pending',
            updatedAt: NOW + 999,
            requests: nextRequests
          }
        };
        const nextRuns: Record<string, WorkflowRun> = {
          ...prevRuns,
          default: {
            ...prevRuns.default!,
            status: 'completed',
            lastTransitionAt: NOW + 999
          }
        };

        backing.updateBatch([
          { key: KEYS.run, value: nextRuns },
          { key: KEYS.queue, value: nextQueues }
        ]);
      } finally {
        conn.run = origRun;
      }

      const taskInserts = sqlWrites.filter((s) => s.includes('INSERT INTO operational_tasks'));
      const metaInserts = sqlWrites.filter((s) => s.includes('INSERT INTO operational_queue_meta'));
      const runInserts = sqlWrites.filter((s) => s.includes('INSERT INTO operational_runs'));
      const kvInserts = sqlWrites.filter((s) => s.includes('INSERT INTO operational_kv_documents'));
      const summaryRunInserts = sqlWrites.filter((s) => s.includes('INSERT INTO runs'));

      expect(taskInserts).toHaveLength(1);
      expect(metaInserts).toHaveLength(1);
      expect(runInserts).toHaveLength(1);
      expect(summaryRunInserts).toHaveLength(1);
      expect(kvInserts).toHaveLength(0);

      // Verify ONLY the changed task row advanced to revision 2; all 499 sibling tasks remain revision 1
      const rev2Tasks = conn.all<{ task_id: string; revision: number }>(
        `SELECT task_id, revision FROM operational_tasks WHERE scope_id = 'scope-inc' AND revision > 1`
      );
      expect(rev2Tasks).toEqual([{ task_id: 'default-task-0400', revision: 2 }]);

      const rev1Count = Number(
        conn.scalar(
          `SELECT COUNT(*) FROM operational_tasks WHERE scope_id = 'scope-inc' AND revision = 1`
        )
      );
      expect(rev1Count).toBe(524); // 499 default siblings + 25 queue-02 tasks

      // Sibling queue-02 Run stayed at revision 1 while default Run moved to revision 2
      const runRevs = conn.all<{ queue_id: string; revision: number }>(
        `SELECT queue_id, revision FROM operational_runs WHERE scope_id = 'scope-inc' ORDER BY queue_id`
      );
      expect(runRevs).toEqual([
        { queue_id: 'default', revision: 2 },
        { queue_id: 'queue-02', revision: 1 }
      ]);

      // Verify Task reorder, Task deletion, Queue deletion, and Run deletion persist across reload
      const afterFirst = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      const reordered = [
        afterFirst['queue-02']!.requests[1]!,
        afterFirst['queue-02']!.requests[0]!
      ];
      backing.update(KEYS.queue, {
        'queue-02': { ...afterFirst['queue-02']!, requests: reordered }
      });
      backing.update(KEYS.run, {});

      backing.reloadCacheFromSqlite();
      const reloadedQueues = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      expect(Object.keys(reloadedQueues)).toEqual(['queue-02']);
      expect(reloadedQueues['queue-02']!.requests.map((r) => r.id)).toEqual([
        'queue-02-task-0001',
        'queue-02-task-0000'
      ]);
      // Empty `{}` run map must stay `{}` across reload (distinct from `undefined`), while
      // explicit `undefined` clears both entity rows and KV marker.
      expect(backing.get(KEYS.run)).toEqual({});
      backing.update(KEYS.run, undefined);
      backing.reloadCacheFromSqlite();
      expect(backing.get(KEYS.run)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('serves deeply frozen views without per-read structuredClone while isolating caller objects and read-only followers (FR-007, US2 AC-4)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-m9-cow-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');

    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const backing = switchable.attachSqlite(store, 'scope-cow', () => NOW);

      const mutableTask = makeTask('default', 0);
      const mutableQueues: Record<string, QueueState> = {
        default: makeQueue([mutableTask])
      };
      backing.update(KEYS.queue, mutableQueues);

      // Mutating caller's local input object after update MUST NOT corrupt internal cache
      mutableTask.description = 'CALLER_LOCAL_MUTATION';

      const read1 = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      const read2 = backing.get<Record<string, QueueState>>(KEYS.queue)!;

      // Exact same deeply frozen reference returned without cloning per read
      expect(read1).toBe(read2);
      expect(Object.isFrozen(read1)).toBe(true);
      expect(Object.isFrozen(read1.default)).toBe(true);
      expect(Object.isFrozen(read1.default!.requests)).toBe(true);
      expect(Object.isFrozen(read1.default!.requests[0])).toBe(true);
      expect(read1.default!.requests[0]!.description).toBe('Task #0 on default');

      // Direct mutation of returned view throws in strict mode
      expect(() => {
        (read1.default!.requests[0] as { description: string }).description = 'ILLEGAL_WRITE';
      }).toThrow(TypeError);

      // Read-only snapshot follower reads schema-9 per-entity rows cleanly without modifying DB
      const follower = createSwitchableOperationalMemento(createMemoryMemento());
      expect(follower.attachReadOnlySnapshotIfPresent(dbPath, 'scope-cow')).toBe(true);
      const followerRead1 = follower.get<Record<string, QueueState>>(KEYS.queue)!;
      const followerRead2 = follower.get<Record<string, QueueState>>(KEYS.queue)!;
      expect(followerRead1).toBe(followerRead2);
      expect(Object.isFrozen(followerRead1.default!.requests[0])).toBe(true);
      expect(followerRead1.default!.requests[0]!.description).toBe('Task #0 on default');

      // Re-ordered object keys for an identical KEYS.queue value must still be treated as a no-op
      // on a post-cutover read-only follower (must NOT throw PostCutoverMementoWriteForbiddenError)
      const q = followerRead1.default!;
      await expect(
        follower.update(KEYS.queue, {
          default: {
            requests: q.requests,
            inFlightId: q.inFlightId,
            updatedAt: q.updatedAt,
            queueLifecycle: q.queueLifecycle,
            pauseSource: q.pauseSource,
            pausedReason: q.pausedReason,
            scheduledStartAt: q.scheduledStartAt,
            scheduledStartSource: q.scheduledStartSource
          }
        })
      ).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('loads existing pre-082 legacy fixture through schema 9 without losing any Run or Task field (SC-005)', async () => {
    const fixturePath = path.resolve(
      __dirname,
      '../../fixtures/state/pre-082-workspace-state.json'
    );
    const fixtureRaw = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as Record<string, unknown>;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-m9-fixture-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'fixture.db');

    const store1 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    let snapshotBeforeClose: {
      readonly queues: unknown;
      readonly runs: unknown;
    };
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento(fixtureRaw));
      switchable.attachSqlite(store1, 'scope-fixture', () => NOW);
      const ws = new WorkspaceStateStore(switchable);
      await ws.initialize();
      snapshotBeforeClose = {
        queues: ws.getQueueStates(),
        runs: ws.getRunMap()
      };
    } finally {
      store1.close();
    }

    // Reopen fresh from disk and assert every Queue, Task, and Run field survived identically
    const store2 = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const switchable2 = createSwitchableOperationalMemento(createMemoryMemento());
      switchable2.attachSqlite(store2, 'scope-fixture', () => NOW + 1_000);
      const ws2 = new WorkspaceStateStore(switchable2);
      await ws2.initialize();

      expect(ws2.getQueueStates()).toEqual(snapshotBeforeClose.queues);
      expect(ws2.getRunMap()).toEqual(snapshotBeforeClose.runs);
    } finally {
      store2.close();
    }
  });

  it('preserves empty `{}` maps across Migration 9, reload, and read-only snapshots without triggering spurious v11 migrations', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-m9-empty-map-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'empty.db');

    // Seed a schema-8 store with explicit `{}` for KEYS.run and KEYS.queue
    const conn8 = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(
        conn8,
        () => NOW,
        BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8)
      );
      conn8.run(
        `INSERT INTO cutover_sentinel (scope_id, authority, stage, cutover_epoch, legacy_digest_sha256, sqlite_digest_sha256, updated_at_ms)
         VALUES (?, 'sqlite', 'retain-source', 1, 'd', 'd', ?)`,
        'scope-empty',
        NOW
      );
      for (const [docKey, payload] of [
        [KEYS.schemaVersion, JSON.stringify(SCHEMA_VERSION)],
        [KEYS.queue, JSON.stringify({ default: makeQueue([]) })],
        [KEYS.run, '{}']
      ] as const) {
        conn8.run(
          `INSERT INTO operational_kv_documents (doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms)
           VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
          'scope-empty',
          docKey,
          payload,
          Buffer.byteLength(payload, 'utf8'),
          NOW
        );
      }
    } finally {
      conn8.close();
    }

    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const backing = switchable.attachSqlite(store, 'scope-empty', () => NOW + 100);
      expect(backing.get(KEYS.run)).toEqual({});

      // Idle workspace initialize must be idempotent (no spurious v11 migration write)
      const ws = new WorkspaceStateStore(switchable);
      const initResult = await ws.initialize();
      expect(initResult.v11MigrationEvents).toEqual([]);

      // Read-only follower must also see `{}` (not `undefined`) and initialize cleanly without PostCutoverMementoWriteForbiddenError
      const follower = createSwitchableOperationalMemento(createMemoryMemento());
      expect(follower.attachReadOnlySnapshotIfPresent(dbPath, 'scope-empty')).toBe(true);
      expect(follower.get(KEYS.run)).toEqual({});
      const followerWs = new WorkspaceStateStore(follower);
      await expect(followerWs.initialize()).resolves.toBeDefined();
    } finally {
      store.close();
    }
  });

  it('prevents shallow-frozen caller wrappers from bypassing deep-freeze isolation and diff persistence', () => {
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => NOW });
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const backing = switchable.attachSqlite(store, 'scope-shallow-freeze', () => NOW);

      const mutableTask = makeTask('default', 0);
      const mutableRequests = [mutableTask];
      const shallowQueue = Object.freeze({
        ...makeQueue(mutableRequests),
        requests: mutableRequests
      });
      const shallowMap = Object.freeze({ default: shallowQueue });

      backing.update(KEYS.queue, shallowMap);
      // Caller mutates nested mutable array/task AFTER passing shallow-frozen wrapper
      mutableTask.description = 'MUTATED_AFTER_SHALLOW_FREEZE';
      mutableRequests.push(makeTask('default', 1));

      // Internal cache must be deeply frozen and completely isolated from caller mutation
      const cached = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      expect(cached).not.toBe(shallowMap);
      expect(Object.isFrozen(cached.default!.requests)).toBe(true);
      expect(cached.default!.requests).toHaveLength(1);
      expect(cached.default!.requests[0]!.description).toBe('Task #0 on default');

      // Writing an updated snapshot with the mutated task must persist to SQLite (not skipped as equal)
      backing.update(KEYS.queue, {
        default: {
          ...cached.default!,
          requests: [{ ...cached.default!.requests[0]!, description: 'PERSISTED_UPDATE' }]
        }
      });
      backing.reloadCacheFromSqlite();
      const reloaded = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      expect(reloaded.default!.requests[0]!.description).toBe('PERSISTED_UPDATE');
    } finally {
      store.close();
    }
  });

  it('hardens against prototype keys, deep nesting/cycles, corrupt entity rows, unreadable schema versions, and error payload leakage', async () => {
    // 1. Prototype-chain lookup & hijacking guards
    const protoPayload = JSON.parse('{"__proto__":{}}') as Record<string, unknown>;
    expect(isDeepEqualJsonValue(protoPayload, { status: 'DIFFERENT' })).toBe(false);
    expect(isOperationalQueueMap(JSON.parse('{"__proto__":{"requests":[]}}'))).toBe(false);
    expect(isOperationalRunMap(JSON.parse('{"constructor":{"id":"r1"}}'))).toBe(false);

    const frozenWithProto = freezeSnapshotWithStructuralSharing(
      JSON.parse('{"__proto__":{"x":1},"ok":true}') as Record<string, unknown>
    );
    expect(Object.getPrototypeOf(frozenWithProto)).toBe(Object.prototype);
    expect(Object.hasOwn(frozenWithProto, '__proto__')).toBe(true);

    // Distinct non-plain objects (Date) must not compare equal
    expect(isDeepEqualJsonValue(new Date(1000), new Date(2000))).toBe(false);

    // 2. Depth bound & cycle guards
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i <= MAX_OPERATIONAL_JSON_DEPTH + 2; i += 1) {
      nested = { child: nested };
    }
    expect(() => canonicalJsonStringify(nested)).toThrow(RangeError);
    expect(() => deepFreezeValue(nested)).toThrow(RangeError);
    expect(() => freezeSnapshotWithStructuralSharing(nested)).toThrow(RangeError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);
    expect(() => deepFreezeValue(cyclic)).toThrow(TypeError);
    expect(() => freezeSnapshotWithStructuralSharing(cyclic)).toThrow(TypeError);

    // 3. Corrupt single entity row & unsafe key skipped gracefully on reload; out-of-range integer safe
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => NOW });
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const backing = switchable.attachSqlite(store, 'scope-hardening', () => NOW);
      const validTask = { ...makeTask('default', 0), updatedAt: 1e30 };
      backing.update(KEYS.queue, { default: makeQueue([validTask]) });

      // Inject a corrupt sibling row, a `__proto__` row, and an over-depth task row directly into SQLite
      let deepJson = '{"leaf":1}';
      for (let i = 0; i < MAX_OPERATIONAL_JSON_DEPTH; i += 1) deepJson = `{"n":${deepJson}}`;
      store.writerConnection.run(
        `INSERT INTO operational_tasks (scope_id, queue_id, task_id, revision, position, status, run_id, enqueued_at_ms, updated_at_ms, payload_json)
         VALUES (?, 'default', 'deep-task', 1, 99, 'pending', NULL, ?, ?, ?)`,
        'scope-hardening',
        NOW,
        NOW,
        `{"id":"deep-task","deep":${deepJson}}`
      );
      store.writerConnection.run(
        `INSERT INTO operational_queue_meta (scope_id, queue_id, revision, queue_lifecycle, updated_at_ms, remainder_json)
         VALUES (?, '__proto__', 1, 'running', ?, '{"evil":true}')`,
        'scope-hardening',
        NOW
      );
      store.writerConnection.run(
        `INSERT INTO operational_queue_meta (scope_id, queue_id, revision, queue_lifecycle, updated_at_ms, remainder_json)
         VALUES (?, 'corrupt-q', 1, 'running', ?, '{not-json')`,
        'scope-hardening',
        NOW
      );

      backing.reloadCacheFromSqlite();
      const loaded = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
      expect(Object.keys(loaded)).toEqual(['default']);
      expect(loaded.default!.requests).toHaveLength(1);

      // Float/out-of-range timestamps in KEYS.run must commit cleanly through projectRunEntriesInTx (STRICT INTEGER)
      backing.update(KEYS.run, {
        default: {
          ...makeRun('default', 'default-task-0000', 'run-float-ts'),
          startedAt: 1763600000.5,
          lastTransitionAt: 1e30
        }
      });
      expect(backing.get<Record<string, WorkflowRun>>(KEYS.run)?.['default']?.id).toBe('run-float-ts');

      // Bare pre-v11 WorkflowRun with null properties alongside KEYS.connectedRuns must not throw in collectActiveFeatureIds
      backing.updateBatch([
        {
          key: KEYS.run,
          value: {
            id: 'legacy-bare-run',
            featureId: 'feat-legacy',
            status: 'running',
            currentPhase: 'plan',
            lastError: null
          }
        },
        {
          key: KEYS.connectedRuns,
          value: {
            'cr-1': {
              connectedRunId: 'cr-1',
              workflowId: 'wf-1',
              revision: 1,
              startedAt: NOW,
              nodes: { n1: { attempts: [{ queueItemId: 'feat-legacy' }] } },
              decisions: []
            }
          }
        }
      ]);
      expect(backing.get<Record<string, unknown>>(KEYS.connectedRuns)).toHaveProperty('cr-1');
    } finally {
      store.close();
    }

    // 4. MIGRATION_9_INVALID_SOURCE_JSON must not echo secret prefixes; NaN schema_version rejected
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-m9-sec-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'sec.db');
    const conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(
        conn,
        () => NOW,
        BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8)
      );
      conn.run(
        `INSERT INTO operational_kv_documents (doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms)
         VALUES ('scope-sec', ?, 1, 1, 'sk-proj-SUPERSECRET_DO_NOT_LEAK', 31, 0, ?)`,
        KEYS.queue,
        NOW
      );
      let caughtMsg = '';
      try {
        SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 10);
      } catch (err) {
        caughtMsg = err instanceof Error ? err.message : String(err);
      }
      expect(caughtMsg).toContain('MIGRATION_9_INVALID_SOURCE_JSON');
      expect(caughtMsg).not.toContain('SUPERSECRET');

      // Corrupt non-numeric, empty, and '0' schema_version / min_reader_version must be rejected
      for (const badVal of ['not-a-number', '', '   ', '0']) {
        conn.run(`UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'schema_version'`, badVal);
        expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 20)).toThrow(
          /UNSUPPORTED_FUTURE_SCHEMA_VERSION/
        );
      }
      conn.run(`UPDATE schema_meta SET meta_value = '8' WHERE meta_key = 'schema_version'`);
      for (const badFloor of ['', '   ', '0']) {
        conn.run(`UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'min_reader_version'`, badFloor);
        expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 25)).toThrow(
          /UNSUPPORTED_MIN_READER_VERSION/
        );
      }
    } finally {
      conn.close();
    }
  });
});
