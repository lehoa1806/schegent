/**
 * FR-R7-07 — Lock, Execution Leases, Watchdog, and Operator Pseudonym key-family
 * module (`KEYS.lock`, `KEYS.executionLeases`, `KEYS.watchdog`,
 * `KEYS.operatorPseudonym`), delegated from `WorkspaceStateStore`.
 *
 * All writes run through the facade-owned `ctx.serialize` and `ctx.memento`
 * (Hard Rule 4 & 58).
 */

import { assertWatchdogShape } from './credit-pause-state';
import type { ExecutionLease } from './execution-lease';
import {
  OWNERSHIP_VERIFY_DEADLINE_MS,
  verifyWithin
} from './ownership-claim';
import type { WatchdogState, WorkspaceLock } from './workflow-run';
import {
  KEYS,
  type GuardedWriteOutcome,
  type OwnershipClaim,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

export async function refreshLockMirrorGuarded(
  ctx: WorkspaceStateFamilyContext,
  claim: OwnershipClaim,
  mirror: WorkspaceLock,
  options: { readonly refreshHeartbeatAt?: number } = {}
): Promise<GuardedWriteOutcome> {
  let outcome: GuardedWriteOutcome = { outcome: 'unavailable' } as GuardedWriteOutcome;
  await ctx.serialize(KEYS.lock, async () => {
    const registry = ctx.getOwnershipRegistry();
    const verdict =
      options.refreshHeartbeatAt === undefined
        ? await verifyWithin(
            registry,
            claim.resource,
            claim.ownerId,
            claim.fence,
            OWNERSHIP_VERIFY_DEADLINE_MS,
            ctx.scheduler
          )
        : await registry.heartbeat(
            claim.resource,
            claim.ownerId,
            claim.fence,
            options.refreshHeartbeatAt
          );
    if (verdict.outcome === 'unavailable') {
      outcome = { outcome: 'unavailable' };
      return;
    }
    if (verdict.outcome === 'rejected') {
      outcome = {
        outcome: 'rejected',
        reason: verdict.reason,
        currentFence: verdict.currentFence,
        ownerOfRecord: verdict.ownerOfRecord
      };
      return;
    }
    try {
      await ctx.memento.update(KEYS.lock, mirror);
      outcome = { outcome: 'written' };
    } catch {
      outcome = { outcome: 'unavailable' };
    }
  });
  if (outcome.outcome === 'written') ctx.notify(KEYS.lock);
  return outcome;
}

export function getLock(ctx: WorkspaceStateFamilyContext): WorkspaceLock | null {
  return ctx.memento.get<WorkspaceLock>(KEYS.lock) ?? null;
}

export function setLock(
  ctx: WorkspaceStateFamilyContext,
  lock: WorkspaceLock | null
): Promise<void> {
  return ctx.serialize(KEYS.lock, () => ctx.memento.update(KEYS.lock, lock)).then(() => {
    ctx.notify(KEYS.lock);
  });
}

export function getExecutionLeases(
  ctx: WorkspaceStateFamilyContext
): Record<string, ExecutionLease> {
  const raw = ctx.memento.get<Record<string, ExecutionLease>>(KEYS.executionLeases);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

export function setExecutionLease(
  ctx: WorkspaceStateFamilyContext,
  queueId: string,
  lease: ExecutionLease | null
): Promise<void> {
  return ctx.serialize(KEYS.executionLeases, () => {
    const next = { ...getExecutionLeases(ctx) };
    if (lease === null) delete next[queueId];
    else next[queueId] = lease;
    return ctx.memento.update(KEYS.executionLeases, next);
  }).then(() => {
    ctx.notify(KEYS.executionLeases);
  });
}

export function getWatchdog(ctx: WorkspaceStateFamilyContext): WatchdogState {
  return (
    ctx.memento.get<WatchdogState>(KEYS.watchdog) ?? {
      paused: false,
      pausedSince: null,
      nextPollAt: null,
      pollIntervalMs: 30 * 60 * 1000,
      lastStatusOk: null,
      lastPollOutcome: null,
      cause: null
    }
  );
}

export function setWatchdog(
  ctx: WorkspaceStateFamilyContext,
  state: WatchdogState
): Promise<void> {
  return ctx.serialize(KEYS.watchdog, () => {
    assertWatchdogShape(state);
    return ctx.memento.update(KEYS.watchdog, state);
  }).then(() => {
    ctx.notify(KEYS.watchdog);
  });
}

export function readOperatorPseudonym(ctx: WorkspaceStateFamilyContext): unknown {
  return ctx.memento.get<unknown>(KEYS.operatorPseudonym);
}

export async function writeOperatorPseudonym(
  ctx: WorkspaceStateFamilyContext,
  value: { readonly version: 1; readonly pseudonym: string }
): Promise<void> {
  await ctx.memento.update(KEYS.operatorPseudonym, value);
}
