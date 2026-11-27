/**
 * FR-R6-F08 (FR-009, research R7, Clarification 4) — whether a handoff may be delivered to a
 * new target attempt. Pure: it reads rows already loaded and writes nothing.
 *
 * Refusals, first that applies wins: a closed handoff, an unsupported handoff, a revision that is
 * not the current one, an intent still pending, a target attempt already used.
 *
 * The guard then applies once any earlier intent exists. A new attempt is automatic only when
 * every earlier intent was refused before it was sent and the effect certainty is `safe`.
 * Otherwise a direct backend is always refused, and anything else needs an accepted, unused
 * `continue-new-attempt` decision on the current revision. Without one, the refusal names what
 * changed: the connection, then the profile, else `decision-required`. A decision forces a fresh
 * session. It lapses at the next intent or the next recorded outcome (`handoff-settle.ts`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { RecoveryEffectCertainty } from '../../contracts/recovery-envelope';
import {
  CLOSED_HANDOFF_STATES,
  type HandoffRefusal,
  type RedeliveryRefusal
} from '../../contracts/recovery-handoff/handoff-types';
import type { DecisionRow, DeliveryRow, HandoffRow } from './handoff-store-rows';

/** The delivery facts the request and every earlier intent share. */
export type RedeliveryRequest = Pick<
  DeliveryRow,
  'targetAttemptId' | 'transport' | 'connectionId' | 'backendId' | 'profileId' | 'profileVersion'
>;

export type RedeliveryPriorIntent = RedeliveryRequest & Pick<DeliveryRow, 'outcome' | 'outcomeReason'>;

export type RedeliveryDecision = Pick<
  DecisionRow,
  'decisionId' | 'revisionNo' | 'decision' | 'outcome' | 'consumedByIntentId'
>;

export interface RedeliveryInput {
  readonly handoff: Pick<HandoffRow, 'state' | 'currentRevision' | 'sourceAttemptId'>;
  readonly revisionNo: number;
  readonly certainty: RecoveryEffectCertainty;
  /** Every earlier intent of the handoff, oldest first. */
  readonly priorIntents: readonly RedeliveryPriorIntent[];
  readonly decisions: readonly RedeliveryDecision[];
  readonly request: RedeliveryRequest;
}

export type RedeliveryVerdict =
  | {
      readonly ok: true;
      /** The decision this intent consumes, if the guard needed one. */
      readonly decisionId: string | null;
      /** True when a decision permitted the attempt: the session plan must be fresh. */
      readonly forceFresh: boolean;
    }
  | HandoffRefusal<RedeliveryRefusal>;

function refuse(code: RedeliveryRefusal): HandoffRefusal<RedeliveryRefusal> {
  return { ok: false, code };
}

function refusedBeforeSend(intent: RedeliveryPriorIntent): boolean {
  return intent.outcome === 'refused' && intent.outcomeReason === 'not-sent';
}

/** Refusals 1 to 4 of R7, which hold with or without a decision. */
function standingRefusal(input: RedeliveryInput): RedeliveryRefusal | null {
  const { handoff, request } = input;
  if (CLOSED_HANDOFF_STATES.has(handoff.state)) return 'handoff-closed';
  if (handoff.state === 'unsupported') return 'unsupported-version';
  if (handoff.currentRevision !== input.revisionNo) return 'stale-revision';
  if (input.priorIntents.some((intent) => intent.outcome === 'pending')) return 'delivery-in-flight';
  const used = input.priorIntents.some((intent) => intent.targetAttemptId === request.targetAttemptId);
  if (used || request.targetAttemptId === handoff.sourceAttemptId) return 'attempt-reused';
  return null;
}

function usableDecision(input: RedeliveryInput): RedeliveryDecision | undefined {
  return input.decisions.find(
    (row) =>
      row.revisionNo === input.revisionNo &&
      row.decision === 'continue-new-attempt' &&
      row.outcome === 'accepted' &&
      row.consumedByIntentId === null
  );
}

/** The refusal that names what changed since the latest earlier intent. */
function guardRefusal(latest: RedeliveryPriorIntent, request: RedeliveryRequest): RedeliveryRefusal {
  if (request.connectionId === null || request.connectionId !== latest.connectionId) return 'new-connection-refused';
  if (request.profileId !== latest.profileId || request.profileVersion !== latest.profileVersion) {
    return 'profile-changed-refused';
  }
  return 'decision-required';
}

export function evaluateRedelivery(input: RedeliveryInput): RedeliveryVerdict {
  const standing = standingRefusal(input);
  if (standing !== null) return refuse(standing);
  const latest = input.priorIntents.at(-1);
  if (latest === undefined) return { ok: true, decisionId: null, forceFresh: false };
  const automatic = input.certainty === 'safe' && input.priorIntents.every(refusedBeforeSend);
  if (automatic) return { ok: true, decisionId: null, forceFresh: false };
  if (input.request.transport === 'direct') return refuse('direct-backend-refused');
  const usable = usableDecision(input);
  if (usable !== undefined) return { ok: true, decisionId: usable.decisionId, forceFresh: true };
  return refuse(guardRefusal(latest, input.request));
}
