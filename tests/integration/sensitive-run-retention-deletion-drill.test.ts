/**
 * FR-R8-03 (03-01) — Sensitive-run retention and deletion drill with recognizable synthetic markers.
 *
 * Exercises `ephemeral`, `diagnostic` (`errors-only`), and `forensic` (`always`) privacy profiles
 * through `completed`, `paused`, `failed`, and interrupted cleanup (`orphan .pending` + dead-PID
 * temp spool), inspecting `.pending/`, POSIX `0700`/`0600` modes, SQLite store, SQLite backups,
 * `.schegent/audit.log`, runtime log, OS temp spools, private recovery checkpoints, failure records,
 * and a simulated backend CLI home store before and after `deleteRunEvidence`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { FAILURE_RECORD_DIR } from '../../src/contracts/failure-record';
import { privacyProfile } from '../../src/contracts/privacy-profiles';
import { SanitizedLogger } from '../../src/lib/logger';
import { CliTransportSink } from '../../src/monitor/cli-transport-sink';
import { TransportRouter } from '../../src/monitor/transport/transport-router';
import { deleteRunEvidence } from '../../src/services/evidence-delete';
import { RUN_CHECKPOINT_DIRECTORY, safeRunSegment } from '../../src/services/run-checkpoint-paths';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';

const PROMPT_MARKER = 'SCHEGENT_SYNTHETIC_PROMPT_MARKER_0301_SENSITIVE';
const STDOUT_MARKER = 'SCHEGENT_SYNTHETIC_STDOUT_MARKER_0301_SENSITIVE';
const STDERR_MARKER = 'SCHEGENT_SYNTHETIC_STDERR_MARKER_0301_SENSITIVE';
const SECRET_MARKER = ['ghp', 'SyntheticDrillToken0123456789ABCDEF99'].join('_');

const tempRoots: string[] = [];

function makeDrillSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-drill-0301-'));
  tempRoots.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  const privateStorage = path.join(root, 'global-storage');
  const spoolRoot = path.join(root, 'temp-spools');
  const fakeCliHome = path.join(root, 'fake-home', '.claude', 'projects', 'drill');
  const runtimeLogPath = path.join(root, 'runtime.log');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(privateStorage, { recursive: true });
  fs.mkdirSync(spoolRoot, { recursive: true });
  fs.mkdirSync(fakeCliHome, { recursive: true });
  return { root, workspaceRoot, privateStorage, spoolRoot, fakeCliHome, runtimeLogPath };
}

function makeFileLogger(runtimeLogPath: string): SanitizedLogger {
  return new SanitizedLogger([
    {
      appendLine(line: string): void {
        fs.appendFileSync(runtimeLogPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      }
    }
  ]);
}

function collectFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFilesRecursive(full));
    else if (entry.isFile()) results.push(full);
  }
  return results.sort();
}

function filesContainingMarker(dir: string, marker: string): string[] {
  const hits: string[] = [];
  for (const file of collectFilesRecursive(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(marker)) hits.push(path.relative(dir, file));
  }
  return hits;
}

function posixMode(targetPath: string): number {
  return fs.statSync(targetPath).mode & 0o777;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FR-R8-03 (03-01) sensitive-run retention & deletion drill', () => {
  it('ephemeral profile suppresses raw transcripts, .pending staging, temp spools, and transport bytes across completed, paused, and failed runs', async () => {
    const box = makeDrillSandbox();
    const profile = privacyProfile('ephemeral');
    const logger = makeFileLogger(box.runtimeLogPath);
    const rawWriter = new RawTranscriptWriter(box.workspaceRoot, logger, box.spoolRoot);
    const transportRouter = new TransportRouter({
      workspaceRoot: () => box.workspaceRoot,
      readSetting: () => profile.settings.transportCaptureMode,
      readRawTranscriptMode: () => profile.settings.rawTranscriptMode,
      readMaxAgeDays: () => profile.settings.sessionRetentionMaxAgeDays,
      tempRoot: box.spoolRoot,
      runStatus: () => undefined,
      logger
    });
    const transportSink = new CliTransportSink({
      router: transportRouter,
      sanitize: (line) => logger.sanitize(line),
      logger
    });
    const auditWriter = new AuditLogWriter({ workspaceRoot: box.workspaceRoot }, logger);

    try {
      for (const status of ['completed', 'paused', 'failed'] as const) {
        const runId = randomUUID();
        await rawWriter.appendStart({
          runId,
          phase: 'speckit-implement',
          iteration: 1,
          prompt: `${PROMPT_MARKER} ${SECRET_MARKER}`,
          mode: profile.settings.rawTranscriptMode
        });
        const capture = await rawWriter.createInvocationCapture(runId, profile.settings.rawTranscriptMode);
        expect(capture).toBeNull();
        transportSink.record({
          runId,
          phase: 'speckit-implement',
          stream: 'stdout',
          line: `${STDOUT_MARKER} ${SECRET_MARKER}`
        });
        await rawWriter.appendEnd({
          runId,
          stdout: `${STDOUT_MARKER} ${SECRET_MARKER}`,
          stderr: STDERR_MARKER,
          exitCode: status === 'failed' ? 1 : 0,
          killed: false,
          timedOut: false,
          capture,
          mode: profile.settings.rawTranscriptMode
        });
        await transportRouter.finalizeRun(runId, status, new Set());
        await rawWriter.finalizeRun(runId, status, profile.settings.rawTranscriptMode);
        await auditWriter.append({
          runId,
          phase: 'speckit-implement',
          iteration: 1,
          eventType: 'phase-end',
          outcome: status === 'failed' ? 'failure' : 'success',
          payload: {
            outcome: status === 'failed' ? 'failed' : 'clean',
            exitCode: status === 'failed' ? 1 : 0,
            terminationReason: status === 'failed' ? 'error' : 'completed'
          }
        });
        logger.info(`drill run ${runId} token=${SECRET_MARKER}`);
      }
    } finally {
      await transportSink.flushAndDispose();
    }

    // Zero disallowed raw/transport/spool markers anywhere in workspace or temp spool
    expect(filesContainingMarker(box.workspaceRoot, PROMPT_MARKER)).toEqual([]);
    expect(filesContainingMarker(box.workspaceRoot, STDOUT_MARKER)).toEqual([]);
    expect(filesContainingMarker(box.workspaceRoot, STDERR_MARKER)).toEqual([]);
    expect(filesContainingMarker(box.workspaceRoot, SECRET_MARKER)).toEqual([]);
    expect(fs.readdirSync(box.spoolRoot)).toEqual([]);
    expect(fs.existsSync(path.join(box.workspaceRoot, '.schegent', 'sessions', '.pending'))).toBe(false);

    // Runtime log is redacted (zero raw secret marker)
    if (fs.existsSync(box.runtimeLogPath)) {
      expect(fs.readFileSync(box.runtimeLogPath, 'utf8')).not.toContain(SECRET_MARKER);
    }
    // Audit log is owner-only (0600) inside 0700 .schegent
    if (process.platform !== 'win32') {
      expect(posixMode(path.join(box.workspaceRoot, '.schegent'))).toBe(0o700);
      expect(posixMode(path.join(box.workspaceRoot, '.schegent', 'audit.log'))).toBe(0o600);
    }
  });

  it('diagnostic (errors-only) stages temporarily, cleans up on completed, retains on paused/failed, and deleteRunEvidence removes per-run copies while disclosing surviving stores', async () => {
    const box = makeDrillSandbox();
    const profile = privacyProfile('diagnostic');
    const logger = makeFileLogger(box.runtimeLogPath);
    const rawWriter = new RawTranscriptWriter(box.workspaceRoot, logger, box.spoolRoot);
    const transportRouter = new TransportRouter({
      workspaceRoot: () => box.workspaceRoot,
      readSetting: () => profile.settings.transportCaptureMode,
      readRawTranscriptMode: () => profile.settings.rawTranscriptMode,
      readMaxAgeDays: () => profile.settings.sessionRetentionMaxAgeDays,
      tempRoot: box.spoolRoot,
      runStatus: () => undefined,
      logger
    });
    const transportSink = new CliTransportSink({
      router: transportRouter,
      sanitize: (line) => logger.sanitize(line),
      logger
    });
    const auditWriter = new AuditLogWriter({ workspaceRoot: box.workspaceRoot }, logger);
    const dbPath = path.join(box.privateStorage, 'sqlite', 'drill-scope', 'schegent-state.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

    try {
      // 1. Completed run under diagnostic: staged in .pending during run, completely removed on completion
      const completedRunId = randomUUID();
      await rawWriter.appendStart({
        runId: completedRunId,
        phase: 'speckit-plan',
        iteration: 1,
        prompt: PROMPT_MARKER,
        mode: profile.settings.rawTranscriptMode
      });
      const pendingCompletedPath = path.join(box.workspaceRoot, '.schegent', 'sessions', '.pending', `raw-${completedRunId}.log`);
      expect(fs.existsSync(pendingCompletedPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(posixMode(pendingCompletedPath)).toBe(0o600);
      }

      // Active .pending refuses deleteRunEvidence (never races live staging)
      const refusedWhilePending = await deleteRunEvidence(box.workspaceRoot, completedRunId, {
        isRunActive: () => false,
        checkpointRoot: box.privateStorage
      });
      expect(refusedWhilePending).toMatchObject({ outcome: 'refused', reason: 'active-writer' });

      const completedCapture = await rawWriter.createInvocationCapture(completedRunId, profile.settings.rawTranscriptMode);
      expect(completedCapture).not.toBeNull();
      completedCapture?.write('stdout', `${STDOUT_MARKER}\n`);
      transportSink.record({
        runId: completedRunId,
        phase: 'speckit-plan',
        stream: 'stdout',
        line: `${STDOUT_MARKER} ${SECRET_MARKER}`
      });
      await rawWriter.appendEnd({
        runId: completedRunId,
        stdout: STDOUT_MARKER,
        stderr: '',
        exitCode: 0,
        killed: false,
        timedOut: false,
        capture: completedCapture,
        mode: profile.settings.rawTranscriptMode
      });
      await transportRouter.finalizeRun(completedRunId, 'completed', new Set());
      await rawWriter.finalizeRun(completedRunId, 'completed', profile.settings.rawTranscriptMode);

      expect(fs.existsSync(pendingCompletedPath)).toBe(false);
      expect(fs.existsSync(path.join(box.workspaceRoot, '.schegent', 'sessions', `raw-${completedRunId}.log`))).toBe(false);
      expect(fs.existsSync(path.join(box.workspaceRoot, '.schegent', 'sessions', completedRunId, 'transport.log'))).toBe(false);

      // 1b. Paused run under diagnostic: promotes pending raw transcript & retains on pause, then deleteRunEvidence removes it cleanly
      const pausedRunId = randomUUID();
      await rawWriter.appendStart({
        runId: pausedRunId,
        phase: 'speckit-plan',
        iteration: 1,
        prompt: `${PROMPT_MARKER}:paused`,
        mode: profile.settings.rawTranscriptMode
      });
      const pausedPendingPath = path.join(box.workspaceRoot, '.schegent', 'sessions', '.pending', `raw-${pausedRunId}.log`);
      expect(fs.existsSync(pausedPendingPath)).toBe(true);
      await rawWriter.appendEnd({
        runId: pausedRunId,
        stdout: `${STDOUT_MARKER}:paused`,
        stderr: '',
        exitCode: 0,
        killed: false,
        timedOut: false,
        mode: profile.settings.rawTranscriptMode
      });
      await rawWriter.finalizeRun(pausedRunId, 'paused', profile.settings.rawTranscriptMode);
      const pausedRetainedPath = path.join(box.workspaceRoot, '.schegent', 'sessions', `raw-${pausedRunId}.log`);
      expect(fs.existsSync(pausedPendingPath)).toBe(false);
      expect(fs.existsSync(pausedRetainedPath)).toBe(true);
      expect(fs.readFileSync(pausedRetainedPath, 'utf8')).toContain(`${PROMPT_MARKER}:paused`);
      const deletedPaused = await deleteRunEvidence(box.workspaceRoot, pausedRunId, {
        isRunActive: () => false,
        checkpointRoot: box.privateStorage
      });
      expect(deletedPaused.outcome).toBe('completed');
      expect(fs.existsSync(pausedRetainedPath)).toBe(false);

      // 1c. Interrupted cleanup: orphaned .pending/raw-<runId>.log left by an abrupt host stop is reclaimed on finalizeRun('completed')
      const orphanPendingRunId = randomUUID();
      await rawWriter.appendStart({
        runId: orphanPendingRunId,
        phase: 'speckit-plan',
        iteration: 1,
        prompt: `${PROMPT_MARKER}:orphan`,
        mode: profile.settings.rawTranscriptMode
      });
      const orphanPendingPath = path.join(box.workspaceRoot, '.schegent', 'sessions', '.pending', `raw-${orphanPendingRunId}.log`);
      expect(fs.existsSync(orphanPendingPath)).toBe(true);
      await rawWriter.finalizeRun(orphanPendingRunId, 'completed', profile.settings.rawTranscriptMode);
      expect(fs.existsSync(orphanPendingPath)).toBe(false);

      // 2. Failed run under diagnostic: promotes raw transcript + redacted transport, plus checkpoint, failure record, SQLite backup, and simulated CLI home session
      const failedRunId = randomUUID();
      await rawWriter.appendStart({
        runId: failedRunId,
        phase: 'speckit-implement',
        iteration: 1,
        prompt: `${PROMPT_MARKER} ${SECRET_MARKER}`,
        mode: profile.settings.rawTranscriptMode
      });
      const failedCapture = await rawWriter.createInvocationCapture(failedRunId, profile.settings.rawTranscriptMode);
      failedCapture?.write('stdout', `${STDOUT_MARKER} ${SECRET_MARKER}\n`);
      failedCapture?.write('stderr', `${STDERR_MARKER}\n`);
      transportSink.record({
        runId: failedRunId,
        phase: 'speckit-implement',
        stream: 'stdout',
        line: `${STDOUT_MARKER} ${SECRET_MARKER}`
      });
      await rawWriter.appendEnd({
        runId: failedRunId,
        stdout: STDOUT_MARKER,
        stderr: STDERR_MARKER,
        exitCode: 1,
        killed: false,
        timedOut: false,
        capture: failedCapture,
        mode: profile.settings.rawTranscriptMode
      });
      await transportRouter.finalizeRun(failedRunId, 'failed', new Set());
      await rawWriter.finalizeRun(failedRunId, 'failed', profile.settings.rawTranscriptMode);

      // Seed private recovery checkpoint, failure record, history description, audit row, SQLite backup, and simulated CLI home file
      const checkpointDir = path.join(box.privateStorage, RUN_CHECKPOINT_DIRECTORY, safeRunSegment(failedRunId));
      fs.mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(checkpointDir, 'patch.diff'), `diff ${PROMPT_MARKER}\n`, { mode: 0o600 });

      const failureDir = path.join(box.workspaceRoot, ...FAILURE_RECORD_DIR);
      fs.mkdirSync(failureDir, { recursive: true, mode: 0o700 });
      const failureFile = path.join(failureDir, `20261124T120000000Z_deadbeef_${failedRunId}_${randomUUID()}.json`);
      fs.writeFileSync(failureFile, JSON.stringify({ runId: failedRunId, cause: 'error' }), { mode: 0o600 });

      const historyDir = path.join(box.workspaceRoot, '.schegent', 'history');
      fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
      const historyFile = path.join(historyDir, `${failedRunId}.txt`);
      fs.writeFileSync(historyFile, 'Run history description kept intentionally', { mode: 0o600 });

      await auditWriter.append({
        runId: failedRunId,
        phase: 'speckit-implement',
        iteration: 1,
        eventType: 'phase-end',
        outcome: 'failure',
        payload: { outcome: 'failed', exitCode: 1, terminationReason: 'error' }
      });

      const backup = await sqliteStore.backupRestore.createOnlineBackup({
        backupId: 'bkp-drill-0301',
        scopeId: 'drill-scope',
        trustedRootDir: box.privateStorage,
        relativeBackupDirSegments: ['sqlite', 'drill-scope', 'backups']
      });
      expect(fs.existsSync(backup.backupDatabasePath)).toBe(true);

      const cliSessionFile = path.join(box.fakeCliHome, `${failedRunId}.jsonl`);
      fs.writeFileSync(cliSessionFile, JSON.stringify({ prompt: PROMPT_MARKER, secret: SECRET_MARKER }), { mode: 0o600 });

      const retainedRawPath = path.join(box.workspaceRoot, '.schegent', 'sessions', `raw-${failedRunId}.log`);
      const retainedTransportPath = path.join(box.workspaceRoot, '.schegent', 'sessions', failedRunId, 'transport.log');
      expect(fs.existsSync(retainedRawPath)).toBe(true);
      expect(fs.readFileSync(retainedRawPath, 'utf8')).toContain(PROMPT_MARKER);
      expect(fs.existsSync(retainedTransportPath)).toBe(true);
      // Transport redacts secret patterns
      expect(fs.readFileSync(retainedTransportPath, 'utf8')).not.toContain(SECRET_MARKER);
      if (process.platform !== 'win32') {
        expect(posixMode(retainedRawPath)).toBe(0o600);
        expect(posixMode(retainedTransportPath)).toBe(0o600);
      }

      // Execute supported deletion action
      const deleted = await deleteRunEvidence(box.workspaceRoot, failedRunId, {
        isRunActive: () => false,
        checkpointRoot: box.privateStorage
      });
      expect(deleted.outcome).toBe('completed');
      if (deleted.outcome !== 'completed') return;
      expect(deleted.checkpoint).toBe('removed');
      expect(deleted.removed).toContain(`.schegent/sessions/raw-${failedRunId}.log`);
      expect(deleted.removed).toContain(`.schegent/sessions/${failedRunId}/transport.log`);
      expect(deleted.removed.some((p) => p.includes('failure-records'))).toBe(true);
      expect(deleted.retained).toContainEqual({ path: `.schegent/history/${failedRunId}.txt`, reason: 'run-history' });

      // All surviving stores explicitly disclosed
      const keptStoreIds = deleted.keptStores.map((k) => k.store);
      expect(keptStoreIds).toEqual(
        expect.arrayContaining([
          'audit-log',
          'runtime-log',
          'metrics-rollup',
          'run-history',
          'sqlite-store',
          'sqlite-backups',
          'external-artifacts-and-handoffs',
          'telemetry-spool',
          'provider-cli-stores'
        ])
      );

      // Verify on-disk post-deletion state: per-run sensitive workspace/checkpoint bytes gone, disclosed surviving stores intact
      expect(fs.existsSync(retainedRawPath)).toBe(false);
      expect(fs.existsSync(retainedTransportPath)).toBe(false);
      expect(fs.existsSync(checkpointDir)).toBe(false);
      expect(fs.existsSync(failureFile)).toBe(false);
      expect(filesContainingMarker(box.workspaceRoot, PROMPT_MARKER)).toEqual([]);
      expect(filesContainingMarker(box.workspaceRoot, STDOUT_MARKER)).toEqual([]);
      expect(fs.existsSync(historyFile)).toBe(true);
      expect(fs.existsSync(path.join(box.workspaceRoot, '.schegent', 'audit.log'))).toBe(true);
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(backup.backupDatabasePath)).toBe(true);
      expect(fs.existsSync(cliSessionFile)).toBe(true);
    } finally {
      await transportSink.flushAndDispose();
      sqliteStore.close();
    }
  });

  it('forensic retains completed run transcripts and interrupted dead-PID temp spools are scavenged on next capture', async () => {
    const box = makeDrillSandbox();
    const profile = privacyProfile('forensic');
    const logger = makeFileLogger(box.runtimeLogPath);
    const rawWriter = new RawTranscriptWriter(box.workspaceRoot, logger, box.spoolRoot);

    // Plant an abandoned temp spool from a dead PID (simulating SIGKILL interrupted cleanup)
    const deadSpool = path.join(box.spoolRoot, 'schegent-raw-spool-999999-orphaned');
    fs.mkdirSync(deadSpool, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deadSpool, 'stdout'), PROMPT_MARKER, { mode: 0o600 });
    expect(fs.existsSync(deadSpool)).toBe(true);

    const runId = randomUUID();
    await rawWriter.appendStart({
      runId,
      phase: 'speckit-plan',
      iteration: 1,
      prompt: PROMPT_MARKER,
      mode: profile.settings.rawTranscriptMode
    });
    const capture = await rawWriter.createInvocationCapture(runId, profile.settings.rawTranscriptMode);
    expect(capture).not.toBeNull();
    // Dead-PID spool was scavenged automatically by createInvocationCapture
    expect(fs.existsSync(deadSpool)).toBe(false);

    capture?.write('stdout', `${STDOUT_MARKER}\n`);
    await rawWriter.appendEnd({
      runId,
      stdout: STDOUT_MARKER,
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      capture,
      mode: profile.settings.rawTranscriptMode
    });
    await rawWriter.finalizeRun(runId, 'completed', profile.settings.rawTranscriptMode);

    const rawPath = path.join(box.workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`);
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.readFileSync(rawPath, 'utf8')).toContain(PROMPT_MARKER);
    expect(fs.readFileSync(rawPath, 'utf8')).toContain(STDOUT_MARKER);

    const del = await deleteRunEvidence(box.workspaceRoot, runId, {
      isRunActive: () => false,
      checkpointRoot: box.privateStorage
    });
    expect(del.outcome).toBe('completed');
    expect(fs.existsSync(rawPath)).toBe(false);
  });
});
