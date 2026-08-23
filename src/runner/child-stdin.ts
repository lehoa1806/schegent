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
 * A synchronous `try` only ever saw a synchronous throw, and a pipe rarely
 * raises one: measured on Node v24.19.0, even a write to an already-destroyed
 * stream reports asynchronously. For a *live* stream whose peer has gone away
 * the failure likewise arrives later, on the stream's `'error'` event or the
 * write callback — after the `try` block has returned. No `stdin`
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
  /**
   * `true` iff the whole prompt was handed off without the write reporting an
   * error — that is, the stream accepted every byte and closed cleanly.
   *
   * Deliberately NOT "every byte the child read": nothing observable at this
   * layer can say that. Measured on Node v24.19.0, a prompt small enough to fit
   * the OS pipe buffer reports success even against a child that closes its
   * stdin having read nothing, because the bytes were accepted by the pipe. The
   * oracle is the write's own fate, and that is exactly the property the phase
   * runner acts on: a write that FAILED proves the backend answered a truncated
   * prompt, while a write that succeeded only means nothing went wrong here.
   */
  readonly delivered: boolean;
  /**
   * The stream error's `code` when delivery failed — an errno such as `EPIPE`.
   * Never any part of the prompt. `undefined` when delivery succeeded.
   */
  readonly errorCode?: string;
}

/**
 * The recorded code is constrained to an errno shape at the source.
 *
 * It is the only part of a delivery failure that travels, and it travels far: into
 * the `phase-end` audit payload and into the operator-facing warning string the
 * webview renders. Node's own errors carry a short SCREAMING_SNAKE errno
 * (`EPIPE`, `ERR_STREAM_DESTROYED`), so nothing is lost by insisting on that
 * shape — and insisting means an `'error'` carrying an attacker- or
 * model-influenced `code` from some future foreign stream cannot become an
 * unbounded string on a UI path. `AGENTS.md` forbids routing an unsanitized
 * string to the UI; this is that rule applied at the boundary rather than trusted
 * downstream.
 */
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]{0,31}$/;
const FALLBACK_CODE = 'ERR_STDIN_WRITE';

function errnoOf(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERRNO_SHAPE.test(code) ? code : FALLBACK_CODE;
}

const DELIVERED: StdinDeliveryResult = { delivered: true };

/**
 * How long a caller waits for the delivery result after the child has already
 * completed. Mirrors `STDIO_CLOSE_GRACE_MS` because it bounds the same hazard
 * from the other direction: a descendant that inherited the pipe.
 */
export const STDIN_DELIVERY_GRACE_MS = 2_000;

/**
 * Read the delivery result with a bound.
 *
 * The hazard: a pending write settles when the peer accepts the bytes or the pipe
 * breaks, and a DESCENDANT that inherited the stdin read end and never drains it
 * delays both. An unbounded `await` on the delivery promise after the child has
 * completed would then hang the invocation — the runner's idle timer has nothing
 * left to kill, and the run, with the queue behind it, stops for the workspace's
 * lifetime. That is the failure this feature exists to prevent, moved one await
 * later.
 *
 * Honesty about how load-bearing this is: measured on macOS / Node v24.19.0, the
 * pending write settles `ECANCELED` as soon as the child exits even with a
 * grandchild holding the read end, so on this platform the bound never fires. It
 * is kept as belt-and-braces rather than removed, because the platform behaviour
 * it relies on is not one this code controls and the cost of being wrong is a
 * wedged queue. Do not read the paragraph above as a reproduced failure — it is
 * the shape being guarded, not an observation.
 *
 * Expiry reports DELIVERED, not a failure: an unobserved fate is not evidence of
 * a truncated prompt, and the pre-feature behaviour was to never check at all.
 * The timer is unref'd so a bounded wait cannot by itself hold the host (or a
 * test runner) open.
 */
export function awaitStdinDelivery(
  delivery: Promise<StdinDeliveryResult>,
  graceMs = STDIN_DELIVERY_GRACE_MS
): Promise<StdinDeliveryResult> {
  return new Promise<StdinDeliveryResult>((resolve) => {
    const timer = setTimeout(() => resolve(DELIVERED), graceMs);
    // Cast, because a browser-shaped `setTimeout` returns a number with no
    // `unref` — the same guard `child-completion.ts` applies to its grace timer.
    (timer as { unref?: () => void }).unref?.();
    void delivery.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        // `writePromptToStdin` never rejects; a hostile double still must not
        // turn this bounded read into an unhandled rejection.
        clearTimeout(timer);
        resolve(DELIVERED);
      }
    );
  });
}

/**
 * Attach an `'error'` handler, then write the prompt and resolve once its fate is
 * known. Never rejects, and never leaves an `'error'` unhandled — the two
 * properties the previous shape lacked.
 *
 * An absent `child.stdin` and an empty prompt both resolve as delivered without
 * writing a byte: there is nothing to fail, and reporting a condition for them
 * would make every no-prompt invocation look broken. The empty-prompt path still
 * closes the stream, so it still attaches the handler first — see below.
 */
export function writePromptToStdin(
  child: ChildProcess,
  prompt: string
): Promise<StdinDeliveryResult> {
  const stdin = child.stdin;
  if (!stdin) return Promise.resolve(DELIVERED);
  if (prompt.length === 0) {
    // `end()` is still a stream operation and can still fail asynchronously
    // (EPIPE, ERR_STREAM_DESTROYED) against a peer that is already gone. With no
    // listener that is an uncaught exception — the H-04 crash, reached through
    // the one path that carries no prompt. The listener absorbs it and the
    // outcome stays `delivered`: nothing was sent, so there is nothing to report
    // and no invocation should be failed over it.
    try {
      stdin.on('error', () => { /* no prompt was written; nothing to classify */ });
      stdin.end();
    } catch {
      // A stream operation can also fail SYNCHRONOUSLY (a stdin that is not a
      // stream, a stream already finished). Nothing was written, so there is
      // still nothing to classify — but the throw must not escape, or the
      // no-prompt path fails the whole invocation where the previous
      // `try { … } catch { }` tolerated it.
    }
    return Promise.resolve(DELIVERED);
  }

  return new Promise<StdinDeliveryResult>((resolve) => {
    let settled = false;
    const settle = (result: StdinDeliveryResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Split `write(prompt)` then `end(cb)` rather than `end(prompt, cb)`. Both
    // forms were measured to report EPIPE on both channels — the `'error'` event
    // and the callback — so the oracle is unaffected; the split form additionally
    // keeps the two observable operations that existing runner tests assert on.
    //
    // Guarded, because a stream operation can also fail SYNCHRONOUSLY — a stdin
    // that is not a stream, a stream already finished, an invalid chunk. Left
    // unguarded that throw escapes the executor as a REJECTION, and both runners
    // read this result only after the child has completed, so a rejected promise
    // sits with no handler across the whole invocation: Node raises
    // `unhandledRejection` (fatal by default) and the invocation then throws
    // instead of reporting the condition — the same host-fatal shape H-04 is
    // about, reached through the one path that claims to be immune to it.
    let listenerAttached = false;
    try {
      // Attached BEFORE the first byte, and INSIDE the guard. This ordering is
      // the entire fix: a handler installed after the write can still miss the
      // event, and a handler that is never installed is an uncaught exception.
      // The listener stays attached for the stream's lifetime rather than being
      // removed on settle, because a late `'error'` must be absorbed too —
      // removing it would restore the original defect for any failure arriving
      // after the callback. It sits inside the `try` because attaching is itself
      // a call on a foreign object: a stdin that is not an EventEmitter (an
      // injected `spawnFn`'s double) throws here, and outside the guard that
      // throw escapes the executor as the rejection this helper promises never
      // to produce.
      // `err?.`, not `err.` — an `'error'` emitted with no argument (a foreign
      // stdin, an injected `spawnFn`'s double) would otherwise throw INSIDE this
      // listener, which is an uncaught exception: the exact host-fatal shape this
      // module exists to prevent, reached through its own handler.
      stdin.on('error', (err?: NodeJS.ErrnoException) => {
        settle({ delivered: false, errorCode: errnoOf(err) });
      });
      listenerAttached = true;
      stdin.write(prompt);
      stdin.end((err?: Error | null) => {
        if (err) {
          settle({
            delivered: false,
            errorCode: errnoOf(err)
          });
          return;
        }
        settle(DELIVERED);
      });
    } catch (err) {
      // `err as … | undefined` and `?.`, for the same reason the `'error'`
      // listener above reads `err?.code`: a foreign stdin can `throw` a
      // non-object, and dereferencing that inside this catch would escape the
      // executor as the rejection this helper promises never to produce.
      settle({
        delivered: false,
        errorCode: errnoOf(err)
      });
      // A throw from `write` skips the `end()` above and leaves the stream OPEN.
      // A backend that reads its prompt to EOF then never sees one: it produces
      // no output, so the runner's idle timer is the only thing left to end the
      // invocation, and that window is the phase timeout — up to 90 minutes of
      // waiting for a failure already classified on the line above. Closing it
      // here makes the child fail fast instead. Only when the `'error'` listener
      // is known to be attached, because `end()` can fail asynchronously too and
      // an unlistened `'error'` is the H-04 host crash; and guarded, because the
      // same foreign object that just threw can throw again.
      if (listenerAttached) {
        try {
          stdin.end();
        } catch {
          // Nothing left to close, and the outcome is already recorded.
        }
      }
    }
  });
}
