import type { ChildProcess } from 'node:child_process';

/**
 * FR-R3-047 / H-04 — the one place a prompt is written to a child's stdin.
 *
 * WHY THIS MODULE EXISTS
 *
 * Both runners used to write the prompt like this:
 *
 *     try { child.stdin?.write(prompt); child.stdin?.end(); } catch { }
 *
 * `write()` throws synchronously only for an already-destroyed stream. For a
 * *live* stream whose peer has gone away, the failure arrives later, on the
 * stream's `'error'` event — after the `try` block has returned. No `stdin`
 * `'error'` listener existed anywhere in `src` (verified count: zero), so Node
 * treated it as an uncaught exception. In the extension host that is fatal to
 * the HOST, not to the invocation: the queue, every concurrent Run, and any
 * unsaved projection go with it. Reproduced on Node v24.19.0 with an 8 MiB
 * prompt against a child that destroys its stdin.
 *
 * Two runners needed identical semantics and a guard needs one thing to point
 * at, which is why this is a module rather than two inline fixes. Inlining it
 * twice is how the two write sites drifted apart in the first place.
 *
 * THE ORACLE, AND THE ONE THAT LOOKS RIGHT AND IS NOT
 *
 * Delivery success is decided by the write-completion callback. It is NOT
 * decided by `stdin.bytesWritten`: measured on Node v24.19.0, that counter
 * reaches the full prompt length *while EPIPE fires*, because it counts bytes
 * handed to the stream rather than bytes the peer accepted. A byte-count
 * comparison cannot distinguish a delivered prompt from a discarded one at all.
 *
 * ONE FAILURE NOTIFIES TWICE
 *
 * The stream's `'error'` event and the `end()` callback both fire, with the same
 * `EPIPE`. Recording is therefore idempotent: the first observation wins and
 * every later one is absorbed, including one arriving after the caller has moved
 * on. Without that, one failure becomes two records.
 *
 * WHAT IS NEVER CARRIED
 *
 * Any byte of the prompt. It is operator content and may contain anything, so
 * the result carries a classification and an errno — never the payload.
 */

/** Outcome of writing a prompt to a child's stdin. */
export interface StdinDeliveryResult {
  /** `true` iff every byte reached the child before its stdin closed. */
  readonly delivered: boolean;
  /**
   * The stream error's `code` when delivery failed — an errno such as `EPIPE`.
   * Never any part of the prompt. `undefined` when delivery succeeded.
   */
  readonly errorCode?: string;
}

const DELIVERED: StdinDeliveryResult = { delivered: true };

/**
 * Attach an `'error'` handler, then write the prompt and resolve once its fate is
 * known. Never rejects, and never leaves an `'error'` unhandled — the two
 * properties the previous shape lacked.
 *
 * An absent `child.stdin` and an empty prompt both resolve as delivered without
 * writing: there is nothing to fail, and reporting a condition for them would
 * make every no-prompt invocation look broken.
 */
export function writePromptToStdin(
  child: ChildProcess,
  prompt: string
): Promise<StdinDeliveryResult> {
  const stdin = child.stdin;
  if (!stdin) return Promise.resolve(DELIVERED);
  if (prompt.length === 0) {
    stdin.end();
    return Promise.resolve(DELIVERED);
  }

  return new Promise<StdinDeliveryResult>((resolve) => {
    let settled = false;
    const settle = (result: StdinDeliveryResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Attached BEFORE the first byte. This ordering is the entire fix: a handler
    // installed after the write can still miss the event, and a handler that is
    // never installed is an uncaught exception. The listener stays attached for
    // the stream's lifetime rather than being removed on settle, because a late
    // `'error'` must be absorbed too — removing it would restore the original
    // defect for any failure arriving after the callback.
    stdin.on('error', (err: NodeJS.ErrnoException) => {
      settle({ delivered: false, errorCode: err.code ?? 'ERR_STDIN_WRITE' });
    });

    // Split `write(prompt)` then `end(cb)` rather than `end(prompt, cb)`. Both
    // forms were measured to report EPIPE on both channels — the `'error'` event
    // and the callback — so the oracle is unaffected; the split form additionally
    // keeps the two observable operations that existing runner tests assert on.
    stdin.write(prompt);
    stdin.end((err?: Error | null) => {
      if (err) {
        settle({
          delivered: false,
          errorCode: (err as NodeJS.ErrnoException).code ?? 'ERR_STDIN_WRITE'
        });
        return;
      }
      settle(DELIVERED);
    });
  });
}
