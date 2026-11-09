// FR-R6-F05 (FR-021, contract surfaces-and-wiring.md §4) — the headless artifact lifecycle API.
//
// Every function validates its request with the validator the sidebar handler uses, then delegates to
// the injected `ArtifactLifecycleService` and returns its `LifecycleResult` unchanged. A malformed
// request is refused `invalid-input` before the service sees it. Mutations carry their own
// `MutationAuthority`, preview id and confirmation; the service gate decides them in its fixed order.
//
// This module imports no editor host API (rule 13). It performs no I/O of its own and retains nothing.
//
// `previewTaskArchival` is not in the §4 table: archival is a previewed mutation, so a caller needs a
// preview id to present, exactly as deletion has `previewArtifactDeletion`.

import type {
  DeletionOperation,
  LifecycleResult,
  RetentionPreview,
  StorageInventoryPage,
  StoragePressureReport
} from '../contracts/artifact-lifecycle/lifecycle-types';
import {
  validateArchivalPreviewRequest,
  validateArchivalRequest,
  validateDeletionExecuteRequest,
  validateDeletionPreviewRequest,
  validateInventoryRequest,
  validatePolicyAdoptionRequest,
  validateRetentionPolicyPreviewRequest
} from '../contracts/validators/artifact-lifecycle';
import type { ArchivalResult, PolicyAdoptionResult } from '../contracts/artifact-lifecycle/retention-policy-types';
import type { StorageDetailsReader } from '../contracts/sidebar-ipc/storage-details';
import type { ArtifactLifecycleService } from '../services/artifact-lifecycle/lifecycle-service';

/** The service surface this module needs; a narrower type keeps fakes honest in tests. */
export type ArtifactLifecycleApiService = Pick<
  ArtifactLifecycleService,
  | 'listInventory'
  | 'getPressureReport'
  | 'previewDeletion'
  | 'executeDeletion'
  | 'previewRetentionPolicy'
  | 'adoptRetentionPolicy'
  | 'previewTaskArchival'
  | 'archiveTerminalTasks'
>;

/** One inventory page (FR-009, FR-012). */
export function getStorageInventory(
  service: ArtifactLifecycleApiService,
  request?: unknown
): LifecycleResult<StorageInventoryPage> {
  const valid = validateInventoryRequest(request);
  if (!valid.ok) return valid;
  return service.listInventory(valid.value);
}

/** The storage pressure report (FR-020). */
export function getStoragePressure(service: ArtifactLifecycleApiService): LifecycleResult<StoragePressureReport> {
  return service.getPressureReport();
}

/** A deletion preview; its id is what `executeArtifactDeletion` must present (FR-008). */
export function previewArtifactDeletion(
  service: ArtifactLifecycleApiService,
  request?: unknown
): LifecycleResult<RetentionPreview> {
  const valid = validateDeletionPreviewRequest(request);
  if (!valid.ok) return valid;
  return service.previewDeletion(valid.value);
}

/** Execute a previewed, confirmed deletion (FR-010); resumable after a restart. */
export async function executeArtifactDeletion(
  service: ArtifactLifecycleApiService,
  request: unknown,
  signal?: AbortSignal
): Promise<LifecycleResult<DeletionOperation>> {
  const valid = validateDeletionExecuteRequest(request);
  if (!valid.ok) return valid;
  return service.executeDeletion(valid.value, signal);
}

/** What adopting a retention policy would collect, keep and archive (FR-014). */
export function previewRetentionPolicy(service: ArtifactLifecycleApiService, policy: unknown): LifecycleResult<RetentionPreview> {
  const valid = validateRetentionPolicyPreviewRequest(policy);
  if (!valid.ok) return valid;
  return service.previewRetentionPolicy(valid.value);
}

/** Adopt a previewed, confirmed policy; returns the new revision (FR-014). */
export function adoptRetentionPolicy(
  service: ArtifactLifecycleApiService,
  request: unknown
): LifecycleResult<PolicyAdoptionResult> {
  const valid = validatePolicyAdoptionRequest(request);
  if (!valid.ok) return valid;
  return service.adoptRetentionPolicy(valid.value);
}

/** Which terminal Tasks would leave the hot lists; its id is what `archiveTerminalTasks` presents (FR-016). */
export function previewTaskArchival(service: ArtifactLifecycleApiService, request: unknown): LifecycleResult<RetentionPreview> {
  const valid = validateArchivalPreviewRequest(request);
  if (!valid.ok) return valid;
  return service.previewTaskArchival(valid.value);
}

/** Archive previewed terminal Tasks; Tasks with unresolved control frames are skipped (FR-016). */
export function archiveTerminalTasks(service: ArtifactLifecycleApiService, request: unknown): LifecycleResult<ArchivalResult> {
  const valid = validateArchivalRequest(request);
  if (!valid.ok) return valid;
  return service.archiveTerminalTasks(valid.value);
}

const STORE_NOT_OPEN: LifecycleResult<never> = {
  ok: false,
  refusal: { code: 'unavailable', message: 'the application store is not open in this window' }
};

/**
 * The sidebar's storage-details reader (contract §5). It answers with exactly what
 * `getStoragePressure` and `getStorageInventory` answer, so the two surfaces cannot disagree
 * (SC-009). With no service, every read is refused `unavailable`; production passes `null` until
 * the application store is constructed there (F01-B cutover).
 */
export function createStorageDetailsReader(service: ArtifactLifecycleApiService | null): StorageDetailsReader {
  return {
    read(cursor) {
      if (service === null) return STORE_NOT_OPEN;
      const pressure = getStoragePressure(service);
      if (!pressure.ok) return pressure;
      const page = getStorageInventory(service, cursor === undefined ? undefined : { cursor });
      if (!page.ok) return page;
      return { ok: true, value: { pressure: pressure.value, page: page.value } };
    }
  };
}
