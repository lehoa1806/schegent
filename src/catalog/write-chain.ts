// Feature 254 (FR-R4-F07, W1; research R20; data-model §8; FR-037) — the store's write chain.
//
// A store's write reads the manifest, builds the next one from it, and replaces it. Two writes through one
// store that overlap both read the same manifest, and the second rename erases the first's entry: both
// callers are told `saved`, and one definition is gone. The per-definition gate does not catch it, because
// the two writes are of DIFFERENT definitions and each passes its own. The fix is that no write through one
// store starts until the previous one has settled, so each loads the manifest the one before it left.
//
// The chain is one `Promise<void>` tail. It is the shape of `mutation-command-executor.ts`
// (`chain.then(run, run)`), held per store and not per router: the router's chain covers only commands
// dispatched through that router, and FR-037 is a property of the store, the one object every in-process
// writer shares.
//
// What this does NOT do, stated so the module is not read as more than it is. It orders writes within one
// store, in one process. It is not a lock: there is no lock file and no lock directory (FR-038), and a
// second process, or a second store built on the same directory, is not ordered by it. That case is
// covered by the host's one-store-per-directory claim (`catalog-store-wiring.ts`) and the documented
// single-writer precondition (`docs/architecture/durability-decision.md`).
//
// Pure: no I/O, no host API, so `src/catalog/` stays pure (FR-057, FR-058).

/** Serialises asynchronous operations, in the order they were issued. */
export interface WriteChain {
  /**
   * Run `operation` after every earlier operation on this chain has settled.
   *
   * The caller gets the operation's own promise: its result, or its own rejection. A rejection is not
   * swallowed for the caller and does not stop the chain.
   */
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createWriteChain(): WriteChain {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      // `then(operation, operation)`: the operation runs whether the previous one fulfilled or rejected,
      // and a synchronous throw becomes a rejection of this operation's promise, not an exception here.
      const result = tail.then(operation, operation);
      // The stored tail swallows rejections ONLY to keep the chain alive for the next writer. `result`,
      // which the caller holds, still rejects: nothing is hidden from the caller who issued the write.
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  };
}
