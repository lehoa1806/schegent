import { describe, it, expect } from 'vitest';
import {
  COMPACTION_MODEL_ID,
  compactClaudeSession
} from '../../../src/controller/session-compactor';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import type { BackendRunner, InvocationRequest, RawInvocationOutput } from '../../../src/contracts/backend-runner';

function streamOf(text: string): ZippedStreamBuffer {
  const buf = new ZippedStreamBuffer();
  if (text.length > 0) buf.append(text);
  buf.finalize();
  return buf;
}

interface FakeOutcome {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

function makeRunner(outcome: FakeOutcome = {}): {
  runner: BackendRunner;
  seen: InvocationRequest[];
} {
  const seen: InvocationRequest[] = [];
  const runner = {
    invoke: async (request: InvocationRequest): Promise<RawInvocationOutput> => {
      seen.push(request);
      return {
        stdoutBuffer: streamOf(outcome.stdout ?? ''),
        stderrBuffer: streamOf(outcome.stderr ?? ''),
        exitCode: outcome.exitCode === undefined ? 0 : outcome.exitCode,
        killed: false,
        timedOut: false
      } as unknown as RawInvocationOutput;
    }
  } as unknown as BackendRunner;
  return { runner, seen };
}

function inputs(runner: BackendRunner) {
  return {
    runner,
    rawTranscript: null,
    runId: 'run-1',
    phase: 'speckit-implement',
    iteration: 1,
    cliPath: '/usr/local/bin/claude',
    cwd: '/w',
    resumeSessionId: 'session-1',
    onCommand: async (): Promise<void> => {},
    logger: new SanitizedLogger()
  } as unknown as Parameters<typeof compactClaudeSession>[0];
}

describe('session compaction model pin', () => {
  // The reporting workspace pinned `claude-haiku-4-6`, which is not a model. Every phase
  // boundary therefore failed compaction, dropped the session, and restarted the next
  // phase cold — the dominant cost driver in an 8-hour, $77.21 run.
  it('pins a model id the catalog actually carries', () => {
    expect(COMPACTION_MODEL_ID).toBe('claude-haiku-4-5-20251001');
  });

  it('sends the pinned model on the compaction invocation', async () => {
    const { runner, seen } = makeRunner();
    await compactClaudeSession(inputs(runner));
    expect(seen.map((r) => r.model)).toEqual([COMPACTION_MODEL_ID]);
  });
});

describe('session compaction failure reporting', () => {
  // The throw reported only `exit=1, killed=false, timedOut=false`, and the caller logged
  // only phase and iteration. The CLI's own explanation — the one sentence that names the
  // bad model — was discarded at both layers, so the same failure could fire ten times in
  // one run without anything an operator reads naming a cause.
  it('carries the CLI explanation into the thrown error', async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stdout:
        '{"type":"result","result":"Prompt is too long \\u00b7 automatic compaction failed: ' +
        "There's an issue with the selected model (claude-haiku-4-6)." +
        ' It may not exist or you may not have access to it."}\n'
    });
    await expect(compactClaudeSession(inputs(runner))).rejects.toThrow(
      /issue with the selected model/
    );
  });

  it('still reports the process facts when the CLI said nothing', async () => {
    const { runner } = makeRunner({ exitCode: 1 });
    await expect(compactClaudeSession(inputs(runner))).rejects.toThrow(/exit=1/);
  });

  it('prefers stderr when the CLI wrote there', async () => {
    const { runner } = makeRunner({ exitCode: 1, stderr: 'model not found\n' });
    await expect(compactClaudeSession(inputs(runner))).rejects.toThrow(/model not found/);
  });

  // The excerpt is model-controlled text on its way into a log line, so it goes through
  // the shared redaction set — `logger.sanitize`, never a second copy of the patterns.
  it('redacts a secret that reached the CLI output', async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stderr: 'auth failed for sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
    });
    const message = await compactClaudeSession(inputs(runner)).then(
      () => 'did not throw',
      (err: Error) => err.message
    );
    expect(message).toMatch(/auth failed/);
    expect(message).not.toMatch(/sk-ant-api03-AAAA/);
  });
});
