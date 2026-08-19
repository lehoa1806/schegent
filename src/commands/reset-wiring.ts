// Feature FR-R3-006 (T342, T344, T346, T348) — everything the extension host
// wires up for the reset transaction.
//
// `reset.ts` owns the transaction: the confirmation, the phase order, and what
// each outcome means. This file owns the *wiring* — the two activation-path
// helpers that finish a reset the previous host did not survive, and the factory
// that builds the stage-2 half of the `ResetHost` port out of a live controller
// and audit writer. They are separated because they diverge in what they depend
// on: `reset.ts` needs a store and a port and is testable with neither a
// controller nor a filesystem, while everything here exists only once stage 2 is
// up and is meaningless before it.
//
// It also keeps `extension.ts` to call sites. Reset touches activation at four
// points — recover, record the recovery, build the support, register the command
// — and inlining all four put the whole transaction's prose in the middle of a
// file that is a wiring manifest for thirty other subsystems.

import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SanitizedLogger } from '../lib/logger';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { RESET_QUIESCE_POLL_INTERVAL_MS, RESET_QUIESCE_WINDOW_MS } from '../state/reset-transaction';
import { appendResetAuditEvent, type ResetStageSupport } from './reset';

/**
 * The controller surface `quiesce` needs, as a structural port.
 *
 * Three members rather than the controller type: this is the whole of what
 * stopping the work requires, and naming it here means the factory can be tested
 * against an object literal.
 */
export interface ResetControllerPort {
  /** True while some session's driver is mid-drive — see `waitForRunnersToStop`. */
  readonly running: boolean;
  /** How many Runs this window owns, paused ones included. */
  readonly liveRunCount: number;
  cancelActive(queueId?: string): void;
}

/**
 * Finish a reset the previous host did not survive (T346).
 *
 * Call this *before* `store.initialize()`. The order matters: a half-cleared
 * state is still a readable one — the schema version is reset-exempt, so the
 * migration chain would run normally against it — and running it first would
 * mean repairing a Run whose queue entry the clear had already removed, emitting
 * repair events about it, and then clearing the repaired Run anyway. Finishing
 * first means the migrations see the state the operator actually asked for.
 *
 * A failure is logged, not thrown. The marker stays `in-progress`, so the next
 * activation tries again; failing activation instead would leave the operator
 * with no window and no way to reach the command that fixes it.
 *
 * @returns the generation it finished, or `null` if there was nothing to finish.
 */
export async function completeInterruptedResetOnActivation(
  store: Pick<WorkspaceStateStore, 'completeInterruptedReset'>,
  logger: Pick<SanitizedLogger, 'warn' | 'error'>
): Promise<number | null> {
  try {
    const generation = await store.completeInterruptedReset();
    if (generation !== null) {
      logger.warn(`activation: completed an interrupted reset (generation ${generation})`);
    }
    return generation;
  } catch (err) {
    logger.error(`activation: could not complete interrupted reset: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Record the interrupted reset this activation finished (T346, T348).
 *
 * Emitted at the same generation the original attempt claimed, so the audit
 * shows one reset with two entries rather than two resets: the first says it
 * reached `clear`, this one says it reached `reload`. Best-effort, like every
 * other activation-path append.
 */
export async function recordCompletedInterruptedReset(
  audit: Pick<AuditLogWriter, 'append'>,
  logger: Pick<SanitizedLogger, 'warn'>,
  generation: number
): Promise<void> {
  await appendResetAuditEvent(audit, logger, {
    outcome: 'completed',
    phaseReached: 'reload',
    generation,
    refusalReason: null,
    canceledRunCount: 0
  });
}

/**
 * Build the reset transaction's stage-2 half (T342, T344, T345, T348).
 *
 * `quiesce` is the only phase that needs anything from stage 2; the rest of the
 * transaction is the wiring's own `dispose()` (which already stops every
 * watchdog and heartbeat, releases every execution lease, and then primacy), the
 * store's clear, and stage 2 being wired again.
 */
export function createResetStageSupport(deps: {
  readonly controller: ResetControllerPort;
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}): ResetStageSupport {
  return {
    quiesce: async () => {
      const canceledRunCount = deps.controller.liveRunCount;
      deps.controller.cancelActive();
      const quiesced = await waitForRunnersToStop(deps.controller);
      return quiesced ? { ok: true, canceledRunCount } : { ok: false, reason: 'runner-still-active' };
    },
    recordReset: (payload) => appendResetAuditEvent(deps.auditWriter, deps.logger, payload)
  };
}

/**
 * Wait for every CLI subprocess in this window to stop, bounded.
 *
 * The predicate is `!controller.running`, deliberately not `liveRunCount === 0`.
 * They answer different questions and only the first is the one a clear depends
 * on: `running` asks whether any driver is mid-phase — i.e. whether a subprocess
 * is alive and will write when it finishes — while `liveRunCount` counts the
 * Runs this window owns, and a **paused** Run still owns its queue, its lease
 * and its cap slot with its driver idle. Waiting for the count would therefore
 * hang the full window and refuse the reset in exactly the situation an operator
 * reaches for it: a workspace with paused Runs they want gone. `cancelActive()`
 * cannot move a paused Run either — its driver has already returned from
 * `drive()`, so there is nothing listening to the abort — but it does not need
 * to, because the teardown that follows disposes those sessions and the clear
 * removes their records.
 *
 * This is the same question Clean All's runner-ack probe asks, with a longer
 * window because the two commands do different things when it elapses.
 */
async function waitForRunnersToStop(controller: ResetControllerPort): Promise<boolean> {
  const deadline = Date.now() + RESET_QUIESCE_WINDOW_MS;
  while (controller.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESET_QUIESCE_POLL_INTERVAL_MS));
  }
  return !controller.running;
}
