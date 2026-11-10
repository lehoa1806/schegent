/**
 * FR-R6-F08 (FR-012, FR-013, FR-014, research R9) — the operator's operations on a handoff.
 *
 * `decide` records an operator decision against the revision the operator read. A decision on a
 * revision that is no longer current is stored `refused-stale`, and one on a closed handoff is
 * stored `refused-closed`: a refused decision is a durable fact, not an error, and it permits no
 * attempt. An accepted `abandon` consumes the handoff with `closed_reason` `abandoned`.
 * `setHandoffPaused` changes only the pin purpose. `supersede` closes the handoff and its current
 * issued revision. Both closing paths release every pin after the handoff transaction commits,
 * because F05 pin writes take their own transaction. `explain` reads rows and writes none.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  CLOSED_HANDOFF_STATES,
  HANDOFF_DECISIONS,
  HANDOFF_MANIFEST_VERSION,
  type DecisionOutcome,
  type HandoffDecision,
  type HandoffPinPurpose,
  type HandoffRefusal
} from '../../contracts/recovery-handoff/handoff-types';
import { includesValue, isNonNegativeInteger, isOpaqueId } from '../artifact-lifecycle/lifecycle-results';
import { buildExplanation, type HandoffExplanation } from './handoff-explanation';
import { decisionIdFor } from './handoff-identity';
import { isNewerBuildStore, pinPurposeFor, releaseAll } from './handoff-pins';
import type { HandoffWriteDeps } from './handoff-prepare';
import { syncPinPurpose } from './handoff-settle';
import type { HandoffRow, SqliteHandoffStore } from './handoff-store';

export type DecideResult =
  | { readonly ok: true; readonly decisionId: string; readonly outcome: DecisionOutcome }
  | HandoffRefusal<'not-found' | 'conflict' | 'unsupported-version'>
  | (HandoffRefusal<'invalid'> & { readonly field: string });

export type SetPausedResult =
  | { readonly ok: true; readonly pinPurpose: HandoffPinPurpose | null }
  | HandoffRefusal<'not-found' | 'handoff-closed' | 'unsupported-version'>;

export type SupersedeResult =
  | { readonly ok: true; readonly state: 'superseded' }
  | HandoffRefusal<'not-found' | 'handoff-closed' | 'unsupported-version'>;

export type ExplainResult =
  | { readonly ok: true; readonly explanation: HandoffExplanation }
  | HandoffRefusal<'not-found' | 'unsupported-version'>;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Names the first invalid field of a decision request, or `null` when every field is valid. */
function invalidDecisionField(handoffId: string, revisionNo: number, decision: string, requestId: string): string | null {
  if (!DIGEST_PATTERN.test(handoffId)) return 'handoffId';
  if (!isNonNegativeInteger(revisionNo) || revisionNo < 1) return 'revisionNo';
  if (!includesValue(HANDOFF_DECISIONS, decision)) return 'decision';
  if (!isOpaqueId(requestId)) return 'requestId';
  return null;
}

/** The revision a decision must name: the current one, or the newest draft before any issue. */
function decidableRevision(store: SqliteHandoffStore, handoff: HandoffRow): number {
  return handoff.currentRevision ?? store.maxRevisionNo(handoff.handoffId);
}

/**
 * A handoff this build cannot interpret: imported from an unknown legacy version, or whose
 * current revision a newer build wrote. It is kept as it is, so nothing closes it or releases
 * its pins (FR-015).
 */
function isUnsupportedHandoff(store: SqliteHandoffStore, handoff: HandoffRow): boolean {
  if (handoff.state === 'unsupported') return true;
  const current = handoff.currentRevision;
  if (current === null) return false;
  const revision = store.getRevision(handoff.handoffId, current);
  return revision !== undefined && revision.manifestVersion > HANDOFF_MANIFEST_VERSION;
}

function outcomeFor(store: SqliteHandoffStore, handoff: HandoffRow, revisionNo: number): DecisionOutcome {
  if (CLOSED_HANDOFF_STATES.has(handoff.state)) return 'refused-closed';
  if (revisionNo !== decidableRevision(store, handoff)) return 'refused-stale';
  return 'accepted';
}

/** Contract `decide`. */
export function decideHandoff(
  deps: HandoffWriteDeps,
  handoffId: string,
  revisionNo: number,
  decision: HandoffDecision,
  requestId: string
): DecideResult {
  const field = invalidDecisionField(handoffId, revisionNo, decision, requestId);
  if (field !== null) return { ok: false, code: 'invalid', field };
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const decisionId = decisionIdFor(handoffId, requestId);
  const holder: { abandoned: boolean } = { abandoned: false };
  const result = store.transaction((): DecideResult => {
    const handoff = store.getHandoff(handoffId);
    if (handoff === undefined) return { ok: false, code: 'not-found' };
    if (isUnsupportedHandoff(store, handoff)) return { ok: false, code: 'unsupported-version' };
    const existing = store.getDecision(decisionId);
    if (existing !== undefined) {
      if (existing.revisionNo !== revisionNo || existing.decision !== decision) return { ok: false, code: 'conflict' };
      return { ok: true, decisionId, outcome: existing.outcome };
    }
    const outcome = outcomeFor(store, handoff, revisionNo);
    const nowMs = deps.nowMs();
    store.insertDecision({ decisionId, handoffId, revisionNo, decision, outcome, nowMs });
    if (outcome === 'accepted' && decision === 'abandon') {
      store.updateHandoff(handoffId, { state: 'consumed', closedReason: 'abandoned' }, nowMs);
      holder.abandoned = true;
    }
    return { ok: true, decisionId, outcome };
  });
  if (holder.abandoned) releaseAll(deps, handoffId);
  return result;
}

/** Contract `setHandoffPaused`: pausing changes the pin purpose only, never the handoff state. */
export function setHandoffPaused(deps: HandoffWriteDeps, handoffId: string, paused: boolean): SetPausedResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const changed = store.transaction((): SetPausedResult | 'changed' => {
    const handoff = store.getHandoff(handoffId);
    if (handoff === undefined) return { ok: false, code: 'not-found' };
    if (CLOSED_HANDOFF_STATES.has(handoff.state)) return { ok: false, code: 'handoff-closed' };
    if (handoff.paused !== paused) store.updateHandoff(handoffId, { paused }, deps.nowMs());
    return 'changed';
  });
  if (changed !== 'changed') return changed;
  syncPinPurpose(deps, handoffId);
  const handoff = store.getHandoff(handoffId);
  const pinPurpose = handoff === undefined ? null : (handoff.pinPurpose ?? pinPurposeFor(handoff.state, handoff.paused));
  return { ok: true, pinPurpose };
}

/** Contract `supersede`: closes the handoff and its issued revision, then releases every pin. */
export function supersedeHandoff(deps: HandoffWriteDeps, handoffId: string): SupersedeResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const closed = store.transaction((): SupersedeResult | 'closed' => {
    const handoff = store.getHandoff(handoffId);
    if (handoff === undefined) return { ok: false, code: 'not-found' };
    if (CLOSED_HANDOFF_STATES.has(handoff.state)) return { ok: false, code: 'handoff-closed' };
    if (isUnsupportedHandoff(store, handoff)) return { ok: false, code: 'unsupported-version' };
    const nowMs = deps.nowMs();
    store.updateHandoff(handoffId, { state: 'superseded', closedReason: 'superseded' }, nowMs);
    const current = handoff.currentRevision;
    if (current !== null && store.getRevision(handoffId, current)?.status === 'issued') {
      store.supersedeRevision(handoffId, current, nowMs);
    }
    return 'closed';
  });
  if (closed !== 'closed') return closed;
  releaseAll(deps, handoffId);
  return { ok: true, state: 'superseded' };
}

/** Contract `explain`: reads the handoff's rows and writes none. */
export function explainHandoff(deps: Pick<HandoffWriteDeps, 'conn' | 'store'>, handoffId: string): ExplainResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const handoff = store.getHandoff(handoffId);
  if (handoff === undefined) return { ok: false, code: 'not-found' };
  const revisionNo = decidableRevision(store, handoff);
  const revision = store.getRevision(handoffId, revisionNo) ?? null;
  const explanation = buildExplanation({
    handoff,
    revision,
    references: revision === null ? [] : store.listReferences(handoffId, revision.revisionNo),
    deliveries: store.listDeliveries(handoffId),
    decisions: store.listDecisions(handoffId)
  });
  return { ok: true, explanation };
}
