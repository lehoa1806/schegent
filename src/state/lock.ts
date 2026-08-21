import type { OwnershipClaim, WorkspaceStateStore } from './workspace-state';
import type { WorkspaceLock } from './workflow-run';
import { PRIMACY_RESOURCE } from './ownership-registry';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STALENESS_THRESHOLD_MS = 15_000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface SchedulerHandle {
  clear(): void;
}

export interface Scheduler {
  setInterval(fn: () => void, ms: number): SchedulerHandle;
}

export const systemScheduler: Scheduler = {
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    return {
      clear() {
        clearInterval(id);
      }
    };
  }
};

/**
 * The per-workspace window-primacy lease. Its tenure is activation-to-disposal:
 * acquired in `extension.ts` at activation, released at `dispose()`, and nowhere
 * else (feature 093, FR-028 / FR-032a).
 *
 * Deliberately **no** scope wrapper. Feature 034's `withLock(scope, fn)` released
 * in a `finally`, which made a window-scoped lease end at a Run-scoped moment:
 * it acquired idempotently per owner and kept no reference count, so
 * with two Runs in one window the first `finally` to run dropped primacy for
 * every Run in the window, and a rival window could claim the workspace while
 * this one was still executing. `RunDriver.drive()` was its last production
 * caller; removing that wrapper (and the `session.retain()` calls that existed
 * only to suppress its auto-release) left the method dead, and it is deleted
 * rather than kept, because a working wrapper is a working template for
 * reintroducing the defect. Reference-counting it was the rejected alternative —
 * it keeps the lease's lifetime implicit and has to be right at every release
 * site. Acquire with `tryAcquire()` and release only where the tenure genuinely
 * ends. `tests/integration/concurrent-run-execution.test.ts` (SC-009) pins this.
 *
 * ## Feature FR-R3-003 — where the decision is actually made
 *
 * Acquisition used to be a read of `KEYS.lock`, a staleness comparison, and a
 * write. That is three steps with no atomicity between them and, worse, over a
 * `Memento`, which is a per-extension-host cache: two windows opening the same
 * workspace each read `null` and each wrote themselves in. The decision now goes
 * through `store.ownership` — an exclusive-create on a generation-numbered file
 * under `.schegent/ownership/` — and the generation number it returns is a
 * fencing token this manager carries and re-checks at the point of effect.
 *
 * `KEYS.lock` survives as an advisory **mirror**, because `isForeignLockHeld()`
 * and `ownerOfRecord()` are synchronous and are read from projection paths that
 * cannot await. Every mirror read is additionally gated on this window holding a
 * fence, so a superseded window reads `false` from its own mirror rather than
 * the stale `true` the mirror alone would give.
 *
 * ## FR-R3-024 — which predicate a caller is entitled to
 *
 * The rule this class states is advisory-for-projection,
 * authoritative-for-decisions. It was stated and not enforced: six decision
 * sites read `isHeld()` — Clean All, the seven palette queue mutations, rerun
 * from history, retry active run, retry phase now, and the schedule watchdog's
 * promote. All six now read {@link WorkspaceLockManager.hasPrimacy}, and
 * `tests/lint/primacy-predicate-split.test.ts` holds that end state.
 *
 * `isHeld()` is retained, with **no host callers by design**. It is the mirror's
 * own accessor and the shape the invariant below is stated in; deleting it would
 * move that statement into a comment. A new caller is a decision to justify, not
 * a default to inherit.
 *
 * Why reading the mirror is safe at all: `heartbeat()` writes it through
 * `writeGuarded`, which refreshes the ownership record *before* the mirror write
 * and returns *before* it on a refused or unanswerable refresh, and
 * `tryAcquire()` writes it only after `acquire` returned. So the mirror can
 * never be fresher than the record, and because the reclaim rule in
 * `ownership-registry.ts` and `isHeld()`'s freshness check share one
 * `STALENESS_THRESHOLD_MS`, the mirror is already stale whenever a rival may
 * reclaim. `isHeld()` is therefore conservative: falsely negative is possible,
 * falsely positive is not. That ordering is an invariant, not an accident —
 * `tests/unit/state/mirror-write-ordering.test.ts` fails if it is reordered.
 */
export class WorkspaceLockManager {
  private readonly store: WorkspaceStateStore;
  private readonly ownerId: string;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private heartbeatHandle: SchedulerHandle | null = null;
  /**
   * The generation this window's claim was issued at, or `null` when it holds no
   * claim. Guarded operations carry it; a rejected check clears it.
   */
  private fence: number | null = null;

  constructor(
    store: WorkspaceStateStore,
    ownerId: string,
    clock: Clock = systemClock,
    scheduler: Scheduler = systemScheduler
  ) {
    this.store = store;
    this.ownerId = ownerId;
    this.clock = clock;
    this.scheduler = scheduler;
  }

  public get id(): string {
    return this.ownerId;
  }

  /**
   * Claim primacy, or report who holds it.
   *
   * A storage failure is reported as a refusal, not as a success: the rule is
   * refuse to acquire, never assume acquired. It is deliberately *not*
   * distinguished from "another window holds it" in the return shape, because
   * every caller does the same thing with both — `commands/resume.ts` raises
   * `LockHeldError` and the schedule path defers to the watchdog's next tick —
   * and a third arm would be a distinction no caller acts on.
   */
  public async tryAcquire(): Promise<{ acquired: boolean; ownerId: string }> {
    const now = this.clock.now();
    const outcome = await this.store.ownership.acquire(
      PRIMACY_RESOURCE,
      this.ownerId,
      now,
      STALENESS_THRESHOLD_MS
    );
    if (outcome.outcome !== 'acquired') {
      this.fence = null;
      const recorded = outcome.outcome === 'held' ? outcome.ownerId : this.ownerOfRecord();
      return { acquired: false, ownerId: recorded ?? this.ownerId };
    }
    this.fence = outcome.fence;
    const lock: WorkspaceLock = {
      ownerId: this.ownerId,
      acquiredAt: outcome.acquiredAt,
      heartbeatAt: now
    };
    await this.store.setLock(lock);
    this.startHeartbeat();
    return { acquired: true, ownerId: this.ownerId };
  }

  public isHeld(): boolean {
    if (this.fence === null) return false;
    const lock = this.store.getLock();
    if (!lock) return false;
    if (lock.ownerId !== this.ownerId) return false;
    return this.clock.now() - lock.heartbeatAt <= STALENESS_THRESHOLD_MS;
  }

  public isForeignLockHeld(): boolean {
    const lock = this.store.getLock();
    if (!lock) return false;
    if (lock.ownerId === this.ownerId) return false;
    return this.clock.now() - lock.heartbeatAt <= STALENESS_THRESHOLD_MS;
  }

  public ownerOfRecord(): string | null {
    return this.store.getLock()?.ownerId ?? null;
  }

  /** The fencing token this window's claim was issued at, for guarded writes. */
  public fenceOfRecord(): number | null {
    return this.fence;
  }

  /**
   * The authoritative answer to "is this window still primary", read from the
   * fenced record rather than the mirror (T300).
   *
   * Fails closed: a storage layer that cannot answer resolves to `false`, so a
   * mutating command is refused rather than admitted on an unverified claim.
   */
  public async hasPrimacy(): Promise<boolean> {
    const claim = this.claim();
    if (claim === null) return false;
    const verdict = await this.store.verifyClaim(claim);
    return verdict.outcome === 'valid';
  }

  /** This window's claim, or `null` when it holds none. */
  private claim(): OwnershipClaim | null {
    if (this.fence === null) return null;
    return { resource: PRIMACY_RESOURCE, ownerId: this.ownerId, fence: this.fence };
  }

  /**
   * Refresh the claim, and re-earn it when the record has moved on.
   *
   * A rejected beat means a rival reclaimed this window's generation while it was
   * stalled. The response is to drop the local fence and re-acquire — never to
   * call `release()`, which would end this window's tenure and stop the heartbeat
   * on a moment that is not the end of its tenure. If the rival still holds the
   * resource, the re-acquisition is refused and this window is simply not primary
   * until the rival goes away; if it does not, this window is primary again within
   * one beat, at a new generation.
   *
   * The mirror refresh goes through `writeGuarded` (T302) rather than being
   * written after a separate check, because the mirror is what every synchronous
   * reader trusts: a beat that lost the resource must not leave a *fresh*
   * `KEYS.lock` entry behind it. `refreshHeartbeatAt` folds the record's own
   * liveness refresh into the same call, so this costs one storage round trip and
   * not two.
   */
  public async heartbeat(): Promise<void> {
    const claim = this.claim();
    if (claim === null) return;
    const now = this.clock.now();
    const outcome = await this.store.writeGuarded(
      claim,
      () => {
        const lock = this.store.getLock();
        return this.store.setLock({
          ownerId: this.ownerId,
          acquiredAt: lock?.ownerId === this.ownerId ? lock.acquiredAt : now,
          heartbeatAt: now
        });
      },
      { refreshHeartbeatAt: now }
    );
    if (outcome.outcome === 'written') return;
    // Transient: keep the fence and try again on the next beat rather than
    // surrendering a claim that may well still be ours.
    if (outcome.outcome === 'unavailable') return;
    this.fence = null;
    await this.tryAcquire();
  }

  public async release(): Promise<void> {
    this.stopHeartbeat();
    const fence = this.fence;
    this.fence = null;
    if (fence !== null) {
      await this.store.ownership.release(PRIMACY_RESOURCE, this.ownerId, fence);
    }
    const lock = this.store.getLock();
    if (lock && lock.ownerId === this.ownerId) {
      await this.store.setLock(null);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle) return;
    this.heartbeatHandle = this.scheduler.setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeatHandle?.clear();
    this.heartbeatHandle = null;
  }
}
