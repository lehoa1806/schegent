/**
 * Post-merge review Finding 5 — unit & parity tests for the read-only
 * `node:worker_threads` chunked run-snapshot capture worker.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { captureRunSnapshot, type CaptureRequest } from '../../../src/services/reporting/snapshot-capture';
import {
  createRunSnapshotWorkerClient,
  resolveRunSnapshotWorkerPath,
  RUN_SNAPSHOT_WORKER_FILENAME,
  RUN_SNAPSHOT_WORKER_RESOURCE_LIMITS
} from '../../../src/services/reporting/run-snapshot-worker';
import {
  resolveWorkerEntryPath,
  WORKER_OOM_ERROR_CODE
} from '../../../src/services/worker-entry-path';
import { seedAttempt, seedRun } from './report-fixture';
import { removeTempRoot } from '../../temp-root-cleanup';

const NOW = 1_800_000_000_000;

describe('Post-merge Finding 5 — RunSnapshotWorkerClient parity, truncation, and cancellation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await removeTempRoot(dir);
    }
  });

  async function createSeededDb(): Promise<{ dbPath: string; conn: NodeSqliteConnection }> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-run-snap-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'runs.sqlite');
    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
    seedRun(conn, {
      runId: 'r-1',
      createdAtMs: 1_500,
      workflowId: 'wf-a',
      frozenClosureId: 'fz-1',
      status: 'failed',
      startedAtMs: 1_500,
      completedAtMs: 2_000,
      terminalReason: 'phase_timeout'
    });
    seedRun(conn, {
      runId: 'r-2',
      createdAtMs: 1_600,
      workflowId: 'wf-b',
      frozenClosureId: null,
      status: 'succeeded',
      startedAtMs: 1_600,
      completedAtMs: 2_100,
      terminalReason: 'custom free text /path/to/secret'
    });
    seedAttempt(conn, { attemptId: 'a-1', runId: 'r-1', stepIndex: 0, attemptNumber: 1, startedAtMs: 1_510, completedAtMs: 1_800, exitCode: 1, status: 'failed' });
    seedAttempt(conn, { attemptId: 'a-2', runId: 'r-2', stepIndex: 0, attemptNumber: 1, startedAtMs: 1_610, completedAtMs: 1_900, exitCode: 0, status: 'succeeded' });
    conn.run(`UPDATE attempts SET backend_kind = 'claude', model_id = 'claude-sonnet' WHERE attempt_id = 'a-1'`);

    for (const [id, runId, attemptId] of [
      ['art-1', 'r-1', 'a-1'],
      ['art-2', 'r-1', 'a-1'],
      ['art-3', 'r-2', 'a-2']
    ] as const) {
      conn.run(
        `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
         VALUES (?, ?, 64, 'application/json', 'diagnostic', ?, ?, 1550)`,
        id,
        'd'.repeat(64),
        runId,
        attemptId
      );
      conn.run(
        `INSERT INTO artifact_lifecycle (
           artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
           retention_class, store_kind, immutability, digest_algorithm, digest_value,
           generation, extent_bytes, byte_size, availability, producer_identity,
           display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
         ) VALUES (
           ?, 1, ?, ?, 'metadata',
           'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?,
           NULL, NULL, 64, 'present', 'runner', 'diag.json', 1550, 1550, NULL, 1550
         )`,
        id,
        runId,
        attemptId,
        'd'.repeat(64)
      );
    }

    conn.run(
      `INSERT INTO phase_handoff_records (
         handoff_id, run_id, source_attempt_id, target_phase_id, revision, status, record_json, record_bytes, created_at_ms, updated_at_ms
       ) VALUES ('ho-1', 'r-1', 'a-1', 'verify', 1, 'ready', '{}', 2, 1550, 1550)`
    );
    conn.run(
      `INSERT INTO phase_review_loop_ledgers (loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms)
       VALUES ('loop-1', 'r-1', 'review', 1, 'approved', '{"candidateRef":"c/1","snapshot":{"findings":[{"status":"resolved"}]}}', 1550)`
    );
    return { dbPath, conn };
  }

  it('matches synchronous captureRunSnapshot verbatim across full, filtered, and auxiliary-truncated captures', async () => {
    const { dbPath, conn } = await createSeededDb();
    const worker = createRunSnapshotWorkerClient(dbPath, { chunkSize: 1 });
    try {
      const fullReq: CaptureRequest = {
        workspaceId: 'ws-1',
        range: { startMs: 1_000, endMs: 5_000 },
        cutoffMs: 5_000,
        filters: {},
        cap: 10
      };
      const syncFull = captureRunSnapshot(conn, fullReq);
      const workerFull = await worker.capture(fullReq);
      expect(workerFull).toEqual(syncFull);

      // Auxiliary truncation parity (cap = 2 fits 2 roots & 2 attempts, truncates 3 artifacts).
      const truncReq: CaptureRequest = { ...fullReq, cap: 2 };
      const syncTrunc = captureRunSnapshot(conn, truncReq);
      const workerTrunc = await worker.capture(truncReq);
      expect(workerTrunc).toEqual(syncTrunc);
      if (!workerTrunc.ok) throw new Error('expected ok');
      expect(workerTrunc.value.omissions).toEqual([
        { what: 'evidenceRefs', reason: 'snapshot-rows-truncated' }
      ]);

      // Root cap limit parity.
      const limitedReq: CaptureRequest = { ...fullReq, cap: 1 };
      expect(await worker.capture(limitedReq)).toEqual(captureRunSnapshot(conn, limitedReq));

      // Filter parity.
      const filteredReq: CaptureRequest = { ...fullReq, filters: { workflowId: ['wf-a'] } };
      expect(await worker.capture(filteredReq)).toEqual(captureRunSnapshot(conn, filteredReq));
      expect(worker.spawnCount).toBe(1);
    } finally {
      await worker.close();
      conn.close();
    }
  });

  it('returns cancelled immediately for pre-aborted signals and recovers cleanly after mid-flight cancellation', async () => {
    const { dbPath, conn } = await createSeededDb();
    const worker = createRunSnapshotWorkerClient(dbPath);
    try {
      const req: CaptureRequest = {
        workspaceId: 'ws-1',
        range: { startMs: 1_000, endMs: 5_000 },
        cutoffMs: 5_000,
        filters: {},
        cap: 10
      };
      const preAborted = new AbortController();
      preAborted.abort();
      expect(await worker.capture(req, { signal: preAborted.signal })).toEqual({
        ok: false,
        outcome: 'cancelled'
      });

      // Mid-flight cancellation terminates worker; next capture respawns cleanly.
      const liveAbort = new AbortController();
      const inFlight = worker.capture(req, { signal: liveAbort.signal });
      liveAbort.abort();
      expect(await inFlight).toEqual({ ok: false, outcome: 'cancelled' });
      expect(worker.terminationCount).toBeGreaterThanOrEqual(1);

      const recovered = await worker.capture(req);
      expect(recovered.ok).toBe(true);
    } finally {
      await worker.close();
      conn.close();
    }
  });

  it('resolves dist/<name>.worker.js for bundled host, sibling .js for compiled host, and sibling .ts in Vitest', () => {
    const distDir = path.resolve('/app/dist');
    const distBundle = path.join(distDir, RUN_SNAPSHOT_WORKER_FILENAME);
    expect(
      resolveRunSnapshotWorkerPath({
        callerDir: distDir,
        callerFilename: path.join(distDir, 'extension.js'),
        fileExists: (candidate) => candidate === distBundle
      })
    ).toBe(distBundle);

    const outDir = path.resolve('/app/out/src/services/reporting');
    const compiledSibling = path.join(outDir, 'run-snapshot-worker-entry.js');
    expect(
      resolveRunSnapshotWorkerPath({
        callerDir: outDir,
        callerFilename: path.join(outDir, 'run-snapshot-worker.js'),
        fileExists: (candidate) => candidate === compiledSibling
      })
    ).toBe(compiledSibling);

    const liveResolved = resolveRunSnapshotWorkerPath();
    expect(liveResolved.endsWith(path.join('reporting', 'run-snapshot-worker-entry.ts'))).toBe(true);

    expect(
      resolveWorkerEntryPath({
        bundledFilename: 'demo.worker.js',
        sourceEntryStem: 'demo-entry',
        callerDir: distDir,
        callerFilename: path.join(distDir, 'extension.js'),
        fileExists: () => false
      })
    ).toBe(path.join(distDir, 'demo.worker.js'));

    expect(RUN_SNAPSHOT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(256);
    expect(RUN_SNAPSHOT_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb).toBe(32);
  });

  it('maps ERR_WORKER_OUT_OF_MEMORY cleanly to limited/working-data and non-OOM worker crashes to source-read-failed', async () => {
    const { dbPath, conn } = await createSeededDb();
    const scriptDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-run-snap-oom-'));
    tempDirs.push(scriptDir);

    const oomScript = path.join(scriptDir, 'oom-worker.cjs');
    await fsp.writeFile(
      oomScript,
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', () => {
         const hold = [];
         while (true) hold.push(new Array(1024 * 1024).fill(1));
       });`,
      'utf8'
    );

    const crashScript = path.join(scriptDir, 'crash-worker.cjs');
    await fsp.writeFile(
      crashScript,
      `const { parentPort } = require('node:worker_threads');
       parentPort.on('message', () => {
         const err = new Error('boom');
         err.code = 'SIMULATED_WORKER_CRASH';
         throw err;
       });`,
      'utf8'
    );

    const req: CaptureRequest = {
      workspaceId: 'ws-1',
      range: { startMs: 1_000, endMs: 5_000 },
      cutoffMs: 5_000,
      filters: {},
      cap: 10
    };

    const oomCodes: string[] = [];
    const oomClient = createRunSnapshotWorkerClient(dbPath, {
      workerEntryPath: oomScript,
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      onErrorCode: (code) => oomCodes.push(code)
    });
    const crashCodes: string[] = [];
    const crashClient = createRunSnapshotWorkerClient(dbPath, {
      workerEntryPath: crashScript,
      onErrorCode: (code) => crashCodes.push(code)
    });
    try {
      const oomResult = await oomClient.capture(req);
      expect(oomResult).toEqual({ ok: false, outcome: 'limited', limit: 'working-data' });
      expect(oomCodes).toContain(WORKER_OOM_ERROR_CODE);

      const crashResult = await crashClient.capture(req);
      expect(crashResult).toEqual({ ok: false, outcome: 'failed', reason: 'source-read-failed' });
      expect(crashCodes).toContain('SIMULATED_WORKER_CRASH');
    } finally {
      await oomClient.close();
      await crashClient.close();
      conn.close();
    }
  });
});

