// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: DEFERRED.
// Opening the writable SQLite store, executing F04 cutover migrations, and reconciling
// F05/F06/F07/F08 state are handed to `stage2-producers.ts` via `runSafety.replayTerminalTransitions`
// and `runSafety.reconcileComposableWorkflowRuns`, gated on `isWorkspaceTrusted()` and `lock.hasPrimacy()`.
// At wiring time this module only attaches a read-only SQLite snapshot if an existing DB file is present.

import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { DeliveryRepresentation } from '../contracts/phase-context/context-delivery';
import { createPhaseContextApi, type PhaseContextApi } from '../headless/phase-context-api';
import type { SanitizedLogger } from '../lib/logger';
import { createSideEffectFailureReporter, type SideEffectFailureReport } from '../lib/side-effect-failure-reporter';
import type { AcpRunnerObservationEvent } from '../runner/acp-backed-runner';
import {
  createSqliteAcpDurableRuntimeStore,
  type AcpDurableRuntimeStore,
  type AcpSessionBindingStore
} from '../services/acp-runtime/acp-durable-runtime-store';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactLifecycleService
} from '../services/artifact-lifecycle';
import { SqliteCutoverStoreRegistry, type CutoverRegistrationSlot } from './sqlite-cutover-registry';
import { createDesktopOwnershipFenceForStore } from './workflow-ownership-fence';
import {
  buildContainedProbeAndReader,
  buildDurableHandoffSeam,
  buildNodeLifecycleFs,
  buildOwnerResolver,
  buildScanRoots,
  buildSecretPort,
  createDynamicStorageDetailsReader,
  createDynamicUsageAccountingReader,
  disposeSqliteRuntimeResources,
  isChildOfActiveComposableRun,
  isRecoveryEnvelopeProtectedForServices,
  isRecoveryRunProtectedForServices,
  ProtectedRunIdsUnavailableError,
  replayTelemetrySpoolAfterSettling,
  reportRelocationOutcome,
  sweepWithReadableProtection
} from './sqlite-cutover-helpers';
import {
  createExecFileGitRunner,
  createRunLaneCoordinator,
  LaneService,
  type RunLaneCoordinator
} from '../services/execution-lanes';
import { IntegrationStore } from '../services/execution-lanes/integration-store';
import { createSpawnCheck } from '../services/execution-lanes/verification-runner';
import {
  createChangeReviewService,
  integrationStoreSource,
  type ChangeReviewService
} from '../services/change-review';
import { createLiveLogIndex, type LiveLogIndex } from '../services/phase-log/live-log-index';
import {
  createReportingService,
  type ReportingService
} from '../services/reporting';
import {
  createPhaseHandoffCoordinator,
  createSqliteHandoffStore,
  type PhaseHandoffCoordinator
} from '../services/phase-context';
import {
  createRecoveryHandoffService,
  type RecoveryEnvelopePort,
  type RecoveryHandoffService
} from '../services/recovery-handoff';
import {
  relocateLegacySqliteStore,
  RelocationWalFilesystemRefusedError,
  SqliteApplicationStore,
  type StoreRelocationOutcome,
  type SwitchableCatalogFsAdapter
} from '../services/sqlite-store';
import type { FilesystemTypeVerdict } from '../services/sqlite-store/filesystem-type-detector';
import {
  createTelemetryHostService,
  type TelemetryHostService
} from '../services/telemetry-host/telemetry-host-service';
import type { AcpAttemptBinding, AcpUsageUpdate } from '../services/usage-accounting/acp-usage-mapping';
import { metricsRollupLegacySource } from '../services/usage-accounting/legacy-epoch';
import {
  createUsageAccountingService,
  type UsageAccountingService
} from '../services/usage-accounting/usage-accounting-service';
import {
  createUsageAccountingWiring,
  type TerminalRunSummary,
  type UsageAccountingWiring
} from '../services/usage-accounting/usage-accounting-wiring';
import {
  createCutoverAuthorityGuard,
  createDesktopWorkflowComposition,
  defaultCapabilityAssessment,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition,
  type ProductionWorkflowComposition
} from '../services/workflow-execution/production-workflow-composition';
import type { SwitchableOperationalMemento } from '../state/sqlite-operational-backing';
import type { WorkspaceStateStore } from '../state/workspace-state';
import {
  readLanesEnabled,
  readLanesLiveCap,
  readLanesProvisioningDeadlineMs,
  readProcessEnvironmentPolicy,
  readTelemetryExportUserSettings
} from './uncached-settings-accessors';

export {
  CutoverRegistrationOrderError,
  EXPECTED_CUTOVER_REGISTRATION_ORDER,
  type CutoverRegistrationSnapshot,
  type CutoverRegistrationSlot
} from './sqlite-cutover-registry';

const cutoverRegistry = new SqliteCutoverStoreRegistry<SqliteCutoverCoordinator>();

export const registerOperationalMementoForStore = cutoverRegistry.registerOperationalMemento.bind(cutoverRegistry);
export const getOperationalMementoForStore = cutoverRegistry.getOperationalMemento.bind(cutoverRegistry);
export const registerCatalogFsForStore = cutoverRegistry.registerCatalogFs.bind(cutoverRegistry);
export const registerWorkspaceLockForStore = cutoverRegistry.registerWorkspaceLock.bind(cutoverRegistry);
export const getWorkspaceLockForStore = cutoverRegistry.getWorkspaceLock.bind(cutoverRegistry);
export const getSqliteCutoverCoordinator = cutoverRegistry.getCoordinator.bind(cutoverRegistry);
export const inspectCutoverRegistrations = cutoverRegistry.inspect.bind(cutoverRegistry);
export const assertCutoverRegistrationOrder = cutoverRegistry.assertCompleteAndOrdered.bind(cutoverRegistry);
export function resetCutoverStage2(store: WorkspaceStateStore): readonly CutoverRegistrationSlot[] {
  try {
    return cutoverRegistry.resetStage2(store);
  } finally {
    unregisterProductionWorkflowComposition(store);
  }
}

export function disposeCutoverStore(store: WorkspaceStateStore): readonly CutoverRegistrationSlot[] {
  try {
    return cutoverRegistry.dispose(store);
  } finally {
    unregisterProductionWorkflowComposition(store);
  }
}

export function deriveWorkspaceScopeId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot, 'utf8').digest('hex').slice(0, 16);
}

/**
 * FR-R7-10 (closing review gap GC-26) — the canonical SQLite database a window opens:
 * `<globalStorageUri>/sqlite/<scope>/schegent-state.db`, where `<scope>` hashes the workspace root.
 * Keying strictly by `globalStorageUri` + `<scope>` gives one folder one operational store whether
 * VS Code opens it directly, via a `.code-workspace` file, or without a per-window `storageUri`.
 */
export function sqliteDatabasePathFor(
  storage: { readonly storageUri?: string | undefined; readonly globalStorageUri: string },
  workspaceRoot: string
): string {
  return path.join(storage.globalStorageUri, 'sqlite', deriveWorkspaceScopeId(workspaceRoot), 'schegent-state.db');
}

export interface SqliteCutoverServices {
  readonly sqliteStore: SqliteApplicationStore;
  readonly artifactLifecycle: ArtifactLifecycleService;
  readonly usageAccounting: UsageAccountingService;
  readonly usageWiring: UsageAccountingWiring;
  readonly telemetryHost: TelemetryHostService;
  readonly liveLogIndex: LiveLogIndex;
  readonly recoveryHandoff: RecoveryHandoffService;
  readonly laneService: LaneService;
  readonly runLaneCoordinator: RunLaneCoordinator;
  readonly phaseHandoffCoordinator: PhaseHandoffCoordinator;
  readonly acpRuntimeStore: AcpDurableRuntimeStore;
  readonly reportingService: ReportingService;
  readonly changeReviewService: ChangeReviewService;
  readonly workflowComposition: ProductionWorkflowComposition;
  readonly disposeTelemetryConfig?: () => void;
}

export interface SqliteCutoverCoordinator {
  readonly scopeId: string;
  readonly storageRoot: string;
  readonly expectedDatabasePath: string;
  probePassiveSnapshots(): Promise<void>;
  activatePrimary(): Promise<SqliteCutoverServices | null>;
  getServices(): SqliteCutoverServices | null;
  getSqliteStore(): SqliteApplicationStore | null;
  hasInFlightSqliteRun(): boolean;
  reloadAfterRestore(): Promise<void>;
  getArtifactLifecycle(): ArtifactLifecycleService | null;
  getUsageAccounting(): UsageAccountingService | null;
  getTelemetryHost(): TelemetryHostService | null;
  getLiveLogIndex(): LiveLogIndex | null;
  getRecoveryHandoff(): RecoveryHandoffService | null;
  getLaneService(): LaneService | null;
  getRunLaneCoordinator(): RunLaneCoordinator | null;
  getPhaseHandoffCoordinator(): PhaseHandoffCoordinator | null;
  resolveHandoffRepresentation(attemptId: string): DeliveryRepresentation | null;
  resolveHandoffContentDigest(handoffId: string): string | null;
  getReportingService(): ReportingService | null;
  getChangeReviewService(): ChangeReviewService | null;
  getPhaseContextApi(): PhaseContextApi;
  getAcpSessionBindingStore(): AcpSessionBindingStore | null;
  allocateAcpConnectionGeneration(): number | null;
  getProtectedRunIds(): ReadonlySet<string>;
  getDatabaseProtectedPaths(): readonly string[];
  isRecoveryEnvelopeProtected(runSegment: string, handoverSegment: string): boolean;
  isRecoveryRunProtected(runSegment: string): boolean;
  onTerminalRun(summary: TerminalRunSummary): void;
  completeRootExecutionLane(params: {
    readonly rootExecutionId: string;
    readonly laneId?: string | undefined;
    readonly status: 'completed' | 'failed' | 'canceled';
  }): void;
  recordAcpObservation(event: AcpRunnerObservationEvent): void;
  recordAcpUsageUpdate(update: AcpUsageUpdate, binding: AcpAttemptBinding | null): void;
  close(): void;
}

export interface CreateSqliteCutoverCoordinatorDeps {
  readonly context: Pick<vscode.ExtensionContext, 'storageUri' | 'globalStorageUri' | 'subscriptions'> & {
    readonly secrets?: (Pick<vscode.SecretStorage, 'get'> & Partial<Pick<vscode.SecretStorage, 'onDidChange'>>) | undefined;
  };
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  readonly auditWriter: AuditLogWriter;
  readonly envelopes: RecoveryEnvelopePort;
  readonly pinnedRunIds: () => ReadonlySet<string>;
  readonly logger: SanitizedLogger;
  readonly isWorkspaceTrusted: () => boolean;
  readonly hasPrimacy: () => Promise<boolean>;
  readonly subscribePrimacyLost?: (listener: () => void) => vscode.Disposable;
  readonly disposables: vscode.Disposable[];
  /** Optional operator notice callback (defaults to `vscode.window.showWarningMessage`). */
  readonly notifyOperator?: ((message: string) => void | Promise<void>) | undefined;
  /** Optional filesystem type for canonical storage root (enables deterministic WAL-refusal testing). */
  readonly canonicalFilesystemType?: string | undefined;
  /** Optional filesystem type for legacy storage root (test seam). */
  readonly legacyFilesystemType?: string | undefined;
  /** Optional host filesystem verdict probe (defaults to OS mount detector). */
  readonly detectFilesystemType?: ((targetPath: string) => Promise<FilesystemTypeVerdict>) | undefined;
  /** Optional additional legacy storage roots to inspect during one-time relocation (test seam). */
  readonly additionalLegacyStorageRoots?: readonly string[] | undefined;
}

interface OpenPrimarySqliteServicesInput {
  readonly deps: CreateSqliteCutoverCoordinatorDeps;
  readonly scopeId: string;
  readonly globalStorageRoot: string;
  readonly legacyStorageRoot: string | undefined;
  readonly operationalMemento: SwitchableOperationalMemento | undefined;
  readonly catalogFs: SwitchableCatalogFsAdapter | undefined;
  readonly reportSideEffectFailure: SideEffectFailureReport;
  readonly onActiveLocationResolved: (location: {
    readonly activeStorageRoot: string;
    readonly activeDatabasePath: string;
    readonly preservedUnselectedPaths: readonly string[];
    readonly legacyRetired: boolean;
  }) => void;
  readonly getProtectedPaths: () => readonly string[];
  readonly isClosed: () => boolean;
}

function defaultNotifyOperator(message: string): void {
  void vscode.window.showWarningMessage(message);
}

function emitOperatorNotice(
  deps: CreateSqliteCutoverCoordinatorDeps,
  message: string
): void {
  try {
    const fn = deps.notifyOperator ?? defaultNotifyOperator;
    void Promise.resolve(fn(message)).catch(() => undefined);
  } catch {
    // Best-effort operator notice must never crash activation.
  }
}

async function openPrimarySqliteServices(
  input: OpenPrimarySqliteServicesInput
): Promise<SqliteCutoverServices | null> {
  const { deps, scopeId, globalStorageRoot, legacyStorageRoot } = input;

  let relocationOutcome: StoreRelocationOutcome;
  try {
    relocationOutcome = await relocateLegacySqliteStore({
      scopeId,
      globalStorageUri: globalStorageRoot,
      legacyStorageUri: legacyStorageRoot,
      additionalLegacyStorageRoots: deps.additionalLegacyStorageRoots,
      canonicalFilesystemType: deps.canonicalFilesystemType,
      legacyFilesystemType: deps.legacyFilesystemType,
      detectFilesystemType: deps.detectFilesystemType,
      logger: deps.logger,
      verifyPrimacy: deps.hasPrimacy
    });
  } catch (error) {
    if (input.isClosed()) return null;
    const isWalFsRefusal = error instanceof RelocationWalFilesystemRefusedError;
    input.operationalMemento?.setDurableBatchUnavailableReason(
      isWalFsRefusal ? 'network-share-wal-unsupported' : 'relocation-aborted'
    );
    deps.logger.warn('sqlite cutover: relocation aborted', {
      reason: isWalFsRefusal ? error.reason : error instanceof Error ? error.name : 'unknown'
    });
    if (isWalFsRefusal) {
      emitOperatorNotice(deps, `Schegent refused to open the operational SQLite store on a WAL-ineligible network filesystem (${error.canonicalVerdict.filesystemType}).`);
    }
    return null;
  }

  if (input.isClosed()) return null;

  if (relocationOutcome.outcome === 'refused_newer_schema') {
    input.operationalMemento?.setDurableBatchUnavailableReason('refused-newer-schema');
    deps.logger.warn('sqlite cutover: refused relocation for newer schema', {
      reason: relocationOutcome.reason,
      recordedVersion: relocationOutcome.recordedVersion,
      maxSupportedVersion: relocationOutcome.maxSupportedVersion,
      offendingPath: relocationOutcome.offendingPath
    });
    emitOperatorNotice(
      deps,
      `Schegent refused to open or relocate the operational SQLite database (${relocationOutcome.reason}). Update Schegent before opening this workspace.`
    );
    return null;
  }

  const activeStorageRoot = relocationOutcome.activeStorageRoot;
  const activeDatabasePath = relocationOutcome.activeDatabasePath;
  const activeSourceKind = relocationOutcome.activeSourceKind;
  const legacyRetired =
    activeSourceKind === 'host_global_storage_uri' &&
    relocationOutcome.retirementPending !== true;

  input.onActiveLocationResolved({
    activeStorageRoot,
    activeDatabasePath,
    preservedUnselectedPaths: relocationOutcome.preservedUnselectedPaths,
    legacyRetired
  });
  reportRelocationOutcome(relocationOutcome, deps.logger, (msg) => emitOperatorNotice(deps, msg));

  if (input.isClosed() || !(await deps.hasPrimacy()) || input.isClosed()) {
    return null;
  }

  let sqliteStore: SqliteApplicationStore;
  try {
    const activeVerdict = relocationOutcome.activeFilesystemVerdict;
    sqliteStore = await SqliteApplicationStore.openAtTrustedLocation({
      trustedRootDir: activeStorageRoot,
      relativeSegments: ['sqlite', scopeId],
      databaseFileName: 'schegent-state.db',
      sourceKind: activeSourceKind,
      filesystemType:
        activeVerdict?.filesystemType ??
        (activeSourceKind === 'host_global_storage_uri'
          ? deps.canonicalFilesystemType
          : deps.legacyFilesystemType),
      filesystemClassification: activeVerdict?.classification,
      detectFilesystemType: deps.detectFilesystemType
    }, undefined, (message, fields) => deps.logger.warn(message, fields));
  } catch (error) {
    if (!input.isClosed()) input.operationalMemento?.setDurableBatchUnavailableReason('sqlite-open-failed');
    deps.logger.warn('sqlite cutover: failed to open application store', {
      reason: error instanceof Error ? error.name : 'unknown'
    });
    return null;
  }

  let createdTelemetryHost: TelemetryHostService | null = null;
  let createdUsageAccounting: UsageAccountingService | null = null;
  let usageWiring: UsageAccountingWiring | null = null;
  let workflowComposition: ProductionWorkflowComposition | null = null;
  let configSub: vscode.Disposable | null = null;
  let secretSub: vscode.Disposable | null = null;
  const cleanupPartial = (): void => {
    const ownedShared = !input.isClosed();
    if (workflowComposition !== null) unregisterProductionWorkflowComposition(deps.store, workflowComposition);
    disposeSqliteRuntimeResources({
      operationalMemento: input.operationalMemento,
      catalogFs: input.catalogFs,
      clearDetachedWriter: ownedShared,
      disposeTelemetryConfig: () => {
        try {
          configSub?.dispose();
        } catch {
          // Best-effort disposal must not prevent disposing sibling subscriptions.
        }
        try {
          secretSub?.dispose();
        } catch {
          // Best-effort disposal.
        }
      },
      usageAccounting: createdUsageAccounting,
      usageWiring,
      workflowComposition,
      telemetryHost: createdTelemetryHost,
      sqliteStore
    });
  };
  if (input.isClosed()) {
    cleanupPartial();
    return null;
  }

  try {
    input.operationalMemento?.attachSqlite(sqliteStore, scopeId);
    if (input.catalogFs !== undefined) {
      await input.catalogFs.attachSqlite(sqliteStore, scopeId, undefined, () => !input.isClosed());
      if (input.isClosed()) {
        cleanupPartial();
        return null;
      }
    }

    const { probe, reader } = buildContainedProbeAndReader(deps.workspaceRoot);
    const artifactLifecycle = createArtifactLifecycleService({
      conn: sqliteStore.writerConnection,
      nowMs: () => Date.now(),
      fs: buildNodeLifecycleFs([deps.workspaceRoot, activeStorageRoot], input.getProtectedPaths),
      probe,
      byteReader: reader,
      audit: {
        recordLifecycleMutation: (rec) => {
          deps.logger.info('artifact-lifecycle: mutation', {
            kind: rec.operationKind,
            opId: rec.operationId,
            result: rec.result
          });
        }
      },
      scanRoots: buildScanRoots(deps.workspaceRoot),
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: buildOwnerResolver(deps.store, sqliteStore.writerConnection),
      workspaceRoot: deps.workspaceRoot,
      workspaceId: scopeId,
      pinnedRunIds: deps.pinnedRunIds
    });

    await artifactLifecycle.reconcileAfterRestart({
      trusted: true,
      primary: true,
      auditHealthy: true
    });
    if (input.isClosed()) {
      cleanupPartial();
      return null;
    }

    const usageAccounting = createUsageAccountingService({
      conn: sqliteStore.writerConnection,
      nowUtc: () => new Date().toISOString(),
      monotonicMs: () => performance.now(),
      workspaceId: scopeId,
      logger: deps.logger
    });
    createdUsageAccounting = usageAccounting;
    await usageAccounting.importLegacyEpoch(metricsRollupLegacySource(deps.workspaceRoot));
    if (input.isClosed()) {
      cleanupPartial();
      return null;
    }

    const telemetryHost = createTelemetryHostService({
      sqliteStore,
      storageRoot: activeStorageRoot,
      secrets: buildSecretPort(deps.context.secrets),
      isWorkspaceTrusted: deps.isWorkspaceTrusted,
      serviceVersion: '0.2.0',
      reportSideEffectFailure: input.reportSideEffectFailure
    });
    createdTelemetryHost = telemetryHost;
    telemetryHost.configureFromUserSettings(readTelemetryExportUserSettings());
    // Subscribe immediately after initial configuration (before startup awaits) so settings or
    // SecretStorage changes during activation are never missed.
    configSub = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('schegent.telemetry.export')) {
        telemetryHost.configureFromUserSettings(readTelemetryExportUserSettings());
      }
    });
    const boundConfigSub = configSub;
    const secretsPort = deps.context.secrets;
    secretSub =
      secretsPort !== undefined && typeof secretsPort.onDidChange === 'function'
        ? secretsPort.onDidChange((event) => {
            telemetryHost.invalidateCredential(event.key);
          })
        : null;
    const boundSecretSub = secretSub;

    usageWiring = createUsageAccountingWiring({
      service: usageAccounting,
      auditWriter: deps.auditWriter,
      subscriptions: deps.disposables,
      logger: deps.logger,
      onAcceptedObservation: (observationId) => {
        telemetryHost.offerAcceptedObservationById(observationId);
      }
    });

    const liveLogIndex = createLiveLogIndex(sqliteStore.writerConnection);
    const acpRuntimeStore = createSqliteAcpDurableRuntimeStore(sqliteStore.writerConnection, scopeId);

    const recoveryHandoff = createRecoveryHandoffService({
      conn: sqliteStore.writerConnection,
      lifecycle: artifactLifecycle,
      probe,
      envelopes: deps.envelopes,
      acpSessionBindings: acpRuntimeStore.sessionBindings,
      clock: () => Date.now()
    });
    recoveryHandoff.reopen();

    const laneService = LaneService.open({
      connection: sqliteStore.writerConnection,
      workspaceRoot: deps.workspaceRoot,
      storageDir: activeStorageRoot,
      workspaceId: scopeId,
      liveLaneCap: readLanesLiveCap(deps.workspaceRoot),
      provisioningDeadlineMs: readLanesProvisioningDeadlineMs(deps.workspaceRoot),
      git: createExecFileGitRunner(),
      spawnCheck: createSpawnCheck({ environmentPolicy: () => readProcessEnvironmentPolicy(deps.workspaceRoot) }),
      clock: () => Date.now(),
      random: (size) => randomBytes(size),
      authorizeApproval: () => false
    });
    try {
      await laneService.reconcile();
    } catch (laneError) {
      if (!(laneError instanceof Error) || laneError.name !== 'LaneGitError') {
        deps.logger.warn('sqlite cutover: lane reconciliation skipped', {
          reason: laneError instanceof Error ? laneError.name : 'unknown'
        });
      }
    }
    if (input.isClosed()) {
      cleanupPartial();
      return null;
    }

    const runLaneCoordinator = createRunLaneCoordinator({
      getLaneService: () => laneService,
      isLanesEnabled: () => readLanesEnabled(deps.workspaceRoot),
      primaryWorkspaceRoot: deps.workspaceRoot
    });
    await runLaneCoordinator.refreshCacheFromStore();
    if (input.isClosed()) {
      cleanupPartial();
      return null;
    }

    const handoffStore = createSqliteHandoffStore(sqliteStore.writerConnection);
    const phaseHandoffCoordinator = createPhaseHandoffCoordinator({
      store: handoffStore,
      primaryWorkspaceRoot: deps.workspaceRoot,
      workspaceId: scopeId,
      lifecycle: artifactLifecycle,
      resolveExecutionRoot: (runId) => runLaneCoordinator.resolveExecutionRootSyncOrCached(runId),
      resolveLaneId: (runId) => runLaneCoordinator.resolveLaneIdForRun(runId)
    });
    phaseHandoffCoordinator.reconcileInterruptedDispatches();

    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const reportingService = createReportingService({
      conn: sqliteStore.writerConnection,
      readPool: sqliteStore.readPool,
      workspaceId: scopeId,
      workspaceRoot: deps.workspaceRoot,
      nowMs: () => Date.now(),
      monotonicMs: () => performance.now(),
      hostTimezone,
      accounting: usageAccounting,
      logger: {
        warn: (code, ctx) => {
          deps.logger.warn(code, ctx);
        }
      }
    });
    await reportingService.reconcileExports();
    if (input.isClosed() || !(await deps.hasPrimacy()) || input.isClosed()) {
      cleanupPartial();
      return null;
    }

    const changeReviewService = createChangeReviewService({
      source: integrationStoreSource(new IntegrationStore(sqliteStore.writerConnection), scopeId),
      git: createExecFileGitRunner(),
      cwd: deps.workspaceRoot
    });

    const durableHandoffSeam = buildDurableHandoffSeam(artifactLifecycle, sqliteStore.writerConnection);

    workflowComposition = createDesktopWorkflowComposition({
      store: deps.store,
      workspaceRoot: deps.workspaceRoot,
      isWorkspaceTrusted: deps.isWorkspaceTrusted,
      ...createDesktopOwnershipFenceForStore(deps.store),
      durableHandoffSeam,
      phaseHandoffCoordinator,
      cutoverAuthorityGuard: createCutoverAuthorityGuard({ mode: 'post-cutover-strict', storeAuthority: 'sqlite-f04', runtimeAuthority: 'acp-f13' }),
      assessBackendCapability: (backendId, capability) =>
        capability === 'durable-handoff'
          ? Object.freeze({ backendId, capability, status: 'verified' as const, source: 'fixture-adapter' as const, reasonCode: `capability-verified:${backendId}:durable-handoff` })
          : defaultCapabilityAssessment(backendId, capability)
    });
    registerProductionWorkflowComposition(deps.store, workflowComposition);

    void replayTelemetrySpoolAfterSettling(telemetryHost, input.reportSideEffectFailure);

    input.operationalMemento?.configureDetachedTrustedSqliteWriter({
      databasePath: activeDatabasePath,
      scopeId,
      canWrite: async () => !input.isClosed() && deps.isWorkspaceTrusted() && (await deps.hasPrimacy()) && !input.isClosed(),
      openStore: (databasePath) =>
        new SqliteApplicationStore({
          databasePath,
          onWalHealth: (message, fields) => deps.logger.warn(message, fields),
          journalMode: 'wal'
        })
    });

    return {
      sqliteStore,
      artifactLifecycle,
      usageAccounting,
      usageWiring,
      telemetryHost,
      liveLogIndex,
      recoveryHandoff,
      laneService,
      runLaneCoordinator,
      phaseHandoffCoordinator,
      acpRuntimeStore,
      reportingService,
      changeReviewService,
      workflowComposition,
      disposeTelemetryConfig: () => {
        try {
          boundConfigSub.dispose();
        } catch {
          // Best-effort disposal must not leak `boundSecretSub`.
        }
        try {
          boundSecretSub?.dispose();
        } catch {
          // Best-effort disposal.
        }
      }
    };
  } catch (error) {
    if (!input.isClosed()) input.operationalMemento?.setDurableBatchUnavailableReason('sqlite-init-failed');
    cleanupPartial();
    deps.logger.warn('sqlite cutover: initialization failed', {
      reason: error instanceof Error ? error.name : 'unknown'
    });
    return null;
  }
}

export function createSqliteCutoverCoordinator(
  deps: CreateSqliteCutoverCoordinatorDeps
): SqliteCutoverCoordinator {
  cutoverRegistry.assertNotDisposed(deps.store, 'coordinator');
  cutoverRegistry.getCoordinator(deps.store)?.close();
  const scopeId = deriveWorkspaceScopeId(deps.workspaceRoot);
  const globalStorageRoot = deps.context.globalStorageUri.fsPath;
  const legacyStorageRoot = deps.context.storageUri?.fsPath;
  const expectedDatabasePath = sqliteDatabasePathFor(
    { storageUri: legacyStorageRoot, globalStorageUri: globalStorageRoot },
    deps.workspaceRoot
  );
  const legacyDatabasePath =
    legacyStorageRoot !== undefined && path.resolve(legacyStorageRoot) !== path.resolve(globalStorageRoot)
      ? path.join(legacyStorageRoot, 'sqlite', scopeId, 'schegent-state.db')
      : null;

  const operationalMemento = cutoverRegistry.getOperationalMemento(deps.store);
  const catalogFs = cutoverRegistry.getCatalogFs(deps.store);
  operationalMemento?.requireDurableBatch();

  const relSegments = ['sqlite', scopeId] as const;
  const canonicalContainment = { rootDir: globalStorageRoot, relativeDirSegments: relSegments, dbFileName: 'schegent-state.db' };
  const legacyContainment =
    legacyDatabasePath !== null && legacyStorageRoot !== undefined
      ? { rootDir: legacyStorageRoot, relativeDirSegments: relSegments, dbFileName: 'schegent-state.db' }
      : null;

  // Safe at wiring time (even in untrusted or non-primary windows): strict-contained,
  // zero-mutation read-only snapshot probe (`immutable=1` when `-wal` absent).
  let canonicalOperationalAttached = operationalMemento?.attachReadOnlySnapshotIfPresent(expectedDatabasePath, scopeId, canonicalContainment) ?? false;
  let canonicalCatalogAttached = catalogFs?.attachReadOnlySnapshotIfPresent(expectedDatabasePath, scopeId, canonicalContainment) ?? false;
  let attachedOperational = canonicalOperationalAttached;
  let attachedCatalog = canonicalCatalogAttached;
  let canonicalPassiveAttached = canonicalOperationalAttached || canonicalCatalogAttached;
  let legacyPassiveAttached = false;
  if (legacyDatabasePath !== null && legacyContainment !== null) {
    if (!attachedOperational) {
      attachedOperational = operationalMemento?.attachReadOnlySnapshotIfPresent(legacyDatabasePath, scopeId, legacyContainment) ?? false;
      if (attachedOperational) legacyPassiveAttached = true;
    }
    if (!attachedCatalog) {
      attachedCatalog = catalogFs?.attachReadOnlySnapshotIfPresent(legacyDatabasePath, scopeId, legacyContainment) ?? false;
      if (attachedCatalog) legacyPassiveAttached = true;
    }
  }

  let activeStorageRoot =
    !canonicalPassiveAttached && legacyPassiveAttached && legacyStorageRoot !== undefined
      ? legacyStorageRoot
      : globalStorageRoot;
  let activeDatabasePath =
    !canonicalPassiveAttached && legacyPassiveAttached && legacyDatabasePath !== null
      ? legacyDatabasePath
      : expectedDatabasePath;
  let preservedUnselectedPaths: readonly string[] = [];
  let legacyRetired = legacyDatabasePath === null;

  let activeServices: SqliteCutoverServices | null = null;
  // Review gap GC-05 — the best-effort paths below report a failure instead of dropping it.
  const reportSideEffectFailure = createSideEffectFailureReporter(deps.logger);
  let activatingPromise: Promise<SqliteCutoverServices | null> | null = null;
  let closed = false;

  const getDatabaseProtectedPaths = (): readonly string[] => {
    const bases = [activeDatabasePath, ...preservedUnselectedPaths];
    if (legacyDatabasePath !== null && !legacyRetired) bases.push(legacyDatabasePath);
    const protectedSet = new Set<string>();
    for (const base of bases) {
      protectedSet.add(base);
      protectedSet.add(`${base}-wal`);
      protectedSet.add(`${base}-shm`);
    }
    return [...protectedSet];
  };

  const isInactive = (): boolean => closed || cutoverRegistry.getCoordinator(deps.store) !== coordinator;
  const isPassive = (): boolean =>
    !isInactive() &&
    activeServices === null &&
    activatingPromise === null &&
    !(operationalMemento?.isSqliteAttached() ?? false) &&
    !(catalogFs?.isSqliteAttached() ?? false);
  const safeProbeAsync = async (probe: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await probe();
    } catch {
      return false;
    }
  };

  let passiveProbePromise: Promise<void> | null = null;
  const runPassiveProbeOnce = async (): Promise<void> => {
    if (!isPassive()) return;
    if (!canonicalOperationalAttached && operationalMemento !== undefined) {
      const canonicalOk = await safeProbeAsync(() =>
        operationalMemento.attachReadOnlySnapshotIfPresentAsync(globalStorageRoot, relSegments, 'schegent-state.db', scopeId, isPassive)
      );
      if (!isPassive()) return;
      if (canonicalOk) {
        canonicalOperationalAttached = true;
        attachedOperational = true;
        canonicalPassiveAttached = true;
      } else if (!attachedOperational && legacyStorageRoot !== undefined && legacyDatabasePath !== null) {
        attachedOperational = await safeProbeAsync(() =>
          operationalMemento.attachReadOnlySnapshotIfPresentAsync(legacyStorageRoot, relSegments, 'schegent-state.db', scopeId, isPassive)
        );
        if (!isPassive()) return;
        if (attachedOperational) legacyPassiveAttached = true;
      }
    }
    if (!canonicalCatalogAttached && catalogFs !== undefined) {
      const canonicalOk = await safeProbeAsync(() =>
        catalogFs.attachReadOnlySnapshotIfPresentAsync(globalStorageRoot, relSegments, 'schegent-state.db', scopeId, isPassive)
      );
      if (!isPassive()) return;
      if (canonicalOk) {
        canonicalCatalogAttached = true;
        attachedCatalog = true;
        canonicalPassiveAttached = true;
      } else if (!attachedCatalog && legacyStorageRoot !== undefined && legacyDatabasePath !== null) {
        attachedCatalog = await safeProbeAsync(() =>
          catalogFs.attachReadOnlySnapshotIfPresentAsync(legacyStorageRoot, relSegments, 'schegent-state.db', scopeId, isPassive)
        );
        if (!isPassive()) return;
        if (attachedCatalog) legacyPassiveAttached = true;
      }
    }
    if (isPassive()) {
      if (canonicalPassiveAttached) {
        activeStorageRoot = globalStorageRoot;
        activeDatabasePath = expectedDatabasePath;
      } else if (legacyPassiveAttached && legacyStorageRoot !== undefined && legacyDatabasePath !== null) {
        activeStorageRoot = legacyStorageRoot;
        activeDatabasePath = legacyDatabasePath;
      }
    }
  };

  const probePassiveSnapshots = (): Promise<void> => {
    if (!isPassive()) return Promise.resolve();
    passiveProbePromise ??= runPassiveProbeOnce().finally(() => {
      passiveProbePromise = null;
    });
    return passiveProbePromise;
  };

  const disposeServices = (current: SqliteCutoverServices, includeShared = true): void => {
    disposeSqliteRuntimeResources({
      operationalMemento,
      catalogFs,
      clearDetachedWriter: includeShared,
      disposeTelemetryConfig: current.disposeTelemetryConfig,
      usageAccounting: current.usageAccounting,
      usageWiring: current.usageWiring,
      workflowComposition: current.workflowComposition,
      telemetryHost: current.telemetryHost,
      sqliteStore: current.sqliteStore
    });
  };

  const demoteOnPrimacyLoss = (): void => {
    if (activeServices === null) return;
    const current = activeServices; activeServices = null;
    disposeServices(current, cutoverRegistry.getCoordinator(deps.store) === coordinator);
    unregisterProductionWorkflowComposition(deps.store, current.workflowComposition);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    const ownsRegistration = cutoverRegistry.getCoordinator(deps.store) === coordinator;
    if (activeServices !== null) demoteOnPrimacyLoss();
    else if (ownsRegistration) {
      operationalMemento?.configureDetachedTrustedSqliteWriter(null);
      operationalMemento?.detachSqlite();
      catalogFs?.detachSqlite();
      unregisterProductionWorkflowComposition(deps.store);
    }
    cutoverRegistry.unregisterCoordinator(deps.store, coordinator);
  };

  const openAndWirePrimary = async (): Promise<SqliteCutoverServices | null> => {
    if (isInactive()) return null;
    if (!deps.isWorkspaceTrusted() || !(await deps.hasPrimacy())) {
      return null;
    }
    if (isInactive()) return null;
    if (activeServices !== null) return activeServices;
    const opened = await openPrimarySqliteServices({
      deps,
      scopeId,
      globalStorageRoot,
      legacyStorageRoot,
      operationalMemento,
      catalogFs,
      reportSideEffectFailure,
      onActiveLocationResolved: (location) => {
        if (isInactive()) return;
        activeStorageRoot = location.activeStorageRoot;
        activeDatabasePath = location.activeDatabasePath;
        preservedUnselectedPaths = location.preservedUnselectedPaths;
        legacyRetired = location.legacyRetired;
      },
      getProtectedPaths: getDatabaseProtectedPaths,
      isClosed: isInactive
    });
    if (isInactive()) {
      if (opened !== null) {
        unregisterProductionWorkflowComposition(deps.store, opened.workflowComposition);
        disposeServices(opened, false);
      }
      return null;
    }
    activeServices = opened;
    return activeServices;
  };

  const coordinator: SqliteCutoverCoordinator = {
    scopeId,
    get storageRoot() {
      return activeStorageRoot;
    },
    expectedDatabasePath,
    probePassiveSnapshots,
    activatePrimary() {
      if (activeServices !== null) return Promise.resolve(activeServices);
      activatingPromise ??= openAndWirePrimary().finally(() => {
        activatingPromise = null;
      });
      return activatingPromise;
    },
    getServices: () => activeServices,
    getSqliteStore: () => activeServices?.sqliteStore ?? null,
    hasInFlightSqliteRun() {
      if (activeServices === null) return false;
      try {
        return activeServices.sqliteStore.readPool.withReadConnection(
          activeServices.sqliteStore.writerConnection,
          (conn) => {
            const activeRelational = Number(
              conn.scalar(
                `SELECT COUNT(*) FROM runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'aborted')`
              ) ?? 0
            );
            if (activeRelational > 0) return true;
            const activeOpRuns = Number(
              conn.scalar(
                `SELECT COUNT(*) FROM operational_runs WHERE status NOT IN ('completed', 'failed', 'canceled')`
              ) ?? 0
            );
            if (activeOpRuns > 0) return true;
            const activeQueue = Number(
              conn.scalar(
                `SELECT COUNT(*) FROM operational_queue_meta WHERE in_flight_id IS NOT NULL`
              ) ?? 0
            );
            return activeQueue > 0;
          }
        );
      } catch {
        // Fail closed when SQLite active-run state cannot be read.
        return true;
      }
    },
    async reloadAfterRestore() {
      const errors: unknown[] = [];
      try {
        operationalMemento?.reloadSqliteCache();
      } catch (err) {
        errors.push(err);
      }
      if (activeServices !== null) {
        try {
          await activeServices.runLaneCoordinator.refreshCacheFromStore();
        } catch (err) {
          reportSideEffectFailure('restore-lane-cache-reload', err);
          errors.push(err);
        }
        try {
          activeServices.recoveryHandoff.reopen();
        } catch (err) {
          reportSideEffectFailure('restore-handoff-reopen', err);
          errors.push(err);
        }
        try {
          activeServices.phaseHandoffCoordinator.reloadFromStore();
        } catch (err) {
          reportSideEffectFailure('restore-handoff-reopen', err);
          errors.push(err);
        }
        try {
          activeServices.acpRuntimeStore.resetInMemoryState();
        } catch (err) {
          reportSideEffectFailure('acp-observation-ledger', err);
          errors.push(err);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
    getArtifactLifecycle: () => activeServices?.artifactLifecycle ?? null,
    getUsageAccounting: () => activeServices?.usageAccounting ?? null,
    getTelemetryHost: () => activeServices?.telemetryHost ?? null,
    getLiveLogIndex: () => activeServices?.liveLogIndex ?? null,
    getRecoveryHandoff: () => activeServices?.recoveryHandoff ?? null,
    getLaneService: () => activeServices?.laneService ?? null,
    getRunLaneCoordinator: () => activeServices?.runLaneCoordinator ?? null,
    getPhaseHandoffCoordinator: () => activeServices?.phaseHandoffCoordinator ?? null,
    resolveHandoffRepresentation: (attemptId) =>
      activeServices?.phaseHandoffCoordinator.resolveHandoffRepresentation(attemptId) ?? null,
    resolveHandoffContentDigest: (handoffId) =>
      activeServices?.phaseHandoffCoordinator.resolveHandoffContentDigest(handoffId) ?? null,
    getReportingService: () => activeServices?.reportingService ?? null,
    getChangeReviewService: () => activeServices?.changeReviewService ?? null,
    getPhaseContextApi: () => createPhaseContextApi(() => activeServices?.phaseHandoffCoordinator ?? null),
    getAcpSessionBindingStore: () => activeServices?.acpRuntimeStore.sessionBindings ?? null,
    allocateAcpConnectionGeneration: () =>
      activeServices?.acpRuntimeStore.allocateConnectionGeneration() ?? null,
    getProtectedRunIds: () => querySqliteProtectedRunIds(activeServices, reportSideEffectFailure),
    getDatabaseProtectedPaths,
    isRecoveryEnvelopeProtected: (runSegment, handoverSegment) =>
      isRecoveryEnvelopeProtectedForServices(activeServices, runSegment, handoverSegment),
    isRecoveryRunProtected: (runSegment) => isRecoveryRunProtectedForServices(activeServices, runSegment),
    onTerminalRun(summary) {
      if (activeServices === null) return;
      activeServices.usageWiring.onTerminalRun(summary);
      try {
        const matchedRun = Object.values(deps.store.getRunMap()).find(
          (candidate) => candidate.id === summary.runId
        );
        const handoff = matchedRun?.envelope?.phaseHandoff;
        if (handoff?.handoffId != null && handoff.revision != null) {
          const cleanCompletion =
            summary.status === 'completed' || summary.status === 'succeeded';
          activeServices.phaseHandoffCoordinator.settleAttemptDispatch({
            handoffId: handoff.handoffId,
            revision: handoff.revision,
            targetAttemptId: handoff.attemptId,
            delivered: cleanCompletion
          });
        }
        if (
          (summary.status === 'completed' ||
            summary.status === 'failed' ||
            summary.status === 'canceled') &&
          !isChildOfActiveComposableRun(deps.store, matchedRun?.featureId)
        ) {
          void activeServices.runLaneCoordinator.onRunTerminal({
            runId: summary.runId,
            laneId: matchedRun?.laneId,
            status: summary.status
          }).catch((err: unknown) => reportSideEffectFailure('lane-settlement', err));
        }
      } catch (err) {
        // Best-effort handoff dispatch and lane settlement.
        reportSideEffectFailure('handoff-and-lane-settlement', err);
      }
    },
    completeRootExecutionLane(params) {
      if (activeServices === null) return;
      void activeServices.runLaneCoordinator.onRunTerminal({
        runId: params.rootExecutionId,
        laneId: params.laneId,
        status: params.status
      }).catch((err: unknown) => reportSideEffectFailure('lane-settlement', err));
    },
    recordAcpObservation(event) {
      if (activeServices === null) return;
      const now = Date.now();
      const sessionId = event.observation.acpSessionId || `${event.attemptId}-session`;
      try {
        activeServices.acpRuntimeStore.recordObservation(
          {
            profileId: event.projection.profileId,
            attemptId: event.attemptId,
            observation: event.observation
          },
          now
        );
        activeServices.liveLogIndex.openStream({
          streamKey: `${event.runId ?? 'adhoc'}:${event.attemptId}`,
          generation: sessionId,
          captureMode: 'captured',
          nowMs: now
        });
      } catch (err) {
        // Best-effort observation ledger recording.
        reportSideEffectFailure('acp-observation-ledger', err);
      }
      if (event.observation.kind === 'usage') {
        coordinator.recordAcpUsageUpdate(event.observation.usage, event.observation.binding);
      }
    },
    recordAcpUsageUpdate(update, binding) {
      if (activeServices === null) return;
      try {
        const res = activeServices.usageAccounting.ingestAcpUsageUpdate(update, binding);
        if (res.ok && res.value.disposition === 'accepted') {
          activeServices.telemetryHost.offerAcceptedObservationById(res.value.observationId);
        }
      } catch (err) {
        // Accounting never interrupts agent execution.
        reportSideEffectFailure('usage-accounting', err);
      }
    },
    close
  };

  cutoverRegistry.registerCoordinator(deps.store, coordinator, {
    allowMissingCatalogFs: catalogFs === undefined && !deps.isWorkspaceTrusted()
  });
  if (deps.subscribePrimacyLost !== undefined) deps.disposables.push(deps.subscribePrimacyLost(demoteOnPrimacyLoss));
  deps.disposables.push({ dispose: close });
  return coordinator;
}

export {
  createDynamicStorageDetailsReader,
  createDynamicUsageAccountingReader,
  ProtectedRunIdsUnavailableError,
  replayTelemetrySpoolAfterSettling,
  sweepWithReadableProtection
};

/**
 * The run ids a sweep must spare: lane pins, export pins and active protective references.
 * Empty when SQLite is not open, since nothing can be pinned there. Throws
 * {@link ProtectedRunIdsUnavailableError}, after reporting, when the query fails.
 */
export function querySqliteProtectedRunIds(
  services: SqliteCutoverServices | null,
  reportFailure: SideEffectFailureReport
): ReadonlySet<string> {
  const result = new Set<string>();
  if (services === null) return result;
  for (const lanePinnedRunId of services.runLaneCoordinator.getProtectedRunIds()) {
    result.add(lanePinnedRunId);
  }
  for (const exportPinnedRunId of services.reportingService.activeExportRootIds()) {
    result.add(exportPinnedRunId);
  }
  try {
    const rows = services.sqliteStore.writerConnection.all<{ readonly run_id: string }>(
      `SELECT DISTINCT al.owner_run_id AS run_id
         FROM artifact_lifecycle al
         JOIN artifact_references ar ON ar.artifact_id = al.artifact_id
        WHERE ar.protective = 1 AND ar.released_revision IS NULL AND al.owner_run_id IS NOT NULL
       UNION
       SELECT DISTINCT ar.owner_id AS run_id
         FROM artifact_references ar
        WHERE ar.protective = 1 AND ar.released_revision IS NULL AND ar.owner_type = 'run'`
    );
    for (const row of rows) {
      if (row.run_id) result.add(row.run_id);
    }
  } catch (err) {
    // Fail closed: a partial set would expose the runs pinned only here.
    reportFailure('sweep-protection-query', err);
    throw new ProtectedRunIdsUnavailableError();
  }
  return result;
}
