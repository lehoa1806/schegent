/**
 * FR-R6-F08 — the recovery handoff service and the pure modules F13 and F01-B use.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export {
  createRecoveryHandoffService,
  type RecoveryHandoffService,
  type RecoveryHandoffServiceDeps,
  type ResolveResult
} from './recovery-handoff-service';
export {
  envelopeDigestOf,
  type AssessAttemptResult,
  type CaptureCandidateOptions,
  type CaptureCandidateResult,
  type RecoveryEnvelopePort
} from './handoff-envelopes';
export type { IssueResult, PrepareResult, RequiredPinRefusal } from './handoff-prepare';
export type { PriorSessionInput, RecordIntentInput, RecordIntentResult } from './handoff-intent';
export type { AcknowledgeResult, ConsumeResult, ReopenResult, ReportNotSentResult } from './handoff-settle';
export type { DecideResult, ExplainResult, SetPausedResult, SupersedeResult } from './handoff-operator';
export {
  buildExplanation,
  HandoffExplanationContentError,
  type ExplainedAttribution,
  type ExplainedDecision,
  type ExplainedDelivery,
  type ExplainedExclusion,
  type ExplainedOmission,
  type ExplainedReference,
  type HandoffExplanation,
  type HandoffExplanationSnapshot,
  type HandoffExplanationTruncation
} from './handoff-explanation';
export {
  evaluateRedelivery,
  type RedeliveryDecision,
  type RedeliveryInput,
  type RedeliveryPriorIntent,
  type RedeliveryRequest,
  type RedeliveryVerdict
} from './delivery-policy';
export { planSession, type PriorSession, type SessionParty, type SessionPlanInput } from './session-plan';
export { cutoffKeyFor, decisionIdFor, handoffIdFor, intentIdFor, ownerDigestFor } from './handoff-identity';
export { HANDOFF_PIN_LIMIT, pinPurposeFor, type PinRefusal } from './handoff-pins';
export {
  classifyResolution,
  type OmittedReference,
  type ResolvedReference,
  type RevisionResolution,
  type RevisionUsability
} from './handoff-resolver';
export {
  serializeHandoffManifest,
  validateHandoffManifest,
  type HandoffManifest
} from '../../contracts/recovery-handoff/handoff-manifest';
export type { ImportLegacyResult } from './legacy-handoff-import';
export {
  LEGACY_RECORD_STATUSES,
  legacyPriorSession,
  mapLegacyRecord,
  type AcpSessionMapping,
  type LegacyHandoffRecord,
  type LegacyMapping,
  type LegacyRecordStatus
} from './legacy-handoff-mapping';
