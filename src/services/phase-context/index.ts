/**
 * FR-R6-F15 (F15-A + F15-B) — the phase-context handoff surface: policy and identity parsing,
 * source contribution and selection, the manifest and its one rendering, preparation, acceptance
 * with revisions, approval and dispatch intents, the delivery plan, the review loop, the
 * metadata-only explanation, observation and admission, durable SQLite storage, cross-root
 * streaming materialization, and attempt-scoped result publication. Types are in
 * `src/contracts/phase-context/`. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export {
  createAcceptanceService,
  type AcceptanceService,
  type AcceptResult,
  type ApproveResult,
  type DispatchIntentResult,
  type EditOutcome,
  type InspectResult,
  type SettleResult
} from './acceptance';
export {
  allocateAttemptStagingPaths,
  captureAttemptPublications,
  type AttemptStagingPaths,
  type CaptureAttemptPublicationsInput,
  type CaptureAttemptPublicationsResult,
  type PublishedArtifactCapture,
  type StagedContributionOutcome,
  type StagedFixClaimsOutcome,
  type StagedReviewReportOutcome
} from './attempt-result-publisher';
export { checkDispatch, planDelivery, type DeliveryInput, type DeliveryResult, type DispatchCheck } from './delivery-plan';
export { explainHandoff, explainReviewLoop, observationOf, observePrepared, type ExplainResult } from './explanation';
export {
  createFindingLedger,
  rehydrateFindingLedger,
  type AcceptReportResult,
  type ClaimsContext,
  type FindingLedger,
  type FindingLedgerSnapshot,
  type LedgerOptions,
  type RecordClaimsResult,
  type ReportContext
} from './finding-ledger';
export {
  artifactVersionKey,
  materializeHandoffArtifacts,
  type MaterializationSource,
  type MaterializeBatchInput,
  type MaterializeBatchResult,
  type MaterializedArtifactEntry
} from './handoff-materializer';
export { handoffIdOf, parseHandoffIdentity, type IdentityParse } from './identity';
export { buildLoopHistory } from './loop-history';
export { buildManifest, manifestDigestOf, parseManifest, serializeManifest, type ManifestInput, type ManifestParse } from './manifest';
export { createMemoryHandoffStore } from './memory-store';
export { parseBoundInputs, parseHandoffPolicy, policyDigestOf, type PolicyParse } from './policy';
export { prepareHandoff, type PrepareInput, type PrepareResult } from './preparation';
export {
  createPreparationAdmission,
  type AdmissionOptions,
  type AdmissionResult,
  type AdmissionSnapshot,
  type AdmissionState,
  type PreparationAdmission
} from './preparation-admission';
export { renderContext } from './renderer';
export { parseFixClaims, parseReviewReport, type FixClaimsResult, type ReviewReportResult } from './review-report';
export { editRevision, preparedOf, type EditResult } from './revision-edit';
export { selectSources, type SelectionInput, type SelectionResult, type SourceCost, type ValidCandidate } from './selection';
export { parseSourceContribution, type ContributionParse } from './source-contribution';
export {
  createSqliteHandoffStore,
  type DurableHandoffStore,
  type HandoffRunMetadata,
  type StoredReviewLoopEntry
} from './sqlite-handoff-store';
export {
  createPhaseHandoffCoordinator,
  normalizeNodePathForHandoff,
  type PhaseHandoffCoordinator,
  type PhaseHandoffCoordinatorDeps,
  type PlanAttemptDeliveryInput,
  type PlanAttemptDeliveryResult,
  type PrepareTransitionHandoffInput,
  type PrepareTransitionHandoffResult,
  type RecordSettledAttemptInput,
  type ReviewLoopInspection,
  type TargetProfileResolution
} from './phase-handoff-coordinator';
