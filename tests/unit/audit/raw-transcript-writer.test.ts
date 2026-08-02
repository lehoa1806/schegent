import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  RawTranscriptWriter,
  type RawTranscriptCapture
} from '../../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';

let workspaceRoot: string;
let logger: SanitizedLogger;
let warnSpy: MockInstance<(message: string, context?: Record<string, unknown>) => void>;
let writer: RawTranscriptWriter;

async function readLog(runId: string): Promise<string> {
  return fs.readFile(
    path.join(workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`),
    'utf8'
  );
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-tx-'));
  logger = new SanitizedLogger();
  warnSpy = vi.spyOn(logger, 'warn');
  writer = new RawTranscriptWriter(workspaceRoot, logger);
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  warnSpy.mockRestore();
});

describe('RawTranscriptWriter happy path (T005, US1)', () => {
  it('writes a complete SESSION block with header + all four sections', async () => {
    await writer.appendStart({
      runId: 'abc',
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hello prompt'
    });
    await writer.appendEnd({
      runId: 'abc',
      stdout: 'hello stdout',
      stderr: 'hello stderr',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    const contents = await readLog('abc');

    expect(contents).toContain('========== SESSION START ==========');
    expect(contents).toContain('Run ID: abc');
    expect(contents).toContain('Phase: speckit-specify');
    expect(contents).toContain('Iteration: 1');
    expect(contents).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/);
    expect(contents).toContain('[PROMPT]');
    expect(contents).toContain('hello prompt');
    expect(contents).toContain('[STDOUT]');
    expect(contents).toContain('hello stdout');
    expect(contents).toContain('[STDERR]');
    expect(contents).toContain('hello stderr');
    expect(contents).toContain('[EXIT_CODE]: 0');
    expect(contents).toContain('========== SESSION END ==========');
  });

  it('creates a local .schegent/.gitignore for transcript privacy defense-in-depth', async () => {
    await writer.appendStart({
      runId: 'gitignore',
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hello prompt'
    });

    const contents = await fs.readFile(
      path.join(workspaceRoot, '.schegent', '.gitignore'),
      'utf8'
    );
    expect(contents).toContain('Schegent runtime artifacts are local-only');
    expect(contents).toContain('*');
  });

  it('writes [EXIT_CODE]: timeout when timedOut=true', async () => {
    await writer.appendStart({ runId: 'tmo', phase: 'speckit-plan', iteration: 1, prompt: 'p' });
    await writer.appendEnd({
      runId: 'tmo',
      stdout: '',
      stderr: '',
      exitCode: null,
      killed: true,
      timedOut: true
    });
    expect(await readLog('tmo')).toContain('[EXIT_CODE]: timeout');
  });

  it('writes [EXIT_CODE]: null on cancellation (killed + exitCode=null)', async () => {
    await writer.appendStart({ runId: 'cnc', phase: 'speckit-plan', iteration: 1, prompt: 'p' });
    await writer.appendEnd({
      runId: 'cnc',
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      killed: true,
      timedOut: false
    });
    expect(await readLog('cnc')).toContain('[EXIT_CODE]: null');
  });

  it('preserves verbatim middle output through the disk-backed capture when parsing buffers truncate', async () => {
    const runId = 'streamed';
    await writer.appendStart({
      runId,
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p'
    });
    const capture = await writer.createInvocationCapture(runId);
    expect(capture).not.toBeNull();
    const entriesDuringCapture = await fs.readdir(
      path.join(workspaceRoot, '.schegent', 'sessions')
    );
    expect(entriesDuringCapture.some((entry) => entry.startsWith('.raw-spool-'))).toBe(false);

    const stdout = `head-${'x'.repeat(32_768)}-fatal-middle-${'y'.repeat(32_768)}-tail`;
    const stderr = `stderr-${'z'.repeat(2_048)}-middle-evidence`;
    const accepted = capture?.write('stdout', stdout);
    if (accepted === false) {
      await new Promise<void>((resolve) => capture?.onceDrain('stdout', resolve));
    }
    capture?.write('stderr', stderr);

    const stdoutBuffer = new ZippedStreamBuffer(4, 128);
    stdoutBuffer.append(stdout);
    stdoutBuffer.finalize();
    const stderrBuffer = new ZippedStreamBuffer(4, 128);
    stderrBuffer.append(stderr);
    stderrBuffer.finalize();
    expect(stdoutBuffer.truncated).toBe(true);
    expect(stderrBuffer.truncated).toBe(true);

    await writer.appendEnd({
      runId,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      exitCode: 0,
      killed: false,
      timedOut: false,
      capture
    });

    const contents = await readLog(runId);
    expect(contents).toContain(stdout);
    expect(contents).toContain(stderr);
    expect(contents).toContain('fatal-middle');
    const mode = (await fs.stat(
      path.join(workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`)
    )).mode;
    expect(mode & 0o077).toBe(0);
    const sessionEntries = await fs.readdir(
      path.join(workspaceRoot, '.schegent', 'sessions')
    );
    expect(sessionEntries.some((entry) => entry.startsWith('.raw-spool-'))).toBe(false);
  });

  it('scavenges OS-temp spools whose owner process is no longer alive', async () => {
    const spoolRoot = path.join(workspaceRoot, 'isolated-os-temp');
    await fs.mkdir(spoolRoot, { recursive: true });
    const abandoned = await fs.mkdtemp(
      path.join(spoolRoot, 'schegent-raw-spool-2147483647-')
    );
    await fs.writeFile(path.join(abandoned, 'stdout'), 'unredacted');
    const isolatedWriter = new RawTranscriptWriter(workspaceRoot, logger, spoolRoot);

    const capture = await isolatedWriter.createInvocationCapture('scavenge');

    expect(capture).not.toBeNull();
    await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    await capture?.dispose();
  });

  it('rewinds a partial spool copy and falls back to bounded output', async () => {
    const runId = 'spool-read-failure';
    await writer.appendStart({
      runId,
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p'
    });
    const capture: RawTranscriptCapture = {
      failed: false,
      write: () => true,
      onceDrain: (_stream, callback) => callback(),
      finish: async () => undefined,
      appendStreamTo: async (stream, destination) => {
        if (stream === 'stdout') {
          await destination.write('partial-spool-copy');
          throw new Error('spool read failed');
        }
        await destination.write('captured-stderr');
      },
      dispose: async () => undefined
    };

    await writer.appendEnd({
      runId,
      stdout: 'bounded-stdout-fallback',
      stderr: 'bounded-stderr-fallback',
      exitCode: 0,
      killed: false,
      timedOut: false,
      capture
    });

    const contents = await readLog(runId);
    expect(contents).toContain('bounded-stdout-fallback');
    expect(contents).not.toContain('partial-spool-copy');
    expect(contents).toContain('captured-stderr');
  });

  it('falls back when capture failure is reported after a successful-looking copy', async () => {
    const runId = 'late-spool-failure';
    await writer.appendStart({
      runId,
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p'
    });
    let failed = false;
    const capture: RawTranscriptCapture = {
      get failed() { return failed; },
      write: () => true,
      onceDrain: (_stream, callback) => callback(),
      finish: async () => undefined,
      appendStreamTo: async (_stream, destination) => {
        await destination.write('partial-spool-copy');
        failed = true;
      },
      dispose: async () => undefined
    };

    await writer.appendEnd({
      runId,
      stdout: 'bounded-stdout-fallback',
      stderr: 'bounded-stderr-fallback',
      exitCode: 0,
      killed: false,
      timedOut: false,
      capture
    });

    const contents = await readLog(runId);
    expect(contents).toContain('bounded-stdout-fallback');
    expect(contents).toContain('bounded-stderr-fallback');
    expect(contents).not.toContain('partial-spool-copy');
  });
});

describe('RawTranscriptWriter per-run isolation (T008, US2)', () => {
  it('produces distinct files per runId with no cross-contamination', async () => {
    await writer.appendStart({ runId: 'r1', phase: 'speckit-specify', iteration: 1, prompt: 'p1' });
    await writer.appendEnd({
      runId: 'r1',
      stdout: 'out1',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });
    await writer.appendStart({ runId: 'r2', phase: 'speckit-specify', iteration: 1, prompt: 'p2' });
    await writer.appendEnd({
      runId: 'r2',
      stdout: 'out2',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    const log1 = await readLog('r1');
    const log2 = await readLog('r2');

    expect(log1).toContain('Run ID: r1');
    expect(log1).toContain('p1');
    expect(log1).toContain('out1');
    expect(log1).not.toContain('Run ID: r2');
    expect(log1).not.toContain('p2');
    expect(log1).not.toContain('out2');

    expect(log2).toContain('Run ID: r2');
    expect(log2).toContain('p2');
    expect(log2).toContain('out2');
    expect(log2).not.toContain('Run ID: r1');
    expect(log2).not.toContain('p1');
    expect(log2).not.toContain('out1');
  });
});

describe('RawTranscriptWriter best-effort (T012, FR-007)', () => {
  it('does not throw when fs.appendFile rejects, warns once per runId, stays usable for other runIds', async () => {
    // Force EISDIR on writes to runId="fail" by pre-creating a directory at
    // the target file path. This is a real filesystem failure, not a mock —
    // appendFile cannot redefine its property descriptor under vi.spyOn.
    const sessionsDir = path.join(workspaceRoot, '.schegent', 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(path.join(sessionsDir, 'raw-fail.log'));

    await writer.appendStart({ runId: 'fail', phase: 'speckit-specify', iteration: 1, prompt: 'p' });
    await writer.appendEnd({
      runId: 'fail',
      stdout: '',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    const failWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('raw transcript write failed for run fail')
    );
    expect(failWarnings).toHaveLength(1);

    await writer.appendStart({ runId: 'ok', phase: 'speckit-specify', iteration: 1, prompt: 'p2' });
    await writer.appendEnd({
      runId: 'ok',
      stdout: 'okstd',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });
    expect(await readLog('ok')).toContain('Run ID: ok');
  });
});

describe('RawTranscriptWriter empty runId (T013, FR-011)', () => {
  it('skips logging entirely and warns exactly once across calls', async () => {
    await writer.appendStart({ runId: '', phase: 'speckit-specify', iteration: 1, prompt: 'p' });
    await writer.appendEnd({
      runId: '',
      stdout: '',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    const sessionsDir = path.join(workspaceRoot, '.schegent', 'sessions');
    let dirContents: string[] = [];
    try {
      dirContents = await fs.readdir(sessionsDir);
    } catch {
      // dir not created — acceptable
    }
    expect(dirContents).toHaveLength(0);

    const emptyWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('raw transcript skipped: empty runId')
    );
    expect(emptyWarnings).toHaveLength(1);
  });
});

describe('RawTranscriptWriter custom-phase instruction redaction (T049, US3, SC-008, FR-019)', () => {
  it('keeps a sensitive token verbatim in the raw transcript while logger.sanitize redacts it', async () => {
    const sensitive = 'sk-ant-api03-fake-token-ABCDEFGHIJKLMNOPQRSTUVWX';
    const customInstruction = `Audit the staged diff. Use creds: ${sensitive} to authenticate.`;
    const customPhaseId = 'security-audit';
    const runId = 'custom-phase-run';

    await writer.appendStart({
      runId,
      phase: customPhaseId,
      iteration: 1,
      prompt: customInstruction
    });
    await writer.appendEnd({
      runId,
      stdout: 'all clean',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    const rawContents = await readLog(runId);
    expect(rawContents).toContain(`Phase: ${customPhaseId}`);
    expect(rawContents).toContain(sensitive);
    expect(rawContents).not.toContain('[REDACTED]');

    const auditEquivalent = logger.sanitize(customInstruction);
    expect(auditEquivalent).not.toContain(sensitive);
    expect(auditEquivalent).toContain('[REDACTED]');
  });
});

describe('RawTranscriptWriter retention modes', () => {
  it('does not create transcript or spool artifacts in off mode', async () => {
    await writer.appendStart({
      runId: 'off-run', phase: 'speckit-plan', iteration: 1, prompt: 'secret', mode: 'off'
    });
    expect(await writer.createInvocationCapture('off-run', 'off')).toBeNull();
    await writer.appendEnd({
      runId: 'off-run', stdout: 'x', stderr: '', exitCode: 0,
      killed: false, timedOut: false, mode: 'off'
    });
    await expect(readLog('off-run')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stages errors-only privately, promotes failures, and deletes completion', async () => {
    const runId = 'error-run';
    await writer.appendStart({
      runId, phase: 'speckit-plan', iteration: 1, prompt: 'p', mode: 'errors-only'
    });
    await writer.appendEnd({
      runId, stdout: 'x', stderr: 'bad', exitCode: 1,
      killed: false, timedOut: false, mode: 'errors-only'
    });
    const pending = path.join(
      workspaceRoot, '.schegent', 'sessions', '.pending', `raw-${runId}.log`
    );
    expect(await fs.stat(pending).then((s) => s.isFile())).toBe(true);
    await writer.finalizeRun(runId, 'failed', 'errors-only');
    expect(await readLog(runId)).toContain('bad');
    await writer.finalizeRun(runId, 'completed', 'errors-only');
    await expect(readLog(runId)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
