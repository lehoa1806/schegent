/**
 * FR-R6-F03 / F07 / F13 (`finding-runner-diagnostic-write-promises`) — bounded serialized chain
 * for per-chunk verbose diagnostic tee writes so an invocation never accumulates an unbounded
 * `Promise<void>[]` array across sustained streams.
 *
 * Zero `vscode` imports.
 */
export const DIAGNOSTIC_WRITE_CHAIN_CONCURRENCY = 1;

export interface DiagnosticWriteChain {
  enqueue(task: () => Promise<void>): void;
  drain(): Promise<void>;
}

export function createDiagnosticWriteChain(): DiagnosticWriteChain {
  let tail: Promise<void> = Promise.resolve();
  const swallow = (): void => undefined;

  return {
    enqueue(task: () => Promise<void>): void {
      tail = tail.then(task, task).then(swallow, swallow);
    },
    drain(): Promise<void> {
      return tail;
    }
  };
}

