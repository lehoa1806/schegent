import type { ChildProcess } from 'node:child_process';

export const STDIO_CLOSE_GRACE_MS = 2_000;

export interface ChildCompletion {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdioCloseTimedOut: boolean;
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
   * tests pass it explicitly and the feature promised to edit no existing test.
   * What makes the regression unrepresentable is the lint guard forbidding a
   * production call site from passing `false`, not the shape of this signature.
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
      stdioCloseTimedOut: boolean
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code, signal, stdioCloseTimedOut });
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
    const onError = (): void => settle(null, null, false);

    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
  });
}
