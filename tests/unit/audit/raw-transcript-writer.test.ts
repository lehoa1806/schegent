import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

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
