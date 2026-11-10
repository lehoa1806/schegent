/**
 * FR-R6-F08 (FR-010, research R8, US5) — whether a delivery loads the prior session or starts a
 * fresh one. Pure.
 *
 * It loads the prior session only when the prior id is an ACP session id (never legacy
 * provenance), the owner, profile, backend and capability set are unchanged, the backend
 * declares the session capability, and no uncertain earlier delivery forces a fresh session.
 * The first reason that applies is the one returned. Loading a session never settles effect
 * certainty; a foreign session id is never carried.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  FreshSessionReason,
  SessionCapability,
  SessionPlan
} from '../../contracts/recovery-handoff/handoff-types';

/** The facts both sides of a session comparison carry. */
export interface SessionParty {
  /** `ownerDigestFor(owner)`; the account scope itself is never compared or stored. */
  readonly ownerDigest: string;
  readonly backendId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly capabilitiesDigest: string;
}

export interface PriorSession extends SessionParty {
  readonly sessionId: string;
  /** `legacy` marks an id kept as provenance from a pre-F08 record; it is never loaded. */
  readonly source: 'acp' | 'legacy';
}

export interface SessionPlanInput {
  readonly prior: PriorSession | null;
  readonly target: SessionParty;
  readonly capability: SessionCapability;
  /** True when an uncertain earlier delivery was continued by an operator decision. */
  readonly forceFresh: boolean;
}

/** The reasons that compare the prior session with the target, in order. */
function mismatchReason(prior: PriorSession, input: SessionPlanInput): FreshSessionReason | null {
  const { target } = input;
  if (prior.source === 'legacy') return 'legacy-session';
  if (prior.ownerDigest !== target.ownerDigest) return 'owner-mismatch';
  if (prior.profileId !== target.profileId || prior.profileVersion !== target.profileVersion) return 'profile-changed';
  if (prior.backendId !== target.backendId) return 'backend-changed';
  if (prior.capabilitiesDigest !== target.capabilitiesDigest) return 'capabilities-changed';
  if (input.capability === 'absent') return 'capability-absent';
  if (input.capability === 'unknown') return 'capability-unknown';
  return null;
}

export function planSession(input: SessionPlanInput): SessionPlan {
  const { prior } = input;
  if (input.forceFresh) return { plan: 'fresh-session', reason: 'uncertain-prior' };
  if (prior === null) return { plan: 'fresh-session', reason: 'no-prior-session' };
  const reason = mismatchReason(prior, input);
  if (reason !== null) return { plan: 'fresh-session', reason };
  return { plan: 'load-session', sessionId: prior.sessionId };
}
