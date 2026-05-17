// Feature 031 T043 — unit tests for the session-log writer's
// missing-file / missing-directory creation behavior.
//
// Coverage:
//   (a) When `session.log` does not exist, `appendBlock` creates it and any
//       missing parent directories under the wake-up home directory, and
//       the block is at the head of the new file.
//   (b) When `<wakeup home>/` does not exist, the directory is created with
//       `recursive: true`.
//   (c) When the wakeup-home parent itself is unwritable, the append falls
//       through to `session-log-write-failed:eacces` without crashing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBlock } from '../../../src/wakeup/session-log-writer';

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ISO = '2026-05-16T04:00:00.000Z';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-log-writer-missing-'));
});

afterEach(() => {
  // Best-effort cleanup; some tests set the dir 0o000 so chmod first.
  try {
    chmodSync(tmpDir, 0o755);
  } catch {
    // ignore
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Feature 031 T043 — session-log-writer missing-file/dir creation', () => {
  it('creates session.log when it does not exist', async () => {
    const sessionLogPath = join(tmpDir, 'session.log');
    expect(existsSync(sessionLogPath)).toBe(false);

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: ISO,
        correlationId: ID_A,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: hello\n'
    });

    expect(result.outcome).toBe('appended');
    expect(existsSync(sessionLogPath)).toBe(true);
    const content = readFileSync(sessionLogPath, 'utf8');
    expect(content.startsWith(`=== wakeup-block ${ISO} id=${ID_A}`)).toBe(true);
  });

  it('creates the missing wakeup home directory recursively', async () => {
    const homeDir = join(tmpDir, 'wakeup');
    const sessionLogPath = join(homeDir, 'session.log');
    expect(existsSync(homeDir)).toBe(false);

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: ISO,
        correlationId: ID_A,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: ok\n'
    });

    expect(result.outcome).toBe('appended');
    expect(existsSync(homeDir)).toBe(true);
    expect(existsSync(sessionLogPath)).toBe(true);
  });

  it('creates nested missing parent directories recursively', async () => {
    const sessionLogPath = join(tmpDir, 'a', 'b', 'c', 'session.log');
    expect(existsSync(join(tmpDir, 'a'))).toBe(false);

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: ISO,
        correlationId: ID_A,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: nested\n'
    });

    expect(result.outcome).toBe('appended');
    expect(existsSync(sessionLogPath)).toBe(true);
  });

  // POSIX-only: chmod-based unwritable test. On Win32 mode bits are
  // advisory and this assertion does not exercise EACCES — skip there.
  const itPosix = process.platform === 'win32' ? it.skip : it;
  itPosix('returns session-log-write-failed:eacces when the parent dir is unwritable', async () => {
    const homeDir = join(tmpDir, 'wakeup-locked');
    mkdirSync(homeDir, { recursive: true });
    chmodSync(homeDir, 0o000);

    const sessionLogPath = join(homeDir, 'session.log');
    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: ISO,
        correlationId: ID_A,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: blocked\n'
    });

    expect(result.outcome).toBe('write-failed');
    if (result.outcome !== 'write-failed') return;
    // Permitted canonicalized reasons under a locked parent dir on POSIX
    // are EACCES / EPERM (depending on the underlying syscall that fails
    // first — open() vs mkdir()). Either is acceptable; both are non-
    // crashing flows for the operator.
    expect(result.reason).toMatch(/^session-log-write-failed:(eacces|eperm)$/);

    chmodSync(homeDir, 0o755);
  });
});
