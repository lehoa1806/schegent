/**
 * FR-R6-F08 — the frozen camelCase rows of the five recovery handoff tables, and the
 * mappers from the raw snake_case rows SQLite returns.
 *
 * The enum casts are sound: every enum column carries a CHECK list that equals its
 * contract constant (`handoff-schema.test.ts`), so a stored value is always a member.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  DecisionOutcome,
  DeliveryOutcome,
  DeliveryOutcomeReason,
  DeliveryTransport,
  FreshSessionReason,
  HandoffClosedReason,
  HandoffDecision,
  HandoffPinPurpose,
  HandoffPinState,
  HandoffReferenceRole,
  HandoffResolution,
  HandoffRevisionStatus,
  HandoffState,
  SessionPlanKind
} from '../../contracts/recovery-handoff/handoff-types';
import type {
  RecoveryEffectCertainty,
  RecoveryWorkspaceCoverage
} from '../../contracts/recovery-envelope';

export interface HandoffRow {
  readonly handoffId: string;
  readonly workspaceId: string;
  readonly rootExecutionId: string;
  readonly invocationId: string;
  readonly sourceAttemptId: string;
  readonly state: HandoffState;
  readonly paused: boolean;
  readonly closedReason: HandoffClosedReason | null;
  readonly currentRevision: number | null;
  readonly pinPurpose: HandoffPinPurpose | null;
  readonly pinPurposeTarget: HandoffPinPurpose | null;
  readonly legacyProvenance: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RevisionRow {
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly status: HandoffRevisionStatus;
  readonly cutoffKey: string;
  readonly executionRevision: string;
  readonly usageRevision: number;
  readonly factCutoffMs: number;
  readonly manifestVersion: number;
  readonly manifestJson: string;
  readonly manifestDigest: string;
  readonly certainty: RecoveryEffectCertainty;
  readonly coverage: RecoveryWorkspaceCoverage;
  readonly issuedAtMs: number | null;
  readonly supersededAtMs: number | null;
}

export interface ReferenceRow {
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly required: boolean;
  readonly expectedDigest: string | null;
  readonly pinState: HandoffPinState;
  readonly pinRefusal: string | null;
  readonly lastResolution: HandoffResolution | null;
  readonly resolvedAtMs: number | null;
}

export interface DeliveryRow {
  readonly intentId: string;
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly targetAttemptId: string;
  readonly envelopeDigest: string;
  readonly transport: DeliveryTransport;
  readonly backendId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly ownerDigest: string;
  readonly sessionPlan: SessionPlanKind;
  readonly sessionReason: FreshSessionReason | null;
  readonly sessionId: string | null;
  readonly connectionId: string | null;
  readonly promptId: string | null;
  readonly capabilitiesDigest: string;
  readonly accessPlanDigest: string;
  readonly outcome: DeliveryOutcome;
  readonly outcomeReason: DeliveryOutcomeReason | null;
  readonly decisionId: string | null;
  readonly recordedAtMs: number;
  readonly settledAtMs: number | null;
}

export interface DecisionRow {
  readonly decisionId: string;
  readonly handoffId: string;
  readonly revisionNo: number;
  readonly decision: HandoffDecision;
  readonly outcome: DecisionOutcome;
  readonly consumedByIntentId: string | null;
  readonly recordedAtMs: number;
}

export interface RawHandoffRow {
  handoff_id: string;
  workspace_id: string;
  root_execution_id: string;
  invocation_id: string;
  source_attempt_id: string;
  state: string;
  paused: number;
  closed_reason: string | null;
  current_revision: number | null;
  pin_purpose: string | null;
  pin_purpose_target: string | null;
  legacy_provenance: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface RawRevisionRow {
  handoff_id: string;
  revision_no: number;
  status: string;
  cutoff_key: string;
  execution_revision: string;
  usage_revision: number;
  fact_cutoff_ms: number;
  manifest_version: number;
  manifest_json: string;
  manifest_digest: string;
  certainty: string;
  coverage: string;
  issued_at_ms: number | null;
  superseded_at_ms: number | null;
}

export interface RawReferenceRow {
  handoff_id: string;
  revision_no: number;
  artifact_id: string;
  role: string;
  required: number;
  expected_digest: string | null;
  pin_state: string;
  pin_refusal: string | null;
  last_resolution: string | null;
  resolved_at_ms: number | null;
}

export interface RawDeliveryRow {
  intent_id: string;
  handoff_id: string;
  revision_no: number;
  target_attempt_id: string;
  envelope_digest: string;
  transport: string;
  backend_id: string;
  profile_id: string;
  profile_version: string;
  owner_digest: string;
  session_plan: string;
  session_reason: string | null;
  session_id: string | null;
  connection_id: string | null;
  prompt_id: string | null;
  capabilities_digest: string;
  access_plan_digest: string;
  outcome: string;
  outcome_reason: string | null;
  decision_id: string | null;
  recorded_at_ms: number;
  settled_at_ms: number | null;
}

export interface RawDecisionRow {
  decision_id: string;
  handoff_id: string;
  revision_no: number;
  decision: string;
  outcome: string;
  consumed_by_intent_id: string | null;
  recorded_at_ms: number;
}

export function toHandoffRow(raw: RawHandoffRow): HandoffRow {
  return Object.freeze({
    handoffId: raw.handoff_id,
    workspaceId: raw.workspace_id,
    rootExecutionId: raw.root_execution_id,
    invocationId: raw.invocation_id,
    sourceAttemptId: raw.source_attempt_id,
    state: raw.state as HandoffState,
    paused: raw.paused === 1,
    closedReason: raw.closed_reason as HandoffClosedReason | null,
    currentRevision: raw.current_revision,
    pinPurpose: raw.pin_purpose as HandoffPinPurpose | null,
    pinPurposeTarget: raw.pin_purpose_target as HandoffPinPurpose | null,
    legacyProvenance: raw.legacy_provenance,
    createdAtMs: raw.created_at_ms,
    updatedAtMs: raw.updated_at_ms
  });
}

export function toRevisionRow(raw: RawRevisionRow): RevisionRow {
  return Object.freeze({
    handoffId: raw.handoff_id,
    revisionNo: raw.revision_no,
    status: raw.status as HandoffRevisionStatus,
    cutoffKey: raw.cutoff_key,
    executionRevision: raw.execution_revision,
    usageRevision: raw.usage_revision,
    factCutoffMs: raw.fact_cutoff_ms,
    manifestVersion: raw.manifest_version,
    manifestJson: raw.manifest_json,
    manifestDigest: raw.manifest_digest,
    certainty: raw.certainty as RecoveryEffectCertainty,
    coverage: raw.coverage as RecoveryWorkspaceCoverage,
    issuedAtMs: raw.issued_at_ms,
    supersededAtMs: raw.superseded_at_ms
  });
}

export function toReferenceRow(raw: RawReferenceRow): ReferenceRow {
  return Object.freeze({
    handoffId: raw.handoff_id,
    revisionNo: raw.revision_no,
    artifactId: raw.artifact_id,
    role: raw.role as HandoffReferenceRole,
    required: raw.required === 1,
    expectedDigest: raw.expected_digest,
    pinState: raw.pin_state as HandoffPinState,
    pinRefusal: raw.pin_refusal,
    lastResolution: raw.last_resolution as HandoffResolution | null,
    resolvedAtMs: raw.resolved_at_ms
  });
}

export function toDeliveryRow(raw: RawDeliveryRow): DeliveryRow {
  return Object.freeze({
    intentId: raw.intent_id,
    handoffId: raw.handoff_id,
    revisionNo: raw.revision_no,
    targetAttemptId: raw.target_attempt_id,
    envelopeDigest: raw.envelope_digest,
    transport: raw.transport as DeliveryTransport,
    backendId: raw.backend_id,
    profileId: raw.profile_id,
    profileVersion: raw.profile_version,
    ownerDigest: raw.owner_digest,
    sessionPlan: raw.session_plan as SessionPlanKind,
    sessionReason: raw.session_reason as FreshSessionReason | null,
    sessionId: raw.session_id,
    connectionId: raw.connection_id,
    promptId: raw.prompt_id,
    capabilitiesDigest: raw.capabilities_digest,
    accessPlanDigest: raw.access_plan_digest,
    outcome: raw.outcome as DeliveryOutcome,
    outcomeReason: raw.outcome_reason as DeliveryOutcomeReason | null,
    decisionId: raw.decision_id,
    recordedAtMs: raw.recorded_at_ms,
    settledAtMs: raw.settled_at_ms
  });
}

export function toDecisionRow(raw: RawDecisionRow): DecisionRow {
  return Object.freeze({
    decisionId: raw.decision_id,
    handoffId: raw.handoff_id,
    revisionNo: raw.revision_no,
    decision: raw.decision as HandoffDecision,
    outcome: raw.outcome as DecisionOutcome,
    consumedByIntentId: raw.consumed_by_intent_id,
    recordedAtMs: raw.recorded_at_ms
  });
}
