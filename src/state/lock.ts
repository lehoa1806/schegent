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
 * The per-workspace window-primacy lease. Its tenure ends at disposal: first
 * claimed from `extension.ts` at activation, released at `dispose()`, and
 * released nowhere else (feature 093, FR-028 / FR-032a).
 *
 * FR-032 (BUG-001) amends the START of that tenure and nothing else. A window
 * that loses the activation election keeps contesting on its own interval and
 * may become primary later, so acquisition is no longer a single moment —
 * `tick()` carries why, and `onPrimacyGained` is how anyone finds out. The
 * release side is untouched: there is still exactly one release site, and a
 * contending window's interval is stopped by the same `release()` that stops a
 * primary window's heartbeat.
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
 * `refreshLockMirrorGuarded`, which refreshes the ownership record *before* the mirror write
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
  /** FR-R3-103 — listeners for fence loss; see `onFenceLost`. */
  private readonly fenceLostListeners = new Set<() => void>();

  /** FR-032 — listeners for a primacy gain won on a tick; see `onPrimacyGained`. */
  private readonly primacyGainedListeners = new Set<
    (result: { acquired: boolean; ownerId: string }) => void
  >();

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
   *
   * FR-032 (BUG-001) — THE INTERVAL IS ARMED ON BOTH BRANCHES. It used to be
   * armed only where the claim succeeded, which gave a refused window no clock
   * of its own: it asked once, at activation, inside the fifteen seconds during
   * which a dead host's lease still reads fresh, lost correctly, and never asked
   * again. `tick()` is what the interval runs, and it is the branch that turns
   * this from a heartbeat into a heartbeat-or-contest.
   *
   * This method stays SILENT about the outcome either way. Its first caller is
   * activation, which reads the returned result directly and has no subscriber
   * yet, and its second is `heartbeat()`'s inline re-acquisition, which is a
   * window regaining a fence it never stopped driving under. Announcing either
   * would install recovery over a window that already has it. `tick()` owns the
   * notification because `tick()` is the only site where a gain is news.
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
      this.startHeartbeat();
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
   * The mirror refresh goes through `refreshLockMirrorGuarded` (T302, reshaped by
   * FR-R3-077 T1041) rather than being written after a separate check, because
   * the mirror is what every synchronous reader trusts: a beat that lost the
   * resource must not leave a *fresh* `KEYS.lock` entry behind it.
   * `refreshHeartbeatAt` folds the record's own liveness refresh into the same
   * call, so this costs one storage round trip and not two.
   *
   * What changed in T1041 is the shape, not the protocol: the verify used to
   * happen and then a callback was awaited — two operations — and it now happens
   * inside the same serialized link that writes the mirror.
   */
  public async heartbeat(): Promise<void> {
    const claim = this.claim();
    if (claim === null) return;
    const now = this.clock.now();
    const lock = this.store.getLock();
    const outcome = await this.store.refreshLockMirrorGuarded(
      claim,
      {
        ownerId: this.ownerId,
        acquiredAt: lock?.ownerId === this.ownerId ? lock.acquiredAt : now,
        heartbeatAt: now
      },
      { refreshHeartbeatAt: now }
    );
    if (outcome.outcome === 'written') return;
    // Transient: keep the fence and try again on the next beat rather than
    // surrendering a claim that may well still be ours.
    if (outcome.outcome === 'unavailable') return;
    this.fence = null;
    // FR-R3-103 (FR-046) — tell someone the fence is gone.
    //
    // THE HALF THIS CLOSES. Losing the fence stopped the STATE STORE from committing — the
    // beat nulls the fence and re-acquires, and the commit-point check refuses writes in
    // between. It did nothing about the CHILD. No path from fence loss reached an
    // `AbortController` or a process tree, so a superseded window's subprocess went on
    // mutating the shared checkout for as long as it liked: fencing turned its *state* writes
    // into refusals while its *file* writes landed. Attribution and checkpoints detect that;
    // nothing prevented it.
    //
    // A CALLBACK, not a direct abort. This class knows about leases and storage, and giving it
    // a reference to a driver or a process tree would make the lock manager the place where
    // "what does supersession mean" is decided. The driver registers what it wants done; this
    // reports the fact.
    //
    // Fired BEFORE `tryAcquire()`. Re-acquisition may succeed within the same beat, and a
    // window that is primary again must not have swallowed the fact that it briefly was not —
    // its child ran unfenced for that interval either way.
    //
    // Errors are swallowed deliberately: a listener that throws must not prevent the
    // re-acquisition below, or one bad callback would leave the window permanently
    // non-primary.
    for (const listener of this.fenceLostListeners) {
      try {
        listener();
      } catch {
        /* a listener must not be able to stop the re-acquisition */
      }
    }
    await this.tryAcquire();
  }

  /**
   * What the interval runs: beat if this window is primary, contest if it is not.
   *
   * FR-032 (BUG-001) — THE ELECTION HAS A LIFETIME. Primacy used to be decided
   * once, at activation, and a window that lost it stayed non-primary until VS
   * Code restarted. The losing case is not rare and not benign: an incumbent
   * host that dies without releasing leaves a lease that reads fresh for
   * `STALENESS_THRESHOLD_MS`, so a replacement window opened inside that window
   * contests, loses *correctly*, and then never asks again — the reported
   * instance sat there for 6h28m with persisted Runs nobody was driving.
   *
   * BRANCHING ON THE FENCE, not on a remembered verdict. `fence === null` is the
   * authoritative statement "this window holds no claim", maintained by every
   * path that can end one — the refused acquire, the rejected beat — so the
   * branch cannot disagree with the record the way a cached boolean could.
   *
   * The contest costs one `ownership.acquire` per beat from a non-primary
   * window, at exactly the rate a primary window already writes its heartbeat.
   * That symmetry is the point: the protocol's write rate is unchanged by who
   * wins, so a workspace with two windows open costs what a workspace with one
   * window and one crashed host has always cost.
   *
   * THE NOTIFICATION IS ONLY HERE. `tryAcquire()`'s other two callers are
   * activation and the fence-loss path, and neither is a gain a subscriber
   * should act on; SC-011 pins the count at exactly one across a gain → loss →
   * gain cycle, which holds by construction because this is the only site.
   * Listener errors are swallowed for the reason `heartbeat()` gives for its
   * own: one bad callback must not leave the window permanently non-primary.
   */
  public async tick(): Promise<void> {
    if (this.fence !== null) {
      await this.heartbeat();
      return;
    }
    const result = await this.tryAcquire();
    if (!result.acquired) return;
    for (const listener of this.primacyGainedListeners) {
      try {
        listener(result);
      } catch {
        /* a listener must not be able to undo a win this window already holds */
      }
    }
  }

  /**
   * Register a callback for the moment this window loses its fence.
   *
   * FR-R3-103 (FR-046). The driver uses it to run the same abort ladder an operator cancel
   * uses. Returns a disposer, because a window that registered and then disposed must not keep
   * a dead driver reachable from a long-lived lock manager.
   */
  public onFenceLost(listener: () => void): { dispose: () => void } {
    this.fenceLostListeners.add(listener);
    return { dispose: () => this.fenceLostListeners.delete(listener) };
  }

  /**
   * Register a callback for the moment this window WINS primacy on a tick.
   *
   * FR-032 (BUG-001). `stage2-producers.ts` uses it to install the five recovery
   * producers it declined to install at activation, and `primacy-gain-wiring.ts`
   * is the one subscriber.
   *
   * IT CARRIES THE RESULT, where `onFenceLost` carries nothing. That asymmetry is
   * deliberate rather than an inconsistency: a fence loss is a fact with no
   * payload — the window is no longer primary and every subscriber does the same
   * thing about it — whereas every recovery installer is gated on the election
   * result, so a subscriber handed nothing would have to re-read a verdict from
   * somewhere, and the only verdict in scope at the producers is the one
   * activation recorded, which reads `acquired: false` in precisely the case
   * this event exists to repair.
   *
   * Returns a disposer, for `onFenceLost`'s stated reason: a window that
   * registered and then disposed must not keep a dead graph reachable from a
   * long-lived lock manager.
   */
  public onPrimacyGained(
    listener: (result: { acquired: boolean; ownerId: string }) => void
  ): { dispose: () => void } {
    this.primacyGainedListeners.add(listener);
    return { dispose: () => this.primacyGainedListeners.delete(listener) };
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
      void this.tick();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeatHandle?.clear();
    this.heartbeatHandle = null;
  }
}
