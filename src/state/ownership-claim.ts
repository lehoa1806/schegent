/**
 * FR-R3-077 (T1037) — what a commit point is made under.
 *
 * `FR-R3-055` built the fence and `setRun` accepted it as an OPTIONAL argument,
 * "so every existing caller is unchanged". The 2026-08-24 review measured the
 * consequence: 35 call sites, none of them passing one, `writtenAtFence` never
 * written, and the read-side half with no production caller at all. An optional
 * safety argument is an unused one.
 *
 * So the argument becomes required, and the type carries the second half of the
 * answer: a caller that provably holds no lease says so, by name, with a reason
 * from a closed set. That is the difference between this and a default — a
 * default is silent and uncountable, and `unfencedCommit('host-disposal')` is
 * neither. `tsc` enumerates the sites; this union enumerates the exemptions; and
 * `tests/unit/state/unfenced-commit-inventory.test.ts` pins the set so a new one
 * cannot arrive without a reviewed edit in three places.
 */

import { HEARTBEAT_INTERVAL_MS, systemScheduler, type Scheduler } from './lock';
import { queueResource, type FenceCheck, type OwnershipRegistry } from './ownership-registry';
import type { OwnershipClaim } from './workspace-state';

/**
 * FR-R4-F01 (FR-021, contract C3, research R6) — how long a commit waits for the ownership
 * record to answer before it gives up and refuses.
 *
 * A named constant, not a setting. One heartbeat period: a verify that has not answered within
 * it knows nothing newer than the next beat will, and it is a third of
 * `STALENESS_THRESHOLD_MS`, so a commit gives up well before a rival could reclaim on staleness.
 * Imported, not restated, so the two cannot drift.
 */
export const OWNERSHIP_VERIFY_DEADLINE_MS = HEARTBEAT_INTERVAL_MS;

/**
 * `registry.verify`, bounded: the answer, or `{ outcome: 'unavailable', cause: 'deadline' }`
 * once `deadlineMs` has passed on `scheduler`.
 *
 * `checkCommitFence` runs inside the `KEYS.run` and `KEYS.queue` links, and `serialize` chains
 * every later write on that key behind the link, so a verify that never settles used to wedge
 * every later write in the window. On expiry the commit now refuses `fence-unverifiable` and the
 * link completes.
 *
 * Only the READ is raced (FR-023, G11). The abandoned promise is attached to nothing but the
 * guard below: a result that arrives after the deadline has no continuation that writes, commits
 * or notifies, so it cannot authorize the commit it belonged to (FR-022, G12). The timer is the
 * scheduler's `setInterval`, cleared as soon as either side wins, because that is the seam this
 * module already has (`Scheduler` has no one-shot form) and an interval cleared on its first
 * fire is one.
 */
export function verifyWithin(
  registry: Pick<OwnershipRegistry, 'verify'>,
  resource: string,
  ownerId: string,
  fence: number,
  deadlineMs: number,
  scheduler: Scheduler
): Promise<FenceCheck> {
  return new Promise<FenceCheck>((resolve) => {
    let settled = false;
    const settle = (check: FenceCheck): void => {
      if (settled) return;
      settled = true;
      timer.clear();
      resolve(check);
    };
    const timer = scheduler.setInterval(() => {
      settle({ outcome: 'unavailable', cause: 'deadline' });
    }, deadlineMs);
    registry.verify(resource, ownerId, fence).then(settle, () => {
      settle({ outcome: 'unavailable' });
    });
  });
}

/**
 * Why a commit carries no fence. Closed on purpose.
 *
 * Each arm is a place where no lease can exist yet, or exists no longer:
 *
 * - `pre-election-recovery` — activation-time recovery, before window primacy has
 *   been decided. There is no holder to claim under; `FR-R3-070` made the
 *   election run first where it could, and what remains here genuinely precedes
 *   any claim.
 * - `host-disposal` — the window is surrendering, not holding. Requiring a live
 *   claim on the way out would make disposal fail exactly when the claim has
 *   already gone.
 * - `state-migration` — forward-only migrations run before any queue is live.
 * - `lease-not-held` — this window holds no lease on the queue it is writing:
 *   the ordinary case is a late write after a Run's terminal transition released
 *   it. Produced in exactly ONE place (`WorkspaceStateStore.runCommitClaim`) and
 *   warned once per queue, so the absence is observable rather than silent; the
 *   inventory test pins that single site. Refusing such a write instead would
 *   strand the Run record, which is a separate decision with its own risk.
 * - `test-fixture` — tests only. The inventory test asserts this arm appears in no
 *   `src/` file, so it cannot become a production shortcut.
 */
export type UnfencedCommitReason =
  | 'pre-election-recovery'
  | 'host-disposal'
  | 'state-migration'
  | 'lease-not-held'
  | 'test-fixture';

/** Every reason, in one place, so the inventory test can assert the set. */
export const UNFENCED_COMMIT_REASONS: readonly UnfencedCommitReason[] = [
  'pre-election-recovery',
  'host-disposal',
  'state-migration',
  'lease-not-held',
  'test-fixture'
];

export interface UnfencedCommit {
  readonly kind: 'unfenced';
  readonly reason: UnfencedCommitReason;
}

/**
 * The required third argument of the Run commit point: a live claim, or a named
 * admission that there is none.
 */
export type RunCommitClaim = OwnershipClaim | UnfencedCommit;

/**
 * FR-R3-077 — the same shape for the queue mutation path, under a distinct name.
 *
 * Structurally identical and deliberately not the same type: a fence is only
 * meaningful against the resource it was issued for, and a separate name is what
 * stops a primacy claim being handed to a queue mutation by a caller that had one
 * lying around. `OwnershipClaim` already carries `resource` for the runtime half
 * of that check; this is the compile-time half.
 */
export type QueueCommitClaim = OwnershipClaim | UnfencedCommit;

/** Declare, by name and with a reason, that this commit carries no fence. */
export function unfencedCommit(reason: UnfencedCommitReason): UnfencedCommit {
  return { kind: 'unfenced', reason };
}

/**
 * True when the commit carries a live claim to verify.
 *
 * Discriminated on the presence of `kind` rather than on its value: an
 * `OwnershipClaim` has no such member, so `'kind' in claim` is the narrowing the
 * two shapes actually offer. Comparing `claim.kind !== 'unfenced'` through a
 * cast reads the same and is not — the cast asserts the member exists, and the
 * comparison is then statically false.
 */
export function isFencedClaim(claim: RunCommitClaim): claim is OwnershipClaim {
  return !('kind' in claim);
}

/** Why a fenced commit was refused, for `QueueMutationRejected` to carry. */
export interface CommitFenceFailure {
  readonly reason: 'fence-wrong-resource' | 'fence-unverifiable' | 'fence-superseded';
  readonly message: string;
}

/**
 * FR-R3-077 follow-up — verify a commit fence against the queue it NAMES, and
 * tell the two ways it can fail apart. `null` when the fence holds.
 *
 * Two things the commit points asserted and did not do.
 *
 * FIRST, the resource. `OwnershipClaim`'s header says bundling `resource` with
 * `fence` "keeps a caller from pairing a primacy token with a queue", and the
 * two claim aliases above are documented as "deliberately not the same type".
 * Neither held: TypeScript aliases are structural, so `RunCommitClaim` and
 * `QueueCommitClaim` are interchangeable, and `setRun`/`updateQueue` passed
 * `claim.resource` straight to `verify` without ever asking whether it was THIS
 * queue's resource. A primacy claim therefore verified — primacy is live — and
 * stamped `writtenAtFence` from the primacy generation counter, which
 * `readRunIfLive` then compares against the queue's independent one. No caller
 * does that today; this is what keeps it that way, at runtime, which is where a
 * claim is actually built.
 *
 * SECOND, the difference between a fence shown to be stale and a fence that
 * could not be READ. `OwnershipRegistry.verify` answers `unavailable` from a
 * bare catch on any storage failure, so an unreadable ownership record reported
 * as `fence-superseded` and sent an operator looking for a reclaim that never
 * happened. Both still refuse — an unanswerable check is a refusal, not a pass,
 * which is the discipline the lock mirror and `pre-push` already keep.
 */
export async function checkCommitFence(
  registry: Pick<OwnershipRegistry, 'verify'>,
  claim: OwnershipClaim,
  queueId: string,
  subject: 'Run' | 'Queue',
  scheduler: Scheduler = systemScheduler
): Promise<CommitFenceFailure | null> {
  const expected = queueResource(queueId);
  if (claim.resource !== expected) {
    return {
      reason: 'fence-wrong-resource',
      message: `${subject} mutation refused: claim names ${claim.resource}, not ${expected}`
    };
  }
  // FR-R4-F01 (FR-021) — bounded, so an ownership record that never answers refuses the commit
  // instead of holding the link, and every later write on this key, for ever.
  const check = await verifyWithin(
    registry,
    expected,
    claim.ownerId,
    claim.fence,
    OWNERSHIP_VERIFY_DEADLINE_MS,
    scheduler
  );
  if (check.outcome === 'valid') return null;
  const unverifiable = check.outcome === 'unavailable';
  const timedOut = check.outcome === 'unavailable' && check.cause === 'deadline';
  return {
    reason: unverifiable ? 'fence-unverifiable' : 'fence-superseded',
    message:
      `${subject} mutation refused: fence ${claim.fence} for ${expected} is ` +
      (unverifiable
        ? timedOut
          ? 'unverifiable; the ownership record did not answer in time'
          : 'unverifiable; the ownership record could not be read'
        : 'superseded')
  };
}
