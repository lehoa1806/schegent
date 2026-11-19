/**
 * FR-R7-07 — Forward migration pipeline executed by `WorkspaceStateStore.initialize()`,
 * covering schema version stamping, v2→v15 forward migrations, Run quarantine
 * normalization, orphaned-Run reconciliation, and deleted-queue residue pruning
 * (Hard Rule 7).
 */

import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import { makeDefaultRegistry, type QueueRegistry } from '../contracts/queue-registry';
import { STATE_SCHEMA_VERSION, STATE_SCHEMA_VERSION_V8 } from '../contracts/state-schema';
import type { QueueState } from '../queue/feature-request';
import { migrateV14ToV15 } from './credit-pause-state';
import {
  migrateV11ToV12,
  type HistoryStateMigrationAuditEvent
} from './history-state-migrator';
import {
  migrateRunVerdictBasis,
  verdictBasisEvents,
  type VerdictBasisMigrationEvent
} from './host-verification-migrator';
import {
  reconcileOrphanedRuns,
  type OrphanedRunCanceledAuditEvent
} from './orphaned-run-reconciler';
import {
  assertPersistedVersionSupported,
  migrateLegacyQueueState,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV9ToV10,
  migrateV12ToV13,
  type QueuePauseCollapseAuditEvent,
  type QueueStateMap,
  type StateMigratedV5ToV6AuditEvent,
  type StateMigratedV6ToV7AuditEvent,
  type StateMigratedV9ToV10AuditEvent
} from './queue-state-migrator';
import {
  isRunStateMap,
  isWorkflowRun,
  migrateV10ToV11,
  type RunStateMap,
  type RunStateMigrationAuditEvent
} from './run-state-migrator';
import type { TerminalTransitionIntent, WorkflowRun } from './workflow-run';
import {
  migrateLegacyRun,
  repairRunOnLoad,
  type WorkflowRunRepairedAuditEvent
} from './workflow-run-migrator';
import {
  KEYS,
  SCHEMA_VERSION,
  type ForwardMigrationEvents,
  type InitializeResult,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

function needsLegacyRunMigration(persistedNumeric: number | undefined): boolean {
  return typeof persistedNumeric !== 'number' || persistedNumeric < STATE_SCHEMA_VERSION_V8;
}

function anyForwardMigrationRan(events: ForwardMigrationEvents): boolean {
  return Object.values(events).some((list) => list.length > 0);
}

async function stampVersion(
  ctx: WorkspaceStateFamilyContext,
  includeVersionString: boolean
): Promise<void> {
  if (includeVersionString) {
    await ctx.memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
  }
  await ctx.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
}

function readLegacySingularQueue(ctx: WorkspaceStateFamilyContext): QueueState | null {
  const raw = ctx.memento.get<unknown>(KEYS.queue);
  if (raw === undefined || raw === null) return null;
  if (Array.isArray((raw as QueueState).requests)) return raw as QueueState;
  if (typeof raw === 'object') {
    return (raw as QueueStateMap)[DEFAULT_QUEUE_ID] ?? null;
  }
  return null;
}

function writeLegacySingularQueue(
  ctx: WorkspaceStateFamilyContext,
  next: QueueState
): Thenable<void> {
  const raw = ctx.memento.get<unknown>(KEYS.queue);
  const isMap =
    raw !== undefined &&
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray((raw as QueueState).requests);
  if (!isMap) return ctx.memento.update(KEYS.queue, next);
  return ctx.memento.update(KEYS.queue, { ...(raw as QueueStateMap), [DEFAULT_QUEUE_ID]: next });
}

function queueIdForPersistedTask(ctx: WorkspaceStateFamilyContext, taskId: string): string | null {
  for (const [queueId, state] of Object.entries(ctx.readQueueMap())) {
    const requests = (state as Partial<QueueState> | undefined)?.requests ?? [];
    if (requests.some((request) => request.id === taskId)) return queueId;
  }
  return null;
}

async function migrateQueueRegistryIfNeeded(ctx: WorkspaceStateFamilyContext): Promise<void> {
  const existingRegistry = ctx.memento.get<QueueRegistry | null>(KEYS.queueRegistry);
  if (existingRegistry !== undefined && existingRegistry !== null) {
    return;
  }
  const lifted = migrateLegacyQueueState(readLegacySingularQueue(ctx));
  await ctx.memento.update(KEYS.queueRegistry, lifted.registry);
  await writeLegacySingularQueue(ctx, lifted.queueState);
  await ctx.memento.update(KEYS.queueDefaultId, lifted.defaultQueueId);
  if (lifted.quarantine !== null) {
    await ctx.memento.update(KEYS.queueMigrationQuarantine, lifted.quarantine);
  }
}

async function migrateV5ToV6IfNeeded(
  ctx: WorkspaceStateFamilyContext,
  persistedNumeric: number | undefined
): Promise<readonly StateMigratedV5ToV6AuditEvent[]> {
  const registry = ctx.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? null;
  const queueState = readLegacySingularQueue(ctx);
  const effectiveVersion = persistedNumeric !== undefined && persistedNumeric >= 6 ? 6 : 5;
  const result = migrateV5ToV6(
    { schemaVersion: effectiveVersion, queueRegistry: registry, queueState },
    Date.now()
  );
  if (!result.migrated) {
    return [];
  }
  const isFreshWorkspace =
    persistedNumeric === undefined &&
    result.auditEvents.length === 1 &&
    result.auditEvents[0].sourceQueueCount <= 1 &&
    result.auditEvents[0].pendingTaskCount === 0 &&
    result.auditEvents[0].inFlightTaskCount === 0 &&
    result.auditEvents[0].inheritedPausedState === false;
  if (isFreshWorkspace) {
    await ctx.memento.update(KEYS.queueRegistry, result.state.queueRegistry);
    await writeLegacySingularQueue(ctx, result.state.queueState);
    await ctx.memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
    return [];
  }
  await ctx.memento.update(KEYS.queueRegistry, result.state.queueRegistry);
  await writeLegacySingularQueue(ctx, result.state.queueState);
  await ctx.memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
  const raw = ctx.memento.get<unknown>(KEYS.run);
  if (isWorkflowRun(raw)) {
    const runRecord = raw as unknown as { queueId?: string };
    if (runRecord.queueId !== undefined && runRecord.queueId !== DEFAULT_QUEUE_ID) {
      await ctx.memento.update(KEYS.run, { ...raw, queueId: DEFAULT_QUEUE_ID });
    }
  }
  return result.auditEvents;
}

async function migrateV6ToV7IfNeeded(
  ctx: WorkspaceStateFamilyContext,
  persistedNumeric: number | undefined
): Promise<readonly StateMigratedV6ToV7AuditEvent[]> {
  const queueState = readLegacySingularQueue(ctx);
  if (queueState === null) return [];
  const alreadyV7 =
    persistedNumeric === 7 && typeof (queueState as QueueState).queueLifecycle === 'string';
  if (alreadyV7) return [];
  const result = migrateV6ToV7(queueState, Date.now());
  if (!result.migrated) return [];
  const isFreshWorkspace =
    result.queueState.requests.length === 0 &&
    result.queueState.inFlightId === null &&
    result.queueState.paused === false;
  await writeLegacySingularQueue(ctx, result.queueState);
  if (isFreshWorkspace) return [];
  return result.auditEvents;
}

async function migrateV9ToV10IfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<readonly StateMigratedV9ToV10AuditEvent[]> {
  const raw = ctx.memento.get<unknown>(KEYS.queue);
  if (raw === undefined || raw === null) return [];
  const result = migrateV9ToV10(raw, Date.now());
  if (Object.keys(result.queueStates).length === 0) return [];
  await ctx.memento.update(KEYS.queue, result.queueStates);
  if (!result.migrated) return [];
  return result.auditEvents;
}

async function migrateV10ToV11IfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<readonly RunStateMigrationAuditEvent[]> {
  const result = migrateV10ToV11(
    ctx.memento.get<unknown>(KEYS.run),
    (taskId) => queueIdForPersistedTask(ctx, taskId),
    Date.now()
  );
  if (!result.changed) return [];
  await ctx.memento.update(KEYS.run, result.runs);
  return result.events;
}

async function migrateV11ToV12IfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<readonly HistoryStateMigrationAuditEvent[]> {
  const result = migrateV11ToV12(
    ctx.memento.get<unknown>(KEYS.history),
    (taskId) => queueIdForPersistedTask(ctx, taskId),
    Date.now()
  );
  if (!result.changed) return [];
  await ctx.memento.update(KEYS.history, result.history);
  return result.events;
}

export async function migrateV12ToV13IfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<readonly QueuePauseCollapseAuditEvent[]> {
  const queueStates = ctx.readQueueMap();
  const registry = ctx.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? makeDefaultRegistry();
  const result = migrateV12ToV13(queueStates, registry, Date.now());
  if (!result.changed) return [];
  await ctx.memento.update(KEYS.queue, result.queueStates);
  if (JSON.stringify(result.registry) !== JSON.stringify(registry)) {
    await ctx.memento.update(KEYS.queueRegistry, result.registry);
    ctx.notify(KEYS.queueRegistry);
  }
  ctx.notify(KEYS.queue);
  return result.auditEvents;
}

export async function migrateVerdictBasisIfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<readonly VerdictBasisMigrationEvent[]> {
  const events: VerdictBasisMigrationEvent[] = [];
  const raw = ctx.memento.get<unknown>(KEYS.run);
  if (isRunStateMap(raw)) {
    const next: RunStateMap = {};
    let changed = false;
    for (const [queueId, run] of Object.entries(raw)) {
      const result = migrateRunVerdictBasis(run);
      next[queueId] = result.run;
      if (!result.changed) continue;
      changed = true;
      events.push(...verdictBasisEvents(run.id, queueId, result.counts));
    }
    if (changed) await ctx.memento.update(KEYS.run, next);
  }
  const journal: Record<string, TerminalTransitionIntent> = {
    ...ctx.getTerminalTransitionIntents()
  };
  let journalChanged = false;
  for (const [runId, intent] of Object.entries(journal)) {
    const result = migrateRunVerdictBasis(intent.run);
    if (!result.changed) continue;
    journalChanged = true;
    journal[runId] = { ...intent, run: result.run };
    events.push(...verdictBasisEvents(intent.run.id, null, result.counts));
  }
  if (journalChanged) await ctx.memento.update(KEYS.terminalTransitionIntent, journal);
  return events;
}

export async function migrateCreditPauseIfNeeded(ctx: WorkspaceStateFamilyContext): Promise<void> {
  const { runs, watchdog } = migrateV14ToV15(
    ctx.memento.get<unknown>(KEYS.run),
    ctx.memento.get<unknown>(KEYS.watchdog)
  );
  if (runs !== null) await ctx.memento.update(KEYS.run, runs);
  if (watchdog !== null) await ctx.memento.update(KEYS.watchdog, watchdog);
}

export async function reconcileOrphanedRunsIfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<readonly OrphanedRunCanceledAuditEvent[]> {
  const raw = ctx.memento.get<unknown>(KEYS.run);
  if (!isRunStateMap(raw)) return [];
  const result = reconcileOrphanedRuns(
    raw,
    (taskId) => queueIdForPersistedTask(ctx, taskId) !== null,
    Date.now()
  );
  if (!result.changed) return [];
  await ctx.memento.update(KEYS.run, result.runs);
  return result.events;
}

async function reconcileDeletedQueueResidueIfNeeded(
  ctx: WorkspaceStateFamilyContext
): Promise<void> {
  const registeredIds = new Set(ctx.getQueueRegistry().entries.map((entry) => entry.id));
  const rawQueues = ctx.memento.get<unknown>(KEYS.queue);
  if (
    rawQueues !== undefined &&
    rawQueues !== null &&
    typeof rawQueues === 'object' &&
    !Array.isArray((rawQueues as QueueState).requests)
  ) {
    const nextQueues: QueueStateMap = {};
    let queuesChanged = false;
    for (const [queueId, state] of Object.entries(rawQueues as QueueStateMap)) {
      if (registeredIds.has(queueId)) {
        nextQueues[queueId] = state;
      } else {
        queuesChanged = true;
      }
    }
    if (queuesChanged) {
      await ctx.memento.update(KEYS.queue, nextQueues);
    }
  }

  const rawRuns = ctx.memento.get<unknown>(KEYS.run);
  if (isRunStateMap(rawRuns)) {
    const nextRuns: RunStateMap = {};
    let runsChanged = false;
    for (const [queueId, run] of Object.entries(rawRuns)) {
      const status = run.status as string;
      const isTerminal =
        status === 'completed' || status === 'failed' || status === 'canceled';
      if (!registeredIds.has(queueId) && isTerminal) {
        runsChanged = true;
      } else {
        nextRuns[queueId] = run;
      }
    }
    if (runsChanged) {
      await ctx.memento.update(KEYS.run, nextRuns);
    }
  }

  const prunedHistory = ctx.pruneExcessDeletedHistoryPartitions(
    ctx.readHistoryMap(),
    registeredIds
  );
  if (prunedHistory !== null) {
    await ctx.memento.update(KEYS.history, prunedHistory);
  }
}

async function normalizeRunForInitialize(
  ctx: WorkspaceStateFamilyContext,
  applyLegacyMigration: boolean
): Promise<readonly WorkflowRunRepairedAuditEvent[]> {
  const raw = ctx.memento.get<unknown>(KEYS.run);
  if (raw === undefined || raw === null) return [];

  if (isRunStateMap(raw)) {
    const events: WorkflowRunRepairedAuditEvent[] = [];
    const next: RunStateMap = {};
    const quarantined: Array<{ queueId: string; raw: unknown }> = [];
    let changed = applyLegacyMigration;
    for (const [queueId, persisted] of Object.entries(raw)) {
      const migrated = applyLegacyMigration ? migrateLegacyRun(persisted) : persisted;
      if (migrated === null) {
        changed = true;
        quarantined.push({ queueId, raw: persisted });
        continue;
      }
      const repair = repairRunOnLoad(migrated);
      next[queueId] = repair.run;
      if (repair.auditEvents.length > 0) {
        events.push(...repair.auditEvents);
        changed = true;
      }
      if (repair.warnings.length > 0) {
        ctx.warnLoadRepairs(repair.warnings);
        changed = true;
      }
    }
    if (changed) await ctx.memento.update(KEYS.run, next);
    if (quarantined.length > 0) await ctx.runQuarantine.capture(quarantined);
    return events;
  }

  const migrated = applyLegacyMigration ? migrateLegacyRun(raw) : (raw as WorkflowRun);
  if (migrated === null) {
    await ctx.runQuarantine.capture([{ queueId: DEFAULT_QUEUE_ID, raw }]);
    return [];
  }
  const repair = repairRunOnLoad(migrated);
  ctx.warnLoadRepairs(repair.warnings);
  if (applyLegacyMigration || repair.auditEvents.length > 0 || repair.warnings.length > 0) {
    await ctx.memento.update(KEYS.run, repair.run);
  }
  return repair.auditEvents;
}

async function runForwardMigrations(
  ctx: WorkspaceStateFamilyContext,
  persistedNumeric: number | undefined,
  hadPersistedRegistry = false
): Promise<ForwardMigrationEvents> {
  await migrateQueueRegistryIfNeeded(ctx);
  const throughVerdictBasis = {
    v6MigrationEvents: await migrateV5ToV6IfNeeded(ctx, persistedNumeric),
    v7MigrationEvents: await migrateV6ToV7IfNeeded(ctx, persistedNumeric),
    v10MigrationEvents: await migrateV9ToV10IfNeeded(ctx),
    v11MigrationEvents: await migrateV10ToV11IfNeeded(ctx),
    v12MigrationEvents: await migrateV11ToV12IfNeeded(ctx),
    v13MigrationEvents: await ctx.migrationSteps.migrateV12ToV13IfNeeded(),
    v14MigrationEvents: await ctx.migrationSteps.migrateVerdictBasisIfNeeded()
  };
  await ctx.migrationSteps.migrateCreditPauseIfNeeded();
  const orphanedRunEvents = await ctx.migrationSteps.reconcileOrphanedRunsIfNeeded();
  if (hadPersistedRegistry) {
    await reconcileDeletedQueueResidueIfNeeded(ctx);
  }
  return {
    ...throughVerdictBasis,
    orphanedRunEvents
  };
}

export async function initializeWorkspaceState(
  ctx: WorkspaceStateFamilyContext
): Promise<InitializeResult> {
  const persistedNumeric = ctx.memento.get<number>(KEYS.schemaVersionNumeric);
  const rawRegistryBeforeInit = ctx.memento.get<unknown>(KEYS.queueRegistry);
  const hadPersistedRegistry =
    rawRegistryBeforeInit !== undefined && rawRegistryBeforeInit !== null;
  assertPersistedVersionSupported(persistedNumeric);
  const persistedVersion = ctx.memento.get<string>(KEYS.schemaVersion);
  if (!persistedVersion) {
    const runRepairEvents = await normalizeRunForInitialize(
      ctx,
      needsLegacyRunMigration(persistedNumeric)
    );
    const migrationEvents = await runForwardMigrations(ctx, persistedNumeric, hadPersistedRegistry);
    await stampVersion(ctx, true);
    return {
      migrated: true,
      ...migrationEvents,
      runRepairEvents
    };
  }
  if (persistedVersion === SCHEMA_VERSION) {
    if (persistedNumeric !== STATE_SCHEMA_VERSION) {
      const runRepairEvents = await normalizeRunForInitialize(
        ctx,
        needsLegacyRunMigration(persistedNumeric)
      );
      const migrationEvents = await runForwardMigrations(
        ctx,
        persistedNumeric,
        hadPersistedRegistry
      );
      await stampVersion(ctx, false);
      return {
        migrated: true,
        ...migrationEvents,
        runRepairEvents
      };
    }
    const runRepairEvents = await normalizeRunForInitialize(ctx, false);
    const migrationEvents = await runForwardMigrations(ctx, persistedNumeric, hadPersistedRegistry);
    return {
      migrated: anyForwardMigrationRan(migrationEvents) || runRepairEvents.length > 0,
      ...migrationEvents,
      runRepairEvents
    };
  }
  const [persistedMajor] = persistedVersion.split('.');
  const [runtimeMajor] = SCHEMA_VERSION.split('.');
  if (persistedMajor === runtimeMajor) {
    const runRepairEvents = await normalizeRunForInitialize(
      ctx,
      needsLegacyRunMigration(persistedNumeric)
    );
    const migrationEvents = await runForwardMigrations(ctx, persistedNumeric, hadPersistedRegistry);
    await stampVersion(ctx, true);
    return {
      migrated: true,
      ...migrationEvents,
      runRepairEvents
    };
  }
  throw new Error(
    `Schegent state version ${persistedVersion} is incompatible with runtime ${SCHEMA_VERSION}. Run "Schegent: Reset Workspace State" to clear.`
  );
}
