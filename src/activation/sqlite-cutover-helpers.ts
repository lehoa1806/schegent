// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Pure helper factories for `sqlite-cutover-wiring.ts`: contained artifact-lifecycle
// filesystem adapters (enforcing protected SQLite database paths), contained workspace
// byte readers, scan roots, owner resolution, and relocation outcome notices.

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { SanitizedLogger } from '../lib/logger';
import type { SideEffectFailureReport } from '../lib/side-effect-failure-reporter';
import type { StorageDetailsReader } from '../contracts/sidebar-ipc/storage-details';
import type { UsageAccountingReader } from '../contracts/sidebar-ipc/usage-accounting';
import { createStorageDetailsReader } from '../headless/artifact-lifecycle-api';
import { createUsageAccountingReader } from '../headless/usage-accounting-api';
import { resolveContainedLink } from '../lib/path-containment';
import { isTargetProtectedPathSync } from '../lib/protected-path-match';
import { openWithinRoot } from '../lib/safe-open';
import { HANDOFF_ACCEPTED_STORE_KINDS } from '../contracts/recovery-handoff/handoff-types';
import {
  ArtifactRecordStore,
  type ArtifactByteProbe,
  type ArtifactByteReader,
  type ArtifactLifecycleService,
  type ArtifactLocator,
  type LifecycleFs,
  type OwnerResolver,
  type StorageScanRoot
} from '../services/artifact-lifecycle';
import {
  assessRecoveryEnvelopeProtection,
  handoffOwnerResolution
} from '../services/recovery-handoff';
import { assessRunSegmentProtection } from '../services/recovery-handoff/handoff-envelope-protection';
import type {
  NodeSqliteConnection,
  SqliteApplicationStore,
  StoreRelocationOutcome,
  SwitchableCatalogFsAdapter
} from '../services/sqlite-store';
import type { TelemetrySecretPort } from '../contracts/telemetry-export';
import type { TelemetryHostService } from '../services/telemetry-host/telemetry-host-service';
import type { UsageAccountingService } from '../services/usage-accounting/usage-accounting-service';
import type { UsageAccountingWiring } from '../services/usage-accounting/usage-accounting-wiring';
import {
  createWorkflowRefusalOutcome,
  type DurableArtifactHandoverSeam,
  type ProductionWorkflowComposition
} from '../services/workflow-execution/production-workflow-composition';
import {
  PostCutoverMementoWriteForbiddenError,
  type SwitchableOperationalMemento
} from '../state/sqlite-operational-backing';
import { isTerminalRunStatus } from '../state/workflow-run';
import type { InitializeResult, WorkspaceStateStore } from '../state/workspace-state';
import { completeInterruptedResetOnActivation } from '../commands/reset-wiring';

export function buildNodeLifecycleFs(
  allowedRoots: readonly string[],
  getProtectedPaths: () => readonly string[]
): LifecycleFs {
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
      const protectedPaths = getProtectedPaths();
      if (
        isTargetProtectedPathSync(absolutePath, protectedPaths) ||
        isTargetProtectedPathSync(contained.resolved, protectedPaths)
      ) {
        throw new Error('lifecycle unlink refused for protected SQLite store path');
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

export function buildContainedProbeAndReader(workspaceRoot: string): {
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

export function buildScanRoots(workspaceRoot: string): readonly StorageScanRoot[] {
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
    },
    {
      rootId: 'handoff-materialized',
      root: path.join(workspaceRoot, '.schegent', 'handoff-materialized'),
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: 'handoff-context'
    },
    {
      rootId: 'immutable-results',
      root: path.join(workspaceRoot, '.schegent', 'immutable-results'),
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: 'handoff-context'
    }
  ];
}

export function isRecoveryEnvelopeProtectedForServices(
  services: { readonly sqliteStore: SqliteApplicationStore } | null,
  runSegment: string,
  handoverSegment: string
): boolean {
  if (services === null) return true;
  try {
    return services.sqliteStore.readPool.withReadConnection(
      services.sqliteStore.writerConnection,
      (conn) => assessRecoveryEnvelopeProtection(conn, runSegment, handoverSegment).protected
    );
  } catch {
    return true;
  }
}

export function isRecoveryRunProtectedForServices(
  services: { readonly sqliteStore: SqliteApplicationStore } | null,
  runSegment: string
): boolean {
  if (services === null) return true;
  try {
    return services.sqliteStore.readPool.withReadConnection(
      services.sqliteStore.writerConnection,
      (conn) => assessRunSegmentProtection(conn, runSegment).protected
    );
  } catch {
    return true;
  }
}

export function buildOwnerResolver(
  store: WorkspaceStateStore,
  conn?: NodeSqliteConnection
): OwnerResolver {
  return (ownerKind, ownerId) => {
    if (ownerKind === 'handoff') {
      if (conn === undefined || conn.isClosed()) return 'unresolved';
      try {
        return handoffOwnerResolution(conn, ownerId);
      } catch {
        return 'unresolved';
      }
    }
    if (ownerKind === 'run') {
      try {
        const live = Object.values(store.getRunMap()).find((r) => r.id === ownerId);
        if (live) {
          return isTerminalRunStatus(live.status) ? 'settled' : 'live';
        }
        const presence = store.getConnectedRunPresence(ownerId);
        if (presence === 'present') return 'live';
        if (presence === 'unreadable-refused') return 'unresolved';
        return 'settled';
      } catch {
        return 'unresolved';
      }
    }
    return 'live';
  };
}

export function reportRelocationOutcome(
  outcome: Exclude<StoreRelocationOutcome, { readonly outcome: 'refused_newer_schema' }>,
  logger: SanitizedLogger,
  notify: (message: string) => void
): void {
  const notices: string[] = [];
  if (outcome.outcome === 'relocated') {
    logger.info('sqlite cutover: relocated legacy store into folder-keyed global storage', {
      relocatedFromPath: outcome.relocatedFromPath,
      activeDatabasePath: outcome.activeDatabasePath
    });
  } else if (outcome.outcome === 'conflict_resolved') {
    logger.warn('sqlite cutover: multiple databases held state; kept unselected database unmodified', {
      selectionRule: outcome.selectionRule,
      winnerSourcePath: outcome.winnerSourcePath,
      preservedUnselectedPaths: outcome.preservedUnselectedPaths
    });
    if (outcome.newlyDiscoveredConflictPaths.length > 0) {
      const preservedList = outcome.newlyDiscoveredConflictPaths.join(', ');
      notices.push(
        `Schegent found more than one operational store for this folder and selected the most recently written database. The other data is available at ${preservedList}.`
      );
    }
  } else if (outcome.outcome === 'fallback_legacy_preserved') {
    logger.warn('sqlite cutover: canonical store target unavailable; keeping legacy store active in place', {
      reason: outcome.reason,
      activeDatabasePath: outcome.activeDatabasePath
    });
    notices.push(
      `Schegent could not relocate the SQLite store to global storage (${outcome.reason}). The legacy store remains active at ${outcome.activeDatabasePath}.`
    );
  }
  if (
    outcome.noticeRequired &&
    outcome.diagnostics &&
    outcome.diagnostics.length > 0
  ) {
    notices.push(
      `Schegent SQLite store relocation reported diagnostic conditions (${outcome.diagnostics.join(', ')}). Review the Schegent output log for details.`
    );
  }
  if (notices.length > 0) notify(notices.join(' '));
}

export function buildSecretPort(
  secrets: { get(key: string): Thenable<string | undefined> } | undefined
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

export function buildDurableHandoffSeam(
  artifactLifecycle: ArtifactLifecycleService,
  conn?: NodeSqliteConnection
): DurableArtifactHandoverSeam {
  const records = conn === undefined ? null : new ArtifactRecordStore(conn, () => Date.now());
  return Object.freeze({
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
        if (!HANDOFF_ACCEPTED_STORE_KINDS.has(check.value.storeKind)) {
          return {
            accepted: false,
            refusal: createWorkflowRefusalOutcome({
              category: 'missing-collaborator',
              reasonCode: `durable-handoff-artifact-unsupported:${check.value.storeKind}`,
              message: `Artifact store kind "${check.value.storeKind}" is not eligible for durable handoff.`,
              rootExecutionId: req.rootExecutionId,
              invocationId: req.invocationId,
              attemptsConsumed: 0
            })
          };
        }
        if (check.value.availability !== 'present') {
          return {
            accepted: false,
            refusal: createWorkflowRefusalOutcome({
              category: 'missing-collaborator',
              reasonCode: `durable-handoff-artifact-unavailable:${check.value.availability}`,
              message: `Artifact availability is "${check.value.availability}", not "present".`,
              rootExecutionId: req.rootExecutionId,
              invocationId: req.invocationId,
              attemptsConsumed: 0
            })
          };
        }
        if (records !== null && records.locatorOf(artifactId) === null) {
          return {
            accepted: false,
            refusal: createWorkflowRefusalOutcome({
              category: 'missing-collaborator',
              reasonCode: 'durable-handoff-artifact-unavailable:missing-locator',
              message: 'Artifact has no durable locator registered.',
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
}

export function isChildOfActiveComposableRun(
  store: WorkspaceStateStore,
  featureId: string | undefined
): boolean {
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
  // Fail closed when a child task belongs to a connected parent that is unreadable/refused so a
  // child terminal event cannot prematurely close a shared isolated lane.
  if (store.hasUnreadableConnectedRuns()) {
    for (const queue of Object.values(store.getQueueStates())) {
      const task = queue.requests.find((req) => req.id === featureId);
      const rootRunId = task?.workflowOccurrence?.rootRunId;
      if (rootRunId !== undefined && store.getConnectedRunPresence(rootRunId) === 'unreadable-refused') {
        return true;
      }
    }
  }
  return false;
}

function runBestEffortDispose(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    /* best-effort disposal: continue releasing remaining SQLite resources */
  }
}

export function disposeSqliteRuntimeResources(resources: {
  readonly operationalMemento?: SwitchableOperationalMemento | undefined;
  readonly catalogFs?: SwitchableCatalogFsAdapter | undefined;
  readonly clearDetachedWriter?: boolean | undefined;
  readonly disposeTelemetryConfig?: (() => void) | undefined;
  readonly usageAccounting?: UsageAccountingService | null | undefined;
  readonly usageWiring?: UsageAccountingWiring | null | undefined;
  readonly reportingService?: { readonly close?: () => Promise<void> } | null | undefined;
  readonly workflowComposition?: ProductionWorkflowComposition | null | undefined;
  readonly telemetryHost?: TelemetryHostService | null | undefined;
  readonly sqliteStore: SqliteApplicationStore;
}): void {
  if (resources.clearDetachedWriter !== false) {
    runBestEffortDispose(() => resources.operationalMemento?.configureDetachedTrustedSqliteWriter(null));
  }
  runBestEffortDispose(() => resources.operationalMemento?.detachSqlite(resources.sqliteStore));
  runBestEffortDispose(() => resources.catalogFs?.detachSqlite(resources.sqliteStore));
  runBestEffortDispose(resources.disposeTelemetryConfig);
  runBestEffortDispose(() => resources.usageWiring?.dispose());
  runBestEffortDispose(() => {
    void resources.usageAccounting?.close().catch(() => undefined);
  });
  runBestEffortDispose(() => {
    void resources.reportingService?.close?.().catch(() => undefined);
  });
  runBestEffortDispose(() => resources.workflowComposition?.dispose());

  const closeStore = (): void => {
    try {
      resources.sqliteStore.close();
    } catch {
      /* best-effort disposal: store may already be closed or unreadable */
    }
  };

  const host = resources.telemetryHost;
  if (host !== null && host !== undefined) {
    let disabled = true;
    try {
      disabled = host.getStatus().evaluation.kind === 'disabled';
    } catch {
      /* sqlite connection may already be closed or failing; close store immediately */
      disabled = true;
    }
    if (disabled) {
      try {
        void host.shutdown().catch(() => undefined);
      } catch {
        /* best-effort telemetry shutdown during disposal */
      }
      closeStore();
    } else {
      try {
        void host
          .shutdown()
          .catch(() => undefined)
          .finally(() => {
            closeStore();
          });
      } catch {
        /* synchronous telemetry shutdown failure: close SQLite store immediately */
        closeStore();
      }
    }
  } else {
    closeStore();
  }
}

/** The SQLite half of the protected-run set could not be read, so no sweep may act on the rest. */
export class ProtectedRunIdsUnavailableError extends Error {
  public constructor() {
    super('the protected run set could not be read');
    this.name = 'ProtectedRunIdsUnavailableError';
  }
}

/**
 * Review gap GC-05 follow-up (2026-11-12) — runs `sweep` only on a protected set that was read
 * whole. When the set is unavailable the query has already reported why, and the sweep is skipped.
 */
export async function sweepWithReadableProtection(
  readProtected: () => ReadonlySet<string>,
  sweep: (protectedIds: ReadonlySet<string>) => Promise<unknown>
): Promise<'swept' | 'skipped'> {
  let protectedIds: ReadonlySet<string>;
  try {
    protectedIds = readProtected();
  } catch (err) {
    if (err instanceof ProtectedRunIdsUnavailableError) return 'skipped';
    throw err;
  }
  await sweep(protectedIds);
  return 'swept';
}

/** Re-sends the batches a previous host spooled once, after destination setup settles. */
export async function replayTelemetrySpoolAfterSettling(
  host: Pick<TelemetryHostService, 'idle' | 'reconcileAndReplaySpool'>,
  reportFailure: SideEffectFailureReport
): Promise<void> {
  try {
    await host.idle();
    await host.reconcileAndReplaySpool();
  } catch (err) {
    reportFailure('telemetry-spool', err);
  }
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
    queryAsync: (req, signal) => {
      const reader = createUsageAccountingReader(getService());
      return reader.queryAsync !== undefined ? reader.queryAsync(req, signal) : Promise.resolve(reader.query(req, signal));
    },
    readGaps: (req) => createUsageAccountingReader(getService()).readGaps(req),
    readQualifications: () => createUsageAccountingReader(getService()).readQualifications()
  };
}

export async function checkPostCutoverDatabasePresentOnDisk(databasePath: string): Promise<boolean> {
  try {
    const st = await fsp.lstat(databasePath);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function abortIfPostCutoverDatabaseMissing(input: {
  readonly operationalMemento: SwitchableOperationalMemento | undefined;
  readonly scopeId: string;
  readonly activeDatabasePath: string;
  readonly logger: SanitizedLogger;
  readonly notify: (message: string) => void;
}): Promise<boolean> {
  if (!input.operationalMemento?.hasCutoverAuthorityForScope(input.scopeId)) return false;
  if (await checkPostCutoverDatabasePresentOnDisk(input.activeDatabasePath)) return false;
  input.operationalMemento.setDurableBatchUnavailableReason('sqlite-database-missing-after-cutover');
  input.logger.warn(
    'sqlite cutover: authoritative database is missing after cutover; refusing fresh creation or legacy memento re-import',
    { scopeId: input.scopeId }
  );
  input.notify(
    'Schegent operational SQLite database is missing after cutover. Operational writes are disabled to prevent resurrecting stale state; restore a backup or reset workspace state.'
  );
  return true;
}

export function createEmptyInitializeResult(): InitializeResult {
  return {
    migrated: false,
    v6MigrationEvents: [],
    v7MigrationEvents: [],
    v10MigrationEvents: [],
    v11MigrationEvents: [],
    v12MigrationEvents: [],
    v13MigrationEvents: [],
    v14MigrationEvents: [],
    orphanedRunEvents: [],
    runRepairEvents: []
  };
}

export async function probeOperationalMementoSnapshotBeforeInitialize(input: {
  readonly globalStorageRoot: string;
  readonly legacyStorageRoot?: string | undefined;
  readonly scopeId: string;
  readonly operationalMemento: SwitchableOperationalMemento | undefined;
  readonly logger: SanitizedLogger;
}): Promise<boolean> {
  const { globalStorageRoot, legacyStorageRoot, scopeId, operationalMemento, logger } = input;
  if (operationalMemento === undefined) return false;
  operationalMemento.setActiveScope(scopeId);
  if (operationalMemento.isSqliteAttached()) return true;

  const relSegments = ['sqlite', scopeId] as const;
  const canonicalPath = path.join(globalStorageRoot, 'sqlite', scopeId, 'schegent-state.db');
  const canonicalContainment = {
    rootDir: globalStorageRoot,
    relativeDirSegments: relSegments,
    dbFileName: 'schegent-state.db'
  };
  const safeAsync = async (fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn();
    } catch {
      return false;
    }
  };

  let attached = operationalMemento.attachReadOnlySnapshotIfPresent(
    canonicalPath,
    scopeId,
    canonicalContainment
  );
  if (!attached && operationalMemento.lastSyncReadOnlyProbeNeededAsync()) {
    attached = await safeAsync(() =>
      operationalMemento.attachReadOnlySnapshotIfPresentAsync(
        globalStorageRoot,
        relSegments,
        'schegent-state.db',
        scopeId
      )
    );
  }
  if (
    !attached &&
    legacyStorageRoot !== undefined &&
    path.resolve(legacyStorageRoot) !== path.resolve(globalStorageRoot)
  ) {
    const legacyPath = path.join(legacyStorageRoot, 'sqlite', scopeId, 'schegent-state.db');
    attached = operationalMemento.attachReadOnlySnapshotIfPresent(legacyPath, scopeId, {
      rootDir: legacyStorageRoot,
      relativeDirSegments: relSegments,
      dbFileName: 'schegent-state.db'
    });
    if (!attached && operationalMemento.lastSyncReadOnlyProbeNeededAsync()) {
      attached = await safeAsync(() =>
        operationalMemento.attachReadOnlySnapshotIfPresentAsync(
          legacyStorageRoot,
          relSegments,
          'schegent-state.db',
          scopeId
        )
      );
    }
  }
  if (!attached && operationalMemento.hasCutoverAuthorityForScope(scopeId)) {
    operationalMemento.setDurableBatchUnavailableReason('sqlite-unavailable-post-cutover');
    logger.warn(
      'sqlite cutover: authoritative database is missing or unreadable at startup; refusing legacy memento fallback',
      { scopeId }
    );
  }
  return attached;
}

export async function initializeOperationalStoreForActivation(input: {
  readonly globalStorageRoot: string;
  readonly legacyStorageRoot?: string | undefined;
  readonly scopeId: string;
  readonly operationalMemento: SwitchableOperationalMemento | undefined;
  readonly store: WorkspaceStateStore;
  readonly logger: SanitizedLogger;
}): Promise<{
  readonly completedResetGeneration: number | null;
  readonly migrationEvents: InitializeResult;
}> {
  await probeOperationalMementoSnapshotBeforeInitialize(input);
  const completedResetGeneration = await completeInterruptedResetOnActivation(input.store, input.logger);
  try {
    const migrationEvents = await input.store.initialize();
    return { completedResetGeneration, migrationEvents };
  } catch (err) {
    if (
      err instanceof PostCutoverMementoWriteForbiddenError &&
      input.operationalMemento?.isReadOnlySnapshotAttached() === true
    ) {
      input.logger.info('deferred load-time state repairs until primary SQLite attach', {
        scopeId: input.scopeId
      });
      return { completedResetGeneration, migrationEvents: createEmptyInitializeResult() };
    }
    throw err;
  }
}

export function extractPrimacyGainedSubscriber(
  lock: object
): ((listener: () => void) => { dispose: () => void }) | undefined {
  if (
    'onPrimacyGained' in lock &&
    typeof (lock as { onPrimacyGained?: unknown }).onPrimacyGained === 'function'
  ) {
    const subscribe = (
      lock as {
        onPrimacyGained: (
          cb: (result: { acquired: boolean; ownerId: string }) => void
        ) => { dispose: () => void };
      }
    ).onPrimacyGained;
    return (listener: () => void) =>
      subscribe.call(lock, (result) => {
        if (result.acquired) listener();
      });
  }
  return undefined;
}

/**
 * The run ids a sweep must spare: lane pins, export pins and active protective references.
 * Empty when SQLite is not open, since nothing can be pinned there. Throws
 * {@link ProtectedRunIdsUnavailableError}, after reporting, when the query fails.
 */
export function querySqliteProtectedRunIds(
  services: {
    readonly runLaneCoordinator: { getProtectedRunIds(): Iterable<string> };
    readonly reportingService: { activeExportRootIds(): Iterable<string> };
    readonly sqliteStore: SqliteApplicationStore;
  } | null,
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

