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

import type { OwnershipClaim } from './workspace-state';

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
