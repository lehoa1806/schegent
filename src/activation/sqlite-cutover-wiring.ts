// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: DEFERRED.
// Opening the writable SQLite store, executing F04 cutover migrations, and reconciling
// F05/F06/F07/F08 state are handed to `stage2-producers.ts` via `runSafety.replayTerminalTransitions`
// and `runSafety.reconcileComposableWorkflowRuns`, gated on `isWorkspaceTrusted()` and `lock.hasPrimacy()`.
// At wiring time this module only attaches a read-only SQLite snapshot if an existing DB file is present.

import { createHash, randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { StorageDetailsReader } from '../contracts/sidebar-ipc/storage-details';
import type { UsageAccountingReader } from '../contracts/sidebar-ipc/usage-accounting';
import { createStorageDetailsReader } from '../headless/artifact-lifecycle-api';
import { createPhaseContextApi, type PhaseContextApi } from '../headless/phase-context-api';
import { createUsageAccountingReader } from '../headless/usage-accounting-api';
import type { SanitizedLogger } from '../lib/logger';
import { resolveContainedLink } from '../lib/path-containment';
import { openWithinRoot } from '../lib/safe-open';
import type { AcpRunnerObservationEvent } from '../runner/acp-backed-runner';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactByteProbe,
  type ArtifactByteReader,
  type ArtifactLifecycleService,
  type ArtifactLocator,
  type LifecycleFs,
  type OwnerResolver,
  type StorageScanRoot
} from '../services/artifact-lifecycle';
import {
  createExecFileGitRunner,
  createRunLaneCoordinator,
  LaneService,
  type RunLaneCoordinator
} from '../services/execution-lanes';
import { IntegrationStore } from '../services/execution-lanes/integration-store';
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
  SqliteApplicationStore,
  type SwitchableCatalogFsAdapter
} from '../services/sqlite-store';
import type { TelemetrySecretPort } from '../contracts/telemetry-export';
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
  createWorkflowRefusalOutcome,
  defaultCapabilityAssessment,
  getOrCreateProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  type DurableArtifactHandoverSeam,
  type ProductionWorkflowComposition
} from '../services/workflow-execution/production-workflow-composition';
import type { WorkspaceLockManager } from '../state/lock';
import type { SwitchableOperationalMemento } from '../state/sqlite-operational-backing';
import { isTerminalRunStatus } from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';
import {
  readLanesEnabled,
  readLanesLiveCap,
  readLanesProvisioningDeadlineMs,
  readTelemetryExportUserSettings
} from './uncached-settings-accessors';

const operationalMementoByStore = new WeakMap<WorkspaceStateStore, SwitchableOperationalMemento>();
const catalogFsByStore = new WeakMap<WorkspaceStateStore, SwitchableCatalogFsAdapter>();
const workspaceLockByStore = new WeakMap<
  WorkspaceStateStore,
  { readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>; readonly disposables: vscode.Disposable[] }
>();
const coordinatorByStore = new WeakMap<WorkspaceStateStore, SqliteCutoverCoordinator>();

export function registerOperationalMementoForStore(
  store: WorkspaceStateStore,
  memento: SwitchableOperationalMemento
): void {
  operationalMementoByStore.set(store, memento);
}

export function getOperationalMementoForStore(
  store: WorkspaceStateStore
): SwitchableOperationalMemento | undefined {
  return operationalMementoByStore.get(store);
}

export function registerCatalogFsForStore(
  store: WorkspaceStateStore,
  catalogFs: SwitchableCatalogFsAdapter
): void {
  catalogFsByStore.set(store, catalogFs);
}

export function registerWorkspaceLockForStore(
  store: WorkspaceStateStore,
  lock: Pick<WorkspaceLockManager, 'hasPrimacy'>,
  disposables: vscode.Disposable[]
): void {
  workspaceLockByStore.set(store, { lock, disposables });
}

export function getWorkspaceLockForStore(store: WorkspaceStateStore): {
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  readonly disposables: vscode.Disposable[];
} | undefined {
  return workspaceLockByStore.get(store);
}

export function getSqliteCutoverCoordinator(
  store: WorkspaceStateStore
): SqliteCutoverCoordinator | undefined {
  return coordinatorByStore.get(store);
}

export function deriveWorkspaceScopeId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot, 'utf8').digest('hex').slice(0, 16);
}

function buildNodeLifecycleFs(allowedRoots: readonly string[]): LifecycleFs {
  return {
    async lstat(absolutePath) {
      try {
        const st = await fsp.lstat(absolutePath);
        const kind = st.isSymbolicLink()
          ? 'symlink'
          : st.isDirectory()
            ? 'directory'
            : st.isFile()
              ? 'file'
              : 'other';
        return { kind, sizeBytes: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
    async readdir(absolutePath) {
      try {
        return await fsp.readdir(absolutePath);
      } catch {
        return [];
      }
    },
    realpath: (absolutePath) => fsp.realpath(absolutePath),
    async unlink(absolutePath) {
      const contained = await resolveContainedLink(absolutePath, allowedRoots);
      if (contained.outcome === 'absent') return;
      if (contained.outcome !== 'contained') {
        throw new Error(`lifecycle unlink refused outside allowed roots (${contained.reason})`);
      }
      await fsp.unlink(contained.resolved);
    }
  };
}

function splitRelativeSegments(relPath: string): readonly string[] | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.length === 0) return null;
  const parts = normalized.split('/').filter((s) => s.length > 0);
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts;
}

function buildContainedProbeAndReader(workspaceRoot: string): {
  readonly probe: ArtifactByteProbe;
  readonly reader: ArtifactByteReader;
} {
  const readSafeBytes = async (locator: ArtifactLocator): Promise<Buffer | null> => {
    if (locator.storageTier !== 'workspace_file') return null;
    const segments = splitRelativeSegments(locator.uriOrRelpath);
    if (segments === null) return null;
    const opened = await openWithinRoot(workspaceRoot, segments, { flags: 'r' });
    if (opened.outcome === 'refused') return null;
    try {
      return await opened.handle.readFile();
    } catch {
      return null;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  };

  return {
    probe: {
      async observe(locator) {
        const bytes = await readSafeBytes(locator);
        if (bytes === null) {
          return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
        }
        return { exists: true, sizeBytes: bytes.byteLength, producerIdentity: null, generation: null };
      },
      async digestSha256(locator) {
        const bytes = await readSafeBytes(locator);
        if (bytes === null) return null;
        return createHash('sha256').update(bytes).digest('hex');
      }
    },
    reader: {
      async read(locator) {
        return await readSafeBytes(locator);
      }
    }
  };
}

function buildScanRoots(workspaceRoot: string): readonly StorageScanRoot[] {
  return [
    {
      rootId: 'transcripts',
      root: path.join(workspaceRoot, '.schegent', 'transcripts'),
      retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
      storeKind: 'transcript'
    },
    {
      rootId: 'diagnostics',
      root: path.join(workspaceRoot, '.schegent', 'diagnostics'),
      retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
      storeKind: 'diagnostic'
    },
    {
      rootId: 'reports',
      root: path.join(workspaceRoot, '.schegent', 'reports'),
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: 'report'
    }
  ];
}

function buildOwnerResolver(store: WorkspaceStateStore): OwnerResolver {
  return (ownerKind, ownerId) => {
    if (ownerKind === 'run') {
      const live = Object.values(store.getRunMap()).find((r) => r.id === ownerId);
      if (live) {
        return isTerminalRunStatus(live.status) ? 'settled' : 'live';
      }
      const connectedRuns: Readonly<Record<string, unknown>> = store.getConnectedRuns();
      if (connectedRuns[ownerId] !== undefined) return 'live';
      return 'settled';
    }
    return 'live';
  };
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
  readonly reportingService: ReportingService;
  readonly changeReviewService: ChangeReviewService;
  readonly workflowComposition: ProductionWorkflowComposition;
}

export interface SqliteCutoverCoordinator {
  readonly scopeId: string;
  readonly expectedDatabasePath: string;
  activatePrimary(): Promise<SqliteCutoverServices | null>;
  getServices(): SqliteCutoverServices | null;
  getSqliteStore(): SqliteApplicationStore | null;
  getArtifactLifecycle(): ArtifactLifecycleService | null;
  getUsageAccounting(): UsageAccountingService | null;
  getTelemetryHost(): TelemetryHostService | null;
  getLiveLogIndex(): LiveLogIndex | null;
  getRecoveryHandoff(): RecoveryHandoffService | null;
  getLaneService(): LaneService | null;
  getRunLaneCoordinator(): RunLaneCoordinator | null;
  getPhaseHandoffCoordinator(): PhaseHandoffCoordinator | null;
  getReportingService(): ReportingService | null;
  getChangeReviewService(): ChangeReviewService | null;
  getPhaseContextApi(): PhaseContextApi;
  getProtectedRunIds(): ReadonlySet<string>;
  getDatabaseProtectedPaths(): readonly string[];
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
    readonly secrets?: Pick<vscode.SecretStorage, 'get'> | undefined;
  };
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  readonly auditWriter: AuditLogWriter;
  readonly envelopes: RecoveryEnvelopePort;
  readonly pinnedRunIds: () => ReadonlySet<string>;
  readonly logger: SanitizedLogger;
  readonly isWorkspaceTrusted: () => boolean;
  readonly hasPrimacy: () => Promise<boolean>;
  readonly disposables: vscode.Disposable[];
}

function buildSecretPort(
  secrets: Pick<vscode.SecretStorage, 'get'> | undefined
): TelemetrySecretPort | null {
  if (secrets === undefined) return null;
  return {
    availability: () => 'available',
    async read(reference: string): Promise<string | null> {
      const value = await secrets.get(reference);
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
  };
}

interface OpenPrimarySqliteServicesInput {
  readonly deps: CreateSqliteCutoverCoordinatorDeps;
  readonly scopeId: string;
  readonly storageRoot: string;
  readonly expectedDatabasePath: string;
  readonly hasWorkspaceStorage: boolean;
  readonly operationalMemento: SwitchableOperationalMemento | undefined;
  readonly catalogFs: SwitchableCatalogFsAdapter | undefined;
}

async function openPrimarySqliteServices(
  input: OpenPrimarySqliteServicesInput
): Promise<SqliteCutoverServices | null> {
  const { deps, scopeId, storageRoot, expectedDatabasePath, hasWorkspaceStorage } = input;
  let sqliteStore: SqliteApplicationStore;
  try {
    sqliteStore = await SqliteApplicationStore.openAtTrustedLocation({
      trustedRootDir: storageRoot,
      relativeSegments: ['sqlite', scopeId],
      databaseFileName: 'schegent-state.db',
      sourceKind: hasWorkspaceStorage ? 'host_storage_uri' : 'host_global_storage_uri'
    });
  } catch (error) {
    deps.logger.warn('sqlite cutover: failed to open application store', {
      reason: error instanceof Error ? error.name : 'unknown'
    });
    return null;
  }

  try {
    input.operationalMemento?.attachSqlite(sqliteStore, scopeId);
    input.operationalMemento?.configureDetachedTrustedSqliteWriter({
      databasePath: expectedDatabasePath,
      scopeId,
      canWrite: () => deps.isWorkspaceTrusted()
    });
    if (input.catalogFs !== undefined) {
      await input.catalogFs.attachSqlite(sqliteStore, scopeId);
    }

    const { probe, reader } = buildContainedProbeAndReader(deps.workspaceRoot);
    const artifactLifecycle = createArtifactLifecycleService({
      conn: sqliteStore.writerConnection,
      nowMs: () => Date.now(),
      fs: buildNodeLifecycleFs([deps.workspaceRoot, storageRoot]),
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
      resolveOwner: buildOwnerResolver(deps.store),
      workspaceRoot: deps.workspaceRoot,
      workspaceId: scopeId,
      pinnedRunIds: deps.pinnedRunIds
    });

    await artifactLifecycle.reconcileAfterRestart({
      trusted: true,
      primary: true,
      auditHealthy: true
    });

    const usageAccounting = createUsageAccountingService({
      conn: sqliteStore.writerConnection,
      nowUtc: () => new Date().toISOString(),
      monotonicMs: () => performance.now(),
      workspaceId: scopeId,
      logger: deps.logger
    });
    await usageAccounting.importLegacyEpoch(metricsRollupLegacySource(deps.workspaceRoot));

    const telemetryHost = createTelemetryHostService({
      sqliteStore,
      storageRoot,
      secrets: buildSecretPort(deps.context.secrets),
      isWorkspaceTrusted: deps.isWorkspaceTrusted,
      serviceVersion: '0.2.0'
    });
    telemetryHost.configureFromUserSettings(readTelemetryExportUserSettings());
    const configSub = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('schegent.telemetry.export')) {
        telemetryHost.configureFromUserSettings(readTelemetryExportUserSettings());
      }
    });
    deps.context.subscriptions.push(configSub);

    const usageWiring = createUsageAccountingWiring({
      service: usageAccounting,
      auditWriter: deps.auditWriter,
      subscriptions: deps.context.subscriptions,
      logger: deps.logger,
      onAcceptedObservation: (observationId) => {
        telemetryHost.offerAcceptedObservationById(observationId);
      }
    });

    const liveLogIndex = createLiveLogIndex(sqliteStore.writerConnection);

    const recoveryHandoff = createRecoveryHandoffService({
      conn: sqliteStore.writerConnection,
      lifecycle: artifactLifecycle,
      probe,
      envelopes: deps.envelopes,
      clock: () => Date.now()
    });
    recoveryHandoff.reopen();

    const laneService = LaneService.open({
      connection: sqliteStore.writerConnection,
      workspaceRoot: deps.workspaceRoot,
      storageDir: storageRoot,
      workspaceId: scopeId,
      liveLaneCap: readLanesLiveCap(deps.workspaceRoot),
      provisioningDeadlineMs: readLanesProvisioningDeadlineMs(deps.workspaceRoot),
      git: createExecFileGitRunner(),
      clock: () => Date.now(),
      random: (size) => randomBytes(size)
    });
    await laneService.reconcile();

    const runLaneCoordinator = createRunLaneCoordinator({
      getLaneService: () => laneService,
      isLanesEnabled: () => readLanesEnabled(deps.workspaceRoot),
      primaryWorkspaceRoot: deps.workspaceRoot
    });
    await runLaneCoordinator.refreshCacheFromStore();

    const handoffStore = createSqliteHandoffStore(sqliteStore.writerConnection);
    const phaseHandoffCoordinator = createPhaseHandoffCoordinator({
      store: handoffStore,
      primaryWorkspaceRoot: deps.workspaceRoot,
      workspaceId: scopeId,
      lifecycle: artifactLifecycle,
      resolveExecutionRoot: (runId) => runLaneCoordinator.resolveExecutionRootSyncOrCached(runId),
      resolveLaneId: (runId) => runLaneCoordinator.resolveLaneIdForRun(runId)
    });

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

    const changeReviewService = createChangeReviewService({
      source: integrationStoreSource(new IntegrationStore(sqliteStore.writerConnection), scopeId),
      git: createExecFileGitRunner(),
      cwd: deps.workspaceRoot
    });

    const durableHandoffSeam: DurableArtifactHandoverSeam = Object.freeze({
      status: 'qualified' as const,
      requestHandover(req: Parameters<DurableArtifactHandoverSeam['requestHandover']>[0]) {
        for (const artifactId of req.artifactIds) {
          const check = artifactLifecycle.getArtifact(artifactId);
          if (!check.ok) {
            return {
              accepted: false,
              refusal: createWorkflowRefusalOutcome({
                category: 'missing-collaborator',
                reasonCode: `durable-handoff-artifact-unavailable:${check.refusal.code}`,
                message: check.refusal.message,
                rootExecutionId: req.rootExecutionId,
                invocationId: req.invocationId,
                attemptsConsumed: 0
              })
            };
          }
        }
        return { accepted: true };
      }
    });

    const workflowComposition = getOrCreateProductionWorkflowComposition(deps.store, {
      workspaceRoot: deps.workspaceRoot,
      isWorkspaceTrusted: deps.isWorkspaceTrusted,
      durableHandoffSeam,
      phaseHandoffCoordinator,
      cutoverAuthorityGuard: createCutoverAuthorityGuard({
        mode: 'post-cutover-strict',
        storeAuthority: 'sqlite-f04',
        runtimeAuthority: 'acp-f13'
      }),
      assessBackendCapability: (backendId, capability) => {
        if (capability === 'durable-handoff') {
          return Object.freeze({
            backendId,
            capability,
            status: 'verified' as const,
            source: 'fixture-adapter' as const,
            reasonCode: `capability-verified:${backendId}:durable-handoff`
          });
        }
        return defaultCapabilityAssessment(backendId, capability);
      }
    });
    registerProductionWorkflowComposition(deps.store, workflowComposition);

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
      reportingService,
      changeReviewService,
      workflowComposition
    };
  } catch (error) {
    sqliteStore.close();
    deps.logger.warn('sqlite cutover: initialization failed', {
      reason: error instanceof Error ? error.name : 'unknown'
    });
    return null;
  }
}

function isChildOfActiveComposableRun(store: WorkspaceStateStore, featureId: string | undefined): boolean {
  if (featureId === undefined) return false;
  for (const wfRun of Object.values(store.getConnectedRuns())) {
    if (wfRun.invocations === undefined) continue;
    for (const frame of Object.values(wfRun.invocations)) {
      for (const attempts of Object.values(frame.attemptsByNodeId)) {
        if (attempts.some((a) => a.queueItemId === featureId)) {
          const rootFrame = Object.values(wfRun.invocations).find(
            (f) => f.parentInvocationId === null
          );
          const status = rootFrame?.status;
          return status === 'in-flight' || status === 'waiting-for-handoff' || status === 'paused';
        }
      }
    }
  }
  return false;
}

export function createSqliteCutoverCoordinator(
  deps: CreateSqliteCutoverCoordinatorDeps
): SqliteCutoverCoordinator {
  const scopeId = deriveWorkspaceScopeId(deps.workspaceRoot);
  const hasWorkspaceStorage = deps.context.storageUri !== undefined;
  const storageRoot = deps.context.storageUri?.fsPath ?? deps.context.globalStorageUri.fsPath;
  const expectedDatabasePath = path.join(storageRoot, 'sqlite', scopeId, 'schegent-state.db');

  const operationalMemento = getOperationalMementoForStore(deps.store);
  const catalogFs = catalogFsByStore.get(deps.store);

  // Safe at wiring time (even in untrusted or non-primary windows): read-only snapshot probe only.
  operationalMemento?.attachReadOnlySnapshotIfPresent(expectedDatabasePath, scopeId);
  catalogFs?.attachReadOnlySnapshotIfPresent(expectedDatabasePath, scopeId);

  let activeServices: SqliteCutoverServices | null = null;
  let activatingPromise: Promise<SqliteCutoverServices | null> | null = null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (activeServices !== null) {
      const current = activeServices;
      activeServices = null;
      operationalMemento?.detachSqlite();
      catalogFs?.detachSqlite();
      current.usageWiring.dispose();
      current.workflowComposition.dispose();
      if (current.telemetryHost.getStatus().evaluation.kind === 'disabled') {
        void current.telemetryHost.shutdown();
        current.sqliteStore.close();
      } else {
        void current.telemetryHost.shutdown().finally(() => {
          current.sqliteStore.close();
        });
      }
    }
    coordinatorByStore.delete(deps.store);
  };

  deps.disposables.push({ dispose: close });

  const openAndWirePrimary = async (): Promise<SqliteCutoverServices | null> => {
    if (closed) return null;
    if (!deps.isWorkspaceTrusted() || !(await deps.hasPrimacy())) {
      return null;
    }
    if (activeServices !== null) return activeServices;
    activeServices = await openPrimarySqliteServices({
      deps,
      scopeId,
      storageRoot,
      expectedDatabasePath,
      hasWorkspaceStorage,
      operationalMemento,
      catalogFs
    });
    return activeServices;
  };

  const coordinator: SqliteCutoverCoordinator = {
    scopeId,
    expectedDatabasePath,
    activatePrimary() {
      if (activeServices !== null) return Promise.resolve(activeServices);
      activatingPromise ??= openAndWirePrimary().finally(() => {
        activatingPromise = null;
      });
      return activatingPromise;
    },
    getServices: () => activeServices,
    getSqliteStore: () => activeServices?.sqliteStore ?? null,
    getArtifactLifecycle: () => activeServices?.artifactLifecycle ?? null,
    getUsageAccounting: () => activeServices?.usageAccounting ?? null,
    getTelemetryHost: () => activeServices?.telemetryHost ?? null,
    getLiveLogIndex: () => activeServices?.liveLogIndex ?? null,
    getRecoveryHandoff: () => activeServices?.recoveryHandoff ?? null,
    getLaneService: () => activeServices?.laneService ?? null,
    getRunLaneCoordinator: () => activeServices?.runLaneCoordinator ?? null,
    getPhaseHandoffCoordinator: () => activeServices?.phaseHandoffCoordinator ?? null,
    getReportingService: () => activeServices?.reportingService ?? null,
    getChangeReviewService: () => activeServices?.changeReviewService ?? null,
    getPhaseContextApi: () => createPhaseContextApi(() => activeServices?.phaseHandoffCoordinator ?? null),
    getProtectedRunIds: () => querySqliteProtectedRunIds(activeServices),
    getDatabaseProtectedPaths: () => [
      expectedDatabasePath,
      `${expectedDatabasePath}-wal`,
      `${expectedDatabasePath}-shm`
    ],
    onTerminalRun(summary) {
      if (activeServices === null) return;
      activeServices.usageWiring.onTerminalRun(summary);
      try {
        const matchedRun = Object.values(deps.store.getRunMap()).find(
          (candidate) => candidate.id === summary.runId
        );
        const handoff = matchedRun?.envelope?.phaseHandoff;
        if (handoff?.handoffId != null && handoff.revision != null) {
          activeServices.phaseHandoffCoordinator.settleAttemptDispatch({
            handoffId: handoff.handoffId,
            revision: handoff.revision,
            targetAttemptId: handoff.attemptId,
            delivered: summary.status === 'completed'
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
          });
        }
      } catch {
        // Best-effort handoff dispatch and lane settlement.
      }
    },
    completeRootExecutionLane(params) {
      if (activeServices === null) return;
      void activeServices.runLaneCoordinator.onRunTerminal({
        runId: params.rootExecutionId,
        laneId: params.laneId,
        status: params.status
      });
    },
    recordAcpObservation(event) {
      if (activeServices === null) return;
      const conn = activeServices.sqliteStore.writerConnection;
      const now = Date.now();
      const obs = event.observation;
      const sessionId = obs.acpSessionId || `${event.attemptId}-session`;
      const connectionGeneration = Math.max(1, obs.generation || 1);
      const hostReceiveSeq = Math.max(1, obs.hostReceiveSeq || 1);
      const eventKind = obs.kind === 'display' ? `display:${obs.event.kind}` : obs.kind;
      const observationKey = `${event.projection.profileId}:${connectionGeneration}:${hostReceiveSeq}`;
      const payloadSha256 = createHash('sha256')
        .update(JSON.stringify({ kind: eventKind, turnId: obs.turnId, origin: obs.origin }), 'utf8')
        .digest('hex');
      try {
        conn.run(
          `INSERT INTO acp_observation_ledger (
            observation_key, profile_id, connection_generation, host_receive_seq,
            acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, connection_generation, host_receive_seq) DO NOTHING`,
          observationKey,
          event.projection.profileId,
          connectionGeneration,
          hostReceiveSeq,
          sessionId,
          obs.turnId || 'idle',
          obs.attemptId ?? event.attemptId,
          obs.origin,
          eventKind,
          payloadSha256,
          now
        );
        const streamKey = `${event.runId ?? 'adhoc'}:${event.attemptId}`;
        activeServices.liveLogIndex.openStream({
          streamKey,
          generation: sessionId,
          captureMode: 'captured',
          nowMs: now
        });
      } catch {
        // Best-effort observation ledger recording.
      }
    },
    recordAcpUsageUpdate(update, binding) {
      if (activeServices === null) return;
      try {
        const res = activeServices.usageAccounting.ingestAcpUsageUpdate(update, binding);
        if (res.ok && res.value.disposition === 'accepted') {
          activeServices.telemetryHost.offerAcceptedObservationById(res.value.observationId);
        }
      } catch {
        // Accounting never interrupts agent execution.
      }
    },
    close
  };

  coordinatorByStore.set(deps.store, coordinator);
  return coordinator;
}

function querySqliteProtectedRunIds(services: SqliteCutoverServices | null): ReadonlySet<string> {
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
  } catch {
    // Best-effort sweep protection query.
  }
  return result;
}

export function createDynamicStorageDetailsReader(
  getService: () => ArtifactLifecycleService | null
): StorageDetailsReader {
  return {
    read(cursor) {
      return createStorageDetailsReader(getService()).read(cursor);
    }
  };
}

export function createDynamicUsageAccountingReader(
  getService: () => UsageAccountingService | null
): UsageAccountingReader {
  return {
    query: (req, signal) => createUsageAccountingReader(getService()).query(req, signal),
    readGaps: (req) => createUsageAccountingReader(getService()).readGaps(req),
    readQualifications: () => createUsageAccountingReader(getService()).readQualifications()
  };
}
