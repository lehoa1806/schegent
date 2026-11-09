/**
 * FR-R6-F05 — `ArtifactLifecycleService`, the single authority for every
 * F05-governed operation (FR-021). The headless API and the read-only webview
 * storage-details query call it and return its result types unchanged.
 *
 * The facade holds the injected dependencies and delegates to one module per
 * concern: records, previews, the mutation gate, and the story modules.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { randomUUID } from 'node:crypto';
import type {
  ArtifactAccessHandle,
  ArtifactRecord,
  ArtifactReference,
  DeletionOperation,
  LifecycleResult,
  MutationAuthority,
  MutationRequestBase,
  PreviewKind,
  RetentionPolicy,
  RetentionPreview,
  SourcePreservationOperation,
  StorageInventoryPage,
  StoragePressureReport,
  StorageScanResult
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { MaterializedCopy, QualifyAccessRequest } from '../../contracts/artifact-lifecycle/access-types';
import type {
  LegacyCatalogAdmissionPort,
  LegacyCatalogClassification,
  LegacyPurgeRequest,
  LegacyPurgeResult,
  LegacyQuarantineRequest,
  LegacyReimportPreview
} from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import type {
  ArchivalQueueInput,
  ArchivalRequest,
  ArchivalResult,
  ArchivedDetailExpiry,
  ArchivedTaskListRequest,
  ArchivedTaskPage,
  PolicyAdoptionRequest,
  PolicyAdoptionResult,
  RunFrameStatusLookup
} from '../../contracts/artifact-lifecycle/retention-policy-types';
import { SWEEPER_CENSUS, type SweeperCensusEntry } from '../../contracts/artifact-lifecycle/sweeper-census';
import {
  accessDependenciesFromContext,
  createArtifactAccessHandles,
  type ArtifactAccessHandles,
  type MaterializeCopyOptions
} from './access-handles';
import { ArtifactRecordStore, type RegisterArtifactInput } from './artifact-records';
import {
  executeDeletion,
  getDeletionOperation,
  reconcileDeletionOperation,
  type DeletionRequest
} from './deletion-operations';
import { previewDeletion, type DeletionSelection } from './deletion-plan';
import { listInventory, type InventoryRequest } from './inventory';
import { createLegacyPreservation, type LegacyPreservation } from './legacy-preservation';
import type { ArtifactLifecycleServiceDependencies, LifecycleContext } from './lifecycle-context';
import { isOpaqueId, ok, refuse } from './lifecycle-results';
import { checkMutationAuthority, runAuthorizedMutation } from './mutation-authority';
import { PreviewStore } from './previews';
import { adoptPolicy, previewPolicyAdoption } from './retention-policy';
import {
  ReferenceStore,
  type AddReferenceInput,
  type ProtectionVerdict,
  type ReleaseReferenceInput
} from './references';
import { reconcileAfterRestart, type RestartReconciliation } from './restart-reconciliation';
import { buildPressureReport } from './storage-pressure';
import { scanDeclaredRoots, type StorageScanSnapshot } from './storage-scan';
import { archiveTerminalTasks, expireArchivedDetail, listArchivedTasks, previewArchival } from './task-archival';

export type { ArtifactLifecycleServiceDependencies } from './lifecycle-context';

/** Without a control-ledger lookup every run counts as unresolved, so no Task is archived (fail closed). */
const UNKNOWN_RUN_FRAMES: RunFrameStatusLookup = () => ['in-flight'];

const NO_LEGACY_CATALOG = 'no legacy catalog is configured';

export interface EarlyReleaseRequest extends MutationRequestBase {
  readonly referenceId: string;
}

export class ArtifactLifecycleService {
  protected readonly deps: ArtifactLifecycleServiceDependencies;
  protected readonly records: ArtifactRecordStore;
  protected readonly previews: PreviewStore;
  protected readonly references: ReferenceStore;
  protected readonly newId: () => string;
  /** The entries of the latest scan this instance took; the inventory pages them. */
  private lastScan: StorageScanSnapshot | null = null;
  private accessHandleInstance: ArtifactAccessHandles | null = null;

  public constructor(deps: ArtifactLifecycleServiceDependencies) {
    this.deps = deps;
    this.newId = deps.newId ?? randomUUID;
    this.records = new ArtifactRecordStore(deps.conn, deps.nowMs);
    this.previews = new PreviewStore(deps.conn, deps.nowMs, this.newId);
    this.references = new ReferenceStore(deps.conn, deps.nowMs);
  }

  protected get ctx(): LifecycleContext {
    return {
      deps: this.deps,
      records: this.records,
      previews: this.previews,
      references: this.references,
      newId: this.newId
    };
  }

  public registerArtifact(input: RegisterArtifactInput): LifecycleResult<ArtifactRecord> {
    return this.records.register(input);
  }

  public getArtifact(artifactId: string): LifecycleResult<ArtifactRecord> {
    return this.records.get(artifactId);
  }

  public reconcileArtifact(artifactId: string): Promise<LifecycleResult<ArtifactRecord>> {
    return this.records.reconcile(artifactId, this.deps.probe);
  }

  /** The fixed-order gate (FR-021, AC-09); exposed so callers can pre-check a request. */
  public checkMutationAuthority(
    request: MutationRequestBase,
    kind: PreviewKind,
    currentBasis: string
  ): LifecycleResult<RetentionPreview> {
    return checkMutationAuthority(this.previews, request, kind, currentBasis);
  }

  /** Every existing evidence sweeper and its protection (clarification 1); the operator guide renders it. */
  public listSweeperCensus(): readonly SweeperCensusEntry[] {
    return SWEEPER_CENSUS;
  }

  public addReference(input: AddReferenceInput): LifecycleResult<ArtifactReference> {
    return this.references.add(input);
  }

  public releaseReference(input: ReleaseReferenceInput): LifecycleResult<ArtifactReference> {
    return this.references.release(input);
  }

  public listReferences(artifactId: string): LifecycleResult<readonly ArtifactReference[]> {
    return this.references.list(artifactId);
  }

  public isProtected(artifactId: string): ProtectionVerdict {
    return this.references.isProtected(artifactId, this.deps.resolveOwner);
  }

  public protectedRunIds(): ReadonlySet<string> {
    return this.references.protectedRunIds();
  }

  /** FR-007: the preview names the recovery capability the release surrenders. */
  public previewEarlyRelease(referenceId: string): LifecycleResult<RetentionPreview> {
    const found = this.references.getById(referenceId);
    if (!found.ok) return found;
    const reference = found.value;
    if (!reference.active) return refuse('invalid-input', 'the reference is already released');
    const artifact = this.records.get(reference.artifactId);
    const byteSize = artifact.ok ? artifact.value.byteSize : 0;
    const summary = this.references.earlyReleaseSummary(reference, byteSize);
    return { ok: true, value: this.previews.create('early-release', this.references.earlyReleaseBasis(reference), summary) };
  }

  public releaseReferenceEarly(request: EarlyReleaseRequest): LifecycleResult<ArtifactReference> {
    if (!isOpaqueId(request.referenceId)) return refuse('invalid-input', 'reference id is malformed');
    const found = this.references.getById(request.referenceId);
    if (!found.ok) return found;
    const gated = runAuthorizedMutation(
      { previews: this.previews, audit: this.deps.audit },
      request,
      'early-release',
      this.references.earlyReleaseBasis(found.value),
      () => {
        const released = this.references.releaseEarly(request.referenceId);
        return {
          operationId: this.newId(),
          counts: { released: released.ok ? 1 : 0 },
          result: released.ok ? 'completed' : 'refused',
          value: released
        };
      }
    );
    return gated.ok ? gated.value : gated;
  }

  /** One bounded inventory page (FR-009, FR-012, NFR-001). */
  public listInventory(request: InventoryRequest = {}): LifecycleResult<StorageInventoryPage> {
    return listInventory(this.ctx, this.lastScan, request);
  }

  /** Walks the declared roots once; the inventory then pages this scan's entries (FR-012). */
  public async scanDeclaredRoots(signal?: AbortSignal): Promise<LifecycleResult<StorageScanResult>> {
    const { result, snapshot } = await scanDeclaredRoots(this.ctx, signal);
    this.lastScan = snapshot;
    return result;
  }

  public getPressureReport(): LifecycleResult<StoragePressureReport> {
    return buildPressureReport(this.ctx);
  }

  public previewDeletion(selection: DeletionSelection = {}): LifecycleResult<RetentionPreview> {
    return previewDeletion(this.ctx, selection);
  }

  public executeDeletion(request: DeletionRequest, signal?: AbortSignal): Promise<LifecycleResult<DeletionOperation>> {
    return executeDeletion(this.ctx, request, signal);
  }

  public reconcileDeletionOperation(
    operationId: string,
    authority: MutationAuthority,
    signal?: AbortSignal
  ): Promise<LifecycleResult<DeletionOperation>> {
    return reconcileDeletionOperation(this.ctx, operationId, authority, signal);
  }

  /**
   * Host-internal, at activation and before any sweep: resumes every unfinished deletion and
   * settles every in-flight preservation. Takes the host's authority because a resume needs standing.
   */
  public reconcileAfterRestart(
    authority: MutationAuthority,
    signal?: AbortSignal
  ): Promise<LifecycleResult<RestartReconciliation>> {
    return reconcileAfterRestart(this.ctx, authority, (operationId) => this.reconcilePreservation(operationId), signal);
  }

  public getDeletionOperation(operationId: string): LifecycleResult<DeletionOperation> {
    return getDeletionOperation(this.ctx, operationId);
  }

  /** FR-014: what adopting `policy` would collect, keep and archive. */
  public previewRetentionPolicy(policy: RetentionPolicy): LifecycleResult<RetentionPreview> {
    return previewPolicyAdoption(this.ctx, policy);
  }

  public adoptRetentionPolicy(request: PolicyAdoptionRequest): LifecycleResult<PolicyAdoptionResult> {
    return adoptPolicy(this.ctx, request);
  }

  /** FR-016: which terminal Tasks would leave the hot lists; Tasks with unresolved frames stay. */
  public previewTaskArchival(queues: readonly ArchivalQueueInput[]): LifecycleResult<RetentionPreview> {
    return previewArchival(this.ctx, queues, this.frameStatuses());
  }

  public archiveTerminalTasks(request: ArchivalRequest): LifecycleResult<ArchivalResult> {
    return archiveTerminalTasks(this.ctx, request, this.frameStatuses());
  }

  public expireArchivedDetail(): LifecycleResult<ArchivedDetailExpiry> {
    return expireArchivedDetail(this.ctx);
  }

  public listArchivedTasks(request: ArchivedTaskListRequest): LifecycleResult<ArchivedTaskPage> {
    return listArchivedTasks(this.ctx, request);
  }

  /** FR-023: a qualified handle under the injected access policy; a caller cannot supply its own policy. */
  public qualifyAccess(request: QualifyAccessRequest): Promise<LifecycleResult<ArtifactAccessHandle>> {
    return this.accessHandles().qualifyAccess(request, this.deps.accessPolicy);
  }

  public materializeCopy(
    handle: ArtifactAccessHandle,
    destinationRoot: string,
    options?: MaterializeCopyOptions
  ): Promise<LifecycleResult<MaterializedCopy>> {
    return this.accessHandles().materializeCopy(handle, destinationRoot, options);
  }

  public resolveMaterializedCopy(copyId: string): LifecycleResult<MaterializedCopy> {
    return this.accessHandles().resolveMaterializedCopy(copyId);
  }

  /** FR-013: read-only classification of version-before-manifest residue. */
  public async classifyLegacyCatalogResidue(): Promise<LifecycleResult<LegacyCatalogClassification>> {
    const legacy = this.legacy();
    return legacy === null ? refuse('unavailable', NO_LEGACY_CATALOG) : ok(await legacy.classifyLegacyCatalogResidue());
  }

  public previewLegacyQuarantine(basisRevision: string): Promise<LifecycleResult<RetentionPreview>> {
    return this.withLegacy((legacy) => legacy.previewLegacyQuarantine(basisRevision));
  }

  /** FR-014: copy, verify the digest, then contained remove; never an overwrite. */
  public quarantineLegacyResidue(
    request: LegacyQuarantineRequest
  ): Promise<LifecycleResult<SourcePreservationOperation>> {
    return this.withLegacy((legacy) => legacy.quarantineLegacyResidue(request));
  }

  public reconcilePreservation(operationId: string): Promise<LifecycleResult<SourcePreservationOperation>> {
    return this.withLegacy((legacy) => legacy.reconcilePreservation(operationId));
  }

  /** FR-015: re-import goes through the catalog's own admission gates; a conflict refuses. */
  public previewLegacyReimport(
    residueId: string,
    admission: LegacyCatalogAdmissionPort
  ): Promise<LifecycleResult<LegacyReimportPreview>> {
    return this.withLegacy((legacy) => legacy.previewReimport(residueId, admission));
  }

  public previewQuarantinePurge(): Promise<LifecycleResult<RetentionPreview>> {
    return this.withLegacy((legacy) => legacy.previewQuarantinePurge());
  }

  public purgeQuarantinedResidue(request: LegacyPurgeRequest): Promise<LifecycleResult<LegacyPurgeResult>> {
    return this.withLegacy((legacy) => legacy.purgeQuarantinedResidue(request));
  }

  private withLegacy<T>(
    run: (legacy: LegacyPreservation) => Promise<LifecycleResult<T>>
  ): Promise<LifecycleResult<T>> {
    const legacy = this.legacy();
    return legacy === null ? Promise.resolve(refuse('unavailable', NO_LEGACY_CATALOG)) : run(legacy);
  }

  private legacy(): LegacyPreservation | null {
    const catalog = this.deps.legacyCatalog;
    if (catalog === undefined) return null;
    return createLegacyPreservation({
      ...catalog,
      conn: this.deps.conn,
      nowMs: this.deps.nowMs,
      newId: this.newId,
      workspaceId: this.deps.workspaceId,
      previews: this.previews,
      audit: this.deps.audit
    });
  }

  private frameStatuses(): RunFrameStatusLookup {
    return this.deps.runFrameStatuses ?? UNKNOWN_RUN_FRAMES;
  }

  /** One instance per service: it remembers the handles it issued, and only those are honoured. */
  private accessHandles(): ArtifactAccessHandles {
    this.accessHandleInstance ??= createArtifactAccessHandles(accessDependenciesFromContext(this.ctx, this.deps.byteReader));
    return this.accessHandleInstance;
  }
}
