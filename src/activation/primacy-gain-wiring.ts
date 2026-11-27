// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Subscribes to one lock-manager event and forwards it. The acts it eventually
// causes belong to `stage2-producers.ts`, which is THE GATE and re-reads trust
// when it runs, so this module writes nothing, spawns nothing and arms no timer
// of its own — at wiring time or afterwards.

import type * as vscode from 'vscode';

import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import type { Stage2Producers } from './stage2-producers';

/**
 * Install the recovery producers when this window wins primacy after activation.
 *
 * FR-032 (BUG-001, SC-011) — the election used to run exactly once, at
 * activation, and a window that lost it stayed non-primary for the rest of its
 * life: the heartbeat interval was armed only on the winning branch, so nothing
 * ever asked again. When the incumbent host died without releasing its lease,
 * the replacement contested once inside the staleness window, lost correctly,
 * and went quiet. `WorkspaceLockManager.tick()` now contests on every beat, and
 * this is the one subscriber that turns a later win into the five recovery
 * landmarks `stage2-producers.ts` keeps behind `lockResult.acquired`.
 *
 * WHY THE LOCK AND THE PRODUCERS ARE PASSED DIRECTLY, where the sibling
 * `trust-grant-wiring.ts` takes a thunk for the same shape of job. That module
 * subscribes in `activate()`, before Stage 2 exists and across every reload, so
 * it has to reach the CURRENT producers rather than a disposed lock. This
 * subscription is made inside `wireStage2` from the two objects it will call,
 * and all three die together when that wiring is closed. A thunk here would
 * model a lifetime difference that does not exist.
 *
 * WHERE IT IS REGISTERED, AND WHAT PAID FOR THE LINE. Inside `wireStage2`,
 * after `createStage2Producers` and before `producers.run()`, so the subscriber
 * is listening before the election it waits on; onto that function's own
 * `disposables` rather than `context.subscriptions`, because the lock and the
 * producers it closes over are replaced on every reload and a subscription that
 * outlived them would hold a dead graph reachable. `wireStage2` was AT its
 * 403-line exemption in `source-loc-budget.test.ts` when this landed, and that
 * exemption is shrink-only — so the registration is one line, paid for by
 * pairing two properties of the `createStage2Producers` call onto one, the same
 * move the `executionLease` line above it already makes. Everything that would
 * otherwise be a comment at the call site is in this paragraph instead, which is
 * the arrangement the gate asks for: the body extracted, the call site bare.
 *
 * WHY THE GAIN'S OWN RESULT IS FORWARDED RATHER THAN RE-READ. `installRecovery`
 * gates five blocks on the result it is handed, and the one closed over at
 * activation reads `acquired: false` in precisely the window this module exists
 * for — it would take all five `else` branches and install nothing, silently.
 * The event carries the winning result because this is the subscriber that needs
 * it; `onFenceLost` carries nothing because its subscriber does not.
 */
export function wirePrimacyGain(input: {
  readonly logger: SanitizedLogger;
  readonly lock: WorkspaceLockManager;
  readonly producers: Stage2Producers;
}): vscode.Disposable {
  const { logger, lock, producers } = input;
  return lock.onPrimacyGained((result) => {
    logger.info('window primacy gained after activation; installing recovery producers');
    // The rejection is caught HERE for `trust-grant-wiring.ts`'s reason, which
    // applies to a late election unchanged: nothing awaits this call, so a bare
    // `void` would discard the failure into an unhandled rejection — no log
    // line, no notification — while the recovery latch is already set and
    // nothing retries. The operator would be left with a window that holds
    // primacy and drives nothing, which is this bug wearing a different mask.
    // `errorMessage` rather than the cast-to-Error the sibling reaches for:
    // that cast is a grandfathered entry in the shrink-only baseline
    // `tests/lint/no-new-error-cast.test.ts` holds, and a new one is a new
    // site. `catch` binds `unknown`, so the cast reads "undefined" for
    // anything thrown that is not an Error.
    void producers.installRecovery(result).catch((err: unknown) => {
      logger.warn(`recovery producers failed after primacy gain: ${errorMessage(err)}`);
    });
  });
}
