// Feature 014 T017 — unit tests for InvocationLog.
//
// Coverage:
//   - append + read round trip
//   - malformed JSONL lines are silently skipped on read
//   - append rejects records with `cwdInsideWorkspace !== false`
//   - empty log → empty array
//   - rotation triggers when file > 5MB and shifts backups upward
//   - retention drops lines older than 90 days at rotation time

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvocationLog,
  projectWakeUpLogEntries,
  type InvocationRecord
} from '../../../src/wakeup/invocation-log';

function freshRecord(over: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    timestamp: new Date().toISOString(),
    platform: 'darwin',
    pid: 1234,
    lockAcquired: true,
    ephemeralCwd: '/tmp/schegent-primer-session/abc',
    cwdInsideWorkspace: false,
    envScrubbed: true,
    claudeExitCode: 0,
    durationMs: 1500,
    ...over
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schegent-wakeup-log-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('InvocationLog.append + read', () => {
  it('appends a single record and reads it back', async () => {
    const log = new InvocationLog(tempDir);
    const rec = freshRecord();
    await log.append(rec);
    const back = await log.read();
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(rec);
  });

  it('returns [] when no log file exists', async () => {
    const log = new InvocationLog(tempDir);
    expect(await log.read()).toEqual([]);
  });

  it('rejects records with cwdInsideWorkspace !== false', async () => {
    const log = new InvocationLog(tempDir);
    const bad = freshRecord({ cwdInsideWorkspace: true as unknown as false });
    await expect(log.append(bad)).rejects.toThrow(/cwdInsideWorkspace must be literal false/);
  });

  it('skips malformed lines silently on read', async () => {
    const log = new InvocationLog(tempDir);
    await log.append(freshRecord({ pid: 1 }));
    // Inject one malformed line directly into the log file.
    writeFileSync(
      join(tempDir, 'invocations.log'),
      readFileSync(join(tempDir, 'invocations.log'), 'utf8')
        + 'this is not json\n'
        + '{}\n'   // valid JSON but missing required cwdInsideWorkspace
        + JSON.stringify(freshRecord({ pid: 2 })) + '\n',
      'utf8'
    );
    const back = await log.read();
    expect(back.map((r) => r.pid)).toEqual([1, 2]);
  });

  it('honors limit on read', async () => {
    const log = new InvocationLog(tempDir);
    for (let i = 0; i < 5; i++) {
      await log.append(freshRecord({ pid: i + 1 }));
    }
    const r = await log.read(2);
    expect(r.map((x) => x.pid)).toEqual([4, 5]);
  });
});

describe('Wake up log projection', () => {
  it('projects newest five entries with source, status, and raw response', async () => {
    const log = new InvocationLog(tempDir);
    for (let i = 0; i < 6; i++) {
      await log.append(freshRecord({
        timestamp: new Date(Date.UTC(2026, 4, 14, 10, i)).toISOString(),
        pid: i,
        triggerSource: i % 2 === 0 ? 'manual' : 'scheduled',
        rawResponse: `response-${i}`,
        status: i === 2 ? 'skipped' : 'succeeded',
        skipped: i === 2
      }));
    }

    const projection = log.projectRecent((s) => s, 5);
    expect(projection.entries).toHaveLength(5);
    expect(projection.entries.map((e) => e.rawResponse)).toEqual([
      'response-5',
      'response-4',
      'response-3',
      'response-2',
      'response-1'
    ]);
    expect(projection.entries[3]).toMatchObject({
      triggerSource: 'manual',
      status: 'skipped'
    });
  });

  it('derives status and scheduled source for legacy records', () => {
    const rows = projectWakeUpLogEntries(
      [
        freshRecord({ timestamp: '2026-05-14T00:00:00.000Z', claudeExitCode: 0 }),
        freshRecord({
          timestamp: '2026-05-14T00:01:00.000Z',
          lockAcquired: false,
          claudeExitCode: null
        }),
        freshRecord({
          timestamp: '2026-05-14T00:02:00.000Z',
          claudeExitCode: null,
          errorReason: 'claude-watchdog-killed'
        })
      ],
      (s) => s,
      3
    );

    expect(rows.map((r) => [r.triggerSource, r.status])).toEqual([
      ['scheduled', 'timed-out'],
      ['scheduled', 'skipped'],
      ['scheduled', 'succeeded']
    ]);
  });

  it('sanitizes and caps projected raw response text', async () => {
    const log = new InvocationLog(tempDir);
    await log.append(freshRecord({
      rawResponse: `token-secret ${'x'.repeat(5000)}`
    }));

    const projection = log.projectRecent((s) => s.replace('token-secret', '<redacted>'), 1);
    expect(projection.entries[0].rawResponse).toContain('<redacted>');
    expect(projection.entries[0].rawResponse).toContain('[truncated]');
    expect(Buffer.byteLength(projection.entries[0].rawResponse, 'utf8')).toBeLessThanOrEqual(4096);
  });
});

describe('InvocationLog rotation', () => {
  it('rotates when the log exceeds 5 MB', async () => {
    const log = new InvocationLog(tempDir);
    const logPath = join(tempDir, 'invocations.log');
    // Pre-fill the current log past the 5MB cap.
    const filler = JSON.stringify(freshRecord()) + '\n';
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1024, filler);
    writeFileSync(logPath, bytes);
    await log.append(freshRecord({ pid: 9999 }));
    expect(existsSync(join(tempDir, 'invocations.log.1'))).toBe(true);
    expect(statSync(logPath).size).toBeLessThan(5 * 1024 * 1024);
  });

  it('shifts backups upward and drops the oldest', async () => {
    const log = new InvocationLog(tempDir);
    // Pre-populate three backups so rotation must drop .3.
    writeFileSync(join(tempDir, 'invocations.log.1'), 'old1', 'utf8');
    writeFileSync(join(tempDir, 'invocations.log.2'), 'old2', 'utf8');
    writeFileSync(join(tempDir, 'invocations.log.3'), 'old3-will-be-dropped', 'utf8');
    // Force rotation by filling the current log past 5MB.
    const logPath = join(tempDir, 'invocations.log');
    writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024 + 1024, 'a'));
    await log.append(freshRecord({ pid: 1 }));

    expect(readFileSync(join(tempDir, 'invocations.log.2'), 'utf8')).toBe('old1');
    expect(readFileSync(join(tempDir, 'invocations.log.3'), 'utf8')).toBe('old2');
    // .1 is now the freshly rotated (size-bounded) backup, not 'old1'.
    expect(readFileSync(join(tempDir, 'invocations.log.1'), 'utf8')).not.toBe('old1');
  });

  it('drops lines older than 90 days at rotation', async () => {
    const log = new InvocationLog(tempDir);
    const logPath = join(tempDir, 'invocations.log');
    const stale = freshRecord({
      pid: 1,
      timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    });
    const fresh = freshRecord({ pid: 2, timestamp: new Date().toISOString() });
    // Force size beyond cap; mix stale and fresh records.
    const fillerLine = JSON.stringify(stale) + '\n';
    let body = '';
    while (body.length < 5 * 1024 * 1024 + 1024) body += fillerLine;
    body += JSON.stringify(fresh) + '\n';
    writeFileSync(logPath, body, 'utf8');
    await log.append(freshRecord({ pid: 3 }));

    const rotated = readFileSync(join(tempDir, 'invocations.log.1'), 'utf8');
    // Stale lines must have been filtered out; the fresh one remains.
    expect(rotated).toContain('"pid":2');
    expect(rotated).not.toContain('"pid":1');
  });
});
