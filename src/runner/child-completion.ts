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
  waitForStdioClose: boolean,
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
