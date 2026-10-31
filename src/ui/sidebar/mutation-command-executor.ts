import type { CommandAckMessage } from './messages';
import { ACK_RETENTION_MAX_ENTRIES, ACK_RETENTION_MS } from '../../contracts/ack-retention';

export interface MutationCommandExecutorOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * FR-R4-F05 (C6) — how one gated command runs. `serialize` defaults to `true`:
 * the operation joins the promise chain and runs after every earlier serialized
 * one. `false` runs it at once, beside whatever is held, and keeps the identity
 * handling (in-flight join and replay), for a gated command that writes no
 * shared state the chain protects.
 */
export interface MutationExecuteOptions {
  readonly serialize?: boolean;
}

interface CachedAck {
  readonly ack: CommandAckMessage;
  readonly expiresAt: number;
}

/**
 * Serializes host mutations and makes correlation ids idempotent for a
 * bounded window. Read-only IPC bypasses this class and remains concurrent.
 * A gated command declared `concurrent` uses this class for its identity
 * handling only (`serialize: false`).
 */
export class MutationCommandExecutor {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, CachedAck>();
  private readonly inFlight = new Map<string, Promise<CommandAckMessage | null>>();

  constructor(options: MutationCommandExecutorOptions = {}) {
    this.ttlMs = options.ttlMs ?? ACK_RETENTION_MS;
    this.maxEntries = options.maxEntries ?? ACK_RETENTION_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  public async execute(
    correlationId: string,
    postAck: (ack: CommandAckMessage) => Thenable<boolean> | Promise<boolean>,
    operation: (
      captureAck: (ack: CommandAckMessage) => Thenable<boolean> | Promise<boolean>
    ) => Promise<void>,
    options: MutationExecuteOptions = {}
  ): Promise<void> {
    this.prune();
    const cached = this.cache.get(correlationId);
    if (cached && cached.expiresAt > this.now()) {
      await postAck(cached.ack);
      return;
    }

    const active = this.inFlight.get(correlationId);
    if (active) {
      const ack = await active;
      if (ack) await postAck(ack);
      return;
    }

    let resolveResult!: (ack: CommandAckMessage | null) => void;
    const result = new Promise<CommandAckMessage | null>((resolve) => {
      resolveResult = resolve;
    });
    this.inFlight.set(correlationId, result);

    const run = async (): Promise<void> => {
      // FR-R4-F05 (I10) — the FIRST ack an operation posts is the one remembered: it is
      // the one the original sender saw, and a repeat, whether it joins in flight or
      // replays from the cache, must be told the same thing. The last ack would let a
      // retry hear something the first attempt never first said.
      let firstAck: CommandAckMessage | null = null;
      try {
        await operation(async (ack) => {
          if (firstAck === null) {
            firstAck = ack;
            this.remember(correlationId, ack);
          }
          return postAck(ack);
        });
      } finally {
        resolveResult(firstAck);
        this.inFlight.delete(correlationId);
      }
    };

    if (options.serialize === false) {
      await run();
      return;
    }

    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    await next;
  }

  private remember(correlationId: string, ack: CommandAckMessage): void {
    this.cache.delete(correlationId);
    this.cache.set(correlationId, {
      ack: Object.freeze({ ...ack }),
      expiresAt: this.now() + this.ttlMs
    });
    this.prune();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
