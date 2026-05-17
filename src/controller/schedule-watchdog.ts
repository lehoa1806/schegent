import type { QueueManager } from '../queue/queue-manager';
import type { QueueRegistry } from '../queue/queue-registry';
import type { SanitizedLogger } from '../lib/logger';
import type { AuditEventType } from '../contracts/audit-events';

export interface QueueScheduleWatchdogDeps {
  readonly getRegistry: () => QueueRegistry;
  readonly queue: Pick<QueueManager, 'fireDueSchedules'>;
  readonly drain: () => Promise<void> | void;
  readonly isPrimary: () => boolean;
  readonly logger: Pick<SanitizedLogger, 'warn' | 'info'>;
  readonly audit?: {
    append(entry: {
      runId: string;
      phase: string;
      iteration: number;
      eventType: AuditEventType;
      payload: Record<string, unknown>;
      outcome: 'info' | 'success' | 'failure';
    }): Promise<unknown>;
  };
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Feature 051 — Decision recorded: KEEP this class as a slim no-op shim.
 * Reason: removing the construction site in `extension.ts` (and the
 * watchdog-managed `setRateLimitHandler` wiring around it) would force a
 * restructure of the activation flow for no behavioral gain — the tick()
 * already short-circuits to `[]` in single-queue mode (030). Reserved for
 * future re-introduction of scheduled queues; the test stays as guard.
 */
export class QueueScheduleWatchdog {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly deps: QueueScheduleWatchdogDeps,
    private readonly tickIntervalMs: number = 60_000
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  public start(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = this.setTimer(() => {
      void this.tick().catch((err) =>
        this.deps.logger.warn(`schedule-watchdog tick failed: ${(err as Error).message}`)
      );
    }, this.tickIntervalMs);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Feature 030 (US3, T047) — single-queue mode. The per-queue schedule
   * monitor is a strict no-op: `QueueRegistryEntry.schedule` is always
   * `null` after the v5 → v6 migration, so there is nothing to fire.
   * The class is kept as a slim shim so the extension activation flow
   * does not need restructuring; future re-introduction of multi-queue
   * schedules can restore the real polling loop.
   */
  public async tick(): Promise<readonly string[]> {
    if (this.disposed || !this.deps.isPrimary()) return [];
    // Feature 030 — schedule is always null on the single unified queue;
    // no entry can ever be "due". Returning [] early skips the registry
    // scan, the audit append, and the drain hop.
    return [];
  }
}
