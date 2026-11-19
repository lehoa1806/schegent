/**
 * FR-R7-07 — Connected Workflow Runs, Control Ledger, and Reset Transaction
 * key-family module (`KEYS.connectedRuns`, `KEYS.controlLedger`,
 * `KEYS.resetMarker`), delegated from `WorkspaceStateStore`.
 *
 * Uses the single facade-owned `ctx.serialize` / `ctx.serializeAcrossKeys`,
 * `ctx.writeGate`, and ownership/primacy fences.
 */

import { STATE_SCHEMA_VERSION } from '../contracts/state-schema';
import {
  connectedRunRefusalWarning,
  connectedRunsWithout,
  migrateConnectedRuns
} from './connected-run-migrator';
import {
  assertConnectedRunInvariants,
  type ConnectedWorkflowRun
} from './connected-workflow-run';
import { checkCommitFence } from './ownership-claim';
import {
  isResetInterrupted,
  isResetMarker,
  nextResetGeneration,
  type ResetMarker
} from './reset-transaction';
import {
  KEYS,
  RESET_CLEARED_KEYS,
  type ConnectedRunWriteResult,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

export interface ConnectedRunsWarningState {
  connectedRunDropsWarned: string | null;
}

export function createConnectedRunsWarningState(): ConnectedRunsWarningState {
  return { connectedRunDropsWarned: null };
}

function staleConnectedRunWrite(current: ConnectedWorkflowRun | null): ConnectedRunWriteResult {
  return { outcome: 'stale', current };
}

function readConnectedRunCollection(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState
): ReturnType<typeof migrateConnectedRuns> {
  const result = migrateConnectedRuns(ctx.memento.get<unknown>(KEYS.connectedRuns));
  const dropped = result.dropped.length === 0 ? null : result.dropped.join(', ');
  if (dropped !== warned.connectedRunDropsWarned) {
    warned.connectedRunDropsWarned = dropped;
    if (dropped !== null) ctx.logger?.warn(connectedRunRefusalWarning(result));
  }
  return result;
}

export function getConnectedRuns(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState
): Readonly<Record<string, ConnectedWorkflowRun>> {
  return readConnectedRunCollection(ctx, warned).runs;
}

export function getConnectedRun(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  connectedRunId: string
): ConnectedWorkflowRun | null {
  return getConnectedRuns(ctx, warned)[connectedRunId] ?? null;
}

export async function compareAndSetConnectedRun(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  next: ConnectedWorkflowRun,
  expectedRevision: number
): Promise<ConnectedRunWriteResult> {
  let result = staleConnectedRunWrite(null);
  await ctx.serialize(KEYS.connectedRuns, async () => {
    const { runs, refused } = readConnectedRunCollection(ctx, warned);
    if (Object.hasOwn(refused, next.connectedRunId)) return;
    const current: ConnectedWorkflowRun | null = Object.hasOwn(runs, next.connectedRunId)
      ? runs[next.connectedRunId]!
      : null;
    if ((current !== null ? current.revision : 0) !== expectedRevision || next.revision <= expectedRevision) {
      result = staleConnectedRunWrite(current);
      return;
    }
    const boundQueueId = next.queueId;
    const claimSource = ctx.getRunClaimSource();
    if (
      boundQueueId !== undefined &&
      claimSource?.tenureOf?.(boundQueueId).state === 'lost'
    ) {
      result = staleConnectedRunWrite(current);
      return;
    }
    if (boundQueueId !== undefined && claimSource !== null) {
      const queueClaim = claimSource.claimFor(boundQueueId);
      if (queueClaim !== null) {
        const f = await checkCommitFence(
          ctx.getOwnershipRegistry(),
          queueClaim,
          boundQueueId,
          'Run',
          ctx.scheduler
        );
        if (f !== null) {
          if (f.reason === 'fence-superseded') {
            const currentClaim = claimSource.claimFor(boundQueueId);
            if (currentClaim?.ownerId === queueClaim.ownerId && currentClaim.fence === queueClaim.fence) {
              claimSource.markLost?.(boundQueueId, 'superseded');
            }
          }
          result = staleConnectedRunWrite(current);
          return;
        }
      }
    }
    const primacySource = ctx.getPrimacyClaimSource();
    if (primacySource !== null && !(await primacySource.canCommitConnectedRun())) {
      result = staleConnectedRunWrite(current);
      return;
    }
    assertConnectedRunInvariants(next, {
      knownQueueIds: new Set(ctx.getQueueRegistry().entries.map((entry) => entry.id))
    });
    await ctx.memento.update(KEYS.connectedRuns, {
      ...refused,
      ...runs,
      [next.connectedRunId]: next
    });
    result = { outcome: 'written', run: next };
  });
  if (result.outcome === 'written') ctx.notify(KEYS.connectedRuns);
  return result;
}

export async function deleteConnectedRuns(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  connectedRunIds: readonly string[]
): Promise<number> {
  if (connectedRunIds.length === 0) return 0;
  let removed = 0;
  await ctx.serialize(KEYS.connectedRuns, async () => {
    const after = connectedRunsWithout(readConnectedRunCollection(ctx, warned), connectedRunIds);
    removed = after.removed;
    if (removed === 0) return;
    await ctx.memento.update(KEYS.connectedRuns, after.stored);
  });
  if (removed > 0) ctx.notify(KEYS.connectedRuns);
  return removed;
}

export function getRawControlLedger(ctx: WorkspaceStateFamilyContext): unknown {
  return ctx.memento.get<unknown>(KEYS.controlLedger);
}

export async function transactControlLedger<T>(
  ctx: WorkspaceStateFamilyContext,
  op: (raw: unknown, write: (next: unknown) => Promise<void>) => Promise<T>
): Promise<T> {
  let outcome!: T;
  const state = { didWrite: false };
  await ctx.serialize(KEYS.controlLedger, async () => {
    const current = ctx.memento.get<unknown>(KEYS.controlLedger);
    outcome = await op(current, async (next: unknown) => {
      await ctx.memento.update(KEYS.controlLedger, next);
      state.didWrite = true;
    });
  });
  if (state.didWrite) {
    ctx.notify(KEYS.controlLedger);
  }
  return outcome;
}

export function getResetMarker(ctx: WorkspaceStateFamilyContext): ResetMarker | null {
  const raw = ctx.memento.get<unknown>(KEYS.resetMarker);
  return isResetMarker(raw) ? raw : null;
}

export async function resetWorkspaceState(ctx: WorkspaceStateFamilyContext): Promise<number> {
  ctx.writeGate.lift();
  const generation = nextResetGeneration(getResetMarker(ctx));
  await ctx.serializeAcrossKeys([...RESET_CLEARED_KEYS, KEYS.resetMarker], async () => {
    await ctx.memento.update(KEYS.resetMarker, {
      generation,
      status: 'in-progress'
    } satisfies ResetMarker);
    for (const key of RESET_CLEARED_KEYS) {
      await ctx.memento.update(key, undefined);
    }
    await ctx.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    await ctx.memento.update(KEYS.resetMarker, {
      generation,
      status: 'complete'
    } satisfies ResetMarker);
  });
  return generation;
}

export async function completeInterruptedReset(
  ctx: WorkspaceStateFamilyContext
): Promise<number | null> {
  const marker = getResetMarker(ctx);
  if (!isResetInterrupted(marker)) return null;
  ctx.writeGate.lift();
  const generation = marker!.generation;
  await ctx.serializeAcrossKeys([...RESET_CLEARED_KEYS, KEYS.resetMarker], async () => {
    for (const key of RESET_CLEARED_KEYS) {
      await ctx.memento.update(key, undefined);
    }
    await ctx.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    await ctx.memento.update(KEYS.resetMarker, {
      generation,
      status: 'complete'
    } satisfies ResetMarker);
  });
  return generation;
}
