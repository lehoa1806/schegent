/**
 * FR-R6-F08 (FR-009, FR-011, research R4, R7) — settling delivery intents and closing a handoff.
 *
 * `acknowledge` settles a pending or uncertain intent once; `reportNotSent` settles a pending
 * intent as refused before it was sent, returning the handoff to `ready`, or to `uncertain` while
 * an earlier intent is uncertain; `consume` closes an acknowledged handoff and then
 * releases its pins; `reopen` turns every intent still pending at restart into `uncertain` and
 * reconciles pins. A failed delivery never releases a pin: only `consume`, and restart after an
 * interrupted close, release them.
 *
 * Handoff rows change inside one handoff transaction; F05 pin writes take their own transaction,
 * so they run after it commits.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { HandoffRefusal, HandoffState } from '../../contracts/recovery-handoff/handoff-types';
import { isNewerBuildStore, pinPurposeFor, reconcilePins, releaseAll, switchPurpose } from './handoff-pins';
import type { HandoffWriteDeps } from './handoff-prepare';
import type { SqliteHandoffStore } from './handoff-store';

export type AcknowledgeResult =
  | { readonly ok: true; readonly duplicate: boolean }
  | HandoffRefusal<'not-found' | 'conflict' | 'unsupported-version'>;

export type ReportNotSentResult =
  | { readonly ok: true }
  | HandoffRefusal<'not-found' | 'conflict' | 'unsupported-version'>;

export type ConsumeResult =
  | { readonly ok: true; readonly state: 'consumed' }
  | HandoffRefusal<'not-found' | 'conflict' | 'unsupported-version'>;

export interface ReopenResult {
  readonly pendingToUncertain: number;
  readonly purposeSwitchesFinished: number;
  readonly pinsRetried: number;
}

const ACKNOWLEDGEABLE: ReadonlySet<HandoffState> = new Set<HandoffState>(['delivering', 'uncertain']);
const NOT_SENT_FROM: ReadonlySet<HandoffState> = new Set<HandoffState>(['delivering']);

/** Moves the pins to the purpose the handoff's state now asks for. */
export function syncPinPurpose(deps: HandoffWriteDeps, handoffId: string): void {
  const handoff = deps.store.getHandoff(handoffId);
  if (handoff === undefined) return;
  const target = pinPurposeFor(handoff.state, handoff.paused);
  if (target !== null && target !== handoff.pinPurpose) switchPurpose(deps, handoffId, target);
}

/** Moves the handoff from one of `from` to `to` once none of its intents is pending. */
function moveWhenSettled(
  store: SqliteHandoffStore,
  handoffId: string,
  from: ReadonlySet<HandoffState>,
  to: HandoffState,
  nowMs: number
): void {
  const handoff = store.getHandoff(handoffId);
  if (handoff === undefined || !from.has(handoff.state)) return;
  if (store.listDeliveries(handoffId).some((row) => row.outcome === 'pending')) return;
  store.updateHandoff(handoffId, { state: to }, nowMs);
}

/**
 * Marks every accepted decision not yet consumed as consumed by `intentId`. Called whenever an
 * intent is recorded or its outcome changes, so a decision authorizes at most the next attempt
 * and never one after an outcome recorded after it (FR-009).
 */
export function lapseOutstandingDecisions(store: SqliteHandoffStore, handoffId: string, intentId: string): void {
  for (const decision of store.listDecisions(handoffId)) {
    if (decision.outcome === 'accepted' && decision.consumedByIntentId === null) {
      store.markDecisionConsumed(decision.decisionId, intentId);
    }
  }
}

/** The state a failed delivery returns to: `uncertain` while an earlier delivery may have arrived. */
function stateAfterNotSent(store: SqliteHandoffStore, handoffId: string): HandoffState {
  const uncertain = store.listDeliveries(handoffId).some((row) => row.outcome === 'uncertain');
  return uncertain ? 'uncertain' : 'ready';
}

/** Contract `acknowledge`. */
export function acknowledgeIntent(deps: HandoffWriteDeps, intentId: string): AcknowledgeResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const intent = store.getDelivery(intentId);
  if (intent === undefined) return { ok: false, code: 'not-found' };
  const result = store.transaction((): AcknowledgeResult => {
    const current = store.getDelivery(intentId) ?? intent;
    if (current.outcome === 'acknowledged') return { ok: true, duplicate: true };
    if (current.outcome === 'refused') return { ok: false, code: 'conflict' };
    const nowMs = deps.nowMs();
    store.acknowledgeDelivery(intentId, nowMs);
    lapseOutstandingDecisions(store, intent.handoffId, intentId);
    moveWhenSettled(store, intent.handoffId, ACKNOWLEDGEABLE, 'acknowledged', nowMs);
    return { ok: true, duplicate: false };
  });
  if (result.ok && !result.duplicate) syncPinPurpose(deps, intent.handoffId);
  return result;
}

/** Contract `reportNotSent`: the intent was refused before anything was sent. */
export function reportIntentNotSent(deps: HandoffWriteDeps, intentId: string): ReportNotSentResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const intent = store.getDelivery(intentId);
  if (intent === undefined) return { ok: false, code: 'not-found' };
  const result = store.transaction((): ReportNotSentResult => {
    const current = store.getDelivery(intentId) ?? intent;
    if (current.outcome === 'refused' && current.outcomeReason === 'not-sent') return { ok: true };
    if (current.outcome !== 'pending') return { ok: false, code: 'conflict' };
    const nowMs = deps.nowMs();
    store.settleDelivery(intentId, 'refused', 'not-sent', nowMs);
    lapseOutstandingDecisions(store, intent.handoffId, intentId);
    moveWhenSettled(store, intent.handoffId, NOT_SENT_FROM, stateAfterNotSent(store, intent.handoffId), nowMs);
    return { ok: true };
  });
  if (result.ok) syncPinPurpose(deps, intent.handoffId);
  return result;
}

/** Contract `consume`: closes an acknowledged handoff, then releases every pin it holds. */
export function consumeHandoff(deps: HandoffWriteDeps, handoffId: string): ConsumeResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const closed = store.transaction((): ConsumeResult | 'closed' => {
    const handoff = store.getHandoff(handoffId);
    if (handoff === undefined) return { ok: false, code: 'not-found' };
    // Only a delivered handoff repeats as consumed; an abandoned one was never acknowledged.
    if (handoff.state === 'consumed') {
      return handoff.closedReason === 'delivered' ? { ok: true, state: 'consumed' } : { ok: false, code: 'conflict' };
    }
    if (handoff.state !== 'acknowledged') return { ok: false, code: 'conflict' };
    store.updateHandoff(handoffId, { state: 'consumed', closedReason: 'delivered' }, deps.nowMs());
    return 'closed';
  });
  if (closed !== 'closed') return closed;
  releaseAll(deps, handoffId);
  return { ok: true, state: 'consumed' };
}

/** Contract `reopen`: run once at startup. */
export function reopenHandoffs(deps: HandoffWriteDeps): ReopenResult {
  if (isNewerBuildStore(deps.conn)) return { pendingToUncertain: 0, purposeSwitchesFinished: 0, pinsRetried: 0 };
  const { store } = deps;
  const pendingToUncertain = store.transaction(() => {
    const nowMs = deps.nowMs();
    let moved = 0;
    for (const intent of store.listPendingDeliveries()) {
      if (!store.settleDelivery(intent.intentId, 'uncertain', 'restart-before-ack', nowMs)) continue;
      moved += 1;
      lapseOutstandingDecisions(store, intent.handoffId, intent.intentId);
      if (store.getHandoff(intent.handoffId)?.state === 'delivering') {
        store.updateHandoff(intent.handoffId, { state: 'uncertain' }, nowMs);
      }
    }
    return moved;
  });
  let purposeSwitchesFinished = 0;
  let pinsRetried = 0;
  for (const handoff of store.listOpenHandoffs()) {
    const reconciled = reconcilePins(deps, handoff.handoffId);
    if (reconciled.switchFinished) purposeSwitchesFinished += 1;
    pinsRetried += reconciled.pinsRetried;
  }
  for (const handoffId of store.listClosedHandoffsHoldingPins()) reconcilePins(deps, handoffId);
  return { pendingToUncertain, purposeSwitchesFinished, pinsRetried };
}
