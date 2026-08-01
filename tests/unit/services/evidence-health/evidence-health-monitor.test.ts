import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import {
  RawTranscriptWriter,
  type RawTranscriptCapture
} from '../../../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import { EvidenceHealthMonitor } from '../../../../src/services/evidence-health/evidence-health-monitor';

describe('EvidenceHealthMonitor', () => {
  it('models sink policies independently and coalesces repeated causes', () => {
    const monitor = new EvidenceHealthMonitor(() => new Date('2026-08-01T00:00:00.000Z'));

    expect(monitor.getSnapshot()).toMatchObject({
      overall: 'healthy',
      audit: { status: 'healthy', continuationPolicy: 'fail-closed' },
      rawTranscript: { status: 'healthy', continuationPolicy: 'continue-degraded' },
      runtimeLog: { status: 'healthy', continuationPolicy: 'continue-degraded' }
    });

    expect(monitor.reportFailure('rawTranscript', 'ENOSPC')).toBe(true);
    expect(monitor.reportFailure('rawTranscript', 'ENOSPC')).toBe(false);
    expect(monitor.getSnapshot()).toMatchObject({
      overall: 'degraded',
      rawTranscript: {
        status: 'degraded',
        cause: 'disk-full',
        failureCount: 2
      }
    });

    expect(monitor.reportFailure('audit', 'EACCES')).toBe(true);
    expect(monitor.getSnapshot()).toMatchObject({
      overall: 'unavailable',
      audit: { status: 'unavailable', cause: 'permission-denied' }
    });
  });

  it('never projects exception text, paths, or secret-like causes', () => {
    const monitor = new EvidenceHealthMonitor();
    monitor.reportFailure('runtimeLog', '/private/workspace TOKEN=secret-value');

    expect(monitor.getSnapshot().runtimeLog.cause).toBe('io-error');
    expect(JSON.stringify(monitor.getSnapshot())).not.toContain('/private/workspace');
    expect(JSON.stringify(monitor.getSnapshot())).not.toContain('secret-value');
  });

  it.each([
    ['EACCES', 'permission-denied'],
    ['ENOSPC', 'disk-full'],
    ['stream-error', 'stream-error'],
    ['cleanup-failed', 'cleanup-failed']
  ] as const)('projects injected %s failures as bounded cause %s', (cause, expected) => {
    const monitor = new EvidenceHealthMonitor();

    monitor.reportFailure('rawTranscript', cause);

    expect(monitor.getSnapshot().rawTranscript).toMatchObject({
      status: 'degraded',
      cause: expected
    });
  });
});

describe('evidence sink fault integration', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-evidence-health-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('marks structured audit unavailable when the durable append fails', async () => {
    await fs.writeFile(path.join(workspaceRoot, '.schegent'), 'not-a-directory');
    const monitor = new EvidenceHealthMonitor();
    const writer = new AuditLogWriter(
      { workspaceRoot },
      new SanitizedLogger(),
      monitor
    );

    await expect(writer.append({
      runId: 'run-audit-failure',
      phase: 'done',
      iteration: 0,
      eventType: 'error',
      outcome: 'failure',
      payload: {}
    })).rejects.toThrow();

    expect(monitor.getSnapshot()).toMatchObject({
      overall: 'unavailable',
      audit: { status: 'unavailable', continuationPolicy: 'fail-closed' }
    });
  });

  it('marks runtime evidence degraded on ENOSPC and suppresses repeat warnings', async () => {
    const monitor = new EvidenceHealthMonitor();
    const logger = new SanitizedLogger();
    const warn = vi.spyOn(logger, 'warn');
    const diskFull = Object.assign(new Error('secret path'), { code: 'ENOSPC' });
    const sink = new RuntimeLogSink({
      accessor: {
        read: () => ({
          level: 'INFO',
          path: path.join(workspaceRoot, 'runtime.log'),
          maxBytes: 1024,
          maxGenerations: 1
        })
      },
      fallbackLogger: logger,
      evidenceHealth: monitor,
      stat: async () => ({ size: 0 }),
      appendFile: vi.fn().mockRejectedValue(diskFull)
    });

    sink.appendLine('[2026-08-01T00:00:00.000Z] INFO first');
    sink.appendLine('[2026-08-01T00:00:01.000Z] INFO second');
    await sink.flushPendingWrites();

    expect(monitor.getSnapshot()).toMatchObject({
      overall: 'degraded',
      runtimeLog: { status: 'degraded', cause: 'disk-full' }
    });
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('runtime-log-sink')))
      .toHaveLength(1);
  });

  it('marks raw evidence degraded when a partial spool copy falls back', async () => {
    const monitor = new EvidenceHealthMonitor();
    const writer = new RawTranscriptWriter(
      workspaceRoot,
      new SanitizedLogger(),
      undefined,
      monitor
    );
    await writer.appendStart({
      runId: 'run-partial',
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'work'
    });
    const capture: RawTranscriptCapture = {
      failed: false,
      write: () => true,
      onceDrain: (_stream, callback) => callback(),
      finish: async () => undefined,
      appendStreamTo: async (stream, destination) => {
        if (stream === 'stdout') {
          await destination.write('partial');
          throw Object.assign(new Error('stream broke'), { code: 'EIO' });
        }
      },
      dispose: async () => undefined
    };

    await writer.appendEnd({
      runId: 'run-partial',
      stdout: 'bounded-fallback',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      capture
    });

    expect(monitor.getSnapshot()).toMatchObject({
      overall: 'degraded',
      rawTranscript: { status: 'degraded', cause: 'partial-write' }
    });
  });

  it('marks raw evidence degraded when spool cleanup fails', async () => {
    const monitor = new EvidenceHealthMonitor();
    const writer = new RawTranscriptWriter(
      workspaceRoot,
      new SanitizedLogger(),
      undefined,
      monitor
    );
    await writer.appendStart({
      runId: 'run-cleanup',
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'work'
    });
    const capture: RawTranscriptCapture = {
      failed: false,
      write: () => true,
      onceDrain: (_stream, callback) => callback(),
      finish: async () => undefined,
      appendStreamTo: async () => undefined,
      dispose: async () => {
        throw new Error('/private/workspace cleanup detail');
      }
    };

    await writer.appendEnd({
      runId: 'run-cleanup',
      stdout: '',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      capture
    });

    expect(monitor.getSnapshot().rawTranscript).toMatchObject({
      status: 'degraded',
      cause: 'cleanup-failed'
    });
    expect(JSON.stringify(monitor.getSnapshot())).not.toContain('/private/workspace');
  });
});
