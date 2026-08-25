import type { ChildProcess } from 'node:child_process';

export const STDIO_CLOSE_GRACE_MS = 2_000;

export interface ChildCompletion {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdioCloseTimedOut: boolean;
  /**
   * FR-R3-047 — the child emitted a process-level `'error'`: most often a spawn
   * that never produced a process at all (ENOENT on a mistyped CLI path).
   * Absent means a process ran.
   *
   * Callers need this beside the prompt-delivery result because a child that
   * never started breaks the stdin pipe too — measured on Node v24.19.0, the
   * write fails `EPIPE` — and calling that a prompt-delivery failure names a
   * cause that is not the cause for the commonest misconfiguration there is.
   * The child's `'error'` is emitted before the write's fate is known, so a
   * caller reading this alongside the delivery result sees it set rather than
   * racing it.
   */
  readonly processError?: boolean;
}

/**
 * Wait for the subprocess and, when transcript teeing is active, give its
 * stdio pipes a bounded grace period to close after the process exits.
 *
 * Node's `close` event can be delayed indefinitely when a descendant keeps an
 * inherited pipe open. Waiting only for `exit` loses buffered output; waiting
 * only for `close` can strand the workflow queue. This helper races the two
 * lifecycle boundaries and destroys the local pipe readers after the bounded
 * grace so no late data can reach an already-finalized transcript sink.
 *
 * WHAT THE GRACE TOLERATES TODAY (FR-R3-083, re-measured 2026-08-25)
 *
 * `FR-R3-054` §5 left this open: cancellation now signals the whole process group,
 * and "descendant survival is what it exists to tolerate, so it may now be
 * tolerating something that no longer happens." Measured in
 * `tests/unit/runner/child-completion-tree.test.ts`, on darwin/arm64. The answer is
 * that the two paths differ, and the grace is KEPT:
 *
 *   - On the NORMAL-completion path the grace is still load-bearing. Nothing
 *     signals the group there -- `terminate()` is not involved when a phase simply
 *     finishes -- so a descendant that inherited the pipe still holds the write end
 *     after the child exits, and `'close'` does not arrive. This is the ordinary
 *     case, on every run that ends well.
 *
 *   - After a TREE KILL the grace is redundant: the descendant dies with the group
 *     and `'close'` arrives inside the window.
 *
 * Two things follow, and the second is the one worth carrying. Deleting the grace
 * because cancellation no longer needs it would have unbounded the path that still
 * does. And the tree kill only makes it redundant while the child is a GROUP
 * LEADER: a spawn path that omitted `processTreeSpawnOptions()` would degrade
 * silently to a direct-child kill, the descendant would keep the pipe, and this
 * grace would become the only bound on that path too. It is the same reason
 * `signalProcessTree` signals the group AND the child rather than choosing between
 * them.
 */
export function waitForChildCompletion(
  child: ChildProcess,
  /**
   * FR-R3-047 (M-01) — defaults to waiting, and every production call site now
   * omits it. Both runners used to pass `outputSink !== undefined`, so whether a
   * transcript sink existed decided whether this helper settled on `exit` or
   * waited for `close`: with capture off it stopped at `exit` and lost anything
   * buffered before `close`, which can include the terminal `{"type":"result"}`
   * line and the session id. The comment below already said that waiting only for
   * `exit` "loses buffered output"; the callers then did exactly that whenever an
   * operator turned capture off. A privacy setting must not select correctness.
   *
   * The parameter survives rather than being removed because this helper's own
   * tests in `tests/unit/runner/child-completion.test.ts` pass it explicitly and
   * exercise both settling boundaries. What makes the regression unrepresentable
   * is the lint guard forbidding a production call site from passing `false`, not
   * the shape of this signature.
   */
  waitForStdioClose = true,
  closeGraceMs = STDIO_CLOSE_GRACE_MS
): Promise<ChildCompletion> {
  return new Promise((resolve) => {
    let settled = false;
    let exitObserved = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let closeTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      if (closeTimer) clearTimeout(closeTimer);
    };
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      stdioCloseTimedOut: boolean,
      processError = false
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        signal,
        stdioCloseTimedOut,
        // Set only on the failing path, so the healthy shape is unchanged.
        ...(processError ? { processError: true } : {})
      });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitObserved = true;
      exitCode = code;
      exitSignal = signal;
      if (!waitForStdioClose) {
        settle(code, signal, false);
        return;
      }
      closeTimer = setTimeout(() => {
        // Settle and detach data listeners at the runner boundary before
        // destroying the local readers. Descendants may still hold their
        // write ends, but they can no longer extend this invocation forever.
        settle(exitCode, exitSignal, true);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, closeGraceMs);
      closeTimer.unref?.();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(
        exitObserved ? exitCode : code,
        exitObserved ? exitSignal : signal,
        false
      );
    };
    // A ChildProcess `'error'` is NOT synonymous with "no process ran". Node
    // emits it for a failed spawn, but also for a `kill()` that fails on a LIVE
    // child — which `terminate()` performs on every idle expiry and every
    // cancellation. `processError` is consumed as "there was no child" and is
    // used to suppress the prompt-delivery condition, so widening it to any
    // `'error'` would silently discard a real EPIPE truncation on a live
    // backend. `pid` is the exact discriminator: it is assigned only after the
    // spawn succeeded, so `undefined` means no process was ever created.
    //
    // The observed exit state is preserved for the same reason. An `'error'`
    // arriving inside the stdio-close grace, after `'exit'` already reported a
    // code, must not replace that code with `null` — the projection and the
    // `killed` checks both read `exitCode === null` as "terminated by signal".
    const onError = (): void =>
      settle(
        exitObserved ? exitCode : null,
        exitObserved ? exitSignal : null,
        false,
        child.pid === undefined
      );

    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
  });
}
