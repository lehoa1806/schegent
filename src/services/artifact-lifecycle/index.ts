/**
 * FR-R6-F05 — artifact lifecycle service barrel and factory.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { ArtifactLifecycleServiceDependencies } from './lifecycle-context';
import { ArtifactLifecycleService } from './lifecycle-service';

export {
  ArtifactLifecycleService,
  type ArtifactLifecycleServiceDependencies,
  type EarlyReleaseRequest
} from './lifecycle-service';
export {
  accessDependenciesFromContext,
  createArtifactAccessHandles,
  type AccessHandleDependencies,
  type ArtifactAccessHandles,
  type MaterializeCopyOptions
} from './access-handles';
export {
  ArtifactRecordStore,
  decideReconciledAvailability,
  type ArtifactByteObservation,
  type ArtifactByteProbe,
  type ArtifactLocator,
  type ManagedPageRequest,
  type RegisterArtifactInput
} from './artifact-records';
export {
  DELETION_LEASE_TTL_MS,
  executeDeletion,
  getDeletionOperation,
  reconcileDeletionOperation,
  type DeletionRequest
} from './deletion-operations';
export {
  DELETION_PREVIEW_MAX_EXCEPTIONS,
  planDeletion,
  previewDeletion,
  type DeletionPlan,
  type DeletionPlanTarget,
  type DeletionSelection
} from './deletion-plan';
export { boundInventoryPage, listInventory, type InventoryRequest } from './inventory';
export { classifyLegacyCatalogResidue, type LegacyCatalogRoot } from './legacy-classification';
export {
  createLegacyPreservation,
  LegacyPreservation,
  type LegacyPreservationDependencies
} from './legacy-preservation';
export { DEFAULT_QUARANTINE_SEGMENTS } from './legacy-preservation-context';
export { createNodeLegacyPreservationFs, type LegacyPreservationFs } from './legacy-preservation-fs';
export {
  DEFAULT_LIFECYCLE_WORKSPACE_ID,
  type ArtifactStanding,
  type LegacyCatalogDependencies,
  type LifecycleContext
} from './lifecycle-context';
export { mapF04Availability, resolveAvailability } from './availability-mapping';
export {
  DENY_ALL_ACCESS_POLICY,
  type ArtifactAccessPolicy,
  type ArtifactByteReader,
  type LifecycleFs,
  type LifecycleFsEntry,
  type StorageScanRoot
} from './lifecycle-ports';
export {
  F05_LIFECYCLE_DDL,
  F05_LIFECYCLE_MIGRATION_NAME,
  F05_LIFECYCLE_MIGRATION_VERSION,
  F05_LIFECYCLE_TABLE_NAMES
} from './lifecycle-schema';
export {
  checkMutationAuthority,
  checkStandingAuthority,
  runAuthorizedMutation,
  type LifecycleAuditRecord,
  type LifecycleAuditSink,
  type LifecycleMutationResult
} from './mutation-authority';
export { PreviewStore } from './previews';
export {
  adoptPolicy,
  currentRetentionDecisions,
  evaluateEligibility,
  isRetentionPolicy,
  POLICY_PREVIEW_MAX_EXCEPTIONS,
  previewPolicyAdoption,
  readAdoptedPolicy
} from './retention-policy';
export {
  ARCHIVAL_PREVIEW_MAX_EXCEPTIONS,
  archiveTerminalTasks,
  expireArchivedDetail,
  isUnresolvedFrameStatus,
  listArchivedTasks,
  previewArchival
} from './task-archival';
export {
  ReferenceStore,
  referenceIdFor,
  type AddReferenceInput,
  type OwnerResolution,
  type OwnerResolver,
  type ProtectionVerdict,
  type ReleaseReferenceInput
} from './references';
export {
  reconcileAfterRestart,
  type PreservationReconciler,
  type RestartReconciliation
} from './restart-reconciliation';
export { buildPressureReport, inventoryCoverage, SHARED_ADMISSION_AUTHORITY } from './storage-pressure';
export { scanDeclaredRoots, type StorageScanSnapshot, type StorageScanTotals } from './storage-scan';
export { evaluateSweepCandidate, type SweepCandidateInput } from './sweep-delegation';

export function createArtifactLifecycleService(deps: ArtifactLifecycleServiceDependencies): ArtifactLifecycleService {
  return new ArtifactLifecycleService(deps);
}
