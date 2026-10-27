// Feature 092 (T048, US2, FR-031/FR-033) — the per-queue execution lease.
//
// This is the relaxed half of the lock split described in
// specs/092-multi-queue-concurrency/contracts/concurrent-drain-and-leases.md §2.
// `WorkspaceLockManager` keeps its exact semantics and its zero diff because it
// feeds `WorkflowSnapshot.isPrimary` and therefore every mutating IPC gate; a
// window must not become primary merely by draining a queue. So execution
// exclusion moves here, where the cardinality rule is different:
//
//   Window primacy : one holder per workspace   (state/lock.ts, unchanged)
//   Execution      : one holder per QUEUE, N across queues   (this file)
//
// Everything else is deliberately the same shape as the lock — same 5 s
// heartbeat, same 15 s staleness, same reclaim-on-stale terms — and the
// constants are imported rather than restated so the two cannot drift.

import { HEARTBEAT_INTERVAL_MS, STALENESS_THRESHOLD_MS, systemClock, systemScheduler } from './lock';
import type { Clock, Scheduler, SchedulerHandle } from './lock';
import {
  fallbackOwnershipRegistry,
  queueResource,
  releaseOutcomeOf,
  type OwnershipRegistry,
  type ReleaseOutcome
} from './ownership-registry';
import { OWNERSHIP_VERIFY_DEADLINE_MS, verifyWithin } from './ownership-claim';
import type { OwnershipClaim } from './workspace-state';
import type { SanitizedLogger } from '../lib/logger';

/** One queue's execution claim. Persisted under `KEYS.executionLeases`. */
export interface ExecutionLease {
  readonly queueId: string;
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

/** Why a claim was lost: the beat was rejected, or a commit was refused as superseded. */
export type ClaimLostReason = 'superseded' | 'rejected';

/**
 * FR-R4-F01 (data-model §1) — what this window knows about its claim on one queue.
 *
 * `lost` is the state a rejected heartbeat or a superseded commit leaves behind.
 * It keeps the generation the claim was issued at, so the commit point is handed
 * the OLD fence and refuses it; deleting the fence instead made the claim read as
 * "never held", which the store admitted as an unfenced write. In memory only: a
 * restart starts every queue at `never-held` (spec D6).
 */
export type ClaimTenure =
  | { readonly state: 'held'; readonly claim: OwnershipClaim }
  | {
      readonly state: 'lost';
      readonly claim: OwnershipClaim;
      readonly reason: ClaimLostReason;
      readonly lostAt: number;
    }
  | { readonly state: 'released' }
  | { readonly state: 'never-held' };

/**
 * The store surface the manager needs. Narrow on purpose: the lease manager
 * owns the staleness arithmetic, the store owns persistence.
 *
 * `ownership` is optional because this port predates feature FR-R3-003 and is
 * implemented by hand-rolled doubles that carry no registry. Absent, the manager
 * falls back to one memoized on the store object, so two managers over one double
 * still contend — see `fallbackOwnershipRegistry`. A real `WorkspaceStateStore`
 * always supplies it.
 */
export interface ExecutionLeaseStore {
  getExecutionLeases(): Record<string, ExecutionLease>;
  setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void>;
  readonly ownership?: OwnershipRegistry;
}

/**
 * Feature FR-R3-003 — acquisition moved to the fenced registry for the same
 * reason as window primacy: `KEYS.executionLeases` is a `Memento` entry, so the
 * read-decide-write it used to perform arbitrated nothing between two extension
 * hosts. Two windows could each claim the same queue and each start a Run on the
 * one shared working tree.
 *
 * The mirror under `KEYS.executionLeases` is retained and is advisory, exactly as
 * `KEYS.lock` is for primacy: the synchronous readers below need it, and each is
 * gated on this window holding the queue's fence.
 */
export class ExecutionLeaseManager {
  private readonly store: ExecutionLeaseStore;
  private readonly ownerId: string;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private heartbeatHandle: SchedulerHandle | null = null;
  /** FR-R3-055 — the beat currently in flight, so a release can drain it. */
  private inFlightBeat: Promise<void> | null = null;
  /** Queue id → the generation this window's claim on it was issued at. */
  private readonly fences = new Map<string, number>();
  /** Queue id → the claim this window lost, at the generation it was issued at. */
  private readonly lost = new Map<
    string,
    { readonly claim: OwnershipClaim; readonly reason: ClaimLostReason; readonly lostAt: number }
  >();
  /** Queues this window gave back. Only a `tryAcquire` that returns `acquired` leaves this set. */
  private readonly released = new Set<string>();
  private readonly claimLostListeners = new Set<
    (queueId: string, reason: ClaimLostReason) => void
  >();

  constructor(
    store: ExecutionLeaseStore,
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
   * Read at call time rather than captured in the constructor: a store points its
   * ownership storage at the workspace during activation stage 2, which may be
   * after this manager was built.
   */
  private get ownership(): OwnershipRegistry {
    return this.store.ownership ?? fallbackOwnershipRegistry(this.store);
  }

  /**
   * Claim one queue. Succeeds when the queue is unclaimed, already ours, or
   * held by an owner whose heartbeat has gone stale — the same three cases the
   * workspace lock admits, applied per queue instead of per workspace.
   *
   * A storage failure is a refusal on the same terms as contention: the drain's
   * step 6 reads `acquired: false` as "another window has this queue", waits, and
   * tries again on the next sweep, which is the correct response to both.
   */
  public async tryAcquire(queueId: string): Promise<{ acquired: boolean; ownerId: string }> {
    const now = this.clock.now();
    const outcome = await this.ownership.acquire(
      queueResource(queueId),
      this.ownerId,
      now,
      STALENESS_THRESHOLD_MS
    );
    if (outcome.outcome !== 'acquired') {
      this.fences.delete(queueId);
      const recorded =
        outcome.outcome === 'held' ? outcome.ownerId : this.ownerOfRecord(queueId);
      return { acquired: false, ownerId: recorded ?? this.ownerId };
    }
    this.fences.set(queueId, outcome.fence);
    this.lost.delete(queueId);
    this.released.delete(queueId);
    await this.store.setExecutionLease(queueId, {
      queueId,
      ownerId: this.ownerId,
      acquiredAt: outcome.acquiredAt,
      heartbeatAt: now
    });
    this.startHeartbeat();
    return { acquired: true, ownerId: this.ownerId };
  }

  public isHeld(queueId: string): boolean {
    if (!this.fences.has(queueId)) return false;
    const lease = this.store.getExecutionLeases()[queueId];
    if (!lease || lease.ownerId !== this.ownerId) return false;
    return !this.isStale(lease, this.clock.now());
  }

  /** The fencing token this window's claim on `queueId` was issued at. */
  public fenceOfRecord(queueId: string): number | null {
    return this.fences.get(queueId) ?? null;
  }

  /**
   * FR-R3-077 (T1037) — this window's claim on `queueId`, as a commit point wants
   * it, or `null` when this window holds none.
   *
   * Deliberately built from the REMEMBERED fence rather than from the record: a
   * host whose lease was reclaimed while it was stalled still carries the
   * generation it was issued, and handing that stale generation to the commit
   * point is precisely how the commit gets refused. A claim rebuilt from the
   * current record would launder the staleness away and the fence would verify
   * every time.
   *
   * FR-R4-F01 — that holds after the loss is known too. A claim this window LOST
   * is still answered, at its old generation: returning `null` there made the
   * commit point treat a loser exactly like a window that never held the queue,
   * and admit its write unfenced.
   */
  public claimFor(queueId: string): OwnershipClaim | null {
    const fence = this.fences.get(queueId);
    if (fence !== undefined) return this.claimAt(queueId, fence);
    return this.lost.get(queueId)?.claim ?? null;
  }

  /** FR-R4-F01 (contract C1) — what this window knows about its claim on `queueId`. */
  public tenureOf(queueId: string): ClaimTenure {
    const fence = this.fences.get(queueId);
    if (fence !== undefined) return { state: 'held', claim: this.claimAt(queueId, fence) };
    const lost = this.lost.get(queueId);
    if (lost !== undefined) {
      return { state: 'lost', claim: lost.claim, reason: lost.reason, lostAt: lost.lostAt };
    }
    return this.released.has(queueId) ? { state: 'released' } : { state: 'never-held' };
  }

  /**
   * FR-R4-F01 (contract C2 G8) — the store saw a commit refused `fence-superseded`
   * before the heartbeat did. Moves a HELD queue to lost; any other state is left
   * as it is, so a repeat is a no-op and a queue never held stays never held.
   *
   * Nothing here is awaited, and neither another queue nor window primacy is
   * touched (hard rule 4).
   */
  public markLost(queueId: string, reason: 'superseded'): void {
    const fence = this.fences.get(queueId);
    if (fence === undefined) return;
    this.moveToLost(queueId, fence, reason);
    this.stopHeartbeatIfIdle();
  }

  /**
   * FR-R4-F01 (contract C1 G2) — told once per transition into lost, for one
   * queue. A throwing listener is swallowed. The shape is
   * `WorkspaceLockManager.onFenceLost`'s: the disposer is what stops delivery.
   */
  public onClaimLost(listener: (queueId: string, reason: ClaimLostReason) => void): {
    dispose(): void;
  } {
    this.claimLostListeners.add(listener);
    return { dispose: () => void this.claimLostListeners.delete(listener) };
  }

  private claimAt(queueId: string, fence: number): OwnershipClaim {
    return { resource: queueResource(queueId), ownerId: this.ownerId, fence };
  }

  private moveToLost(queueId: string, fence: number, reason: ClaimLostReason): void {
    this.fences.delete(queueId);
    this.lost.set(queueId, {
      claim: this.claimAt(queueId, fence),
      reason,
      lostAt: this.clock.now()
    });
    for (const listener of [...this.claimLostListeners]) {
      try {
        listener(queueId, reason);
      } catch {
        // A listener failing must not decide whether the loss is recorded, or
        // whether the next listener hears of it.
      }
    }
  }

  /**
   * The authoritative answer to "does this window still hold `queueId`", read from
   * the fenced record rather than the mirror (T301).
   *
   * Fails closed: storage that cannot answer resolves to `false`, so the drain
   * declines to admit rather than starting a Run on an unverified claim.
   */
  public async hasLease(queueId: string): Promise<boolean> {
    const fence = this.fences.get(queueId);
    if (fence === undefined) return false;
    // FR-R4-F01 (FR-021) — bounded, so the drain's admission check refuses on an ownership record
    // that never answers instead of waiting on it. The heartbeat is a write and stays unbounded.
    const verdict = await verifyWithin(
      this.ownership,
      queueResource(queueId),
      this.ownerId,
      fence,
      OWNERSHIP_VERIFY_DEADLINE_MS,
      this.scheduler
    );
    return verdict.outcome === 'valid';
  }

  public isForeignLeaseHeld(queueId: string): boolean {
    const lease = this.store.getExecutionLeases()[queueId];
    if (!lease || lease.ownerId === this.ownerId) return false;
    return !this.isStale(lease, this.clock.now());
  }

  public ownerOfRecord(queueId: string): string | null {
    return this.store.getExecutionLeases()[queueId]?.ownerId ?? null;
  }

  /** Every queue this window currently holds a live lease on. */
  public heldQueueIds(): readonly string[] {
    const now = this.clock.now();
    return Object.values(this.store.getExecutionLeases())
      .filter(
        (lease) =>
          lease.ownerId === this.ownerId &&
          this.fences.has(lease.queueId) &&
          !this.isStale(lease, now)
      )
      .map((lease) => lease.queueId);
  }

  /**
   * One interval refreshes every lease this window holds. A per-lease timer
   * would multiply memento writes by the queue count for no added safety —
   * the leases share an owner, so they go stale together or not at all.
   *
   * Driven from the fence map rather than the mirror: the fences are what this
   * window was actually granted, and a mirror entry naming this owner without a
   * fence is a claim it cannot prove. A queue whose generation has moved on is
   * dropped from both, and — unlike primacy — it is not re-acquired here. A
   * reclaimed execution lease means another window is draining that queue, and
   * the drain's step 6 is the one place allowed to decide to contend for it.
   */
  public async heartbeat(): Promise<void> {
    const beat = this.runHeartbeat();
    this.inFlightBeat = beat;
    try {
      await beat;
    } finally {
      if (this.inFlightBeat === beat) this.inFlightBeat = null;
    }
  }

  private async runHeartbeat(): Promise<void> {
    const now = this.clock.now();
    for (const [queueId, fence] of [...this.fences]) {
      const verdict = await this.ownership.heartbeat(
        queueResource(queueId),
        this.ownerId,
        fence,
        now
      );
      if (verdict.outcome === 'unavailable') continue;
      if (verdict.outcome === 'rejected') {
        // FR-R4-F01 (FR-001) — the claim is LOST, not forgotten. The same epoch
        // check as below applies: a release that finished while this beat was
        // parked has already recorded the queue as released, and a loss reported
        // for a queue this window gave back would be a false one.
        if (this.fences.get(queueId) === fence) this.moveToLost(queueId, fence, 'rejected');
        const stale = this.store.getExecutionLeases()[queueId];
        if (stale?.ownerId === this.ownerId) {
          await this.store.setExecutionLease(queueId, null);
        }
        continue;
      }
      // FR-R3-055 (H-06) — the closing epoch, checked at the point of effect.
      //
      // A release can run to completion while this beat is parked on the await
      // above. Writing here would restore this window as the holder of a queue it
      // has given back -- a resurrected holder, which the next window then has to
      // wait out as a stale lease. The fence map IS the epoch: `releaseOne`
      // deletes the entry, so a beat whose fence is no longer the live one has
      // nothing left to refresh.
      if (this.fences.get(queueId) !== fence) continue;
      const lease = this.store.getExecutionLeases()[queueId];
      await this.store.setExecutionLease(queueId, {
        queueId,
        ownerId: this.ownerId,
        acquiredAt: lease?.ownerId === this.ownerId ? lease.acquiredAt : now,
        heartbeatAt: now
      });
    }
    this.stopHeartbeatIfIdle();
  }

  /**
   * Give one queue back, and say what that came to (contract C7). A caller that can act on the
   * answer logs it through `releaseLeaseLogged`; none throws on it.
   */
  public async release(queueId: string): Promise<ReleaseOutcome> {
    const heldFence = this.fences.get(queueId);
    const outcome = await this.releaseOne(queueId);
    this.stopHeartbeatIfIdle();
    await this.drainHeartbeat();
    if (heldFence === undefined) return outcome;
    const reasserted = await this.reassertReleased(queueId, heldFence);
    return reasserted === null || reasserted === 'not-holder' ? outcome : reasserted;
  }

  /**
   * FR-R4-F01 (FR-024, probe P2) — after the in-flight beat has settled, make sure it did not
   * put this window back as the holder.
   *
   * The beat's own epoch check protects the MIRROR (a released queue's fence is gone, so it skips
   * the mirror write). It cannot protect the registry: a beat parked inside the registry's
   * read-then-replace lands AFTER this release's own write and restores the holder, which the
   * next window then has to wait out as a stale lease. The drain above is what makes that
   * observable, so this is where it is undone. Skipped when this window has since taken the queue
   * again (`tryAcquire` returned `acquired`), which is a claim, not a resurrection.
   */
  private async reassertReleased(queueId: string, heldFence: number): Promise<ReleaseOutcome | null> {
    if (this.fences.has(queueId)) return null;
    const resource = queueResource(queueId);
    const verdict = await this.ownership.verify(resource, this.ownerId, heldFence);
    if (verdict.outcome === 'unavailable') return 'unavailable';
    if (verdict.outcome !== 'valid') return null;
    return releaseOutcomeOf(await this.ownership.release(resource, this.ownerId, heldFence));
  }

  public async releaseAll(): Promise<void> {
    // Each write awaits, so the key set this started from can be stale by the
    // time the loop reaches the next key — the drain's step-7 failure path
    // releases its own queue, and another window's release rewrites the whole
    // record. Re-read and guard rather than assume: the only caller is
    // `dispose()`, which releases the workspace lock immediately afterwards,
    // and a throw here would skip that release.
    //
    // The fence map is unioned in, because a claim this window was granted must
    // be given back even when its mirror entry has already gone.
    //
    // FR-R4-F01 — a lost claim is given back too: disposal records every tenure
    // this window had as released, whatever state it was in.
    const candidates = new Set([
      ...this.fences.keys(),
      ...this.lost.keys(),
      ...Object.keys(this.store.getExecutionLeases())
    ]);
    for (const queueId of candidates) {
      const lease = this.store.getExecutionLeases()[queueId];
      const tracked = this.fences.has(queueId) || this.lost.has(queueId);
      if (!tracked && lease?.ownerId !== this.ownerId) continue;
      await this.releaseOne(queueId);
    }
    this.stopHeartbeatIfIdle();
    await this.drainHeartbeat();
  }

  /**
   * Give one queue back.
   *
   * The fence is this window's own when it acquired the lease itself. When it
   * does not have one, the record is consulted: a release is authorized by being
   * the owner of record *at the current generation*, which is a claim a revived
   * predecessor cannot make, because it is no longer the owner of record. That
   * fallback is what lets the controller's manager instance release a lease the
   * drain's instance acquired — they share an owner id and a store, and without it
   * a terminal Run would strand its queue until the 15 s staleness reclaim.
   */
  private async releaseOne(queueId: string): Promise<ReleaseOutcome> {
    const resource = queueResource(queueId);
    const fence = this.fences.get(queueId) ?? (await this.currentFenceIfMine(resource));
    this.fences.delete(queueId);
    this.lost.delete(queueId);
    this.released.add(queueId);
    // No fence means the registry does not name this owner as holder: nothing to give back there.
    let outcome: ReleaseOutcome = 'not-holder';
    if (fence !== null) {
      outcome = releaseOutcomeOf(await this.ownership.release(resource, this.ownerId, fence));
    }
    const lease = this.store.getExecutionLeases()[queueId];
    if (lease && lease.ownerId === this.ownerId) {
      await this.store.setExecutionLease(queueId, null);
    }
    return outcome;
  }

  private async currentFenceIfMine(resource: string): Promise<number | null> {
    const record = await this.ownership.read(resource);
    if (!record || record.holder?.ownerId !== this.ownerId) return null;
    return record.fence;
  }

  /**
   * Run `fn` while holding one queue's lease, releasing on both the normal and
   * the throwing path.
   *
   * Contention returns `null` rather than throwing: losing an execution lease
   * means another window is already draining that queue, which is the ordinary
   * outcome of the drain's step 6 and not an error the operator should ever
   * see. Callers that genuinely lose *primacy* raise `LockHeldError` at their
   * own `tryAcquire()` site instead — see `commands/resume.ts`.
   *
   * A scope wrapper is right here and wrong for `WorkspaceLockManager`
   * (which has none, deliberately) because a lease taken by `withLease` ends
   * inside the call that took it. A Run outlives its drain, so the workspace
   * lock has no equivalent — see the note on `WorkspaceLockManager`.
   */
  public async withLease<T>(queueId: string, fn: () => Promise<T>): Promise<T | null> {
    const probe = await this.tryAcquire(queueId);
    if (!probe.acquired) return null;
    try {
      return await fn();
    } finally {
      // FR-R4-F01 (C7) — kept silent, and the reason is recorded rather than implied. The lease
      // ends inside the call that took it, so this is its `finally`: a release failure surfacing
      // from here would replace `fn`'s own result or throw. A lease not given back ends in the
      // staleness reclaim (`STALENESS_THRESHOLD_MS`), the same bound every failed release has.
      await this.release(queueId).catch(() => undefined);
    }
  }

  private isStale(lease: ExecutionLease, now: number): boolean {
    return now - lease.heartbeatAt > STALENESS_THRESHOLD_MS;
  }

  /**
   * FR-R3-055 (H-06) — wait out a beat already in flight, so a caller returning
   * from `release` can rely on no further write arriving for that queue.
   *
   * The epoch check above is what makes the outcome CORRECT; this makes it
   * OBSERVABLE. Without it, `release` returned while a beat was still parked and
   * a test -- or a caller reading the record immediately afterwards -- saw
   * whatever the interleaving produced.
   *
   * Unbounded on purpose. The beat awaits the same storage calls `release` itself
   * performs, so wedged storage was already going to block `release` at
   * `setExecutionLease`; waiting here introduces no new unbounded wait, and a
   * bound would only restore the window the epoch check exists to close.
   */
  private async drainHeartbeat(): Promise<void> {
    const beat = this.inFlightBeat;
    if (!beat) return;
    await beat.catch(() => undefined);
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle) return;
    this.heartbeatHandle = this.scheduler.setInterval(() => {
      // FR-R4-F01 (FR-024, contract C1 G5, probe P2) — skip while the previous beat is pending,
      // so at most one beat is ever in flight for `release` to settle. Two overlapping beats
      // left `inFlightBeat` pointing at the later one, and the earlier could land after a release.
      if (this.inFlightBeat !== null) return;
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatIfIdle(): void {
    if (this.fences.size > 0) return;
    this.heartbeatHandle?.clear();
    this.heartbeatHandle = null;
  }
}

/** What `releaseLeaseLogged` needs of a lease: the drain's doubles return nothing, the manager an outcome. */
export interface LeaseReleasePort {
  release(queueId: string): Promise<ReleaseOutcome | void> | ReleaseOutcome | void;
}

/**
 * FR-R4-F01 (FR-033, contract C7) — give a queue's lease back and say so when it did not go.
 *
 * Replaces `release(queueId).catch(() => undefined)` at the sites that can log. A throw reads as
 * `unavailable`; `released` and a double that returns nothing are silent. The line carries the
 * queue id and the outcome and nothing else, and the call never throws, so the surrounding
 * cleanup it sits in still runs.
 */
export async function releaseLeaseLogged(
  lease: LeaseReleasePort,
  queueId: string,
  logger: Pick<SanitizedLogger, 'warn'> | null | undefined
): Promise<void> {
  let outcome: ReleaseOutcome | void;
  try {
    outcome = await lease.release(queueId);
  } catch {
    outcome = 'unavailable';
  }
  if (outcome === undefined || outcome === 'released') return;
  logger?.warn('execution lease release failed', { queueId, outcome });
}
