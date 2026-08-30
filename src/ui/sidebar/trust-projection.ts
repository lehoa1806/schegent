// The two trust facts every snapshot carries, resolved once per compose.
//
// Extracted from `snapshot-composer.ts` (feature 102, T011). It is the last
// concern that was still inlined there: history, monitor, queue, the three
// catalogs, and the queue runtimes each already have their own module, and the
// composer's own budget comment says composition, lifecycle, and timing are
// split. This is that split finished, not a new one — the budget exists to force
// exactly this, which is why it was not raised to make room instead.
//
// **Fails closed.** A resolver that throws yields the idle projection, in which
// nothing is trusted. The alternative — letting the throw escape — would drop
// the whole snapshot, and a surface with no snapshot is one that shows the
// operator its last state indefinitely.

import {
  getResolvedCapabilities,
  getResolvedScope
} from '../../state/capability-trust-resolver';
import { IDLE_TRUST_PROJECTION, type TrustProjection } from './snapshot';

/**
 * The workspace's trust and the capabilities it resolves to.
 *
 * @param onError Sanitized warning sink. Optional because a host with no logger
 *   still needs a projection; swallowing the cause silently is the reason this
 *   takes a sink rather than returning the error.
 */
export function composeTrustProjection(onError?: (message: string) => void): TrustProjection {
  try {
    const resolved = getResolvedCapabilities();
    return Object.freeze({
      workspaceTrust: resolved.workspaceTrust,
      resolvedTrust: Object.freeze({
        phases: resolved.phases,
        retryConditions: resolved.retryConditions
      }),
      // FR-R3-143 (T036) — WHICH STEP of the ladder decided, alongside what it
      // decided. `resolvedTrust` alone cannot answer "why is this off?", and the
      // surfaces that tried to answer it guessed: `TrustBanner.svelte:33-42` says
      // "disabled by workspace policy" for both capabilities, which is false
      // whenever the deciding step is the user's own setting.
      //
      // This is `getResolvedScope`, not the `scopes` map the general-settings
      // projection carries. They disagree in three ways that matter here: that map
      // is workspace-first where this ladder is deny-first, it treats an explicit
      // `null` as set (`!== undefined`), and it has no `'workspace-trust'` member —
      // so it cannot express the one state an operator most needs named.
      //
      // Inside the existing `try` deliberately: a resolver that throws must still
      // yield `IDLE_TRUST_PROJECTION` whole, per the fail-closed contract above.
      resolvedScope: Object.freeze({
        phases: getResolvedScope('phases'),
        retryConditions: getResolvedScope('retryConditions')
      })
    });
  } catch (error) {
    onError?.(`projector: failed to resolve trust capabilities: ${(error as Error).message}`);
    return IDLE_TRUST_PROJECTION;
  }
}
