import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEffectiveSignatures } from '../../../src/lib/fatal-signature-registry';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_MAX_LINE_UNITS } from '../../../src/lib/line-framer';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { InvocationOutputSink, RawInvocationOutput } from '../../../src/runner/invocation-result';
import {
  capturedText,
  createFakeBackendChild,
  scriptedSpawn,
  stubGroupSignals,
  type FakeChildScript
} from '../../fixtures/fake-backend-child';

/**
 * FR-R4-F06 (FR-025, FR-027; T27; contract F, F1 to F6 and F8) -- the Claude adapter's end of life,
 * in Claude's own completion protocol: a parsed `type: result` line.
 *
 * WHY THIS FILE. Adapter tests existed for the happy path and a few named defects. Nothing walked
 * the same six situations through each adapter in that adapter's protocol, so a gap in one (a final
 * line with no newline, an oversized line, a failing stdin) was invisible until a Run hit it. The
 * cases are the rows of contract F's table, scripted on `createFakeBackendChild` and driven by fake
 * timers only (F7): no case sleeps.
 *
 * THE DECOY. Every script opens with an `assistant` message whose text is the serialized string
 * `{"type":"result","subtype":"success"}`. The runner must never take completion from assistant
 * text, because a substring is forgeable by anything the model prints and a `result` envelope is
 * emitted by the harness around the model. So each case also proves the decoy armed nothing, by
 * asserting what completed the invocation was the case's own line, or nothing.
 *
 * F2 is red at `befeccc8`: the runner's line framer was never flushed at the end of stdout, so a
 * final `result` line with no newline was dropped and `sawTerminalResult` read `false`. The control
 * is M16 (remove the flush).
 */
const INIT = '{"type":"system","subtype":"init","session_id":"sess-lifecycle"}\n';
const RESULT = '{"type":"result","subtype":"success","result":"done"}';
const DECOY =
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: RESULT }] }
  }) + '\n';
/** Past the 15 s settle window, with room. The constant is module-private to the runner. */
const PAST_SETTLE_MS = 16_000;
const LADDER_DRAIN_MS = 5_000;
const IDLE_MS = 90 * 60_000;

const baseRequest = {
  runId: 'run-claude-lifecycle',
  phase: 'speckit-implement' as const,
  iteration: 1,
  prompt: 'do the work',
  cliPath: 'claude',
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
  readonly runner: ClaudeCliRunner;
  readonly logger: SanitizedLogger;
  readonly result: Promise<RawInvocationOutput>;
}

function start(
  script: FakeChildScript,
  request: Partial<Parameters<ClaudeCliRunner['invoke']>[0]> = {},
  outputSink?: InvocationOutputSink
): Started {
  const child = createFakeBackendChild(script);
  const logger = quietLogger();
  const runner = new ClaudeCliRunner(scriptedSpawn(child), null, undefined, logger);
  const result = runner.invoke({ ...baseRequest, ...request }, outputSink);
  return { child, runner, logger, result };
}

/** Let the ladder's timers run out against the stubbed group signals, so none is left pending. */
async function drainLadder(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LADDER_DRAIN_MS);
}

/** "Reaped or reported": the child exited or was signalled, and the active entry is gone. */
function expectReaped(started: Started): void {
  const { child, runner } = started;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(runner.hasActiveProcess).toBe(false);
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

describe('ClaudeCliRunner lifecycle, in its own protocol (T27)', () => {
  it('F1. a terminal result and a child that lingers: the settle window ends it, and the ladder reaps the child', async () => {
    const s = start({
      stdout: [
        { at: 1, chunk: INIT + DECOY },
        { at: 10, chunk: RESULT + '\n' }
      ]
    });
    await vi.advanceTimersByTimeAsync(10);
    // Nothing yet: the settle window has not run out, and the decoy did not start one.
    expect(s.child.signalsReceived).toEqual([]);

    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    const raw = await s.result;
    await drainLadder();

    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.sawTerminalResult).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
    expect(s.child.signalsReceived).toContain('SIGTERM');
    expectReaped(s);
  });

  it('F1 control. the decoy alone completes nothing: no settle window opens, no signal is sent', async () => {
    const s = start({ stdout: [{ at: 1, chunk: INIT + DECOY }] });
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS + 1_000);

    expect(s.child.signalsReceived, 'assistant text must not arm the settle window').toEqual([]);
    expect(s.runner.hasActiveProcess).toBe(true);

    // End it, so no rung is left pending.
    s.runner.cancelActive();
    await vi.advanceTimersByTimeAsync(10);
    const raw = await s.result;
    await drainLadder();
    expect(raw.sawTerminalResult).toBe(false);
    expect(raw.completedAwaitingExit).toBe(false);
  });

  it('F2. a final result line with no newline is parsed and completes the invocation', async () => {
    const s = start({
      stdout: [
        { at: 1, chunk: INIT + DECOY },
        // The last stdout bytes: a result line, no newline, then the child exits.
        { at: 10, chunk: RESULT }
      ],
      exitAt: 20
    });
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(raw.sawTerminalResult, 'the flushed line is parsed, as every framed line is').toBe(true);
    expect(raw.exitCode).toBe(0);
    expect(capturedText(raw.stdoutBuffer).endsWith(RESULT)).toBe(true);
    expectReaped(s);
  });

  it('F2 control. the same script with the newline completes too, so the case is not vacuous', async () => {
    const s = start({
      stdout: [
        { at: 1, chunk: INIT + DECOY },
        { at: 10, chunk: RESULT + '\n' }
      ],
      exitAt: 20
    });
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(raw.sawTerminalResult).toBe(true);
    expect(capturedText(raw.stdoutBuffer).endsWith(RESULT + '\n')).toBe(true);
  });

  it('F3. an oversized line is cut and warned once, and the next result line still completes', async () => {
    const oversized = 'x'.repeat(DEFAULT_MAX_LINE_UNITS + 1);
    const s = start({
      stdout: [
        { at: 1, chunk: INIT + DECOY },
        { at: 10, chunk: oversized + '\n' },
        { at: 20, chunk: RESULT + '\n' }
      ],
      exitAt: 30
    });
    await vi.advanceTimersByTimeAsync(40);
    const raw = await s.result;
    await drainLadder();

    const framingWarnings = vi
      .mocked(s.logger.warn)
      .mock.calls.filter(([message]) => String(message).includes('framing bound'));
    expect(framingWarnings, 'one truncation, one warning').toHaveLength(1);
    expect(raw.sawTerminalResult).toBe(true);
    expectReaped(s);
  });

  it('F4. a built-in fatal signature on stderr sets streamFatalMatch', async () => {
    const s = start(
      {
        stdout: [{ at: 1, chunk: INIT + DECOY }],
        stderr: [{ at: 10, chunk: "error: unknown option '--bogus'\n" }],
        exitAt: 20,
        exitCode: 1
      },
      { effectiveFatalSignatures: getEffectiveSignatures([]) }
    );
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(raw.streamFatalMatch).toMatchObject({ matched: true, stream: 'stderr' });
    expectReaped(s);
  });

  it('F4 control (hard rule 17). the same text inside a stdout JSON envelope matches nothing', async () => {
    const envelope =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: "error: unknown option '--bogus'" }]
        }
      }) + '\n';
    const s = start(
      { stdout: [{ at: 1, chunk: INIT + DECOY + envelope }], exitAt: 20 },
      { effectiveFatalSignatures: getEffectiveSignatures([]) }
    );
    await vi.advanceTimersByTimeAsync(30);
    const raw = await s.result;
    await drainLadder();

    expect(raw.streamFatalMatch?.matched).toBe(false);
  });

  it.each(['EPIPE', 'ECONNRESET'] as const)(
    'F5. a stdin that fails with %s is reported on the result, not thrown',
    async (code) => {
      const s = start({
        stdout: [{ at: 1, chunk: INIT + DECOY }],
        stdinFailure: { code },
        exitAt: 50
      });
      await vi.advanceTimersByTimeAsync(60);
      const raw = await s.result;
      await drainLadder();

      expect(raw.stdinDeliveryFailed).toBe(true);
      expect(raw.stdinErrorCode).toBe(code);
      expect(raw.diagnosticWarnings).toContain('stdin-delivery-failed');
      // The decoy completed nothing on this path either.
      expect(raw.sawTerminalResult).toBe(false);
      expectReaped(s);
    }
  );

  it('F6. aborting the cancellation signal gives killed, runs the ladder, and settleTeardowns reports one outcome', async () => {
    const controller = new AbortController();
    const s = start(
      { stdout: [{ at: 1, chunk: INIT + DECOY }] },
      { cancellationSignal: controller.signal }
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(s.runner.hasActiveProcess).toBe(true);

    controller.abort();
    const teardowns = s.runner.settleTeardowns();
    await vi.advanceTimersByTimeAsync(LADDER_DRAIN_MS);
    const raw = await s.result;

    expect(raw.killed).toBe(true);
    expect(raw.sawTerminalResult).toBe(false);
    expect(s.child.signalsReceived).toContain('SIGTERM');
    const outcomes = await teardowns;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      runner: 'claude-cli',
      attribution: { runId: baseRequest.runId, phase: baseRequest.phase, iteration: 1 },
      result: 'group-gone'
    });
    expectReaped(s);
  });

  it('F8. a serialized result inside assistant text does not set sawTerminalResult, and the invocation waits for the real line', async () => {
    const s = start({
      stdout: [
        { at: 1, chunk: INIT + DECOY },
        { at: 30_000, chunk: RESULT + '\n' }
      ],
      exitAt: 30_020
    });
    // Past where the decoy would have armed the settle window and had the child signalled.
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    expect(s.child.signalsReceived, 'the decoy armed a settle window').toEqual([]);
    expect(s.runner.hasActiveProcess).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    const raw = await s.result;
    await drainLadder();

    expect(raw.sawTerminalResult, 'only the real terminal line sets it').toBe(true);
    expect(raw.completedAwaitingExit).toBe(false);
    expectReaped(s);
  });

  it('F9. split/chunked terminal result and fatal diagnostic across chunks are reassembled', async () => {
    const s = start(
      {
        stdout: [
          { at: 1, chunk: '{"type":"system","subtype":"init","ses' },
          { at: 5, chunk: 'sion_id":"sess-split"}\n' },
          { at: 10, chunk: '{"type":"res' },
          { at: 15, chunk: 'ult","subtype":"success",' },
          { at: 20, chunk: '"result":"done"}\n' }
        ],
        stderr: [
          { at: 12, chunk: 'error: unknown ' },
          { at: 18, chunk: "option '--bogus'\n" }
        ],
        exitAt: 30,
        exitCode: 1
      },
      { effectiveFatalSignatures: getEffectiveSignatures([]) }
    );
    await vi.advanceTimersByTimeAsync(40);
    const raw = await s.result;
    await drainLadder();

    expect(raw.sawTerminalResult).toBe(true);
    expect(raw.cliSessionId).toBe('sess-split');
    expect(raw.streamFatalMatch).toMatchObject({ matched: true, stream: 'stderr' });
    expectReaped(s);
  });

  it('F10. stdout close after exit retains post-exit buffered chunks, and close-grace expiry flushes an un-newlined final result', async () => {
    const bufferedAfterExit = start({
      stdout: [
        { at: 5, chunk: INIT },
        { at: 50, chunk: RESULT + '\n' }
      ],
      exitAt: 20,
      closeAfterExitMs: 80
    });
    await vi.advanceTimersByTimeAsync(120);
    const bufferedRaw = await bufferedAfterExit.result;
    await drainLadder();

    expect(bufferedRaw.sawTerminalResult).toBe(true);
    expect(bufferedRaw.exitCode).toBe(0);
    expect(capturedText(bufferedRaw.stdoutBuffer).endsWith(RESULT + '\n')).toBe(true);
    expectReaped(bufferedAfterExit);

    const heldPipe = start({
      stdout: [
        { at: 5, chunk: INIT },
        { at: 10, chunk: RESULT }
      ],
      exitAt: 20,
      holdStdioOpenAfterExit: true
    });
    await vi.advanceTimersByTimeAsync(2_100);
    const heldRaw = await heldPipe.result;
    await drainLadder();

    expect(heldRaw.sawTerminalResult).toBe(true);
    expect(heldRaw.exitCode).toBe(0);
    expect(
      vi
        .mocked(heldPipe.logger.warn)
        .mock.calls.some(([msg]) => String(msg).includes('close grace expired'))
    ).toBe(true);
    expectReaped(heldPipe);
  });

  it('F11. output sink backpressure pauses child streams and suspends the settle timer until drain', async () => {
    let drainStdout: (() => void) | undefined;
    const sink: InvocationOutputSink = {
      write: vi.fn(() => false),
      onceDrain: (stream, cb) => {
        if (stream === 'stdout') drainStdout = cb;
      }
    };
    const s = start(
      {
        stdout: [
          { at: 1, chunk: INIT },
          { at: 10, chunk: RESULT + '\n' }
        ]
      },
      {},
      sink
    );

    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS * 2);
    expect(s.child.signalsReceived, 'blocked sink suspends settle expiry').toEqual([]);
    expect(s.runner.hasActiveProcess).toBe(true);

    drainStdout?.();
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_MS);
    const raw = await s.result;
    await drainLadder();

    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
    expectReaped(s);
  });

  it('F12. absolute maxDurationMs deadline terminates a chatty child that resets the idle timer', async () => {
    const s = start(
      {
        stdout: [
          { at: 100, chunk: INIT },
          { at: 200, chunk: DECOY },
          { at: 300, chunk: DECOY },
          { at: 400, chunk: DECOY }
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
