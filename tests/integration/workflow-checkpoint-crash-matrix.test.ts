/**
 * FR-R8-01 (01-09, T021, SC-009) — Real 16-case `SIGKILL` crash-recovery matrix
 * across immediately before and immediately after every one of the 8 persisted
 * production workflow checkpoints on disposable WAL SQLite stores with
 * deterministic fake provider child processes and two consecutive restarts.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reconcileComposableWorkflowRuns } from '../../src/activation/run-safety-wiring';
import { createDesktopOwnershipFenceForStore } from '../../src/activation/workflow-ownership-fence';
import { SanitizedLogger } from '../../src/lib/logger';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import {
  createProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import { resolveRootInvocationId } from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager, type Scheduler } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';
import type {
  CrashCheckpointId,
  CrashTiming
} from './helpers/workflow-checkpoint-crash-worker';

const WORKER_SCRIPT = path.resolve(__dirname, 'helpers', 'workflow-checkpoint-crash-worker.ts');
let workerBundleDir = '';
let workerCjsPath = '';

beforeAll(() => {
  workerBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-wf-crash-bundle-'));
  workerCjsPath = path.join(workerBundleDir, 'workflow-checkpoint-crash-worker.cjs');
  buildSync({
    entryPoints: [WORKER_SCRIPT],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:sqlite'],
    outfile: workerCjsPath
  });
});

afterAll(() => {
  if (workerBundleDir.length > 0) {
    fs.rmSync(workerBundleDir, { recursive: true, force: true });
  }
});

const CHECKPOINTS: readonly CrashCheckpointId[] = [
  'prepared-root',
  'linked-root',
  'admitted-attempt',
  'pending-dispatch',
  'spawn-intent',
  'acknowledged-process',
  'settled-attempt',
  'terminal-projection'
];

const CASES: readonly { readonly checkpoint: CrashCheckpointId; readonly timing: CrashTiming }[] =
  CHECKPOINTS.flatMap((checkpoint) => [
    { checkpoint, timing: 'before' as const },
    { checkpoint, timing: 'after' as const }
  ]);

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

const fixtureTempDirs: string[] = [];
const fixtureOwnedPids: number[] = [];

function killFixturePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

afterEach(async () => {
  while (fixtureOwnedPids.length > 0) {
    const pid = fixtureOwnedPids.pop();
    if (pid !== undefined) killFixturePid(pid);
  }
  while (fixtureTempDirs.length > 0) {
    const dir = fixtureTempDirs.pop();
    if (dir !== undefined) await removeTempRoot(dir);
  }
});

interface WorkerReadyMessage {
  readonly readyToKill: true;
  readonly checkpoint: CrashCheckpointId;
  readonly timing: CrashTiming;
  readonly attemptId?: string;
  readonly queueItemId?: string;
  readonly providerPid?: number;
  readonly receiptPath?: string;
}

async function runWorkerAndSigkill(params: {
  readonly dbPath: string;
  readonly workspaceRoot: string;
  readonly receiptDir: string;
  readonly checkpoint: CrashCheckpointId;
  readonly timing: CrashTiming;
  readonly runId: string;
}): Promise<{ readonly signal: NodeJS.Signals | null; readonly sentinel: WorkerReadyMessage }> {
  const child = spawn(
    process.execPath,
    [
      workerCjsPath,
      params.dbPath,
      params.workspaceRoot,
      params.receiptDir,
      params.checkpoint,
      params.timing,
      params.runId
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  if (child.pid !== undefined) fixtureOwnedPids.push(child.pid);

  let stderrBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });

  const sentinel = await new Promise<WorkerReadyMessage>((resolve, reject) => {
    let stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      for (const line of stdoutBuf.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<WorkerReadyMessage>;
          if (parsed.readyToKill === true) {
            resolve(parsed as WorkerReadyMessage);
            return;
          }
        } catch {
          // Wait for full JSON line.
        }
      }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `Crash worker exited before readyToKill (code=${String(code)}, signal=${String(signal)}): ${stderrBuf}`
        )
      );
    });
  });

  if (sentinel.providerPid !== undefined && sentinel.providerPid > 1) {
    fixtureOwnedPids.push(sentinel.providerPid);
  }

  const exitSignal = await new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('exit', (_code, signal) => resolve(signal));
    child.kill('SIGKILL');
  });

  return { signal: exitSignal, sentinel };
}

async function runRestartRecoveryPass(params: {
  readonly dbPath: string;
  readonly workspaceRoot: string;
  readonly runId: string;
}): Promise<{
  readonly rootLinkState: string | null;
  readonly rootStatus: string | null;
  readonly connectedRunStatus: string | null;
  readonly pauseCause: string | null;
  readonly queueRowCount: number;
  readonly activePermitCount: number;
  readonly uncertainPermitCount: number;
  readonly attemptStage: string | null;
}> {
  const sqlite = new SqliteApplicationStore({ databasePath: params.dbPath, journalMode: 'wal' });
  expect(sqlite.writerConnection.scalar<string>('PRAGMA integrity_check')).toBe('ok');
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqlite, 'crash-matrix-scope');
  const ownershipDir = path.join(params.workspaceRoot, '.schegent', 'ownership');
  const store = new WorkspaceStateStore(memento);
  store.useOwnershipStorage(
    createDiskOwnershipFs({ workspaceRoot: params.workspaceRoot, ownershipDir }),
    ownershipDir
  );
  await store.initialize();
  const recoveryNow = () => Date.now() + STALENESS_THRESHOLD_MS + 5_000;
  const lock = new WorkspaceLockManager(
    store,
    'recovery-win',
    { now: recoveryNow },
    noopScheduler
  );
  const acquired = await lock.tryAcquire();
  expect(acquired.acquired).toBe(true);
  store.bindPrimacyClaimSource(lock);
  const lease = new ExecutionLeaseManager(store, 'recovery-win', { now: recoveryNow }, noopScheduler);
  store.bindRunClaimSource(lease);
  const logger = new SanitizedLogger();
  const composition = createProductionWorkflowComposition({
    store,
    workspaceRoot: params.workspaceRoot,
    isWorkspaceTrusted: () => true,
    ...createDesktopOwnershipFenceForStore(store),
    requireLiveFenceVerifier: true
  });
  registerProductionWorkflowComposition(store, composition);

  try {
    await reconcileComposableWorkflowRuns({
      workspaceRoot: params.workspaceRoot,
      store,
      logger,
      productionComposition: composition
    });

    const ledgerRead = composition.ledgerStore.read();
    const root = ledgerRead.ok ? ledgerRead.ledger.roots[params.runId] ?? null : null;
    const connected = store.getConnectedRun(params.runId);
    const rootInvId = connected !== null ? resolveRootInvocationId(connected) : null;
    const rootFrame = rootInvId !== null ? connected?.invocations?.[rootInvId] ?? null : null;
    const permits = ledgerRead.ok
      ? Object.values(ledgerRead.ledger.permits).filter(
          (p) => (p.rootRunId ?? p.ledgerRunId) === params.runId
        )
      : [];
    const activePermitCount = permits.filter((p) => p.status === 'active').length;
    const uncertainPermitCount = permits.filter(
      (p) => p.status === 'held-uncertain' || p.state === 'uncertain'
    ).length;
    const attempt = root !== null ? Object.values(root.attemptsById)[0] ?? null : null;

    return {
      rootLinkState: root?.linkState ?? null,
      rootStatus: root?.status ?? null,
      connectedRunStatus: rootFrame?.status ?? null,
      pauseCause: rootFrame?.controlMarkers?.manualPauseCause ?? root?.pauseCause ?? null,
      queueRowCount: store.getQueue('default').requests.length,
      activePermitCount,
      uncertainPermitCount,
      attemptStage: attempt?.stage ?? null
    };
  } finally {
    unregisterProductionWorkflowComposition(store, composition);
    await lock.release();
    sqlite.close();
  }
}

describe('FR-R8-01 (01-09) — Real 16-case SIGKILL 8-checkpoint crash-recovery matrix', () => {
  it.each(CASES)(
    'recovers cleanly across two restarts after SIGKILL $timing $checkpoint',
    async ({ checkpoint, timing }) => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `schegent-crash-${checkpoint}-${timing}-`));
      fixtureTempDirs.push(tmpRoot);
      const dbPath = path.join(tmpRoot, 'state.sqlite');
      const receiptDir = path.join(tmpRoot, 'receipts');
      fs.mkdirSync(receiptDir, { recursive: true });
      const runId = `crun-crash-${checkpoint}-${timing}`;

      const { signal } = await runWorkerAndSigkill({
        dbPath,
        workspaceRoot: tmpRoot,
        receiptDir,
        checkpoint,
        timing,
        runId
      });
      expect(signal).toBe('SIGKILL');

      const receiptFiles = fs.readdirSync(receiptDir).filter((f) => f.startsWith('receipt-'));

      // Two consecutive restarts on fresh WAL SQLite handles must converge identically
      const pass1 = await runRestartRecoveryPass({ dbPath, workspaceRoot: tmpRoot, runId });
      const pass2 = await runRestartRecoveryPass({ dbPath, workspaceRoot: tmpRoot, runId });
      expect(pass2).toEqual(pass1);

      // Independent post-recovery invariants per checkpoint
      if (
        checkpoint === 'prepared-root' ||
        checkpoint === 'linked-root' ||
        checkpoint === 'admitted-attempt' ||
        (checkpoint === 'pending-dispatch' && timing === 'before')
      ) {
        // Pre-queue crash: orphaned unstarted root cleaned up, zero queue items, zero permits, zero provider receipts
        expect(receiptFiles.length).toBe(0);
        expect(pass1.rootLinkState).toBeNull();
        expect(pass1.connectedRunStatus).toBeNull();
        expect(pass1.queueRowCount).toBe(0);
        expect(pass1.activePermitCount).toBe(0);
        expect(pass1.uncertainPermitCount).toBe(0);
      } else if (
        (checkpoint === 'pending-dispatch' && timing === 'after') ||
        (checkpoint === 'spawn-intent' && timing === 'before')
      ) {
        // Queue item durably committed with parent run, zero spawns occurred: stays pending-dispatch & in-flight
        expect(receiptFiles.length).toBe(0);
        expect(pass1.rootLinkState).toBe('active');
        expect(pass1.connectedRunStatus).toBe('in-flight');
        expect(pass1.queueRowCount).toBe(1);
        expect(pass1.attemptStage).toBe('pending-dispatch');
      } else if (checkpoint === 'spawn-intent' && timing === 'after') {
        // Spawn intent persisted right before child spawn; host was SIGKILL'd -> paused uncertain, zero spawns!
        expect(receiptFiles.length).toBe(0);
        expect(pass1.connectedRunStatus).toBe('paused');
        expect(pass1.pauseCause).toBe('recovery-uncertain-effect');
        expect(pass1.queueRowCount).toBe(1);
        expect(pass1.activePermitCount).toBe(0);
        expect(pass1.uncertainPermitCount).toBe(1);
        expect(fs.readdirSync(receiptDir).filter((f) => f.startsWith('receipt-')).length).toBe(0);
      } else if (checkpoint === 'acknowledged-process') {
        // Provider spawned via ProcessLifecycleRunner and wrote receipt; host crashed before/after ack -> paused uncertain, zero duplicate spawns!
        expect(receiptFiles.length).toBe(1);
        expect(pass1.connectedRunStatus).toBe('paused');
        expect(pass1.pauseCause).toBe('recovery-uncertain-effect');
        expect(pass1.queueRowCount).toBe(1);
        expect(pass1.activePermitCount).toBe(0);
        expect(pass1.uncertainPermitCount).toBe(1);
        // Recovery MUST NOT spawn a second provider child
        expect(fs.readdirSync(receiptDir).filter((f) => f.startsWith('receipt-')).length).toBe(1);
      } else {
        // settled-attempt (before/after) & terminal-projection (before/after): converges cleanly to completed terminal root
        expect(receiptFiles.length).toBe(1);
        expect(pass1.connectedRunStatus).toBe('completed');
        expect(pass1.rootLinkState).toBe('terminal');
        expect(pass1.rootStatus).toBe('completed');
        expect(pass1.queueRowCount).toBe(1);
        expect(pass1.activePermitCount).toBe(0);
        expect(pass1.uncertainPermitCount).toBe(0);
        expect(fs.readdirSync(receiptDir).filter((f) => f.startsWith('receipt-')).length).toBe(1);
      }
    },
    30_000
  );
});
