import { describe, it, expect } from 'vitest';
import {
  COMPACTION_IDLE_TIMEOUT_MS,
  COMPACTION_MAX_DURATION_MS,
  COMPACTION_MODEL_ID,
  SessionCompactionError,
  compactClaudeSession,
  compactionFailureRecord
} from '../../../src/controller/session-compactor';
import { MONITOR_STALL_THRESHOLD_MS } from '../../../src/contracts/monitor-events';
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

describe('session compaction bounds', () => {
  // The founding defect: the compaction bound was 60_000 and the monitor's stall
  // threshold is 90_000, so a silent compaction child was always killed 30 seconds
  // before `handleStall` could fire. No `monitor-stall` was ever writable about one.
  // Asserted rather than left to two literals agreeing, because two literals
  // agreeing is what this was.
  it('gives compaction more idle runway than the monitor needs to declare a stall', () => {
    expect(COMPACTION_IDLE_TIMEOUT_MS).toBeGreaterThan(MONITOR_STALL_THRESHOLD_MS);
  });

  it('bounds the invocation on both the idle window and the wall clock', async () => {
    const { runner, seen } = makeRunner();
    await compactClaudeSession(inputs(runner));
    expect(seen.map((r) => r.timeoutMs)).toEqual([COMPACTION_IDLE_TIMEOUT_MS]);
    expect(seen.map((r) => r.maxDurationMs)).toEqual([COMPACTION_MAX_DURATION_MS]);
  });

  // A child that emits one byte inside every idle window resets the idle timer
  // forever, which is the case `maxDurationMs` exists for and the case compaction
  // had no bound on at all.
  it('sets the wall-clock bound above the idle window', () => {
    expect(COMPACTION_MAX_DURATION_MS).toBeGreaterThan(COMPACTION_IDLE_TIMEOUT_MS);
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

  // The excerpt read trailing LINES and never parsed anything, so the one envelope a
  // killed compaction child had written — its `init` handshake — was reported as the
  // explanation: 600 characters of cwd, tool list and model, in the field added to
  // name a cause. A child whose only output is a handshake has no account of itself,
  // and the process facts alone read correctly.
  it('offers no explanation when the CLI only completed its handshake', async () => {
    const { runner } = makeRunner({
      exitCode: null,
      stdout:
        '{"type":"system","subtype":"init","cwd":"/w","tools":["Bash","Read","Edit"],' +
        '"model":"claude-haiku-4-5-20251001","session_id":"abc"}\n'
    });
    const message = await compactClaudeSession(inputs(runner)).then(
      () => 'did not throw',
      (err: Error) => err.message
    );
    expect(message).toMatch(/exit=signal/);
    expect(message).not.toMatch(/tools|init|cwd/);
  });

  it('reports the result field, not the envelope around it', async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stdout:
        '{"type":"system","subtype":"init","cwd":"/w","tools":["Bash"]}\n' +
        '{"type":"result","subtype":"error_during_execution",' +
        '"result":"Prompt is too long","session_id":"abc"}\n'
    });
    const message = await compactClaudeSession(inputs(runner)).then(
      () => 'did not throw',
      (err: Error) => err.message
    );
    expect(message).toMatch(/Prompt is too long/);
    expect(message).not.toMatch(/error_during_execution|session_id|"result"/);
  });

  // A CLI that dies before stream-json starts writes plain text. Skipping every line
  // that is not a `result` envelope would discard exactly that case.
  it('still reports plain-text output that is not stream-json at all', async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stdout: 'claude: command failed to start\n'
    });
    await expect(compactClaudeSession(inputs(runner))).rejects.toThrow(
      /command failed to start/
    );
  });

  // Plain output is reported WHOLE, not last-line-only: the verdict is per stream, so a
  // multi-line refusal keeps its second line and the reader keeps the remedy that is
  // usually on it.
  it('keeps every line of a multi-line plain-text refusal', async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stderr: 'compaction refused\nrun `claude login` and retry\n'
    });
    const message = await compactClaudeSession(inputs(runner)).then(
      () => 'did not throw',
      (err: Error) => err.message
    );
    expect(message).toMatch(/compaction refused/);
    expect(message).toMatch(/claude login/);
  });

  // Whole, but on ONE line. The collapse serves two readers now — this message, which
  // becomes a log line, and the classification below — and only the second had a test.
  // A multi-line message breaks the line-oriented sink it is written to, which is the
  // reason the collapse existed before anything was classified.
  it('reports a multi-line refusal as a single line', async () => {
    const { runner } = makeRunner({
      exitCode: 1,
      stderr: 'compaction refused\nrun `claude login` and retry\n'
    });
    const message = await compactClaudeSession(inputs(runner)).then(
      () => 'did not throw',
      (err: Error) => err.message
    );
    expect(message).not.toMatch(/\n/);
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

describe('session compaction failure classification', () => {
  // TWO DIFFERENT EVENTS ARRIVED UNDER ONE NAME. A compaction that RAN and did not
  // finish (killed, timed out, or a bounded child that never returned) and a session
  // the CLI would not ADMIT at all are opposite facts: the first says the bound was
  // reached, the second says the bound was never approached. The run this was filed
  // from spent 74 s of a 300 s bound and was refused, and the only record said
  // `session-compact-failed`, which reads as the first. An operator tuning the bound
  // would have been tuning a number that had nothing to do with it.
  const classify = async (outcome: FakeOutcome): Promise<string> => {
    const { runner } = makeRunner(outcome);
    return compactClaudeSession(inputs(runner)).then(
      () => 'did not throw',
      (err: unknown) =>
        err instanceof SessionCompactionError ? err.kind : `not a compaction error: ${String(err)}`
    );
  };

  it('marks a session the CLI would not admit as too large', async () => {
    expect(
      await classify({
        exitCode: 1,
        stdout: '{"type":"result","result":"Prompt is too long","session_id":"abc"}\n'
      })
    ).toBe('session-too-large');
  });

  it('marks a compaction that ran and did not finish as an invocation failure', async () => {
    expect(await classify({ exitCode: 1, stderr: 'model not found\n' })).toBe(
      'invocation-failed'
    );
  });

  // A child whose only output was a handshake has no account of itself. Absence of a
  // refusal is not a refusal, and guessing from the process facts alone would put the
  // more alarming of the two codes on the case with the least evidence.
  it('marks a silent child as an invocation failure, not a refusal', async () => {
    expect(await classify({ exitCode: null })).toBe('invocation-failed');
  });

  // The sentence is matched after whitespace is collapsed, for the same reason the
  // excerpt collapses it: a refusal that wraps is the same refusal. Matching the raw
  // text would report the general code for a line break.
  it('recognises the refusal when the CLI wrapped its sentence across lines', async () => {
    expect(await classify({ exitCode: 1, stderr: 'Prompt is too\nlong\n' })).toBe(
      'session-too-large'
    );
  });

  // ORDER IS THE POINT. The excerpt is bounded at 600 characters for a log line; the
  // classification is a verdict about what happened. Classifying the bounded string
  // would make the verdict depend on where the CLI put its sentence, so this pins the
  // sentence PAST the bound and still expects it read.
  it('classifies the whole account, not the excerpt the bound left behind', async () => {
    const message = await classify({
      exitCode: 1,
      stderr: `${'x'.repeat(700)} Prompt is too long\n`
    });
    expect(message).toBe('session-too-large');
  });

  // THE COMPOUND SENTENCE, decided deliberately rather than left to fall out. The CLI
  // says both things at once when a session is too large AND its own recovery could not
  // run: "Prompt is too long · automatic compaction failed: <why the recovery failed>".
  // That is the exact shape of the invalid-model incident, and it classifies as a
  // refusal — because on the facts it IS one. The session was not admitted; a second
  // fault stopped the CLI from fixing that itself. The reason code answers "was this
  // request admitted?", and `detail` still carries the whole sentence, so the second
  // fault is not lost to the reader who has to act on it.
  it('reads a refusal compounded with another fault as a refusal', async () => {
    expect(
      await classify({
        exitCode: 1,
        stdout:
          '{"type":"result","result":"Prompt is too long \\u00b7 automatic compaction failed: ' +
          "There's an issue with the selected model (claude-haiku-4-6)." +
          ' It may not exist or you may not have access to it."}\n'
      })
    ).toBe('session-too-large');
  });

  it('gives the two kinds different reason codes and different warnings', () => {
    const tooLarge = compactionFailureRecord(
      new SessionCompactionError('refused', 'session-too-large')
    );
    const ran = compactionFailureRecord(
      new SessionCompactionError('killed', 'invocation-failed')
    );
    expect(tooLarge.reasonCode).not.toBe(ran.reasonCode);
    expect(tooLarge.warning).not.toBe(ran.warning);
    // The code already on record, and in `docs/reference/settings.md`, keeps its
    // meaning: it is the mode it always described. Only the new mode is new.
    expect(ran.reasonCode).toBe('session-compaction-failed-fresh-session');
  });

  // The compactor rethrows the runner's own error untouched when `invoke` throws, and
  // that error is not this class. Anything unrecognised must fall to the code that was
  // already there rather than to the more specific claim.
  it('falls back to the general record for an error it did not raise', () => {
    expect(compactionFailureRecord(new Error('spawn ENOENT')).reasonCode).toBe(
      'session-compaction-failed-fresh-session'
    );
    expect(compactionFailureRecord('not an error at all').reasonCode).toBe(
      'session-compaction-failed-fresh-session'
    );
  });
});
