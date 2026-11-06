import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import {
  RawTranscriptWriter,
  type RawTranscriptCapture
} from '../../../../src/audit/raw-transcript-writer';
import { VerboseDiagnosticWriter } from '../../../../src/audit/verbose-diagnostic-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import { createTransportRouter } from '../../../../src/monitor/transport/transport-router';
import { TransportStoreError, type RunTransportStore } from '../../../../src/monitor/transport/run-transport-store';
import {
  AUDIT_INTEGRITY_CAUSES,
  AUDIT_WRITE_CAUSES,
  EVIDENCE_SINK_NAMES,
  EvidenceHealthMonitor,
  normalizeEvidenceFailureCause
} from '../../../../src/services/evidence-health/evidence-health-monitor';

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

/**
 * FR-R4-F03 (FR-006, FR-009, FR-016, FR-022; contract T14, data-model §6, R8) — the audit sink's causes
 * fall in two classes, and a landed append ends only one of them.
 *
 * A WRITE cause (the disk refused, was full, timed out) clears on the next landed row: nothing is
 * wrong with the history, only with one write. An INTEGRITY cause (a broken link, history shorter than
 * the checkpoint, history missing) is a finding about the history itself, so a landed row, which says
 * nothing about it, must never clear it. Before this, nothing ever reported audit success at all, so
 * one rejected append blocked every Run until the window reloaded.
 */
describe('EvidenceHealthMonitor, audit causes in two classes', () => {
  const at = (): Date => new Date('2026-10-30T00:00:00.000Z');
  const audit = (monitor: EvidenceHealthMonitor) => monitor.getSnapshot().audit;

  it('names the two classes exactly', () => {
    expect(AUDIT_WRITE_CAUSES).toEqual([
      'permission-denied',
      'disk-full',
      'read-only-filesystem',
      'timeout',
      'path-refused',
      'partial-write',
      'io-error'
    ]);
    expect(AUDIT_INTEGRITY_CAUSES).toEqual(['chain-broken', 'history-shorter', 'history-missing']);
  });

  it.each(['chain-broken', 'history-shorter', 'history-missing'])('passes the integrity code %s through normalization unchanged', (code) => {
    expect(normalizeEvidenceFailureCause(code)).toBe(code);
  });

  it('a write cause on a healthy sink makes it unavailable with that cause', () => {
    const monitor = new EvidenceHealthMonitor(at);
    monitor.reportFailure('audit', 'EACCES');
    expect(audit(monitor)).toMatchObject({ status: 'unavailable', cause: 'permission-denied', failureCount: 1 });
  });

  it('a write cause over another write cause replaces it', () => {
    const monitor = new EvidenceHealthMonitor(at);
    monitor.reportFailure('audit', 'EACCES');
    monitor.reportFailure('audit', 'ENOSPC');
    expect(audit(monitor)).toMatchObject({ status: 'unavailable', cause: 'disk-full', failureCount: 2 });
  });

  it('a write cause over an integrity cause keeps the integrity cause and counts the failure', () => {
    const monitor = new EvidenceHealthMonitor(at);
    monitor.reportFailure('audit', 'history-shorter');
    monitor.reportFailure('audit', 'ENOSPC');
    expect(audit(monitor)).toMatchObject({ status: 'unavailable', cause: 'history-shorter', failureCount: 2 });
  });

  it.each(['chain-broken', 'history-shorter', 'history-missing'])(
    'an integrity cause %s makes any state unavailable with that cause',
    (code) => {
      const fromHealthy = new EvidenceHealthMonitor(at);
      fromHealthy.reportFailure('audit', code);
      expect(audit(fromHealthy)).toMatchObject({ status: 'unavailable', cause: code });

      const fromWrite = new EvidenceHealthMonitor(at);
      fromWrite.reportFailure('audit', 'EACCES');
      fromWrite.reportFailure('audit', code);
      expect(audit(fromWrite)).toMatchObject({ status: 'unavailable', cause: code });

      const fromIntegrity = new EvidenceHealthMonitor(at);
      fromIntegrity.reportFailure('audit', 'chain-broken');
      fromIntegrity.reportFailure('audit', code);
      expect(audit(fromIntegrity)).toMatchObject({ status: 'unavailable', cause: code });
    }
  );

  it('a landed append clears a write cause', () => {
    const monitor = new EvidenceHealthMonitor(at);
    monitor.reportFailure('audit', 'ENOSPC');
    monitor.reportSuccess('audit');
    expect(audit(monitor)).toMatchObject({ status: 'healthy', cause: null, failureCount: 0 });
  });

  it.each(['chain-broken', 'history-shorter', 'history-missing'])(
    'a landed append leaves the integrity cause %s unchanged',
    (code) => {
      const monitor = new EvidenceHealthMonitor(at);
      monitor.reportFailure('audit', code);
      monitor.reportSuccess('audit');
      expect(audit(monitor)).toMatchObject({ status: 'unavailable', cause: code, failureCount: 1 });
    }
  );

  it('the reset clears the two history causes and nothing else', () => {
    for (const code of ['history-shorter', 'history-missing']) {
      const monitor = new EvidenceHealthMonitor(at);
      monitor.reportFailure('audit', code);
      monitor.clearAuditIntegrity(['history-shorter', 'history-missing']);
      expect(audit(monitor)).toMatchObject({ status: 'healthy', cause: null });
    }
    const broken = new EvidenceHealthMonitor(at);
    broken.reportFailure('audit', 'chain-broken');
    broken.clearAuditIntegrity(['history-shorter', 'history-missing']);
    expect(audit(broken), 'a broken link is not cleared by the reset').toMatchObject({
      status: 'unavailable',
      cause: 'chain-broken'
    });
    const write = new EvidenceHealthMonitor(at);
    write.reportFailure('audit', 'ENOSPC');
    write.clearAuditIntegrity(['history-shorter', 'history-missing']);
    expect(audit(write), 'a write cause is not an integrity finding').toMatchObject({ cause: 'disk-full' });
  });

  it('an activation reset still clears every audit cause', () => {
    const monitor = new EvidenceHealthMonitor(at);
    monitor.reportFailure('audit', 'history-missing');
    monitor.reset();
    expect(audit(monitor)).toMatchObject({ status: 'healthy', cause: null });
  });
});

describe('FR-R5-F13 — complete evidence sink coverage (auditCheckpoint, transport, verboseDiagnostics)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f13-health-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('enumerates all eight evidence sinks and normalizes containment/checkpoint causes', () => {
    expect(EVIDENCE_SINK_NAMES).toEqual([
      'audit',
      'rawTranscript',
      'runtimeLog',
      'metricsRollup',
      'historyPointer',
      'auditCheckpoint',
      'transport',
      'verboseDiagnostics'
    ]);
    expect(normalizeEvidenceFailureCause('symlink-component')).toBe('path-refused');
    expect(normalizeEvidenceFailureCause('outside-root')).toBe('path-refused');
    expect(normalizeEvidenceFailureCause('stage-not-owned')).toBe('path-refused');
    expect(normalizeEvidenceFailureCause('checkpoint-unavailable')).toBe('checkpoint-unavailable');
    expect(normalizeEvidenceFailureCause('corrupt')).toBe('checkpoint-unavailable');
  });

  it('reports transport sink failures and recovery when enabled, while disabled capture stays healthy', async () => {
    const monitor = new EvidenceHealthMonitor();
    let mode: 'off' | 'on' = 'off';
    let failAppend = true;
    const fakeStore = {
      openDescriptorCount: 0,
      narrowLegacy: async () => undefined,
      stateOf: async () => ({ bytes: 0, oldestMs: null }),
      compact: async () => ({ outcome: 'kept' as const }),
      append: async () => {
        if (failAppend) throw new TransportStoreError('ENOSPC');
      },
      dispose: async () => undefined
    } as unknown as RunTransportStore;

    const router = createTransportRouter({
      workspaceRoot: () => workspaceRoot,
      readSetting: () => mode,
      readRawTranscriptMode: () => 'off',
      readMaxAgeDays: () => 30,
      tempRoot: workspaceRoot,
      runStatus: () => undefined,
      logger: { warn: () => undefined },
      store: fakeStore,
      evidenceHealth: monitor
    });

    await router.route({ runId: 'r1', stream: 'stdout', line: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }, 'hi\n');
    expect(monitor.getSnapshot().transport.status).toBe('healthy');

    mode = 'on';
    await router.route({ runId: 'r1', stream: 'stdout', line: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }, 'hi\n');
    expect(monitor.getSnapshot().transport).toMatchObject({
      status: 'degraded',
      cause: 'disk-full'
    });

    failAppend = false;
    await router.route({ runId: 'r1', stream: 'stdout', line: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }, 'hi\n');
    expect(monitor.getSnapshot().transport).toMatchObject({
      status: 'healthy',
      cause: null
    });
  });

  it('reports verboseDiagnostics sink refusal and recovery when enabled', async () => {
    const monitor = new EvidenceHealthMonitor();
    const segments = ['.schegent', 'sessions', 'r1', 'diagnostics', 'p1', 'ph1', 'iter-1'];
    const directory = path.join(workspaceRoot, ...segments);
    const target = {
      workspaceRoot,
      segments,
      directory,
      debugFile: path.join(directory, 'debug.log'),
      streamFile: path.join(directory, 'stream.jsonl'),
      verboseLogFile: path.join(directory, 'verbose.log')
    };

    const outside = path.join(workspaceRoot, 'outside-dir');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'));

    const refusedWriter = new VerboseDiagnosticWriter(new SanitizedLogger(), monitor);
    await refusedWriter.prepare(target);
    expect(monitor.getSnapshot().verboseDiagnostics).toMatchObject({
      status: 'degraded',
      cause: 'path-refused'
    });

    await fs.rm(path.join(workspaceRoot, '.schegent'), { force: true });
    const healthyWriter = new VerboseDiagnosticWriter(new SanitizedLogger(), monitor);
    await healthyWriter.prepare(target);
    await healthyWriter.teeStream(target, '{"type":"init"}\n');
    expect(monitor.getSnapshot().verboseDiagnostics).toMatchObject({
      status: 'healthy',
      cause: null
    });
  });
});
