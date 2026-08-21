import type { HandlerContext } from './handler-contract';
import type { RouterDeps } from './router-types';
import { ack } from './handler-helpers';
import { SECONDARY_REJECT } from './constants';

/**
 * FR-R3-024 (FR-012) — the non-mutating commands that require primacy of their
 * own accord, because `MUTATING_COMMANDS` does not cover them and the router's
 * gate therefore never runs.
 *
 * A read command belongs here when serving it touches shared workspace state a
 * rival window may be writing — `CMD_READ_METRICS` scans the archive corpus.
 * A read that only projects in-memory host state does not belong here; gating
 * it would disable the sidebar of a secondary window for no benefit.
 *
 * `tests/lint/primacy-predicate-split.test.ts` asserts every entry imports
 * {@link withPrimary}, so a handler cannot join this list without gating and
 * cannot gate without joining it.
 */
export const PRIMACY_GATED_READ_HANDLERS: readonly string[] = ['cmd-read-metrics.ts'];

/**
 * The single primacy predicate for the sidebar command surface.
 *
 * Fail-closed on all three paths, which is the whole point of the function:
 *
 * 1. **Absent callback** — a host that wired no `isPrimary` cannot prove this
 *    window holds the lock, so it does not act. Before FR-R3-024 this returned
 *    `true`, which made a deps-wiring regression indistinguishable from a
 *    granted claim; `checkTrusted` has always taken the opposite posture for
 *    the same class of mistake. Tests MUST wire `isPrimary` explicitly, and
 *    `tests/lint/message-router-primacy-wiring.test.ts` enforces it.
 * 2. **Throw** — an unanswerable ownership read is not a granted claim.
 * 3. **Non-`true` return** — including the `unavailable` verdict
 *    `lock.hasPrimacy()` reports when the storage layer cannot answer, in
 *    `tryAcquire`'s own words: refuse to acquire, never assume acquired.
 *
 * The absent-callback path warns; the other two do not, because their callers
 * warn with the command type in hand.
 */
export async function isWindowPrimary(
  deps: Pick<RouterDeps, 'isPrimary' | 'logger'>
): Promise<boolean> {
  if (!deps.isPrimary) {
    deps.logger.warn(
      'router: primary-host callback missing — rejecting command (fail-closed)'
    );
    return false;
  }
  try {
    return (await deps.isPrimary()) === true;
  } catch {
    return false;
  }
}

/**
 * FR-R3-024 (FR-007) — the primacy gate for a handler, shaped so its verdict
 * cannot be dropped.
 *
 * TypeScript has no `#[must_use]`, so every verdict-returning shape stays
 * discardable and one of them was in fact discarded: `cmd-read-metrics`
 * awaited a `checkPrimary(ctx)` boolean and ignored it, leaving a gate its own
 * comment called mandatory as a no-op for two features. Making the gated work
 * the argument removes the verdict from the caller's hands entirely — omitting
 * `run` is a compile error, and there is nothing left to forget to read.
 *
 * Warns BEFORE the ack (Feature 019 BUG-001 / FR-021) so the runtime-log line
 * lands even if the ack-post throws, and logs the command type and correlation
 * id only — never the payload.
 *
 * No `notifyWarning` toast, unlike the router's gate on mutating commands: a
 * refused read is not an operator action that failed, and a polled read would
 * raise one toast per poll.
 */
export async function withPrimary(
  ctx: HandlerContext,
  command: { readonly type: string },
  run: () => Promise<void>
): Promise<void> {
  if (await isWindowPrimary(ctx.deps)) {
    await run();
    return;
  }
  ctx.deps.logger.warn('router: rejected by handler primary gate', {
    type: command.type,
    correlationId: ctx.correlationId
  });
  await ack(ctx, 'rejected', SECONDARY_REJECT);
}
