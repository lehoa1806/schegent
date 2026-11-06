import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyFatal, getEffectiveSignatures } from '../../../src/lib/fatal-signature-registry';
import { SanitizedLogger } from '../../../src/lib/logger';
import { AgyCliRunner } from '../../../src/runner/agy-cli';
import type { InvocationOutputSink, RawInvocationOutput } from '../../../src/runner/invocation-result';
import {
  capturedText,
  createFakeBackendChild,
  scriptedSpawn,
  stubGroupSignals,
  type FakeChildScript
} from '../../fixtures/fake-backend-child';

/**
 * FR-R4-F06 (FR-025, FR-027; T29; contract F, F1 to F6) -- the Agy adapter's end of life, in
 * Agy's own completion protocol: the process exits and its stdio closes. A terminal row is DATA
 * in that protocol, not completion.
 *
 * Agy is the adapter that had no `cancellationSignal` case at all; F6 is its first. Its prompt
 * reaches stdin only as an NDJSON envelope, so F5's control checks that shape.
 *
 * (PROOF) Each case that could pass vacuously names its control. The control for F1 is M19: a
 * lifecycle runner that completes on the first stdout line that parses as JSON turns F1 red, because
 * the invocation would then settle at the terminal row instead of at the child's end. The cases for
 * F1 and F2 also plant a pair: the same script with the child ending right after the row, and with
 * the newline present, so a pass is a pass on both sides of the difference the case is about.
 *
 * Fake timers only (F7); the child is `createFakeBackendChild`, and the termination ladder runs
 * against stubbed group signals, so no real process or group is touched.
 */
const TERMINAL_ROW = '{"event":"result","subtype":"success","result":"done"}';
/** The one shape Agy reads a prompt in from stdin: one NDJSON message per line (`agy-cli.ts`). */
const PROMPT_ENVELOPE = (prompt: string): string =>
  `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
const IDLE_MS = 120_000;
const LADDER_DRAIN_MS = 5_000;

const baseRequest = {
  runId: 'run-agy-lifecycle',
  phase: 'speckit-implement' as const,
  iteration: 1,
  prompt: 'do the work',
  cliPath: 'agy',
  cwd: '/repo',
  timeoutMs: IDLE_MS
};

function quietLogger(): SanitizedLogger {
  const logger = new SanitizedLogger();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  return logger;
}

interface Started {
  readonly child: ReturnType<typeof createFakeBackendChild>;
  readonly runner: AgyCliRunner;
  readonly logger: SanitizedLogger;
  readonly result: Promise<RawInvocationOutput>;
  readonly done: () => boolean;
}

function start(
  script: FakeChildScript,
  request: Partial<Parameters<AgyCliRunner['invoke']>[0]> = {},
  outputSink?: InvocationOutputSink
): Started {
  const child = createFakeBackendChild(script);
  const logger = quietLogger();
  const runner = new AgyCliRunner(scriptedSpawn(child), null, logger);
  let finished = false;
  const result = runner.invoke({ ...baseRequest, ...request }, outputSink).finally(() => {
    finished = true;
  });
  return { child, runner, logger, result, done: () => finished };
}

async function drainLadder(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LADDER_DRAIN_MS);
}

/** "Reaped or reported": the child exited or was signalled, and the active entry is gone. */
function expectReaped(started: Started): void {
  expect(started.child.exitCode !== null || started.child.signalCode !== null).toBe(true);
  expect(started.runner.hasActiveProcess).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers();
  stubGroupSignals();
});

afterEach(() => {
  const pending = vi.getTimerCount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(pending, 'a ladder rung would have fired against the real process.kill').toBe(0);
});

describe('AgyCliRunner lifecycle, in its own protocol (T29)', () => {
  it('F1. a terminal row does not complete the invocation; its idle bound does, and the ladder reaps the child', async () => {
    const s = start({ stdout: [{ at: 10, chunk: TERMINAL_ROW + '\n' }] });

    // A minute on, the child has printed its terminal row and has not exited. Still running.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.done(), 'the terminal row must not complete the invocation').toBe(false);
    expect(s.child.signalsReceived).toEqual([]);

    // The idle bound runs out (it restarts at the last output), and the ladder ends the child.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    const raw = await s.result;
    await drainLadder();

    expect(raw.timedOut, 'the result kind matches the bound that ended it').toBe(true);
    expect(raw.exitCode).toBeNull();
    expect(s.child.signalsReceived).toContain('SIGTERM');
    expectReaped(s);
  });

  it('F1. the same lingering child ended by a cancellation is killed, not timed out', async () => {
    const controller = new AbortController();
    const s = start(
      { stdout: [{ at: 10, chunk: TERMINAL_ROW + '\n' }] },
      { cancellationSignal: controller.signal }
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.done()).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    const raw = await s.result;
    await drainLadder();

    expect(raw.killed).toBe(true);
    expect(raw.timedOut).toBe(false);
    expectReaped(s);
  });

  it('F1 planted pair. the same script with the child exiting right after the row completes at the exit', async () => {
    const s = start({ stdout: [{ at: 10, chunk: TERMINAL_ROW + '\n' }], exitAt: 20 });
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(raw.exitCode).toBe(0);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
    expect(s.child.signalsReceived).toEqual([]);
    expectReaped(s);
  });

  it('F2. a last line with no newline is captured byte for byte', async () => {
    const s = start({ stdout: [{ at: 10, chunk: TERMINAL_ROW }], exitAt: 20 });
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(capturedText(raw.stdoutBuffer)).toBe(TERMINAL_ROW);
    expect(raw.exitCode).toBe(0);
    expectReaped(s);
  });

  it('F2 planted pair. a newline-terminated last line gives the same bytes plus the newline', async () => {
    const s = start({ stdout: [{ at: 10, chunk: TERMINAL_ROW + '\n' }], exitAt: 20 });
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(capturedText(raw.stdoutBuffer)).toBe(TERMINAL_ROW + '\n');
  });

  it('F3. a 2 MiB line is captured whole and does not change completion', async () => {
    const big = 'y'.repeat(2 * 1024 * 1024);
    const s = start({ stdout: [{ at: 10, chunk: big + '\n' }, { at: 20, chunk: TERMINAL_ROW + '\n' }], exitAt: 30 });
    await vi.advanceTimersByTimeAsync(40);
    const raw = await s.result;
    await drainLadder();

    const text = capturedText(raw.stdoutBuffer);
    expect(text.length).toBe(big.length + 1 + TERMINAL_ROW.length + 1);
    expect(text.startsWith(big)).toBe(true);
    expect(raw.stdoutBuffer.truncated, 'the capture bound is 64 MiB; 2 MiB is far inside it').toBe(false);
    expect(raw.exitCode).toBe(0);
    expect(raw.timedOut).toBe(false);
    expectReaped(s);
  });

  it('F4. a fatal diagnostic on stderr is in the trailing lines and classifies; inside a stdout envelope it does not', async () => {
    const diagnostic = "error: unknown option '--bogus'";
    const envelope =
      JSON.stringify({ type: 'item.completed', item: { text: diagnostic } }) + '\n';

    const onStderr = start(
      { stderr: [{ at: 10, chunk: diagnostic + '\n' }], exitAt: 20, exitCode: 1 },
      { effectiveFatalSignatures: getEffectiveSignatures([]) }
    );
    await vi.advanceTimersByTimeAsync(30);
    const stderrRaw = await onStderr.result;
    await drainLadder();
    expect(stderrRaw.stderrBuffer.getTrailingLines(5)).toContain(diagnostic);
    expect(stderrRaw.streamFatalMatch).toMatchObject({ matched: true, stream: 'stderr' });
    expect(
      classifyFatal(capturedText(stderrRaw.stdoutBuffer), capturedText(stderrRaw.stderrBuffer))
    ).toMatchObject({ matched: true, stream: 'stderr' });

    const inEnvelope = start(
      { stdout: [{ at: 10, chunk: envelope }], exitAt: 20 },
      { effectiveFatalSignatures: getEffectiveSignatures([]) }
    );
    await vi.advanceTimersByTimeAsync(30);
    const envelopeRaw = await inEnvelope.result;
    await drainLadder();
    expect(envelopeRaw.streamFatalMatch).toEqual({ matched: false });
    expect(
      classifyFatal(capturedText(envelopeRaw.stdoutBuffer), capturedText(envelopeRaw.stderrBuffer))
    ).toEqual({ matched: false });
  });

  it.each(['EPIPE', 'ECONNRESET'] as const)(
    'F5. a stdin that fails with %s is reported on the result, not thrown',
    async (code) => {
      const s = start({ stdinFailure: { code }, exitAt: 50 });
      await vi.advanceTimersByTimeAsync(60);
      const raw = await s.result;
      await drainLadder();

      expect(raw.stdinDeliveryFailed).toBe(true);
      expect(raw.stdinErrorCode).toBe(code);
      expect(raw.diagnosticWarnings).toEqual(['stdin-delivery-failed']);
      expectReaped(s);
    }
  );

  it('F5 control. a healthy stdin receives the NDJSON envelope, not the bare prompt', async () => {
    const s = start({ exitAt: 50 });
    await vi.advanceTimersByTimeAsync(60);
    const raw = await s.result;
    await drainLadder();

    expect(raw.stdinDeliveryFailed).toBeUndefined();
    expect(s.child.stdinWrites.join('')).toBe(PROMPT_ENVELOPE(baseRequest.prompt));
    expect(s.child.stdinWrites.join('')).not.toBe(baseRequest.prompt);
  });

  it('F6. aborting the cancellation signal (Agy\'s first such case) gives killed, runs the ladder, and settleTeardowns reports one outcome', async () => {
    const controller = new AbortController();
    const s = start({}, { cancellationSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(s.runner.hasActiveProcess).toBe(true);

    controller.abort();
    const teardowns = s.runner.settleTeardowns();
    await vi.advanceTimersByTimeAsync(LADDER_DRAIN_MS);
    const raw = await s.result;

    expect(raw.killed).toBe(true);
    expect(s.child.signalsReceived).toContain('SIGTERM');
    const outcomes = await teardowns;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      runner: 'agy-cli',
      attribution: { runId: baseRequest.runId, phase: baseRequest.phase, iteration: 1 },
      result: 'group-gone'
    });
    expectReaped(s);
  });

  it('F9. split/chunked stdout records (including conversation_id) and split stderr fatal diagnostics are reassembled', async () => {
    const s = start(
      {
        stdout: [
          { at: 5, chunk: '{"event":"res' },
          { at: 10, chunk: 'ult","conversation_id":"agy-split-9","result":"done"}\n' }
        ],
        stderr: [
          { at: 12, chunk: 'error: unknown ' },
          { at: 18, chunk: "option '--bogus'\n" }
        ],
        exitAt: 25,
        exitCode: 1
      },
      { effectiveFatalSignatures: getEffectiveSignatures([]) }
    );
    await vi.advanceTimersByTimeAsync(35);
    const raw = await s.result;
    await drainLadder();

    expect(raw.cliSessionId).toBe('agy-split-9');
    expect(raw.streamFatalMatch).toMatchObject({ matched: true, stream: 'stderr' });
    expectReaped(s);
  });

  it('F10. stdout close after exit retains post-exit buffered chunks, and close-grace expiry bounds a held pipe', async () => {
    const bufferedAfterExit = start({
      stdout: [{ at: 50, chunk: '{"type":"result","conversation_id":"agy-after-exit"}\n' }],
      exitAt: 20,
      closeAfterExitMs: 80
    });
    await vi.advanceTimersByTimeAsync(120);
    const bufferedRaw = await bufferedAfterExit.result;
    await drainLadder();

    expect(bufferedRaw.cliSessionId).toBe('agy-after-exit');
    expect(bufferedRaw.exitCode).toBe(0);
    expectReaped(bufferedAfterExit);

    const heldPipe = start({
      stdout: [{ at: 10, chunk: TERMINAL_ROW }],
      exitAt: 20,
      holdStdioOpenAfterExit: true
    });
    await vi.advanceTimersByTimeAsync(2_100);
    const heldRaw = await heldPipe.result;
    await drainLadder();

    expect(capturedText(heldRaw.stdoutBuffer)).toBe(TERMINAL_ROW);
    expect(heldRaw.exitCode).toBe(0);
    expect(
      vi
        .mocked(heldPipe.logger.warn)
        .mock.calls.some(([msg]) => String(msg).includes('stdio close grace expired'))
    ).toBe(true);
    expectReaped(heldPipe);
  });

  it('F11. output sink backpressure pauses child streams and suspends the idle timer until drain', async () => {
    let drainStdout: (() => void) | undefined;
    const sink: InvocationOutputSink = {
      write: vi.fn(() => false),
      onceDrain: (stream, cb) => {
        if (stream === 'stdout') drainStdout = cb;
      }
    };
    const s = start({ stdout: [{ at: 10, chunk: TERMINAL_ROW + '\n' }] }, {}, sink);

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(s.child.signalsReceived, 'blocked sink suspends idle expiry').toEqual([]);
    expect(s.done()).toBe(false);

    drainStdout?.();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    const raw = await s.result;
    await drainLadder();

    expect(raw.timedOut).toBe(true);
    expectReaped(s);
  });

  it('F12. absolute maxDurationMs deadline terminates a chatty child that resets the idle timer', async () => {
    const s = start(
      {
        stdout: [
          { at: 100, chunk: 'tick\n' },
          { at: 200, chunk: 'tick\n' },
          { at: 300, chunk: 'tick\n' },
          { at: 400, chunk: 'tick\n' }
        ]
      },
      { timeoutMs: 1_000, maxDurationMs: 350 }
    );

    await vi.advanceTimersByTimeAsync(400);
    const raw = await s.result;
    await drainLadder();

    expect(raw.deadlineExceeded).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.exitCode).toBeNull();
    expectReaped(s);
  });

  it('F13. a spawn error (ENOENT with pid undefined) settles without misreporting stdinDeliveryFailed', async () => {
    const s = start({ spawnError: { code: 'ENOENT' } });
    await vi.advanceTimersByTimeAsync(20);
    const raw = await s.result;
    await drainLadder();

    expect(raw.exitCode).toBeNull();
    expect(raw.stdinDeliveryFailed).toBeUndefined();
    expect(raw.diagnosticWarnings ?? []).not.toContain('stdin-delivery-failed');
    expect(s.runner.hasActiveProcess).toBe(false);
  });
});
