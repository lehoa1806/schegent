import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { ClaudeCliRunner, type SpawnFn } from '../../src/runner/claude-cli';
import { MAX_STREAM_BUFFER_BYTES } from '../../src/runner/zipped-stream-buffer';
import { readIterationManifest } from '../../src/services/phase-log/phase-log-reader';
import { SessionArtifactRetentionService } from '../../src/services/session-retention/session-artifact-retention-service';

const configuredRecordCount = Number.parseInt(
  process.env.SCHEGENT_SUSTAINED_RECORD_COUNT ?? '',
  10
);
const RECORD_COUNT = Number.isSafeInteger(configuredRecordCount) && configuredRecordCount >= 4_600
  ? Math.min(configuredRecordCount, 100_000)
  : 4_600;
const PAYLOAD_BYTES = 1_024;
const MAX_PHASE_LOG_ENTRIES = 200;
const PHASE_LOG_ROWS = 10_000;

function streamPayload(stream: 'stdout' | 'stderr'): string {
  const body = stream === 'stdout' ? 'x' : 'y';
  const suffix = stream === 'stdout' ? '🙂' : '漢';
  let output = '🙂\n';
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    output += `${stream}:${String(index).padStart(6, '0')}:${body.repeat(PAYLOAD_BYTES)}:${suffix}\n`;
  }
  if (stream === 'stdout') {
    output += `${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`;
  }
  return output;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function transcriptStreams(contents: string): { stdout: string; stderr: string } {
  const stdoutMarker = '[STDOUT]\n';
  const stderrMarker = '\n\n[STDERR]\n';
  const exitMarker = '\n\n[EXIT_CODE]:';
  const stdoutStart = contents.indexOf(stdoutMarker) + stdoutMarker.length;
  const stderrStart = contents.indexOf(stderrMarker, stdoutStart) + stderrMarker.length;
  const exitStart = contents.indexOf(exitMarker, stderrStart);
  if (stdoutStart < stdoutMarker.length || stderrStart < stderrMarker.length || exitStart < 0) {
    throw new Error('raw transcript framing is incomplete');
  }
  return {
    stdout: contents.slice(stdoutStart, stderrStart - stderrMarker.length),
    stderr: contents.slice(stderrStart, exitStart)
  };
}

describe('sustained execution evidence path', () => {
  let workspaceRoot: string;
  let spoolRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sustained-'));
    spoolRoot = path.join(workspaceRoot, 'os-temp');
    await fs.mkdir(spoolRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it(`keeps parser memory bounded while ${RECORD_COUNT} raw rows per stream remain complete`, async () => {
    const fixturePath = path.resolve('tests/fixtures/high-volume-cli.mjs');
    const spawnFixture: SpawnFn = (_command, _args, options) =>
      spawn(
        process.execPath,
        [fixturePath, String(RECORD_COUNT), String(PAYLOAD_BYTES)],
        options
      ) as ChildProcess;
    const transcript = new RawTranscriptWriter(
      workspaceRoot,
      new SanitizedLogger(),
      spoolRoot
    );
    const runId = 'sustained-run';
    await transcript.appendStart({
      runId,
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'deterministic sustained evidence fixture'
    });
    const capture = await transcript.createInvocationCapture(runId);
    expect(capture).not.toBeNull();

    const output = await new ClaudeCliRunner(spawnFixture).invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'run sustained fixture',
      timeoutMs: 30_000,
      cliPath: process.execPath,
      cwd: workspaceRoot,
      inheritProcessEnv: false
    }, capture ?? undefined);
    await transcript.appendEnd({
      runId,
      stdout: output.stdoutBuffer,
      stderr: output.stderrBuffer,
      exitCode: output.exitCode,
      killed: output.killed,
      timedOut: output.timedOut,
      capture
    });

    const expectedStdout = streamPayload('stdout');
    const expectedStderr = streamPayload('stderr');
    expect(output.stdoutBuffer.truncated).toBe(true);
    expect(output.stderrBuffer.truncated).toBe(true);
    expect(output.stdoutBuffer.retainedBytes).toBeLessThanOrEqual(MAX_STREAM_BUFFER_BYTES);
    expect(output.stderrBuffer.retainedBytes).toBeLessThanOrEqual(MAX_STREAM_BUFFER_BYTES);
    expect(output.stdoutBuffer.totalBytes).toBe(Buffer.byteLength(expectedStdout));
    expect(output.stderrBuffer.totalBytes).toBe(Buffer.byteLength(expectedStderr));

    const rawPath = path.join(
      workspaceRoot,
      '.schegent',
      'sessions',
      `raw-${runId}.log`
    );
    const raw = transcriptStreams(await fs.readFile(rawPath, 'utf8'));
    expect(sha256(raw.stdout)).toBe(sha256(expectedStdout));
    expect(sha256(raw.stderr)).toBe(sha256(expectedStderr));
    expect(await fs.readdir(spoolRoot)).toEqual([]);
    const rawStat = await fs.stat(rawPath);
    expect(rawStat.mode & 0o077).toBe(0);

    // Simulate an extension-host restart with a spool left by a dead owner.
    const abandoned = await fs.mkdtemp(
      path.join(spoolRoot, 'schegent-raw-spool-2147483647-')
    );
    await fs.writeFile(path.join(abandoned, 'stdout'), 'abandoned-unredacted-bytes');
    const restartedWriter = new RawTranscriptWriter(
      workspaceRoot,
      new SanitizedLogger(),
      spoolRoot
    );
    const restartedCapture = await restartedWriter.createInvocationCapture('restart-check');
    expect(restartedCapture).not.toBeNull();
    await expect(fs.access(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    await restartedCapture?.dispose();
    expect(await fs.readdir(spoolRoot)).toEqual([]);

    // The same profile closes with enforced disk bounds once the run is inactive.
    const retention = new SessionArtifactRetentionService({
      workspaceRoot,
      policy: () => ({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxBytes: 1 }),
      logger: new SanitizedLogger()
    });
    const retentionResult = await retention.sweep();
    expect(retentionResult.totalBytes).toBeLessThanOrEqual(1);
    expect(retentionResult.removedArtifactCount).toBe(1);

    const report = {
      recordCount: RECORD_COUNT,
      totalEmittedBytes:
        output.stdoutBuffer.totalBytes + output.stderrBuffer.totalBytes,
      retainedParserBytes:
        output.stdoutBuffer.retainedBytes + output.stderrBuffer.retainedBytes,
      rawTranscriptBytes: rawStat.size,
      retainedSessionBytes: retentionResult.totalBytes,
      orphanedSpools: (await fs.readdir(spoolRoot)).length,
      restartRecovery: 'passed'
    };
    console.info(`[sustained-evidence] ${JSON.stringify(report)}`);
    const reportPath = process.env.SCHEGENT_SOAK_REPORT;
    if (reportPath) {
      const absoluteReportPath = path.resolve(reportPath);
      await fs.mkdir(path.dirname(absoluteReportPath), { recursive: true });
      await fs.writeFile(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  }, 30_000);

  it('caps a large phase-log hydration while preserving the newest ordered rows', async () => {
    const streamPath = path.join(
      workspaceRoot,
      '.schegent',
      'sessions',
      'run-large-log',
      'diagnostics',
      'pipeline',
      'phase',
      'iter-1',
      'stream.jsonl'
    );
    const rows = Array.from({ length: PHASE_LOG_ROWS }, (_, index) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `ordered-row-${index}` }] }
      })
    );
    await fs.mkdir(path.dirname(streamPath), { recursive: true });
    await fs.writeFile(streamPath, `${rows.join('\n')}\n`, 'utf8');

    const manifest = await readIterationManifest({
      workspaceRoot,
      selection: {
        queueId: 'queue',
        taskId: 'run-large-log',
        pipelineId: 'pipeline',
        phaseId: 'phase',
        iterationN: 1
      },
      isInFlight: false,
      caps: { perFieldBytes: 4_096, maxEntries: MAX_PHASE_LOG_ENTRIES },
      sanitize: (value) => value
    });

    expect(manifest.entries).toHaveLength(MAX_PHASE_LOG_ENTRIES);
    expect(manifest.entries[0]).toMatchObject({
      kind: 'truncated-head',
      body: { droppedEntryCount: PHASE_LOG_ROWS - MAX_PHASE_LOG_ENTRIES + 1 }
    });
    expect(manifest.entries.at(-1)?.body.text).toBe(
      `ordered-row-${PHASE_LOG_ROWS - 1}`
    );
    expect(manifest.entries.map((entry) => entry.seq)).toEqual(
      Array.from({ length: MAX_PHASE_LOG_ENTRIES }, (_, index) => index)
    );
  });

  it.each([
    ['clean', { exitCode: 0, killed: false, timedOut: false }],
    ['fatal', { exitCode: 17, killed: false, timedOut: false }],
    ['timeout', { exitCode: null, killed: true, timedOut: true }],
    ['cancel', { exitCode: null, killed: true, timedOut: false }]
  ] as const)('terminates the deterministic %s fixture with explicit flags', async (
    scenario,
    expected
  ) => {
    const fixturePath = path.resolve('tests/fixtures/high-volume-cli.mjs');
    const spawnFixture: SpawnFn = (_command, _args, options) =>
      spawn(process.execPath, [fixturePath, '32', '64', scenario], options) as ChildProcess;
    const cancellation = new AbortController();
    const invocation = new ClaudeCliRunner(spawnFixture).invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: `run ${scenario} fixture`,
      timeoutMs: scenario === 'timeout' ? 100 : 5_000,
      cliPath: process.execPath,
      cwd: workspaceRoot,
      inheritProcessEnv: false,
      cancellationSignal: cancellation.signal
    });
    if (scenario === 'cancel') {
      setTimeout(() => cancellation.abort(), 100);
    }

    const output = await invocation;

    expect(output).toMatchObject(expected);
  }, 10_000);
});
