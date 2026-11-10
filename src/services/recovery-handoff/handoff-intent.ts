/**
 * FR-R6-F08 (FR-009, FR-010, research R7, R8) — recording a delivery intent.
 *
 * One intent per target attempt: the id derives from the handoff and the target attempt, so a
 * repeated call lands on the row the first call wrote and returns it as a duplicate. A repeat
 * that differs in any recorded field is a conflict, never a second row.
 *
 * In one transaction it reads the handoff, its current revision, its earlier intents and
 * decisions; runs `evaluateRedelivery`; runs `planSession`; writes the intent; moves the handoff
 * to `delivering`; and lapses every outstanding decision to this intent. The pin purpose follows
 * after the commit, because F05 pin writes take their own transaction.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  CLOSED_HANDOFF_STATES,
  HANDOFF_MANIFEST_VERSION,
  SESSION_CAPABILITIES,
  type DeliveryTransport,
  type HandoffRefusal,
  type RedeliveryRefusal,
  type SessionCapability,
  type SessionOwner,
  type SessionPlan
} from '../../contracts/recovery-handoff/handoff-types';
import { includesValue, isNonNegativeInteger, isOpaqueId } from '../artifact-lifecycle/lifecycle-results';
import { evaluateRedelivery, type RedeliveryRequest } from './delivery-policy';
import { intentIdFor, ownerDigestFor } from './handoff-identity';
import { isNewerBuildStore } from './handoff-pins';
import type { HandoffWriteDeps } from './handoff-prepare';
import { lapseOutstandingDecisions, syncPinPurpose } from './handoff-settle';
import type { DeliveryRow } from './handoff-store-rows';
import { planSession, type PriorSession } from './session-plan';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TRANSPORTS: readonly DeliveryTransport[] = ['acp', 'direct'];
const PRIOR_SOURCES: readonly PriorSession['source'][] = ['acp', 'legacy'];

/** The session a previous attempt ran in, as the caller knows it. */
export interface PriorSessionInput {
  readonly sessionId: string;
  readonly source: 'acp' | 'legacy';
  readonly owner: SessionOwner;
  readonly backendId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly capabilitiesDigest: string;
}

export interface RecordIntentInput {
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly targetAttemptId: string;
  readonly envelopeDigest: string;
  readonly transport: DeliveryTransport;
  readonly backendId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly connectionId?: string;
  readonly promptId?: string;
  readonly capabilitiesDigest: string;
  readonly accessPlanDigest: string;
  readonly owner: SessionOwner;
  readonly sessionCapability: SessionCapability;
  readonly priorSession?: PriorSessionInput;
}

export type RecordIntentResult =
  | {
      readonly ok: true;
      readonly intentId: string;
      /** True when an identical earlier call wrote the row. */
      readonly duplicate: boolean;
      readonly sessionPlan: SessionPlan;
    }
  | (HandoffRefusal<'invalid'> & { readonly field: string })
  | HandoffRefusal<'not-found' | 'conflict' | RedeliveryRefusal>;

const ID_FIELDS = ['targetAttemptId', 'backendId', 'profileId', 'profileVersion'] as const;
const DIGEST_FIELDS = ['handoffId', 'envelopeDigest', 'capabilitiesDigest', 'accessPlanDigest'] as const;

function isOwner(owner: SessionOwner): boolean {
  return isOpaqueId(owner.agentId) && isOpaqueId(owner.accountScope);
}

function optionalIdValid(value: string | undefined): boolean {
  return value === undefined || isOpaqueId(value);
}

function invalidPriorField(prior: PriorSessionInput): string | null {
  if (!isOpaqueId(prior.sessionId)) return 'priorSession.sessionId';
  if (!includesValue(PRIOR_SOURCES, prior.source)) return 'priorSession.source';
  if (!isOwner(prior.owner)) return 'priorSession.owner';
  for (const field of ['backendId', 'profileId', 'profileVersion'] as const) {
    if (!isOpaqueId(prior[field])) return `priorSession.${field}`;
  }
  if (!DIGEST_PATTERN.test(prior.capabilitiesDigest)) return 'priorSession.capabilitiesDigest';
  return null;
}

/** The first field that fails validation, or null. */
function invalidField(input: RecordIntentInput): string | null {
  for (const field of DIGEST_FIELDS) {
    if (!DIGEST_PATTERN.test(input[field])) return field;
  }
  for (const field of ID_FIELDS) {
    if (!isOpaqueId(input[field])) return field;
  }
  if (!isNonNegativeInteger(input.revisionNo)) return 'revisionNo';
  if (!includesValue(TRANSPORTS, input.transport)) return 'transport';
  if (!optionalIdValid(input.connectionId)) return 'connectionId';
  if (!optionalIdValid(input.promptId)) return 'promptId';
  if (!isOwner(input.owner)) return 'owner';
  if (!includesValue(SESSION_CAPABILITIES, input.sessionCapability)) return 'sessionCapability';
  return input.priorSession === undefined ? null : invalidPriorField(input.priorSession);
}

function sameIntent(row: DeliveryRow, input: RecordIntentInput, ownerDigest: string): boolean {
  return (
    row.handoffId === input.handoffId &&
    row.revisionNo === input.revisionNo &&
    row.envelopeDigest === input.envelopeDigest &&
    row.transport === input.transport &&
    row.backendId === input.backendId &&
    row.profileId === input.profileId &&
    row.profileVersion === input.profileVersion &&
    row.connectionId === (input.connectionId ?? null) &&
    row.promptId === (input.promptId ?? null) &&
    row.capabilitiesDigest === input.capabilitiesDigest &&
    row.accessPlanDigest === input.accessPlanDigest &&
    row.ownerDigest === ownerDigest
  );
}

/** The plan a stored intent was recorded with; the schema keeps the reason and id paired. */
function storedPlan(row: DeliveryRow): SessionPlan {
  if (row.sessionPlan === 'load-session' && row.sessionId !== null) {
    return { plan: 'load-session', sessionId: row.sessionId };
  }
  return { plan: 'fresh-session', reason: row.sessionReason ?? 'no-prior-session' };
}

function requestOf(input: RecordIntentInput): RedeliveryRequest {
  return {
    targetAttemptId: input.targetAttemptId,
    transport: input.transport,
    connectionId: input.connectionId ?? null,
    backendId: input.backendId,
    profileId: input.profileId,
    profileVersion: input.profileVersion
  };
}

function priorOf(prior: PriorSessionInput | undefined): PriorSession | null {
  if (prior === undefined) return null;
  return {
    sessionId: prior.sessionId,
    source: prior.source,
    ownerDigest: ownerDigestFor(prior.owner),
    backendId: prior.backendId,
    profileId: prior.profileId,
    profileVersion: prior.profileVersion,
    capabilitiesDigest: prior.capabilitiesDigest
  };
}

function writeIntent(deps: HandoffWriteDeps, input: RecordIntentInput): RecordIntentResult {
  const { store } = deps;
  const handoff = store.getHandoff(input.handoffId);
  if (handoff === undefined) return { ok: false, code: 'not-found' };
  const intentId = intentIdFor(input.handoffId, input.targetAttemptId);
  const ownerDigest = ownerDigestFor(input.owner);
  const existing = store.getDelivery(intentId);
  if (existing !== undefined) {
    if (!sameIntent(existing, input, ownerDigest)) return { ok: false, code: 'conflict' };
    return { ok: true, intentId, duplicate: true, sessionPlan: storedPlan(existing) };
  }
  const revision = store.getRevision(input.handoffId, input.revisionNo);
  // A revision a newer build wrote is never delivered (FR-015). A closed handoff is reported as
  // closed first, as R7 orders it, so the check leaves that case to `evaluateRedelivery`.
  const futureRevision = revision !== undefined && revision.manifestVersion > HANDOFF_MANIFEST_VERSION;
  if (futureRevision && !CLOSED_HANDOFF_STATES.has(handoff.state)) {
    return { ok: false, code: 'unsupported-version' };
  }
  const decisions = store.listDecisions(input.handoffId);
  const verdict = evaluateRedelivery({
    handoff,
    revisionNo: input.revisionNo,
    certainty: revision?.certainty ?? 'unknown',
    priorIntents: store.listDeliveries(input.handoffId),
    decisions,
    request: requestOf(input)
  });
  if (!verdict.ok) return verdict;
  const sessionPlan = planSession({
    prior: priorOf(input.priorSession),
    target: {
      ownerDigest,
      backendId: input.backendId,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      capabilitiesDigest: input.capabilitiesDigest
    },
    capability: input.sessionCapability,
    forceFresh: verdict.forceFresh
  });
  const nowMs = deps.nowMs();
  store.insertDelivery({
    ...requestOf(input),
    intentId,
    handoffId: input.handoffId,
    revisionNo: input.revisionNo,
    envelopeDigest: input.envelopeDigest,
    ownerDigest,
    sessionPlan: sessionPlan.plan,
    sessionReason: sessionPlan.plan === 'fresh-session' ? sessionPlan.reason : null,
    sessionId: sessionPlan.plan === 'load-session' ? sessionPlan.sessionId : null,
    promptId: input.promptId ?? null,
    capabilitiesDigest: input.capabilitiesDigest,
    accessPlanDigest: input.accessPlanDigest,
    decisionId: verdict.decisionId,
    nowMs
  });
  store.updateHandoff(input.handoffId, { state: 'delivering' }, nowMs);
  lapseOutstandingDecisions(store, input.handoffId, intentId);
  return { ok: true, intentId, duplicate: false, sessionPlan };
}

/** Contract `recordIntent`. */
export function recordIntent(deps: HandoffWriteDeps, input: RecordIntentInput): RecordIntentResult {
  const field = invalidField(input);
  if (field !== null) return { ok: false, code: 'invalid', field };
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const result = deps.store.transaction(() => writeIntent(deps, input));
  if (result.ok && !result.duplicate) syncPinPurpose(deps, input.handoffId);
  return result;
}
