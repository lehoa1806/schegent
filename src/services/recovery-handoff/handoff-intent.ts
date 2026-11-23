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

import { isBackendRunnerKind } from '../../contracts/backend-kinds';
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
import {
  isEphemeralBridgeSessionId,
  type AcpSessionBindingStore
} from '../acp-runtime/acp-durable-runtime-store';
import { includesValue, isNonNegativeInteger, isOpaqueId } from '../artifact-lifecycle/lifecycle-results';
import { evaluateRedelivery, type RedeliveryRequest } from './delivery-policy';
import { intentIdFor, ownerDigestFor } from './handoff-identity';
import { isNewerBuildStore } from './handoff-pins';
import type { HandoffWriteDeps } from './handoff-prepare';
import { lapseOutstandingDecisions, syncPinPurpose } from './handoff-settle';
import type { DeliveryRow, HandoffRow, RevisionRow } from './handoff-store-rows';
import {
  isValidAcpSessionMapping,
  parseLegacyProvenance,
  type AcpSessionMapping
} from './legacy-handoff-mapping';
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
  /** Explicit validated ACP session mapping required to allow `load-session` on a legacy handoff (`16-12`). */
  readonly acpMapping?: AcpSessionMapping;
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

function matchesBindingBackend(backendId: string, bindingBackend: string): boolean {
  if (isBackendRunnerKind(backendId)) return backendId === bindingBackend;
  if (backendId.startsWith('acp-')) {
    const suffix = backendId.slice(4);
    if (isBackendRunnerKind(suffix)) return suffix === bindingBackend;
  }
  return false;
}

/**
 * FR-R7-16 (`16-12`, FR-012) — derives the prior session source from stored `legacyProvenance`
 * rather than trusting caller-supplied `source: 'acp'`.
 *
 * - Ephemeral bridge IDs (`/^acp-(?:claude|codex|agy)-session-\d+$/`) never load.
 * - Any legacy-originated handoff (`legacyProvenance !== null`) forces `source: 'legacy'` unless
 *   stored provenance parses cleanly as `legacy-record` with a non-null `providerSessionId`,
 *   caller supplies a valid non-ephemeral explicit `acpMapping` matching `prior.sessionId` and
 *   distinct from `providerSessionId`, and `acpSessionBindings` is wired with a matching,
 *   non-ephemeral durable binding for the canonical backend and stored `providerSessionId`.
 */
function priorOf(
  handoff: HandoffRow,
  input: RecordIntentInput,
  acpSessionBindings: AcpSessionBindingStore | undefined
): PriorSession | null {
  const prior = input.priorSession;
  if (prior === undefined) return null;
  const base = {
    sessionId: prior.sessionId,
    ownerDigest: ownerDigestFor(prior.owner),
    backendId: prior.backendId,
    profileId: prior.profileId,
    profileVersion: prior.profileVersion,
    capabilitiesDigest: prior.capabilitiesDigest
  };
  if (isEphemeralBridgeSessionId(prior.sessionId)) {
    return { ...base, source: 'legacy' };
  }
  if (handoff.legacyProvenance === null) {
    return { ...base, source: prior.source };
  }
  const provenance = parseLegacyProvenance(handoff.legacyProvenance);
  if (provenance.kind !== 'legacy-record' || provenance.providerSessionId === null) {
    return { ...base, source: 'legacy' };
  }
  if (prior.sessionId === provenance.providerSessionId) {
    return { ...base, source: 'legacy' };
  }
  if (
    prior.source !== 'acp' ||
    prior.acpMapping === undefined ||
    prior.acpMapping.sessionId !== prior.sessionId ||
    !isValidAcpSessionMapping(prior.acpMapping, provenance.providerSessionId)
  ) {
    return { ...base, source: 'legacy' };
  }
  if (acpSessionBindings === undefined) {
    return { ...base, source: 'legacy' };
  }
  const binding = acpSessionBindings.getBinding(prior.acpMapping.sessionId);
  if (
    binding === null ||
    isEphemeralBridgeSessionId(binding.persistedSessionId) ||
    isEphemeralBridgeSessionId(binding.providerSessionId) ||
    !matchesBindingBackend(input.backendId, binding.backend) ||
    binding.providerSessionId !== provenance.providerSessionId
  ) {
    return { ...base, source: 'legacy' };
  }
  return { ...base, source: 'acp' };
}

function manifestEnvelopeDigestOf(revision: RevisionRow | undefined): string | null {
  if (revision === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(revision.manifestJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const envelope = (parsed as { readonly envelope?: unknown }).envelope;
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return null;
    const digest = (envelope as { readonly digest?: unknown }).digest;
    return typeof digest === 'string' && DIGEST_PATTERN.test(digest) ? digest : null;
  } catch {
    return null;
  }
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
  const usableDecision = store.findUnconsumedAcceptedDecision(
    input.handoffId,
    input.revisionNo,
    'continue-new-attempt'
  );
  const verdict = evaluateRedelivery({
    handoff,
    revisionNo: input.revisionNo,
    certainty: revision?.certainty ?? 'unknown',
    priorIntents: store.listDeliveries(input.handoffId),
    decisions: usableDecision === null ? [] : [usableDecision],
    request: requestOf(input)
  });
  if (!verdict.ok) return verdict;
  const expectedEnvelopeDigest = manifestEnvelopeDigestOf(revision);
  if (expectedEnvelopeDigest !== null && input.envelopeDigest !== expectedEnvelopeDigest) {
    return { ok: false, code: 'conflict' };
  }
  const sessionPlan = planSession({
    prior: priorOf(handoff, input, deps.acpSessionBindings),
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
