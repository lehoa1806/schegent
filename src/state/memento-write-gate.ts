import type { SanitizedLogger } from '../lib/logger';
import type { Scheduler } from './lock';
import { OWNERSHIP_VERIFY_DEADLINE_MS } from './ownership-claim';

/**
 * FR-R5-F09 (F-35, NU-02) — deadline for any `memento.update` inside the serialized store chains,
 * and the typed error raised when a write hangs past it or when subsequent writes hit the
 * quarantined writer.
 */
export const MEMENTO_WRITE_DEADLINE_MS = OWNERSHIP_VERIFY_DEADLINE_MS;

export type StorageWriteFailureReason =
  | 'storage-write-timeout'
  | 'storage-write-quarantined';

export class StorageWriteQuarantinedError extends Error {
  public readonly reason: StorageWriteFailureReason;

  constructor(reason: StorageWriteFailureReason, message: string) {
    super(message);
    this.name = 'StorageWriteQuarantinedError';
    this.reason = reason;
  }
}

/** The one Memento call the gate makes. */
export interface MementoWriter {
  update(key: string, value: unknown): Thenable<void>;
}

type WriteOutcome =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'error'; readonly error: unknown };

/**
 * Bounds every Memento write by `MEMENTO_WRITE_DEADLINE_MS` and quarantines the writer when one
 * runs past it, so further writes fail fast instead of queueing behind a hung store.
 *
 * Review gap GC-04 (2026-11-12) — the quarantine used to hold until a destructive reset. It now
 * ends when the write that caused it settles, landed or failed: the store has answered again, and
 * reads go straight to the Memento, so there is no second copy for the late write to disagree
 * with. Each quarantine is an identity token, so a late settle from one that a reset already
 * lifted cannot lift a newer one.
 */
export class MementoWriteGate {
  private quarantine: object | null = null;

  constructor(
    private readonly memento: MementoWriter,
    private readonly scheduler: Scheduler,
    private readonly logger: SanitizedLogger | null
  ) {}

  public isQuarantined(): boolean {
    return this.quarantine !== null;
  }

  /** Clears the quarantine outright; reset and interrupted-reset completion call this. */
  public lift(): void {
    this.quarantine = null;
  }

  public async write(key: string, value: unknown): Promise<void> {
    if (this.quarantine !== null) {
      throw new StorageWriteQuarantinedError(
        'storage-write-quarantined',
        `Workspace state write refused for ${key}: storage writer is quarantined after an earlier write timed out`
      );
    }
    const settled = this.startWrite(key, value);
    const raced = await this.raceDeadline(settled);
    if (raced.outcome === 'ok') return;
    if (raced.outcome === 'error') throw raced.error;
    const token = {};
    this.quarantine = token;
    this.logger?.warn('workspace state write timed out; quarantining state writer', {
      key,
      deadlineMs: MEMENTO_WRITE_DEADLINE_MS
    });
    void settled.then((late) => {
      this.liftOnLateSettle(token, key, late.outcome);
    });
    throw new StorageWriteQuarantinedError(
      'storage-write-timeout',
      `Workspace state write timed out after ${MEMENTO_WRITE_DEADLINE_MS}ms for ${key}; state writer is now quarantined`
    );
  }

  private startWrite(key: string, value: unknown): Promise<WriteOutcome> {
    try {
      return Promise.resolve(this.memento.update(key, value)).then(
        () => ({ outcome: 'ok' as const }),
        (error: unknown) => ({ outcome: 'error' as const, error })
      );
    } catch (error) {
      return Promise.resolve({ outcome: 'error' as const, error });
    }
  }

  private async raceDeadline(
    settled: Promise<WriteOutcome>
  ): Promise<WriteOutcome | { readonly outcome: 'timeout' }> {
    let handle: { clear(): void } | null = null;
    const clear = (): void => {
      if (handle !== null) {
        handle.clear();
        handle = null;
      }
    };
    const raced = await Promise.race([
      settled,
      new Promise<{ readonly outcome: 'timeout' }>((resolve) => {
        handle = this.scheduler.setInterval(() => {
          clear();
          resolve({ outcome: 'timeout' });
        }, MEMENTO_WRITE_DEADLINE_MS);
      })
    ]);
    clear();
    return raced;
  }

  private liftOnLateSettle(token: object, key: string, outcome: WriteOutcome['outcome']): void {
    if (this.quarantine !== token) return;
    this.quarantine = null;
    this.logger?.warn('workspace state write settled after its deadline; state writer resumed', {
      key,
      outcome
    });
  }
}
