import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ProcessLifecycleRunner, type ProcessSpawnFn } from '../../../src/runner/process-lifecycle-runner';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import { awaitStdinDelivery, writePromptToStdin } from '../../../src/runner/child-stdin';
import type { InvocationRequest } from '../../../src/runner/invocation-result';

/**
 * FR-R3-047 / H-04 — the repository's first runner tests that spawn a REAL child.
 *
 * Every other file in this directory injects a fabricated `spawnFn` whose stdin is
 * a `Writable` stub that always calls `cb()`. Such a stub cannot emit `EPIPE`, and
 * `EPIPE` is the entire finding: the runners write the prompt inside a synchronous
 * `try/catch`, which cannot intercept an asynchronous `'error'` event, so a backend
 * that dies mid-write raises an uncaught exception and kills the extension host.
 * A fake reaches none of that.
 *
 * The assertion is the ABSENCE OF A PROCESS-LEVEL EVENT, not the presence of a
 * return value. That distinction decides whether this file means anything: today
 * the invocation result is computed correctly and the host dies around it, so a
 * test that only inspected the returned value would pass against the broken code.
 * Installing our own `uncaughtException` listener is also what makes the failure
 * observable instead of fatal — Node suppresses the default abort once a listener
 * exists, so the defect becomes a recorded call rather than a dead test run.
 */

/** Large enough to exceed the pipe buffer; a prompt that fits proves nothing. */
const EIGHT_MIB = 8 * 1024 * 1024;

/** A child that throws its stdin away, then lingers so the write is still in flight. */
const CHILD_DESTROYS_STDIN = 'process.stdin.destroy(); setTimeout(() => process.exit(0), 400);';

/** A child that drains stdin fully and reports how much it read. */
const CHILD_READS_ALL =
  'let n = 0;' +
  'process.stdin.on("data", (c) => { n += c.length; });' +
  'process.stdin.on("end", () => { console.log("read:" + n); process.exit(0); });';

function requestFor(prompt: string): InvocationRequest {
  return {
    phase: 'implement' as InvocationRequest['phase'],
    iteration: 1,
    prompt,
    timeoutMs: 30_000,
    cliPath: process.execPath,
    cwd: process.cwd()
  };
}

function realRunner(label: string): ProcessLifecycleRunner {
  return new ProcessLifecycleRunner(
    spawn as unknown as ProcessSpawnFn,
    null,
    new SanitizedLogger([]),
    label
  );
}

/**
 * Run `body` with process-level fault listeners installed, and report anything they
 * caught. Listeners are removed in a `finally` so one case cannot leak them into the
 * next, which would silently disarm every later assertion in the file.
 */
async function withFaultListeners<T>(
  body: () => Promise<T>
): Promise<{ value: T; faults: string[] }> {
  const faults: string[] = [];
  const onUncaught = (err: unknown): void => {
    const e = err as { code?: string; message?: string };
    faults.push(`uncaughtException:${e.code ?? e.message ?? 'unknown'}`);
  };
  const onUnhandled = (reason: unknown): void => {
    faults.push(`unhandledRejection:${(reason as { code?: string }).code ?? String(reason)}`);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  try {
    const value = await body();
    // One turn of the loop so an asynchronous fault raised by the write has a
    // chance to arrive before we stop listening. Without it a passing result here
    // would only mean "the fault had not landed yet".
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { value, faults };
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  }
}

describe('prompt delivery to a real child (H-04)', () => {
  it('fails the invocation, not the host, when the child destroys stdin mid-write', async () => {
    const runner = realRunner('h04-generic');
    const { value: raw, faults } = await withFaultListeners(() =>
      runner.invoke({
        request: requestFor('x'.repeat(EIGHT_MIB)),
        args: ['-e', CHILD_DESTROYS_STDIN],
        env: process.env,
        commandDisplay: 'node -e <fixture>'
      })
    );

    // The host survived: this is the finding, and it is asserted rather than
    // inferred from the absence of a crash.
    expect(faults).toEqual([]);
    // The invocation still produced a result rather than hanging.
    expect(raw).toBeDefined();
    expect(raw.durationMs).toBeGreaterThanOrEqual(0);
    // And the failure was CLASSIFIED, not merely survived: this is the only place
    // the condition is produced from a real EPIPE, so without these two lines the
    // runner could route the failure nowhere and every case here would still pass.
    // The errno itself is asserted as present rather than equal to a literal —
    // which errno the platform reports (EPIPE, ECANCELED) is not the contract.
    expect(raw.stdinDeliveryFailed).toBe(true);
    expect(raw.stdinErrorCode).toBeTruthy();
    // And it left no entry behind: a failed write must not strand the runner's
    // active-process bookkeeping, which would make `hasActiveProcess` permanently
    // true and `cancelAll()` at deactivation orphan a child.
    expect(runner.hasActiveProcess).toBe(false);
  }, 45_000);

  it('records nothing and behaves as before when the child reads the whole prompt', async () => {
    const runner = realRunner('h04-happy');
    const { value: raw, faults } = await withFaultListeners(() =>
      runner.invoke({
        request: requestFor('y'.repeat(64 * 1024)),
        args: ['-e', CHILD_READS_ALL],
        env: process.env,
        commandDisplay: 'node -e <fixture>'
      })
    );

    expect(faults).toEqual([]);
    expect(raw.exitCode).toBe(0);
    expect(runner.hasActiveProcess).toBe(false);
    // The child confirms it drained every byte, so this really is the happy path
    // rather than a delivery failure that happened to exit zero.
    expect(raw.stdoutBuffer.getTrailingLines(20)).toContain(`read:${64 * 1024}`);
  }, 45_000);

  it('never lets a prompt byte reach the log or the result on the failing path', async () => {
    const marker = 'PROMPT_MARKER_DO_NOT_LEAK';
    const lines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]);
    const runner = new ProcessLifecycleRunner(
      spawn as unknown as ProcessSpawnFn, null, logger, 'h04-leak'
    );
    const prompt = `${marker}${'z'.repeat(EIGHT_MIB)}`;

    const { value: raw } = await withFaultListeners(() =>
      runner.invoke({
        request: requestFor(prompt),
        args: ['-e', CHILD_DESTROYS_STDIN],
        env: process.env,
        commandDisplay: 'node -e <fixture>'
      })
    );

    expect(lines.join('\n')).not.toContain(marker);
    expect(JSON.stringify({ ...raw, stdoutBuffer: undefined, stderrBuffer: undefined }))
      .not.toContain(marker);
  }, 45_000);
});

describe('prompt delivery: the other write site (FR-009, SC-002)', () => {
  /**
   * Two write sites serve four backends. The Claude runner writes directly; the
   * generic process-lifecycle runner's write is shared by the Agy and Codex
   * adapters, which delegate to it and correctly contain no write of their own.
   * So covering these two covers all four, and a guard enumerating runner
   * classes would demand a handler in two files that must not have one.
   */
  it('the Claude runner also fails the invocation rather than the host', async () => {
    // The Claude runner spawns its own argv, so the fixture child is supplied by
    // pointing `cliPath` at this Node binary; whatever argv it appends, a Node
    // process with no script reads stdin and exits, which is enough to exercise
    // the write path.
    const runner = new ClaudeCliRunner(
      spawn as unknown as never,
      null,
      {},
      new SanitizedLogger([])
    );
    const { faults } = await withFaultListeners(async () => {
      try {
        await runner.invoke(requestFor('x'.repeat(EIGHT_MIB)));
      } catch {
        // A rejected invocation is acceptable here; an uncaught process-level
        // fault is not, and that is what this case asserts.
      }
      return null;
    });
    expect(faults).toEqual([]);
  }, 45_000);
});

describe('a child that never started is not a delivery failure', () => {
  /**
   * FR-R3-047 — measured on Node v24.19.0: a spawn that fails with ENOENT still
   * created the stdin pipe, so the prompt write fails `EPIPE`. Classifying that
   * as a prompt-delivery failure names the wrong cause for the commonest
   * misconfiguration there is — a mistyped `cliPath` — and the condition outranks
   * every other arm of the phase-runner decision chain, so the wrong cause is the
   * only one the operator sees.
   */
  it('leaves the condition unset when the CLI path does not exist', async () => {
    const runner = realRunner('h04-enoent');
    const { value: raw, faults } = await withFaultListeners(() =>
      runner.invoke({
        request: { ...requestFor('a prompt no process will ever read'), cliPath: '/nonexistent/schegent-cli' },
        args: [],
        env: process.env,
        commandDisplay: '/nonexistent/schegent-cli'
      })
    );

    // The host still survives — that part is the H-04 fix and is unchanged.
    expect(faults).toEqual([]);
    // But the invocation does not claim a delivery defect for a backend that
    // never existed; it fails through the ordinary no-output classification.
    expect(raw.stdinDeliveryFailed).toBeFalsy();
    expect(raw.stdinErrorCode).toBeUndefined();
    expect(raw.exitCode).toBeNull();
    expect(runner.hasActiveProcess).toBe(false);
  }, 45_000);
});

describe('a synchronous stream failure resolves rather than rejecting', () => {
  /**
   * FR-R3-047 — the helper is documented as never rejecting, and both runners
   * rely on it: they read the delivery result only after the child has completed,
   * so a rejected promise would sit with no handler for the whole invocation and
   * Node would raise `unhandledRejection` — fatal to the host by default, the
   * exact shape this feature exists to remove.
   */
  it('classifies a write that throws instead of rejecting the promise', async () => {
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    stdin.write = () => { throw Object.assign(new Error('boom'), { code: 'ERR_STREAM_DESTROYED' }); };
    const child = { stdin } as unknown as Parameters<typeof writePromptToStdin>[0];

    const faults: string[] = [];
    const onUnhandled = (reason: unknown): void => { faults.push(String(reason)); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const promise = writePromptToStdin(child, 'a prompt');
      // A turn of the loop before the result is read, which is what the runners
      // do: without the guard the rejection is already unhandled by this point.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(promise).resolves.toEqual({
        delivered: false,
        errorCode: 'ERR_STREAM_DESTROYED'
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(faults).toEqual([]);
  });
});

describe('the no-prompt paths still absorb a stream error', () => {
  /**
   * An empty prompt writes no byte, but it still calls `end()`, and `end()` is
   * still a stream operation that can fail asynchronously against a peer that is
   * already gone. `EventEmitter.emit('error')` with no listener throws — which is
   * precisely how an EPIPE becomes an uncaught exception and takes the extension
   * host down — so emitting it is a direct test of whether the handler is
   * attached on this path too, not a simulation of one.
   */
  it('attaches the handler before closing stdin for an empty prompt', async () => {
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = { stdin } as unknown as Parameters<typeof writePromptToStdin>[0];

    const result = await writePromptToStdin(child, '');

    // Nothing was sent, so nothing is reported: an invocation carrying no prompt
    // must not be classified as a delivery failure.
    expect(result.delivered).toBe(true);
    expect(() => stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })))
      .not.toThrow();
  });
});

describe('the delivery read is bounded (no invocation may hang on it)', () => {
  /**
   * A pending write settles when the peer accepts the bytes or the pipe breaks.
   * Neither happens when a DESCENDANT inherited the stdin read end and never
   * drains it — the same condition the stdio-close grace exists to tolerate. The
   * child then exits, `waitForChildCompletion` settles on its own bounded grace,
   * and an unbounded `await` on the delivery promise never returns: the
   * invocation never resolves and the run, with the queue behind it, hangs for
   * the workspace's lifetime.
   */
  it('resolves as delivered when the write never reports its fate', async () => {
    const never = new Promise<Awaited<ReturnType<typeof writePromptToStdin>>>(() => {
      /* a write that neither finishes nor errors */
    });

    const started = Date.now();
    const result = await awaitStdinDelivery(never, 25);

    // Bounded, and bounded on the safe side: an unobserved fate is not evidence
    // of a truncated prompt, so it must not fail the invocation either.
    expect(result).toEqual({ delivered: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('still reports a failure that arrives inside the grace', async () => {
    const failed = Promise.resolve({ delivered: false, errorCode: 'EPIPE' } as const);
    await expect(awaitStdinDelivery(failed, 5_000)).resolves.toEqual({
      delivered: false,
      errorCode: 'EPIPE'
    });
  });
});

describe('the recorded code is constrained at the source (security)', () => {
  /**
   * `errorCode` is the only part of a delivery failure that travels, and it
   * reaches both the audit payload and an operator-facing string the webview
   * renders. AGENTS.md forbids routing an unsanitized string to the UI, so the
   * shape is enforced where the value is created rather than trusted downstream.
   */
  it('accepts a real errno and rejects anything that is not one', async () => {
    const attempts: Array<{ thrown: unknown; expected: string }> = [
      { thrown: Object.assign(new Error('x'), { code: 'EPIPE' }), expected: 'EPIPE' },
      { thrown: Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }), expected: 'ERR_STREAM_DESTROYED' },
      // A long, markup-bearing, or lowercase value is replaced, not carried.
      { thrown: Object.assign(new Error('x'), { code: '<img src=x onerror=alert(1)>' }), expected: 'ERR_STDIN_WRITE' },
      { thrown: Object.assign(new Error('x'), { code: 'A'.repeat(4096) }), expected: 'ERR_STDIN_WRITE' },
      { thrown: Object.assign(new Error('x'), { code: 42 }), expected: 'ERR_STDIN_WRITE' },
      { thrown: 'a bare string', expected: 'ERR_STDIN_WRITE' },
      { thrown: null, expected: 'ERR_STDIN_WRITE' }
    ];

    for (const { thrown, expected } of attempts) {
      // A stdin whose write throws synchronously with the crafted value.
      const stdin = {
        on: () => undefined,
        write: () => { throw thrown; },
        end: () => undefined
      };
      const result = await writePromptToStdin(
        { stdin } as unknown as Parameters<typeof writePromptToStdin>[0],
        'a prompt'
      );
      expect(result.delivered).toBe(false);
      expect(result.errorCode).toBe(expected);
    }
  });
});
