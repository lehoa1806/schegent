import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

type CrashBoundaryMode =
  | 'before-begin'
  | 'mid-tx'
  | 'after-commit'
  | 'negative-control-split-writes';

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
      return Promise.resolve();
    }
  };
}

function buildRun(featureId: string, runId: string, now: number): WorkflowRun {
  return {
    id: runId,
    featureId,
    featureDir: 'specs/315-run-transition-table',
    status: 'running',
    currentPhase: 'speckit-specify',
    currentIteration: 0,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    pipeline: {
      id: 'default-pipeline',
      name: 'Default',
      phases: [{ id: 'speckit-specify', name: 'Specify', instruction: 'Specify' }]
    }
  };
}

async function main(): Promise<void> {
  const [, , dbPath, scopeId, modeRaw, featureId, runId] = process.argv;
  if (!dbPath || !scopeId || !modeRaw || !featureId || !runId) {
    throw new Error('Usage: worker <dbPath> <scopeId> <mode> <featureId> <runId>');
  }
  const mode = modeRaw as CrashBoundaryMode;
  const now = 1_750_000_000_000;

  const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqliteStore, scopeId, () => now);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);

  const run = buildRun(featureId, runId, now);

  if (mode === 'negative-control-split-writes') {
    // Reproduces the legacy two-call split (setRun followed by crash before markInFlight).
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  const conn = sqliteStore.writerConnection;
  const originalExec = conn.exec.bind(conn);
  const originalRun = conn.run.bind(conn);

  let armCrash = false;

  conn.exec = ((sql: string) => {
    if (armCrash && mode === 'before-begin' && sql === 'BEGIN IMMEDIATE') {
      process.kill(process.pid, 'SIGKILL');
    }
    const res = originalExec(sql);
    if (armCrash && mode === 'after-commit' && sql === 'COMMIT') {
      process.kill(process.pid, 'SIGKILL');
    }
    return res;
  }) as typeof conn.exec;

  let kvWritesInTx = 0;
  conn.run = ((...args: Parameters<typeof conn.run>) => {
    const [sql, ...params] = args;
    if (armCrash && mode === 'mid-tx' && sql.includes('INSERT INTO operational_kv_documents')) {
      kvWritesInTx += 1;
      // Kill AFTER KEYS.run (kvWritesInTx === 1) has already been written inside the open
      // BEGIN IMMEDIATE transaction, right before KEYS.queue (kvWritesInTx === 2) / COMMIT.
      if (kvWritesInTx === 2 && params[1] === KEYS.queue) {
        process.kill(process.pid, 'SIGKILL');
      }
    }
    return originalRun(...args);
  }) as typeof conn.run;

  armCrash = true;
  await queue.admitRun(featureId, run);
  sqliteStore.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
