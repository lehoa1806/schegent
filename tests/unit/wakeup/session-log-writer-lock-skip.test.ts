// Feature 031 T044 — unit tests for the lock-skipped invocation invariant.
//
// Lock-skipped invocations (`status === 'skipped' && lockAcquired === false`)
// MUST NOT call `appendBlock` — the file is left untouched. Additionally
// the JSONL `InvocationRecord` for this skip path MUST carry
// `correlationId === undefined` (per data-model §3 invariant — lock-skipped
// records produce no session-log block, so there is no correlation target).
//
// We exercise the headless runner end-to-end with a lock-held setup:
//   1. Pre-acquire the wakeup lock with a fresh PID (so the runner sees a
//      live competitor and skips).
//   2. Invoke `runWakeup({ recordLockSkipped: true })` so the skip path
//      appends a JSONL record.
//   3. Assert `session.log` was never created.
//   4. Assert the appended JSONL record has `correlationId === undefined`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
  closeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWakeup } from '../../../src/headless/wakeup-runner';
import { InvocationLog } from '../../../src/wakeup/invocation-log';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-log-writer-lock-skip-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Feature 031 T044 — lock-skipped invocations do not write session.log', () => {
  it('session.log is NOT created on the lock-held skip path', async () => {
    // Seed a valid settings mirror so the runner does not bail before the
    // lock acquisition step.
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h'
      }),
      'utf8'
    );
    // Pre-acquire the lock with a live PID so the runner takes the
    // lock-held skip branch.
    const lockPath = join(tmpDir, 'wakeup.lock');
    const fd = openSync(lockPath, 'wx');
    const holder = JSON.stringify({ pid: process.pid, startMs: Date.now() });
    writeSync(fd, holder);

    const exitCode = await runWakeup({
      homeDir: tmpDir,
      triggerSource: 'scheduled',
      recordLockSkipped: true
    });
    expect(exitCode).toBe(0);

    const sessionLogPath = join(tmpDir, 'session.log');
    expect(existsSync(sessionLogPath)).toBe(false);

    closeSync(fd);
    try {
      rmSync(lockPath);
    } catch {
      // already cleaned up
    }
  });

  it('lock-skipped JSONL record carries correlationId === undefined', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h'
      }),
      'utf8'
    );
    const lockPath = join(tmpDir, 'wakeup.lock');
    const fd = openSync(lockPath, 'wx');
    writeSync(
      fd,
      JSON.stringify({ pid: process.pid, startMs: Date.now() })
    );

    await runWakeup({
      homeDir: tmpDir,
      triggerSource: 'scheduled',
      recordLockSkipped: true
    });

    const log = new InvocationLog(tmpDir);
    const records = await log.read(10);
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record.status).toBe('skipped');
    expect(record.lockAcquired).toBe(false);
    expect(record.correlationId).toBeUndefined();

    closeSync(fd);
    try {
      rmSync(lockPath);
    } catch {
      // ignore
    }
  });
});
