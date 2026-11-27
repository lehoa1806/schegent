/**
 * FR-R8-03 (03-02) — Correlated metadata-only diagnostics, OTLP collector lifecycle & egress safety,
 * and disposable audit-chain integrity verification.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { verifyAuditChainAtAsync } from '../../src/audit/audit-chain';
import { createCountsOnlyAuditExport } from '../../src/commands/export-audit';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { UncontainedBackendRefusedError } from '../../src/services/backend-containment-policy';
import { TELEMETRY_EXPORT_BOUNDS, TELEMETRY_SOURCE_SCHEMA } from '../../src/contracts/telemetry-export';
import { SanitizedLogger } from '../../src/lib/logger';
import { ClaudeCliMonitor } from '../../src/monitor/claude-cli-monitor';
import { ZippedStreamBuffer, readStreamPressurePeak, resetStreamPressure } from '../../src/runner/zipped-stream-buffer';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { createTelemetryHostService } from '../../src/services/telemetry-host/telemetry-host-service';
import { collectBundle, probeBundle } from '../../src/services/diagnostics-bundle/bundle-collect';
import { planBundle } from '../../src/services/diagnostics-bundle/bundle-plan';
import {
  checkStrictUsdAdmission,
  createEmptyRootUsageRollup
} from '../../src/services/workflow-execution/control-usage-accounting';

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

function startLoopbackServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${String(addr.port)}/v1/metrics`, port: addr.port });
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv !== undefined) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FR-R8-03 (03-02) metadata-only correlated diagnostics, OTLP lifecycle, and audit integrity', () => {
  it('correlates one (runId, attemptId, reason) across all six diagnostic classes via real PhaseRunner, ClaudeCliMonitor, and counts-only export', async () => {
    resetStreamPressure();
    const workspaceRoot = makeTempDir('schegent-corr-0302-');
    const runtimeLogPath = path.join(workspaceRoot, 'runtime.log');
    const logger = makeFileLogger(runtimeLogPath);
    const auditWriter = new AuditLogWriter({ workspaceRoot }, logger);

    let clockMs = 1_763_985_600_000;
    const monitor = new ClaudeCliMonitor({
      stallThresholdMs: 60_000,
      rateLimitMatchers: [],
      monotonicNow: () => clockMs,
      now: () => new Date(clockMs),
      audit: auditWriter,
      transport: { record: () => undefined },
      activity: { record: () => undefined },
      logger
    });

    const runId = randomUUID();
    let invocationNum = 0;

    // Real PhaseRunner driving a controlled BackendRunner:
    //  - Attempt 1: pre-spawn admission refusal (`UncontainedBackendRefusedError`)
    //  - Attempt 2: qualified child identity + bounded stream high-water mark via ZippedStreamBuffer +
    //               monitor exit -> `monitor-invocation-summary` + contradictory exit & missing usage -> `phase-end`
    const fakeBackend: BackendRunner = {
      hasActiveProcess: false,
      cancelActive: () => false,
      close: () => undefined,
      settleTeardowns: async () => [],
      async invoke(request) {
        invocationNum += 1;
        if (invocationNum === 1) {
          throw new UncontainedBackendRefusedError('codex', 'uncontained-refused');
        }
        expect(request.attemptId).toMatch(/^[0-9a-f-]{36}$/i);

        monitor.onStart(runId, request.phase, 4242);
        monitor.onSpawnPid(runId, 4242, {
          id: 'inv-real-2',
          helperInvocation: false,
          maxDurationMs: null
        });
        monitor.onStdoutChunk(runId, 'line 1\nline 2\n', 'inv-real-2');

        const stdoutBuffer = new ZippedStreamBuffer(64, 512);
        const stderrBuffer = new ZippedStreamBuffer(32, 64);
        stdoutBuffer.append([
          'x'.repeat(600),
          '=== SCHEGENT AUDIT LOG ===',
          'phase: speckit-implement',
          'files_created: []',
          'files_modified: []',
          'files_deleted: []',
          'commands_executed: []',
          'network_calls: ["none"]',
          'ruleset_switches: ["none"]',
          'notes: ok',
          '=== END AUDIT LOG ===',
          '[SCHEGENT_STATUS: CLEAR]'
        ].join('\n'));
        stderrBuffer.append('err\n');
        const highWater = stdoutBuffer.highWaterRetainedBytes + stderrBuffer.highWaterRetainedBytes;
        const observed = stdoutBuffer.totalBytes + stderrBuffer.totalBytes;
        const truncated = stdoutBuffer.truncated || stderrBuffer.truncated;
        stdoutBuffer.finalize();
        stderrBuffer.finalize();

        clockMs += 420;
        monitor.onExit(
          runId,
          {
            exitCode: 1,
            signal: null,
            killed: false,
            timedOut: false,
            ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
            streamHighWaterBytes: highWater,
            streamObservedBytes: observed,
            streamTruncated: truncated
          },
          'inv-real-2'
        );

        return {
          stdoutBuffer,
          stderrBuffer,
          exitCode: 1,
          killed: false,
          timedOut: false,
          durationMs: 420,
          command: 'codex',
          sawTerminalResult: true,
          terminalReconciliation: {
            status: 'contradictory-exit',
            stopReason: 'end_turn',
            processExitCode: 1,
            processSignal: null,
            warningCode: 'acp-contradictory-exit'
          },
          admissionDecision: {
            kind: 'codex',
            executableTarget: 'codex-security',
            resolvedExecutablePath: '/usr/local/bin/codex-security',
            permissionMode: 'unrestricted',
            containmentPosture: 'accepted-uncontained',
            fingerprint: {
              digest: 'a'.repeat(64),
              components: {
                backend: 'codex',
                version: '0.159',
                os: process.platform,
                arch: process.arch,
                mechanism: 'none',
                'environment-policy': 'a'.repeat(64),
                'flag-surface': 'none'
              }
            }
          }
        };
      }
    };

    const phaseRunner = new PhaseRunner({ runner: fakeBackend, promptBuilder: new PromptBuilder(), auditWriter, logger });
    const codexPhaseDef = {
      id: 'speckit-implement',
      name: 'Implement',
      instruction: 'Implement.',
      runner: 'codex' as const,
      hostVerification: 'exit-code' as const
    };

    // 1. Pre-spawn admission refusal through real PhaseRunner -> emits phase-start + phase-end(cause=pre_spawn_refusal)
    await expect(
      phaseRunner.run({
        phase: 'speckit-implement',
        phaseDef: codexPhaseDef,
        iteration: 1,
        iterationCap: 3,
        featureDescription: 'correlated diagnostics drill',
        featureDir: null,
        cliPath: 'codex',
        cwd: workspaceRoot,
        timeoutMs: 30_000,
        runId
      })
    ).rejects.toThrow(/uncontained/i);

    // 2–5. Real PhaseRunner invocation emitting cli-invocation, monitor-invocation-summary, and phase-end
    const runResult = await phaseRunner.run({
      phase: 'speckit-implement',
      phaseDef: codexPhaseDef,
      iteration: 2,
      iterationCap: 3,
      featureDescription: 'correlated diagnostics drill',
      featureDir: null,
      cliPath: 'codex',
      cwd: workspaceRoot,
      timeoutMs: 30_000,
      runId
    });
    expect(runResult.outcome).toBe('failed');
    expect(readStreamPressurePeak()).toBeGreaterThanOrEqual(64);

    // Missing usage -> strict-usd refusal confirmed alongside
    const budgetDecision = checkStrictUsdAdmission({
      rootBudget: {
        version: 1,
        budgetMode: 'strict-usd',
        maxPhaseAttempts: 10,
        maxMicrousd: 5_000_000
      },
      rollup: {
        ...createEmptyRootUsageRollup(),
        unpricedAttemptCount: 1
      }
    });
    expect(budgetDecision).toMatchObject({ allowed: false, pauseReason: 'spend-unverifiable' });

    // Wait briefly for monitor's fire-and-forget audit append to flush to disk
    await new Promise((resolve) => setTimeout(resolve, 50));

    const auditLogRaw = fs.readFileSync(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
    const rawAuditLines = auditLogRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; runId: string; eventType: string; iteration: number; payload: Record<string, unknown> });

    const runRows = rawAuditLines.filter((r) => r.runId === runId);
    const attempt1Start = runRows.find((r) => r.eventType === 'phase-start' && r.iteration === 1);
    const attempt2Start = runRows.find((r) => r.eventType === 'phase-start' && r.iteration === 2);
    expect(attempt1Start).toBeDefined();
    expect(attempt2Start).toBeDefined();
    const attempt1Id = attempt1Start!.id;
    const attempt2Id = attempt2Start!.id;

    // 6. Recovery decision logged with runId + attemptId + reason and next step (metadata-only)
    logger.warn('recovery decision: uncertain external effect; operator must inspect workspace and resume or cancel', {
      runId,
      attemptId: attempt2Id,
      reason: 'recovery-uncertain-effect',
      nextAction: 'inspect-and-resume-or-cancel'
    });

    const refusalRow = runRows.find((r) => r.eventType === 'phase-end' && r.payload.attemptId === attempt1Id);
    const childRow = runRows.find((r) => r.eventType === 'cli-invocation' && r.payload.attemptId === attempt2Id);
    const streamRow = runRows.find((r) => r.eventType === 'monitor-invocation-summary' && r.payload.attemptId === attempt2Id);
    const endRow = runRows.find((r) => r.eventType === 'phase-end' && r.payload.attemptId === attempt2Id);

    expect(refusalRow?.payload.cause).toBe('pre_spawn_refusal');
    expect(childRow?.payload).toMatchObject({
      runner: 'codex',
      executableTarget: 'codex-security',
      containmentPosture: 'accepted-uncontained',
      permissionMode: 'unrestricted',
      attemptId: attempt2Id
    });
    expect(streamRow?.payload).toMatchObject({
      attemptId: attempt2Id,
      streamHighWaterBytes: 516,
      streamTruncated: true
    });
    expect(Number(streamRow?.payload.streamObservedBytes)).toBeGreaterThan(600);
    expect(endRow?.payload).toMatchObject({
      attemptId: attempt2Id,
      verdictBasis: 'exit-code',
      exitCode: 1,
      warnings: expect.arrayContaining(['acp-contradictory-exit', 'output-truncated-unclassifiable'])
    });
    expect((endRow?.payload.metrics as Record<string, number>).totalCostUsd).toBeUndefined();
    expect((endRow?.payload.metrics as Record<string, number>).streamHighWaterBytes).toBe(516);
    expect((endRow?.payload.metrics as Record<string, number>).streamObservedBytes).toBe(
      Number(streamRow?.payload.streamObservedBytes)
    );

    // Counts-only audit export preserves attemptId on phase-end, cli-invocation, and monitor-invocation-summary without false tamper nulls
    const exportedRows = createCountsOnlyAuditExport(auditLogRaw)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
    expect(exportedRows.find((r) => r.eventType === 'cli-invocation')?.payload.attemptId).toBe(attempt2Id);
    expect(exportedRows.find((r) => r.eventType === 'monitor-invocation-summary')?.payload.attemptId).toBe(attempt2Id);
    expect(exportedRows.filter((r) => r.eventType === 'phase-end').map((r) => r.payload.attemptId)).toEqual(
      expect.arrayContaining([attempt1Id, attempt2Id])
    );

    monitor.dispose();

    // Collect metadata-only diagnostics bundle (no raw transcript / transport selected)
    const bundleSources = {
      workspaceRoot,
      sanitize: (s: string) => logger.sanitize(s),
      sanitizeRecord: <T extends Record<string, unknown>>(r: T): T => r,
      hostVersion: '0.2.0',
      hostBuild: { commit: 'a'.repeat(40), dirty: false, mode: 'development' as const },
      hostSettings: () => ({ rawTranscriptMode: 'off' }),
      runStatus: () => ({ runId, status: 'paused', manualPauseCause: 'recovery-uncertain-effect' }),
      runtimeLog: () => ({ path: runtimeLogPath, maxGenerations: 2 })
    };
    const probes = await probeBundle(bundleSources, runId);
    const plan = planBundle(probes, false);
    const items = await collectBundle(bundleSources, runId, plan);
    const runtimeItem = items.find((i) => i.item === 'runtime-log');
    const statusItem = items.find((i) => i.item === 'run-status');
    const auditItem = items.find((i) => i.item === 'audit-rows');

    expect(statusItem?.content).toContain('recovery-uncertain-effect');
    expect(runtimeItem?.content).toContain(attempt2Id);
    expect(runtimeItem?.content).toContain('inspect-and-resume-or-cancel');
    expect(auditItem?.content).toContain(attempt1Id);
    expect(auditItem?.content).toContain(attempt2Id);
    expect(auditItem?.content).not.toContain(workspaceRoot);
  });

  it('exercises OTLP collector disabled, unreachable (bounded redacted spool), recovered (replay+ack), and refuses unapproved destinations and 3xx redirects', async () => {
    const dir = makeTempDir('schegent-otlp-0302-');
    const dbPath = path.join(dir, 'schegent-state.db');
    const storageRoot = path.join(dir, 'storage');
    fs.mkdirSync(storageRoot, { recursive: true });
    const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

    const receivedAtCollector: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const receivedAtRedirectTrap: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    let collectorMode: '503' | '200' = '503';

    const collector = await startLoopbackServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedAtCollector.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (collectorMode === '503') {
          res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '120' });
          res.end('{}');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }
      });
    });

    const redirectTrap = await startLoopbackServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedAtRedirectTrap.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200);
        res.end('{}');
      });
    });

    const redirector = await startLoopbackServer((_req, res) => {
      res.writeHead(302, { location: redirectTrap.url });
      res.end();
    });

    const secretToken = 'Bearer synthetic-otlp-credential-0302';
    const host = createTelemetryHostService({
      sqliteStore,
      storageRoot,
      secrets: {
        availability: () => 'available',
        read: async (ref) => (ref === 'otlp-token' ? secretToken : null)
      },
      isWorkspaceTrusted: () => true,
      serviceVersion: '0.2.0'
    });

    try {
      // 1. Disabled: zero network calls, zero spool directories
      const disabledEval = host.configureFromUserSettings({
        enabled: false,
        endpoint: collector.url,
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: '',
        contentPolicy: 'metadata-only'
      });
      expect(disabledEval.kind).toBe('disabled');
      expect(fs.existsSync(path.join(storageRoot, 'telemetry-spool'))).toBe(false);
      expect(receivedAtCollector).toHaveLength(0);

      // 2. Unapproved destinations refused before any network I/O or credential read
      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint: 'http://collector.example.invalid/v1/metrics',
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: '',
          contentPolicy: 'metadata-only'
        })
      ).toMatchObject({ kind: 'refused', reason: 'plaintext-not-loopback' });

      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint: collector.url,
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: '',
          contentPolicy: 'content'
        })
      ).toMatchObject({ kind: 'refused', reason: 'content-export-unsupported' });

      expect(
        host.configureFromRawProfiles([
          {
            id: 'ws-profile',
            revision: 1,
            enabled: true,
            scope: 'workspace',
            protocol: 'otlp-http-json',
            signals: ['metrics'],
            contentPolicy: 'metadata-only',
            endpoint: collector.url,
            allowPlaintextLoopback: true,
            credential: null
          }
        ])
      ).toMatchObject({ kind: 'refused', reason: 'scope-not-authorized' });

      // 3. HTTP 3xx redirect receives neither metrics nor credentials on the redirected target
      const redirEval = host.configureFromUserSettings({
        enabled: true,
        endpoint: redirector.url,
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        contentPolicy: 'metadata-only',
        credentialSecretKey: 'otlp-token',
        credentialHeaderName: 'authorization'
      });
      expect(redirEval.kind).toBe('authorized');
      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'op-redir-1',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-6',
          modelReported: 'claude-sonnet-4-6',
          durationMs: 250,
          outcome: 'succeeded'
        }
      ]);
      host.flush();
      await host.idle();
      expect(receivedAtRedirectTrap).toHaveLength(0);
      expect(host.getStatus().health.dropReasons['redirect-refused']).toBeGreaterThanOrEqual(1);

      // 4. Collector unreachable (503 + Retry-After exceeding 30s retry budget -> immediate retry-budget-exhausted -> spooled)
      collectorMode = '503';
      const authEval = host.configureFromUserSettings({
        enabled: true,
        endpoint: collector.url,
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        contentPolicy: 'metadata-only',
        credentialSecretKey: 'otlp-token',
        credentialHeaderName: 'authorization'
      });
      expect(authEval.kind).toBe('authorized');
      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'usage',
          sourceId: 'usage-spool-1',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-6',
          modelReported: '/Users/secret/path/should-not-leak',
          measures: [
            {
              measure: 'input_tokens',
              unit: 'count',
              quantity: '1200',
              completeness: 'known',
              provenance: 'provider-reported',
              cacheRelation: null
            }
          ]
        }
      ]);
      host.flush();
      await host.idle();

      const statusWhileDown = host.getStatus();
      expect(statusWhileDown.spooledBatches).toBe(1);
      expect(statusWhileDown.spooledBytes).toBeGreaterThan(0);
      expect(statusWhileDown.spooledBytes).toBeLessThanOrEqual(TELEMETRY_EXPORT_BOUNDS.diskSpoolBytes);

      // Inspect spooled file on disk: strictly metadata-only, path-excluded, zero credentials
      const spoolDir = path.join(storageRoot, 'telemetry-spool');
      const spoolFiles = fs.readdirSync(spoolDir);
      expect(spoolFiles.length).toBeGreaterThanOrEqual(1);
      const spooledText = fs.readFileSync(path.join(spoolDir, spoolFiles[0]!), 'utf8');
      expect(spooledText).not.toContain('/Users/secret/path');
      expect(spooledText).not.toContain(secretToken);
      expect(spooledText).not.toContain('usage-spool-1');
      expect(spooledText).toContain('gen_ai.client.token.usage');

      // 5. Collector recovers (200 OK) -> reconcileAndReplaySpool replays and acknowledges
      collectorMode = '200';
      const replay = await host.reconcileAndReplaySpool();
      expect(replay.replayed).toBe(1);
      expect(replay.acknowledged).toBe(1);
      expect(host.getStatus().spooledBatches).toBe(0);
      const lastAck = receivedAtCollector.at(-1);
      expect(lastAck?.headers.authorization).toBe(secretToken);
      expect(lastAck?.body).toContain('gen_ai.client.token.usage');
      expect(lastAck?.body).not.toContain('/Users/secret/path');
    } finally {
      await host.shutdown();
      sqliteStore.close();
    }
  });

  it('verifies audit chain integrity on clean, tampered, and torn-tail disposable logs', async () => {
    const dir = makeTempDir('schegent-audit-chain-0302-');
    const logger = new SanitizedLogger([]);
    const writer = new AuditLogWriter({ workspaceRoot: dir }, logger);
    const runId = randomUUID();

    await writer.append({
      runId,
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'phase-start',
      outcome: 'info',
      payload: { phaseId: 'speckit-plan' }
    });
    await writer.append({
      runId,
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'phase-end',
      outcome: 'success',
      payload: { outcome: 'clean', exitCode: 0, terminationReason: 'completed' }
    });

    const auditDir = path.join(dir, '.schegent');
    const auditFile = path.join(auditDir, 'audit.log');

    const cleanCheck = await verifyAuditChainAtAsync(auditDir);
    expect(cleanCheck?.verdict.ok).toBe(true);
    if (cleanCheck?.verdict.ok) {
      expect(cleanCheck.verdict.entries).toBe(2);
    }

    // 1. Torn final line (simulated mid-write power loss)
    const originalBytes = fs.readFileSync(auditFile, 'utf8');
    fs.writeFileSync(auditFile, `${originalBytes}{"id":"truncated-torn-tail`, 'utf8');
    const tornCheck = await verifyAuditChainAtAsync(auditDir);
    expect(tornCheck?.verdict.ok).toBe(false);
    if (tornCheck && !tornCheck.verdict.ok) {
      expect(tornCheck.verdict.reason).toBe('malformed');
      expect(tornCheck.verdict.atEntry).toBe(3);
    }

    // 2. Mid-chain byte tamper (edited payload on line 1 breaks line 2's prevDigest)
    const tampered = originalBytes.replace('"speckit-plan"', '"speckit-tamper"');
    fs.writeFileSync(auditFile, tampered, 'utf8');
    const tamperCheck = await verifyAuditChainAtAsync(auditDir);
    expect(tamperCheck?.verdict.ok).toBe(false);
    if (tamperCheck && !tamperCheck.verdict.ok) {
      expect(tamperCheck.verdict.reason).toBe('broken-link');
      expect(tamperCheck.verdict.atEntry).toBe(2);
    }
  });
});
