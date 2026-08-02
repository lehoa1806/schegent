import type { CommandAckMessage } from './messages';

export interface MutationCommandExecutorOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface CachedAck {
  readonly ack: CommandAckMessage;
  readonly expiresAt: number;
}

/**
 * Serializes host mutations and makes correlation ids idempotent for a
 * bounded window. Read-only IPC bypasses this class and remains concurrent.
 */
export class MutationCommandExecutor {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, CachedAck>();
  private readonly inFlight = new Map<string, Promise<CommandAckMessage | null>>();

  constructor(options: MutationCommandExecutorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  public async execute(
    correlationId: string,
    postAck: (ack: CommandAckMessage) => Thenable<boolean> | Promise<boolean>,
    operation: (
      captureAck: (ack: CommandAckMessage) => Thenable<boolean> | Promise<boolean>
    ) => Promise<void>
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
      let finalAck: CommandAckMessage | null = null;
      try {
        await operation(async (ack) => {
          finalAck = ack;
          this.remember(correlationId, ack);
          return postAck(ack);
        });
      } finally {
        resolveResult(finalAck);
        this.inFlight.delete(correlationId);
      }
    };

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
