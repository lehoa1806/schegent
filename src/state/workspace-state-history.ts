/**
 * FR-R7-07 — History key-family module (`KEYS.history`), delegated from
 * `WorkspaceStateStore`.
 *
 * Preserves per-queue partitioning (`HISTORY_CAP_PER_QUEUE = 50`), bounded
 * deleted-queue partition pruning (`MAX_DELETED_HISTORY_PARTITIONS`), and
 * single-chain whole-map serialization via `ctx.serialize`.
 */

import { HISTORY_UNATTRIBUTED_QUEUE_ID } from '../contracts/queue-identity';
import {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  MAX_DELETED_HISTORY_PARTITIONS,
  type PersistedHistoryEntry,
  type PersistedHistoryMap,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

export function readHistoryMap(ctx: WorkspaceStateFamilyContext): PersistedHistoryMap {
  const raw = ctx.memento.get<unknown>(KEYS.history);
  if (raw === undefined || raw === null) return {};
  if (Array.isArray(raw)) {
    return raw.length > 0 ? { [HISTORY_UNATTRIBUTED_QUEUE_ID]: raw } : {};
  }
  if (typeof raw !== 'object') return {};
  const map: PersistedHistoryMap = {};
  for (const [queueId, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(entries)) map[queueId] = entries;
  }
  return map;
}

export function getHistoryMap(ctx: WorkspaceStateFamilyContext): Readonly<PersistedHistoryMap> {
  return { ...readHistoryMap(ctx) };
}

export function getHistory(ctx: WorkspaceStateFamilyContext): PersistedHistoryEntry[] {
  return Object.values(readHistoryMap(ctx)).flat();
}

export function pruneExcessDeletedHistoryPartitions(
  ctx: WorkspaceStateFamilyContext,
  map: PersistedHistoryMap,
  registeredIds: ReadonlySet<string> = new Set(
    ctx.getQueueRegistry().entries.map((entry) => entry.id)
  )
): PersistedHistoryMap | null {
  const deletedKeys = Object.keys(map).filter(
    (queueId) => queueId !== HISTORY_UNATTRIBUTED_QUEUE_ID && !registeredIds.has(queueId)
  );
  if (deletedKeys.length <= MAX_DELETED_HISTORY_PARTITIONS) return null;
  const latestCompletedAt = (queueId: string): number => {
    const entries = map[queueId] ?? [];
    let maxTs = 0;
    for (const item of entries) {
      const parsed = Date.parse((item as { completedAt?: string }).completedAt ?? '');
      if (Number.isFinite(parsed) && parsed > maxTs) maxTs = parsed;
    }
    return maxTs;
  };
  const sortedOldestFirst = deletedKeys
    .slice()
    .sort((a, b) => latestCompletedAt(a) - latestCompletedAt(b));
  const toDrop = new Set(
    sortedOldestFirst.slice(0, deletedKeys.length - MAX_DELETED_HISTORY_PARTITIONS)
  );
  const next: PersistedHistoryMap = {};
  for (const [queueId, entries] of Object.entries(map)) {
    if (!toDrop.has(queueId)) next[queueId] = entries;
  }
  return next;
}

export async function appendHistory(
  ctx: WorkspaceStateFamilyContext,
  queueId: string,
  entry: PersistedHistoryEntry
): Promise<readonly PersistedHistoryEntry[]> {
  let evicted: readonly PersistedHistoryEntry[] = [];
  await ctx.serialize(KEYS.history, async () => {
    const map = readHistoryMap(ctx);
    const existing = map[queueId] ?? [];
    const incoming = entry as { runId?: unknown; terminalStatus?: unknown };
    if (
      typeof incoming.runId === 'string' &&
      existing.some((candidate) => {
        const prior = candidate as { runId?: unknown; terminalStatus?: unknown };
        return prior.runId === incoming.runId && prior.terminalStatus === incoming.terminalStatus;
      })
    ) {
      return;
    }
    const next = [...existing, entry];
    const overflow = next.length - HISTORY_CAP_PER_QUEUE;
    const trimmed = overflow > 0 ? next.slice(overflow) : next;
    evicted = overflow > 0 ? next.slice(0, overflow) : [];
    const updatedMap: PersistedHistoryMap = { ...map, [queueId]: trimmed };
    const prunedMap = ctx.pruneExcessDeletedHistoryPartitions(updatedMap) ?? updatedMap;
    await ctx.memento.update(KEYS.history, prunedMap);
  });
  ctx.notify(KEYS.history);
  return evicted;
}
